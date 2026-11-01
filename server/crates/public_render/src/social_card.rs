use std::{collections::BTreeMap, sync::Arc};
pub use usvg::fontdb::Database as SocialCardFonts;

use crate::HtmlRenderer;
use serde::Serialize;
use tera::Context;
use tiny_skia::Pixmap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocialCardInput<'a> {
  pub title: &'a str,
  pub subtitle: &'a str,
  pub brand: &'a str,
  pub theme: SocialCardTheme,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SocialCardTheme {
  pub background_start: String,
  pub background_end: String,
  pub surface: String,
  pub border: String,
  pub primary: String,
  pub secondary: String,
  pub text: String,
  pub muted: String,
  pub mark_text: String,
  pub font_family: String,
}

impl Default for SocialCardTheme {
  fn default() -> Self {
    Self {
      background_start: "#f8fafc".to_string(),
      background_end: "#e5edf7".to_string(),
      surface: "#ffffff".to_string(),
      border: "#c8d2df".to_string(),
      primary: "#1c5fb8".to_string(),
      secondary: "#0a6dca".to_string(),
      text: "#172033".to_string(),
      muted: "#526173".to_string(),
      mark_text: "M".to_string(),
      font_family: "Inter, system-ui, sans-serif".to_string(),
    }
  }
}

impl SocialCardTheme {
  /// Project server-owned theme colors into the browser-free Open Graph card.
  ///
  /// The renderer accepts only normalized `#rrggbb` color values here. Invalid
  /// or missing values fall back to deterministic defaults so a broken custom
  /// theme cannot produce invalid SVG or abort a full render batch.
  pub fn from_theme_colors(colors: &BTreeMap<String, BTreeMap<String, String>>, brand: &str) -> Self {
    let defaults = Self::default();
    let light = colors.get("light").or_else(|| colors.values().next());
    let pick = |key: &str, fallback: &str| {
      light
        .and_then(|values| values.get(key))
        .and_then(|value| normalize_hex_color(value))
        .unwrap_or_else(|| fallback.to_string())
    };

    Self {
      background_start: pick("paper", &defaults.background_start),
      background_end: pick("paper-deep", &defaults.background_end),
      surface: pick("paper", &defaults.surface),
      border: pick("rule", &defaults.border),
      primary: pick("accent-primary", &defaults.primary),
      secondary: pick("accent-secondary", &defaults.secondary),
      text: pick("ink", &defaults.text),
      muted: pick("ink-soft", &defaults.muted),
      mark_text: operator_mark_text(brand),
      font_family: defaults.font_family,
    }
  }
}

/// Render a deterministic PNG Open Graph card without a browser runtime.
pub fn render_social_card_png(
  renderer: &HtmlRenderer,
  input: &SocialCardInput<'_>,
  fonts: Arc<SocialCardFonts>,
) -> Result<Vec<u8>, String> {
  let family = input
    .theme
    .font_family
    .split(',')
    .next()
    .unwrap_or("")
    .trim()
    .trim_matches(['\'', '"']);
  if !fonts
    .faces()
    .any(|face| face.families.iter().any(|(name, _)| name == family))
  {
    return Err("social-card font family is unavailable".into());
  }
  rasterize_social_card(renderer, input, fonts)
}

fn rasterize_social_card(
  renderer: &HtmlRenderer,
  input: &SocialCardInput<'_>,
  fonts: Arc<SocialCardFonts>,
) -> Result<Vec<u8>, String> {
  let validating_catalog = fonts.is_empty();
  let options = usvg::Options {
    font_resolver: if validating_catalog {
      // Catalog validation exercises SVG/context/dimension contracts. The CLI
      // separately supplies and validates its registered theme fonts.
      usvg::FontResolver {
        select_font: Box::new(|_, _| None),
        select_fallback: Box::new(|_, _, _| None),
      }
    } else {
      usvg::FontResolver::default()
    },
    fontdb: fonts,
    image_href_resolver: usvg::ImageHrefResolver {
      resolve_string: Box::new(|_, _| None),
      resolve_data: Box::new(|_, _, _| None),
    },
    ..usvg::Options::default()
  };
  // Character counts alone cannot protect variable-font glyph bounds. Reflow
  // at most 44 times; retain the existing 58px type, three lines and card frame.
  for max_chars in (1..=44).rev() {
    let svg = social_card_svg(renderer, input, max_chars)?;
    let tree = usvg::Tree::from_str(&svg, &options).map_err(|err| format!("parse social-card svg: {err}"))?;
    let size = tree.size().to_int_size();
    if size.width() != 1200 || size.height() != 630 {
      return Err("social-card dimensions must remain 1200×630".into());
    }
    if !validating_catalog {
      let mut bounds = Vec::new();
      collect_title_bounds(tree.root(), &mut bounds);
      if bounds.is_empty() {
        return Err("social-card title did not produce glyphs".into());
      }
      if bounds
        .iter()
        .any(|b| b.left() < 88.0 || b.top() < 190.0 || b.bottom() > 430.0)
      {
        return Err("social-card title placement exceeds protected bounds".into());
      }
      if bounds.iter().any(|b| b.right() > 1112.0) {
        continue;
      }
    }
    let mut pixmap = Pixmap::new(size.width(), size.height()).ok_or("allocate social-card pixmap")?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    return pixmap
      .encode_png()
      .map_err(|err| format!("encode social-card png: {err}"));
  }
  Err("social-card title cannot fit protected bounds".into())
}

fn collect_title_bounds(group: &usvg::Group, bounds: &mut Vec<tiny_skia::Rect>) {
  for node in group.children() {
    match node {
      usvg::Node::Group(group) => collect_title_bounds(group, bounds),
      usvg::Node::Text(text) if text.id().starts_with("social-title-") => {
        bounds.push(text.flattened().abs_bounding_box())
      }
      _ => {}
    }
  }
}

fn social_card_svg(renderer: &HtmlRenderer, input: &SocialCardInput<'_>, max_chars: usize) -> Result<String, String> {
  #[derive(Serialize)]
  struct TitleLine {
    y: usize,
    text: String,
  }
  let labels = renderer.labels("en");
  let title = if input.title.split_whitespace().next().is_none() {
    &labels.social_untitled
  } else {
    input.title
  };
  let title_lines: Vec<_> = wrap_svg_text(title, max_chars, 3)
    .into_iter()
    .enumerate()
    .map(|(index, text)| TitleLine {
      y: 250 + index * 72,
      text,
    })
    .collect();
  let mut context = Context::new();
  context.insert("title_lines", &title_lines);
  context.insert("subtitle", &truncate_svg_text(input.subtitle, 96));
  context.insert("brand", &truncate_svg_text(input.brand, 40));
  context.insert("theme", &input.theme);
  context.insert("footer", &labels.social_footer);
  let svg = renderer.render("social_card.svg.tera", &context)?;
  if svg.len() > 1024 * 1024 {
    return Err("social-card SVG exceeds byte limit".into());
  }
  Ok(svg)
}

pub(crate) fn validate_catalog(renderer: &HtmlRenderer) -> Result<(), String> {
  for title in [
    "",
    "<Catalog & title> with several words exercising the next title line and the third title line without unbounded input",
  ] {
    rasterize_social_card(
      renderer,
      &SocialCardInput {
        title,
        subtitle: "<Subtitle & value>",
        brand: "<Brand & owner>",
        theme: SocialCardTheme::default(),
      },
      Arc::new(SocialCardFonts::new()),
    )?;
  }
  Ok(())
}

fn wrap_svg_text(value: &str, max_chars: usize, max_lines: usize) -> Vec<String> {
  let mut lines = Vec::new();
  let mut current = String::new();
  for word in value.split_whitespace() {
    let projected = if current.is_empty() {
      word.chars().count()
    } else {
      current.chars().count() + 1 + word.chars().count()
    };
    if projected > max_chars && !current.is_empty() {
      lines.push(current);
      current = String::new();
      if lines.len() == max_lines {
        break;
      }
    }
    if !current.is_empty() {
      current.push(' ');
    }
    current.push_str(&truncate_svg_text(word, max_chars));
  }
  if !current.is_empty() && lines.len() < max_lines {
    lines.push(current);
  }
  if lines.is_empty() {
    lines.push(String::new());
  }
  if lines.len() == max_lines
    && value.split_whitespace().collect::<Vec<_>>().join(" ").len() > lines.join(" ").len()
    && let Some(last) = lines.last_mut()
  {
    *last = truncate_svg_text(last, max_chars.saturating_sub(3));
    last.push_str("...");
  }
  lines
}

fn truncate_svg_text(value: &str, max_chars: usize) -> String {
  let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.chars().count() <= max_chars {
    return normalized;
  }
  let mut out = normalized.chars().take(max_chars.saturating_sub(3)).collect::<String>();
  out.push_str("...");
  out
}

fn normalize_hex_color(value: &str) -> Option<String> {
  let trimmed = value.trim();
  let hex = trimmed.strip_prefix('#')?;
  if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return None;
  }
  Some(format!("#{hex}").to_ascii_lowercase())
}

fn operator_mark_text(brand: &str) -> String {
  let words = brand
    .split(|character: char| !character.is_alphanumeric())
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>();
  let mut mark = String::new();
  for word in words.iter().take(2) {
    if let Some(character) = word.chars().next() {
      mark.extend(character.to_uppercase());
    }
  }
  if mark.is_empty() {
    "M".to_string()
  } else {
    mark.chars().take(2).collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn social_card_theme_projects_server_theme_colors_and_operator_mark() {
    let mut light = BTreeMap::new();
    light.insert("paper".to_string(), "#FFFFFF".to_string());
    light.insert("paper-deep".to_string(), "#F3F3F5".to_string());
    light.insert("rule".to_string(), "#E5DFD3".to_string());
    light.insert("ink".to_string(), "#1F2330".to_string());
    light.insert("ink-soft".to_string(), "#4B5363".to_string());
    light.insert("accent-primary".to_string(), "#7D2841".to_string());
    light.insert("accent-secondary".to_string(), "#1F3A52".to_string());
    let mut colors = BTreeMap::new();
    colors.insert("light".to_string(), light);

    let theme = SocialCardTheme::from_theme_colors(&colors, "Acme Knowledge");
    let svg = social_card_svg(
      &crate::catalog::test_renderer(),
      &SocialCardInput {
        title: "Card",
        subtitle: "Workspace",
        brand: "Acme Knowledge",
        theme,
      },
      44,
    )
    .unwrap();

    assert!(svg.contains("#7d2841"));
    assert!(svg.contains("#1f3a52"));
    assert!(svg.contains(">AK</text>"));
  }

  #[test]
  fn social_card_theme_ignores_invalid_custom_colors() {
    let mut light = BTreeMap::new();
    light.insert("accent-primary".to_string(), "url(javascript:alert(1))".to_string());
    let mut colors = BTreeMap::new();
    colors.insert("light".to_string(), light);

    let theme = SocialCardTheme::from_theme_colors(&colors, "Myoxus");

    assert_eq!(theme.primary, SocialCardTheme::default().primary);
  }
}

#[cfg(test)]
mod raster_contract_tests {
  use super::*;

  #[test]
  fn long_translated_titles_fit_actual_raster_bounds_without_changing_the_frame() {
    let renderer = crate::catalog::test_renderer();
    let mut fonts = SocialCardFonts::new();
    fonts.load_font_data(include_bytes!("../../../static/fonts/inter-vf.ttf").to_vec());
    let fonts = Arc::new(fonts);
    for title in ["Premiers pas · Créer un document utile".to_string(), "W".repeat(200)] {
      let png = render_social_card_png(
        renderer,
        &SocialCardInput {
          title: &title,
          subtitle: "Workspace",
          brand: "Myoxus",
          theme: SocialCardTheme::default(),
        },
        fonts.clone(),
      )
      .unwrap();
      let pixels = image::load_from_memory(&png).unwrap().to_rgba8();
      assert_eq!(pixels.dimensions(), (1200, 630));
      let glyphs: Vec<_> = pixels
        .enumerate_pixels()
        .filter_map(|(x, y, color)| {
          ((190..430).contains(&y) && color.0[..3].iter().all(|v| *v < 100)).then_some((x, y))
        })
        .collect();
      assert!(!glyphs.is_empty());
      let left = glyphs.iter().map(|p| p.0).min().unwrap();
      let right = glyphs.iter().map(|p| p.0).max().unwrap();
      assert!(
        left >= 88 && right <= 1112,
        "actual title raster bounds {left}..{right}"
      );
    }
  }

  #[test]
  fn title_changes_real_glyph_pixels_inside_the_protected_card_geometry() {
    let renderer = crate::catalog::test_renderer();
    let mut fonts = SocialCardFonts::new();
    fonts.load_font_data(include_bytes!("../../../static/fonts/inter-vf.ttf").to_vec());
    let fonts = Arc::new(fonts);
    let first = SocialCardInput {
      title: "Captured title one",
      subtitle: "Workspace",
      brand: "Myoxus",
      theme: SocialCardTheme::default(),
    };
    assert!(render_social_card_png(renderer, &first, Arc::new(SocialCardFonts::new())).is_err());
    let second = SocialCardInput {
      title: "Captured title two",
      ..first.clone()
    };
    let first = image::load_from_memory(&render_social_card_png(renderer, &first, fonts.clone()).unwrap())
      .unwrap()
      .to_rgba8();
    let second = image::load_from_memory(&render_social_card_png(renderer, &second, fonts).unwrap())
      .unwrap()
      .to_rgba8();
    assert_eq!(first.dimensions(), (1200, 630));
    assert_eq!(second.dimensions(), first.dimensions());
    let changes: Vec<_> = first
      .enumerate_pixels()
      .filter_map(|(x, y, pixel)| (pixel != second.get_pixel(x, y)).then_some((x, y)))
      .collect();
    assert!(!changes.is_empty(), "the title must actually survive rasterization");
    let bounds = (
      changes.iter().map(|p| p.0).min().unwrap(),
      changes.iter().map(|p| p.1).min().unwrap(),
      changes.iter().map(|p| p.0).max().unwrap(),
      changes.iter().map(|p| p.1).max().unwrap(),
    );
    assert!(
      bounds.0 >= 88 && bounds.2 <= 1112 && bounds.1 >= 190 && bounds.3 <= 430,
      "measured changed glyph bounds: {bounds:?}"
    );
  }
}
