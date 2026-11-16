import { describe, expect, it } from "vitest";
import {
  axisTicks,
  bandPath,
  chartDescription,
  coalesceOomEvents,
  formatBytes,
  linePath,
  type MemoryOomEvent,
  type MemorySampleBucket,
  nearestBucket,
  resolveBucket,
  scaleY,
} from "./memory-chart.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function bucket(
  start: string,
  minBytes: number,
  averageBytes: number,
  maxBytes: number,
  samples = 2,
): MemorySampleBucket {
  return { start, minBytes, averageBytes, maxBytes, samples };
}

function oom(at: string, message: string | null = null): MemoryOomEvent {
  return { at, kind: "oom_killed", message };
}

describe("memory bucket resolution", () => {
  it("maps Auto to 10m for 6h and 30m for 24h/72h", () => {
    expect(resolveBucket("6h", "auto")).toBe("10m");
    expect(resolveBucket("24h", "auto")).toBe("30m");
    expect(resolveBucket("72h", "auto")).toBe("30m");
  });

  it("keeps explicit buckets and clamps 10m at 72h", () => {
    expect(resolveBucket("6h", "30m")).toBe("30m");
    expect(resolveBucket("24h", "10m")).toBe("10m");
    expect(resolveBucket("72h", "10m")).toBe("30m");
  });
});

describe("scaleY", () => {
  it("maps the domain to the inverted pixel range", () => {
    expect(scaleY(0, 0, 100, 100)).toBe(100);
    expect(scaleY(100, 0, 100, 100)).toBe(0);
    expect(scaleY(50, 0, 100, 100)).toBe(50);
    expect(scaleY(25, 0, 100, 200)).toBe(150);
  });

  it("clamps values outside the domain and handles a flat domain", () => {
    expect(scaleY(-10, 0, 100, 100)).toBe(100);
    expect(scaleY(120, 0, 100, 100)).toBe(0);
    expect(scaleY(5, 5, 5, 100)).toBe(100);
    expect(scaleY(5, 0, 100, 0)).toBe(0);
  });
});

describe("linePath", () => {
  it("builds one subpath for contiguous points", () => {
    expect(
      linePath([
        { x: 0, y: 10 },
        { x: 100, y: 20 },
      ]),
    ).toBe("M 0 10 L 100 20");
  });

  it("breaks the line at a gap instead of bridging missing buckets", () => {
    expect(
      linePath([
        { x: 0, y: 10 },
        { x: 10, y: 20, gapAfter: true },
        { x: 30, y: 30 },
        { x: 40, y: 40 },
      ]),
    ).toBe("M 0 10 L 10 20 M 30 30 L 40 40");
  });

  it("renders a single point and an empty series without inventing a zero", () => {
    expect(linePath([{ x: 5, y: 5 }])).toBe("M 5 5 l 0.01 0");
    expect(linePath([])).toBe("");
  });
});

describe("bandPath", () => {
  it("closes the min-max band across contiguous buckets", () => {
    expect(
      bandPath([
        { x: 0, upperY: 10, lowerY: 20 },
        { x: 10, upperY: 5, lowerY: 25 },
      ]),
    ).toBe("M 0 10 L 10 5 L 10 25 L 0 20 Z");
  });

  it("splits the band at gaps", () => {
    expect(
      bandPath([
        { x: 0, upperY: 10, lowerY: 20, gapAfter: true },
        { x: 30, upperY: 5, lowerY: 15 },
      ]),
    ).toBe("M 0 10 L 0 20 Z M 30 5 L 30 15 Z");
  });
});

describe("nearestBucket", () => {
  const buckets = [
    { start: "2026-11-16T10:00:00.000Z" },
    { start: "2026-11-16T11:00:00.000Z" },
    { start: "2026-11-16T12:00:00.000Z" },
  ];

  it("returns the index of the closest bucket start", () => {
    expect(nearestBucket(buckets, "2026-11-16T10:20:00.000Z")).toBe(0);
    expect(nearestBucket(buckets, "2026-11-16T11:20:00.000Z")).toBe(1);
    expect(nearestBucket(buckets, Date.parse("2026-11-16T11:45:00.000Z"))).toBe(2);
  });

  it("returns -1 for an empty or invalid set", () => {
    expect(nearestBucket([], "2026-11-16T11:00:00.000Z")).toBe(-1);
    expect(nearestBucket(buckets, "not-a-date")).toBe(-1);
  });
});

describe("formatBytes", () => {
  it("formats MiB and GiB and uses an em dash for missing values", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("0 MiB");
    expect(formatBytes(412 * MIB)).toBe("412 MiB");
    expect(formatBytes(486.5 * MIB)).toBe("487 MiB");
    expect(formatBytes(1.84 * GIB)).toBe("1.84 GiB");
    expect(formatBytes(2 * GIB)).toBe("2 GiB");
    expect(formatBytes(1024 * MIB)).toBe("1 GiB");
  });
});

describe("coalesceOomEvents", () => {
  it("keeps at most one event per 60 seconds", () => {
    const events = [
      oom("2026-11-16T12:00:00.000Z"),
      oom("2026-11-16T12:00:30.000Z"),
      oom("2026-11-16T12:01:00.000Z"),
      oom("2026-11-16T12:01:20.000Z"),
    ];
    const kept = coalesceOomEvents(events);
    expect(kept.map((event) => event.at)).toEqual([
      "2026-11-16T12:00:00.000Z",
      "2026-11-16T12:01:00.000Z",
    ]);
  });
});

describe("chartDescription", () => {
  it("describes an empty range without implying zero data", () => {
    const text = chartDescription("6h", [], []);
    expect(text).toContain("6 hours");
    expect(text).toContain("No samples in this range");
  });

  it("summarizes buckets, current, peak, and OOM events", () => {
    const text = chartDescription(
      "24h",
      [
        bucket("2026-11-16T10:00:00.000Z", 100 * MIB, 200 * MIB, 300 * MIB),
        bucket("2026-11-16T11:00:00.000Z", 300 * MIB, 500 * MIB, 1.84 * GIB),
      ],
      [oom("2026-11-16T10:30:00.000Z"), oom("2026-11-16T11:30:00.000Z")],
      { samples: 4, peakBytes: 1.84 * GIB, currentBytes: 500 * MIB },
    );
    expect(text).toContain("24 hours");
    expect(text).toContain("2 buckets with samples");
    expect(text).toContain("current 500 MiB");
    expect(text).toContain("peak 1.84 GiB");
    expect(text).toContain("2 OOM events");
    expect(text).toContain("Buckets with no samples are omitted");
  });
});

describe("axisTicks", () => {
  const from = "2026-11-16T00:00:00.000Z";
  const to = "2026-11-16T06:00:00.000Z";

  it("includes both window ends and the requested count", () => {
    const ticks = axisTicks(from, to, 4);
    expect(ticks).toHaveLength(4);
    expect(ticks[0]?.at).toBe(Date.parse(from));
    expect(ticks[3]?.at).toBe(Date.parse(to));
    expect(ticks[1]?.at).toBe(Date.parse("2026-11-16T02:00:00.000Z"));
    for (const tick of ticks) {
      expect(tick.label).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("adds the weekday for a multi-day window and rejects an empty count", () => {
    const ticks = axisTicks(from, "2026-11-19T00:00:00.000Z", 2, true);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]?.label).toMatch(/^[A-Za-z]{3} \d{2}:\d{2}$/);
    expect(axisTicks(from, to, 0)).toEqual([]);
  });
});
