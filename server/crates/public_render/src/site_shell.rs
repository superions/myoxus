use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicSiteShellOptions {
  pub breadcrumbs_enabled: bool,
  pub toc_enabled: bool,
  pub max_toc_depth: u8,
  pub previous_next_enabled: bool,
  pub code_copy_enabled: bool,
  pub syntax_highlighting_enabled: bool,
  pub search_enabled: bool,
  pub asset_base_url: Option<String>,
  pub search_bundle_url: Option<String>,
  pub social_card_url: Option<String>,
  pub breadcrumbs: Vec<PublicBreadcrumb>,
  pub previous: Option<PublicAdjacentPage>,
  pub next: Option<PublicAdjacentPage>,
  pub footer_note: Option<String>,
}

impl Default for PublicSiteShellOptions {
  fn default() -> Self {
    Self {
      breadcrumbs_enabled: true,
      toc_enabled: true,
      max_toc_depth: 3,
      previous_next_enabled: true,
      code_copy_enabled: true,
      syntax_highlighting_enabled: true,
      search_enabled: true,
      asset_base_url: None,
      search_bundle_url: None,
      social_card_url: None,
      breadcrumbs: Vec::new(),
      previous: None,
      next: None,
      footer_note: None,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicBreadcrumb {
  pub label: String,
  pub href: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicAdjacentPage {
  pub label: String,
  pub href: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TocEntry {
  pub id: String,
  pub level: u8,
  pub title: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct TemplateSiteShell<'a> {
  pub public_css: &'a str,
  pub public_js: &'a str,
  pub public_css_url: Option<String>,
  pub public_js_url: Option<String>,
  pub code_copy_enabled: bool,
  pub search_enabled: bool,
  pub search_bundle_url: Option<String>,
  pub breadcrumbs_enabled: bool,
  pub breadcrumbs: &'a [PublicBreadcrumb],
  pub toc_enabled: bool,
  pub toc: &'a [TocEntry],
  pub previous_next_enabled: bool,
  pub previous: &'a Option<PublicAdjacentPage>,
  pub next: &'a Option<PublicAdjacentPage>,
  pub footer_note: &'a Option<String>,
  pub social_card_url: &'a Option<String>,
}

impl PublicSiteShellOptions {
  pub(crate) fn template<'a>(&'a self, toc: &'a [TocEntry], css: &'a str, js: &'a str) -> TemplateSiteShell<'a> {
    let normalized_asset_base = self
      .asset_base_url
      .as_deref()
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(|value| value.trim_end_matches('/').to_string());
    TemplateSiteShell {
      public_css: css,
      public_js: js,
      public_css_url: normalized_asset_base.as_ref().map(|base| format!("{base}/public.css")),
      public_js_url: normalized_asset_base.as_ref().map(|base| format!("{base}/public.js")),
      code_copy_enabled: self.code_copy_enabled,
      search_enabled: self.search_enabled && self.search_bundle_url.is_some(),
      search_bundle_url: self.search_bundle_url.clone(),
      breadcrumbs_enabled: self.breadcrumbs_enabled && !self.breadcrumbs.is_empty(),
      breadcrumbs: &self.breadcrumbs,
      toc_enabled: self.toc_enabled && !toc.is_empty(),
      toc,
      previous_next_enabled: self.previous_next_enabled && (self.previous.is_some() || self.next.is_some()),
      previous: &self.previous,
      next: &self.next,
      footer_note: &self.footer_note,
      social_card_url: &self.social_card_url,
    }
  }
}

/// Keep an external document key opaque to URL path, query and fragment parsing.
pub fn public_document_path(workspace_id: uuid::Uuid, route_key: &str) -> String {
  let key = url::form_urlencoded::byte_serialize(route_key.as_bytes())
    .collect::<String>()
    .replace('+', "%20");
  format!("/public/{workspace_id}/{key}")
}

pub fn public_folder_path(workspace_id: uuid::Uuid, folder_id: &str) -> String {
  let query = url::form_urlencoded::Serializer::new(String::new())
    .append_pair("folder", folder_id)
    .finish();
  format!("/public/{workspace_id}?{query}")
}
