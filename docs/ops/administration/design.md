<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Admin appearance and branding

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

This runbook describes the operator-facing Admin Design surfaces backed by the
server-owned Theme database. Runtime appearance
configuration is stored in typed theme/branding tables and exposed through the
existing AdminRoot GraphQL surface.

<details>
<summary>On this page</summary>

- [Active model](#active-model)
- [Operator workflow](#operator-workflow)
- [Verification](#verification)
- [Failure modes](#failure-modes)

</details>

## Active model

The active appearance model is:

- `theme_profiles` selects the effective theme and display mode.
- `themes` combine one `color_schemas` row with one `typography_sets` row.
- `color_schema_values` stores light/dark color token values.
- `typography_styles` stores semantic style rows keyed by `style_key`.
- `font_families` and `font_assets` define selectable UI/PDF font coverage.

## Operator workflow

1. Open `/adminfrontend/design`.
2. Pick a city theme in the overview gallery.
3. Choose the display mode: light, dark, or system.
4. Adjust colors in the Colors tab if the preset needs tenant-specific changes.
5. Configure logo, product mark, and the favicon pack in the Branding tab.
6. Open `/adminfrontend/typography` to inspect editor/PDF font roles and asset
   coverage in its Editor-Fonts tab. Font Library and uploaded font add-ons live there,
   not on the Design or PDF-Export pages.
7. Open `/adminfrontend/typography` to adjust typography styles. The page saves
   typed `typography_styles` patches through `admin.setTypographyStyles`.
8. Refresh Admin and Web clients to verify the server-emitted runtime CSS.

Typography uses `admin.themeCatalog.fontFamilies` for font selectors and
validates selectable fonts server-side before saving. It does not write
`branding.typography_tokens` and does not use `/api/fonts` as a private editor
manifest. No external font CDN is used.

Hierarchy, Body and Inline share a draft and Save/Cancel actions. Native tabs
retain unsaved values; Cancel restores the latest server baseline and returns
focus to the first editor disclosure, even when its fields are collapsed.
Empty numeric drafts remain visible and block Save rather than becoming zero.
The preview keeps the last valid numeric value until entry is completed.
Styles owns its own filtered draft and Save/Cancel actions; saving those rows
does not discard unsaved values in the guided tabs. Failed writes retain drafts
and show the error at the owning editor. Controls remain locked through readback.

The same editor is embedded below Workspace typography in workspace Appearance.
Its heading precedes its native tabs. Those writes target only the selected
workspace; changing the workspace starts that workspace's own draft. Global
and workspace changes both use `admin.setTypographyStyles`, not local presets.

Workspace appearance shows inheritance only after the catalog and both the
workspace/global profiles have loaded. A load error offers Retry without
selecting a fallback preset or writing an override. Existing color/typography
drafts stay mounted during read recovery; editing is disabled until the current
profiles are available again. An unchanged readback preserves unsaved colors;
Reset explicitly discards the color draft. Preset selection and Inherit global
profile cannot overlap while their write and readback are pending.

Favicon packs are uploaded through the same authenticated branding upload
endpoint as logos. The ZIP must contain `favicon-32.png`, `favicon-36.png`,
`favicon-48.png`, `favicon-72.png`, `favicon-96.png`, `favicon-144.png`, and
`favicon-192.png`; the server validates PNG dimensions before publishing the
files atomically.

The Branding tab separates organisation identity used by document branding and
legal metadata from app/server logo, product-mark and favicon assets. Identity
uses its own Save/Cancel actions; asset uploads do not save or discard an
identity draft. Switching Design tabs preserves that draft. Cancel restores
the last server values and returns focus to Display name. Save failures retain
the draft and remain visible at the identity form. Its controls stay locked
until the mutation and authoritative readback finish.

Each asset slot uploads independently and remains disabled through readback.
The light/dark samples and seven favicon sizes show actual server-owned assets;
an upload error leaves the previous preview in place. Identity Save does not
publish app assets or workspace document-branding overrides.

## Verification

After saving, reload `/api/branding/theme.css` and verify its response is not
cached from the prior revision. Open Web and Admin in the selected theme and
check navigation, dialogs, form states and editor content. When typography or
font assets changed, render a representative PDF as well. Review browser and
API errors and retain the previous theme values until every consuming surface
passes.

## Failure modes

- Theme changes do not appear after saving: reload `/api/branding/theme.css` and
  check that the effective theme profile points at the selected theme.
- Typography changes do not appear: verify that `admin.setTypographyStyles`
  succeeded, the effective theme profile points at the cloned/unlocked
  typography set and `/api/branding/theme.css` contains the expected
  `--myoxus-font-*` variables.
- Unexpected preset labels appear: compare the served `/info` revision with
  the selected frontend artifact, then reload the theme catalog. A mismatch
  means the served Admin bundle is stale; redeploy or roll back the complete
  matched frontend artifact instead of editing theme rows.
- Favicon upload fails: verify that the ZIP contains exactly the required
  favicon PNG sizes and does not exceed the 1 MiB hard cap.
