# Virgultum Icons Provenance

`@virgultum/icons` is the generated low-level icon boundary for the Virgultum
editor and Myoxus clients.

## License

The generator, remaining Myoxus source geometry, generated facade code, and
keyword metadata in this package are licensed under `AGPL-3.0-or-later`.
Reviewed Tabler SVG geometry embedded in the generated React and Lit artifacts
is licensed under the Tabler MIT license recorded in
`THIRD_PARTY_LICENSES.md`.

The non-exported comparison artifact contains attributed Phosphor and Tabler
renderings under their MIT licenses.

## Source Of Truth

- `src/icon-names.json` preserves the public export surface expected by existing editor code.
- `src/mappings/tabler-top-200.json` is the reviewed semantic mapping
  consumed by the generator. It currently normalizes 200 reviewed public
  exports to 197 unique glyph names.
- `src/text-glyphs.inter.json` contains committed static artwork paths for
  typographic UI marks such as heading levels, bold/italic/underline,
  quotes, code symbols, and numbered-list digits. The paths are extracted from
  the bundled Inter variable fonts at `wght=700`; they are icon artwork, not a
  redistributed font or a runtime font dependency.
- `scripts/build-icons.mjs` contains the original geometric icon grammar and
  the semantic quality contracts that keep product icons recognizable.
- `scripts/extract-text-glyphs.py` is a maintenance helper for regenerating
  `src/text-glyphs.inter.json` from the local font files. It is intentionally
  not part of the normal build path so icon builds stay deterministic and do
  not require Python/fontTools.
- `dist/` is generated and must match `yarn workspace @virgultum/icons build`.

## Quality Gate

The generator must protect both existence and meaning. Critical glyphs are
covered by semantic SVG-marker checks, and direction/state families are covered
by distinctness checks so broad name rules cannot collapse icons such as import
vs. export, unchecked vs. checked, or text-left vs. generic type into the same
shape.

UI glyph output is intentionally monochrome. The generator may keep historical
`*DuotoneIcon` export names, but generated React/Lit components must not contain
grey `opacity` layers or Duotone backgrounds; all schematic UI icons render as
single-`currentColor` geometry.

Text-like glyphs must use the committed typographic path table instead of
hand-drawn pseudo-letter or seven-segment geometry. This rule covers heading
numbers, format controls, quote/code marks, and numbered-list digits. It keeps
small-size rendering closer to real typography and avoids malformed symbols.

The bundled Inter source fonts remain under the SIL Open Font License in
`server/static/fonts/`. The extracted icon paths are static UI artwork generated
through the font-design process and are distributed as part of this AGPL icon
package.

Every geometry change must be followed by:

```bash
yarn workspace @virgultum/icons build
yarn workspace @virgultum/icons check
yarn workspace @virgultum/icons gallery --out /tmp/myoxus-complete-icon-set.html
rg -n "opacity" dist
```

Visual QA should render the full export surface at large, sidebar, and compact
sizes before generated artifacts are accepted. The review uses exactly three
categories: `fix` for blocking visual/semantic defects, `review` for
context-sensitive but legible glyphs, and `ok` for accepted glyphs.

When glyph readability is disputed, compare against the strongest open-source
React/SVG icon references for metaphor and spacing. External packages remain
generator or review inputs; product and editor code must not import them
directly.

The retained historical Top-50 comparison records Phosphor and Tabler renderings,
source counts, semantic mappings and package versions. Its standalone HTML keeps
the MIT notices. The temporary generator and Phosphor dependency were removed
after the Tabler selection; current usage analysis and Tabler review remain.
Product and editor code must not import external icon packages.

The 2026-07-17 review selected Tabler. The generator materializes the reviewed
Top-200, obvious and open-review mappings in the React and Lit outputs; explicit
Myoxus fallbacks remain with their existing geometry. `@tabler/icons-react`
remains a pinned build-time input, not a product runtime dependency. The current
mapping inventory is documented in `docs/dev/myoxus-icon-system.md`.

## Legacy Block

This package no longer vendors or downloads `@blocksuite/icons`. The old re-vendor scripts
were removed. The guard `yarn workspace @virgultum/icons check:legacy` fails if the package,
build scripts, lockfile, CI workflows, or source icon names reintroduce the legacy icon package,
fetch flow, or removed product-icon export names.

The product icon is exported as `MyoxusIcon` and generated from the repo-owned
Bilch mascot source in `assets/branding/myoxus_mascot.svg` as original
AGPL-licensed vector geometry. Compatibility aliases for the removed product
icon name and removed abstract line-mark geometry are not allowed.
