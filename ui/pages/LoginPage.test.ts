import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootPayload } from "../boot.js";
import LoginPage from "./LoginPage.vue";

const mocks = vi.hoisted(() => ({
  apiMutation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiMutation: mocks.apiMutation };
});

vi.mock("../navigation.js", () => ({ fullDocumentNavigate: mocks.navigate }));

beforeEach(() => {
  vi.clearAllMocks();
});

function boot(next: string): BootPayload {
  return {
    route: { id: "login", params: {} },
    props: { next },
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "Sign in",
      active: "none",
      pendingCount: 0,
      sshPendingCount: 0,
    },
    spaRoutes: ["login"],
    topbar: { ideHref: "/ide/" },
  };
}

describe("LoginPage", () => {
  it("renders the operator sign-in plate", () => {
    const wrapper = mount(LoginPage, { props: { boot: boot("/projects") } });
    expect(wrapper.get("#login-title").text()).toBe("Operator sign-in");
    expect(wrapper.get("label[for='token']").text()).toBe("Operator token (required)");
    expect(wrapper.get("button[type='submit']").text()).toContain("Sign in");
  });

  it("blocks an empty token before calling the API", async () => {
    const wrapper = mount(LoginPage, { props: { boot: boot("/") } });
    await wrapper.get("form").trigger("submit");
    expect(mocks.apiMutation).not.toHaveBeenCalled();
    expect(wrapper.get("#token-error").text()).toContain("Enter the operator token.");
  });

  it("submits the token and follows the server's next path", async () => {
    mocks.apiMutation.mockResolvedValueOnce({ ok: true, next: "/handoffs" });
    const wrapper = mount(LoginPage, { props: { boot: boot("/projects") } });
    await wrapper.get("#token").setValue("  secret-token  ");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/session",
      { json: { token: "secret-token", next: "/projects" } },
      { onUnauthorized: expect.any(Function) },
    );
    expect(mocks.navigate).toHaveBeenCalledWith("/handoffs");
  });

  it("shows the rejection message and re-enables the form on 401", async () => {
    const actual = await import("../api.js");
    mocks.apiMutation.mockRejectedValueOnce(new actual.ApiError("invalid token", 401));
    const wrapper = mount(LoginPage, { props: { boot: boot("/") } });
    await wrapper.get("#token").setValue("wrong");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get("#token-error").text()).toContain("Token rejected.");
    expect(wrapper.get("button[type='submit']").attributes("disabled")).toBeUndefined();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("toggles token visibility", async () => {
    const wrapper = mount(LoginPage, { props: { boot: boot("/") } });
    expect(wrapper.get("#token").attributes("type")).toBe("password");
    await wrapper.get("[data-password-toggle]").trigger("click");
    expect(wrapper.get("#token").attributes("type")).toBe("text");
  });
});
