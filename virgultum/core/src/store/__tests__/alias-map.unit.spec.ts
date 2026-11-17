import { describe, expect, it } from "vitest";

import {
  AliasMap,
  expandFlavourVariants,
  FLAVOUR_ALIAS_MAP,
  resolveFlavour,
  resolveSurfaceId,
  REVERSE_FLAVOUR_ALIAS_MAP,
  reverseResolveFlavour,
  SURFACE_ID_ALIAS_MAP,
} from "../schema/flavour-alias.js";

describe("AliasMap", () => {
  it("returns canonical value on direct lookup", () => {
    const map = new AliasMap<string>(FLAVOUR_ALIAS_MAP);
    map.set("myoxus:paragraph", "schema-paragraph");
    expect(map.get("myoxus:paragraph")).toBe("schema-paragraph");
  });

  it("resolves legacy affine:* key to canonical myoxus:* value", () => {
    const map = new AliasMap<string>(FLAVOUR_ALIAS_MAP);
    map.set("myoxus:paragraph", "schema-paragraph");
    expect(map.get("affine:paragraph")).toBe("schema-paragraph");
  });

  it("returns undefined for unknown key", () => {
    const map = new AliasMap<string>(FLAVOUR_ALIAS_MAP);
    map.set("myoxus:paragraph", "schema-paragraph");
    expect(map.get("custom:block")).toBeUndefined();
  });

  it("has() returns true for canonical key", () => {
    const map = new AliasMap<string>(FLAVOUR_ALIAS_MAP);
    map.set("myoxus:note", "schema-note");
    expect(map.has("myoxus:note")).toBe(true);
  });

  it("has() returns true for legacy alias key", () => {
    const map = new AliasMap<string>(FLAVOUR_ALIAS_MAP);
    map.set("myoxus:note", "schema-note");
    expect(map.has("affine:note")).toBe(true);
  });

  it("has() returns false for unknown key", () => {
    const map = new AliasMap<string>(FLAVOUR_ALIAS_MAP);
    expect(map.has("custom:unknown")).toBe(false);
  });

  it("set() stores under the provided key (canonical), not under the alias", () => {
    const map = new AliasMap<string>(FLAVOUR_ALIAS_MAP);
    map.set("myoxus:code", "schema-code");
    // canonical lookup
    expect(map.get("myoxus:code")).toBe("schema-code");
    // legacy lookup resolves to canonical
    expect(map.get("affine:code")).toBe("schema-code");
    // legacy key is NOT present as an independent entry
    expect(map.size).toBe(1);
  });

  it("handles all 25 flavour entries", () => {
    const map = new AliasMap<number>(FLAVOUR_ALIAS_MAP);
    let i = 0;
    for (const [, canonical] of FLAVOUR_ALIAS_MAP) {
      map.set(canonical, i++);
    }
    for (const [legacy, canonical] of FLAVOUR_ALIAS_MAP) {
      expect(map.get(legacy)).toBe(map.get(canonical));
    }
  });

  it("handles surface ID aliases", () => {
    const map = new AliasMap<string>(SURFACE_ID_ALIAS_MAP);
    map.set("myoxus:surface:text", "text-schema");
    map.set("myoxus:surface:ymap", "ymap-schema");
    expect(map.get("affine:surface:text")).toBe("text-schema");
    expect(map.get("affine:surface:ymap")).toBe("ymap-schema");
  });
});

describe("resolveFlavour", () => {
  it("resolves legacy affine:* to myoxus:*", () => {
    expect(resolveFlavour("affine:paragraph")).toBe("myoxus:paragraph");
    expect(resolveFlavour("affine:page")).toBe("myoxus:page");
    expect(resolveFlavour("affine:embed-github")).toBe("myoxus:embed-github");
  });

  it("passes through already-canonical myoxus:* unchanged", () => {
    expect(resolveFlavour("myoxus:paragraph")).toBe("myoxus:paragraph");
    expect(resolveFlavour("myoxus:embed-figma")).toBe("myoxus:embed-figma");
  });

  it("passes through unknown flavours unchanged", () => {
    expect(resolveFlavour("custom:block")).toBe("custom:block");
    expect(resolveFlavour("")).toBe("");
  });
});

describe("reverseResolveFlavour (BUG-08)", () => {
  it("maps canonical myoxus:* back to legacy affine:*", () => {
    expect(reverseResolveFlavour("myoxus:surface")).toBe("affine:surface");
    expect(reverseResolveFlavour("myoxus:paragraph")).toBe("affine:paragraph");
    expect(reverseResolveFlavour("myoxus:embed-github")).toBe(
      "affine:embed-github",
    );
  });

  it("passes through already-legacy affine:* unchanged", () => {
    // affine:* is not a canonical key in REVERSE_FLAVOUR_ALIAS_MAP
    expect(reverseResolveFlavour("affine:surface")).toBe("affine:surface");
  });

  it("passes through unknown flavours unchanged", () => {
    expect(reverseResolveFlavour("custom:block")).toBe("custom:block");
  });

  it("REVERSE_FLAVOUR_ALIAS_MAP covers all 25 flavour entries", () => {
    expect(REVERSE_FLAVOUR_ALIAS_MAP.size).toBe(FLAVOUR_ALIAS_MAP.size);
    for (const [legacy, canonical] of FLAVOUR_ALIAS_MAP) {
      expect(REVERSE_FLAVOUR_ALIAS_MAP.get(canonical)).toBe(legacy);
    }
  });
});

describe("resolveSurfaceId", () => {
  it("resolves legacy affine:surface:* to myoxus:surface:*", () => {
    expect(resolveSurfaceId("affine:surface:text")).toBe("myoxus:surface:text");
    expect(resolveSurfaceId("affine:surface:ymap")).toBe("myoxus:surface:ymap");
  });

  it("passes through canonical surface IDs unchanged", () => {
    expect(resolveSurfaceId("myoxus:surface:text")).toBe("myoxus:surface:text");
    expect(resolveSurfaceId("myoxus:surface:ymap")).toBe("myoxus:surface:ymap");
  });
});

// =====================================================================
// P-VIRG-ARCH-F-01/02 — expandFlavourVariants Tests
// =====================================================================

describe("expandFlavourVariants (P-VIRG-ARCH-F-01/02)", () => {
  it("kanonische Eingabe liefert Set mit kanonisch + legacy", () => {
    const out = expandFlavourVariants("myoxus:paragraph");
    expect(out).toEqual(new Set(["myoxus:paragraph", "affine:paragraph"]));
  });

  it("legacy Eingabe liefert Set mit legacy + kanonisch (Reihenfolge egal)", () => {
    const out = expandFlavourVariants("affine:paragraph");
    expect(out).toEqual(new Set(["affine:paragraph", "myoxus:paragraph"]));
  });

  it("Array-Eingabe expandiert jeden Eintrag", () => {
    const out = expandFlavourVariants(["myoxus:note", "affine:database"]);
    expect(out).toEqual(
      new Set([
        "myoxus:note",
        "affine:note",
        "affine:database",
        "myoxus:database",
      ]),
    );
  });

  it("custom-Flavour ohne Alias bleibt unveraendert (nur Original)", () => {
    const out = expandFlavourVariants("custom:block");
    expect(out).toEqual(new Set(["custom:block"]));
  });

  it("dedupliziert wenn canonical === original === legacy (z.B. surface)", () => {
    // 'affine:surface' ist sowohl im FLAVOUR_ALIAS_MAP als auch
    // selbst der kanonische Schluessel. Set-Dedup garantiert
    // Eindeutigkeit.
    const out = expandFlavourVariants("affine:surface");
    expect(out.size).toBe(2);
    expect(out.has("affine:surface")).toBe(true);
    expect(out.has("myoxus:surface")).toBe(true);
  });

  it("leeres Array liefert leeres Set", () => {
    expect(expandFlavourVariants([]).size).toBe(0);
  });

  it("nutzerdefinierter Alias-Map-Wert bleibt korrekt", () => {
    // "affine:embed-figma" -> "myoxus:embed-figma" und umgekehrt
    const out = expandFlavourVariants("myoxus:embed-figma");
    expect(out).toEqual(new Set(["myoxus:embed-figma", "affine:embed-figma"]));
  });
});
