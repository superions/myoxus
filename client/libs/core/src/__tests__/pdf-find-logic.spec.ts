import { describe, expect, it } from "vitest";

// Pure logic extracted from PDFViewerInner: builds a flat match list from
// per-page text-string arrays, supporting case-insensitive and case-sensitive modes.
function buildMatchList(
  textStrings: Map<number, string[]>,
  query: string,
  caseSensitive: boolean,
  pageCount: number,
): Array<{ pageNum: number; itemIndex: number }> {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: Array<{ pageNum: number; itemIndex: number }> = [];
  for (let p = 0; p < pageCount; p++) {
    const strs = textStrings.get(p) ?? [];
    strs.forEach((str, idx) => {
      const hay = caseSensitive ? str : str.toLowerCase();
      if (hay.includes(needle)) {
        matches.push({ pageNum: p, itemIndex: idx });
      }
    });
  }
  return matches;
}

// Wraps cursor navigation: ((n % len) + len) % len for wrapping
function wrapCursor(n: number, len: number): number {
  return ((n % len) + len) % len;
}

describe("pdf find: buildMatchList", () => {
  const makeStrings = (pages: Record<number, string[]>, pageCount: number) => {
    const m = new Map<number, string[]>();
    for (let i = 0; i < pageCount; i++) {
      m.set(i, pages[i] ?? []);
    }
    return m;
  };

  it("returns empty list when query is empty", () => {
    const strings = makeStrings({ 0: ["hello world"] }, 1);
    expect(buildMatchList(strings, "", false, 1)).toEqual([]);
  });

  it("finds single match on one page", () => {
    const strings = makeStrings({ 0: ["hello world", "foo bar"] }, 1);
    const result = buildMatchList(strings, "hello", false, 1);
    expect(result).toEqual([{ pageNum: 0, itemIndex: 0 }]);
  });

  it("finds multiple matches on one page", () => {
    const strings = makeStrings({ 0: ["hello world", "hello there"] }, 1);
    const result = buildMatchList(strings, "hello", false, 1);
    expect(result).toEqual([
      { pageNum: 0, itemIndex: 0 },
      { pageNum: 0, itemIndex: 1 },
    ]);
  });

  it("finds matches across multiple pages in order", () => {
    const strings = makeStrings(
      { 0: ["first page", "some text"], 1: ["second page", "first again"] },
      2,
    );
    const result = buildMatchList(strings, "first", false, 2);
    expect(result).toEqual([
      { pageNum: 0, itemIndex: 0 },
      { pageNum: 1, itemIndex: 1 },
    ]);
  });

  it("is case-insensitive by default", () => {
    const strings = makeStrings({ 0: ["Hello World", "HELLO THERE"] }, 1);
    const result = buildMatchList(strings, "hello", false, 1);
    expect(result).toHaveLength(2);
  });

  it("respects case-sensitive mode — no match when case differs", () => {
    const strings = makeStrings({ 0: ["Hello World"] }, 1);
    expect(buildMatchList(strings, "hello", true, 1)).toHaveLength(0);
    expect(buildMatchList(strings, "Hello", true, 1)).toHaveLength(1);
  });

  it("returns empty list when no items match", () => {
    const strings = makeStrings({ 0: ["no match here"] }, 1);
    expect(buildMatchList(strings, "xyz", false, 1)).toEqual([]);
  });

  it("handles pages with no text strings", () => {
    const strings = makeStrings({ 0: [], 1: ["match here"], 2: [] }, 3);
    const result = buildMatchList(strings, "match", false, 3);
    expect(result).toEqual([{ pageNum: 1, itemIndex: 0 }]);
  });

  it("handles pages not in the map (treated as empty)", () => {
    const strings = new Map<number, string[]>([[0, ["hello"]]]);
    const result = buildMatchList(strings, "hello", false, 3);
    expect(result).toEqual([{ pageNum: 0, itemIndex: 0 }]);
  });
});

describe("pdf find: cursor navigation wrapping", () => {
  it("wraps forward past end", () => {
    expect(wrapCursor(3, 3)).toBe(0);
    expect(wrapCursor(4, 3)).toBe(1);
  });

  it("wraps backward past start", () => {
    expect(wrapCursor(-1, 3)).toBe(2);
    expect(wrapCursor(-2, 3)).toBe(1);
  });

  it("stays in range for mid values", () => {
    expect(wrapCursor(1, 3)).toBe(1);
    expect(wrapCursor(2, 3)).toBe(2);
  });
});
