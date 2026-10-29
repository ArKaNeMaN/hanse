<script setup lang="ts">
/**
 * Skill bundle editor and read-only workspace.
 *
 * Ports the relevant behavior from `assets/skill-detail.js`: details/metadata editing, reference
 * files, a source/preview split, generated frontmatter with copy, and client-side validation
 * helpers. The server remains the only writer; the parent assembles the JSON bundle and calls the
 * existing `/api/skills*` handlers through `apiMutation`. No skill text is ever assigned as HTML.
 */
import { computed, ref, watch } from "vue";
import {
  KNOWN_SKILL_METADATA,
  SKILL_LIMITS,
  SKILL_METADATA_KEY,
  SKILL_REFERENCE_PATH,
  type SkillDraft,
  type SkillFormProps,
  type SkillIssueProps,
} from "../skills-types.js";
import AppIcon from "./AppIcon.vue";
import SafeMarkdown from "./SafeMarkdown.vue";

const props = defineProps<{
  draft: SkillDraft;
  editable: boolean;
  mode: "create" | "update";
  error: { message: string; field: string | null } | null;
  nameField: SkillFormProps["nameField"];
  storedIssues: readonly SkillIssueProps[];
}>();

const classification = KNOWN_SKILL_METADATA.filter((entry) => entry.group === "classification");
const discovery = KNOWN_SKILL_METADATA.filter((entry) => entry.group === "discovery");
const versionFields = KNOWN_SKILL_METADATA.filter((entry) => entry.group === "version");

const activeReference = ref<number>(-1);
const view = ref<"source" | "preview">("source");
const copyState = ref<"idle" | "copied" | "failed">("idle");

watch(
  () => props.draft.references.length,
  (length) => {
    if (activeReference.value >= length) {
      activeReference.value = length === 0 ? -1 : length - 1;
    }
  },
);

const currentReference = computed<{ path: string; content: string } | undefined>(() =>
  activeReference.value < 0 ? undefined : props.draft.references[activeReference.value],
);
const previewTitle = computed(() => currentReference.value?.path || "SKILL.md");
const previewText = computed(() => currentReference.value?.content ?? props.draft.content);

function fieldError(field: string): string | null {
  return props.error?.field === field ? props.error.message : null;
}

function metadataValue(key: string): string {
  return props.draft.knownMetadata[key] ?? "";
}

function setMetadata(key: string, event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    props.draft.knownMetadata[key] = target.value;
  }
}

function setRawMetadata(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    props.draft.metadataRaw = target.value;
  }
}

function clearMetadata(): void {
  props.draft.knownMetadata = {};
  props.draft.customMetadata = [];
  props.draft.metadataRaw = null;
}

function addMetadataRow(): void {
  if (props.draft.customMetadata.length >= SKILL_LIMITS.metadataEntries) {
    return;
  }
  props.draft.customMetadata = [...props.draft.customMetadata, { key: "", value: "" }];
}

function removeMetadataRow(index: number): void {
  props.draft.customMetadata = props.draft.customMetadata.filter((_, at) => at !== index);
}

function addReference(): void {
  if (!props.editable || props.draft.references.length >= SKILL_LIMITS.references) {
    return;
  }
  props.draft.references = [...props.draft.references, { path: "", content: "" }];
  activeReference.value = props.draft.references.length - 1;
  view.value = "source";
}

function removeReference(index: number): void {
  const reference = props.draft.references[index];
  if (reference === undefined) {
    return;
  }
  const label = reference.path.length > 0 ? reference.path : "this reference file";
  if (!window.confirm(`Remove ${label}? It is deleted when you save.`)) {
    return;
  }
  props.draft.references = props.draft.references.filter((_, at) => at !== index);
  if (activeReference.value === index) {
    activeReference.value = props.draft.references.length === 0 ? -1 : 0;
  }
}

function setDescription(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    props.draft.description = target.value;
  }
}

function setName(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    props.draft.name = target.value;
  }
}

function setEnabled(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    props.draft.enabled = target.checked;
  }
}

function setLicense(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    props.draft.license = target.value;
  }
}

function setCompatibility(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    props.draft.compatibility = target.value;
  }
}

function setContent(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    props.draft.content = target.value;
  }
}

function setReferencePath(event: Event): void {
  const reference = currentReference.value;
  const target = event.target;
  if (reference !== undefined && target instanceof HTMLInputElement) {
    reference.path = target.value;
  }
}

function setReferenceContent(event: Event): void {
  const reference = currentReference.value;
  const target = event.target;
  if (reference !== undefined && target instanceof HTMLTextAreaElement) {
    reference.content = target.value;
  }
}

function setCustomKey(index: number, event: Event): void {
  const row = props.draft.customMetadata[index];
  const target = event.target;
  if (row !== undefined && target instanceof HTMLInputElement) {
    row.key = target.value;
  }
}

function setCustomValue(index: number, event: Event): void {
  const row = props.draft.customMetadata[index];
  const target = event.target;
  if (row !== undefined && target instanceof HTMLInputElement) {
    row.value = target.value;
  }
}

function metadataObject(): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const entry of KNOWN_SKILL_METADATA) {
    const value = props.draft.knownMetadata[entry.key] ?? "";
    if (value.trim().length > 0) {
      metadata[entry.key] = value;
    }
  }
  for (const row of props.draft.customMetadata) {
    const key = row.key.trim();
    if (key.length === 0 && row.value.trim().length === 0) {
      continue;
    }
    metadata[key] = row.value;
  }
  return metadata;
}

function parseMetadataJson(text: string): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return undefined;
    }
    metadata[key] = value;
  }
  return metadata;
}

/** The same precedence as `skill-detail.js`: a repaired raw JSON object wins over the fields. */
function effectiveMetadata(): { metadata: Record<string, string>; raw: string | undefined } {
  if (props.draft.metadataRaw !== null && props.draft.metadataRaw.trim().length > 0) {
    const parsed = parseMetadataJson(props.draft.metadataRaw);
    return parsed === undefined
      ? { metadata: {}, raw: props.draft.metadataRaw }
      : { metadata: parsed, raw: undefined };
  }
  return { metadata: metadataObject(), raw: undefined };
}

function frontmatter(): { text: string; broken: boolean } | undefined {
  const lines = ["---"];
  const name = props.draft.name.trim();
  const description = props.draft.description.trim();
  const license = props.draft.license.trim();
  const compatibility = props.draft.compatibility.trim();
  if (name.length > 0) {
    lines.push(`name: ${JSON.stringify(name)}`);
  }
  if (description.length > 0) {
    lines.push(`description: ${JSON.stringify(description)}`);
  }
  if (license.length > 0) {
    lines.push(`license: ${JSON.stringify(license)}`);
  }
  if (compatibility.length > 0) {
    lines.push(`compatibility: ${JSON.stringify(compatibility)}`);
  }
  const effective = effectiveMetadata();
  const keys = Object.keys(effective.metadata).sort();
  if (keys.length > 0) {
    lines.push("metadata:");
    for (const key of keys) {
      const renderedKey = SKILL_METADATA_KEY.test(key) ? key : JSON.stringify(key);
      lines.push(`  ${renderedKey}: ${JSON.stringify(effective.metadata[key] ?? "")}`);
    }
  }
  lines.push("---");
  const broken = effective.raw !== undefined;
  if (
    name.length === 0 &&
    description.length === 0 &&
    license.length === 0 &&
    compatibility.length === 0 &&
    keys.length === 0 &&
    !broken
  ) {
    return undefined;
  }
  return { text: lines.join("\n"), broken };
}

async function copyFrontmatter(): Promise<void> {
  const generated = frontmatter();
  if (generated === undefined) {
    return;
  }
  try {
    await navigator.clipboard.writeText(generated.text);
    copyState.value = "copied";
  } catch {
    copyState.value = "failed";
  }
  window.setTimeout(() => {
    copyState.value = "idle";
  }, 1400);
}

function selectReference(index: number): void {
  activeReference.value = index;
  view.value = "source";
}

/** Validation before submit; mirrors the server limits and the legacy client checks. */
function validate(): { field: string; message: string } | undefined {
  if (props.mode === "create") {
    const name = props.draft.name.trim();
    if (name.length === 0) {
      return { field: "name", message: "A skill name is required." };
    }
    if (name.length > SKILL_LIMITS.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      return {
        field: "name",
        message: "Use lowercase letters, digits, and single hyphens.",
      };
    }
  }
  if (props.draft.description.length > SKILL_LIMITS.description) {
    return { field: "description", message: "The description is too long." };
  }
  if (props.draft.content.length > SKILL_LIMITS.content) {
    return { field: "content", message: "The SKILL.md body is too long." };
  }
  if (props.draft.license.length > SKILL_LIMITS.license) {
    return { field: "license", message: "The license is too long." };
  }
  if (props.draft.compatibility.length > SKILL_LIMITS.compatibility) {
    return { field: "compatibility", message: "The compatibility value is too long." };
  }
  if (props.draft.metadataRaw !== null && props.draft.metadataRaw.trim().length > 0) {
    if (parseMetadataJson(props.draft.metadataRaw) === undefined) {
      const preserve =
        props.mode === "update" &&
        props.storedIssues.some((issue) => issue.code === "invalid_skill_metadata");
      if (!preserve) {
        return {
          field: "metadata",
          message:
            "Metadata must be a JSON object whose values are strings, or cleared before saving.",
        };
      }
    }
  }
  if (props.draft.references.length > SKILL_LIMITS.references) {
    return {
      field: "references",
      message: `Use at most ${SKILL_LIMITS.references} reference files.`,
    };
  }
  let aggregate = 0;
  for (const reference of props.draft.references) {
    if (reference.path.length === 0) {
      return {
        field: "references",
        message: "A reference with content needs a canonical references/<slug>.md path.",
      };
    }
    if (!SKILL_REFERENCE_PATH.test(reference.path)) {
      return {
        field: "references",
        message:
          "Reference paths look like references/<slug>.md using lowercase letters, digits, and hyphens.",
      };
    }
    if (reference.content.length > SKILL_LIMITS.referenceContent) {
      return {
        field: "references",
        message: `Each reference file is limited to ${SKILL_LIMITS.referenceContent} characters.`,
      };
    }
    aggregate += reference.content.length;
  }
  if (aggregate > SKILL_LIMITS.referenceAggregate) {
    return {
      field: "references",
      message: `Reference files are limited to ${SKILL_LIMITS.referenceAggregate} characters in total.`,
    };
  }
  return undefined;
}

/** The JSON bundle the parent posts; mirrors `bundleSnapshot()` on the server. */
function bundlePayload(): Record<string, unknown> {
  const effective = effectiveMetadata();
  const bundle: Record<string, unknown> = {
    license: props.draft.license.trim().length === 0 ? null : props.draft.license.trim(),
    compatibility:
      props.draft.compatibility.trim().length === 0 ? null : props.draft.compatibility.trim(),
    metadata: effective.metadata,
    references: props.draft.references.map((reference) => ({
      path: reference.path,
      content: reference.content,
    })),
  };
  if (effective.raw !== undefined) {
    bundle.metadataRaw = effective.raw;
  }
  if (props.mode === "update" && props.storedIssues.length > 0) {
    bundle.preserveInvalid = true;
  }
  return bundle;
}

defineExpose({ validate, bundlePayload });
</script>

<template>
  <div class="stack">
    <details class="card skill-details" id="skill-details" open data-skill-details>
      <summary class="card__head">
        <h2 class="card__title">Details</h2>
        <span class="cluster skill-details__meta">
          <span class="hint">Identity, classification, discovery, license</span>
          <span class="skill-details__chevron" aria-hidden="true">
            <AppIcon name="chevron-right" />
          </span>
        </span>
      </summary>
      <div class="card__body stack">
        <p class="hint skill-details__intro">
          Only name, description, and the SKILL.md body are required; the rest are optional.
        </p>

        <fieldset class="skill-fieldset">
          <legend class="label">Identity</legend>
          <div v-if="mode === 'create'" class="field">
            <label class="label" for="skill-name">Name</label>
            <input
              id="skill-name"
              class="input mono"
              type="text"
              :value="draft.name"
              :required="nameField?.required ?? true"
              :maxlength="nameField?.maxlength ?? 64"
              :pattern="nameField?.pattern"
              autocomplete="off"
              spellcheck="false"
              placeholder="release-checklist"
              :aria-describedby="
                fieldError('name') === null ? 'skill-name-hint' : 'skill-name-hint skill-name-error'
              "
              @input="setName"
            >
            <p
              v-if="fieldError('name') !== null"
              class="field-error"
              id="skill-name-error"
              role="alert"
            >
              {{ fieldError("name") }}
            </p>
            <p class="hint" id="skill-name-hint">
              {{ nameField?.hint ?? "Lowercase letters, digits, and single hyphens." }}
            </p>
          </div>
          <div v-else class="field">
            <label class="label" for="skill-name">Name</label>
            <input
              id="skill-name"
              class="input mono"
              type="text"
              :value="draft.name"
              readonly
              disabled
              aria-describedby="skill-name-hint"
            >
            <p class="hint" id="skill-name-hint">
              Names are immutable. Delete and re-create the skill to rename it.
            </p>
          </div>

          <div class="field">
            <div class="cluster">
              <label class="label" for="skill-description">Description</label>
              <span class="mono" data-skill-counter-output="description">
                {{ draft.description.length }}
                / {{ SKILL_LIMITS.description }}
              </span>
            </div>
            <textarea
              id="skill-description"
              class="textarea"
              rows="3"
              :maxlength="SKILL_LIMITS.description"
              :value="draft.description"
              :disabled="!editable"
              :readonly="!editable"
              required
              data-skill-field="description"
              :aria-describedby="
                fieldError('description') === null
                  ? 'skill-description-hint'
                  : 'skill-description-hint skill-description-error'
              "
              @input="setDescription"
            ></textarea>
            <p
              v-if="fieldError('description') !== null"
              class="field-error"
              id="skill-description-error"
              role="alert"
            >
              {{ fieldError("description") }}
            </p>
            <p class="hint" id="skill-description-hint">
              What the skill does and when the agent should use it.
            </p>
          </div>

          <div class="field">
            <label class="check">
              <input type="hidden" name="enabled" value="0" :disabled="!editable">
              <input
                class="checkbox"
                type="checkbox"
                name="enabled"
                value="1"
                :checked="draft.enabled"
                :disabled="!editable"
                data-skill-field="enabled"
                aria-describedby="skill-enabled-hint"
                @change="setEnabled"
              >
              <span>Enabled</span>
            </label>
            <p class="hint" id="skill-enabled-hint">
              Uncheck to hide this skill at this context without deleting it.
            </p>
          </div>
        </fieldset>

        <fieldset class="skill-fieldset">
          <legend class="label">Classification</legend>
          <div class="grid skill-details-grid">
            <div v-for="entry in classification" :key="entry.key" class="field">
              <label class="label" :for="`skill-metadata-${entry.key}`">{{ entry.label }}</label>
              <input
                :id="`skill-metadata-${entry.key}`"
                class="input"
                type="text"
                :value="metadataValue(entry.key)"
                :list="entry.datalist === undefined ? undefined : 'skill-output-formats'"
                :disabled="!editable"
                :readonly="!editable"
                :aria-describedby="`${`skill-metadata-${entry.key}`}-hint`"
                @input="setMetadata(entry.key, $event)"
              >
              <p class="hint" :id="`skill-metadata-${entry.key}-hint`">{{ entry.hint }}</p>
            </div>
          </div>
        </fieldset>

        <fieldset class="skill-fieldset">
          <legend class="label">Discovery</legend>
          <div class="grid skill-details-grid">
            <div v-for="entry in discovery" :key="entry.key" class="field">
              <label class="label" :for="`skill-metadata-${entry.key}`">{{ entry.label }}</label>
              <input
                :id="`skill-metadata-${entry.key}`"
                class="input"
                type="text"
                :value="metadataValue(entry.key)"
                :disabled="!editable"
                :readonly="!editable"
                :aria-describedby="`${`skill-metadata-${entry.key}`}-hint`"
                @input="setMetadata(entry.key, $event)"
              >
              <p class="hint" :id="`skill-metadata-${entry.key}-hint`">{{ entry.hint }}</p>
            </div>
          </div>
        </fieldset>

        <fieldset class="skill-fieldset">
          <legend class="label">Version and license</legend>
          <div class="grid skill-details-grid">
            <div v-for="entry in versionFields" :key="entry.key" class="field">
              <label class="label" :for="`skill-metadata-${entry.key}`">{{ entry.label }}</label>
              <input
                :id="`skill-metadata-${entry.key}`"
                class="input"
                type="text"
                :value="metadataValue(entry.key)"
                :disabled="!editable"
                :readonly="!editable"
                :aria-describedby="`${`skill-metadata-${entry.key}`}-hint`"
                @input="setMetadata(entry.key, $event)"
              >
              <p class="hint" :id="`skill-metadata-${entry.key}-hint`">{{ entry.hint }}</p>
            </div>
          </div>
          <div class="field">
            <label class="label" for="skill-license">License</label>
            <input
              id="skill-license"
              class="input"
              type="text"
              :value="draft.license"
              :maxlength="SKILL_LIMITS.license"
              :disabled="!editable"
              :readonly="!editable"
              data-skill-field="license"
              aria-describedby="skill-license-hint"
              @input="setLicense"
            >
            <p class="hint" id="skill-license-hint">
              An SPDX identifier or short license name, such as MIT.
            </p>
          </div>
          <div class="field">
            <label class="label" for="skill-compatibility">Compatibility</label>
            <input
              id="skill-compatibility"
              class="input"
              type="text"
              :value="draft.compatibility"
              :maxlength="SKILL_LIMITS.compatibility"
              :disabled="!editable"
              :readonly="!editable"
              data-skill-field="compatibility"
              aria-describedby="skill-compatibility-hint"
              @input="setCompatibility"
            >
            <p class="hint" id="skill-compatibility-hint">
              Runtime or tool requirements, such as Node 20 or a specific agent version.
            </p>
          </div>
        </fieldset>

        <fieldset class="skill-fieldset">
          <legend class="label">Custom metadata</legend>
          <div class="stack--tight" data-skill-custom-metadata>
            <p v-if="draft.customMetadata.length === 0" class="hint">No custom metadata keys.</p>
            <div
              v-for="(row, index) in draft.customMetadata"
              :key="index"
              class="cluster skill-metadata-row"
              data-skill-metadata-row
            >
              <input
                class="input"
                type="text"
                :value="row.key"
                :disabled="!editable"
                :readonly="!editable"
                data-skill-metadata-key-input
                aria-label="Metadata key"
                aria-describedby="skill-custom-metadata-hint"
                @input="setCustomKey(index, $event)"
              >
              <input
                class="input"
                type="text"
                :value="row.value"
                :disabled="!editable"
                :readonly="!editable"
                data-skill-metadata-value-input
                aria-label="Metadata value"
                aria-describedby="skill-custom-metadata-hint"
                @input="setCustomValue(index, $event)"
              >
              <button
                v-if="editable"
                class="btn btn-ghost btn-sm"
                type="button"
                aria-label="Remove metadata"
                @click="removeMetadataRow(index)"
              >
                Remove
              </button>
            </div>
          </div>
          <div v-if="draft.metadataRaw !== null" class="field">
            <label class="label" for="skill-metadata-raw">Raw metadata JSON</label>
            <textarea
              id="skill-metadata-raw"
              class="textarea font-mono"
              rows="6"
              :value="draft.metadataRaw"
              :disabled="!editable"
              :readonly="!editable"
              data-skill-metadata-raw
              aria-describedby="skill-metadata-raw-hint"
              @input="setRawMetadata"
            ></textarea>
            <p class="hint" id="skill-metadata-raw-hint">
              The stored metadata is invalid. Repair it as a JSON object, or clear it to start over.
            </p>
            <button
              v-if="editable"
              class="btn btn-secondary btn-sm"
              type="button"
              data-skill-clear-metadata
              @click="clearMetadata"
            >
              Clear metadata
            </button>
          </div>
          <p class="hint" id="skill-custom-metadata-hint">
            Extra key/value pairs are preserved as-is for tooling you control.
          </p>
          <button
            v-if="editable"
            class="btn btn-secondary btn-sm"
            type="button"
            data-skill-add-metadata
            @click="addMetadataRow"
          >
            Add metadata
          </button>
        </fieldset>

        <datalist id="skill-output-formats">
          <option value="mixed"></option>
          <option value="code"></option>
          <option value="report"></option>
          <option value="document"></option>
          <option value="plan"></option>
          <option value="decision"></option>
        </datalist>
      </div>
    </details>

    <section class="card skill-files" data-skill-files>
      <div class="card__head">
        <h2 class="card__title">Source and preview</h2>
        <p class="hint">
          <template v-if="editable">
            One bundle form: metadata, SKILL.md, and every reference save together.
          </template>
          <template v-else>
            Read-only source from the winning row. Override here to edit a copy at this context.
          </template>
        </p>
      </div>
      <div class="card__body">
        <div class="skill-workspace" data-skill-workspace>
          <aside
            v-if="draft.references.length > 0"
            class="skill-file-list"
            data-skill-file-list
            aria-label="Skill files"
          >
            <div class="skill-file-list__head">
              <p class="nav-label">Files</p>
              <span class="hint mono" data-skill-file-count>
                {{ draft.references.length + 1 }}
              </span>
            </div>
            <div class="skill-file-tabs" data-skill-file-tabs>
              <button
                class="settings-nav__link skill-file-tab"
                type="button"
                :aria-current="activeReference < 0 ? 'page' : undefined"
                data-skill-file-tab
                @click="selectReference(-1)"
              >
                <span class="skill-file-tab__name">SKILL.md</span>
                <span class="hint mono skill-file-tab__size">{{ draft.content.length }} chars</span>
              </button>
              <button
                v-for="(reference, index) in draft.references"
                :key="index"
                class="settings-nav__link skill-file-tab"
                type="button"
                :aria-current="activeReference === index ? 'page' : undefined"
                data-skill-file-tab
                @click="selectReference(index)"
              >
                <span class="skill-file-tab__name">{{ reference.path || "New reference" }}</span>
                <span class="hint mono skill-file-tab__size"
                  >{{ reference.content.length }}
                  chars</span
                >
              </button>
            </div>
            <button
              v-if="editable"
              class="btn btn-secondary btn-sm skill-add-reference"
              type="button"
              data-skill-add-reference
              @click="addReference"
            >
              Add reference
            </button>
          </aside>

          <div class="skill-viewtabs" data-skill-viewtabs>
            <div
              class="segmented skill-viewtabs__group"
              role="tablist"
              aria-label="Source or preview"
            >
              <button
                class="segmented__item"
                type="button"
                role="tab"
                :aria-selected="view === 'source' ? 'true' : 'false'"
                @click="view = 'source'"
              >
                Source
              </button>
              <button
                class="segmented__item"
                type="button"
                role="tab"
                :aria-selected="view === 'preview' ? 'true' : 'false'"
                @click="view = 'preview'"
              >
                Preview
              </button>
            </div>
          </div>

          <div v-show="view === 'source'" class="skill-panes" data-skill-panes>
            <section
              v-show="activeReference < 0"
              class="skill-source-pane"
              data-skill-file
              data-skill-file-kind="skill"
              data-skill-file-path="SKILL.md"
            >
              <div class="cluster">
                <label class="label" for="skill-content">SKILL.md body</label>
                <span class="hint mono" data-skill-file-size>
                  {{ draft.content.length }}
                  / {{ SKILL_LIMITS.content }}
                </span>
              </div>
              <p class="hint" id="skill-content-hint">
                The frontmatter is generated from Details; edit only the body here.
              </p>
              <textarea
                v-if="editable"
                id="skill-content"
                class="textarea font-mono skill-source"
                rows="20"
                :maxlength="SKILL_LIMITS.content"
                :value="draft.content"
                :disabled="!editable"
                :readonly="!editable"
                required
                spellcheck="false"
                data-skill-field="content"
                aria-describedby="skill-content-hint"
                @input="setContent"
              ></textarea>
              <pre v-else class="skill-source prose--pre" data-skill-source-static>{{
                draft.content
              }}</pre>
            </section>

            <section
              v-if="currentReference !== undefined"
              v-show="activeReference >= 0"
              class="skill-source-pane"
              data-skill-file
              data-skill-file-kind="reference"
              data-skill-reference
            >
              <div class="cluster skill-file-head">
                <div class="field skill-file-path-field">
                  <label class="label" for="skill-reference-path">Path</label>
                  <input
                    id="skill-reference-path"
                    class="input mono"
                    type="text"
                    :value="currentReference?.path"
                    :disabled="!editable"
                    :readonly="!editable"
                    data-skill-reference-path
                    placeholder="references/example.md"
                    aria-label="Reference path"
                    :maxlength="SKILL_LIMITS.referencePath"
                    spellcheck="false"
                    autocomplete="off"
                    @input="setReferencePath"
                  >
                </div>
                <span class="hint mono" data-skill-file-size>
                  {{ currentReference?.content.length ?? 0 }}
                  chars
                </span>
                <button
                  v-if="editable"
                  class="btn btn-ghost btn-sm"
                  type="button"
                  data-skill-remove-reference
                  aria-label="Remove this reference file"
                  @click="removeReference(activeReference)"
                >
                  Remove this file
                </button>
              </div>
              <div class="cluster">
                <label class="label" for="skill-reference-content">Reference body</label>
                <span class="mono">
                  {{ currentReference?.content.length ?? 0 }}
                  /
                  {{ SKILL_LIMITS.referenceContent }}
                </span>
              </div>
              <textarea
                v-if="editable"
                id="skill-reference-content"
                class="textarea font-mono skill-source"
                rows="12"
                :maxlength="SKILL_LIMITS.referenceContent"
                :value="currentReference?.content"
                spellcheck="false"
                data-skill-reference-content
                aria-describedby="skill-reference-content-hint"
                @input="setReferenceContent"
              ></textarea>
              <pre v-else class="skill-source prose--pre" data-skill-source-static>{{
                currentReference?.content
              }}</pre>
              <p class="hint" id="skill-reference-content-hint">
                Markdown reference loaded only when the skill points to this file.
              </p>
            </section>
          </div>

          <div
            v-show="view === 'preview'"
            class="skill-preview-pane"
            data-skill-preview-pane
            tabindex="-1"
          >
            <div class="cluster skill-preview-head">
              <p class="label">Preview</p>
              <p class="hint mono" data-skill-preview-title>{{ previewTitle }}</p>
            </div>
            <details v-if="frontmatter() !== undefined" class="skill-frontmatter">
              <summary class="skill-frontmatter__summary">
                <span class="label">Frontmatter</span>
                <span class="hint">Generated from Details</span>
                <AppIcon name="chevron-right" class-name="skill-frontmatter__chevron" />
              </summary>
              <div class="skill-frontmatter__body">
                <pre class="skill-frontmatter__pre">{{ frontmatter()?.text }}</pre>
                <div class="cluster">
                  <button class="btn btn-ghost btn-sm" type="button" @click="copyFrontmatter">
                    <AppIcon name="copy" />
                    {{
                      copyState === "copied"
                        ? "Copied"
                        : copyState === "failed"
                          ? "Copy failed"
                          : "Copy"
                    }}
                  </button>
                  <span v-if="frontmatter()?.broken" class="hint">
                    Metadata needs repair before it can appear in the generated frontmatter.
                  </span>
                </div>
              </div>
            </details>
            <div class="skill-prose" aria-live="polite">
              <SafeMarkdown v-if="previewText.trim().length > 0" :text="previewText" />
              <p v-else class="hint">Nothing to preview yet.</p>
            </div>
          </div>
        </div>

        <div class="cluster skill-reference-foot" id="skill-references">
          <button
            v-if="editable"
            class="btn btn-secondary btn-sm"
            type="button"
            data-skill-add-reference
            @click="addReference"
          >
            Add reference
          </button>
          <span class="hint" data-skill-reference-aggregate>
            {{ draft.references.length }}
            of {{ SKILL_LIMITS.references }} files ·
            {{ draft.references.reduce((total, reference) => total + reference.content.length, 0) }}
            of
            {{ SKILL_LIMITS.referenceAggregate }}
            characters
          </span>
        </div>
        <p class="hint" id="skill-references-hint">
          References are flat references/&lt;slug&gt;.md files, up to {{ SKILL_LIMITS.references }}
          files and {{ SKILL_LIMITS.referenceAggregate }} characters total.
        </p>
        <p v-if="fieldError('references') !== null" class="field-error" role="alert">
          {{ fieldError("references") }}
        </p>
      </div>
    </section>
  </div>
</template>
