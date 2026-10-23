import { describe, expect, it } from "vitest";
import { PreviewService } from "../src/preview/service.js";
import {
  type PreviewCleanup,
  PreviewError,
  type PreviewFailureCode,
  type PreviewOpenInput,
  type PreviewRecord,
} from "../src/preview/types.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DEFAULT_TTL = 2 * HOUR;
const START = Date.UTC(2026, 9, 23, 12, 0, 0);

interface Clock {
  service: PreviewService;
  advance(ms: number): void;
  now(): number;
}

function fixture(options: { maxPerApp?: number; ttlMs?: number } = {}): Clock {
  let current = START;
  const service = new PreviewService({
    now: () => current,
    ...(options.maxPerApp === undefined ? {} : { maxPerApp: options.maxPerApp }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  return {
    service,
    advance(ms: number): void {
      current += ms;
    },
    now(): number {
      return current;
    },
  };
}

function makeInput(overrides: Partial<PreviewOpenInput> = {}): PreviewOpenInput {
  return {
    appId: "p:a",
    projectId: "p",
    appKey: "a",
    key: "web",
    name: "Storefront",
    port: 3000,
    targetHost: "hanse-app-p-a",
    ...overrides,
  };
}

function expectFailure(run: () => unknown, code: PreviewFailureCode): PreviewError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewError);
    expect(error).toBeInstanceOf(Error);
    const previewError = error as PreviewError;
    expect(previewError.name).toBe("PreviewError");
    expect(previewError.code).toBe(code);
    expect(previewError.message.length).toBeGreaterThan(0);
    return previewError;
  }
  throw new Error(`expected failure ${code}`);
}

describe("PreviewService.open", () => {
  it("returns a record with the default 2h absolute expiry", () => {
    const { service, now } = fixture();
    const record = service.open(makeInput());
    expect(record).toEqual({
      ...makeInput(),
      createdAt: now(),
      expiresAt: now() + DEFAULT_TTL,
    });
    expect(service.get("p:a", "web")).toEqual(record);
  });

  it("builds the URL and both base path spellings", () => {
    const { service, now } = fixture();
    const record = service.open(makeInput());
    expect(service.view(record)).toEqual({
      key: "web",
      name: "Storefront",
      port: 3000,
      url: "/preview/p/a/web/",
      basePath: "/preview/p/a/web/",
      basePathWithoutTrailingSlash: "/preview/p/a/web",
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + DEFAULT_TTL).toISOString(),
    });
  });

  it("percent-encodes the project, app, and key path segments", () => {
    const { service } = fixture();
    const record = service.open(
      makeInput({ projectId: "my project", appKey: "app/one", key: "web" }),
    );
    expect(service.view(record).url).toBe("/preview/my%20project/app%2Fone/web/");

    const manual: PreviewRecord = {
      ...makeInput(),
      projectId: "p 1",
      appKey: "a/1",
      key: "web key",
      createdAt: START,
      expiresAt: START + MINUTE,
    };
    expect(service.view(manual)).toMatchObject({
      url: "/preview/p%201/a%2F1/web%20key/",
      basePath: "/preview/p%201/a%2F1/web%20key/",
      basePathWithoutTrailingSlash: "/preview/p%201/a%2F1/web%20key",
    });
  });

  it("upserts by key: updates name/port/target, refreshes expiry, keeps createdAt", () => {
    const { service, now, advance } = fixture();
    const first = service.open(makeInput());
    advance(5 * MINUTE);
    const second = service.open(
      makeInput({ name: "Storefront v2", port: 4000, targetHost: "hanse-app-p-a" }),
    );

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.expiresAt).toBe(now() + DEFAULT_TTL);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(second.name).toBe("Storefront v2");
    expect(second.port).toBe(4000);
    expect(service.list("p:a")).toHaveLength(1);
    expect(service.list("p:a")[0]).toEqual(second);
  });

  it("accepts the documented key boundaries", () => {
    const { service } = fixture();
    expect(service.open(makeInput({ key: "a" })).key).toBe("a");
    expect(service.open(makeInput({ key: "a".repeat(32) })).key).toBe("a".repeat(32));
    expect(service.open(makeInput({ key: "web-2" })).key).toBe("web-2");
    expect(service.open(makeInput({ key: "web-" })).key).toBe("web-");
  });

  it("rejects invalid keys with preview_invalid_key", () => {
    for (const key of ["", "Upper", "web/", "-web", "web_", "a".repeat(33), " web", "web "]) {
      const { service } = fixture();
      expectFailure(() => service.open(makeInput({ key })), "preview_invalid_key");
    }
  });

  it("accepts printable ASCII names up to 64 characters", () => {
    const { service } = fixture();
    expect(service.open(makeInput({ name: "x".repeat(64) })).name).toBe("x".repeat(64));
    expect(service.open(makeInput({ key: "b", name: "Store front (beta)!" })).name).toBe(
      "Store front (beta)!",
    );
  });

  it("rejects empty, oversized, and non-printable names with preview_invalid_name", () => {
    for (const name of [
      "",
      "x".repeat(65),
      "line\nbreak",
      "tab\there",
      "\u007f",
      "\u001f",
      "café",
    ]) {
      const { service } = fixture();
      expectFailure(() => service.open(makeInput({ name })), "preview_invalid_name");
    }
  });

  it("accepts the documented port boundaries", () => {
    const { service } = fixture();
    expect(service.open(makeInput({ port: 1024 })).port).toBe(1024);
    expect(service.open(makeInput({ key: "b", port: 65535 })).port).toBe(65535);
    expect(service.open(makeInput({ key: "c", port: 4101 })).port).toBe(4101);
  });

  it("rejects out-of-range and non-integer ports with preview_invalid_port", () => {
    for (const port of [0, 1023, 65536, 3000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { service } = fixture();
      expectFailure(() => service.open(makeInput({ port })), "preview_invalid_port");
    }
  });

  it("rejects the opencode control port with preview_reserved_port", () => {
    const { service } = fixture();
    expectFailure(() => service.open(makeInput({ port: 4100 })), "preview_reserved_port");
  });

  it("accepts container-name target hosts", () => {
    const { service } = fixture();
    expect(service.open(makeInput({ targetHost: "app.local" })).targetHost).toBe("app.local");
  });

  it("rejects empty or malformed target hosts with preview_internal_error", () => {
    for (const targetHost of ["", "host/path", "host name", "host:3000", "\thost"]) {
      const { service } = fixture();
      expectFailure(() => service.open(makeInput({ targetHost })), "preview_internal_error");
    }
  });
});

describe("PreviewService limits", () => {
  it("allows 8 distinct previews and rejects the 9th with preview_limit", () => {
    const { service } = fixture();
    for (let index = 0; index < 8; index += 1) {
      service.open(makeInput({ key: `preview-${index}` }));
    }
    expect(service.list("p:a")).toHaveLength(8);
    const error = expectFailure(() => service.open(makeInput({ key: "nine" })), "preview_limit");
    expect(error.code).toBe("preview_limit");
    expect(service.list("p:a")).toHaveLength(8);
  });

  it("does not consume a slot when upserting an existing key at the limit", () => {
    const { service } = fixture();
    for (let index = 0; index < 8; index += 1) {
      service.open(makeInput({ key: `preview-${index}` }));
    }
    const updated = service.open(makeInput({ key: "preview-0", name: "Updated", port: 5000 }));
    expect(updated.name).toBe("Updated");
    expect(service.list("p:a")).toHaveLength(8);
  });

  it("frees a slot when a preview is closed", () => {
    const { service } = fixture();
    for (let index = 0; index < 8; index += 1) {
      service.open(makeInput({ key: `preview-${index}` }));
    }
    expect(service.close("p:a", "preview-0")).toBe(true);
    expect(service.open(makeInput({ key: "replacement" })).key).toBe("replacement");
    expect(service.list("p:a")).toHaveLength(8);
  });

  it("prunes expired previews before enforcing the limit", () => {
    const { service, advance } = fixture({ ttlMs: 1000 });
    for (let index = 0; index < 8; index += 1) {
      service.open(makeInput({ key: `preview-${index}` }));
    }
    advance(1000);
    expect(service.list("p:a")).toEqual([]);
    expect(service.open(makeInput({ key: "fresh" })).key).toBe("fresh");
    expect(service.list("p:a")).toHaveLength(1);
  });

  it("honors a custom maxPerApp", () => {
    const { service } = fixture({ maxPerApp: 2 });
    service.open(makeInput({ key: "one" }));
    service.open(makeInput({ key: "two" }));
    expectFailure(() => service.open(makeInput({ key: "three" })), "preview_limit");
  });

  it("keeps separate limits per app", () => {
    const { service } = fixture({ maxPerApp: 1 });
    service.open(makeInput({ appId: "p:a", key: "web" }));
    expect(service.open(makeInput({ appId: "p:b", key: "web" })).appId).toBe("p:b");
  });
});

describe("PreviewService lazy expiry", () => {
  it("expires exactly at the TTL boundary", () => {
    const { service, advance } = fixture();
    service.open(makeInput());
    advance(DEFAULT_TTL - 1);
    expect(service.get("p:a", "web")).toBeDefined();
    advance(1);
    expect(service.get("p:a", "web")).toBeUndefined();
  });

  it("prunes on list", () => {
    const { service, advance, now } = fixture({ ttlMs: 5 * MINUTE });
    service.open(makeInput({ key: "old" }));
    advance(5 * MINUTE);
    expect(service.list("p:a")).toEqual([]);
    expect(service.views("p:a")).toEqual([]);
    expect(now()).toBe(START + 5 * MINUTE);
  });

  it("prunes on get", () => {
    const { service, advance } = fixture({ ttlMs: 5 * MINUTE });
    service.open(makeInput({ key: "old" }));
    advance(5 * MINUTE);
    expect(service.get("p:a", "old")).toBeUndefined();
  });

  it("prunes on close and reports an expired key as not closed", () => {
    const { service, advance } = fixture({ ttlMs: 5 * MINUTE });
    service.open(makeInput({ key: "old" }));
    advance(5 * MINUTE);
    expect(service.close("p:a", "old")).toBe(false);
  });

  it("prunes on open and lets the same key be created fresh", () => {
    const { service, advance, now } = fixture({ ttlMs: 5 * MINUTE });
    const first = service.open(makeInput({ key: "web" }));
    advance(5 * MINUTE);
    const second = service.open(makeInput({ key: "web" }));
    expect(second.createdAt).toBe(now());
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
    expect(second.expiresAt).toBe(now() + 5 * MINUTE);
    expect(service.list("p:a")).toHaveLength(1);
  });

  it("does not expire a record before its deadline", () => {
    const { service, advance } = fixture({ ttlMs: 5 * MINUTE });
    service.open(makeInput());
    advance(4 * MINUTE);
    expect(service.get("p:a", "web")).toBeDefined();
    advance(59 * 1000);
    expect(service.get("p:a", "web")).toBeDefined();
  });
});

describe("PreviewService list ordering", () => {
  it("returns records newest first", () => {
    const { service, advance } = fixture();
    service.open(makeInput({ key: "alpha" }));
    advance(1000);
    service.open(makeInput({ key: "beta" }));
    advance(1000);
    service.open(makeInput({ key: "gamma" }));
    expect(service.list("p:a").map((record) => record.key)).toEqual(["gamma", "beta", "alpha"]);
    expect(service.views("p:a").map((view) => view.key)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("breaks createdAt ties by ascending key", () => {
    const { service } = fixture();
    service.open(makeInput({ key: "beta" }));
    service.open(makeInput({ key: "alpha" }));
    service.open(makeInput({ key: "gamma" }));
    expect(service.list("p:a").map((record) => record.key)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps relative order when an existing key refreshes its expiry", () => {
    const { service, advance } = fixture();
    service.open(makeInput({ key: "old" }));
    advance(1000);
    service.open(makeInput({ key: "new" }));
    advance(1000);
    service.open(makeInput({ key: "old", name: "Old updated" }));
    expect(service.list("p:a").map((record) => record.key)).toEqual(["new", "old"]);
  });
});

describe("PreviewService get and close", () => {
  it("returns undefined and false for unknown keys", () => {
    const { service } = fixture();
    expect(service.get("p:a", "missing")).toBeUndefined();
    expect(service.close("p:a", "missing")).toBe(false);
    expect(service.list("p:a")).toEqual([]);
  });

  it("closes one preview and is idempotent", () => {
    const { service } = fixture();
    service.open(makeInput({ key: "web" }));
    expect(service.close("p:a", "web")).toBe(true);
    expect(service.close("p:a", "web")).toBe(false);
    expect(service.get("p:a", "web")).toBeUndefined();
  });

  it("isolates previews by app", () => {
    const { service } = fixture();
    service.open(makeInput({ appId: "p:a", key: "web", name: "A" }));
    service.open(makeInput({ appId: "p:b", key: "web", name: "B" }));
    expect(service.get("p:a", "web")?.name).toBe("A");
    expect(service.get("p:b", "web")?.name).toBe("B");
    expect(service.close("p:a", "web")).toBe(true);
    expect(service.get("p:a", "web")).toBeUndefined();
    expect(service.get("p:b", "web")?.name).toBe("B");
  });
});

describe("PreviewService clearApp and clearAll", () => {
  it("clears previews and the operator host for one app", () => {
    const { service } = fixture();
    service.open(makeInput({ appId: "p:a", key: "web" }));
    service.open(makeInput({ appId: "p:b", key: "web" }));
    service.recordOperatorHost("p:a", "coordinator.example:8787");
    service.recordOperatorHost("p:b", "coordinator.example:8787");

    const cleanup: PreviewCleanup = service;
    cleanup.clearApp("p:a");

    expect(service.list("p:a")).toEqual([]);
    expect(service.get("p:a", "web")).toBeUndefined();
    expect(service.operatorHost("p:a")).toBeUndefined();
    expect(service.list("p:b")).toHaveLength(1);
    expect(service.operatorHost("p:b")).toEqual({
      host: "coordinator.example:8787",
      hostname: "coordinator.example",
    });
  });

  it("is idempotent", () => {
    const { service } = fixture();
    service.open(makeInput());
    service.clearApp("p:a");
    expect(() => service.clearApp("p:a")).not.toThrow();
    expect(service.list("p:a")).toEqual([]);
  });

  it("clearAll removes every preview and operator host", () => {
    const { service } = fixture();
    service.open(makeInput({ appId: "p:a", key: "web" }));
    service.open(makeInput({ appId: "p:b", key: "web" }));
    service.recordOperatorHost("p:a", "one.example");
    service.recordOperatorHost("p:b", "two.example");
    service.clearAll();
    expect(service.list("p:a")).toEqual([]);
    expect(service.list("p:b")).toEqual([]);
    expect(service.operatorHost("p:a")).toBeUndefined();
    expect(service.operatorHost("p:b")).toBeUndefined();
  });
});

describe("PreviewService operator host", () => {
  it("is undefined until a host is recorded", () => {
    const { service } = fixture();
    expect(service.operatorHost("p:a")).toBeUndefined();
  });

  it("stores the raw host and a normalized hostname", () => {
    const { service } = fixture();
    service.recordOperatorHost("p:a", "Example.COM:8787");
    expect(service.operatorHost("p:a")).toEqual({
      host: "Example.COM:8787",
      hostname: "example.com",
    });
  });

  it("strips IPv6 brackets, the port, and lowercases", () => {
    const { service } = fixture();
    service.recordOperatorHost("p:a", "[2001:DB8::1]:8787");
    expect(service.operatorHost("p:a")).toEqual({
      host: "[2001:DB8::1]:8787",
      hostname: "2001:db8::1",
    });
  });

  it("keeps the latest valid host per app", () => {
    const { service } = fixture();
    service.recordOperatorHost("p:a", "first.example:8787");
    service.recordOperatorHost("p:b", "other.example:8787");
    service.recordOperatorHost("p:a", "Second.EXAMPLE:9000");
    expect(service.operatorHost("p:a")).toEqual({
      host: "Second.EXAMPLE:9000",
      hostname: "second.example",
    });
    expect(service.operatorHost("p:b")).toEqual({
      host: "other.example:8787",
      hostname: "other.example",
    });
  });

  it("ignores empty and invalid hosts without overwriting the last valid one", () => {
    const { service } = fixture();
    service.recordOperatorHost("p:a", "good.example:8787");
    for (const invalidHost of ["", "not a host", "host/path", "http://evil", "[::1", "user@host"]) {
      service.recordOperatorHost("p:a", invalidHost);
    }
    expect(service.operatorHost("p:a")).toEqual({
      host: "good.example:8787",
      hostname: "good.example",
    });
  });

  it("does not record a host for another app", () => {
    const { service } = fixture();
    service.recordOperatorHost("p:a", "coordinator.example");
    expect(service.operatorHost("p:a")).toEqual({
      host: "coordinator.example",
      hostname: "coordinator.example",
    });
    expect(service.operatorHost("p:b")).toBeUndefined();
  });
});
