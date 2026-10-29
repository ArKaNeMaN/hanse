<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import HandoffReviewDialog from "../components/HandoffReviewDialog.vue";
import RouteText from "../components/RouteText.vue";
import SmartLink from "../components/SmartLink.vue";
import StatusPill from "../components/StatusPill.vue";
import { applyChrome } from "../composables/useChrome.js";
import { absoluteTime, timeAgo } from "../format.js";
import type {
  HandoffFilter,
  HandoffRow,
  HandoffsProps,
  HandoffsResponse,
} from "../handoff-types.js";
import type { ProjectHandoff } from "../project-types.js";
import { replyPill, statusPill } from "../status.js";
import { useToastStore } from "../stores/toasts.js";

const FILTERS: readonly HandoffFilter[] = ["all", "waiting", "active", "closed", "replies"];
const EMPTY_COUNTS = { all: 0, waiting: 0, active: 0, closed: 0, replies: 0 } as const;

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

function queryString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

const routeFilter = computed<HandoffFilter>(() => {
  const raw = queryString(route.query.filter);
  return FILTERS.includes(raw as HandoffFilter) ? (raw as HandoffFilter) : "all";
});
const routeQuery = computed(() => queryString(route.query.q).trim());

// A client navigation keeps the first document's boot payload. Use it only when both the route id
// and the filter/query match the current URL; otherwise fetch `/api/ui/handoffs`.
const bootProps = computed<HandoffsProps | undefined>(() => {
  if (props.boot.route.id !== "handoffs") {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as HandoffsProps;
  return candidate.filter === routeFilter.value && candidate.query === routeQuery.value
    ? candidate
    : undefined;
});

const inboxQuery = useQuery<HandoffsResponse>({
  queryKey: computed(() => ["handoffs", routeFilter.value, routeQuery.value]),
  queryFn: () =>
    apiQuery<HandoffsResponse>(
      `/api/ui/handoffs?filter=${encodeURIComponent(routeFilter.value)}&q=${encodeURIComponent(routeQuery.value)}`,
    ),
  initialData: () => bootProps.value,
  staleTime: 30_000,
  retry: false,
});

const view = computed<HandoffsProps | undefined>(() => inboxQuery.data.value ?? bootProps.value);
const hasData = computed(() => view.value !== undefined);
const loading = computed(() => inboxQuery.isFetching.value);
const failed = computed(() => inboxQuery.isError.value);
const notFound = computed(() => {
  const error = inboxQuery.error.value;
  return error instanceof ApiError && error.status === 404;
});
const failure = computed(() => {
  const error = inboxQuery.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load the handoff inbox.";
});
const counts = computed(() => view.value?.counts ?? EMPTY_COUNTS);
const rows = computed(() =>
  (view.value?.rows ?? []).map((row) => ({
    ...row,
    statePill: statusPill(row.state),
    reply: replyPill(row.replyState),
  })),
);

const searchInput = ref(routeQuery.value);
watch(routeQuery, (value) => {
  searchInput.value = value;
});

const pendingDecision = ref<{ id: string; decision: "approved" | "rejected" } | null>(null);
const selectedHandoff = ref<ProjectHandoff | null>(null);
const reviewDialog = ref<InstanceType<typeof HandoffReviewDialog> | null>(null);

function pending(row: HandoffRow): boolean {
  return pendingDecision.value?.id === row.id;
}

function submitSearch(): void {
  const params = new URLSearchParams();
  if (routeFilter.value !== "all") {
    params.set("filter", routeFilter.value);
  }
  const needle = searchInput.value.trim();
  if (needle.length > 0) {
    params.set("q", needle);
  }
  const query = params.toString();
  void router.push(query.length === 0 ? "/handoffs" : `/handoffs?${query}`);
}

async function refreshInbox(): Promise<void> {
  const result = await inboxQuery.refetch();
  const chrome = (result.data as HandoffsResponse | undefined)?.chrome;
  if (chrome !== undefined) {
    applyChrome(chrome);
  }
}

function messageFor(kind: "dispatch" | "reply", decision: "approved" | "rejected"): string {
  if (kind === "reply") {
    return decision === "approved" ? "Reply approved." : "Reply rejected.";
  }
  return decision === "approved" ? "Handoff approved." : "Handoff rejected.";
}

async function decideInline(row: HandoffRow, decision: "approved" | "rejected"): Promise<void> {
  const inline = row.inlineDecision;
  if (inline === null || pendingDecision.value !== null) {
    return;
  }
  pendingDecision.value = { id: row.id, decision };
  try {
    await apiMutation<{ ok: true; decision: "approved" | "rejected" }>(inline.action, {
      form: {
        decision,
        approval_kind: inline.approvalKind,
        return_to: inline.returnTo,
      },
    });
    toasts.push(messageFor(inline.approvalKind, decision), "success");
    await refreshInbox();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not record the decision.";
    toasts.push(message, "error");
  } finally {
    pendingDecision.value = null;
  }
}

async function openReview(row: HandoffRow): Promise<void> {
  selectedHandoff.value = row.dialog;
  await nextTick();
  reviewDialog.value?.open();
}
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Workbench</p>
      <h1 class="page-title">Handoffs</h1>
      <p class="page-description">
        Requests between sibling applications, with operator approval where required.
      </p>
      <div class="page-meta">
        <span class="mono">{{ counts.all }} total</span>
        <span class="mono">{{ counts.waiting }} waiting</span>
        <span class="mono">{{ counts.active }} active</span>
        <span class="mono">{{ counts.replies }} replies waiting</span>
      </div>
    </div>
  </header>

  <div class="page__body">
    <p v-if="loading && hasData" class="hint" role="status" aria-live="polite">
      Updating handoffs…
    </p>

    <section v-if="failed" class="card" aria-labelledby="handoffs-error-title">
      <div class="card__head">
        <h2 class="card__title" id="handoffs-error-title">
          {{ notFound ? "Handoffs not found" : "Handoffs could not be loaded" }}
        </h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">{{ failure }}</p>
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" type="button" @click="inboxQuery.refetch()">
            <AppIcon name="refresh" />Retry
          </button>
          <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
        </div>
      </div>
    </section>

    <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
      Loading handoffs…
    </p>

    <template v-else>
      <div class="toolbar">
        <!-- biome-ignore lint/a11y/useSemanticElements: keep the legacy segmented control markup -->
        <div class="segmented" role="group" aria-label="Handoff filter">
          <SmartLink
            v-for="entry in view.filters"
            :key="entry.value"
            class="segmented__item"
            :to="entry.href"
            :aria-current="entry.current ? 'page' : undefined"
          >
            {{ entry.label }} <span class="mono">{{ entry.count }}</span>
          </SmartLink>
        </div>
        <!-- biome-ignore lint/a11y/useSemanticElements: keep the legacy search form contract -->
        <form
          class="cluster"
          method="get"
          :action="view.search.action"
          role="search"
          @submit.prevent="submitSearch"
        >
          <input
            v-if="view.search.hiddenFilter !== null"
            type="hidden"
            name="filter"
            :value="view.search.hiddenFilter"
          >
          <label class="sr-only" for="handoff-search">Search handoffs</label>
          <input
            id="handoff-search"
            v-model="searchInput"
            class="input search-input"
            name="q"
            :placeholder="view.search.placeholder"
            autocomplete="off"
          >
          <button class="btn btn-secondary" type="submit"><AppIcon name="search" />Search</button>
          <SmartLink
            v-if="view.search.clearHref !== null"
            class="btn btn-ghost"
            :to="view.search.clearHref"
          >
            Clear search
          </SmartLink>
        </form>
      </div>

      <div v-if="view.emptyState !== null" class="empty-state">
        <span class="empty-state__mark">
          <AppIcon :name="view.emptyState.iconName" class-name="icon--lg" />
        </span>
        <h3 class="empty-state__title">{{ view.emptyState.title }}</h3>
        <p class="empty-state__body">{{ view.emptyState.body }}</p>
        <div class="cluster">
          <SmartLink class="btn btn-secondary btn-sm" :to="view.emptyState.actionHref">
            {{ view.emptyState.actionLabel }}
          </SmartLink>
        </div>
      </div>

      <section v-else class="card" aria-labelledby="handoffs-table-title">
        <div class="card__head">
          <h2 class="card__title" id="handoffs-table-title">{{ view.tableTitle }}</h2>
          <span class="mono">{{ view.rows.length }}</span>
        </div>
        <div class="card__body card__body--flush">
          <div class="table-wrap">
            <table class="table table--stack table--handoffs table--inbox">
              <thead>
                <tr>
                  <th scope="col">Id</th>
                  <th scope="col">Route</th>
                  <th scope="col">State</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Updated</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :id="`handoff-${row.id}`" :key="row.id">
                  <td data-label="Id">
                    <span class="mono table__nowrap">{{ row.shortId }}</span>
                  </td>
                  <td data-label="Route">
                    <RouteText :from="row.fromAppKey" :to="row.toAppKey" />
                  </td>
                  <td data-label="State">
                    <div class="cluster">
                      <StatusPill :pill="row.statePill" />
                      <StatusPill v-if="row.reply !== undefined" :pill="row.reply" />
                    </div>
                  </td>
                  <td data-label="Summary">
                    <span class="table__primary">{{ row.summary }}</span>
                  </td>
                  <td data-label="Updated">
                    <span class="mono table__nowrap">
                      <time :datetime="row.updatedAt" :title="absoluteTime(row.updatedAt)">
                        {{ timeAgo(row.updatedAt) }}
                      </time>
                    </span>
                  </td>
                  <td data-label="Actions" class="table__actions">
                    <div class="table__action-group">
                      <form
                        v-if="row.inlineDecision !== null"
                        class="table__inline-form"
                        method="post"
                        :action="row.inlineDecision.action"
                        :aria-busy="pending(row)"
                        @submit.prevent
                      >
                        <input
                          type="hidden"
                          name="approval_kind"
                          :value="row.inlineDecision.approvalKind"
                        >
                        <input type="hidden" name="return_to" :value="row.inlineDecision.returnTo">
                        <button
                          class="btn btn-danger btn-sm"
                          type="button"
                          :disabled="pending(row)"
                          @click="decideInline(row, 'rejected')"
                        >
                          Reject
                        </button>
                        <button
                          class="btn btn-primary btn-sm"
                          type="button"
                          :disabled="pending(row)"
                          @click="decideInline(row, 'approved')"
                        >
                          Approve
                        </button>
                      </form>
                      <button class="btn btn-ghost btn-sm" type="button" @click="openReview(row)">
                        Review
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <HandoffReviewDialog
        v-if="selectedHandoff !== null"
        ref="reviewDialog"
        :handoff="selectedHandoff"
        @changed="refreshInbox"
      />
    </template>
  </div>
</template>
