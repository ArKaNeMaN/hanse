import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySnapshot, deriveQueue, rekeyOptimistic } from "../assets/chat-core.js";

/**
 * Characterization snapshot for the copy-first Stage 3A `chat-feed-store.js` extraction.
 *
 * The expected values were recorded from the legacy pure module (`assets/chat-core.js`) with the
 * synthetic fixture in `test/fixtures/chat-feed-characterization.json`. The new store must replay
 * the same feed order, keyed message/part maps, optimistic rekey, queue derivation, and stream ids.
 */

interface FixturePartInput {
  id: string;
  type: string;
  data: Record<string, unknown>;
  provisional?: boolean;
  sealed?: boolean;
  version?: number;
}

interface FixtureMessageInput {
  id: string;
  role: "user" | "assistant";
  parentID?: string;
  finish?: string;
  optimistic?: string;
  time?: { created?: number; completed?: number };
  partOrder?: string[];
  parts?: FixturePartInput[];
  version?: number;
}

interface FixtureStoreInput {
  sessionID?: string | null;
  order?: string[];
  messages?: FixtureMessageInput[];
  queue?: string[];
  activePromptID?: string | null;
  lastSeqByStream?: Record<string, number>;
  currentStreamID?: string | null;
  turnGeneration?: number;
  agentStatus?: { type?: string } | null;
}

interface RuntimePart {
  id: string;
  type: string;
  data: Record<string, unknown>;
  provisional: boolean;
  partial: boolean;
  sealed: boolean;
  version: number;
}

interface RuntimeMessage {
  id: string;
  role: "user" | "assistant";
  parentID?: string;
  finish?: string;
  optimistic?: string;
  time?: { created?: number; completed?: number };
  partOrder: string[];
  parts: Map<string, RuntimePart>;
  version: number;
}

interface RuntimeStore {
  sessionID: string | null;
  generation: number;
  turnGeneration: number;
  order: string[];
  messages: Map<string, RuntimeMessage>;
  activePromptID: string | null;
  queue: string[];
  openParts: Set<string>;
  lastSeqByStream: Map<string, number>;
  currentStreamID: string | null;
  pendingDeltas: Map<string, string>;
  agentStatus: { type?: string } | null;
  connection: "live" | "reconnecting" | "paused" | "connecting";
}

interface Fixture {
  snapshot: {
    base: FixtureStoreInput;
    messages: Array<Record<string, unknown>>;
    options: { sessionID: string; sessionStatusType: string };
    expected: {
      contentDiscarded: boolean;
      turnChanged: boolean;
      store: unknown;
    };
  };
  rekey: {
    store: FixtureStoreInput;
    options: { tempID: string; serverID: string; sessionStatusType: string };
    expected: { consumed: boolean; store: unknown };
  };
  queue: {
    store: FixtureStoreInput;
    status: string;
    expected: unknown;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/chat-feed-characterization.json", import.meta.url), "utf8"),
) as Fixture;

function emptyStore(sessionID: string | null): RuntimeStore {
  return {
    sessionID,
    generation: 0,
    turnGeneration: 0,
    order: [],
    messages: new Map(),
    activePromptID: null,
    queue: [],
    openParts: new Set(),
    lastSeqByStream: new Map(),
    currentStreamID: null,
    pendingDeltas: new Map(),
    agentStatus: null,
    connection: "live",
  };
}

function buildStore(input: FixtureStoreInput): RuntimeStore {
  const store = emptyStore(input.sessionID ?? null);
  for (const message of input.messages ?? []) {
    const parts = new Map<string, RuntimePart>();
    for (const part of message.parts ?? []) {
      parts.set(part.id, {
        id: part.id,
        type: part.type,
        data: { ...part.data },
        provisional: part.provisional === true,
        partial: false,
        sealed: part.sealed === true,
        version: part.version ?? 1,
      });
    }
    store.messages.set(message.id, {
      id: message.id,
      role: message.role,
      ...(message.parentID === undefined ? {} : { parentID: message.parentID }),
      ...(message.finish === undefined ? {} : { finish: message.finish }),
      ...(message.optimistic === undefined ? {} : { optimistic: message.optimistic }),
      ...(message.time === undefined ? {} : { time: message.time }),
      partOrder: message.partOrder ?? [...parts.keys()],
      parts,
      version: message.version ?? 1,
    });
  }
  store.order = [...(input.order ?? [])];
  store.queue = [...(input.queue ?? [])];
  store.activePromptID = input.activePromptID ?? null;
  store.lastSeqByStream = new Map(Object.entries(input.lastSeqByStream ?? {}));
  store.currentStreamID = input.currentStreamID ?? null;
  store.turnGeneration = input.turnGeneration ?? 0;
  store.agentStatus = input.agentStatus ?? null;
  return store;
}

function projectStore(store: RuntimeStore): unknown {
  return {
    sessionID: store.sessionID,
    generation: store.generation,
    turnGeneration: store.turnGeneration,
    order: [...store.order],
    queue: [...store.queue],
    activePromptID: store.activePromptID,
    lastSeqByStream: Object.fromEntries([...store.lastSeqByStream.entries()].sort()),
    currentStreamID: store.currentStreamID,
    messages: store.order.map((id) => {
      const message = store.messages.get(id);
      return {
        id: message?.id,
        role: message?.role,
        parentID: message?.parentID ?? null,
        finish: message?.finish ?? null,
        optimistic: message?.optimistic ?? null,
        time:
          message?.time === undefined
            ? null
            : {
                created: message.time.created ?? null,
                completed: message.time.completed ?? null,
              },
        partOrder: [...(message?.partOrder ?? [])],
        parts: (message?.partOrder ?? []).map((partID) => {
          const part = message?.parts.get(partID);
          return {
            id: part?.id,
            type: part?.type,
            text: typeof part?.data.text === "string" ? part.data.text : null,
            sealed: part?.sealed === true,
            provisional: part?.provisional === true,
          };
        }),
      };
    }),
  };
}

describe("legacy chat feed characterization", () => {
  it("replays the recorded snapshot order, message/part maps, queue, and stream ids", () => {
    const result = applySnapshot(buildStore(fixture.snapshot.base), fixture.snapshot.messages, {
      sessionID: fixture.snapshot.options.sessionID,
      sessionStatusType: fixture.snapshot.options.sessionStatusType,
    }) as { store: RuntimeStore; contentDiscarded: boolean; turnChanged: boolean };

    expect(result.contentDiscarded).toBe(fixture.snapshot.expected.contentDiscarded);
    expect(result.turnChanged).toBe(fixture.snapshot.expected.turnChanged);
    expect(projectStore(result.store)).toEqual(fixture.snapshot.expected.store);
  });

  it("replays the recorded optimistic rekey and keyed part merge", () => {
    const result = rekeyOptimistic(buildStore(fixture.rekey.store), fixture.rekey.options) as {
      store: RuntimeStore;
      consumed: boolean;
    };

    expect(result.consumed).toBe(fixture.rekey.expected.consumed);
    expect(projectStore(result.store)).toEqual(fixture.rekey.expected.store);
  });

  it("replays the recorded active/queued prompt derivation", () => {
    const result = deriveQueue(buildStore(fixture.queue.store), {
      sessionStatusType: fixture.queue.status,
    });

    expect(result).toEqual(fixture.queue.expected);
  });
});
