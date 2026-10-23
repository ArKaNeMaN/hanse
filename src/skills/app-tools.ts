import { isMasterAppId } from "../master/constants.js";
import type { AgentTokenIdentity } from "../mcp/agent-tokens.js";
import { recordEvent } from "../store/events.js";
import { isSameSkillTarget, skillVisibleAt } from "./access.js";
import type { SkillService } from "./service.js";
import { SkillConflictError } from "./service.js";
import {
  assertOverridableSource,
  assertOwnAppSkillRow,
  assertSkillReadable,
  assertSkillTarget,
  replacementConfirmationError,
  skillConflictError,
} from "./tool-access.js";
import { SkillToolError, toSkillFailure, unknownSkillError } from "./tool-errors.js";
import {
  asBoolean,
  asPositiveInteger,
  skillInputFromArgs,
  skillUpdatePatchFromArgs,
} from "./tool-inputs.js";
import {
  listEffectiveEntry,
  listRowEntry,
  type SkillToolContext,
  skillDetail,
  skillMutationEnrichment,
  skillSummary,
} from "./tool-projection.js";
import type { SkillRow, SkillTarget } from "./types.js";
import { isSkillName } from "./validation.js";

/** The six app-scope skill tools, minus the master's scope/target arguments. */
export const APP_SKILL_TOOLS = [
  {
    name: "create_skill",
    description:
      "Create an enabled skill bundle at this application's own scope. The target is this application; no scope or target arguments are accepted. A same-name skill at this scope is rejected; a same-name skill at a wider scope is shadowed. Creating a skill never restarts the agent; the result reports pendingRestart.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        content: { type: "string" },
        license: { type: ["string", "null"] },
        compatibility: { type: ["string", "null"] },
        metadata: { type: "object", additionalProperties: { type: "string" } },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["name", "description", "content"],
    },
  },
  {
    name: "list_skills",
    description:
      "List the effective skill set and the rows defined at this application's own scope. Returns no skill bodies or reference contents.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_skill",
    description:
      "Read one skill by id when it is effective for this application or belongs to this application's own scope. Disabled, invalid, or shadowed global/project rows are not readable. Returns the body, reference contents, metadata, raw invalid metadata, and stored issues.",
    inputSchema: {
      type: "object",
      properties: { skill_id: { type: "integer", minimum: 1 } },
      required: ["skill_id"],
    },
  },
  {
    name: "update_skill",
    description:
      "Update the description, body, license, compatibility, metadata, or references of a skill owned by this application. Name, scope, target, and enabled are immutable. Global, project, and sibling-application rows are not writable; override a wider source instead.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "integer", minimum: 1 },
        description: { type: "string" },
        content: { type: "string" },
        license: { type: ["string", "null"] },
        compatibility: { type: ["string", "null"] },
        metadata: { type: "object", additionalProperties: { type: "string" } },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "set_skill_enabled",
    description:
      "Enable or disable one skill owned by this application. A disabled skill is a tombstone, not a deletion; it hides a wider same-name skill for this application.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "integer", minimum: 1 },
        enabled: { type: "boolean" },
      },
      required: ["skill_id", "enabled"],
    },
  },
  {
    name: "override_skill",
    description:
      "Copy an enabled skill that is visible in this application's chain (global or this application's project) into this application's own scope. The target is always this application; a source already at this target is rejected as a self-copy. Replacing an existing local row with the same name requires confirm_replace.",
    inputSchema: {
      type: "object",
      properties: {
        source_skill_id: { type: "integer", minimum: 1 },
        enabled: { type: "boolean" },
        confirm_replace: { type: "boolean" },
      },
      required: ["source_skill_id"],
    },
  },
];

export const APP_SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(
  APP_SKILL_TOOLS.map((tool) => tool.name),
);

export function isAppSkillToolName(name: string): boolean {
  return APP_SKILL_TOOL_NAMES.has(name);
}

export type AppSkillToolContext = SkillToolContext;

const FORBIDDEN_KEYS = ["scope", "project_id", "app_key", "confirm_global"] as const;

function requireAppSkills(context: SkillToolContext): SkillService {
  if (context.skills === undefined) {
    throw new SkillToolError("unavailable", "skills are not configured");
  }
  return context.skills;
}

function listSkills(context: SkillToolContext, target: SkillTarget): Record<string, unknown> {
  const resolved = requireAppSkills(context).resolve(target);
  return {
    ok: true,
    scope: "app",
    target,
    effective: resolved.effective.map((entry) => listEffectiveEntry(entry, target)),
    rows: resolved.rows.map((row) => listRowEntry(row)),
    disabled: resolved.disabled,
  };
}

function getSkill(
  context: SkillToolContext,
  target: SkillTarget,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const id = asPositiveInteger(args.skill_id, "skill_id");
  const skills = requireAppSkills(context);
  const row = skills.get(id);
  if (row === undefined) {
    throw unknownSkillError(id);
  }
  assertSkillReadable(skills, row, target);
  return { ok: true, skill: skillDetail(row) };
}

function appActor(agent: AgentTokenIdentity): string {
  return `app:${agent.projectId}:${agent.appKey}`;
}

function eventBytes(row: SkillRow): { contentBytes: number; referenceBytes: number } {
  return {
    contentBytes: Buffer.byteLength(row.content, "utf8"),
    referenceBytes: row.references.reduce(
      (total, reference) => total + Buffer.byteLength(reference.content, "utf8"),
      0,
    ),
  };
}

function createSkill(
  context: SkillToolContext,
  agent: AgentTokenIdentity,
  target: SkillTarget,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const input = skillInputFromArgs(args);
  assertSkillTarget(context.db, "app", target);
  const skills = requireAppSkills(context);
  const actor = appActor(agent);
  const name = input.name ?? "";
  let created: SkillRow;
  try {
    created = context.db.transaction(() => {
      assertSkillTarget(context.db, "app", target);
      const row = skills.create("app", target, input, actor);
      recordEvent(context.db, "app", "app.skill_created", {
        actor,
        skillId: row.id,
        scope: row.scope,
        projectId: row.projectId,
        appKey: row.appKey,
        name: row.name,
        referenceCount: row.references.length,
        ...eventBytes(row),
      });
      return row;
    })();
  } catch (error) {
    if (error instanceof SkillConflictError) {
      throw skillConflictError(skills, "app", target, name);
    }
    throw error;
  }
  return {
    ok: true,
    skill: skillSummary(created),
    ...skillMutationEnrichment(context, skills, created, target, false),
  };
}

function updateSkill(
  context: SkillToolContext,
  agent: AgentTokenIdentity,
  target: SkillTarget,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (args.name !== undefined) {
    throw new SkillToolError("invalid_argument", '"name" is immutable');
  }
  if (args.enabled !== undefined) {
    throw new SkillToolError(
      "invalid_argument",
      "enabled is not settable here; use set_skill_enabled",
    );
  }
  const id = asPositiveInteger(args.skill_id, "skill_id");
  const patch = skillUpdatePatchFromArgs(args);
  if (Object.keys(patch).length === 0) {
    throw new SkillToolError("invalid_argument", "update_skill requires at least one field");
  }
  assertSkillTarget(context.db, "app", target);
  const skills = requireAppSkills(context);
  const actor = appActor(agent);
  const current = skills.get(id);
  if (current === undefined) {
    throw unknownSkillError(id);
  }
  assertOwnAppSkillRow(current, target);
  const updated = context.db.transaction(() => {
    assertSkillTarget(context.db, "app", target);
    const row = skills.get(id);
    if (row === undefined) {
      throw unknownSkillError(id);
    }
    assertOwnAppSkillRow(row, target);
    const result = skills.update(id, patch, actor);
    recordEvent(context.db, "app", "app.skill_updated", {
      actor,
      skillId: result.id,
      scope: result.scope,
      projectId: result.projectId,
      appKey: result.appKey,
      name: result.name,
      changed: Object.keys(patch),
      referenceCount: result.references.length,
      ...eventBytes(result),
    });
    return result;
  })();
  return {
    ok: true,
    skill: skillSummary(updated),
    ...skillMutationEnrichment(context, skills, updated, target, true),
  };
}

function setSkillEnabled(
  context: SkillToolContext,
  agent: AgentTokenIdentity,
  target: SkillTarget,
  args: Record<string, unknown>,
): Record<string, unknown> {
  for (const field of [
    "name",
    "description",
    "content",
    "license",
    "compatibility",
    "metadata",
    "references",
  ]) {
    if (args[field] !== undefined) {
      throw new SkillToolError(
        "invalid_argument",
        "set_skill_enabled only changes enabled; use update_skill for content",
      );
    }
  }
  const id = asPositiveInteger(args.skill_id, "skill_id");
  const enabled = asBoolean(args.enabled, "enabled");
  assertSkillTarget(context.db, "app", target);
  const skills = requireAppSkills(context);
  const actor = appActor(agent);
  const current = skills.get(id);
  if (current === undefined) {
    throw unknownSkillError(id);
  }
  assertOwnAppSkillRow(current, target);
  const updated = context.db.transaction(() => {
    assertSkillTarget(context.db, "app", target);
    const row = skills.get(id);
    if (row === undefined) {
      throw unknownSkillError(id);
    }
    assertOwnAppSkillRow(row, target);
    const result = skills.update(id, { enabled }, actor);
    recordEvent(context.db, "app", "app.skill_enabled", {
      actor,
      skillId: result.id,
      scope: result.scope,
      projectId: result.projectId,
      appKey: result.appKey,
      name: result.name,
      enabled: result.enabled,
    });
    return result;
  })();
  return {
    ok: true,
    skill: skillSummary(updated),
    ...skillMutationEnrichment(context, skills, updated, target, true),
  };
}

function assertAppOverrideSource(source: SkillRow): void {
  if (!source.enabled) {
    throw new SkillToolError(
      "invalid_skill",
      `source skill ${source.id} is disabled; enable it before overriding`,
    );
  }
  if (!isSkillName(source.name)) {
    throw new SkillToolError(
      "invalid_skill",
      `source skill ${source.id} has an invalid name; repair it before overriding`,
    );
  }
}

function overrideSkill(
  context: SkillToolContext,
  agent: AgentTokenIdentity,
  target: SkillTarget,
  args: Record<string, unknown>,
): Record<string, unknown> {
  for (const field of [
    "name",
    "description",
    "content",
    "license",
    "compatibility",
    "metadata",
    "references",
    "skill_id",
  ]) {
    if (args[field] !== undefined) {
      throw new SkillToolError("invalid_argument", `"${field}" is not accepted by override_skill`);
    }
  }
  const sourceId = asPositiveInteger(args.source_skill_id, "source_skill_id");
  const enabled = args.enabled === undefined ? undefined : asBoolean(args.enabled, "enabled");
  const confirmReplace =
    args.confirm_replace === undefined ? false : asBoolean(args.confirm_replace, "confirm_replace");
  assertSkillTarget(context.db, "app", target);
  const skills = requireAppSkills(context);
  const actor = appActor(agent);
  const source = skills.get(sourceId);
  if (source === undefined) {
    throw unknownSkillError(sourceId);
  }
  if (!skillVisibleAt(source, target)) {
    throw unknownSkillError(sourceId);
  }
  if (isSameSkillTarget(source, "app", target)) {
    throw new SkillToolError("invalid_argument", "the source skill is already at the target scope");
  }
  assertOverridableSource(source);
  assertAppOverrideSource(source);
  const existing = skills.resolve(target).rows.find((row) => row.name === source.name);
  if (existing !== undefined && !confirmReplace) {
    throw replacementConfirmationError(existing);
  }

  const overridden = context.db.transaction(() => {
    assertSkillTarget(context.db, "app", target);
    const current = skills.get(sourceId);
    if (current === undefined) {
      throw unknownSkillError(sourceId);
    }
    if (!skillVisibleAt(current, target)) {
      throw unknownSkillError(sourceId);
    }
    if (isSameSkillTarget(current, "app", target)) {
      throw new SkillToolError(
        "invalid_argument",
        "the source skill is already at the target scope",
      );
    }
    assertOverridableSource(current);
    assertAppOverrideSource(current);
    const targetRow = skills.resolve(target).rows.find((row) => row.name === current.name);
    if (targetRow !== undefined && !confirmReplace) {
      throw replacementConfirmationError(targetRow);
    }
    const result = skills.override(sourceId, "app", target, enabled, actor);
    recordEvent(context.db, "app", "app.skill_overridden", {
      actor,
      sourceSkillId: sourceId,
      skillId: result.id,
      scope: result.scope,
      projectId: result.projectId,
      appKey: result.appKey,
      name: result.name,
      enabled: result.enabled,
      referenceCount: result.references.length,
    });
    return result;
  })();

  return {
    ok: true,
    skill: skillSummary(overridden),
    ...skillMutationEnrichment(context, skills, overridden, target, true),
  };
}

/**
 * Execute one app skill tool. The target is always derived from the verified token; the six tools
 * implement app-scope reads and writes with no scope or target argument.
 */
export async function callAppSkillTool(
  context: AppSkillToolContext,
  agent: AgentTokenIdentity,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    if (isMasterAppId(agent.appId)) {
      throw new SkillToolError(
        "master_protected",
        "the master application cannot use app skill tools",
      );
    }
    const target = { projectId: agent.projectId, appKey: agent.appKey };
    if (agent.appId !== `${target.projectId}:${target.appKey}`) {
      throw new SkillToolError("internal_error", "the agent identity is inconsistent");
    }
    for (const field of FORBIDDEN_KEYS) {
      if (args[field] !== undefined) {
        throw new SkillToolError(
          "invalid_argument",
          `"${field}" is not accepted by app skill tools`,
        );
      }
    }
    if (context.skills === undefined) {
      throw new SkillToolError("unavailable", "skills are not configured");
    }
    if (!isAppSkillToolName(name)) {
      throw new SkillToolError("internal_error", `unknown app skill tool: ${name}`);
    }
    switch (name) {
      case "create_skill":
        return createSkill(context, agent, target, args);
      case "list_skills":
        return listSkills(context, target);
      case "get_skill":
        return getSkill(context, target, args);
      case "update_skill":
        return updateSkill(context, agent, target, args);
      case "set_skill_enabled":
        return setSkillEnabled(context, agent, target, args);
      case "override_skill":
        return overrideSkill(context, agent, target, args);
      default:
        throw new SkillToolError("internal_error", `unknown app skill tool: ${name}`);
    }
  } catch (error) {
    return toSkillFailure(error);
  }
}
