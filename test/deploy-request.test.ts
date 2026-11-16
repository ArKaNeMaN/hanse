import { describe, expect, it } from "vitest";
import {
  buildDeployRequest,
  classifyChanges,
  renderDeployRequest,
  validateFullSha,
  validatePublishRunId,
} from "../scripts/deploy-request.mjs";

const deployed = "a".repeat(40);
const target = "b".repeat(40);

describe("deploy request spec", () => {
  it("requires a full 40-character SHA and a numeric publish run id", () => {
    expect(validateFullSha(deployed, "deployed")).toBe(deployed);
    expect(() => validateFullSha("aef3aac", "deployed")).toThrow(/40-character/);
    expect(() => validateFullSha("A".repeat(40), "deployed")).toThrow(/40-character/);
    expect(validatePublishRunId("43340859769")).toBe("43340859769");
    expect(() => validatePublishRunId("run-43340859769")).toThrow(/numeric/);
  });

  it("classifies migrations, routes, assets, health, and the contract", () => {
    const categories = classifyChanges([
      "src/store/migrations.ts",
      "src/shared/routes.ts",
      "src/http/spa.ts",
      "ui/pages/ChatPage.vue",
      "deploy-contract.json",
      "compose.yaml",
      "Dockerfile",
      "src/mcp/protocol.ts",
      "README.md",
    ]);
    expect(categories.migrations).toEqual(["src/store/migrations.ts"]);
    expect(categories.routes).toEqual(["src/shared/routes.ts", "src/http/spa.ts"]);
    expect(categories.assets).toEqual(["ui/pages/ChatPage.vue", "deploy-contract.json"]);
    expect(categories.health).toEqual(["compose.yaml"]);
    expect(categories.contract).toEqual(["deploy-contract.json"]);
    expect(categories.docker).toEqual(["Dockerfile"]);
    expect(categories.publicApi).toEqual(["src/mcp/protocol.ts"]);
  });

  it("renders full SHAs, the publish run, cumulative commits, and no-source-build rules", () => {
    const spec = renderDeployRequest({
      deployedSha: deployed,
      targetSha: target,
      publishRunId: "43340859769",
      commits: [
        { sha: target, subject: "feat(settings): add the settings console" },
        { sha: "c".repeat(40), subject: "fix(chat): keep the composer draft" },
      ],
      changedFiles: ["src/shared/routes.ts", "deploy-contract.json", "src/store/migrations.ts"],
      diffStat: " 3 files changed, 10 insertions(+), 2 deletions(-)",
      shortStat: " 3 files changed, 10 insertions(+), 2 deletions(-)",
    });

    expect(spec).toContain(deployed);
    expect(spec).toContain(target);
    expect(spec).toContain("43340859769");
    expect(spec).toContain(`sha-${target}`);
    expect(spec).toContain("Do not build from source");
    expect(spec).toMatch(/do not deploy a\s+branch name/);
    expect(spec).toContain("feat(settings): add the settings console");
    expect(spec).toContain("fix(chat): keep the composer draft");
    expect(spec).toContain("Required: **yes**");
    expect(spec).toContain("src/store/migrations.ts");
    expect(spec).toContain("Routes: `src/shared/routes.ts`");
    expect(spec).toContain("Verification contract: `deploy-contract.json`");
  });

  it("emits a machine-readable request with the required snake-case fields", () => {
    const request = buildDeployRequest({
      deployedSha: deployed,
      targetSha: target,
      publishRunId: "43340859769",
      commits: [{ sha: target, subject: "feat: target" }],
      changedFiles: ["README.md"],
      diffStat: " 1 file changed, 1 insertion(+)",
      shortStat: " 1 file changed, 1 insertion(+)",
    });
    expect(request).toMatchObject({
      deployed_revision: deployed,
      target_revision: target,
      publish_run_id: "43340859769",
      image_tag: `sha-${target}`,
      no_source_build: true,
      no_branch_deploy: true,
    });
    expect(request.deploy_visible.routes).toEqual([]);
    expect(request.migrations).toEqual([]);
  });
});
