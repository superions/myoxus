use std::collections::HashMap;

use crate::catalog::{HtmlRenderer, LocalizedLabels};
use crate::highlight::render_code_html;
use crate::ir::{
  AssetRef, Block, CalloutAppearance, DocumentBadge, InlineText, PublicDocIr, PublicList, PublicListItem,
  PublicListKind, TableAppearance, TableDensity, WorkspaceIndex, WorkspaceRegisterValue, local_note_name,
};
use crate::seo::{SeoMetadata, build_document_seo, build_workspace_seo};
use crate::site_shell::{PublicSiteShellOptions, TocEntry, public_document_path};
use myoxus_mermaid_render::{MermaidExportRenderer, MermanSvgRenderer, mermaid_svg_asset_key};
use serde::Serialize;
use tera::Context;
use tracing::warn;
use url::Url;

#[derive(Debug, Clone)]
pub struct HtmlRenderOptions {
  pub canonical_url: String,
  pub theme_css_url: String,
  pub favicon_url: String,
  pub noindex: bool,
  /// Server-owned locale used consistently for shell copy and date formatting.
  pub locale: String,
  /// Emit links that resolve from materialized `index.html` files.
  pub snapshot_relative_links: bool,
  pub site_shell: PublicSiteShellOptions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HtmlRenderOutput {
  pub html: String,
  pub seo: SeoMetadata,
}

#[derive(Debug, Clone)]
pub struct PrivateHtmlRenderOptions {
  pub theme_css_url: String,
  pub locale: String,
  /// Captured theme and embedded font URLs. None preserves linked delivery.
  pub portable_css: Option<String>,
}

impl Default for PrivateHtmlRenderOptions {
  fn default() -> Self {
    Self {
      theme_css_url: String::new(),
      locale: "en".into(),
      portable_css: None,
    }
  }
}

#[derive(Debug, Serialize)]
struct TemplateContext<'a> {
  html_lang_attr: String,
  seo_title: &'a str,
  seo_description: &'a str,
  canonical_url_attr: &'a str,
  theme_css_url_attr: &'a str,
  favicon_url_attr: &'a str,
  robots: &'a str,
  body: &'a str,
  public_root_href: String,
  brand_title: &'a str,
  brand_subtitle: &'a str,
  badges: &'a [DocumentBadge],
  workspace_variant: bool,
  labels: &'a LocalizedLabels,
}

struct RenderedBody {
  html: String,
  toc: Vec<TocEntry>,
}

pub fn render_document_html(
  renderer: &HtmlRenderer,
  ir: &PublicDocIr,
  options: &HtmlRenderOptions,
) -> Result<HtmlRenderOutput, String> {
  let seo = build_document_seo(ir, options.canonical_url.clone(), options.noindex);
  let body = render_document_body(ir, options, renderer);
  let public_root_href = if options.snapshot_relative_links {
    "../index.html".to_string()
  } else {
    format!("/public/{}", ir.document.workspace_id)
  };
  render_shell(
    renderer,
    seo,
    &body,
    options,
    &renderer.labels(&options.locale).public_document,
    &ir.document.title,
    &ir.document.metadata_badges,
    &public_root_href,
    false,
  )
}

/// Render authenticated/private document HTML from the same IR as public pages.
///
/// Private delivery intentionally omits public navigation, canonical links and
/// publication controls. Assets remain relative manifest references and binary data is embedded only for explicit portable output.
pub fn render_private_document_html(
  renderer: &HtmlRenderer,
  ir: &PublicDocIr,
  options: &PrivateHtmlRenderOptions,
) -> Result<HtmlRenderOutput, String> {
  let seo = build_document_seo(ir, String::new(), true);
  let body = render_document_body(
    ir,
    &HtmlRenderOptions {
      canonical_url: String::new(),
      theme_css_url: options.theme_css_url.clone(),
      favicon_url: "/favicon.ico".to_string(),
      noindex: true,
      locale: options.locale.clone(),
      snapshot_relative_links: false,
      site_shell: PublicSiteShellOptions {
        breadcrumbs_enabled: false,
        toc_enabled: false,
        max_toc_depth: 0,
        previous_next_enabled: false,
        code_copy_enabled: false,
        syntax_highlighting_enabled: true,
        search_enabled: false,
        asset_base_url: None,
        search_bundle_url: None,
        social_card_url: None,
        breadcrumbs: Vec::new(),
        previous: None,
        next: None,
        footer_note: None,
      },
    },
    renderer,
  );
  let mut context = Context::new();
  context.insert("title", &ir.document.title);
  context.insert("html_lang_attr", &esc_attr(&options.locale));
  // CSS is trusted server/catalog material, but a style element still needs its
  // HTML delimiter escaped even when a custom font family contains '<'.
  let portable_css = options.portable_css.as_ref().map(|css| css.replace('<', "\\3c "));
  context.insert("portable_css", &portable_css);
  context.insert("theme_css_url_attr", &esc_attr(&options.theme_css_url));
  context.insert("public_css", &renderer.css);
  context.insert("body", &body.html);
  let html = renderer.render("private_page.html.tera", &context)?;
  if let Some(css) = portable_css {
    let lower = html.to_ascii_lowercase();
    if css.to_ascii_lowercase().contains("@import")
      || renderer.css.to_ascii_lowercase().contains("@import")
      || !html.contains("data-myoxus-portable-theme")
      || !html.contains(&css)
      || ["<script", "<link", "<iframe", "<object", "<embed", "<base"]
        .iter()
        .any(|tag| lower.contains(tag))
      || !html.contains(&format!("lang=\"{}\"", esc_attr(&options.locale)))
    {
      return Err("Private HTML catalog does not support portable output".into());
    }
  }
  Ok(HtmlRenderOutput { html, seo })
}

fn register_timestamp_html(renderer: &HtmlRenderer, value: chrono::DateTime<chrono::Utc>, locale: &str) -> String {
  format!(
    "<time datetime=\"{}\">{}</time>",
    esc_attr(&value.to_rfc3339()),
    esc(&renderer.timestamp(value, locale))
  )
}

pub fn render_workspace_index_html(
  renderer: &HtmlRenderer,
  index: &WorkspaceIndex,
  options: &HtmlRenderOptions,
) -> Result<HtmlRenderOutput, String> {
  let seo = build_workspace_seo(index, options.canonical_url.clone(), options.noindex);
  let labels = renderer.labels(&options.locale);
  let introduction = index.introduction.as_ref().filter(|ir| !ir.document.blocks.is_empty());
  let show_register = index.document_count > 0 || index.folders.is_empty();
  let mut body = String::new();
  body.push_str("<section data-myoxus-role=\"public-workspace-index\" class=\"mx-public-index\" data-pagefind-body>");
  body.push_str(&format!(
    "<h1>{}</h1>",
    esc(index.folder_title.as_deref().unwrap_or(&index.title))
  ));
  if !index.description.trim().is_empty() {
    body.push_str(&format!(
      "<p class=\"mx-public-workspace-intro\" data-myoxus-role=\"public-workspace-description\">{}</p>",
      esc(&index.description)
    ));
  }
  // Colons cannot occur in authored heading slugs, so fixed anchors stay distinct.
  if introduction.is_some() || !index.folders.is_empty() {
    body.push_str(&format!(
      "<nav class=\"mx-public-overview-nav\" aria-label=\"{}\">",
      esc_attr(&labels.contents)
    ));
    if introduction.is_some() {
      body.push_str(&format!(
        "<a href=\"#myoxus:overview:introduction\">{}</a>",
        esc(&labels.introduction)
      ));
    }
    if !index.folders.is_empty() {
      body.push_str(&format!(
        "<a href=\"#myoxus:overview:folders\">{}</a>",
        esc(&labels.folders)
      ));
    }
    if show_register {
      body.push_str(&format!(
        "<a href=\"#myoxus:overview:documents\">{}</a>",
        esc(&labels.published_documents)
      ));
    }
    body.push_str("</nav>");
  }
  if let Some(ir) = introduction {
    body.push_str(&format!("<section id=\"myoxus:overview:introduction\" class=\"mx-public-overview-section\" aria-label=\"{}\" data-myoxus-role=\"public-workspace-introduction\">", esc_attr(&labels.introduction)));
    body.push_str(&render_document_body(ir, options, renderer).html);
    body.push_str("</section>");
  }
  if !index.folders.is_empty() {
    body.push_str(&format!("<section id=\"myoxus:overview:folders\" class=\"mx-public-overview-section\" aria-labelledby=\"myoxus:overview:folders:title\"><h2 id=\"myoxus:overview:folders:title\">{}</h2><ul class=\"mx-public-folder-list\">", esc(&labels.folders)));
    for folder in &index.folders {
      body.push_str(&format!("<li><a href=\"{}\" data-myoxus-role=\"public-folder-link\"><strong>{}</strong><span class=\"mx-public-index-arrow\" aria-hidden=\"true\">→</span></a></li>", esc_attr(&folder.href), esc(&folder.title)));
    }
    body.push_str("</ul></section>");
  }
  if show_register {
    body.push_str(&format!("<section id=\"myoxus:overview:documents\" class=\"mx-public-overview-section\" aria-label=\"{}\"><div class=\"mx-public-index-heading\"><h2>{}</h2><span data-myoxus-role=\"public-document-count\">{}</span></div>", esc_attr(&labels.published_documents), esc(&labels.published_documents), esc(&renderer.count(index.document_count, &options.locale))));
    if index.items.is_empty() {
      body.push_str(&format!(
        "<p class=\"mx-public-index-empty\" data-myoxus-role=\"public-index-empty\">{}</p>",
        esc(&labels.no_documents)
      ));
    } else {
      if !index.register_columns.iter().any(|key| key == "title") {
        return Err("public register requires its title column".into());
      }
      body.push_str("<div class=\"mx-public-table-wrap\"><table class=\"mx-public-table--ruled\" data-myoxus-role=\"public-document-register\"><thead><tr>");
      for key in &index.register_columns {
        let label = labels
          .register_columns
          .get(key)
          .ok_or("unsupported public register column")?;
        body.push_str(&format!(
          "<th scope=\"col\" data-register-key=\"{}\">{}</th>",
          esc_attr(key),
          esc(label)
        ));
      }
      body.push_str("</tr></thead><tbody>");
      for item in &index.items {
        let href = item.href.clone().unwrap_or_else(|| {
          if options.snapshot_relative_links {
            format!("{}/index.html", item.route_key)
          } else {
            public_document_path(index.workspace_id, &item.route_key)
          }
        });
        body.push_str("<tr>");
        for key in &index.register_columns {
          body.push_str("<td>");
          if key == "title" {
            body.push_str(&format!(
              "<a href=\"{}\" data-myoxus-role=\"public-index-link\">{}</a>",
              esc_attr(&href),
              esc(&item.title)
            ));
          } else {
            match item.register.get(key) {
              Some(WorkspaceRegisterValue::Text(value)) => body.push_str(&esc(value)),
              Some(WorkspaceRegisterValue::Labels(values)) if !values.is_empty() => {
                body.push_str(&esc(&values.join(", ")))
              }
              Some(WorkspaceRegisterValue::Timestamp(value)) => {
                body.push_str(&register_timestamp_html(renderer, *value, &options.locale))
              }
              Some(WorkspaceRegisterValue::Version { label, dirty }) => {
                let value = match (label, dirty) {
                  (Some(label), true) => format!("{label} ({})", labels.register_changed),
                  (Some(label), false) => label.clone(),
                  (None, true) => labels.register_unversioned.clone(),
                  (None, false) => "–".into(),
                };
                body.push_str(&esc(&value));
              }
              _ => body.push('–'),
            }
          }
          body.push_str("</td>");
        }
        body.push_str("</tr>");
      }
      body.push_str("</tbody></table></div>");
    }
    if index.previous_page.is_some() || index.next_page.is_some() {
      body.push_str(&format!(
        "<nav class=\"mx-public-adjacent\" aria-label=\"{}\">",
        esc_attr(&labels.adjacent_pages)
      ));
      for (href, relation, label) in [
        (&index.previous_page, "prev", &labels.previous),
        (&index.next_page, "next", &labels.next),
      ] {
        if let Some(href) = href {
          body.push_str(&format!(
            "<a href=\"{}\" rel=\"{relation}\">{}</a>",
            esc_attr(href),
            esc(label)
          ));
        }
      }
      body.push_str("</nav>");
    }
    body.push_str("</section>");
  }
  body.push_str("</section>");
  let public_root_href = if options.snapshot_relative_links {
    // Folder snapshots reuse their real workspace breadcrumb as the shell home.
    options
      .site_shell
      .breadcrumbs
      .first()
      .and_then(|breadcrumb| breadcrumb.href.clone())
      .unwrap_or_else(|| "index.html".to_string())
  } else {
    format!("/public/{}", index.workspace_id)
  };
  render_shell(
    renderer,
    seo,
    &RenderedBody {
      html: body,
      toc: Vec::new(),
    },
    options,
    &labels.public_workspace,
    &index.title,
    &[],
    &public_root_href,
    true,
  )
}

fn render_shell(
  renderer: &HtmlRenderer,
  seo: SeoMetadata,
  body: &RenderedBody,
  options: &HtmlRenderOptions,
  brand_subtitle: &str,
  brand_title: &str,
  badges: &[DocumentBadge],
  public_root_href: &str,
  workspace_variant: bool,
) -> Result<HtmlRenderOutput, String> {
  let robots = if options.noindex {
    "noindex,nofollow"
  } else {
    "index,follow"
  };
  let canonical_url_attr = esc_attr(&seo.canonical_url);
  let theme_css_url_attr = esc_attr(&options.theme_css_url);
  let favicon_url_attr = esc_attr(&options.favicon_url);
  let labels = renderer.labels(&options.locale);
  let page = TemplateContext {
    html_lang_attr: esc_attr(normalized_html_lang(&options.locale)),
    seo_title: &seo.title,
    seo_description: &seo.description,
    canonical_url_attr: &canonical_url_attr,
    theme_css_url_attr: &theme_css_url_attr,
    favicon_url_attr: &favicon_url_attr,
    robots,
    body: &body.html,
    public_root_href: esc_attr(public_root_href),
    brand_title,
    brand_subtitle,
    badges,
    workspace_variant,
    labels,
  };
  let shell = options.site_shell.template(&body.toc, &renderer.css, &renderer.js);
  let mut context = Context::new();
  context
    .try_insert("page", &page)
    .map_err(|err| format!("template page context failed: {err}"))?;
  context
    .try_insert("shell", &shell)
    .map_err(|err| format!("template shell context failed: {err}"))?;
  let html = renderer.render("public_page.html.tera", &context)?;
  Ok(HtmlRenderOutput { html, seo })
}

fn render_document_body(ir: &PublicDocIr, options: &HtmlRenderOptions, renderer: &HtmlRenderer) -> RenderedBody {
  let mut html = String::new();
  let mut toc = Vec::new();
  let mut slug_counts = HashMap::new();
  html.push_str("<article data-myoxus-role=\"public-document\" class=\"mx-public-document\" data-pagefind-body>");
  for block in &ir.document.blocks {
    match block {
      Block::Paragraph { text, .. } => html.push_str(&format!("<p>{}</p>", render_inline(text, &options.locale))),
      Block::Heading { level, text, .. } => {
        let level = (*level).clamp(1, 6);
        let title = plain_inline(text);
        let id = unique_slug(&title, &mut slug_counts);
        if options.site_shell.toc_enabled && level <= options.site_shell.max_toc_depth {
          toc.push(TocEntry {
            id: id.clone(),
            level,
            title: title.clone(),
          });
        }
        html.push_str(&format!(
          "<h{level} id=\"{}\">{}</h{level}>",
          esc_attr(&id),
          render_inline(text, &options.locale)
        ));
      }
      Block::FootnoteDefinition { block_id, label, placement, number, children, backlinks, .. } =>
        render_footnote_definition(&mut html, block_id, label, *placement, *number, children, backlinks, options, renderer),
      Block::List { list, .. } => render_list(&mut html, list, options, renderer),
      Block::Quote { text, .. } => html.push_str(&format!("<blockquote>{}</blockquote>", render_inline(text, &options.locale))),
      Block::Callout {
        title,
        text,
        appearance,
        children,
        ..
      } => render_callout(&mut html, title.as_deref(), text, *appearance, children, options, renderer),
      Block::Code { language, text, .. } => html.push_str(&render_code_block(language.as_deref(), text, options, renderer)),
      Block::Mermaid {
        block_id,
        source,
        title,
        caption,
      } => html.push_str(&render_mermaid(block_id, source, title, caption)),
      Block::Divider { .. } => html.push_str("<hr />"),
      Block::Image { asset, .. } => html.push_str(&render_image(asset, options.snapshot_relative_links)),
      Block::BookmarkCard { url, title, .. } => html.push_str(&render_link_card(url, title)),
      Block::Table {
        rows,
        header_rows,
        appearance,
        density,
        ..
      } => html.push_str(&render_table(rows, *header_rows, *appearance, *density, &options.locale)),
      Block::TablePlaceholder { .. } => {
        html.push_str("<p class=\"mx-public-unsupported\" data-myoxus-role=\"public-unsupported\" data-pagefind-ignore>Table preview unavailable.</p>")
      }
      Block::UnsupportedBlock { .. } => html.push_str(
        "<p class=\"mx-public-unsupported\" data-myoxus-role=\"public-unsupported\" data-pagefind-ignore>Content preview unavailable.</p>",
      ),
    }
  }
  html.push_str("</article>");
  RenderedBody { html, toc }
}

fn render_list(html: &mut String, list: &PublicList, options: &HtmlRenderOptions, renderer: &HtmlRenderer) {
  let (tag, list_type) = match list.kind {
    PublicListKind::Bulleted => ("ul", "bulleted"),
    PublicListKind::Numbered => ("ol", "numbered"),
    PublicListKind::Todo => ("ul", "todo"),
  };
  html.push_str(&format!(
    "<{tag} class=\"mx-public-list mx-public-list--{list_type}\" data-myoxus-role=\"public-list\" data-list-type=\"{list_type}\">"
  ));
  for item in &list.items {
    render_list_item(html, list.kind, item, options, renderer);
  }
  html.push_str(&format!("</{tag}>"));
}

fn render_list_item(
  html: &mut String,
  kind: PublicListKind,
  item: &PublicListItem,
  options: &HtmlRenderOptions,
  renderer: &HtmlRenderer,
) {
  html.push_str("<li data-myoxus-role=\"public-list-item\">");
  if kind == PublicListKind::Todo {
    let checked_attr = if item.todo_checked.unwrap_or(false) {
      " checked"
    } else {
      ""
    };
    html.push_str(&format!(
      "<label class=\"mx-public-task\" data-myoxus-role=\"public-task\"><input type=\"checkbox\" disabled{checked_attr} /><span>{}</span></label>",
      render_inline(&item.text, &options.locale)
    ));
  } else {
    html.push_str(&render_inline(&item.text, &options.locale));
  }
  for child in &item.children {
    render_nested_block(html, child, options, renderer);
  }
  html.push_str("</li>");
}

fn render_nested_block(html: &mut String, block: &Block, options: &HtmlRenderOptions, renderer: &HtmlRenderer) {
  match block {
    Block::FootnoteDefinition { block_id, label, placement, number, children, backlinks, .. } =>
      render_footnote_definition(html, block_id, label, *placement, *number, children, backlinks, options, renderer),
    Block::List { list, .. } => render_list(html, list, options, renderer),
    Block::Paragraph { text, .. } => html.push_str(&format!("<p>{}</p>", render_inline(text, &options.locale))),
    Block::Quote { text, .. } => html.push_str(&format!("<blockquote>{}</blockquote>", render_inline(text, &options.locale))),
    Block::Callout {
      title,
      text,
      appearance,
      children,
      ..
    } => render_callout(html, title.as_deref(), text, *appearance, children, options, renderer),
    Block::Code { language, text, .. } => html.push_str(&render_code_block(language.as_deref(), text, options, renderer)),
    Block::Mermaid {
      block_id,
      source,
      title,
      caption,
    } => html.push_str(&render_mermaid(block_id, source, title, caption)),
    Block::Divider { .. } => html.push_str("<hr />"),
    Block::Heading { level, text, .. } => {
      let level = (*level).clamp(1, 6);
      html.push_str(&format!("<h{level}>{}</h{level}>", render_inline(text, &options.locale)));
    }
    Block::Image { asset, .. } => html.push_str(&render_image(asset, options.snapshot_relative_links)),
    Block::BookmarkCard { url, title, .. } => html.push_str(&render_link_card(url, title)),
    Block::Table {
      rows,
      header_rows,
      appearance,
      density,
      ..
    } => html.push_str(&render_table(rows, *header_rows, *appearance, *density, &options.locale)),
    Block::TablePlaceholder { .. } => html.push_str(
      "<p class=\"mx-public-unsupported\" data-myoxus-role=\"public-unsupported\" data-pagefind-ignore>Table preview unavailable.</p>",
    ),
    Block::UnsupportedBlock { .. } => html.push_str(
      "<p class=\"mx-public-unsupported\" data-myoxus-role=\"public-unsupported\" data-pagefind-ignore>Content preview unavailable.</p>",
    ),
  }
}

fn render_callout(
  html: &mut String,
  title: Option<&str>,
  text: &[InlineText],
  appearance: CalloutAppearance,
  children: &[Block],
  options: &HtmlRenderOptions,
  renderer: &HtmlRenderer,
) {
  let appearance = match appearance {
    CalloutAppearance::Soft => "soft",
    CalloutAppearance::Accent => "accent",
    CalloutAppearance::Outline => "outline",
  };
  html.push_str(&format!(
    "<aside class=\"mx-public-callout mx-public-callout--{appearance}\" data-myoxus-role=\"public-callout\" data-appearance=\"{appearance}\">"
  ));
  if let Some(title) = title {
    let title = if title.is_empty() {
      match options.locale.split('-').next().unwrap_or("en") {
        "de" => "Hinweis",
        "es" => "Nota",
        _ => "Note",
      }
    } else {
      title
    };
    html.push_str(&format!("<p><strong>{}</strong></p>", esc(title)));
  }
  if !plain_inline(text).trim().is_empty() {
    html.push_str(&format!(
      "<p class=\"mx-public-callout-text\">{}</p>",
      render_inline(text, &options.locale)
    ));
  }
  for child in children {
    render_nested_block(html, child, options, renderer);
  }
  html.push_str("</aside>");
}

fn render_mermaid(block_id: &str, source: &str, title: &str, caption: &str) -> String {
  let asset_key = mermaid_svg_asset_key(&format!("{block_id}\0{source}"));
  let diagram_id = format!(
    "public-mermaid-{}",
    asset_key.trim_start_matches("__mermaid_").trim_end_matches(".svg")
  );
  let svg = match MermanSvgRenderer.render_svg(source, &diagram_id) {
    Ok(svg) => svg,
    Err(error) => {
      warn!(diagram_id, error = %error, "public Mermaid rendering failed");
      return "<figure class=\"mx-public-mermaid mx-public-mermaid--unavailable\" data-myoxus-role=\"public-mermaid\" data-render-status=\"unavailable\" data-pagefind-ignore><p>Diagram preview unavailable.</p></figure>".to_string();
    }
  };

  let mut html = format!(
    "<figure class=\"mx-public-mermaid\" data-myoxus-role=\"public-mermaid\" data-render-status=\"rendered\"><div class=\"mx-public-mermaid-canvas\">{svg}</div>"
  );
  if !title.trim().is_empty() || !caption.trim().is_empty() {
    html.push_str("<figcaption>");
    if !title.trim().is_empty() {
      html.push_str(&format!("<strong>{}</strong>", esc(title.trim())));
    }
    if !caption.trim().is_empty() {
      html.push_str(&format!("<span>{}</span>", esc(caption.trim())));
    }
    html.push_str("</figcaption>");
  }
  html.push_str("</figure>");
  html
}

fn render_table(
  rows: &[Vec<Vec<InlineText>>],
  header_rows: Option<usize>,
  appearance: Option<TableAppearance>,
  density: Option<TableDensity>,
  locale: &str,
) -> String {
  if rows.is_empty() {
    return "<p class=\"mx-public-unsupported\" data-myoxus-role=\"public-unsupported\" data-pagefind-ignore>Table preview unavailable.</p>".to_string();
  }

  let col_count = rows.iter().map(Vec::len).max().unwrap_or(0);
  if col_count == 0 {
    return "<p class=\"mx-public-unsupported\" data-myoxus-role=\"public-unsupported\" data-pagefind-ignore>Table preview unavailable.</p>".to_string();
  }

  let mut html = String::new();
  let appearance = match appearance.unwrap_or(TableAppearance::Grid) {
    TableAppearance::Grid => "grid",
    TableAppearance::Ruled => "ruled",
    TableAppearance::Plain => "plain",
  };
  let density = match density.unwrap_or(TableDensity::Normal) {
    TableDensity::Normal => "normal",
    TableDensity::Compact => "compact",
  };
  html.push_str(&format!(
    "<div class=\"mx-public-table-wrap\"><table class=\"mx-public-table--{appearance} mx-public-table--{density}\" data-myoxus-role=\"public-table\" data-appearance=\"{appearance}\" data-density=\"{density}\">"
  ));
  let header_rows = header_rows.unwrap_or(1).min(rows.len());
  if header_rows > 0 {
    html.push_str("<thead>");
    for row in rows.iter().take(header_rows) {
      render_table_row(&mut html, row, col_count, "th", locale);
    }
    html.push_str("</thead>");
  }
  if header_rows < rows.len() {
    html.push_str("<tbody>");
    for row in rows.iter().skip(header_rows) {
      render_table_row(&mut html, row, col_count, "td", locale);
    }
    html.push_str("</tbody>");
  }
  html.push_str("</table></div>");
  html
}

fn render_table_row(html: &mut String, row: &[Vec<InlineText>], col_count: usize, cell_tag: &str, locale: &str) {
  html.push_str("<tr>");
  for column_index in 0..col_count {
    let cell = row.get(column_index).map(Vec::as_slice).unwrap_or(&[]);
    let scope = if cell_tag == "th" { " scope=\"col\"" } else { "" };
    html.push_str(&format!(
      "<{cell_tag}{scope}>{}</{cell_tag}>",
      render_inline(cell, locale)
    ));
  }
  html.push_str("</tr>");
}

fn render_code_block(
  language: Option<&str>,
  text: &str,
  options: &HtmlRenderOptions,
  renderer: &HtmlRenderer,
) -> String {
  let language_label = language
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or(&renderer.labels(&options.locale).plain_text);
  let class_attr = language
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| format!(" class=\"language-{}\"", esc_attr(value)))
    .unwrap_or_default();
  let highlighted = render_code_html(language, text, options.site_shell.syntax_highlighting_enabled);
  let labels = renderer.labels(&options.locale);
  let copy_button = if options.site_shell.code_copy_enabled {
    format!(
      "<button class=\"mx-public-code-copy\" type=\"button\" data-myoxus-public-copy data-copy-label=\"{}\" data-copied-label=\"{}\" data-failed-label=\"{}\">{}</button>",
      esc_attr(&labels.copy),
      esc_attr(&labels.copied),
      esc_attr(&labels.failed),
      esc(&labels.copy)
    )
  } else {
    String::new()
  };
  format!(
    "<pre data-myoxus-role=\"public-code\" data-pagefind-ignore><div class=\"mx-public-code-header\"><span class=\"mx-public-code-language\">{}</span>{copy_button}</div><code{class_attr}>{highlighted}</code></pre>",
    esc(language_label)
  )
}

fn render_inline(parts: &[InlineText], locale: &str) -> String {
  let mut html = String::new();
  for part in parts {
    if let Some(marker) = &part.local_footnote {
      if marker.resolved {
        let name = local_note_name(marker.placement, marker.number, locale);
        html.push_str(&format!(
          "<sup id=\"{}\" data-myoxus-footnote-definition-id=\"{}\" data-myoxus-footnote-label=\"{}\"><a role=\"doc-noteref\" href=\"#myoxus-footnote-{}\" aria-label=\"{}\">[{}]</a></sup>",
          esc_attr(&marker.reference_id), esc_attr(&marker.definition_id), esc_attr(&marker.label),
          esc_attr(&marker.definition_id), esc_attr(&name), marker.number.unwrap_or_default(),
        ));
      } else {
        html.push_str(&format!(
          "<sup data-myoxus-role=\"footnote-missing\" aria-label=\"{}\">[?]</sup>",
          esc_attr(&local_note_name(None, None, locale))
        ));
      }
      continue;
    }
    let mut chunk = if part.code {
      format!("<code>{}</code>", esc(&part.text))
    } else {
      esc(&part.text)
    };
    if part.bold {
      chunk = format!("<strong>{chunk}</strong>");
    }
    if part.italic {
      chunk = format!("<em>{chunk}</em>");
    }
    if part.strike {
      chunk = format!("<del>{chunk}</del>");
    }
    if let Some(link) = part.link.as_deref().filter(|link| is_allowed_external_link(link)) {
      chunk = format!("<a href=\"{}\" rel=\"noopener noreferrer\">{chunk}</a>", esc_attr(link));
    }
    html.push_str(&chunk);
  }
  html
}

fn plain_inline(parts: &[InlineText]) -> String {
  parts.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join("")
}

fn render_image(asset: &AssetRef, snapshot_relative_links: bool) -> String {
  let src = asset.public_url.as_deref().unwrap_or(asset.source.as_str());
  // Snapshot adapters bind these URLs only after materializing the manifest
  // asset. An authored relative source never gains this delivery authority.
  let resolved_snapshot_asset = snapshot_relative_links
    && asset.public_url.is_some()
    && src
      .trim_start_matches("../")
      .strip_prefix("public-assets/")
      .is_some_and(|path| !path.split('/').any(|segment| matches!(segment, "" | "." | "..")));
  if !is_allowed_public_url(src) && !resolved_snapshot_asset {
    return "<p data-myoxus-role=\"public-asset-placeholder\" data-pagefind-ignore>Image unavailable.</p>".to_string();
  }
  format!(
    "<figure data-myoxus-role=\"public-image\"><img src=\"{}\" alt=\"{}\" loading=\"lazy\" /></figure>",
    esc_attr(src),
    esc_attr(&asset.alt)
  )
}

fn render_link_card(url: &str, title: &str) -> String {
  if !is_allowed_external_link(url) {
    return format!(
      "<p data-myoxus-role=\"public-link-placeholder\" data-pagefind-ignore>{}</p>",
      esc(if title.is_empty() { url } else { title })
    );
  }
  let label = if title.trim().is_empty() { url } else { title };
  format!(
    "<p class=\"mx-public-bookmark\" data-myoxus-role=\"public-bookmark\"><a href=\"{}\" rel=\"noopener noreferrer\">{}</a></p>",
    esc_attr(url),
    esc(label)
  )
}

fn unique_slug(title: &str, slug_counts: &mut HashMap<String, usize>) -> String {
  let base = slugify(title);
  let count = slug_counts.entry(base.clone()).or_insert(0);
  *count += 1;
  if *count == 1 {
    base
  } else {
    format!("{base}-{}", *count)
  }
}

fn slugify(title: &str) -> String {
  let mut slug = String::new();
  let mut previous_dash = false;
  for ch in title.chars().flat_map(char::to_lowercase) {
    if ch.is_ascii_alphanumeric() {
      slug.push(ch);
      previous_dash = false;
    } else if !previous_dash && !slug.is_empty() {
      slug.push('-');
      previous_dash = true;
    }
  }
  while slug.ends_with('-') {
    slug.pop();
  }
  if slug.is_empty() { "section".to_string() } else { slug }
}

fn is_allowed_external_link(value: &str) -> bool {
  Url::parse(value)
    .ok()
    .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn is_allowed_public_url(value: &str) -> bool {
  if value.starts_with("/public-assets/")
    || (value.starts_with("assets/") && !value.split('/').any(|segment| segment == ".."))
  {
    return true;
  }
  is_allowed_external_link(value)
}

fn normalized_html_lang(locale: &str) -> &str {
  let locale = locale.trim();
  if locale.is_empty() { "en" } else { locale }
}

fn esc(value: &str) -> String {
  v_htmlescape::escape(value).to_string()
}

fn esc_attr(value: &str) -> String {
  // v_htmlescape intentionally escapes `/`. That is safe but makes generated
  // route URLs difficult to inspect, so path separators are restored after the
  // security-relevant characters have been escaped.
  v_htmlescape::escape(value).to_string().replace("&#x2f;", "/")
}

fn render_footnote_definition(
  html: &mut String,
  id: &str,
  label: &str,
  placement: Option<yjs::footnote::FootnotePlacement>,
  number: Option<u32>,
  children: &[Block],
  backlinks: &[String],
  options: &HtmlRenderOptions,
  renderer: &HtmlRenderer,
) {
  let name = local_note_name(placement, number, &options.locale);
  let kind = match placement {
    Some(yjs::footnote::FootnotePlacement::Footnote) => "footnote",
    Some(yjs::footnote::FootnotePlacement::Endnote) => "endnote",
    None => "invalid",
  };
  html.push_str(&format!(
    "<section id=\"myoxus-footnote-{}\" role=\"doc-{}\" data-myoxus-footnote-definition=\"{}\" data-myoxus-footnote-label=\"{}\" data-myoxus-footnote-placement=\"{}\" aria-label=\"{}\"><header data-myoxus-footnote-navigation=\"true\">{}</header>",
    esc_attr(id), kind, esc_attr(id), esc_attr(label), kind, esc_attr(&name), esc(&name),
  ));
  for child in children {
    render_nested_block(html, child, options, renderer);
  }
  if !backlinks.is_empty() {
    html.push_str("<footer data-myoxus-footnote-navigation=\"true\">");
    for (index, reference) in backlinks.iter().enumerate() {
      html.push_str(&format!(
        "<a role=\"doc-backlink\" href=\"#{}\" aria-label=\"{} ({})\">↩</a>",
        esc_attr(reference),
        esc_attr(&name),
        index + 1
      ));
    }
    html.push_str("</footer>");
  }
  html.push_str("</section>");
}

/// Exercise absent and populated optional branches using the same typed contexts
/// as real requests. A broken external shell must fail before it is published.
pub(crate) fn validate_catalog(renderer: &HtmlRenderer) -> Result<(), String> {
  use crate::{Document, PublicAdjacentPage, PublicBreadcrumb, WorkspaceIndexItem};
  use uuid::Uuid;
  for locale in ["en", "de", "fr", "es"] {
    for populated in [false, true] {
      let mut options = HtmlRenderOptions {
        canonical_url: "https://example.test/public/catalog?a=1&b=2".into(),
        theme_css_url: "/api/branding/theme.css".into(),
        favicon_url: "/favicon.ico".into(),
        noindex: !populated,
        locale: locale.into(),
        snapshot_relative_links: !populated,
        site_shell: PublicSiteShellOptions::default(),
      };
      if populated {
        options.site_shell.asset_base_url = Some("../assets".into());
        options.site_shell.search_bundle_url = Some("../pagefind/pagefind.js".into());
        options.site_shell.social_card_url = Some("../card.png".into());
        options.site_shell.breadcrumbs.push(PublicBreadcrumb {
          label: "<Catalog & owner>".into(),
          href: Some("../index.html".into()),
        });
        let adjacent = PublicAdjacentPage {
          label: "<Adjacent & page>".into(),
          href: "../next/index.html".into(),
        };
        options.site_shell.previous = Some(adjacent.clone());
        options.site_shell.next = Some(adjacent);
        options.site_shell.footer_note = Some("<Footer & note>".into());
      }
      let ir = PublicDocIr {
        native_fields: Vec::new(),
        document: Document {
          workspace_id: Uuid::nil(),
          doc_id: Uuid::nil(),
          title: "<Catalog & title>".into(),
          public_mode: "Page".into(),
          metadata_badges: if populated {
            vec![DocumentBadge {
              key: "owner".into(),
              label: "<Label>".into(),
              value: "<Value>".into(),
            }]
          } else {
            vec![]
          },
          blocks: if populated {
            vec![Block::Heading {
              block_id: "heading".into(),
              level: 2,
              text: vec![InlineText::plain("<Heading>")],
            }]
          } else {
            vec![]
          },
          assets: vec![],
        },
        diagnostics: vec![],
        native_children: Default::default(),
        native_tables: Default::default(),
        mutation_partial: false,
        native_citations: Default::default(),
        native_text: Default::default(),
      };
      render_document_html(renderer, &ir, &options)?;
      render_private_document_html(
        renderer,
        &ir,
        &PrivateHtmlRenderOptions {
          theme_css_url: options.theme_css_url.clone(),
          ..Default::default()
        },
      )?;
      let index = WorkspaceIndex {
        document_count: usize::from(populated),
        register_columns: vec!["title".into(), "updatedAt".into()],
        workspace_id: Uuid::nil(),
        title: ir.document.title.clone(),
        description: "<Description & value>".into(),
        items: if populated {
          vec![WorkspaceIndexItem {
            register: std::collections::BTreeMap::from([(
              "updatedAt".into(),
              crate::WorkspaceRegisterValue::Timestamp(chrono::DateTime::from_timestamp(0, 0).unwrap()),
            )]),
            href: None,
            doc_id: Uuid::nil(),
            route_key: "catalog".into(),
            title: ir.document.title.clone(),
            public_mode: "Page".into(),
          }]
        } else {
          vec![]
        },
        ..Default::default()
      };
      render_workspace_index_html(renderer, &index, &options)?;
    }
  }
  Ok(())
}
