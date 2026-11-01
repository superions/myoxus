// SPDX-License-Identifier: AGPL-3.0-or-later
// MYOXUS_TEMPLATE_HANDLES_DIAGRAM_FIT
// Preamble for the `letter` PDF template (DIN-5008-konform).
//
// Expects the same dynamic bindings the IR→Typst renderer emits ahead of
// inclusion (see report/preamble.typ for the full list), including the
// global-theme font roles `heading-font`, `body-font`, `mono-font`,
// `symbol-font` plus their `font-weight`, `font-style`, `size`, `leading` and
// `tracking` metrics, document-branding bindings (`brand-footer-text`,
// `brand-logo-small`, `primary-color`), the server-theme
// `code-background-color` and the todo-list helper `pdf-check`.
//
// The letter template implements DIN 5008 Form B:
//   • Anschriftenfeld (address block) at 45mm from top, 85mm × 45mm
//   • Faltmarken (fold marks) at 105mm and 210mm in portrait orientation
//   • Lochmarke (hole-punch mark) at 148.5mm in portrait orientation
//   • German default locale, no cover page, no TOC
//
// L3 typed_inputs are propagated as renderer bindings:
//   #let template-recipient-name — recipient_name string
//   #let template-recipient-address — recipient_address line array
//   #let template-subject-line — subject_line string
//   #let template-salutation — optional salutation string
//   #let template-closing — optional closing string
//   #let template-sender-name — optional sender_name string
//   #let template-letter-date — optional ISO date string

// ── Document metadata ───────────────────────────────────────────────────────
#set document(
  title: doc-title,
  author: doc-author,
  keywords: doc-keywords,
  date: doc-date,
)

// ── Locale-aware footer label ───────────────────────────────────────────────
#let page-of-label = if lang == "en" {
  (current, total) => [Page #current / #total]
} else if lang == "fr" {
  (current, total) => [Page #current / #total]
} else if lang == "es" or lang == "es-MX" {
  (current, total) => [Página #current / #total]
} else if lang == "it" {
  (current, total) => [Pagina #current / #total]
} else if lang == "pt" or lang == "pt-BR" {
  (current, total) => [Página #current / #total]
} else {
  // Default (de) and any other locale: German label.
  (current, total) => [Seite #current / #total]
}

#let salutation-default = if lang == "en" {
  "Dear Sir or Madam,"
} else if lang == "fr" {
  "Madame, Monsieur,"
} else if lang == "es" or lang == "es-MX" {
  "Estimadas señoras y señores:"
} else if lang == "it" {
  "Gentili signore e signori,"
} else if lang == "pt" or lang == "pt-BR" {
  "Prezadas senhoras e senhores,"
} else {
  "Sehr geehrte Damen und Herren,"
}

#let closing-default = if lang == "en" {
  "Yours sincerely,"
} else if lang == "fr" {
  "Cordialement,"
} else if lang == "es" or lang == "es-MX" {
  "Atentamente,"
} else if lang == "it" {
  "Cordiali saluti,"
} else if lang == "pt" or lang == "pt-BR" {
  "Atenciosamente,"
} else {
  "Mit freundlichen Grüßen"
}

#let letter-date-text = if template-letter-date != "" {
  template-letter-date
} else if doc-date != none {
  doc-date.display("[day].[month].[year]")
} else {
  ""
}

// ── DIN-5008 page setup ─────────────────────────────────────────────────────
// Margins per DIN 5008: left 25mm, right 20mm, top 45mm (above which only
// the sender's reference line lives), bottom 25mm. The address block lives
// inside the top margin via a background placement.
#set page(
  paper: paper,
  flipped: page-flipped,
  numbering: "1",
  margin: (left: 25mm, right: 20mm, top: 45mm, bottom: 25mm),
  // DIN folding and punch marks only describe the portrait sheet geometry.
  background: if page-flipped { none } else { place(top + left, [
    // Faltmarken at left edge, 5mm long.
    #place(top + left, dx: 5mm, dy: din-first-fold-y, line(length: 5mm, stroke: 0.3pt + luma(150)))
    #place(top + left, dx: 5mm, dy: din-second-fold-y, line(length: 5mm, stroke: 0.3pt + luma(150)))
    // Lochmarke at left edge, 5mm long.
    #place(top + left, dx: 5mm, dy: din-punch-mark-y, line(length: 5mm, stroke: 0.3pt + luma(150)))
  ]) },
  footer: if footer-style == "none" { none } else { context {
    let page-format = if page-numbering == "roman" { "i" } else { "1" }
    if footer-style == "page-only" {
      if page-numbering != "none" { align(right, counter(page).display(page-format)) }
    } else {
    set text(font: body-font, size: secondary-body-size, weight: body-font-weight,
      style: body-font-style, tracking: body-tracking, fill: header-text-fill)
    set par(leading: secondary-leading)
    grid(
      columns: (1fr, auto),
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
      if page-numbering == "none" { [] } else { page-of-label(
        counter(page).display(page-format),
        numbering(page-format, counter(page).final().first()),
      ) },
    )
    }
  }
  },
)

#let myoxus-fit-visual = myoxus-diagram-fitter(45mm, 70mm)

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
#set par(justify: false, leading: body-leading, spacing: body-paragraph-spacing, first-line-indent: 0pt)
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

// ── Sender reference line (above the address window) ────────────────────────
// DIN 5008 places a small sender-line above the address block; we render it
// as the small document logo when present, otherwise workspace-name.
#{
  if brand-logo-small != "" or workspace-name != "" {
    let sender-mark = if brand-logo-small != "" {
      image(brand-logo-small, height: 5mm)
    } else {
      text(size: compact-body-size, fill: header-text-fill, workspace-name)
    }
    place(
      top + left,
      dx: din-address-block-left,
      dy: 27mm,
      block(
        width: din-address-block-width,
        sender-mark + h(1fr) + line(length: 100%, stroke: 0.3pt + luma(180)),
      ),
    )
  }
}

// ── Address window from template typed_inputs ───────────────────────────────
#{
  if template-recipient-name != "" or template-recipient-address.len() > 0 {
    place(
      top + left,
      dx: din-address-block-left,
      dy: din-address-block-top,
      block(
        width: din-address-block-width,
        height: din-address-block-height,
        inset: (x: 0pt, y: 3mm),
        [
          #if template-recipient-name != "" {
            strong(template-recipient-name)
            linebreak()
          }
          #for line in template-recipient-address {
            line
            linebreak()
          }
        ],
      ),
    )
  }
}

// ── Document date in upper-right (typed input overrides metadata) ───────────
#{
  if letter-date-text != "" {
    place(
      top + right,
      dx: -20mm,
      dy: 50mm,
      text(size: body-meta-size, letter-date-text),
    )
  }
}

// ── Letter framing around the generated body ───────────────────────────────
// The Rust renderer appends only the document body after this preamble. A
// Typst show rule is therefore the template-level extension point that can
// place subject/salutation before, and closing/sender after, the generated
// body without requiring a second renderer pass.
#show: letter-body => {
  // Keep the generated subject/body flow below the absolutely placed
  // address window. The extra clearance prevents long three-line addresses
  // from colliding with the subject in browser PDF viewers and printed output.
  v(75mm)

  if template-subject-line != "" {
    text(weight: "bold", myoxus-heading-string(template-subject-line))
    v(letter-subject-spacing)
  }

  let salutation-text = if template-salutation != "" {
    template-salutation
  } else {
    salutation-default
  }
  if salutation-text != "" {
    myoxus-body-string(salutation-text)
    v(letter-salutation-spacing)
  }

  letter-body

  let closing-text = if template-closing != "" {
    template-closing
  } else {
    closing-default
  }
  if closing-text != "" or template-sender-name != "" {
    v(1.6em)
    if closing-text != "" {
    myoxus-body-string(closing-text)
      linebreak()
    }
    if template-sender-name != "" {
      v(1.8em)
      template-sender-name
    }
  }
}

// ── Body follows (emitted by the IR→Typst renderer) ─────────────────────────
