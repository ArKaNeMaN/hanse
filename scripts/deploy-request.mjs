#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PUBLISH_RUN_ID = /^\d+$/;
const CONTRACT_VERSION = 1;

const ROUTE_FILES = new Set([
  "src/shared/routes.ts",
  "src/http/spa.ts",
  "src/http/server.ts",
  "src/http/ui.ts",
  "src/http/static-error.ts",
  "src/http/page-request.ts",
]);

export function validateFullSha(value, label) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new Error(`${label} must be a full 40-character lowercase commit SHA`);
  }
  return value;
}

export function validatePublishRunId(value) {
  if (typeof value !== "string" || !PUBLISH_RUN_ID.test(value)) {
    throw new Error(
      "publish run id must be the numeric id of a successful 'Publish container' run",
    );
  }
  return value;
}

export function classifyChanges(files) {
  const migrations = files.filter(
    (file) =>
      file === "src/store/migrations.ts" ||
      file.startsWith("src/store/migrations/") ||
      (file.startsWith("src/store/") && /migration/i.test(file.split("/").at(-1) ?? "")),
  );
  const routes = files.filter((file) => ROUTE_FILES.has(file));
  const assets = files.filter(
    (file) =>
      file.startsWith("assets/") ||
      file.startsWith("ui/") ||
      file === "vite.config.ts" ||
      file === "deploy-contract.json",
  );
  const health = files.filter(
    (file) =>
      file.startsWith("compose") ||
      file === "src/http/handler.ts" ||
      file === "src/http/deploy.ts" ||
      file === "src/coordinator/drain.ts" ||
      file === "src/coordinator/deployment-lock.ts",
  );
  const contract = files.filter((file) => file === "deploy-contract.json");
  const docker = files.filter((file) => file === "Dockerfile" || file.startsWith(".hanse/"));
  const publicApi = files.filter(
    (file) => file === "src/mcp/protocol.ts" || file === "src/coordinator/service.ts",
  );
  return { migrations, routes, assets, health, contract, docker, publicApi };
}

function formatList(files) {
  return files.length === 0 ? "none" : files.map((file) => `\`${file}\``).join(", ");
}

function capLines(text, max = 200) {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n... (${lines.length - max} more lines truncated)`;
}

export function buildDeployRequest(input) {
  const {
    deployedSha,
    targetSha,
    publishRunId,
    rollbackTag = `sha-${deployedSha}`,
    commits,
    changedFiles,
    diffStat,
    shortStat,
    generatedAt = new Date().toISOString(),
  } = input;
  const categories = classifyChanges(changedFiles);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    deployed_revision: deployedSha,
    target_revision: targetSha,
    publish_workflow: "Publish container",
    publish_run_id: publishRunId,
    image_tag: `sha-${targetSha}`,
    rollback_tag: rollbackTag,
    no_source_build: true,
    no_branch_deploy: true,
    contract_version: CONTRACT_VERSION,
    cumulative_commits: commits,
    changed_files: changedFiles,
    shortstat: shortStat,
    diffstat: diffStat,
    migrations: categories.migrations,
    deploy_visible: {
      routes: categories.routes,
      assets: categories.assets,
      health: categories.health,
      contract: categories.contract,
      docker: categories.docker,
      public_api: categories.publicApi,
    },
  };
}

export function renderDeployRequest(input) {
  const request = buildDeployRequest(input);
  const {
    deployed_revision: deployedSha,
    target_revision: targetSha,
    publish_run_id: publishRunId,
    image_tag: imageTag,
    rollback_tag: rollbackTag,
    cumulative_commits: commits,
    shortstat,
    diffstat,
    migrations,
    deploy_visible: visible,
  } = request;
  const deployVisible =
    migrations.length > 0 ||
    visible.routes.length > 0 ||
    visible.assets.length > 0 ||
    visible.health.length > 0 ||
    visible.contract.length > 0 ||
    visible.docker.length > 0 ||
    visible.public_api.length > 0;

  const commitLines =
    commits.length === 0
      ? "- none"
      : commits.map((commit) => `- \`${commit.sha}\` ${commit.subject}`).join("\n");
  const migrationAction =
    migrations.length === 0
      ? "No migration files changed in this delta. Still confirm `migrationPending` is false in `GET /readyz` after deploy."
      : "Back up `state`, run `hanse migrate --check --db <copy> --json`, and use the normal startup migration. Use `--online` only for additive/expand migrations.";

  return `# Deploy request

Generated: ${request.generated_at}

## Required identity

| Field | Value |
| --- | --- |
| Deployed revision | \`${deployedSha}\` |
| Target revision | \`${targetSha}\` |
| Publish workflow | \`Publish container\` |
| Publish run id | \`${publishRunId}\` (successful run for the target revision) |
| Image tag | \`${imageTag}\` |
| Rollback tag | \`${rollbackTag}\` |
| Verification contract | \`deploy-contract.json\` (contractVersion ${CONTRACT_VERSION}) |

## Deploy instruction

Deploy only the already-published \`${imageTag}\` images. Do not build from source, do not deploy a
branch name, and do not substitute \`main\`, \`latest\`, or a short SHA. Pull the coordinator, runner,
IDE, agent-default, and agent-base images at \`${imageTag}\`, follow the documented drain/lock
sequence, and verify \`GET /readyz\` reports \`revision\` = \`${targetSha}\`.

## Cumulative delta from the deployed revision

Commits:

${commitLines}

Diffstat (${shortstat || "no file changes"}):

\`\`\`text
${capLines(diffstat) || "(no diff)"}
\`\`\`

## Migrations

Required: **${migrations.length === 0 ? "no" : "yes"}**

Files: ${formatList(migrations)}

${migrationAction}

## Deploy-visible changes

- Routes: ${formatList(visible.routes)}
- Assets/UI: ${formatList(visible.assets)}
- Health/Compose: ${formatList(visible.health)}
- Verification contract: ${formatList(visible.contract)}
- Docker/image: ${formatList(visible.docker)}
- Public API: ${formatList(visible.public_api)}

${deployVisible ? "> This delta changes deploy-visible files. Read the release notes and re-run the verification contract against the deployed image." : "> No deploy-visible files changed in this delta; the normal smoke check still applies."}

## Verification

Use \`deploy-contract.json\` (contractVersion ${CONTRACT_VERSION}). Minimum checks:

- \`GET /healthz\` -> \`200\` \`{"status":"ok"}\`.
- \`GET /readyz\` -> \`200\`, \`status: ok\`, \`dbReady: true\`, \`revision\` = \`${targetSha}\`.
- Anonymous \`GET /\` and \`GET /projects\` -> \`302\` to \`/login?next=...\`.
- Authenticated \`GET /\` and \`GET /projects\` -> \`200\` SPA document with \`id="hanse-boot"\`.
- \`GET /assets/app.css\`, \`/assets/favicon.svg\`, and \`/assets/ui/.vite/manifest.json\` -> \`200\`.
- \`GET /assets/app-content.js\` -> \`404\`.
- \`POST /login\` -> \`405\`.

Do not include deployment-host names, addresses, paths, or secrets in this request.
`;
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function assertCommit(repo, sha, label) {
  try {
    git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    throw new Error(
      `${label} ${sha} is not present in ${repo}; fetch it first (the generator does not fetch or guess).`,
    );
  }
}

function usage() {
  return `Usage: npm run deploy:request -- --deployed <full-sha> --publish-run-id <id> [options]

Required:
  --deployed <sha>        Full 40-character SHA currently deployed
  --publish-run-id <id>   Numeric id of the successful "Publish container" run for the target

Options:
  --target <sha>          Full 40-character target SHA (default: HEAD)
  --rollback-tag <tag>    Previous image tag (default: sha-<deployed>)
  --json                  Print the machine-readable request instead of Markdown
  --output <path>         Write the request to a file
  -h, --help              Show this help
`;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      deployed: { type: "string" },
      target: { type: "string" },
      "publish-run-id": { type: "string" },
      "rollback-tag": { type: "string" },
      json: { type: "boolean", default: false },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  const repo = process.cwd();
  if (values.deployed === undefined) {
    throw new Error("--deployed is required (full 40-character SHA)");
  }
  if (values["publish-run-id"] === undefined) {
    throw new Error("--publish-run-id is required");
  }
  const deployedSha = validateFullSha(values.deployed, "--deployed");
  const targetSha = validateFullSha(values.target ?? git(repo, ["rev-parse", "HEAD"]), "--target");
  if (deployedSha === targetSha) {
    throw new Error("target revision equals the deployed revision; there is nothing to deploy");
  }
  const publishRunId = validatePublishRunId(values["publish-run-id"]);
  assertCommit(repo, deployedSha, "deployed revision");
  assertCommit(repo, targetSha, "target revision");

  const range = `${deployedSha}..${targetSha}`;
  const commits = git(repo, ["log", "--reverse", "--format=%H%x09%s", range])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    });
  const changedFiles = git(repo, ["diff", "--name-only", range]).split("\n").filter(Boolean);
  const diffStat = git(repo, ["diff", "--stat", "--no-color", range]);
  const shortStat = git(repo, ["diff", "--shortstat", "--no-color", range]);

  const request = {
    deployedSha,
    targetSha,
    publishRunId,
    rollbackTag: values["rollback-tag"] ?? `sha-${deployedSha}`,
    commits,
    changedFiles,
    diffStat,
    shortStat,
  };
  const output = values.json
    ? `${JSON.stringify(buildDeployRequest(request), null, 2)}\n`
    : renderDeployRequest(request);
  if (values.output === undefined) {
    process.stdout.write(output);
  } else {
    writeFileSync(values.output, output, "utf8");
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `deploy:request: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
