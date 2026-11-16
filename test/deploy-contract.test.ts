import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/shared/routes.js";

interface ContractRoute {
  id: string;
  path: string;
  public: boolean;
  synthetic: boolean;
}

interface DeployContract {
  contractVersion: number;
  requiredAssets: string[];
  removedAssets: string[];
  routes: ContractRoute[];
  http: {
    health: Record<string, { status: number }>;
    anonymous: Record<string, { status: number; location?: string }>;
    authenticated: Record<string, { status: number }>;
    login: Record<string, { status?: number; statuses?: number[] }>;
    assets: Record<string, { status: number }>;
    missingUiBuild: Record<string, { status: number; title: string }>;
  };
}

const contract = JSON.parse(
  readFileSync(path.join(process.cwd(), "deploy-contract.json"), "utf8"),
) as DeployContract;

describe("deploy contract", () => {
  it("lists every shared page route with the same path, public flag, and synthetic flag", () => {
    expect(contract.routes.map((route) => route.id).sort()).toEqual(
      ROUTES.map((route) => route.id).sort(),
    );
    for (const route of ROUTES) {
      expect(contract.routes.find((entry) => entry.id === route.id)).toMatchObject({
        path: route.path,
        public: route.public === true,
        synthetic: route.synthetic === true,
      });
    }
  });

  it("pins the machine-readable contract version and the UI build assets", () => {
    expect(contract.contractVersion).toBe(1);
    expect(contract.requiredAssets).toContain("/assets/app.css");
    expect(contract.requiredAssets).toContain("/assets/favicon.svg");
    expect(contract.requiredAssets).toContain("/assets/ui/.vite/manifest.json");
    expect(contract.removedAssets).toContain("/assets/app-content.js");
    expect(contract.removedAssets).toContain("/assets/app.js");
  });

  it("records the stable deploy-visible HTTP semantics", () => {
    expect(contract.http.health["GET /healthz"]?.status).toBe(200);
    expect(contract.http.health["GET /readyz"]?.status).toBe(200);
    expect(contract.http.anonymous["GET /"]).toMatchObject({
      status: 302,
      location: "/login?next=%2F",
    });
    expect(contract.http.anonymous["GET /login"]?.status).toBe(200);
    expect(contract.http.authenticated["GET /"]?.status).toBe(200);
    expect(contract.http.authenticated["GET /unknown"]?.status).toBe(404);
    expect(contract.http.login["POST /login"]?.status).toBe(405);
    expect(contract.http.assets["GET /assets/app.css"]?.status).toBe(200);
    expect(contract.http.assets["GET /assets/unknown"]?.status).toBe(404);
    expect(contract.http.missingUiBuild.knownPage).toMatchObject({
      status: 503,
      title: "Interface unavailable",
    });
  });
});
