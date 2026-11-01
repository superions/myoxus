import { describe, expect, test } from "vitest";

import { SLIDE_BACKGROUND_URLS } from "./slide-backgrounds";

describe("AI slide template backgrounds", () => {
  test("use local data URLs instead of remote template artwork", () => {
    const urls = Object.values(SLIDE_BACKGROUND_URLS);

    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toMatch(/^data:image\/svg\+xml,/);
      expect(url).not.toMatch(/^https?:\/\//);
      expect(url).not.toContain("cdn.");
      expect(decodeURIComponent(url)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
});
