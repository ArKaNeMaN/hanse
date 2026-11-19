import { describe, expect, it } from "vitest";
import { sameTarget, targetKey, targetToSkillsHref } from "./skills-target.js";
import type { Target } from "./target-types.js";

describe("targetToSkillsHref", () => {
  it("maps global and all to the global inventory", () => {
    expect(targetToSkillsHref({ kind: "global" })).toBe("/skills");
    expect(targetToSkillsHref({ kind: "all" })).toBe("/skills");
  });

  it("maps a project target to the project inventory", () => {
    expect(targetToSkillsHref({ kind: "project", projectId: "p1" })).toBe("/projects/p1/skills");
  });

  it("maps an app target to the app inventory", () => {
    expect(targetToSkillsHref({ kind: "app", projectId: "p1", appKey: "web" })).toBe(
      "/projects/p1/apps/web/skills",
    );
  });

  it("encodes project ids and app keys", () => {
    const project = "proj 1/α";
    const app = "web app/?";
    const encodedProject = encodeURIComponent(project);
    const encodedApp = encodeURIComponent(app);

    expect(targetToSkillsHref({ kind: "project", projectId: project })).toBe(
      `/projects/${encodedProject}/skills`,
    );
    expect(targetToSkillsHref({ kind: "app", projectId: project, appKey: app })).toBe(
      `/projects/${encodedProject}/apps/${encodedApp}/skills`,
    );
  });
});

describe("sameTarget", () => {
  it("matches singular targets by kind", () => {
    expect(sameTarget({ kind: "global" }, { kind: "global" })).toBe(true);
    expect(sameTarget({ kind: "all" }, { kind: "all" })).toBe(true);
    expect(sameTarget({ kind: "global" }, { kind: "all" })).toBe(false);
  });

  it("matches projects by identity", () => {
    expect(
      sameTarget({ kind: "project", projectId: "p1" }, { kind: "project", projectId: "p1" }),
    ).toBe(true);
    expect(
      sameTarget({ kind: "project", projectId: "p1" }, { kind: "project", projectId: "p2" }),
    ).toBe(false);
  });

  it("matches apps by project and app key", () => {
    expect(
      sameTarget(
        { kind: "app", projectId: "p1", appKey: "web" },
        { kind: "app", projectId: "p1", appKey: "web" },
      ),
    ).toBe(true);
    expect(
      sameTarget(
        { kind: "app", projectId: "p1", appKey: "web" },
        { kind: "app", projectId: "p1", appKey: "api" },
      ),
    ).toBe(false);
    expect(
      sameTarget(
        { kind: "app", projectId: "p1", appKey: "web" },
        { kind: "app", projectId: "p2", appKey: "web" },
      ),
    ).toBe(false);
  });

  it("treats the master flag as a label, not identity", () => {
    expect(
      sameTarget(
        { kind: "app", projectId: "p-master", appKey: "master", master: true },
        { kind: "app", projectId: "p-master", appKey: "master" },
      ),
    ).toBe(true);
  });

  it("does not match across kinds", () => {
    const targets: readonly Target[] = [
      { kind: "global" },
      { kind: "all" },
      { kind: "project", projectId: "p1" },
      { kind: "app", projectId: "p1", appKey: "web" },
    ];
    for (const left of targets) {
      for (const right of targets) {
        if (left.kind !== right.kind) {
          expect(sameTarget(left, right)).toBe(false);
        }
      }
    }
  });
});

describe("targetKey", () => {
  it("returns stable keys", () => {
    expect(targetKey({ kind: "global" })).toBe("global");
    expect(targetKey({ kind: "all" })).toBe("all");
    expect(targetKey({ kind: "project", projectId: "p1" })).toBe("project:p1");
    expect(targetKey({ kind: "app", projectId: "p1", appKey: "web" })).toBe("app:p1/web");
  });

  it("ignores the master flag in the key", () => {
    expect(targetKey({ kind: "app", projectId: "p1", appKey: "web", master: true })).toBe(
      "app:p1/web",
    );
  });
});
