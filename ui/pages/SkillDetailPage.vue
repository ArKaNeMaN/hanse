<script setup lang="ts">
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import SkillBundleEditor from "../components/SkillBundleEditor.vue";
import SkillsScopeNav from "../components/SkillsScopeNav.vue";
import SmartLink from "../components/SmartLink.vue";
import { applyChrome } from "../composables/useChrome.js";
import { markSkillsMutated } from "../skills-mutation.js";
import type {
  SkillActionFormProps,
  SkillDangerProps,
  SkillDetailResponse,
  SkillDraft,
  SkillPendingAppProps,
  SkillWorkspaceProps,
} from "../skills-types.js";
import { useToastStore } from "../stores/toasts.js";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();
const queryClient = useQueryClient();

function queryString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

const skillId = computed(() => queryString(route.params.id));
const fromPath = computed(() => queryString(route.query.from));

const bootDetail = computed<SkillWorkspaceProps | undefined>(() => {
  if (props.boot.route.id !== "skills-detail") {
    return undefined;
  }
  if (props.boot.route.params.id !== skillId.value) {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as SkillWorkspaceProps;
});

const detailQuery = useQuery<SkillDetailResponse>({
  queryKey: computed(() => ["skills-detail", skillId.value, fromPath.value]),
  queryFn: () =>
    apiQuery<SkillDetailResponse>(
      `/api/ui/skills/${encodeURIComponent(skillId.value)}${
        fromPath.value.length === 0 ? "" : `?from=${encodeURIComponent(fromPath.value)}`
      }`,
    ),
  initialData: () => bootDetail.value,
  staleTime: 30_000,
  retry: false,
});

const view = computed<SkillWorkspaceProps | undefined>(
  () => detailQuery.data.value ?? bootDetail.value,
);
const loading = computed(() => detailQuery.isFetching.value);
const failed = computed(() => detailQuery.isError.value);
const notFound = computed(() => {
  const error = detailQuery.error.value;
  return error instanceof ApiError && error.status === 404;
});
const failure = computed(() => {
  const error = detailQuery.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load the skill.";
});

/* ------------------------------------------------------------------------- */
/* Draft                                                                      */
/* ------------------------------------------------------------------------- */

const KNOWN_KEYS = new Set([
  "domain",
  "role",
  "scope",
  "output-format",
  "triggers",
  "related-skills",
  "version",
  "author",
]);

function emptyDraft(): SkillDraft {
  return {
    name: "",
    description: "",
    content: "",
    enabled: true,
    license: "",
    compatibility: "",
    knownMetadata: {},
    customMetadata: [],
    metadataRaw: null,
    references: [],
  };
}

function draftFromView(value: SkillWorkspaceProps): SkillDraft {
  const knownMetadata: Record<string, string> = {};
  const customMetadata: Array<{ key: string; value: string }> = [];
  for (const [key, entry] of Object.entries(value.values.bundle.metadata)) {
    if (KNOWN_KEYS.has(key)) {
      knownMetadata[key] = entry;
    } else {
      customMetadata.push({ key, value: entry });
    }
  }
  return {
    name: value.values.name,
    description: value.values.description,
    content: value.values.content,
    enabled: value.values.enabled,
    license: value.values.bundle.license ?? "",
    compatibility: value.values.bundle.compatibility ?? "",
    knownMetadata,
    customMetadata,
    metadataRaw: value.values.bundle.metadataRaw,
    references: value.values.bundle.references.map((reference) => ({
      path: reference.path,
      content: reference.content,
    })),
  };
}

const draft = ref<SkillDraft>(emptyDraft());
const editor = ref<InstanceType<typeof SkillBundleEditor> | null>(null);
const clientError = ref<{ message: string; field: string | null } | null>(null);
const submitting = ref(false);
const confirmName = ref("");
const deleteError = ref<string | null>(null);

watch(
  view,
  (value) => {
    draft.value = value === undefined ? emptyDraft() : draftFromView(value);
    confirmName.value = "";
    clientError.value = null;
    deleteError.value = null;
  },
  { immediate: true },
);

const displayedError = computed(() => clientError.value ?? view.value?.error ?? null);
const editable = computed(() => view.value?.form !== null && view.value?.form !== undefined);

/* ------------------------------------------------------------------------- */
/* Actions                                                                    */
/* ------------------------------------------------------------------------- */

async function refreshDetail(): Promise<void> {
  const result = await detailQuery.refetch();
  const chrome = result.data?.chrome;
  if (chrome !== undefined) {
    applyChrome(chrome);
  }
}

async function save(): Promise<void> {
  const value = view.value;
  const form = value?.form;
  const bundleEditor = editor.value;
  if (
    value === undefined ||
    form === null ||
    form === undefined ||
    bundleEditor === null ||
    submitting.value
  ) {
    return;
  }
  clientError.value = null;
  const invalid = bundleEditor.validate();
  if (invalid !== undefined) {
    clientError.value = { message: invalid.message, field: invalid.field };
    return;
  }
  submitting.value = true;
  try {
    const bundle = bundleEditor.bundlePayload();
    await apiMutation(form.action, {
      json: {
        action: "update",
        return_to: form.returnTo,
        description: draft.value.description,
        content: draft.value.content,
        enabled: draft.value.enabled,
        ...bundle,
      },
    });
    markSkillsMutated();
    queryClient.removeQueries({ queryKey: ["skills-inventory"] });
    await refreshDetail();
    toasts.push(draft.value.enabled ? "Skill saved." : "Skill disabled here.", "success");
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "The skill could not be saved.";
    clientError.value = { message, field: null };
    toasts.push(message, "error");
  } finally {
    submitting.value = false;
  }
}

function discard(): void {
  const value = view.value;
  if (value === undefined) {
    return;
  }
  draft.value = draftFromView(value);
  clientError.value = null;
  toasts.push("Changes discarded.", "success");
}

function confirmAction(form: SkillActionFormProps): boolean {
  return form.confirm === null || window.confirm(form.confirm);
}

async function runAction(form: SkillActionFormProps, enabled: "1" | "0"): Promise<void> {
  const value = view.value;
  if (value === undefined || submitting.value || !confirmAction(form)) {
    return;
  }
  submitting.value = true;
  try {
    await apiMutation(form.action, {
      json: {
        action: "override",
        from_id: form.fromId ?? 0,
        enabled,
        scope: value.actions.target.scope,
        ...(value.actions.target.scope === "global"
          ? {}
          : { project: value.actions.target.projectId ?? "" }),
        ...(value.actions.target.scope === "app" ? { app: value.actions.target.appKey ?? "" } : {}),
        return_to: form.returnTo,
      },
    });
    markSkillsMutated();
    queryClient.removeQueries({ queryKey: ["skills-inventory"] });
    toasts.push(enabled === "0" ? "Skill disabled here." : "Skill overridden here.", "success");
    void router.push(form.returnTo);
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "The skill action failed.";
    toasts.push(message, "error");
  } finally {
    submitting.value = false;
  }
}

async function revert(form: SkillActionFormProps): Promise<void> {
  if (submitting.value || !confirmAction(form)) {
    return;
  }
  submitting.value = true;
  try {
    await apiMutation(form.action, { json: { return_to: form.returnTo } });
    markSkillsMutated();
    queryClient.removeQueries({ queryKey: ["skills-inventory"] });
    toasts.push("Skill reverted to inherited.", "success");
    void router.push(form.returnTo);
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "The skill could not be reverted.";
    toasts.push(message, "error");
  } finally {
    submitting.value = false;
  }
}

async function removeSkill(danger: SkillDangerProps): Promise<void> {
  const value = view.value;
  if (value === undefined || submitting.value) {
    return;
  }
  deleteError.value = null;
  if (!danger.invalidName && confirmName.value !== danger.expectedName) {
    deleteError.value = "The confirmation name does not match this skill.";
    return;
  }
  submitting.value = true;
  try {
    await apiMutation(danger.action, {
      json: {
        return_to: danger.returnTo,
        ...(danger.invalidName ? {} : { confirm_name: confirmName.value }),
      },
    });
    markSkillsMutated();
    queryClient.removeQueries({ queryKey: ["skills-inventory"] });
    toasts.push(value.row.enabled ? "Skill deleted." : "Skill reverted to inherited.", "success");
    void router.push(danger.returnTo);
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "The skill could not be deleted.";
    deleteError.value = message;
    toasts.push(message, "error");
  } finally {
    submitting.value = false;
  }
}

async function restart(entry: SkillPendingAppProps): Promise<void> {
  if (submitting.value) {
    return;
  }
  submitting.value = true;
  try {
    const separator = entry.restartAction.includes("?") ? "&" : "?";
    const result = await apiMutation<{ restarted?: boolean }>(
      `${entry.restartAction}${separator}return_to=${encodeURIComponent(entry.returnTo)}`,
      { json: {} },
    );
    await refreshDetail();
    toasts.push(
      result.restarted === false
        ? "Agent is not running; skills apply on next start."
        : "Agent restarted.",
      "success",
    );
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "The agent could not be restarted.";
    toasts.push(message, "error");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">{{ view?.header.overline ?? "Skill" }}</p>
      <h1 class="page-title">{{ view?.header.title ?? "Skill" }}</h1>
      <p class="page-description">{{ view?.header.description ?? "" }}</p>
      <div v-if="view !== undefined" class="page-meta">
        <span v-for="entry in view.header.meta" :key="entry" class="mono">{{ entry }}</span>
      </div>
    </div>
    <div v-if="view !== undefined" class="page-header__actions">
      <template v-if="view.header.backHref !== null">
        <SmartLink class="btn btn-ghost" :to="view.header.backHref">
          {{ view.labels.backToSkills }}
        </SmartLink>
      </template>
      <div v-else class="cluster skill-page-actions" data-skill-actions>
        <button
          v-if="view.actions.override !== null"
          class="btn"
          :class="`btn-${view.actions.override.style}`"
          type="button"
          :disabled="submitting"
          @click="runAction(view.actions.override, '1')"
        >
          {{ view.actions.override.label }}
        </button>
        <button
          v-if="view.actions.disable !== null"
          class="btn"
          :class="`btn-${view.actions.disable.style}`"
          type="button"
          :disabled="submitting"
          @click="runAction(view.actions.disable, '0')"
        >
          {{ view.actions.disable.label }}
        </button>
        <SmartLink
          v-if="view.actions.editAtSource !== null"
          class="btn"
          :class="`btn-${view.actions.editAtSource.style}`"
          :to="view.actions.editAtSource.href"
        >
          {{ view.actions.editAtSource.label }}
        </SmartLink>
        <SmartLink
          v-if="view.actions.openEffective !== null"
          class="btn"
          :class="`btn-${view.actions.openEffective.style}`"
          :to="view.actions.openEffective.href"
        >
          {{ view.actions.openEffective.label }}
        </SmartLink>
        <SmartLink
          v-if="view.actions.openTombstone !== null"
          class="btn"
          :class="`btn-${view.actions.openTombstone.style}`"
          :to="view.actions.openTombstone.href"
        >
          {{ view.actions.openTombstone.label }}
        </SmartLink>
        <button
          v-if="view.actions.revert !== null"
          class="btn"
          :class="`btn-${view.actions.revert.style}`"
          type="button"
          :disabled="submitting"
          @click="revert(view.actions.revert)"
        >
          {{ view.actions.revert.label }}
        </button>
        <SmartLink
          v-if="view.actions.openRepair !== null"
          class="btn"
          :class="`btn-${view.actions.openRepair.style}`"
          :to="view.actions.openRepair.href"
        >
          {{ view.actions.openRepair.label }}
        </SmartLink>
        <SmartLink
          v-if="view.actions.openSource !== null"
          class="btn"
          :class="`btn-${view.actions.openSource.style}`"
          :to="view.actions.openSource.href"
        >
          {{ view.actions.openSource.label }}
        </SmartLink>
      </div>
    </div>
  </header>

  <div class="page__body">
    <p v-if="loading && view !== undefined" class="hint" role="status" aria-live="polite">
      Updating skill…
    </p>

    <section v-if="failed && view === undefined" class="card">
      <div class="card__head">
        <h2 class="card__title">
          {{ notFound ? "Skill not found" : "Skill could not be loaded" }}
        </h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">
          {{ notFound ? "This skill does not exist or was deleted." : failure }}
        </p>
        <div class="cluster">
          <button
            v-if="!notFound"
            class="btn btn-secondary btn-sm"
            type="button"
            @click="detailQuery.refetch()"
          >
            <AppIcon name="refresh" />Retry
          </button>
          <RouterLink class="btn btn-secondary btn-sm" to="/skills">Global skills</RouterLink>
          <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
        </div>
      </div>
    </section>

    <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
      Loading skill…
    </p>

    <template v-else>
      <SkillsScopeNav :model="view.scope" />
      <div class="cluster section">
        <span class="badge" :class="`badge-${view.stateBadge.tone}`" data-skill-state>
          {{ view.stateBadge.label }}
        </span>
        <SmartLink class="small" :to="view.contextPage">{{ view.labels.backToSkills }}</SmartLink>
        <span class="hint">
          Source:
          <strong class="mono">{{
            view.row.scope === "app"
              ? "Application"
              : view.row.scope === "project"
                ? "Project"
                : "Global"
          }}</strong>
          · {{ view.state.note }}
        </span>
      </div>

      <section
        v-if="view.restart !== null && view.restart.kind === 'required'"
        class="settings-warning"
        role="status"
        data-skill-restart-banner
      >
        <p class="settings-warning__title"><AppIcon name="refresh" />Restart required</p>
        <p class="small">{{ view.restart.hint }}</p>
        <div v-for="entry in view.restart.entries" :key="entry.appKey" class="cluster">
          <SmartLink class="small" :to="entry.href">{{ entry.appKey }}</SmartLink>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="submitting"
            @click="restart(entry)"
          >
            <AppIcon name="refresh" />Restart agent
          </button>
        </div>
      </section>
      <p v-else-if="view.restart !== null" class="hint" data-skill-restart-banner="none">
        <AppIcon name="check" />{{ view.restart.hint }}
      </p>

      <section
        v-if="view.collisions.length > 0"
        class="settings-warning"
        role="alert"
        data-skill-collisions
      >
        <p
          v-for="warning in view.collisions"
          :key="`${warning.code}-${warning.root}-${warning.name}`"
          class="field-error"
        >
          <AppIcon name="alert-triangle" />{{ warning.text }}
        </p>
      </section>

      <section
        v-if="view.issues.length > 0"
        class="settings-warning"
        role="alert"
        data-skill-issues
      >
        <p class="settings-warning__title"><AppIcon name="alert-triangle" />Issues</p>
        <ul class="stack--tight">
          <li v-for="issue in view.issues" :key="`${issue.code}-${issue.message}`">
            {{ issue.message }}
            <a v-if="issue.anchor !== null" class="small" :href="issue.anchor">Repair</a>
          </li>
        </ul>
      </section>

      <div v-if="editable" class="stack skill-edit-workspace" data-skill-edit-workspace>
        <form
          class="stack skill-bundle-form"
          method="post"
          :action="view.form?.action"
          data-skill-form
          data-skill-mode="update"
          :data-skill-name="view.name"
          @submit.prevent="save"
        >
          <input type="hidden" name="return_to" :value="view.form?.returnTo">
          <div class="skill-editbar" data-skill-editbar>
            <p class="hint" data-skill-status role="status">
              {{ submitting ? "Saving…" : "All changes saved" }}
            </p>
            <button
              class="btn btn-primary"
              type="submit"
              name="action"
              value="update"
              data-skill-save
              :disabled="submitting"
            >
              {{ view.form?.saveLabel }}
            </button>
            <button
              class="btn btn-ghost"
              type="button"
              data-skill-discard
              :disabled="submitting"
              @click="discard"
            >
              {{ view.form?.discardLabel }}
            </button>
          </div>

          <div v-if="displayedError !== null" class="settings-warning" role="alert">
            <p class="settings-warning__title">
              <AppIcon name="alert-triangle" />{{ displayedError.message }}
            </p>
          </div>
          <p v-if="view.conflict !== null" class="field-error" role="alert" data-skill-conflict>
            This name already exists at this scope.
            <SmartLink :to="view.conflict.href">Open the existing skill</SmartLink>.
          </p>

          <SkillBundleEditor
            ref="editor"
            :draft="draft"
            :editable="true"
            mode="update"
            :error="displayedError"
            :name-field="view.form?.nameField ?? null"
            :stored-issues="view.row.storedIssues"
          />
        </form>

        <section v-if="view.danger !== null" class="card skill-danger" data-skill-danger>
          <div class="card__head">
            <h2 class="card__title">Danger zone</h2>
          </div>
          <div class="card__body stack">
            <p class="small">{{ view.danger.explanation }}</p>
            <div v-if="!view.danger.invalidName" class="field">
              <label class="label" for="skill-confirm-name">
                Type the exact skill name to confirm
              </label>
              <input
                id="skill-confirm-name"
                v-model="confirmName"
                class="input mono"
                type="text"
                name="confirm_name"
                required
                autocomplete="off"
                spellcheck="false"
                :aria-describedby="deleteError === null ? undefined : 'skill-confirm-name-error'"
              >
              <p
                v-if="deleteError !== null"
                class="field-error"
                id="skill-confirm-name-error"
                role="alert"
              >
                {{ deleteError }}
              </p>
            </div>
            <button
              class="btn btn-danger"
              type="button"
              :disabled="submitting"
              data-skill-delete
              @click="removeSkill(view.danger)"
            >
              <AppIcon name="trash" />{{ view.danger.label }}
            </button>
          </div>
        </section>
      </div>

      <div v-else class="stack skill-readonly-workspace" data-skill-readonly-workspace>
        <div class="stack skill-readonly" data-skill-readonly :data-skill-name="view.name">
          <SkillBundleEditor
            :draft="draft"
            :editable="false"
            mode="update"
            :error="displayedError"
            :name-field="null"
            :stored-issues="view.row.storedIssues"
          />
        </div>

        <section
          v-if="view.danger !== null && view.state.name === 'invalid-owned-name'"
          class="card skill-danger"
          data-skill-danger
        >
          <div class="card__head">
            <h2 class="card__title">Danger zone</h2>
          </div>
          <div class="card__body stack">
            <p class="small">{{ view.danger.explanation }}</p>
            <button
              class="btn btn-danger"
              type="button"
              :disabled="submitting"
              data-skill-delete
              @click="removeSkill(view.danger)"
            >
              <AppIcon name="trash" />{{ view.danger.label }}
            </button>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
