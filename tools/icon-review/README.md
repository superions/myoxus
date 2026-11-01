# Myoxus Icon Review Tool

This internal desktop-only tool preserves the interactive review workflow for
ambiguous Myoxus-to-Tabler glyph mappings. It is not a product route and must
not be shipped in the Web or Admin frontend.

From the repository root, first generate the current icon artifacts and then
start the review server:

```bash
yarn workspace @virgultum/icons build
yarn icons:review
```

Open `http://127.0.0.1:4177/`. Set `MYOXUS_ICON_REVIEW_PORT` to use a different
local port.

The server derives the remaining rows from the three committed mapping inputs:

- `virgultum/icons/src/mappings/tabler-top-200.json`
- `virgultum/icons/src/mappings/tabler-obvious.json`
- `virgultum/icons/src/mappings/tabler-open-review.json`

Review feedback is autosaved to
`output/icon-review/tabler-decisions-open-remaining.json`. The `output/`
directory is intentionally ignored because it contains local review state and
screenshots. Promote completed decisions into the committed mapping with:

```bash
yarn workspace @virgultum/icons mapping:promote-open-review \
  output/icon-review/tabler-decisions-open-remaining.json
```

After promotion, regenerate and verify both public icon tiers:

```bash
yarn workspace @virgultum/icons mapping:obvious
yarn workspace @virgultum/icons build
yarn workspace @myoxus/icons generate:ui
yarn lint:icons
```

The server exposes only `127.0.0.1`, renders the current Myoxus glyph next to
the proposed Tabler glyph, accepts a replacement Tabler component name, and
records `accept`, `change`, `keep`, `custom`, or `remove` decisions.
