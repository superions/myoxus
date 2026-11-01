// SPDX-License-Identifier: AGPL-3.0-or-later
// Theme tokens for the `report` PDF template.
//
// Mirrors the default template's callout palette but adds report-specific
// tokens for the cover page, branded header rule, and TOC styling.

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

// ── Report-specific tokens ──────────────────────────────────────────────────
#let cover-rule-thickness    = 2pt
#let header-rule-thickness   = 0.6pt
#let footer-rule-thickness   = 0.4pt
#let cover-meta-size = body-meta-size
