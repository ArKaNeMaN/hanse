import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiMutation, apiQuery, clearReloadGuard } from "./api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api helpers", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    clearReloadGuard();
    window.history.replaceState({}, "", "/projects");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries JSON with same-origin credentials and an accept header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    const result = await apiQuery<{ rows: unknown[] }>("/api/ui/projects?q=one");

    expect(result).toEqual({ rows: [] });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/ui/projects?q=one");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json", "x-hanse-ui-version": "2" },
    });
  });

  it("posts form-encoded bodies with the SPA header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, project: { id: "alpha" } }));
    const result = await apiMutation<{ ok: true }>("/api/projects", {
      form: { name: "Alpha Beta" },
    });

    expect(result).toEqual({ ok: true, project: { id: "alpha" } });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "x-hanse-client": "spa",
        "x-hanse-ui-version": "2",
      },
    });
    expect(init?.body).toBe("name=Alpha+Beta");
  });

  it("posts JSON bodies for the existing JSON APIs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiMutation("/api/settings", { json: { key: "llm.model", value: "x" } });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hanse-client": "spa",
        "x-hanse-ui-version": "2",
      },
    });
    expect(init?.body).toBe(JSON.stringify({ key: "llm.model", value: "x" }));
  });

  it("uses an explicit PATCH method for the SSH host update API", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ host: { id: "host-1" } }));
    await apiMutation("/api/ssh/hosts/host-1", { json: { name: "Renamed" } }, { method: "PATCH" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-hanse-client": "spa",
        "x-hanse-ui-version": "2",
      },
    });
  });

  it("uses an explicit DELETE method with an empty JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deleted: true }));
    await apiMutation("/api/ssh/hosts/host-1", { json: {} }, { method: "DELETE" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({ method: "DELETE", body: "{}" });
  });

  it("maps an error envelope to a typed ApiError", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Project already exists.", code: "project_exists" }, 409),
    );

    await expect(apiMutation("/api/projects", { form: { name: "x" } })).rejects.toMatchObject({
      name: "ApiError",
      message: "Project already exists.",
      status: 409,
      code: "project_exists",
    });
  });

  it("falls back to the status when an error body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    const error = await apiMutation("/api/projects", { form: { name: "x" } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, message: "Request failed (500)" });
  });

  it("reloads once for a ui_reload_required 409 and not again", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/projects", search: "", hash: "", reload },
    });
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: "UI reload required", code: "ui_reload_required" }, 409),
    );

    await expect(apiQuery("/api/ui/projects")).rejects.toMatchObject({
      status: 409,
      code: "ui_reload_required",
    });
    expect(reload).toHaveBeenCalledTimes(1);

    await expect(apiQuery("/api/ui/projects")).rejects.toMatchObject({
      status: 409,
      code: "ui_reload_required",
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("clears the reload guard after a successful boot", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/projects", search: "", hash: "", reload },
    });
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: "UI reload required", code: "ui_reload_required" }, 409),
    );

    await expect(apiQuery("/api/ui/projects")).rejects.toMatchObject({ status: 409 });
    expect(reload).toHaveBeenCalledTimes(1);

    clearReloadGuard();
    await expect(apiQuery("/api/ui/projects")).rejects.toMatchObject({ status: 409 });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload for a different 409 code", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/projects", search: "", hash: "", reload },
    });
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Project already exists.", code: "project_exists" }, 409),
    );

    await expect(apiMutation("/api/projects", { form: { name: "x" } })).rejects.toMatchObject({
      status: 409,
      code: "project_exists",
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("redirects to login with the current local path on 401", async () => {
    window.history.replaceState({}, "", "/projects?q=Two");
    fetchMock.mockResolvedValue(jsonResponse({ error: "sign in required" }, 401));
    const onUnauthorized = vi.fn();

    const error = await apiQuery("/api/ui/projects", { onUnauthorized }).catch(
      (caught: unknown) => caught,
    );

    expect(onUnauthorized).toHaveBeenCalledWith("/projects?q=Two");
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: "unauthenticated" });
  });
});
