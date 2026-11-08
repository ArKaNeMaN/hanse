import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCollisions } from "../skills/collisions.js";
import { assertInsideRoot, materializeFailure, rebuildSkills } from "../skills/materialize.js";
import { effectiveSkillHash, type SkillService } from "../skills/service.js";
import type {
  EffectiveBundle,
  EffectiveSkill,
  ExternalBundleDescriptor,
  ResolvedSkills,
  SkillApplyOptions,
  SkillCapture,
  SkillFile,
  SkillMaterializeResult,
  SkillPreview,
  SkillSource,
  SkillTarget,
  SkillWarning,
} from "../skills/types.js";
import type { SkillSourceService } from "./service.js";
import type { ExternalSkillRecord } from "./types.js";
import { parseSkillDocument } from "./validation.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class CompositeSkillSource implements SkillSource {
  readonly #managed: SkillService;
  readonly #sources: SkillSourceService;

  constructor(managed: SkillService, sources: SkillSourceService) {
    this.#managed = managed;
    this.#sources = sources;
  }

  capture(target: SkillTarget): SkillCapture {
    return this.#capture(target, true);
  }

  #capture(target: SkillTarget, loadExternalBytes: boolean): SkillCapture {
    const managed = this.#managed.capture(target);
    const records = this.#sources.activeRecords();
    const disabled = new Set(managed.resolved.disabled.map((entry) => entry.name));
    const managedByName = new Map(managed.resolved.effective.map((skill) => [skill.name, skill]));
    const externalByName = new Map<string, ExternalSkillRecord>();
    for (const record of records) {
      if (!externalByName.has(record.name)) {
        externalByName.set(record.name, record);
      }
    }
    const effective: EffectiveSkill[] = [...managed.resolved.effective];
    const bundles: EffectiveBundle[] = [...managed.managed];
    const external: ExternalBundleDescriptor[] = [];
    const warnings: SkillWarning[] = [...managed.resolved.warnings, ...this.#sources.warnings()];
    const names = new Set<string>([...managedByName.keys(), ...externalByName.keys()]);
    for (const name of [...names].sort(compareStrings)) {
      const managedSkill = managedByName.get(name);
      const record = externalByName.get(name);
      if (managedSkill !== undefined) {
        if (record !== undefined) {
          managedSkill.shadowedExternal = true;
          warnings.push({
            code: "skill_source_conflict",
            name,
            root: record.sourceName,
          });
        }
        continue;
      }
      if (record === undefined || disabled.has(name)) {
        continue;
      }
      const bundle = this.#externalBundle(record, loadExternalBytes);
      effective.push(bundle.skill);
      bundles.push(bundle.bundle);
      external.push(bundle.descriptor);
    }
    effective.sort((left, right) => compareStrings(left.name, right.name));
    const hash = effectiveSkillHash(bundles);
    return {
      hash,
      capturedAt: new Date().toISOString(),
      resolved: {
        ...managed.resolved,
        effective,
        warnings,
      },
      managed: bundles.filter((bundle) => bundle.mode === "managed"),
      external,
    };
  }

  #externalBundle(
    record: ExternalSkillRecord,
    loadBytes: boolean,
  ): { skill: EffectiveSkill; bundle: EffectiveBundle; descriptor: ExternalBundleDescriptor } {
    const files = loadBytes
      ? this.#sources.readSkillFiles(record)
      : record.files.map(
          (file): SkillFile => ({
            path: file.path,
            content: new Uint8Array(),
            sha256: file.sha256,
            size: file.size,
            executable: false,
          }),
        );
    const skillMd = files.find((file) => file.path === "SKILL.md");
    const parsed =
      skillMd === undefined || !loadBytes
        ? { content: "", license: null, compatibility: null, metadata: {} }
        : parseSkillDocument(skillMd.content);
    const references = record.files
      .filter((file) => file.path.startsWith("references/") && file.path.endsWith(".md"))
      .map((file) => ({ path: file.path, size: file.size }));
    const origin = {
      sourceId: record.sourceId,
      sourceName: record.sourceName,
      bucket: record.bucket,
      revision: record.revision,
      snapshotId: record.snapshotId,
    };
    const updatedAt = new Date().toISOString();
    const base = {
      id: null,
      name: record.name,
      description: record.description,
      content: parsed.content,
      license: parsed.license,
      compatibility: parsed.compatibility,
      metadata: parsed.metadata,
      source: null,
      shadows: [],
      shadowedExternal: false,
      mode: "external" as const,
      origin,
      externalKey: `${record.sourceId}:${record.bucket}:${record.name}`,
      fileCount: record.files.filter((file) => file.path !== "SKILL.md").length,
      updatedAt,
      updatedBy: `source:${record.sourceSlug}`,
    };
    return {
      skill: { ...base, references },
      bundle: { ...base, references: [], files },
      descriptor: {
        sourceId: record.sourceId,
        sourceName: record.sourceName,
        bucket: record.bucket,
        revision: record.revision,
        snapshotId: record.snapshotId,
        name: record.name,
        description: record.description,
        files: record.files,
      },
    };
  }

  #collisions(
    resolved: ResolvedSkills,
    options: SkillApplyOptions,
    xdgConfigHome: string | undefined,
  ): { warnings: SkillWarning[]; truncated?: number } {
    return scanCollisions({
      effectiveNames: resolved.effective.map((skill) => skill.name),
      disabledNames: resolved.disabled.map((entry) => entry.name),
      xdgConfigHome,
      options,
    });
  }

  #materialize(
    capture: SkillCapture,
    xdgConfigHome: string,
    options: SkillApplyOptions,
    preserveFirstDeploy: boolean,
  ): SkillMaterializeResult {
    const bundles = [
      ...capture.managed,
      ...capture.external.map((descriptor) => this.#bundleFromDescriptor(descriptor)),
    ];
    const collisions = this.#collisions(capture.resolved, options, xdgConfigHome);
    try {
      assertInsideRoot(options.appRoot, xdgConfigHome);
      mkdirSync(xdgConfigHome, { recursive: true, mode: 0o755 });
      const rebuilt = rebuildSkills({
        appRoot: options.appRoot,
        opencodeRoot: path.join(xdgConfigHome, "opencode"),
        effective: bundles,
        preserveFirstDeploy,
      });
      return {
        hash: capture.hash,
        written: rebuilt.written,
        removed: rebuilt.removed,
        preserved: rebuilt.preserved,
        warnings: [...capture.resolved.warnings, ...collisions.warnings],
        ...(collisions.truncated === undefined ? {} : { truncated: collisions.truncated }),
      };
    } catch (error) {
      throw materializeFailure(error);
    }
  }

  #bundleFromDescriptor(descriptor: ExternalBundleDescriptor): EffectiveBundle {
    const record: ExternalSkillRecord = {
      sourceId: descriptor.sourceId,
      sourceSlug: descriptor.sourceName,
      sourceName: descriptor.sourceName,
      priority: 0,
      bucket: descriptor.bucket,
      snapshotId: descriptor.snapshotId,
      revision: descriptor.revision,
      name: descriptor.name,
      description: descriptor.description,
      version: null,
      contentHash: null,
      skillMdSha256: "",
      files: descriptor.files,
    };
    return this.#externalBundle(record, true).bundle;
  }

  resolve(target: SkillTarget, capture?: SkillCapture): ResolvedSkills {
    return (capture ?? this.#capture(target, false)).resolved;
  }

  preview(target: SkillTarget, options: SkillApplyOptions, capture?: SkillCapture): SkillPreview {
    const resolved = capture?.resolved ?? this.resolve(target);
    const collisions = this.#collisions(resolved, options, undefined);
    return {
      resolved,
      warnings: [...resolved.warnings, ...collisions.warnings],
      ...(collisions.truncated === undefined ? {} : { truncated: collisions.truncated }),
    };
  }

  hash(target: SkillTarget, capture?: SkillCapture): string | undefined {
    return (capture ?? this.#capture(target, false)).hash;
  }

  probe(
    target: SkillTarget,
    _xdgConfigHome: string,
    options: SkillApplyOptions,
    capture?: SkillCapture,
  ): SkillMaterializeResult {
    const captured = capture ?? this.#capture(target, true);
    const staging = mkdtempSync(path.join(os.tmpdir(), "hanse-skill-source-probe-"));
    try {
      return this.#materialize(
        { ...captured, hash: captured.hash },
        staging,
        { ...options, appRoot: staging },
        false,
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  apply(
    target: SkillTarget,
    xdgConfigHome: string,
    options: SkillApplyOptions,
    capture?: SkillCapture,
  ): SkillMaterializeResult {
    return this.#materialize(capture ?? this.#capture(target, true), xdgConfigHome, options, true);
  }
}
