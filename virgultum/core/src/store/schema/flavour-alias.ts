/**
 * AliasMap: Transparent backward-compatibility layer for block flavour names.
 *
 * Primary flavours are `myoxus:*`. Legacy Yjs documents that contain `affine:*`
 * flavour strings are resolved transparently at read-time via this map — no
 * data migration required, no dual-registration, no code duplication.
 *
 * Architecture:
 *   - FLAVOUR_ALIAS_MAP: 25 entries (affine:* → myoxus:*)
 *   - SURFACE_ID_ALIAS_MAP: 2 entries (affine:surface:* → myoxus:surface:*)
 *   - AliasMap<V>: drop-in replacement for Map<string, V> that resolves aliases
 *     on every .get() and .has() call
 *   - resolveFlavour() / resolveSurfaceId(): helper functions for direct use
 *
 * Adding a new flavour:
 *   1. Define the schema with `myoxus:newblock` as the primary flavour
 *   2. Add `'affine:newblock' → 'myoxus:newblock'` to FLAVOUR_ALIAS_MAP
 *   3. Done — all lookup sites are automatically alias-aware
 */

/**
 * Maps legacy `affine:*` block flavour strings to their canonical `myoxus:*`
 * equivalents. Used by AliasMap to provide transparent backward-compat.
 */
export const FLAVOUR_ALIAS_MAP: ReadonlyMap<string, string> = new Map([
  // Standard blocks (16)
  ["affine:page", "myoxus:page"],
  ["affine:note", "myoxus:note"],
  ["affine:paragraph", "myoxus:paragraph"],
  ["affine:list", "myoxus:list"],
  ["affine:code", "myoxus:code"],
  ["affine:divider", "myoxus:divider"],
  ["affine:callout", "myoxus:callout"],
  ["affine:image", "myoxus:image"],
  ["affine:attachment", "myoxus:attachment"],
  ["affine:bookmark", "myoxus:bookmark"],
  ["affine:database", "myoxus:database"],
  ["affine:latex", "myoxus:latex"],
  ["affine:frame", "myoxus:frame"],
  ["affine:surface-ref", "myoxus:surface-ref"],
  ["affine:edgeless-text", "myoxus:edgeless-text"],
  ["affine:table", "myoxus:table"],
  // Embed blocks (8)
  ["affine:embed-iframe", "myoxus:embed-iframe"],
  ["affine:embed-figma", "myoxus:embed-figma"],
  ["affine:embed-github", "myoxus:embed-github"],
  ["affine:embed-youtube", "myoxus:embed-youtube"],
  ["affine:embed-loom", "myoxus:embed-loom"],
  ["affine:embed-html", "myoxus:embed-html"],
  ["affine:embed-linked-doc", "myoxus:embed-linked-doc"],
  ["affine:embed-synced-doc", "myoxus:embed-synced-doc"],
  // Surface block (1)
  ["affine:surface", "myoxus:surface"],
]);

/**
 * Maps legacy surface ID strings to their canonical `myoxus:*` equivalents.
 * Surface IDs appear as discriminator strings inside Yjs Y.Map entries.
 */
export const SURFACE_ID_ALIAS_MAP: ReadonlyMap<string, string> = new Map([
  ["affine:surface:text", "myoxus:surface:text"],
  ["affine:surface:ymap", "myoxus:surface:ymap"],
]);

/**
 * A drop-in replacement for `Map<string, V>` that transparently resolves
 * alias keys on every `get()` and `has()` call.
 *
 * Lookup order:
 *   1. Direct key lookup (canonical `myoxus:*` key) — O(1), no overhead for
 *      new documents
 *   2. If miss: resolve alias via the provided alias map, lookup again — O(1)
 *
 * The alias map itself is never used as primary storage: `set()` always stores
 * under the key provided by the caller (which should be the canonical key).
 * This means:
 *   - New documents: `map.set('myoxus:paragraph', v)` / `map.get('affine:paragraph')` → v ✓
 *   - Direct lookup: `map.get('myoxus:paragraph')` → v ✓ (no alias overhead)
 *   - Unknown key: `map.get('unknown:foo')` → undefined ✓
 */
export class AliasMap<V> extends Map<string, V> {
  constructor(private readonly aliases: ReadonlyMap<string, string>) {
    super();
  }

  override get(key: string): V | undefined {
    return super.get(key) ?? super.get(this.aliases.get(key) ?? "");
  }

  override has(key: string): boolean {
    return super.has(key) || super.has(this.aliases.get(key) ?? "");
  }
}

/**
 * Resolves a possibly-legacy flavour string to its canonical `myoxus:*` form.
 * Returns the input unchanged if it is already canonical or unknown.
 *
 * @example
 *   resolveFlavour('affine:paragraph') // → 'myoxus:paragraph'
 *   resolveFlavour('myoxus:paragraph') // → 'myoxus:paragraph'
 *   resolveFlavour('custom:block')     // → 'custom:block'
 */
export function resolveFlavour(flavour: string): string {
  return FLAVOUR_ALIAS_MAP.get(flavour) ?? flavour;
}

/**
 * Reverse lookup: maps canonical `myoxus:*` flavour strings back to their
 * legacy `affine:*` aliases. Used by `getBlocksByFlavour` to include both
 * variants in the filter set so that blocks stored in older Yjs documents
 * (where `sys:flavour` is `"affine:*"`) are found by `"myoxus:*"` queries.
 */
export const REVERSE_FLAVOUR_ALIAS_MAP: ReadonlyMap<string, string> = new Map(
  Array.from(FLAVOUR_ALIAS_MAP.entries()).map(([legacy, canonical]) => [
    canonical,
    legacy,
  ]),
);

/**
 * Resolves a possibly-canonical flavour back to its legacy `affine:*` alias.
 * Returns the input unchanged if it has no legacy alias (i.e. is already legacy
 * or is a custom flavour not in the alias table).
 *
 * @example
 *   reverseResolveFlavour('myoxus:surface')   // → 'affine:surface'
 *   reverseResolveFlavour('affine:surface')   // → 'affine:surface' (unchanged)
 *   reverseResolveFlavour('custom:block')     // → 'custom:block'  (unchanged)
 */
export function reverseResolveFlavour(flavour: string): string {
  return REVERSE_FLAVOUR_ALIAS_MAP.get(flavour) ?? flavour;
}

/**
 * Resolves a possibly-legacy surface ID string to its canonical `myoxus:*` form.
 * Returns the input unchanged if it is already canonical or unknown.
 */
export function resolveSurfaceId(id: string): string {
  return SURFACE_ID_ALIAS_MAP.get(id) ?? id;
}

// =====================================================================
// P-VIRG-ARCH-F-01/02 — data-format compatibility layer
//
// Persisted markers (FLAVOUR_ALIAS_MAP and SURFACE_ID_ALIAS_MAP) and the
// derived legacy-plus-canonical lookups belong to a named compatibility
// layer. Before F-01, `getBlocksByFlavour` assembled a set from
// `f`/`canonical`/`legacy` inline, leaking a data-format concern into CRUD.
// With F-01/02, the Store delegates that concern to
// `expandFlavourVariants(...)`.
//
// **Contract:**
//   - Input: one or more canonical, legacy, or custom flavours.
//   - Output: every known variant, allowing `getBlocksByFlavour` to find
//     matches regardless of which form the Yjs document persisted.
//   - `Set` deduplicates automatically, so `[f, canonical, legacy]` ordering
//     is harmless.
//
// **Negative acceptance:** A request for `"affine:paragraph"` must return the
// same blocks as a direct `"myoxus:paragraph"` request when the document has
// persisted the canonical form. Removing `expandFlavourVariants` must break
// the owning compatibility test.
// =====================================================================

/**
 * Expands one or more flavours into every known variant (canonical, legacy,
 * and original). Used by `Store.getBlocksByFlavour` and
 * `Store.getModelsByFlavour`.
 *
 * @example
 *   expandFlavourVariants("myoxus:paragraph")
 *     // => Set(["myoxus:paragraph", "affine:paragraph"])
 *   expandFlavourVariants("affine:paragraph")
 *     // => Set(["affine:paragraph", "myoxus:paragraph"])
 *   expandFlavourVariants(["myoxus:note", "affine:database"])
 *     // => Set(["myoxus:note", "affine:note", "myoxus:database", "affine:database"])
 *   expandFlavourVariants("custom:block")
 *     // => Set(["custom:block"])  // no alias, no expansion
 */
export function expandFlavourVariants(flavour: string | string[]): Set<string> {
  const requested = typeof flavour === "string" ? [flavour] : flavour;
  const out = new Set<string>();
  for (const f of requested) {
    // 1. Preserve the original canonical, legacy, or custom form.
    out.add(f);
    // 2. Add the canonical form.
    const canonical = resolveFlavour(f);
    out.add(canonical);
    // 3. Add the legacy form; Set removes duplicates when it equals input.
    const legacy = reverseResolveFlavour(canonical);
    out.add(legacy);
  }
  return out;
}
