// SPDX-License-Identifier: AGPL-3.0-or-later
// Theme tokens for the `letter` PDF template (DIN-5008-konform).

// ── Callouts (parity with default) ──────────────────────────────────────────
#let callout-info-fill = bg-color
#let callout-info-stroke = accent
#let callout-warn-fill = bg-color
#let callout-warn-stroke = accent
#let callout-note-fill = bg-color
#let callout-note-stroke = accent
#let callout-tip-fill = bg-color
#let callout-tip-stroke = accent

// ── Block frames (parity with default) ──────────────────────────────────────
#let header-text-fill = secondary-text-fill
#let table-header-fill = strong-neutral-surface-fill
#let table-caption-fill = secondary-text-fill
#let blockquote-stroke = structural-stroke
#let embed-card-stroke = structural-stroke
#let attachment-stroke = structural-stroke
#let unknown-block-fill = secondary-text-fill
#let aichat-fill = neutral-surface-fill
#let snapshot-placeholder-fill = strong-neutral-surface-fill

// ── DIN-5008 layout tokens ──────────────────────────────────────────────────
// All offsets are measured from the physical page edge (top: 0, left: 0).
// Values follow DIN 5008 Form B (the more common variant: 45mm address window
// top, 85mm wide × 45mm tall; matches DL/C5/C6 window envelopes).
#let din-address-block-top    = 45mm
#let din-address-block-left   = 25mm
#let din-address-block-width  = 85mm
#let din-address-block-height = 45mm

// Faltmarken (fold marks) — small horizontal lines printed at the left edge
// at 105mm (first fold) and 210mm (second fold) from the top. Allows the
// letter to be folded into a DL window envelope.
#let din-first-fold-y  = 105mm
#let din-second-fold-y = 210mm

// Lochmarke (hole-punch mark) at 148.5mm — half-page height for two-hole
// punching aligned to DIN-A4 binding.
#let din-punch-mark-y = 148.5mm

// Reference subject line (Betreffzeile) starts at the top of the body area.
#let letter-subject-spacing = 1.0em
#let letter-salutation-spacing = 1.2em
