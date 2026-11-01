// SPDX-License-Identifier: AGPL-3.0-or-later
//! Locale primitives for the PDF-Export V2 render pipeline
//! (`P-PDF-TPL-LOC-01`).
//!
//! Three pure-Rust resolvers shared by the renderer and the
//! [`super::render_context::RenderContextBuilder`]:
//!
//! 1. [`parse_bcp47`] — validates a BCP-47 tag and rejects locales
//!    outside the Europe + Americas project scope
//!    (`feedback_locale_scope_europe_americas`). The spec mentions
//!    `unic-langid` but that crate is not in the offline registry —
//!    the parser here covers exactly what the project's manifest
//!    schema accepts.
//! 2. [`format_date`] — `iso` / `locale` / `custom`-pattern formatter
//!    with a small built-in locale matrix.
//! 3. [`format_number`] — locale-aware thousands + decimal separator
//!    (Typst has no native locale-aware number formatter, so we write
//!    one ourselves).
//! 4. [`quote_style`] — opening + closing quote glyphs per locale,
//!    typographically correct for the European subset.

use chrono::{DateTime, Datelike, Utc};
use thiserror::Error;

// ─── Allowed locale set ─────────────────────────────────────────────────────

/// Locales the project explicitly allows. Must be kept in sync with
/// `pdf_template_manifest_v2.json::CapabilityLanguage.values` — extending one
/// without the other will cause the manifest validator to reject templates
/// that quote the new locale.
pub const ALLOWED_LOCALES: &[&str] = &[
  "en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "da", "sv", "no", "fi", "el", "ru", "uk", "tr", "hu", "ro",
  "bg", "hr", "sk", "sl", "sr", "et", "lv", "lt", "pt-BR", "es-MX",
];

/// Locales the project explicitly bans (loud signal — silent acceptance of
/// these would later be hard to roll back). The set mirrors the
/// `feedback_locale_scope_europe_americas.md` rule.
pub const BANNED_LOCALES: &[&str] = &["zh", "ja", "ko", "ar", "he", "th", "vi"];

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LocaleError {
  #[error("locale tag is empty")]
  Empty,
  #[error("locale tag `{0}` is not a well-formed BCP-47 subtag")]
  Malformed(String),
  #[error("locale `{0}` is outside the Europe + Americas project scope")]
  OutOfScope(String),
}

/// Parse and validate a BCP-47 tag. Returns the canonical lowercase form on
/// success — the language subtag is lowercased, the optional region subtag
/// stays uppercase (per BCP-47).
///
/// Accepted shapes: `en`, `de`, `pt-BR`, `es-MX`. The tag is rejected if
/// it carries extlang / script / variant subtags (the project's manifest
/// schema does not allow those) or if it falls outside [`ALLOWED_LOCALES`].
pub fn parse_bcp47(tag: &str) -> Result<String, LocaleError> {
  let raw = tag.trim();
  if raw.is_empty() {
    return Err(LocaleError::Empty);
  }
  // Reject control / weird characters early.
  if !raw.chars().all(|c| c.is_ascii_alphabetic() || c == '-') {
    return Err(LocaleError::Malformed(raw.to_owned()));
  }

  let parts: Vec<&str> = raw.split('-').collect();
  let canonical = match parts.as_slice() {
    [lang] if (2..=3).contains(&lang.len()) => lang.to_ascii_lowercase(),
    [lang, region] if (2..=3).contains(&lang.len()) && region.len() == 2 => {
      format!("{}-{}", lang.to_ascii_lowercase(), region.to_ascii_uppercase())
    }
    _ => return Err(LocaleError::Malformed(raw.to_owned())),
  };

  // Strict allow-list. Banned locales raise the OutOfScope error explicitly
  // so the operator sees the project-rule reference; everything else just
  // says "not in scope".
  if BANNED_LOCALES
    .iter()
    .any(|b| *b == canonical || canonical.split_once('-').map(|(l, _)| l) == Some(*b))
  {
    return Err(LocaleError::OutOfScope(canonical));
  }
  if ALLOWED_LOCALES.contains(&canonical.as_str()) {
    return Ok(canonical);
  }
  // Narrow → broad fallback: `de-AT` is not in the allow-list literally,
  // but we accept it if the broader `de` is. This lets the manifest
  // validate cleanly while admins can still pick regional variants for
  // date/number formatting purposes.
  if let Some((base, _)) = canonical.split_once('-')
    && ALLOWED_LOCALES.contains(&base)
  {
    return Ok(canonical);
  }
  Err(LocaleError::OutOfScope(canonical))
}

// ─── Date formatting ─────────────────────────────────────────────────────────

/// Date format spec for the renderer. Mirrors the wording in the spec
/// — `iso`, `locale`, and `custom` with a chrono pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DateFormat<'a> {
  /// `2026-04-29` — always the canonical ISO-8601 date.
  Iso,
  /// `29.04.2026` (de) / `April 29, 2026` (en-US) — locale-driven.
  Locale,
  /// User-supplied chrono pattern (e.g. `"%Y/%m/%d"`).
  Custom(&'a str),
}

/// Format a `DateTime<Utc>` as a plain date string.
///
/// `locale` is the BCP-47 tag that drives the `Locale` variant. Unknown
/// locales fall back to ISO so the renderer never panics.
pub fn format_date(dt: DateTime<Utc>, format: DateFormat<'_>, locale: &str) -> String {
  match format {
    DateFormat::Iso => dt.format("%Y-%m-%d").to_string(),
    DateFormat::Custom(pat) => dt.format(pat).to_string(),
    DateFormat::Locale => format_date_locale(dt, locale),
  }
}

/// Locale matrix for the `Locale` date format. The set is small on purpose
/// — calendar conventions in the project's scope cluster around three
/// patterns (DMY, MDY, YMD), so a hand-rolled lookup beats pulling in
/// `icu_locid` for an offline build.
fn format_date_locale(dt: DateTime<Utc>, locale: &str) -> String {
  let base = locale.split('-').next().unwrap_or(locale);
  let (day, month, year) = (dt.day(), dt.month(), dt.year());
  match (locale, base) {
    // North-American English: `April 29, 2026`.
    ("en-US", _) => format!("{} {}, {year}", english_month(month), day),
    // British / generic English: `29 April 2026`.
    (_, "en") => format!("{day} {} {year}", english_month(month)),
    // German, Polish, Czech, Slovak, Slovenian, Croatian, Serbian, Romanian,
    // Hungarian, Bulgarian: dd.MM.yyyy.
    (_, "de")
    | (_, "pl")
    | (_, "cs")
    | (_, "sk")
    | (_, "sl")
    | (_, "hr")
    | (_, "sr")
    | (_, "ro")
    | (_, "hu")
    | (_, "bg") => format!("{day:02}.{month:02}.{year}"),
    // French, Italian, Spanish, Portuguese, Dutch, Greek, Russian, Ukrainian,
    // Turkish, Estonian, Latvian, Lithuanian, Danish, Swedish, Norwegian,
    // Finnish: dd/MM/yyyy.
    (_, "fr")
    | (_, "it")
    | (_, "es")
    | (_, "pt")
    | (_, "nl")
    | (_, "el")
    | (_, "ru")
    | (_, "uk")
    | (_, "tr")
    | (_, "et")
    | (_, "lv")
    | (_, "lt")
    | (_, "da")
    | (_, "sv")
    | (_, "no")
    | (_, "fi") => {
      format!("{day:02}/{month:02}/{year}")
    }
    // Unknown locale: fall back to ISO so the render keeps going.
    _ => dt.format("%Y-%m-%d").to_string(),
  }
}

fn english_month(m: u32) -> &'static str {
  match m {
    1 => "January",
    2 => "February",
    3 => "March",
    4 => "April",
    5 => "May",
    6 => "June",
    7 => "July",
    8 => "August",
    9 => "September",
    10 => "October",
    11 => "November",
    12 => "December",
    _ => "",
  }
}

// ─── Number formatting ───────────────────────────────────────────────────────

/// Locale-aware thousands + decimal separators. Typst has no native
/// locale-aware number formatter, so we provide our own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NumberFormat {
  pub thousands_sep: &'static str,
  pub decimal_sep: &'static str,
}

impl NumberFormat {
  /// Resolve the numeric format for a BCP-47 tag. Falls back to the
  /// "no separator + dot" baseline (matches the en locale) for unknown
  /// tags so the render keeps going.
  pub fn for_locale(locale: &str) -> Self {
    let base = locale.split('-').next().unwrap_or(locale);
    match (locale, base) {
      // ── Specific regional overrides go FIRST so they win over their base
      //    arm. Mexican Spanish keeps the en-US-style `1,234.56` for parity
      //    with North-American business documents in the project's bilingual
      //    workspaces. Brazilian Portuguese uses the same convention as
      //    European Portuguese (decimal-comma + dot-thousands).
      ("es-MX", _) => NumberFormat {
        thousands_sep: ",",
        decimal_sep: ".",
      },
      // Decimal-comma + space-thousands group.
      (_, "fr")
      | (_, "ru")
      | (_, "uk")
      | (_, "fi")
      | (_, "sv")
      | (_, "no")
      | (_, "cs")
      | (_, "sk")
      | (_, "pl")
      | (_, "lv")
      | (_, "lt")
      | (_, "et") => NumberFormat {
        thousands_sep: "\u{202F}",
        decimal_sep: ",",
      },
      // Decimal-comma + dot-thousands group.
      (_, "de")
      | (_, "es")
      | (_, "pt")
      | (_, "it")
      | (_, "nl")
      | (_, "el")
      | (_, "tr")
      | (_, "hu")
      | (_, "ro")
      | (_, "bg")
      | (_, "hr")
      | (_, "sr")
      | (_, "sl")
      | (_, "da") => NumberFormat {
        thousands_sep: ".",
        decimal_sep: ",",
      },
      // English default: dot decimal + comma thousands.
      _ => NumberFormat {
        thousands_sep: ",",
        decimal_sep: ".",
      },
    }
  }

  /// Format an `f64` with this number format. Negative numbers are
  /// prefixed with `-`; NaN and infinity round-trip via Rust's debug
  /// formatter so the render doesn't deadlock on them.
  pub fn format_f64(&self, n: f64, fractional_digits: usize) -> String {
    if !n.is_finite() {
      return format!("{n}");
    }
    let negative = n.is_sign_negative();
    let abs = n.abs();
    let int_part = abs.trunc() as u64;
    let raw_int = format!("{int_part}");
    let chars: Vec<char> = raw_int.chars().collect();
    // Group from the right in chunks of three.
    let mut grouped = String::new();
    for (idx, c) in chars.iter().enumerate() {
      if idx > 0 && (chars.len() - idx).is_multiple_of(3) {
        grouped.push_str(self.thousands_sep);
      }
      grouped.push(*c);
    }
    let mut out = if negative { format!("-{grouped}") } else { grouped };
    if fractional_digits > 0 {
      let scale = 10f64.powi(fractional_digits as i32);
      let frac = (abs.fract() * scale).round() as u64;
      out.push_str(self.decimal_sep);
      out.push_str(&format!("{frac:0width$}", width = fractional_digits));
    }
    out
  }
}

// ─── Quote style ─────────────────────────────────────────────────────────────

/// Opening and closing quote glyphs for the locale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuoteStyle {
  pub opening: &'static str,
  pub closing: &'static str,
}

impl QuoteStyle {
  /// Resolve the typographically-correct quote pair for a BCP-47 tag.
  /// `auto` (or unknown locales) maps to the baseline curly-double-quote
  /// pair `“ ”` matching English / many Latin scripts.
  pub fn for_locale(locale: &str) -> Self {
    let base = locale.split('-').next().unwrap_or(locale);
    match (locale, base) {
      // German, Czech, Slovak: low-9 + high-66.
      (_, "de") | (_, "cs") | (_, "sk") => Self {
        opening: "„",
        closing: "“",
      },
      // French, Russian, Spanish, Italian, Greek, Ukrainian, Bulgarian,
      // Croatian: guillemets.
      (_, "fr") | (_, "ru") | (_, "es") | (_, "it") | (_, "el") | (_, "uk") | (_, "bg") | (_, "hr") => Self {
        opening: "«",
        closing: "»",
      },
      // Polish: low-9 + high-66 (same shape as German but distinct meaning
      // historically).
      (_, "pl") => Self {
        opening: "„",
        closing: "”",
      },
      // English / Portuguese / Dutch / Scandinavian etc. — curly doubles.
      _ => Self {
        opening: "“",
        closing: "”",
      },
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::TimeZone;

  /// `INV-LOC-01` (`P-PDF-TPL-LOC-01-06`): `de-AT` is accepted via the
  /// narrow→broad fallback (the explicit allow-list does not list `de-AT`
  /// but does list `de`).
  #[test]
  fn inv_loc01_de_at_accepted_via_broad_fallback() {
    let canonical = parse_bcp47("de-AT").expect("ok");
    assert_eq!(canonical, "de-AT");
  }

  /// `INV-LOC-02` (`P-PDF-TPL-LOC-01-07`): `zh` is rejected with a clear
  /// `OutOfScope` error referencing the project rule.
  #[test]
  fn inv_loc02_zh_locale_rejected() {
    let err = parse_bcp47("zh").expect_err("expected rejection");
    assert!(matches!(err, LocaleError::OutOfScope(s) if s == "zh"));
    let err = parse_bcp47("zh-CN").expect_err("expected rejection");
    assert!(matches!(err, LocaleError::OutOfScope(s) if s == "zh-CN"));
  }

  /// `INV-LOC-03` (`P-PDF-TPL-LOC-01-08`): the canonical English allow-
  /// list path keeps working — no false negatives.
  #[test]
  fn inv_loc03_english_canonical_passes() {
    assert_eq!(parse_bcp47("en").expect("ok"), "en");
    assert_eq!(parse_bcp47("EN").expect("ok"), "en");
    assert_eq!(parse_bcp47("en-US").expect("ok"), "en-US");
  }

  /// Malformed tags (numbers, weird separators) are caught.
  #[test]
  fn malformed_inputs_rejected() {
    assert!(matches!(parse_bcp47(""), Err(LocaleError::Empty)));
    assert!(matches!(parse_bcp47("12"), Err(LocaleError::Malformed(_))));
    assert!(matches!(parse_bcp47("en_US"), Err(LocaleError::Malformed(_))));
    assert!(matches!(parse_bcp47("en-USA"), Err(LocaleError::Malformed(_))));
  }

  fn april_29() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 4, 29, 12, 0, 0).unwrap()
  }

  #[test]
  fn date_iso_is_canonical() {
    assert_eq!(format_date(april_29(), DateFormat::Iso, "en"), "2026-04-29");
  }

  #[test]
  fn date_locale_de_uses_dotted_dmy() {
    assert_eq!(format_date(april_29(), DateFormat::Locale, "de"), "29.04.2026");
    assert_eq!(format_date(april_29(), DateFormat::Locale, "de-AT"), "29.04.2026");
  }

  #[test]
  fn date_locale_en_us_uses_month_first() {
    assert_eq!(format_date(april_29(), DateFormat::Locale, "en-US"), "April 29, 2026");
    assert_eq!(format_date(april_29(), DateFormat::Locale, "en"), "29 April 2026");
  }

  #[test]
  fn date_custom_pattern() {
    assert_eq!(
      format_date(april_29(), DateFormat::Custom("%Y/%m/%d"), "en"),
      "2026/04/29"
    );
  }

  #[test]
  fn number_format_de_uses_dot_comma() {
    let f = NumberFormat::for_locale("de");
    assert_eq!(f.format_f64(1234567.89, 2), "1.234.567,89");
  }

  #[test]
  fn number_format_en_uses_comma_dot() {
    let f = NumberFormat::for_locale("en");
    assert_eq!(f.format_f64(1234567.89, 2), "1,234,567.89");
  }

  #[test]
  fn number_format_fr_uses_nbsp_comma() {
    let f = NumberFormat::for_locale("fr");
    // Narrow no-break space (U+202F) between groups.
    let formatted = f.format_f64(1234567.89, 2);
    assert!(
      formatted.contains('\u{202F}'),
      "expected NNBSP separator: {formatted:?}"
    );
    assert!(formatted.ends_with(",89"));
  }

  #[test]
  fn number_format_es_mx_keeps_en_us_style() {
    let f = NumberFormat::for_locale("es-MX");
    assert_eq!(f.format_f64(1234567.89, 2), "1,234,567.89");
  }

  #[test]
  fn number_format_negative_and_no_fraction() {
    let f = NumberFormat::for_locale("de");
    assert_eq!(f.format_f64(-42.0, 0), "-42");
    assert_eq!(f.format_f64(0.0, 0), "0");
  }

  #[test]
  fn quote_style_de() {
    let q = QuoteStyle::for_locale("de");
    assert_eq!(q.opening, "„");
    assert_eq!(q.closing, "“");
  }

  #[test]
  fn quote_style_fr_uses_guillemets() {
    let q = QuoteStyle::for_locale("fr");
    assert_eq!(q.opening, "«");
    assert_eq!(q.closing, "»");
  }

  #[test]
  fn quote_style_default_curly_doubles() {
    let q = QuoteStyle::for_locale("en");
    assert_eq!(q.opening, "“");
    assert_eq!(q.closing, "”");
  }
}
