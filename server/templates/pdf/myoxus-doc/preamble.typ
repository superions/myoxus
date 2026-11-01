// SPDX-License-Identifier: AGPL-3.0-or-later
// MYOXUS_TEMPLATE_HANDLES_TOC
// MYOXUS_TEMPLATE_DEFAULT_COVER_PAGE
// MYOXUS_TEMPLATE_HANDLES_DIAGRAM_FIT
// This adapter receives the ordinary renderer bindings; no document content is embedded.
#import "vendor/ilm.typ": ilm
#let labels = json("i18n/" + lang + ".json")
#let documentation-title = if template-title != "" { template-title } else { doc-title }
#let documentation-author = if template-author != "" { template-author } else { doc-author }
#let documentation-date = if template-report-date != "" {
  let parts = template-report-date.split("-").map(int)
  datetime(year: parts.at(0), month: parts.at(1), day: parts.at(2))
} else { doc-date }
#set document(title: documentation-title, author: documentation-author, keywords: doc-keywords, date: documentation-date)

#let documentation-cover = if cover-page-enabled {
  align(left + horizon)[
    #set par(justify: false, leading: heading-leading)
    #if brand-logo-large != "" { image(brand-logo-large, height: 16mm); v(1em) }
    #if workspace-name != "" { text(size: body-size, workspace-name); v(1em) }
    #text(font: heading-font, size: documentation-title-size, weight: heading-font-weight,
      style: heading-font-style, tracking: heading-tracking, fill: rgb(primary-color), myoxus-heading-string(documentation-title))
    #if template-subtitle != "" { v(0.7em); text(size: documentation-subtitle-size, myoxus-body-string(template-subtitle)) }
    #v(1em)
    #line(length: 40%, stroke: 1pt + rgb(accent))
    #v(2em)
    #if documentation-author != "" { text(documentation-author); linebreak() }
    #if documentation-date != none { documentation-date.display("[year]-[month]-[day]") }
  ]
} else { none }

#let documentation-toc = if toc-behavior != "off" {
  context {
    if toc-behavior == "force" or query(heading.where(outlined: true)).len() >= 2 {
      outline(title: labels.toc_heading, depth: 3, indent: auto)
      pagebreak()
    }
  }
} else { none }

#let documentation-footer = if footer-style == "none" { none } else { context {
  set text(size: documentation-secondary-size, fill: secondary-text-fill)
  set par(justify: false, leading: secondary-leading)
  let previous = query(heading.where(level: 1).before(here()))
  let chapter = if previous.len() > 0 { previous.last().body } else { [] }
  let number = if page-numbering == "none" { [] } else {
    [#labels.page_label #counter(page).display(if page-numbering == "roman" { "i" } else { "1" })]
  }
  if footer-style == "page-only" {
    align(right, number)
  } else {
  line(length: 100%, stroke: 0.4pt + rgb(rule-color))
  v(0.3em)
  grid(columns: (1fr, 1fr, auto), gutter: 1em,
    if brand-footer-text != "" { brand-footer-text } else { documentation-title },
    align(center, chapter),
    number,
  )
  }
} }

#let myoxus-fit-visual = myoxus-diagram-fitter(50mm, 50.5mm)

#let documentation-body(body) = {
  // Preserve the source headings; ilm must not add a second numbering scheme.
  set heading(numbering: none)
  set figure(numbering: none)
  // Leave room for a wrapped document identity in the running footer.
  set page(margin: (top: 22.5mm, bottom: 28mm, x: 25mm), footer-descent: 20%)
  // Syntax highlighting would introduce an unrelated fixed color palette.
  set raw(theme: none)
  show heading: it => {
    let scale = if it.level == 1 { 0.8 } else if it.level == 2 { 0.7 } else { 0.6 }
    set text(font: heading-font, size: heading-size * scale, weight: heading-font-weight,
      style: heading-font-style, tracking: heading-tracking, fill: rgb(primary-color))
    set par(leading: heading-leading, justify: false)
    it
  }
  show raw: set text(font: mono-font, size: mono-size, weight: mono-font-weight,
    style: mono-font-style, tracking: mono-tracking)
  show raw.where(block: true): set par(leading: mono-leading)
  show link: it => text(fill: rgb(text-color), underline(it))
  body
}

#show: body => ilm(
  title: documentation-title,
  authors: documentation-author,
  date: documentation-date,
  cover-page: documentation-cover,
  table-of-contents: documentation-toc,
  paper-size: paper,
  page-style: (flipped: page-flipped, fill: rgb(bg-color)),
  // Discretionary and literal hyphens can share a font glyph and PDF Unicode map.
  // Keep source punctuation intact by breaking body text only between words.
  text-style: (hyphenate: false, font: body-font, size: body-size, weight: body-font-weight,
    style: body-font-style, tracking: body-tracking, fill: rgb(text-color),
    lang: lang, ligatures: ligatures-enabled),
  paragraph-style: (leading: body-leading, spacing: body-paragraph-spacing, justify: true),
  raw-text: (font: mono-font, size: mono-size, weight: mono-font-weight,
    style: mono-font-style, tracking: mono-tracking),
  stroke-color: rgb(rule-color),
  fill-color: rgb(code-background-color),
  footer: documentation-footer,
  // Keep the ordinary IR document title with its first chapter.
  chapter-pagebreak: false,
  external-link-circle: false,
  documentation-body(body),
)
