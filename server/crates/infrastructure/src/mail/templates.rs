// SPDX-License-Identifier: AGPL-3.0-or-later

use myoxus_application::ports::{MailTemplate, PortError, PortResult};
use scraper::{Html, Selector};
use serde_json::Value;
use std::{collections::HashMap, fs};
use tera::{Context, Tera};

pub const MAIL_LANGUAGES: [&str; 5] = ["en", "de", "fr", "es", "it"];

#[derive(Clone)]
pub struct InlineMailAsset {
  pub id: &'static str,
  pub content_type: &'static str,
  pub bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct MailTemplateRenderer {
  directory: String,
  tera: Tera,
  copy: HashMap<String, Value>,
  pub assets: Vec<InlineMailAsset>,
}

pub struct RenderedMail {
  pub subject: String,
  pub html: String,
  pub text: String,
}

impl MailTemplateRenderer {
  /// Resolved catalog path captured together with the immutable template bytes.
  pub fn directory(&self) -> &str {
    &self.directory
  }
  /// Load and validate the complete catalog once. Reloading requires an API restart.
  pub fn new(directory: &str) -> PortResult<Self> {
    let root = fs::canonicalize(directory)
      .map_err(|error| PortError::InvalidInput(format!("Mail root {directory}: {error}")))?;
    // All captured dependencies, including operator file links, must stay inside
    // this catalog. Resolve before reading so an external mount cannot leak bytes.
    let resolve = |relative: &str| -> PortResult<std::path::PathBuf> {
      let path = root.join(relative);
      let resolved = fs::canonicalize(&path)
        .map_err(|error| PortError::InvalidInput(format!("Mail file {}: {error}", path.display())))?;
      if !resolved.starts_with(&root) {
        return Err(PortError::InvalidInput(format!(
          "Mail file escapes mail root: {}",
          path.display()
        )));
      }
      Ok(resolved)
    };
    let mut files = vec![(resolve("_layout.html")?, Some("_layout.html".to_string()))];
    let mut copy = HashMap::new();
    for language in MAIL_LANGUAGES {
      let localized_copy = fs::read_to_string(resolve(&format!("{language}/_copy.json"))?)
        .map_err(|_| PortError::InvalidInput(format!("Missing mail copy: {language}/_copy.json")))?;
      let localized_copy: Value = serde_json::from_str(&localized_copy)
        .map_err(|_| PortError::InvalidInput(format!("Invalid mail copy: {language}/_copy.json")))?;
      for key in [
        "greeting",
        "fallbackLabel",
        "footer",
        "code",
        "actorFallback",
        "eventFallback",
        "documentFallback",
        "workspaceFallback",
        "rowFallback",
      ] {
        if localized_copy[key].as_str().is_none_or(|value| value.trim().is_empty()) {
          return Err(PortError::InvalidInput(format!(
            "Missing mail copy field: {language}/{key}"
          )));
        }
      }
      copy.insert(language.into(), localized_copy);
      for template in MailTemplate::ALL {
        let name = format!("{language}/{}.html", template.name());
        if !root.join(&name).is_file() {
          return Err(PortError::InvalidInput(format!("Missing mail template: {name}")));
        }
        files.push((resolve(&name)?, Some(name)));
      }
    }
    for (path, name) in &files {
      let source = fs::read_to_string(path)
        .map_err(|error| PortError::InvalidInput(format!("Mail file {}: {error}", path.display())))?;
      tera::Template::new(name.as_deref().expect("named mail template"), None, &source)
        .map_err(|_| PortError::InvalidInput(format!("Mail file {}: invalid Tera syntax", path.display())))?;
    }
    let mut tera = Tera::default();
    tera
      .add_template_files(files)
      .map_err(|_| PortError::InvalidInput("Mail catalog has missing files or invalid Tera syntax".into()))?;
    // Tera checks inheritance and macro imports when loading, but includes are
    // otherwise resolved only when sending. Validate their parsed dependencies
    // now so a missing required include cannot activate a broken catalog.
    for template in tera.templates.values() {
      validate_includes(&template.ast, &tera, &root.join(&template.name))?;
    }
    let mut assets = Vec::new();
    for (name, id, content_type) in [
      ("product-mark.png", "myoxus-mark", "image/png"),
      ("inter-regular-latin.woff2", "myoxus-inter-latin", "font/woff2"),
      ("inter-regular-latin-ext.woff2", "myoxus-inter-latin-ext", "font/woff2"),
    ] {
      assets.push(InlineMailAsset {
        id,
        content_type,
        bytes: fs::read(resolve(&format!("assets/{name}"))?)
          .map_err(|_| PortError::InvalidInput(format!("Missing mail asset: assets/{name}")))?,
      });
    }
    Ok(Self {
      directory: directory.into(),
      tera,
      copy,
      assets,
    })
  }

  pub fn language(locale: Option<&str>, default_locale: &str) -> &'static str {
    fn supported(value: &str) -> Option<&'static str> {
      let base = value.trim().split(['-', '_']).next().unwrap_or_default();
      MAIL_LANGUAGES
        .into_iter()
        .find(|language| base.eq_ignore_ascii_case(language))
    }
    locale
      .and_then(supported)
      .or_else(|| supported(default_locale))
      .unwrap_or("en")
  }

  /// The HTML title is the subject's authoring source; the text alternative is
  /// projected from visible semantic elements of the same rendered document.
  pub fn render(&self, template: MailTemplate, language: &str, data: &Value) -> PortResult<RenderedMail> {
    let name = format!("{language}/{}.html", template.name());
    let mut context = Context::from_value(data.clone())
      .map_err(|_| PortError::InvalidInput("Mail context must be an object".into()))?;
    context.insert("locale", language);
    context.insert(
      "copy",
      self
        .copy
        .get(language)
        .ok_or_else(|| PortError::InvalidInput("Unsupported mail language".into()))?,
    );
    if data["actor"].as_str().is_none_or(|value| value.trim().is_empty()) {
      context.insert("actor", &self.copy[language]["actorFallback"]);
    }
    for (field, copy_key) in [
      ("event_title", "eventFallback"),
      ("document_title", "documentFallback"),
      ("workspace_name", "workspaceFallback"),
      ("row_title", "rowFallback"),
    ] {
      if data[field].as_str().is_none_or(|value| value.trim().is_empty()) {
        context.insert(field, &self.copy[language][copy_key]);
      }
    }
    let html = self
      .tera
      .render(&name, &context)
      .map_err(|_| PortError::InvalidInput(format!("Mail template could not be rendered: {name}")))?;
    let document = Html::parse_document(&html);
    let subject = document
      .select(&Selector::parse("title").expect("constant title selector"))
      .next()
      .map(|element| {
        element
          .text()
          .collect::<String>()
          .split_whitespace()
          .collect::<Vec<_>>()
          .join(" ")
      })
      .filter(|subject| !subject.is_empty() && !subject.chars().any(char::is_control))
      .ok_or_else(|| PortError::InvalidInput(format!("Mail template needs a single-line title: {name}")))?;
    let text = document
      .select(
        &Selector::parse("h1, p, [data-mail-details], [data-mail-action], [data-mail-link]")
          .expect("constant mail text selector"),
      )
      .filter(|element| {
        !element
          .ancestors()
          .filter_map(scraper::ElementRef::wrap)
          .any(|parent| parent.value().attr("data-mail-details").is_some())
      })
      .map(|element| {
        element
          .text()
          .collect::<Vec<_>>()
          .join(" ")
          .split_whitespace()
          .collect::<Vec<_>>()
          .join(" ")
      })
      .filter(|text| !text.is_empty())
      .collect::<Vec<_>>()
      .join("\n\n");
    Ok(RenderedMail { subject, html, text })
  }

  pub fn role_name(&self, language: &str, role: &str) -> String {
    self
      .copy
      .get(language)
      .and_then(|copy| copy["roles"][role].as_str())
      .unwrap_or(role)
      .to_string()
  }
}

fn validate_includes(nodes: &[tera::ast::Node], tera: &Tera, path: &std::path::Path) -> PortResult<()> {
  use tera::ast::Node;
  for node in nodes {
    match node {
      Node::Include(_, names, ignore_missing) => {
        if !ignore_missing && !names.iter().any(|name| tera.templates.contains_key(name)) {
          return Err(PortError::InvalidInput(format!(
            "Mail file {}: missing required include {}",
            path.display(),
            names.join(", ")
          )));
        }
      }
      Node::Block(_, block, _) => validate_includes(&block.body, tera, path)?,
      Node::MacroDefinition(_, definition, _) => validate_includes(&definition.body, tera, path)?,
      Node::FilterSection(_, section, _) => validate_includes(&section.body, tera, path)?,
      Node::Forloop(_, body, _) => {
        validate_includes(&body.body, tera, path)?;
        if let Some(empty) = &body.empty_body {
          validate_includes(empty, tera, path)?;
        }
      }
      Node::If(condition, _) => {
        for (_, _, body) in &condition.conditions {
          validate_includes(body, tera, path)?;
        }
        if let Some((_, body)) = &condition.otherwise {
          validate_includes(body, tera, path)?;
        }
      }
      _ => {}
    }
  }
  Ok(())
}
