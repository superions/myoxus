// SPDX-License-Identifier: AGPL-3.0-or-later
use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tera::{Context, Tera};

pub const HTML_CATALOG_FILES: &[&str] = &[
  "public_page.html.tera",
  "private_page.html.tera",
  "social_card.svg.tera",
  "workspace_page.html.tera",
  "rsvp_page.html.tera",
  "assets/public.css",
  "assets/public.js",
  "i18n/en.json",
  "i18n/de.json",
  "i18n/fr.json",
  "i18n/es.json",
];

/// Immutable, process-local capture. Host paths and runtime configuration belong
/// to the Infrastructure provider, never to rendering or document projections.
pub struct HtmlRenderer {
  templates: Tera,
  locales: BTreeMap<String, LocalizedLabels>,
  pub(crate) css: String,
  pub(crate) js: String,
  content_hash: String,
}

/// Allows CLI composition to defer its single capture until HTML is requested.
pub trait HtmlRendererProvider: Send + Sync {
  fn renderer(&self) -> Result<&HtmlRenderer, String>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LocalizedLabels {
  pub public_document: String,
  pub public_workspace: String,
  pub published_documents: String,
  pub introduction: String,
  pub folders: String,
  pub no_documents: String,
  pub register_columns: BTreeMap<String, String>,
  pub register_changed: String,
  pub register_unversioned: String,
  register_timestamp: String,
  pub search_placeholder: String,
  pub breadcrumb: String,
  pub adjacent_pages: String,
  pub previous: String,
  pub next: String,
  pub contents: String,
  pub footer: String,
  pub copy: String,
  pub copied: String,
  pub failed: String,
  pub plain_text: String,
  pub social_footer: String,
  pub social_untitled: String,
  count_one: String,
  count_other: String,
  updated: String,
  months: [String; 12],
}

impl HtmlRenderer {
  pub fn from_files(files: BTreeMap<String, Vec<u8>>) -> Result<Self, String> {
    let mut digest = Sha256::new();
    let mut templates = Tera::default();
    templates.autoescape_on(vec![".html.tera", ".svg.tera"]);
    let mut locales = BTreeMap::new();
    let mut decoded = BTreeMap::new();
    for &name in HTML_CATALOG_FILES {
      let bytes = files
        .get(name)
        .ok_or_else(|| format!("missing HTML catalog file: {name}"))?;
      digest.update((name.len() as u64).to_be_bytes());
      digest.update(name.as_bytes());
      digest.update((bytes.len() as u64).to_be_bytes());
      digest.update(bytes);
      let text = std::str::from_utf8(bytes).map_err(|_| format!("HTML catalog file is not UTF-8: {name}"))?;
      if name.ends_with(".tera") {
        templates
          .add_raw_template(name, text)
          .map_err(|err| format!("HTML catalog template {name}: {err}"))?;
      } else if let Some(locale) = name.strip_prefix("i18n/").and_then(|name| name.strip_suffix(".json")) {
        let labels = read_locale(locale, text, &mut digest)?;
        labels.validate(locale)?;
        locales.insert(locale.to_string(), labels);
      }
      decoded.insert(name, text.to_string());
    }
    let renderer = Self {
      templates,
      locales,
      css: decoded.remove("assets/public.css").unwrap(),
      js: decoded.remove("assets/public.js").unwrap(),
      content_hash: hex::encode(digest.finalize()),
    };
    crate::html::validate_catalog(&renderer)?;
    crate::social_card::validate_catalog(&renderer)?;
    crate::response_pages::validate_catalog(&renderer)?;
    Ok(renderer)
  }

  pub fn content_hash(&self) -> &str {
    &self.content_hash
  }
  pub fn renderer_version(&self, code_version: &str) -> String {
    format!("{code_version}:{}", self.content_hash)
  }
  pub fn public_css(&self) -> &str {
    &self.css
  }
  pub fn public_js(&self) -> &str {
    &self.js
  }
  pub(crate) fn render(&self, name: &str, context: &Context) -> Result<String, String> {
    self
      .templates
      .render(name, context)
      .map_err(|err| format!("HTML catalog render {name}: {err}"))
  }
  pub(crate) fn labels(&self, locale: &str) -> &LocalizedLabels {
    self.locales.get(language(locale)).unwrap_or(&self.locales["en"])
  }
  pub(crate) fn count(&self, count: usize, locale: &str) -> String {
    let labels = self.labels(locale);
    let singular = count == 1 || (language(locale) == "fr" && count == 0);
    let pattern = if singular {
      &labels.count_one
    } else {
      &labels.count_other
    };
    pattern.replace("{count}", &count.to_string())
  }
  pub(crate) fn timestamp(&self, value: DateTime<Utc>, locale: &str) -> String {
    let labels = self.labels(locale);
    labels
      .register_timestamp
      .replace("{month}", &labels.months[value.month0() as usize])
      .replace("{day}", &value.day().to_string())
      .replace("{year}", &value.year().to_string())
      .replace("{hour}", &format!("{:02}", value.hour()))
      .replace("{minute}", &format!("{:02}", value.minute()))
  }
}

/// Existing operator catalogs survive additive labels. The defaults are a
/// projection of the same authored JSON, not another translation dictionary.
fn read_locale(locale: &str, text: &str, digest: &mut Sha256) -> Result<LocalizedLabels, String> {
  let defaults = match locale {
    "en" => include_str!("../../../templates/html/i18n/en.json"),
    "de" => include_str!("../../../templates/html/i18n/de.json"),
    "fr" => include_str!("../../../templates/html/i18n/fr.json"),
    "es" => include_str!("../../../templates/html/i18n/es.json"),
    _ => return Err(format!("unsupported HTML catalog locale: {locale}")),
  };
  let parse = |value: &str| {
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(value)
      .map_err(|err| format!("HTML catalog locale {locale}: {err}"))
  };
  let mut projected = parse(text)?;
  let defaults = parse(defaults)?;
  for key in [
    "introduction",
    "folders",
    "register_columns",
    "register_changed",
    "register_unversioned",
    "register_timestamp",
  ] {
    if !projected.contains_key(key) {
      let value = defaults
        .get(key)
        .ok_or_else(|| format!("missing HTML default label: {key}"))?
        .clone();
      // Effective default changes must also change the captured renderer identity.
      let encoded = serde_json::to_vec(&value).map_err(|err| err.to_string())?;
      digest.update((key.len() as u64).to_be_bytes());
      digest.update(key.as_bytes());
      digest.update((encoded.len() as u64).to_be_bytes());
      digest.update(encoded);
      projected.insert(key.to_string(), value);
    }
  }
  if let (Some(defaults), Some(authored)) = (
    defaults.get("register_columns").and_then(|value| value.as_object()),
    projected
      .get_mut("register_columns")
      .and_then(|value| value.as_object_mut()),
  ) {
    for (key, value) in defaults {
      if !authored.contains_key(key) {
        let encoded = serde_json::to_vec(value).map_err(|err| err.to_string())?;
        digest.update(b"register_columns");
        digest.update((key.len() as u64).to_be_bytes());
        digest.update(key.as_bytes());
        digest.update((encoded.len() as u64).to_be_bytes());
        digest.update(&encoded);
        authored.insert(key.clone(), value.clone());
      }
    }
  }
  serde_json::from_value(serde_json::Value::Object(projected))
    .map_err(|err| format!("HTML catalog locale {locale}: {err}"))
}

fn language(locale: &str) -> &str {
  locale.split(['-', '_']).next().unwrap_or("en")
}

impl LocalizedLabels {
  fn validate(&self, locale: &str) -> Result<(), String> {
    let value = serde_json::to_value(self).map_err(|err| err.to_string())?;
    if value
      .as_object()
      .unwrap()
      .values()
      .any(|value| value.as_str().is_some_and(|text| text.trim().is_empty()))
      || self.months.iter().any(|month| month.trim().is_empty())
      || self.register_columns.values().any(|label| label.trim().is_empty())
    {
      return Err(format!("HTML catalog locale {locale}: empty required label"));
    }
    for (pattern, required) in [
      (&self.count_one, &["{count}"][..]),
      (&self.count_other, &["{count}"][..]),
      (&self.updated, &["{month}", "{day}", "{year}"][..]),
      (
        &self.register_timestamp,
        &["{month}", "{day}", "{year}", "{hour}", "{minute}"][..],
      ),
    ] {
      let mut remainder = pattern.clone();
      for placeholder in required {
        if pattern.matches(placeholder).count() != 1 {
          return Err(format!("HTML catalog locale {locale}: invalid placeholders"));
        }
        remainder = remainder.replace(placeholder, "");
      }
      if remainder.contains(['{', '}']) {
        return Err(format!("HTML catalog locale {locale}: unknown placeholder"));
      }
    }
    Ok(())
  }
}

impl HtmlRendererProvider for HtmlRenderer {
  fn renderer(&self) -> Result<&HtmlRenderer, String> {
    Ok(self)
  }
}

#[cfg(test)]
pub(crate) fn test_renderer() -> &'static HtmlRenderer {
  static CAPTURED: std::sync::OnceLock<HtmlRenderer> = std::sync::OnceLock::new();
  CAPTURED.get_or_init(|| {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
    let files = HTML_CATALOG_FILES
      .iter()
      .map(|name| (name.to_string(), std::fs::read(root.join(name)).unwrap()))
      .collect();
    HtmlRenderer::from_files(files).unwrap()
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{
    Document, HtmlRenderOptions, PrivateHtmlRenderOptions, PublicDocIr, PublicSiteShellOptions, render_document_html,
    render_private_document_html,
  };

  #[test]
  fn external_shell_escapes_user_fields_once_and_keeps_trusted_markup() {
    let renderer = test_renderer();
    let ir = PublicDocIr {
      document: Document {
        workspace_id: uuid::Uuid::nil(),
        doc_id: uuid::Uuid::nil(),
        title: "<Title & \"owner\">".into(),
        public_mode: "Page".into(),
        metadata_badges: vec![],
        blocks: vec![],
        assets: vec![],
      },
      diagnostics: vec![],
      native_children: Default::default(),
      native_tables: Default::default(),
      mutation_partial: false,
      native_citations: Default::default(),
      native_text: Default::default(),
    };
    let options = HtmlRenderOptions {
      canonical_url: "https://example.test/?a=1&b=2".into(),
      theme_css_url: "/theme.css?a=1&b=2".into(),
      favicon_url: "/favicon.ico".into(),
      noindex: true,
      locale: "de-DE".into(),
      snapshot_relative_links: false,
      site_shell: PublicSiteShellOptions::default(),
    };
    let public = render_document_html(renderer, &ir, &options).unwrap().html;
    let private = render_private_document_html(
      renderer,
      &ir,
      &PrivateHtmlRenderOptions {
        theme_css_url: options.theme_css_url.clone(),
        ..Default::default()
      },
    )
    .unwrap()
    .html;
    for html in [public, private] {
      assert!(html.contains("<title>&lt;Title &amp; &quot;owner&quot;&gt;</title>"));
      assert!(!html.contains("&amp;lt;"));
      assert!(html.contains("noindex,nofollow"));
      assert!(html.contains("<article data-myoxus-role="));
      assert!(html.contains("/theme.css?a=1&amp;b=2"));
      assert!(html.contains(renderer.public_css()));
    }
    assert_eq!(renderer.count(0, "fr-FR"), "0 document");
    assert_eq!(renderer.count(2, "de-DE"), "2 Dokumente");
    assert_eq!(renderer.count(1, "unknown"), "1 document");
    let workspace = uuid::Uuid::new_v4();
    let source = uuid::Uuid::new_v4();
    let document_path = crate::public_document_path(source, "café guide & notes?#");
    let folder_path = crate::public_folder_path(workspace, "folder & one");
    let introduction = crate::document_from_yjs(
      workspace,
      uuid::Uuid::new_v4(),
      "Introduction",
      "Page",
      &yjs::markdown_to_yjs(
        "Introduction",
        "## Native heading\n\nA **public** introduction.\n\n- First entry\n- Second entry",
      )
      .unwrap(),
    )
    .unwrap();
    let index = crate::WorkspaceIndex {
      document_count: 1,
      register_columns: vec!["title".into(), "updatedAt".into()],
      workspace_id: workspace,
      title: "<Title & \"owner\">".into(),
      introduction: Some(introduction),
      folders: vec![crate::WorkspaceIndexFolder {
        title: "<Folder & one>".into(),
        href: folder_path.clone(),
      }],
      items: vec![crate::WorkspaceIndexItem {
        register: std::collections::BTreeMap::from([(
          "updatedAt".into(),
          crate::WorkspaceRegisterValue::Timestamp(chrono::DateTime::from_timestamp(0, 0).unwrap()),
        )]),
        href: Some(document_path.clone()),
        doc_id: uuid::Uuid::new_v4(),
        route_key: "café guide & notes?#".into(),
        title: "<Guide & notes>".into(),
        public_mode: "Page".into(),
      }],
      ..Default::default()
    };
    let workspace_html = crate::render_workspace_index_html(renderer, &index, &options)
      .unwrap()
      .html;
    assert!(workspace_html.contains("<h1>&lt;Title &amp; &quot;owner&quot;&gt;</h1>"));
    assert!(workspace_html.contains("&lt;Folder &amp; one&gt;"));
    assert!(workspace_html.contains("Native heading") && workspace_html.contains("<strong>public</strong>"));
    assert!(workspace_html.contains("data-myoxus-role=\"public-list\""));
    assert!(workspace_html.contains(&document_path) && workspace_html.contains(&folder_path));
    assert!(document_path.ends_with("caf%C3%A9%20guide%20%26%20notes%3F%23"));
    assert!(folder_path.ends_with("?folder=folder+%26+one"));
    assert!(
      workspace_html.find("public-workspace-introduction").unwrap()
        < workspace_html.find("public-folder-link").unwrap()
    );
    assert!(workspace_html.find("public-folder-link").unwrap() < workspace_html.find("public-index-link").unwrap());
    assert!(!workspace_html.contains("&amp;lt;") && !workspace_html.contains("<aside class=\"mx-public-aside\""));
  }
  #[test]
  fn deployed_locale_files_keep_custom_copy_and_gain_additive_overview_labels() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
    let mut files: BTreeMap<String, Vec<u8>> = HTML_CATALOG_FILES
      .iter()
      .map(|name| (name.to_string(), std::fs::read(root.join(name)).unwrap()))
      .collect();
    for locale in ["en", "de", "fr", "es"] {
      let name = format!("i18n/{locale}.json");
      let mut labels: serde_json::Value = serde_json::from_slice(&files[&name]).unwrap();
      let object = labels.as_object_mut().unwrap();
      object.remove("introduction");
      object.remove("folders");
      object.insert(
        "public_workspace".into(),
        serde_json::Value::String(format!("Custom {locale}")),
      );
      if locale == "en" {
        object.insert("folders".into(), serde_json::Value::String("Custom chapters".into()));
      }
      files.insert(name, serde_json::to_vec(&labels).unwrap());
    }
    let renderer = HtmlRenderer::from_files(files).unwrap();
    for (locale, introduction, folders) in [
      ("en", "Introduction", "Custom chapters"),
      ("de", "Einleitung", "Ordner"),
      ("fr", "Introduction", "Dossiers"),
      ("es", "Introducción", "Carpetas"),
    ] {
      let labels = renderer.labels(locale);
      assert_eq!(labels.public_workspace, format!("Custom {locale}"));
      assert_eq!(labels.introduction, introduction);
      assert_eq!(labels.folders, folders);
    }
  }
}
