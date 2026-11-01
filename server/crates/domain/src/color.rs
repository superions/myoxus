// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared contrast policy for validated theme and document colours.

/// Choose the higher-contrast black/white foreground for a validated hex fill.
pub fn adaptive_foreground(background: &str) -> &'static str {
  let black = "#000000";
  let white = "#ffffff";
  if contrast_ratio(background, black).unwrap_or(0.0) >= contrast_ratio(background, white).unwrap_or(0.0) {
    black
  } else {
    white
  }
}

/// WCAG contrast for concrete RGB hex colours; unsupported values return None.
pub fn contrast_ratio(a: &str, b: &str) -> Option<f64> {
  let a = relative_luminance(a)?;
  let b = relative_luminance(b)?;
  let lighter = a.max(b);
  let darker = a.min(b);
  Some((lighter + 0.05) / (darker + 0.05))
}

fn relative_luminance(value: &str) -> Option<f64> {
  let (red, green, blue) = parse_hex_color(value)?;
  Some(0.2126 * linear_channel(red) + 0.7152 * linear_channel(green) + 0.0722 * linear_channel(blue))
}

fn linear_channel(value: f64) -> f64 {
  if value <= 0.03928 {
    value / 12.92
  } else {
    ((value + 0.055) / 1.055).powf(2.4)
  }
}

fn parse_hex_color(value: &str) -> Option<(f64, f64, f64)> {
  let hex = value.trim().strip_prefix('#')?;
  let expanded;
  let normalized = match hex.len() {
    3 if hex.chars().all(|ch| ch.is_ascii_hexdigit()) => {
      expanded = hex.chars().flat_map(|ch| [ch, ch]).collect::<String>();
      expanded.as_str()
    }
    6 if hex.chars().all(|ch| ch.is_ascii_hexdigit()) => hex,
    _ => return None,
  };
  let red = u8::from_str_radix(&normalized[0..2], 16).ok()? as f64 / 255.0;
  let green = u8::from_str_radix(&normalized[2..4], 16).ok()? as f64 / 255.0;
  let blue = u8::from_str_radix(&normalized[4..6], 16).ok()? as f64 / 255.0;
  Some((red, green, blue))
}
