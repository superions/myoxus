// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared Myoxus adapter for the pinned Touying presentation layouts.

#import "../touying/0.7.4/lib.typ": *
#import "../touying/0.7.4/themes/simple.typ": simple-theme, title-slide
#import "../touying/0.7.4/themes/metropolis.typ" as metropolis
#import "../touying/0.7.4/themes/dewdrop.typ" as dewdrop

// Typst modules have isolated scopes. The template preamble therefore passes
// renderer bindings explicitly instead of coupling this shared module to a
// particular generated source order.
#let myoxus-presentation(settings, body) = {
  let doc-title = settings.at("doc-title")
  let doc-author = settings.at("doc-author")
  let template-title = settings.at("template-title")
  let template-subtitle = settings.at("template-subtitle")
  let template-author = settings.at("template-author")
  let template-report-date = settings.at("template-report-date")
  let brand-organization-name = settings.at("brand-organization-name")
  let brand-logo-large = settings.at("brand-logo-large")
  let cover-page-enabled = settings.at("cover-page-enabled")
  let toc-behavior = settings.at("toc-behavior")
  let footer-style = settings.at("footer-style")
  let page-numbering = settings.at("page-numbering")
  let layout = settings.at("layout")
  let myoxus-page-width = settings.at("myoxus-page-width")
  let myoxus-page-height = settings.at("myoxus-page-height")
  let body-font = settings.at("body-font")
  let body-font-weight = settings.at("body-font-weight")
  let body-font-style = settings.at("body-font-style")
  let body-tracking = settings.at("body-tracking")
  let body-size = settings.at("body-size")
  let body-leading = settings.at("body-leading")
  let heading-font = settings.at("heading-font")
  let heading-font-weight = settings.at("heading-font-weight")
  let heading-font-style = settings.at("heading-font-style")
  let heading-tracking = settings.at("heading-tracking")
  let heading-size = settings.at("heading-size")
  let mono-font = settings.at("mono-font")
  let text-color = settings.at("text-color")
  let bg-color = settings.at("bg-color")
  let accent = settings.at("accent")
  let secondary-text-fill = settings.at("secondary-text-fill")
  let structural-stroke = settings.at("structural-stroke")
  let neutral-surface-fill = settings.at("neutral-surface-fill")
  let toc-heading = settings.at("toc-heading")
  let continuation-label = settings.at("continuation-label")
  let presentation-title = if template-title != "" { template-title } else { doc-title }
  let presentation-author = if template-author != "" { template-author } else { doc-author }
  let presentation-date = if template-report-date != "" { template-report-date } else { none }
  let presentation-logo = if brand-logo-large != "" { image(brand-logo-large, height: 2.4em) } else { none }
  let presentation-body-size = body-size * 2.176871
  let presentation-heading-size = heading-size * 1.315789

  let presentation-init(self: none, content) = {
    set text(
      font: body-font,
      size: presentation-body-size,
      weight: body-font-weight,
      style: body-font-style,
      tracking: body-tracking,
      fill: rgb(text-color),
    )
    set par(leading: body-leading, justify: false)
    show heading: set text(
      font: heading-font,
      weight: heading-font-weight,
      style: heading-font-style,
      tracking: heading-tracking,
      fill: rgb(text-color),
    )
    show raw: set text(font: mono-font, size: 0.72em)
    content
  }

  let presentation-cover() = {
    if layout == "focus" {
      metropolis.title-slide()
    } else if layout == "navigator" {
      dewdrop.title-slide()
    } else {
      title-slide[
        #set text(font: heading-font, fill: rgb(text-color))
        #text(size: presentation-heading-size, weight: heading-font-weight)[#presentation-title]
        #if template-subtitle != "" { v(0.6em); text(size: 0.9em, fill: secondary-text-fill)[#template-subtitle] }
        #if presentation-author != "" { v(1.2em); text(size: 0.68em)[#presentation-author] }
        #if presentation-date != none { v(0.25em); text(size: 0.58em, fill: secondary-text-fill)[#presentation-date] }
        #if presentation-logo != none { v(1em); presentation-logo }
      ]
    }
  }

  let presentation-outline() = slide[
    #text(font: heading-font, size: 1.2em, weight: heading-font-weight)[#toc-heading]
    #v(0.6em)
    #outline(title: none, depth: 2, indent: auto)
  ]

  let continuation-footer(self) = context {
    let current-page = counter(page).get().first()
    let previous-headings = query(
      heading.where(level: 1).or(heading.where(level: 2)).before(here()),
    )
    if footer-style != "none" and previous-headings.len() > 0 {
      let heading-page = counter(page).at(previous-headings.last().location()).first()
      if heading-page < current-page {
        text(font: heading-font, continuation-label)
      }
    }
  }

  // Touying displays heading bodies outside heading show rules. Set the role
  // explicitly here so slide titles scale independently of the body font.
  let slide-heading(content) = text(
    font: heading-font,
    size: presentation-heading-size,
    weight: heading-font-weight,
    style: heading-font-style,
    tracking: heading-tracking,
    content,
  )
  let focus-slide-heading(self) = utils.display-current-heading(
    setting: content => utils.fit-to-width(grow: false, 100%, slide-heading(content)),
    depth: self.slide-level,
  )

  let slide-number(self) = context {
    let current = counter(page).get()
    let total = counter(page).final()
    if footer-style != "none" and page-numbering != "none" and current.len() > 0 and total.len() > 0 {
      str(current.first()) + " / " + str(total.first())
    }
  }

  let deck-content = {
    if cover-page-enabled { presentation-cover() }
    if toc-behavior != "off" { presentation-outline() }
    body
  }

  let common-page = config-page(
    width: myoxus-page-width,
    height: myoxus-page-height,
    fill: rgb(bg-color),
  )
  let common-behavior = config-common(
    breakable: true,
    clip: false,
    detect-overflow: false,
    slide-level: 2,
    receive-body-for-new-section-slide-fn: true,
  )
  let common-info = config-info(
    title: [#presentation-title],
    subtitle: if template-subtitle != "" { [#template-subtitle] } else { none },
    author: if presentation-author != "" { [#presentation-author] } else { none },
    date: presentation-date,
    institution: if brand-organization-name != "" { [#brand-organization-name] } else { none },
    logo: presentation-logo,
  )

  if layout == "focus" {
    show: metropolis.metropolis-theme.with(
      header: focus-slide-heading,
      header-right: none,
      footer: continuation-footer,
      footer-right: slide-number,
      footer-progress: footer-style != "none",
      common-page,
      // Metropolis reserves 70% of the top margin for its header. Keep the
      // title and vertical padding inside that region as heading size changes.
      config-page(margin: (
        top: calc.max(3 * presentation-body-size,
          (1.2 * presentation-heading-size + presentation-body-size) / 0.7),
        bottom: 1.5em,
        x: 2em,
      )),
      common-behavior,
      config-common(new-section-slide-fn: metropolis.new-section-slide.with(numbered: false)),
      common-info,
      config-colors(
        primary: rgb(accent),
        primary-light: structural-stroke,
        secondary: rgb(text-color),
        neutral-lightest: rgb(bg-color),
        neutral-dark: rgb(text-color),
        neutral-darkest: rgb(text-color),
      ),
      config-methods(init: presentation-init),
    )
    deck-content
  } else if layout == "navigator" {
    show: dewdrop.dewdrop-theme.with(
      subslide-preamble: self => block(text(
        fill: self.colors.primary,
        slide-heading(utils.display-current-heading(depth: self.slide-level)),
      )),
      navigation: "mini-slides",
      mini-slides: (
        height: 3em,
        x: 2em,
        display-section: true,
        display-subsection: true,
        linebreaks: false,
        short-heading: true,
        inline: true,
      ),
      footer: continuation-footer,
      footer-right: slide-number,
      common-page,
      common-behavior,
      common-info,
      config-colors(
        primary: rgb(accent),
        neutral-light: neutral-surface-fill,
        neutral-lightest: rgb(bg-color),
        neutral-dark: rgb(text-color),
        neutral-darkest: rgb(text-color),
      ),
      config-methods(init: presentation-init),
    )
    deck-content
  } else {
    show: simple-theme.with(
      subslide-preamble: block(
        below: 1.5em,
        slide-heading(utils.display-current-heading(level: 2)),
      ),
      footer: continuation-footer,
      footer-right: slide-number,
      config-page(
        width: myoxus-page-width,
        height: myoxus-page-height,
        fill: rgb(bg-color),
        margin: 2em,
      ),
      config-common(
        breakable: true,
        clip: false,
        detect-overflow: true,
        slide-level: 2,
        receive-body-for-new-section-slide-fn: true,
      ),
      config-info(
        title: [#presentation-title],
        subtitle: [#template-subtitle],
        author: [#presentation-author],
        date: presentation-date,
        institution: [#brand-organization-name],
        logo: presentation-logo,
      ),
      config-colors(
        primary: rgb(accent),
        neutral-light: secondary-text-fill,
        neutral-lightest: rgb(bg-color),
        neutral-darkest: rgb(text-color),
      ),
      config-methods(init: presentation-init),
    )
    deck-content
  }
}
