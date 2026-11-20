/**
 * Pure transcript window math.
 *
 * The rendered transcript is a contiguous `[start, end)` slice of the loaded items. Hidden rows are
 * replaced by a top and a bottom spacer that reproduce both their measured heights and the flex gap
 * between them, so the full item-run height is unchanged. This module has no Vue, DOM, network, or
 * storage dependency.
 */

export interface TranscriptWindowInput {
  readonly heights: readonly number[]; // aligned to items; 0 = unmeasured
  readonly fallbackHeight: number;
  readonly gap: number;
  readonly localScrollTop: number;
  readonly viewportHeight: number;
  readonly overscan: number;
  readonly pinned: boolean;
  readonly keepAlive: readonly number[]; // bounded by the caller
  readonly revealIndex?: number; // one-shot restore anchor, may be far away
  readonly enabled: boolean;
}

export interface TranscriptWindow {
  readonly start: number;
  readonly end: number;
  readonly topPad: number;
  readonly bottomPad: number;
}

function effectiveHeight(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function buildPrefix(heights: readonly number[], fallbackHeight: number): number[] {
  const prefix = new Array<number>(heights.length + 1);
  prefix[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    const previous = prefix[index] ?? 0;
    prefix[index + 1] = previous + effectiveHeight(heights[index], fallbackHeight);
  }
  return prefix;
}

function prefixAt(prefix: readonly number[], index: number): number {
  return prefix[index] ?? 0;
}

/** Scroll-content coordinate of item `index`'s top in the full layout (gaps included). */
function topOffset(prefix: readonly number[], gap: number, index: number): number {
  return prefixAt(prefix, index) + gap * index;
}

/** First index in `[0, count)` where `predicate` is true, or `count` when none is. */
function firstIndexWhere(count: number, predicate: (index: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (predicate(middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function fullWindow(): TranscriptWindow {
  return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
}

export function computeTranscriptWindow(input: TranscriptWindowInput): TranscriptWindow {
  const heights = input.heights;
  const count = heights.length;
  if (!input.enabled || count === 0 || input.viewportHeight <= 0) {
    return count === 0 ? fullWindow() : { start: 0, end: count, topPad: 0, bottomPad: 0 };
  }

  const gap = input.gap;
  const fallbackHeight = input.fallbackHeight;
  const prefix = buildPrefix(heights, fallbackHeight);
  const totalHeight = prefixAt(prefix, count);
  const totalWithGaps = totalHeight + gap * (count - 1);

  let start: number;
  let end: number;

  if (input.pinned) {
    end = count;
    const budget = input.viewportHeight + input.overscan;
    const threshold = totalWithGaps - budget;
    const candidate = firstIndexWhere(count, (index) => {
      return topOffset(prefix, gap, index) >= threshold;
    });
    start = clamp(candidate, 0, count - 1);
  } else {
    const topEdge = input.localScrollTop - input.overscan;
    const bottomEdge = input.localScrollTop + input.viewportHeight + input.overscan;
    const first = firstIndexWhere(count, (index) => {
      const height = prefixAt(prefix, index + 1) - prefixAt(prefix, index);
      return topOffset(prefix, gap, index) + height > topEdge;
    });
    const afterLast = firstIndexWhere(count + 1, (index) => {
      return topOffset(prefix, gap, index) >= bottomEdge;
    });
    start = clamp(first, 0, count - 1);
    end = clamp(afterLast, start + 1, count);
  }

  for (const index of input.keepAlive) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      continue;
    }
    start = Math.min(start, index);
    end = Math.max(end, index + 1);
  }

  const revealIndex = input.revealIndex;
  if (
    revealIndex !== undefined &&
    Number.isInteger(revealIndex) &&
    revealIndex >= 0 &&
    revealIndex < count
  ) {
    start = Math.min(start, revealIndex);
    end = Math.max(end, revealIndex + 1);
  }

  start = clamp(start, 0, count - 1);
  end = clamp(end, start + 1, count);

  const topPad = start <= 0 ? 0 : topOffset(prefix, gap, start);
  const bottomPad =
    end >= count
      ? 0
      : Math.max(0, prefixAt(prefix, count) - prefixAt(prefix, end) + gap * (count - 1 - end));

  return { start, end, topPad, bottomPad };
}
