import { beforeEach, describe, expect, it } from "vitest";
import { installedSpaRoutes, installSpaRoutes } from "../../ui/spa-routes.js";

describe("installed SPA route set", () => {
  beforeEach(() => {
    installSpaRoutes([]);
  });

  it("installs and reads the resolved boot set", () => {
    installSpaRoutes(["projects", "overview"]);
    expect([...installedSpaRoutes()]).toEqual(["projects", "overview"]);
  });

  it("replaces the previous set on every install", () => {
    installSpaRoutes(["projects"]);
    installSpaRoutes(["overview"]);
    expect(installedSpaRoutes().has("projects")).toBe(false);
    expect(installedSpaRoutes().has("overview")).toBe(true);
  });

  it("fails closed before any install", () => {
    installSpaRoutes([]);
    expect(installedSpaRoutes().size).toBe(0);
  });
});
