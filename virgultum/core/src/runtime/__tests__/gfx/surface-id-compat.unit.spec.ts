/**
 * Surface ID compatibility tests.
 *
 * Invariants:
 *   - hasSurfaceTextId() accepts both canonical (myoxus:) and legacy (affine:) keys
 *   - hasSurfaceYmapId() accepts both canonical and legacy keys
 *   - SURFACE_TEXT_UNIQ_IDENTIFIER / SURFACE_YMAP_UNIQ_IDENTIFIER are myoxus:*
 */
import { describe, expect, it } from "vitest";

import {
  hasSurfaceTextId,
  hasSurfaceYmapId,
  SURFACE_TEXT_UNIQ_IDENTIFIER,
  SURFACE_YMAP_UNIQ_IDENTIFIER,
} from "../../gfx/model/surface/surface-model.js";

describe("Surface ID constants", () => {
  it("SURFACE_TEXT_UNIQ_IDENTIFIER uses canonical myoxus: prefix", () => {
    expect(SURFACE_TEXT_UNIQ_IDENTIFIER).toBe("myoxus:surface:text");
  });

  it("SURFACE_YMAP_UNIQ_IDENTIFIER uses canonical myoxus: prefix", () => {
    expect(SURFACE_YMAP_UNIQ_IDENTIFIER).toBe("myoxus:surface:ymap");
  });
});

describe("hasSurfaceTextId", () => {
  it("returns true for canonical myoxus:surface:text key", () => {
    expect(hasSurfaceTextId({ "myoxus:surface:text": true })).toBe(true);
  });

  it("returns true for legacy affine:surface:text key", () => {
    expect(hasSurfaceTextId({ "affine:surface:text": true })).toBe(true);
  });

  it("returns false for unrelated object", () => {
    expect(hasSurfaceTextId({ foo: "bar" })).toBe(false);
  });

  it("returns false for ymap key", () => {
    expect(hasSurfaceTextId({ "myoxus:surface:ymap": true })).toBe(false);
  });
});

describe("hasSurfaceYmapId", () => {
  it("returns true for canonical myoxus:surface:ymap key", () => {
    expect(hasSurfaceYmapId({ "myoxus:surface:ymap": true })).toBe(true);
  });

  it("returns true for legacy affine:surface:ymap key", () => {
    expect(hasSurfaceYmapId({ "affine:surface:ymap": true })).toBe(true);
  });

  it("returns false for unrelated object", () => {
    expect(hasSurfaceYmapId({ foo: "bar" })).toBe(false);
  });

  it("returns false for text key", () => {
    expect(hasSurfaceYmapId({ "myoxus:surface:text": true })).toBe(false);
  });
});
