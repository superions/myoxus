// SPDX-License-Identifier: AGPL-3.0-or-later
// MYOXUS_TEMPLATE_HANDLES_DIAGRAM_FIT
// Preamble for the `report` PDF template.
//
// Expects the same dynamic bindings as the default template (emitted by the
// IR→Typst renderer ahead of inclusion):
//   #let doc-title       — string
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
//   #let lang            — ISO 639-1 code
//   #let workspace-name  — string (may be empty)
//   #let brand-footer-text — string (may be empty)
//   #let brand-legal-text — string (may be empty)
//   #let brand-logo-large — virtual blob path, or empty
//   #let brand-logo-small — virtual blob path, or empty
//   #let heading-font    — effective theme heading font tuple
//   #let body-font       — effective theme body font tuple
//   #let mono-font       — effective theme mono font tuple
//   #let symbol-font     — bounded ASCII marker font tuple
//   #let <role>-font-weight/style/size/leading/tracking
//                       — effective server-theme PDF typography metrics
//   #let pdf-check       — ASCII marker helper used for todo lists
//   #let ligatures-enabled — bool
//   #let toc-behavior    — string ("off" | "auto" | "force")
//   #let cover-page-enabled — bool, resolved from L3 input or template default
//   #let confidentiality-label — string, empty when no classification applies
//   #let template-title — optional report title override from typed_inputs
//   #let template-subtitle — optional cover subtitle from typed_inputs
//   #let template-executive-summary — optional pre-body summary paragraph
//   #let template-report-date — optional ISO date string from typed_inputs
//   #let template-author — optional report author from typed_inputs
//   #let template-confidentiality-label — optional typed_inputs label fallback
//
// The report adds:
//   • A branded cover page (title, optional subtitle/date/author)
//   • Branded header with accent rule + workspace name + page counter
//   • Brand-and-page footer
//   • Automatic table of contents after the cover page
//
// Template markers consumed by the Rust source generator:
// MYOXUS_TEMPLATE_HANDLES_TOC
// MYOXUS_TEMPLATE_DEFAULT_COVER_PAGE

// ── Document metadata ───────────────────────────────────────────────────────
#set document(
  title: doc-title,
  author: doc-author,
  keywords: doc-keywords,
  date: doc-date,
)

// ── Locale-aware labels ─────────────────────────────────────────────────────
#let report-toc-label = if lang == "de" {
  "Inhaltsverzeichnis"
} else if lang == "fr" {
  "Table des matières"
} else if lang == "es" or lang == "es-MX" {
  "Índice"
} else if lang == "it" {
  "Indice"
} else if lang == "pt" or lang == "pt-BR" {
  "Sumário"
} else {
  "Table of Contents"
}

#let page-of-label = if lang == "de" {
  (current, total) => [Seite #current / #total]
} else if lang == "fr" {
  (current, total) => [Page #current / #total]
} else if lang == "es" or lang == "es-MX" {
  (current, total) => [Página #current / #total]
} else if lang == "it" {
  (current, total) => [Pagina #current / #total]
} else if lang == "pt" or lang == "pt-BR" {
  (current, total) => [Página #current / #total]
} else {
  (current, total) => [Page #current / #total]
}

#let executive-summary-label = if lang == "de" {
  "Zusammenfassung"
} else if lang == "fr" {
  "Synthèse"
} else if lang == "es" or lang == "es-MX" {
  "Resumen ejecutivo"
} else if lang == "it" {
  "Sintesi"
} else if lang == "pt" or lang == "pt-BR" {
  "Resumo executivo"
} else {
  "Executive Summary"
}

#let report-title = if template-title != "" {
  template-title
} else {
  doc-title
}
#let report-author = if template-author != "" {
  template-author
} else {
  doc-author
}
#let report-date-text = if template-report-date != "" {
  template-report-date
} else if doc-date != none {
  doc-date.display("[year]-[month]-[day]")
} else {
  ""
}
#let report-confidentiality-label = if confidentiality-label != "" {
  confidentiality-label
} else {
  template-confidentiality-label
}

// ── Page setup with branded header + footer ─────────────────────────────────
#set page(
  paper: paper,
  flipped: page-flipped,
  numbering: "1",
  margin: (top: 28mm, bottom: 28mm, x: 22mm),
  header: context {
    set text(font: body-font, size: secondary-body-size, weight: body-font-weight,
      style: body-font-style, tracking: body-tracking, fill: header-text-fill)
    set par(leading: secondary-leading)
    grid(
      columns: (1fr, auto),
      align: (left, right),
      if brand-logo-small != "" {
        image(brand-logo-small, height: 6mm)
      } else if workspace-name != "" {
        [#workspace-name]
      } else {
        []
      },
      [#counter(page).display()],
    )
    v(-0.4em)
    line(length: 100%, stroke: header-rule-thickness + rgb(primary-color))
  },
  footer: if footer-style == "none" { none } else { context {
    let page-format = if page-numbering == "roman" { "i" } else { "1" }
    if footer-style == "page-only" {
      if page-numbering != "none" { align(right, counter(page).display(page-format)) }
    } else {
    set text(font: body-font, size: secondary-body-size, weight: body-font-weight,
      style: body-font-style, tracking: body-tracking, fill: header-text-fill)
    set par(leading: secondary-leading)
    line(length: 100%, stroke: footer-rule-thickness + structural-stroke)
    v(0.3em)
    grid(
      columns: (1fr, auto, auto),
      gutter: 8mm,
      align: (left, right),
      if brand-footer-text != "" {
        [#brand-footer-text]
      } else if brand-legal-text != "" {
        [#brand-legal-text]
      } else if workspace-name != "" {
        [#workspace-name]
      } else {
        []
      },
      if report-confidentiality-label != "" {
        text(size: compact-body-size, weight: "bold", fill: rgb(primary-color), report-confidentiality-label)
      } else {
        []
      },
      if page-numbering == "none" { [] } else { page-of-label(
        counter(page).display(page-format),
        numbering(page-format, counter(page).final().first()),
      ) },
    )
    }
  }
  },
)

#let myoxus-fit-visual = myoxus-diagram-fitter(44mm, 56mm)

#set text(
  font: body-font,
  weight: body-font-weight,
  style: body-font-style,
  size: body-size,
  tracking: body-tracking,
  fill: rgb(text-color),
  lang: lang,
  ligatures: ligatures-enabled,
)
#set par(justify: true, leading: body-leading, spacing: body-paragraph-spacing)
#set list(spacing: body-list-spacing)
#set enum(spacing: body-list-spacing)
#set heading(numbering: "1.1")

#show heading.where(level: 1): it => {
  set text(fill: rgb(primary-color))
  it
}
#show heading.where(level: 2): it => {
  set text(fill: rgb(accent))
  it
}
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
  )
  set par(leading: heading-leading)
  it
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
  set text(fill: rgb(accent))
  underline(it)
}

#if bg-color != "#ffffff" and bg-color != "#FFFFFF" {
  set page(fill: rgb(bg-color))
}

// ── Cover page ──────────────────────────────────────────────────────────────
#if cover-page-enabled {
  set page(header: none, footer: none, numbering: none)
  set par(justify: false)
  set align(left + horizon)
  block(
    width: 100%,
    inset: (x: 0pt, y: 0pt),
    [
      #if brand-logo-large != "" {
        image(brand-logo-large, height: 16mm)
        v(1em)
      }
      #if workspace-name != "" {
        text(size: cover-meta-size, fill: header-text-fill, workspace-name)
        v(0.5em)
      }
      #text(
        font: heading-font,
        size: cover-title-size,
        weight: heading-font-weight,
        style: heading-font-style,
        tracking: heading-tracking,
        fill: rgb(primary-color),
        myoxus-heading-string(report-title),
      )
      #if template-subtitle != "" {
        v(0.5em)
        text(size: cover-subtitle-size, fill: rgb(text-color), myoxus-body-string(template-subtitle))
      }
      #v(0.6em)
      #line(length: 40%, stroke: cover-rule-thickness + rgb(primary-color))
      #v(2em)
      #if report-confidentiality-label != "" {
        text(size: cover-meta-size, weight: "bold", fill: rgb(primary-color), report-confidentiality-label)
        v(1em)
      }
      #if report-author != "" {
        text(size: cover-subtitle-size, weight: "regular", report-author)
        linebreak()
      }
      #if report-date-text != "" {
        text(size: cover-meta-size, fill: header-text-fill, report-date-text)
      }
    ],
  )
  pagebreak()
}

// ── Table of contents ───────────────────────────────────────────────────────
#if toc-behavior != "off" {
  heading(level: 1, numbering: none, outlined: false, report-toc-label)
  outline(title: none, depth: 3, indent: auto)
  pagebreak()
}

// ── Optional executive summary from template typed_inputs ──────────────────
#if template-executive-summary != "" {
  block(
    width: 100%,
    inset: (x: 10pt, y: 8pt),
    stroke: (left: 3pt + rgb(primary-color)),
    fill: neutral-surface-fill,
    [
      #set par(justify: false)
      #text(
        font: heading-font,
        size: heading-size * 0.6,
        weight: heading-font-weight,
        style: heading-font-style,
        tracking: heading-tracking,
        fill: rgb(primary-color),
        executive-summary-label,
      )
      #v(0.45em)
      #template-executive-summary
    ],
  )
  v(1em)
}

// ── Body follows (emitted by the IR→Typst renderer) ─────────────────────────
