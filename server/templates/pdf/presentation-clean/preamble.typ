// SPDX-License-Identifier: AGPL-3.0-or-later
// MYOXUS_TEMPLATE_HANDLES_TOC
// MYOXUS_TEMPLATE_HANDLES_DOCUMENT_TITLE
// MYOXUS_TEMPLATE_HANDLES_DIAGRAM_FIT
#import "vendor/myoxus/presentation-adapter.typ": myoxus-presentation

#let myoxus-fit-visual = myoxus-diagram-fitter(
  myoxus-page-width * 18%,
  myoxus-page-height * 58%,
  enlarge-wide: true,
)
#let presentation-labels = json("i18n/" + lang + ".json")
#show: myoxus-presentation.with((
  layout: "clean",
  doc-title: doc-title,
  doc-author: doc-author,
  template-title: template-title,
  template-subtitle: template-subtitle,
  template-author: template-author,
  template-report-date: template-report-date,
  brand-organization-name: brand-organization-name,
  brand-logo-large: brand-logo-large,
  cover-page-enabled: cover-page-enabled,
  toc-behavior: toc-behavior,
  footer-style: footer-style,
  page-numbering: page-numbering,
  myoxus-page-width: myoxus-page-width,
  myoxus-page-height: myoxus-page-height,
  body-font: body-font,
  body-font-weight: body-font-weight,
  body-font-style: body-font-style,
  body-tracking: body-tracking,
  body-size: body-size,
  body-leading: body-leading,
  heading-font: heading-font,
  heading-font-weight: heading-font-weight,
  heading-font-style: heading-font-style,
  heading-tracking: heading-tracking,
  heading-size: heading-size,
  mono-font: mono-font,
  text-color: text-color,
  bg-color: bg-color,
  accent: accent,
  secondary-text-fill: secondary-text-fill,
  structural-stroke: structural-stroke,
  neutral-surface-fill: neutral-surface-fill,
  toc-heading: presentation-labels.toc_heading,
  continuation-label: presentation-labels.continuation,
))
