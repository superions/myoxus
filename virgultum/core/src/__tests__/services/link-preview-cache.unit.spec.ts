import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LinkPreviewCache } from "../../services/link-preview-service/link-preview-cache";

describe("LinkPreviewCache", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("expires entries and evicts the least recently used entry", () => {
    const cache = new LinkPreviewCache({
      cacheSize: 2,
      localStorageTTL: 10_000,
      memoryTTL: 100,
    });

    cache.set("first", { title: "First" });
    cache.set("second", { title: "Second" });
    expect(cache.get("first")).toEqual({ title: "First" });

    cache.set("third", { title: "Third" });
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toEqual({ title: "First" });
    expect(cache.get("third")).toEqual({ title: "Third" });

    vi.advanceTimersByTime(101);
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("third")).toBeUndefined();
  });
});
