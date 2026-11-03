// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Bounded application-side use of Wordcraft's existing formula converters.

use wordcraft_doc::{math::Math, math_latex};

const MAX_SOURCE_BYTES: usize = 8192;
const MAX_TOKENS: usize = 2048;
const MAX_STRUCTURES: usize = 24;

/// The converter is best-effort and can stop at its internal depth limit.
/// Refuse known expensive input before parsing; callers retain the whole source.
fn bounded_source(source: &str) -> bool {
  if source.trim().is_empty() || source.len() > MAX_SOURCE_BYTES {
    return false;
  }
  let mut braces = 0usize;
  let mut structures = 0usize;
  let mut tokens = 0usize;
  let mut chars = source.chars().peekable();
  while let Some(character) = chars.next() {
    tokens += 1;
    match character {
      '{' => {
        braces += 1;
        structures += 1;
      }
      '}' => {
        let Some(depth) = braces.checked_sub(1) else {
          return false;
        };
        braces = depth;
      }
      '^' | '_' => structures += 1,
      '\\' => {
        let mut command = String::new();
        while chars.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
          command.push(chars.next().unwrap());
        }
        if command.is_empty() {
          chars.next();
        } else {
          // Count all commands conservatively: unbraced command chains can
          // recurse just as deeply as nested groups (not only frac/sqrt).
          structures += 1;
        }
      }
      _ => {}
    }
    if tokens > MAX_TOKENS || structures > MAX_STRUCTURES {
      return false;
    }
  }
  braces == 0
}

pub(super) fn from_latex(source: &str) -> Option<Math> {
  if !bounded_source(source) {
    return None;
  }
  let nodes = math_latex::parse_latex(source);
  (!nodes.is_empty()).then_some(Math {
    nodes,
    ..Default::default()
  })
}

/// Inspect the already-read tree before invoking the recursive LaTeX writer.
/// This does not claim visibility into markup skipped by Wordcraft's reader.
pub(super) fn to_latex(math: &Math) -> Option<String> {
  let value = serde_json::to_value(&math.nodes).ok()?;
  let mut pending = vec![(&value, 0usize)];
  let mut count = 0usize;
  while let Some((value, depth)) = pending.pop() {
    count += 1;
    if count > 8192 || depth > 48 {
      return None;
    }
    match value {
      serde_json::Value::Object(fields) => pending.extend(fields.values().map(|value| (value, depth + 1))),
      serde_json::Value::Array(values) => pending.extend(values.iter().map(|value| (value, depth + 1))),
      _ => {}
    }
  }
  if math.nodes.is_empty() {
    return None;
  }
  let source = math_latex::to_latex(&math.nodes);
  bounded_source(&source).then_some(source)
}
