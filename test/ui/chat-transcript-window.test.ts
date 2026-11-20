import { describe, expect, it } from "vitest";
import {
  computeTranscriptWindow,
  type TranscriptWindow,
  type TranscriptWindowInput,
} from "../../ui/chat/transcript-window.js";

const BASE: TranscriptWindowInput = {
  heights: [],
  fallbackHeight: 160,
  gap: 20,
  localScrollTop: 0,
  viewportHeight: 100,
  overscan: 0,
  pinned: false,
  keepAlive: [],
  enabled: true,
};

function windowOf(input: Partial<TranscriptWindowInput>): TranscriptWindow {
  return computeTranscriptWindow({ ...BASE, ...input });
}

function effective(heights: readonly number[], fallback: number, index: number): number {
  const value = heights[index];
  return value !== undefined && value > 0 ? value : fallback;
}

function prefix(heights: readonly number[], fallback: number, index: number): number {
  let total = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    total += effective(heights, fallback, cursor);
  }
  return total;
}

/**
 * D5 pad identity: the rendered rows plus the top/bottom spacers reproduce the full item-run
 * height exactly, including the flex gap between rows.
 */
function expectPadIdentity(input: TranscriptWindowInput, window: TranscriptWindow): void {
  const count = input.heights.length;
  let rows = 0;
  for (let index = window.start; index < window.end; index += 1) {
    rows += effective(input.heights, input.fallbackHeight, index);
  }
  const innerGaps = input.gap * (window.end - window.start - 1);
  const boundaryGap = window.bottomPad > 0 ? input.gap : 0;
  const rendered = window.topPad + rows + innerGaps + boundaryGap + window.bottomPad;
  const full = prefix(input.heights, input.fallbackHeight, count) + input.gap * (count - 1);
  expect(rendered).toBeCloseTo(full, 6);
}

describe("computeTranscriptWindow", () => {
  it("returns the full range with no spacers when windowing is disabled", () => {
    const heights = [100, 120, 140];
    expect(windowOf({ heights, enabled: false, pinned: true })).toEqual({
      start: 0,
      end: 3,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it("returns an empty range for an empty list", () => {
    expect(windowOf({ heights: [], pinned: true })).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it("returns the full range when the viewport height is not measurable", () => {
    expect(windowOf({ heights: [100, 100], viewportHeight: 0, pinned: false })).toEqual({
      start: 0,
      end: 2,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it("uses the fallback height for unmeasured rows", () => {
    const window = windowOf({
      heights: [0, 0, 0],
      fallbackHeight: 50,
      gap: 0,
      viewportHeight: 60,
      overscan: 0,
      pinned: true,
    });
    expect(window).toEqual({ start: 2, end: 3, topPad: 100, bottomPad: 0 });
    expectPadIdentity(
      {
        ...BASE,
        heights: [0, 0, 0],
        fallbackHeight: 50,
        gap: 0,
        viewportHeight: 60,
        pinned: true,
      },
      window,
    );
  });

  it("keeps two viewport heights of overscan above the pinned tail", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [100, 100, 100],
      gap: 10,
      viewportHeight: 100,
      overscan: 200,
      pinned: true,
    };
    const window = computeTranscriptWindow(input);
    expect(window).toEqual({ start: 1, end: 3, topPad: 110, bottomPad: 0 });
    expectPadIdentity(input, window);
  });

  it("clamps a pinned single row that is taller than the viewport", () => {
    const window = windowOf({
      heights: [1000],
      viewportHeight: 100,
      overscan: 0,
      pinned: true,
    });
    expect(window).toEqual({ start: 0, end: 1, topPad: 0, bottomPad: 0 });
  });

  it("keeps one row at the tail when the last row alone exceeds the budget", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [1000, 100],
      gap: 20,
      viewportHeight: 100,
      overscan: 0,
      pinned: true,
    };
    const window = computeTranscriptWindow(input);
    expect(window).toEqual({ start: 1, end: 2, topPad: 1020, bottomPad: 0 });
    expectPadIdentity(input, window);
  });

  it("selects a middle window from localScrollTop with overscan", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [100, 100, 100, 100],
      gap: 20,
      localScrollTop: 110,
      viewportHeight: 100,
      overscan: 0,
      pinned: false,
    };
    const window = computeTranscriptWindow(input);
    expect(window).toEqual({ start: 1, end: 2, topPad: 120, bottomPad: 220 });
    expectPadIdentity(input, window);
  });

  it("returns the full range for a window covering every row", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [100, 100, 100, 100],
      gap: 20,
      viewportHeight: 1000,
      pinned: false,
    };
    const window = computeTranscriptWindow(input);
    expect(window).toEqual({ start: 0, end: 4, topPad: 0, bottomPad: 0 });
    expectPadIdentity(input, window);
  });

  it("keeps the pad identity for a tail window", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [100, 100, 100, 100],
      gap: 20,
      localScrollTop: 260,
      viewportHeight: 100,
      pinned: false,
    };
    const window = computeTranscriptWindow(input);
    expect(window).toEqual({ start: 2, end: 3, topPad: 240, bottomPad: 100 });
    expectPadIdentity(input, window);
  });

  it("handles a zero gap", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [100, 100, 100],
      gap: 0,
      localScrollTop: 100,
      viewportHeight: 100,
      pinned: false,
    };
    const window = computeTranscriptWindow(input);
    expect(window).toEqual({ start: 1, end: 2, topPad: 100, bottomPad: 100 });
    expectPadIdentity(input, window);
  });

  it("expands the range to include keep-alive rows", () => {
    const window = windowOf({
      heights: Array.from({ length: 10 }, () => 100),
      gap: 0,
      localScrollTop: 500,
      viewportHeight: 100,
      overscan: 0,
      keepAlive: [2, 9],
    });
    expect(window).toEqual({ start: 2, end: 10, topPad: 200, bottomPad: 0 });
  });

  it("ignores out-of-range keep-alive entries", () => {
    const window = windowOf({
      heights: Array.from({ length: 10 }, () => 100),
      gap: 0,
      localScrollTop: 500,
      viewportHeight: 100,
      overscan: 0,
      keepAlive: [-1, 10, 2.5],
    });
    expect(window).toEqual({ start: 5, end: 6, topPad: 500, bottomPad: 400 });
  });

  it("includes a far-away one-shot reveal index", () => {
    const window = windowOf({
      heights: Array.from({ length: 10 }, () => 100),
      gap: 0,
      localScrollTop: 500,
      viewportHeight: 100,
      overscan: 0,
      revealIndex: 0,
    });
    expect(window).toEqual({ start: 0, end: 6, topPad: 0, bottomPad: 400 });
  });

  it("clamps a scroll position past the end to a non-empty tail", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [100, 100, 100],
      gap: 0,
      localScrollTop: 10_000,
      viewportHeight: 100,
      pinned: false,
    };
    const window = computeTranscriptWindow(input);
    expect(window).toEqual({ start: 2, end: 3, topPad: 200, bottomPad: 0 });
    expectPadIdentity(input, window);
  });

  it("clamps a negative scroll position to the head", () => {
    const window = windowOf({
      heights: [100, 100],
      gap: 0,
      localScrollTop: -50,
      viewportHeight: 100,
      overscan: 0,
    });
    expect(window).toEqual({ start: 0, end: 1, topPad: 0, bottomPad: 100 });
  });

  it("keeps the pad identity for a prefix window", () => {
    const input: TranscriptWindowInput = {
      ...BASE,
      heights: [40, 60, 80, 100],
      gap: 12,
      localScrollTop: 0,
      viewportHeight: 100,
      overscan: 0,
      pinned: false,
    };
    const window = computeTranscriptWindow(input);
    expectPadIdentity(input, window);
  });
});
