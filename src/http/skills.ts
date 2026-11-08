import {
  SkillConflictError,
  type SkillFileInput,
  type SkillMetadata,
  type SkillReference,
  type SkillRow,
  type SkillScope,
  SkillService,
  type SkillTarget,
  type SkillUpdate,
  SkillValidationError,
  skillFileView,
} from "../skills/index.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import {
  type BundleValues,
  bundleFromRow,
  parseExplicitTarget,
  previewFor,
  rowPagePath,
  SkillsTargetError,
  skillsPagePath,
  targetExists,
  targetFromQuery,
  type WorkspaceValues,
  workspacePath,
} from "./props/skills.js";
import { safeLocalPath } from "./ui.js";

const JSON_HEADERS = { "cache-control": "no-store" };

const KNOWN_METADATA: Array<{
  key: string;
  label: string;
  group: "classification" | "discovery" | "version";
  hint: string;
}> = [
  {
    key: "domain",
    label: "Domain",
    group: "classification",
    hint: "The broad area the skill belongs to, such as engineering or operations.",
  },
  {
    key: "role",
    label: "Role",
    group: "classification",
    hint: "The role the agent plays while using the skill.",
  },
  {
    key: "scope",
    label: "Operating scope",
    group: "classification",
    hint: "What part of the work it covers, such as one repository or a whole project.",
  },
  {
    key: "output-format",
    label: "Output format",
    group: "classification",
    hint: "The expected result shape: mixed, code, report, document, plan, or decision.",
  },
  {
    key: "triggers",
    label: "Triggers",
    group: "discovery",
    hint: "Comma-separated cues that tell the agent when to load the skill.",
  },
  {
    key: "related-skills",
    label: "Related skills",
    group: "discovery",
    hint: "Comma-separated skill names worth loading alongside this one.",
  },
  {
    key: "version",
    label: "Version",
    group: "version",
    hint: "A short version label, such as 1.0.0.",
  },
  {
    key: "author",
    label: "Author",
    group: "version",
    hint: "The person or team responsible for the skill.",
  },
];

const _KNOWN_METADATA_KEYS = new Set(KNOWN_METADATA.map((entry) => entry.key));

class SkillsBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsBodyError";
  }
}

class SkillsOverrideError extends Error {
  readonly code = "invalid_override_source";

  constructor() {
    super("invalid_override_source");
    this.name = "SkillsOverrideError";
  }
}

class SkillsConfirmError extends Error {
  readonly code = "confirm_name";
  readonly field = "confirm_name";

  constructor() {
    super("the confirmation name does not match this skill");
    this.name = "SkillsConfirmError";
  }
}

/* ------------------------------------------------------------------------- */
/* Response primitives                                                        */
/* ------------------------------------------------------------------------- */

interface JsonError {
  error: string;
  code: string;
  field?: string;
}

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { ...JSON_HEADERS },
  };
}

function errorJson(status: number, value: JsonError): HttpResponse {
  return json(status, value);
}

function redirect(location: string): HttpResponse {
  return {
    status: 303,
    contentType: "text/plain",
    body: "",
    headers: { location, ...JSON_HEADERS },
  };
}

/* ------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* ------------------------------------------------------------------------- */

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function wantsHtml(request: HttpRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(source, key);
}

function parseForm(body: string | undefined): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  if (body === undefined) {
    return fields;
  }
  for (const pair of body.split("&")) {
    const index = pair.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = safeDecode(pair.slice(0, index));
    if (DANGEROUS_KEYS.has(key)) {
      throw new SkillsBodyError("request contains a forbidden field name");
    }
    fields[key] = safeDecode(pair.slice(index + 1));
  }
  return fields;
}

function isJsonRequest(request: HttpRequest): boolean {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    return true;
  }
  return request.body?.trim().startsWith("{") ?? false;
}

function parseObjectBody(request: HttpRequest): Record<string, unknown> {
  if (!isJsonRequest(request)) {
    return parseForm(request.body);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body ?? "");
  } catch {
    throw new SkillsBodyError("invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillsBodyError("request body must be a JSON object");
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new SkillsBodyError("request contains a forbidden field name");
    }
  }
  return parsed as Record<string, unknown>;
}

function jsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillValidationError(`${label} must be valid JSON`, label);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillValidationError(`${label} must be a JSON object`, label);
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new SkillsBodyError("request contains a forbidden field name");
    }
  }
  return record;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function enabledFrom(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === 0) {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "on") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "") {
      return false;
    }
  }
  throw new SkillsBodyError("enabled must be a boolean");
}

function parseId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function requestPath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.set(key, value);
  }
  const query = params.toString();
  return query.length === 0 ? request.path : `${request.path}?${query}`;
}

/* ------------------------------------------------------------------------- */
/* Return paths                                                               */
/* ------------------------------------------------------------------------- */

function safeSkillReturn(value: string | undefined, fallback: string): string {
  const target = safeLocalPath(value, fallback);
  if (target === "/login" || target.startsWith("/login?") || target.startsWith("/login#")) {
    return fallback;
  }
  return target;
}

/* ------------------------------------------------------------------------- */
/* Origin                                                                     */
/* ------------------------------------------------------------------------- */

function originAllowed(request: HttpRequest): boolean {
  const origin = request.origin;
  if (origin === undefined || origin.trim().length === 0) {
    return true;
  }
  const trimmed = origin.trim();
  if (trimmed === "null") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = request.host;
  return host !== undefined && host.length > 0 && parsed.host === host;
}

/* ------------------------------------------------------------------------- */
/* Warning and issue formatting                                               */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* Page chrome                                                                */
/* ------------------------------------------------------------------------- */

function withNotice(location: string, message: string, tone: "success" | "error"): string {
  const hashIndex = location.indexOf("#");
  const hash = hashIndex >= 0 ? location.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? location.slice(0, hashIndex) : location;
  const queryIndex = base.indexOf("?");
  const pathname = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const params = new URLSearchParams(queryIndex >= 0 ? base.slice(queryIndex + 1) : "");
  params.set("notice", message);
  params.set("tone", tone);
  return `${pathname}?${params.toString()}${hash}`;
}

function redirectNotice(
  location: string,
  message: string,
  tone: "success" | "error",
): HttpResponse {
  return redirect(withNotice(location, message, tone));
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

interface ParsedBundle {
  license?: string | null;
  compatibility?: string | null;
  metadata?: SkillMetadata;
  metadataRaw?: string | null;
  references?: SkillReference[];
  files?: SkillFileInput[];
  /** The browser form could not edit these stored fields without JavaScript. */
  preserveInvalid?: boolean;
}

function detailOf(row: SkillRow): Record<string, unknown> {
  return {
    ...row,
    metadataRaw: row.metadataRaw,
    references: row.references.map((reference) => {
      const content = reference.content;
      return {
        path: reference.path,
        content,
        size: Buffer.byteLength(content, "utf8"),
      };
    }),
    files: (row.files ?? []).map(skillFileView),
  };
}

function mergeBundle(base: BundleValues, parsed: ParsedBundle): BundleValues {
  const metadata = parsed.metadata !== undefined ? parsed.metadata : base.metadata;
  const metadataRaw =
    parsed.metadata !== undefined
      ? null
      : parsed.metadataRaw !== undefined
        ? parsed.metadataRaw
        : base.metadataRaw;
  return {
    license: parsed.license !== undefined ? parsed.license : base.license,
    compatibility: parsed.compatibility !== undefined ? parsed.compatibility : base.compatibility,
    metadata,
    metadataRaw,
    references: parsed.references !== undefined ? parsed.references : base.references,
  };
}

function parseBundlePayload(payload: Record<string, unknown>): ParsedBundle {
  let source: Record<string, unknown> = payload;
  if (hasOwn(payload, "bundle")) {
    const rawBundle = payload.bundle;
    if (typeof rawBundle !== "string") {
      throw new SkillsBodyError("bundle must be a JSON string");
    }
    if (rawBundle.trim().length > 0) {
      source = { ...jsonObject(rawBundle, "bundle") };
    }
    for (const key of [
      "license",
      "compatibility",
      "metadata",
      "metadataRaw",
      "references",
      "files",
    ]) {
      if (hasOwn(payload, key)) {
        source[key] = payload[key];
      }
    }
  }
  const parsed: ParsedBundle = {};
  if (hasOwn(source, "license")) {
    const value = source.license;
    if (value !== null && typeof value !== "string") {
      throw new SkillValidationError("license must be a string or null", "license");
    }
    parsed.license = value;
  }
  if (hasOwn(source, "compatibility")) {
    const value = source.compatibility;
    if (value !== null && typeof value !== "string") {
      throw new SkillValidationError("compatibility must be a string or null", "compatibility");
    }
    parsed.compatibility = value;
  }
  if (hasOwn(source, "metadata")) {
    let value = source.metadata;
    if (typeof value === "string") {
      value = jsonObject(value, "metadata");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new SkillValidationError("metadata must be a plain object", "metadata");
    }
    const metadata: SkillMetadata = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry !== "string") {
        throw new SkillValidationError(`metadata value for ${key} must be a string`, "metadata");
      }
      metadata[key] = entry;
    }
    parsed.metadata = metadata;
  }
  if (hasOwn(source, "metadataRaw")) {
    const value = source.metadataRaw;
    if (value !== null && typeof value !== "string") {
      throw new SkillValidationError("metadataRaw must be a string or null", "metadata");
    }
    parsed.metadataRaw = value;
  }
  if (hasOwn(source, "references")) {
    let value = source.references;
    if (typeof value === "string") {
      if (value.trim().length === 0) {
        value = [];
      } else {
        try {
          value = JSON.parse(value) as unknown;
        } catch {
          throw new SkillValidationError("references must be valid JSON", "references");
        }
      }
    }
    if (!Array.isArray(value)) {
      throw new SkillValidationError("references must be an array", "references");
    }
    const references: SkillReference[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new SkillValidationError("each reference must have a path and content", "references");
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string" || typeof record.content !== "string") {
        throw new SkillValidationError("each reference must have a path and content", "references");
      }
      if (record.path.trim().length === 0 && record.content.trim().length === 0) {
        continue;
      }
      references.push({ path: record.path, content: record.content });
    }
    parsed.references = references;
  }
  if (hasOwn(source, "files")) {
    let value = source.files;
    if (typeof value === "string") {
      if (value.trim().length === 0) {
        value = [];
      } else {
        try {
          value = JSON.parse(value) as unknown;
        } catch {
          throw new SkillValidationError("files must be valid JSON", "files");
        }
      }
    }
    if (!Array.isArray(value)) {
      throw new SkillValidationError("files must be an array", "files");
    }
    const files: SkillFileInput[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new SkillValidationError("each file must have a path and text or base64", "files");
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string") {
        throw new SkillValidationError("each file must have a path", "files");
      }
      if (record.text !== undefined && typeof record.text !== "string") {
        throw new SkillValidationError("file text must be a string", "files");
      }
      if (record.base64 !== undefined && typeof record.base64 !== "string") {
        throw new SkillValidationError("file base64 must be a string", "files");
      }
      if (record.executable !== undefined && typeof record.executable !== "boolean") {
        throw new SkillValidationError("file executable must be a boolean", "files");
      }
      files.push({
        path: record.path,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.base64 === undefined ? {} : { base64: record.base64 }),
        ...(record.executable === undefined ? {} : { executable: record.executable }),
      });
    }
    parsed.files = files;
  }
  if (source.preserveInvalid === true) {
    parsed.preserveInvalid = true;
  }
  return parsed;
}

function valuesFromCreatePayload(
  payload: Record<string, unknown>,
  parsed: ParsedBundle,
): WorkspaceValues {
  return {
    name: stringValue(payload.name) ?? "",
    description: stringValue(payload.description) ?? "",
    content: stringValue(payload.content) ?? "",
    enabled: enabledFrom(payload.enabled) ?? true,
    bundle: mergeBundle(
      {
        license: null,
        compatibility: null,
        metadata: {},
        metadataRaw: null,
        references: [],
      },
      parsed,
    ),
  };
}

function valuesFromUpdatePayload(
  payload: Record<string, unknown>,
  parsed: ParsedBundle,
  row: SkillRow,
): WorkspaceValues {
  return {
    description: stringValue(payload.description) ?? row.description,
    content: stringValue(payload.content) ?? row.content,
    enabled: enabledFrom(payload.enabled) ?? row.enabled,
    bundle: mergeBundle(bundleFromRow(row), parsed),
  };
}

function updatePatch(payload: Record<string, unknown>, parsed: ParsedBundle): SkillUpdate {
  const patch: SkillUpdate = {};
  if (hasOwn(payload, "description")) {
    const value = payload.description;
    if (typeof value !== "string") {
      throw new SkillValidationError("description must be a string", "description");
    }
    patch.description = value;
  }
  if (hasOwn(payload, "content")) {
    const value = payload.content;
    if (typeof value !== "string") {
      throw new SkillValidationError("content must be a string", "content");
    }
    patch.content = value;
  }
  if (hasOwn(payload, "enabled")) {
    patch.enabled = enabledFrom(payload.enabled);
  }
  if (parsed.license !== undefined) {
    patch.license = parsed.license;
  }
  if (parsed.compatibility !== undefined) {
    patch.compatibility = parsed.compatibility;
  }
  if (parsed.metadata !== undefined) {
    const preservesRaw =
      parsed.metadataRaw !== undefined &&
      parsed.metadataRaw !== null &&
      Object.keys(parsed.metadata).length === 0;
    if (!preservesRaw) {
      patch.metadata = parsed.metadata;
    }
  }
  if (parsed.references !== undefined) {
    patch.references = parsed.references;
  }
  if (parsed.files !== undefined) {
    patch.files = parsed.files;
  }
  if (Object.keys(patch).length === 0) {
    throw new SkillsBodyError("update requires at least one field");
  }
  return patch;
}

function mutationError(
  error: unknown,
  browser: boolean,
  returnTo: string,
): HttpResponse | undefined {
  if (error instanceof SkillValidationError) {
    if (error.message === "invalid_override_source") {
      if (browser) {
        return redirectNotice(returnTo, "invalid_override_source", "error");
      }
      return errorJson(400, {
        error: "invalid_override_source",
        code: "invalid_override_source",
      });
    }
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, {
      error: error.message,
      code: error.code,
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  if (error instanceof SkillsConfirmError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, { error: error.message, code: error.code, field: error.field });
  }
  if (error instanceof SkillConflictError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(409, { error: error.message, code: error.code });
  }
  if (error instanceof SkillsTargetError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, { error: error.message, code: error.code });
  }
  if (error instanceof SkillsOverrideError) {
    if (browser) {
      return redirectNotice(returnTo, "invalid_override_source", "error");
    }
    return errorJson(400, { error: "invalid_override_source", code: "invalid_override_source" });
  }
  if (error instanceof SkillsBodyError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, { error: error.message, code: "invalid_body" });
  }
  return undefined;
}

function notFound(_browser: boolean): HttpResponse {
  return errorJson(404, { error: "not found", code: "not_found" });
}

/* ------------------------------------------------------------------------- */
/* Dispatch                                                                  */
/* ------------------------------------------------------------------------- */

export function isSkillsRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/skills") {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/skills\/[^/]+\/delete$/.test(pathname)) {
    return method === "POST";
  }
  return method === "GET" || method === "POST" || method === "DELETE"
    ? /^\/api\/skills\/[^/]+$/.test(pathname)
    : false;
}

export async function handleSkills(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  let skills: SkillService;
  try {
    skills = deps.skills ?? new SkillService({ db: deps.db });
  } catch {
    return errorJson(503, { error: "skills are not available", code: "skills_unavailable" });
  }

  const browser = wantsHtml(request);
  const mutation = request.method === "POST" || request.method === "DELETE";

  if (mutation && !originAllowed(request)) {
    return errorJson(403, { error: "cross-site request rejected", code: "cross_origin" });
  }

  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return browser
      ? redirect(`/login?next=${encodeURIComponent(requestPath(request))}`)
      : errorJson(401, { error: "sign in required", code: "unauthorized" });
  }
  if (principal.kind !== "human") {
    return errorJson(403, {
      error: "only a human principal may manage skills",
      code: "human_only",
    });
  }
  const actor = principal.name;

  try {
    if (request.path === "/api/skills" && request.method === "GET") {
      const { scope, target } = targetFromQuery(request.query ?? {});
      if (!targetExists(deps, scope, target)) {
        return notFound(browser);
      }
      const resolved = skills.resolve(target);
      const preview = previewFor(deps, skills, scope, target);
      if (preview === undefined) {
        return json(200, resolved);
      }
      return json(200, {
        ...resolved,
        warnings: preview.warnings,
        ...(preview.truncated === undefined ? {} : { truncated: preview.truncated }),
      });
    }

    if (request.path === "/api/skills" && request.method === "POST") {
      let returnTo = "/skills";
      let payload: Record<string, unknown>;
      let scope: SkillScope = "global";
      let target: SkillTarget = {};
      try {
        payload = parseObjectBody(request);
        const parsedTarget = parseExplicitTarget(payload);
        scope = parsedTarget.scope;
        target = parsedTarget.target;
        returnTo = safeSkillReturn(stringValue(payload.return_to), skillsPagePath(scope, target));
      } catch (error) {
        const mapped = mutationError(error, browser, returnTo);
        if (mapped !== undefined) {
          return mapped;
        }
        throw error;
      }
      if (!targetExists(deps, scope, target)) {
        return notFound(browser);
      }
      const action = stringValue(payload.action) ?? "";
      if (action === "discard") {
        if (browser) {
          return redirectNotice(returnTo, "Changes discarded.", "success");
        }
        return json(200, { discarded: true });
      }
      if (action === "create") {
        let selected: WorkspaceValues | undefined;
        try {
          const parsed = parseBundlePayload(payload);
          selected = valuesFromCreatePayload(payload, parsed);
          if (selected.bundle.metadataRaw !== null) {
            throw new SkillValidationError("metadata must be valid JSON", "metadata");
          }
          const skill = skills.create(
            scope,
            target,
            {
              name: stringValue(payload.name),
              description: selected.description,
              content: selected.content,
              enabled: selected.enabled,
              license: selected.bundle.license,
              compatibility: selected.bundle.compatibility,
              metadata: selected.bundle.metadata,
              references: selected.bundle.references,
              ...(parsed.files === undefined ? {} : { files: parsed.files }),
            },
            actor,
          );
          if (browser) {
            return redirectNotice(workspacePath(skill, returnTo), "Skill created.", "success");
          }
          return json(200, { skill: detailOf(skill) });
        } catch (error) {
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
      }
      if (action === "override") {
        try {
          const fromId = parseId(payload.from_id);
          if (fromId === undefined) {
            throw new SkillsOverrideError();
          }
          const enabled = enabledFrom(payload.enabled);
          const skill = skills.override(fromId, scope, target, enabled, actor);
          if (browser) {
            return redirectNotice(
              returnTo,
              enabled === false ? "Skill disabled here." : "Skill overridden here.",
              "success",
            );
          }
          return json(200, { skill: detailOf(skill) });
        } catch (error) {
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
      }
      return errorJson(400, {
        error: "action must be create or override",
        code: "invalid_body",
      });
    }

    const deleteMatch = /^\/api\/skills\/([^/]+)\/delete$/.exec(request.path);
    if (deleteMatch !== null && request.method === "POST") {
      const id = parseId(safeDecode(deleteMatch[1] ?? ""));
      const row = id === undefined ? undefined : skills.get(id);
      if (id === undefined || row === undefined) {
        return notFound(browser);
      }
      let returnTo = rowPagePath(row);
      let payload: Record<string, unknown> = {};
      try {
        payload = parseObjectBody(request);
        returnTo = safeSkillReturn(stringValue(payload.return_to), returnTo);
        const confirm = stringValue(payload.confirm_name);
        if (confirm !== undefined && confirm !== row.name) {
          throw new SkillsConfirmError();
        }
        skills.delete(id);
        if (browser) {
          return redirectNotice(
            returnTo,
            row.enabled ? "Skill deleted." : "Skill reverted to inherited.",
            "success",
          );
        }
        return json(200, { deleted: true });
      } catch (error) {
        const mapped = mutationError(error, browser, returnTo);
        if (mapped !== undefined) {
          return mapped;
        }
        throw error;
      }
    }

    const idMatch = /^\/api\/skills\/([^/]+)$/.exec(request.path);
    if (idMatch !== null) {
      const id = parseId(safeDecode(idMatch[1] ?? ""));
      const row = id === undefined ? undefined : skills.get(id);
      if (id === undefined || row === undefined) {
        return notFound(browser);
      }
      if (request.method === "GET") {
        return json(200, { skill: detailOf(row) });
      }
      if (request.method === "DELETE") {
        skills.delete(id);
        return json(200, { deleted: true });
      }
      if (request.method === "POST") {
        let returnTo = workspacePath(row);
        let payload: Record<string, unknown>;
        try {
          payload = parseObjectBody(request);
          returnTo = safeSkillReturn(stringValue(payload.return_to), returnTo);
        } catch (error) {
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
        const action = stringValue(payload.action) ?? "update";
        if (action === "delete") {
          const deleteReturnTo = safeSkillReturn(stringValue(payload.return_to), rowPagePath(row));
          try {
            const confirm = stringValue(payload.confirm_name);
            if (confirm !== undefined && confirm !== row.name) {
              throw new SkillsConfirmError();
            }
            skills.delete(id);
            if (browser) {
              return redirectNotice(
                deleteReturnTo,
                row.enabled ? "Skill deleted." : "Skill reverted to inherited.",
                "success",
              );
            }
            return json(200, { deleted: true });
          } catch (error) {
            const mapped = mutationError(error, browser, returnTo);
            if (mapped !== undefined) {
              return mapped;
            }
            throw error;
          }
        }
        if (action === "discard") {
          if (browser) {
            return redirectNotice(returnTo, "Changes discarded.", "success");
          }
          return json(200, { discarded: true });
        }
        if (action !== "update") {
          return errorJson(400, { error: "action must be update or delete", code: "invalid_body" });
        }
        let _values: WorkspaceValues | undefined = valuesFromUpdatePayload(payload, {}, row);
        try {
          const parsed = parseBundlePayload(payload);
          _values = valuesFromUpdatePayload(payload, parsed, row);
          const patch = updatePatch(payload, parsed);
          let skill: SkillRow;
          try {
            skill = skills.update(id, patch, actor);
          } catch (error) {
            if (!(parsed.preserveInvalid === true && error instanceof SkillValidationError)) {
              throw error;
            }
            // Without JavaScript the invalid stored bundle fields cannot be
            // edited; preserve them and apply only the legacy fields so a
            // body/description save never fails on unrelated corrupt data.
            const fallback: SkillUpdate = {};
            if (patch.description !== undefined) {
              fallback.description = patch.description;
            }
            if (patch.content !== undefined) {
              fallback.content = patch.content;
            }
            if (patch.enabled !== undefined) {
              fallback.enabled = patch.enabled;
            }
            if (Object.keys(fallback).length === 0) {
              throw error;
            }
            skill = skills.update(id, fallback, actor);
          }
          if (browser) {
            return redirectNotice(
              returnTo,
              patch.enabled === false ? "Skill disabled here." : "Skill saved.",
              "success",
            );
          }
          return json(200, { skill: detailOf(skill) });
        } catch (error) {
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
      }
      return notFound(browser);
    }

    return notFound(browser);
  } catch (error) {
    if (error instanceof SkillsTargetError || error instanceof SkillsBodyError) {
      const mapped = mutationError(error, browser, "/skills");
      if (mapped !== undefined) {
        return mapped;
      }
    }
    return errorJson(500, { error: "internal error", code: "internal_error" });
  }
}

/* ------------------------------------------------------------------------- */
/* Create page helpers                                                        */
/* ------------------------------------------------------------------------- */
