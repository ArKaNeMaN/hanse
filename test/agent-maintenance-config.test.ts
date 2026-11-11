import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAINTENANCE_CONFIG,
  MIN_MAINTENANCE_INTERVAL_MS,
  resolveMaintenanceConfig,
} from "../src/coordinator/agent-maintenance.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveMaintenanceConfig", () => {
  it("uses the documented defaults for an empty environment", () => {
    expect(resolveMaintenanceConfig({})).toEqual(DEFAULT_MAINTENANCE_CONFIG);
    expect(DEFAULT_MAINTENANCE_CONFIG).toEqual({
      autoStopMs: 172_800_000,
      autoUpdateMs: 10_800_000,
      intervalMs: 300_000,
      autoPullMs: 900_000,
    });
  });

  it("honors explicit values, including 0 to disable an action", () => {
    expect(
      resolveMaintenanceConfig({
        HANSE_AGENT_AUTO_STOP_MS: "0",
        HANSE_AGENT_AUTO_UPDATE_MS: "60000",
        HANSE_AGENT_MAINTENANCE_INTERVAL_MS: "45000",
        HANSE_AGENT_AUTO_PULL_MS: "0",
      }),
    ).toEqual({
      autoStopMs: 0,
      autoUpdateMs: 60_000,
      intervalMs: 45_000,
      autoPullMs: 0,
    });
  });

  it("clamps the idle interval to at least 30 seconds", () => {
    expect(resolveMaintenanceConfig({ HANSE_AGENT_MAINTENANCE_INTERVAL_MS: "1" }).intervalMs).toBe(
      MIN_MAINTENANCE_INTERVAL_MS,
    );
    expect(resolveMaintenanceConfig({ HANSE_AGENT_MAINTENANCE_INTERVAL_MS: "0" }).intervalMs).toBe(
      MIN_MAINTENANCE_INTERVAL_MS,
    );
  });

  it("warns once per invalid value and falls back to the default", () => {
    const warn = vi.fn();
    const config = resolveMaintenanceConfig(
      {
        HANSE_AGENT_AUTO_STOP_MS: "soon",
        HANSE_AGENT_AUTO_UPDATE_MS: "-1",
        HANSE_AGENT_AUTO_PULL_MS: "1.5",
        HANSE_AGENT_MAINTENANCE_INTERVAL_MS: "nope",
      },
      warn,
    );
    expect(config).toEqual(DEFAULT_MAINTENANCE_CONFIG);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "agent_maintenance_invalid_config",
      expect.objectContaining({ variable: "HANSE_AGENT_AUTO_STOP_MS", fallback: 172_800_000 }),
    );
  });

  it("does not warn for an absent or empty value", () => {
    const warn = vi.fn();
    resolveMaintenanceConfig(
      { HANSE_AGENT_AUTO_STOP_MS: "", HANSE_AGENT_AUTO_UPDATE_MS: "   " },
      warn,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
