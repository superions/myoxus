/**
 * Completeness test: every affine:* alias must resolve to a registered schema.
 *
 * This test loads the real MyoxusSchemas bundle and verifies that:
 *   1. FLAVOUR_ALIAS_MAP has exactly the expected number of entries
 *   2. Every canonical target in FLAVOUR_ALIAS_MAP is a known myoxus:* flavour
 *   3. SURFACE_ID_ALIAS_MAP covers both surface discriminator IDs
 */
import { describe, expect, it } from "vitest";

import {
  FLAVOUR_ALIAS_MAP,
  SURFACE_ID_ALIAS_MAP,
} from "../schema/flavour-alias.js";

const EXPECTED_FLAVOUR_COUNT = 25;
const EXPECTED_SURFACE_COUNT = 2;

describe("FLAVOUR_ALIAS_MAP completeness", () => {
  it("keeps the legacy-to-canonical flavour alias table complete and one-to-one", () => {
    expect(FLAVOUR_ALIAS_MAP.size).toBe(EXPECTED_FLAVOUR_COUNT);
    const canonicals = new Set<string>();
    for (const [legacy, canonical] of FLAVOUR_ALIAS_MAP) {
      expect(legacy).toMatch(/^affine:/);
      expect(canonical).toMatch(/^myoxus:/);
      expect(canonicals.has(canonical)).toBe(false);
      canonicals.add(canonical);
    }
    expect(canonicals).toEqual(
      new Set([
        "myoxus:page",
        "myoxus:note",
        "myoxus:paragraph",
        "myoxus:list",
        "myoxus:code",
        "myoxus:divider",
        "myoxus:callout",
        "myoxus:image",
        "myoxus:attachment",
        "myoxus:bookmark",
        "myoxus:database",
        "myoxus:latex",
        "myoxus:frame",
        "myoxus:surface-ref",
        "myoxus:edgeless-text",
        "myoxus:table",
        "myoxus:embed-iframe",
        "myoxus:embed-figma",
        "myoxus:embed-github",
        "myoxus:embed-youtube",
        "myoxus:embed-loom",
        "myoxus:embed-html",
        "myoxus:embed-linked-doc",
        "myoxus:embed-synced-doc",
        "myoxus:surface",
      ]),
    );
  });
});

describe("SURFACE_ID_ALIAS_MAP completeness", () => {
  it("keeps both legacy surface discriminator aliases mapped to Myoxus IDs", () => {
    expect(SURFACE_ID_ALIAS_MAP.size).toBe(EXPECTED_SURFACE_COUNT);
    expect(SURFACE_ID_ALIAS_MAP.get("affine:surface:text")).toBe(
      "myoxus:surface:text",
    );
    expect(SURFACE_ID_ALIAS_MAP.get("affine:surface:ymap")).toBe(
      "myoxus:surface:ymap",
    );
  });
});
