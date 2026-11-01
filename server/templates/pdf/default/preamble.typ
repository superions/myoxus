// SPDX-License-Identifier: AGPL-3.0-or-later
// MYOXUS_TEMPLATE_HANDLES_DIAGRAM_FIT
// MYOXUS_TEMPLATE_USES_TYPED_FLOW_TITLE
// Default preamble for the Myoxus PDF export.
// The shared flow renderer uses typed `title` for the visible heading, with
// the native rich title as its fallback. Metadata and filenames stay native.
//
// Expects the following bindings to be defined ahead of inclusion (the
// renderer emits them from IR + branding overrides):
//   #let doc-title       — string
//   #let doc-filename    — safe PDF filename derived from the document title
//   #let doc-author      — string
//   #let doc-keywords    — array of strings, or `none`
//   #let doc-date        — datetime, or `none`
//   #let paper           — string ("a4" | "us-letter" | "a5")
//   #let primary-color   — hex string ("#rrggbb")
//   #let accent          — hex string ("#rrggbb")
//   #let rule-color      — hex string for structural strokes
//   #let text-color      — hex string
//   #let bg-color        — hex string
//   #let code-background-color — server-theme code surface hex string
//   #let lang            — ISO 639-1 code (e.g. "en")
//   #let workspace-name  — string (may be empty)
//   #let brand-organization-name — string (may be empty)
//   #let brand-footer-text — string (may be empty)
//   #let brand-legal-text — string (may be empty)
//   #let brand-logo-small — virtual blob path, or empty
//   #let heading-font    — effective theme heading font tuple
//   #let body-font       — effective theme body font tuple
//   #let mono-font       — effective theme mono font tuple
//   #let symbol-font     — bounded ASCII marker font tuple
//   #let <role>-font-weight/style/size/leading/tracking
//                       — effective server-theme PDF typography metrics
//   #let pdf-check       — ASCII marker helper used for todo lists
//   #let ligatures-enabled — bool

// PDF metadata fields. `doc-keywords` is always an array (empty when
// the IR carried no keywords); `doc-date` is `none` when the IR has no
// `created_at`, in which case Typst leaves the PDF /CreationDate stamp
// at its default rather than auto-stamping today's date.
#set document(
  title: doc-title,
  author: doc-author,
  keywords: doc-keywords,
  date: doc-date,
)

#let running-version-label = "Version"

#let running-page-label = if lang == "de" {
  (current, total) => [Seite #current / #total]
} else {
  (current, total) => [Page #current / #total]
}

#let running-date = if doc-date == none {
  ""
} else if lang == "de" {
  doc-date.display("[day].[month].[year]")
} else {
  doc-date.display("[year]-[month]-[day]")
}

#let running-identity = if brand-footer-text != "" {
  brand-footer-text
} else if brand-legal-text != "" {
  brand-legal-text
} else if brand-organization-name != "" {
  brand-organization-name
} else {
  workspace-name
}

#set page(
  paper: paper,
  flipped: page-flipped,
  numbering: "1",
  margin: (top: 24mm, bottom: 22mm, x: 22mm),
  header: context {
    set text(
      font: body-font,
      weight: body-font-weight,
      style: body-font-style,
      size: running-header-size,
      tracking: body-tracking,
      fill: running-secondary-fill,
    )
    set par(leading: secondary-leading)
    grid(
      columns: (1fr, auto),
      gutter: 8mm,
      align: (left, right),
      text(fill: running-primary-fill, doc-filename),
      if doc-version != "" {
        [#running-version-label #doc-version]
      } else {
        []
      },
    )
    v(0.35em)
    line(length: 100%, stroke: running-rule-thickness + running-rule-fill)
  },
  footer: if footer-style == "none" { none } else { context {
    let page-format = if page-numbering == "roman" { "i" } else { "1" }
    if footer-style == "page-only" {
      if page-numbering != "none" { align(right, counter(page).display(page-format)) }
    } else {
    set text(
      font: body-font,
      weight: body-font-weight,
      style: body-font-style,
      size: running-footer-size,
      tracking: body-tracking,
      fill: running-secondary-fill,
    )
    set par(leading: secondary-leading)
    line(length: 100%, stroke: running-rule-thickness + running-rule-fill)
    v(0.35em)
    grid(
      columns: (auto, 1fr, auto),
      gutter: 8mm,
      align: (left, center, right),
      [#running-date],
      [#running-identity],
      if page-numbering == "none" { [] } else { running-page-label(
        counter(page).display(page-format),
        numbering(page-format, counter(page).final().first()),
      ) },
    )
    }
  }
  },
)

#let myoxus-fit-visual = myoxus-diagram-fitter(44mm, 46mm)

#set text(
  font: body-font,
  weight: body-font-weight,
  style: body-font-style,
  size: body-size,
  tracking: body-tracking,
  fill: rgb(text-color),
  ligatures: ligatures-enabled,
)
#set par(justify: true, leading: body-leading, spacing: body-paragraph-spacing)
#set list(spacing: body-list-spacing)
#set enum(spacing: body-list-spacing)
#set heading(numbering: none)

#show heading: it => {
  let scale = if it.level == 1 {
    0.8
  } else if it.level == 2 {
    0.7
  } else if it.level == 3 {
    0.6
  } else {
    0.55
  }
  set text(
    font: heading-font,
    weight: heading-font-weight,
    style: heading-font-style,
    size: heading-size * scale,
    tracking: heading-tracking,
    fill: rgb(primary-color),
  )
  set par(leading: heading-leading)
  it.body
}

#show raw: it => {
  set text(
    font: mono-font,
    weight: mono-font-weight,
    style: mono-font-style,
    size: mono-size,
    tracking: mono-tracking,
  )
  if it.block {
    set par(leading: mono-leading)
    block(
      width: 100%,
      fill: rgb(code-background-color),
      inset: 8pt,
      radius: 4pt,
      it,
    )
  } else {
    box(
      fill: rgb(code-background-color),
      inset: (x: 2pt, y: 0.5pt),
      radius: 2pt,
      it,
    )
  }
}

#show link: it => {
  // Monochrome links are reading content, not decorative accent strokes.
  set text(fill: rgb(if color-variant == "mono" { text-color } else { accent }))
  underline(it)
}

#if bg-color != "#ffffff" and bg-color != "#FFFFFF" {
  set page(fill: rgb(bg-color))
}

#set text(lang: lang)
