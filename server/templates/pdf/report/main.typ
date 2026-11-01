// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point for the `report` template bundle.
//
// The IR→Typst renderer prepends the dynamic `#let` bindings (doc-title,
// accent, lang, …) and then concatenates `theme.typ` + `preamble.typ` +
// the rendered body. `main.typ` exists to satisfy the V2 manifest's
// `entry` field and provides a fallback wrapper when the renderer drives
// the bundle through a future V2 pipeline that compiles `entry` directly.

#include "theme.typ"
#include "preamble.typ"
