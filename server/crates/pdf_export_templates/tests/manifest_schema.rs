// SPDX-License-Identifier: AGPL-3.0-or-later
//! Manifest schema validation tests.
//!
//! Mikropaket P-PDF-TPL-02. Verifies that:
//!   * the JSON Schema (`schema/pdf_template_manifest_v2.json`) is well-formed JSON;
//!   * each bundled seed manifest validates against it;
//!   * a manifest with a wrong `schema_version` is rejected (invariant: const "2.0");
//!   * a manifest with an unknown top-level key is rejected
//!     (invariant: D2 — additionalProperties:false everywhere).
//!
//! Test format follows the project rule "invariant-first testing": each test
//! asserts a documented invariant from the schema, not just liveness.
//!
//! ## Validator implementation note
//!
//! The original Mikropaket spec asked for the `jsonschema = "0.18"` crate.
//! In this build environment crates.io is not reachable and several of
//! `jsonschema-0.18`'s transitive dependencies (`fraction`, `iso8601`,
//! `num-cmp`) are not cached locally, so adding the crate would prevent
//! the workspace from resolving offline. To still verify the schema
//! invariants we ship a minimal, in-test JSON-Schema validator that covers
//! exactly the constructs our manifest schema uses (`type`, `const`,
//! `enum`, `pattern`, `min/maxLength`, `min/maxItems`, `uniqueItems`,
//! `properties`, `required`, `additionalProperties:false`, `$ref`/`$defs`,
//! `items`, `minProperties`, `minimum`/`maximum`). The validator is
//! deterministic and pure — no network, no extra deps beyond `serde_json`,
//! which is already in the workspace. The spec deviation is recorded in
//! the agent's final report.

use std::path::{Path, PathBuf};

use serde_json::Value;

// ─── Test entry points ──────────────────────────────────────────────────────

fn crate_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &Path) -> Value {
  let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
  serde_json::from_str(&raw).unwrap_or_else(|e| panic!("file {} is not valid JSON: {e}", path.display()))
}

fn schema_root() -> Value {
  read_json(&crate_root().join("schema/pdf_template_manifest_v2.json"))
}

fn manifest_path(slug: &str) -> PathBuf {
  crate_root()
    .join("../../templates/pdf")
    .join(slug)
    .join("manifest.json")
}

fn assert_valid(schema: &Value, instance: &Value, label: &str) {
  let mut errs = Vec::new();
  validate(schema, schema, instance, "", &mut errs);
  if !errs.is_empty() {
    panic!("{label} expected to validate but failed:\n  - {}", errs.join("\n  - "));
  }
}

fn assert_invalid(schema: &Value, instance: &Value, label: &str) {
  let mut errs = Vec::new();
  validate(schema, schema, instance, "", &mut errs);
  assert!(!errs.is_empty(), "{label} expected to FAIL validation but succeeded");
}

/// Invariant: the schema is itself valid JSON and declares Draft 2020-12.
#[test]
fn inv_schema_is_valid_json_draft_2020_12() {
  let schema = schema_root();
  let dollar_schema = schema
    .get("$schema")
    .and_then(Value::as_str)
    .expect("schema must declare $schema");
  assert_eq!(
    dollar_schema, "https://json-schema.org/draft/2020-12/schema",
    "schema must target Draft 2020-12"
  );
  // Also ensure top-level enforces additionalProperties:false.
  assert_eq!(
    schema.get("additionalProperties"),
    Some(&Value::Bool(false)),
    "top-level schema must set additionalProperties:false (D2)"
  );
}

/// Invariant: the `default` seed manifest validates against the V2 schema.
#[test]
fn inv_seed_default_validates() {
  let schema = schema_root();
  let manifest = read_json(&manifest_path("default"));
  assert_valid(&schema, &manifest, "default manifest");
}

/// Invariant: the `report` seed manifest validates against the V2 schema.
#[test]
fn inv_seed_report_validates() {
  let schema = schema_root();
  let manifest = read_json(&manifest_path("report"));
  assert_valid(&schema, &manifest, "report manifest");
}

/// Invariant: the `letter` seed manifest validates against the V2 schema.
#[test]
fn inv_seed_letter_validates() {
  let schema = schema_root();
  let manifest = read_json(&manifest_path("letter"));
  assert_valid(&schema, &manifest, "letter manifest");
}

#[test]
fn inv_documentation_input_date_format_is_closed() {
  let schema = schema_root();
  let mut manifest = read_json(&manifest_path("myoxus-doc"));
  assert_valid(&schema, &manifest, "documentation ISO date input");
  manifest["inputs_schema"]["properties"]["report_date"]["format"] = serde_json::json!("date-time");
  assert_invalid(&schema, &manifest, "unsupported typed input format");
}

/// Capability subsets stay closed and nonempty; disabled labels use a zero limit.
#[test]
fn inv_capability_subsets_reject_unknown_or_empty_values_and_excess_labels() {
  let schema = schema_root();
  for capability in [
    "colorVariant",
    "headerStyle",
    "footerStyle",
    "tocBehavior",
    "pageNumbering",
  ] {
    for values in [serde_json::json!([]), serde_json::json!(["unsupported"])] {
      let mut manifest = read_json(&manifest_path("myoxus-doc"));
      manifest["capabilities"][capability]["values"] = values;
      assert_invalid(&schema, &manifest, capability);
    }
  }
  let mut manifest = read_json(&manifest_path("myoxus-doc"));
  manifest["capabilities"]["confidentialityLabels"]["max_items"] = serde_json::json!(9);
  assert_invalid(&schema, &manifest, "excessive label limit");
}

/// Invariant (D6): `schema_version` MUST be the string `"2.0"`. A V1 manifest
/// (or any other version literal) must be rejected.
#[test]
fn inv_wrong_schema_version_is_rejected() {
  let schema = schema_root();
  let mut manifest = read_json(&manifest_path("default"));
  manifest
    .as_object_mut()
    .expect("manifest is an object")
    .insert("schema_version".into(), Value::String("1.0".into()));
  assert_invalid(&schema, &manifest, "manifest with schema_version=1.0");
}

/// Invariant: `accentColor.default` must match `^#[0-9a-fA-F]{6}$`. Used as
/// a smoke test to ensure the embedded validator's `pattern` check fires
/// (otherwise the previous additionalProperties test could be a false
/// positive coming from a different rule).
#[test]
fn inv_invalid_accent_color_is_rejected() {
  let schema = schema_root();
  let mut manifest = read_json(&manifest_path("default"));
  manifest["capabilities"]["accentColor"]["default"] = Value::String("not-a-hex".into());
  assert_invalid(&schema, &manifest, "manifest with invalid accent color");
}

/// Invariant (D2): every object level uses `additionalProperties:false`. An
/// unknown top-level key must be rejected.
#[test]
fn inv_unknown_top_level_key_is_rejected() {
  let schema = schema_root();
  let mut manifest = read_json(&manifest_path("default"));
  manifest
    .as_object_mut()
    .expect("manifest is an object")
    .insert("foo".into(), Value::String("bar".into()));
  assert_invalid(&schema, &manifest, "manifest with extra top-level key");
}

/// Invariant: package version and legal/source provenance are mandatory.
#[test]
fn inv_missing_version_or_provenance_is_rejected() {
  let schema = schema_root();
  for field in ["version", "provenance"] {
    let mut manifest = read_json(&manifest_path("default"));
    manifest.as_object_mut().expect("manifest object").remove(field);
    assert_invalid(&schema, &manifest, &format!("manifest without {field}"));
  }
}

// ─── Minimal Draft-2020-12 validator (subset used by our schema) ────────────

/// Validate `instance` against `schema` (rooted at `root` for `$ref`).
/// Errors are appended to `errs` with the JSON-pointer-ish path of the
/// failing instance location.
fn validate(root: &Value, schema: &Value, instance: &Value, path: &str, errs: &mut Vec<String>) {
  // Resolve $ref before anything else.
  let schema = if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
    match resolve_ref(root, reference) {
      Some(s) => s,
      None => {
        errs.push(format!("{path}: unresolved $ref `{reference}`"));
        return;
      }
    }
  } else {
    schema
  };

  let obj = match schema.as_object() {
    Some(o) => o,
    None => return, // booleans / non-objects: treat as accept
  };

  // --- type ---------------------------------------------------------------
  if let Some(t) = obj.get("type") {
    let ok = match t {
      Value::String(s) => instance_type_matches(instance, s),
      Value::Array(arr) => arr
        .iter()
        .filter_map(Value::as_str)
        .any(|s| instance_type_matches(instance, s)),
      _ => true,
    };
    if !ok {
      errs.push(format!(
        "{path}: type mismatch (expected {t}, got {})",
        instance_type(instance)
      ));
      return;
    }
  }

  // --- const --------------------------------------------------------------
  if let Some(c) = obj.get("const") {
    if instance != c {
      errs.push(format!("{path}: const mismatch (expected {c}, got {instance})"));
    }
  }

  // --- enum ---------------------------------------------------------------
  if let Some(Value::Array(values)) = obj.get("enum") {
    if !values.iter().any(|v| v == instance) {
      errs.push(format!("{path}: not in enum (got {instance})"));
    }
  }

  // --- string-specific ----------------------------------------------------
  if let Some(s) = instance.as_str() {
    if let Some(p) = obj.get("pattern").and_then(Value::as_str) {
      if !regex_match(p, s) {
        errs.push(format!("{path}: pattern `{p}` does not match `{s}`"));
      }
    }
    if let Some(min) = obj.get("minLength").and_then(Value::as_u64) {
      if (s.chars().count() as u64) < min {
        errs.push(format!("{path}: minLength {min} > {}", s.chars().count()));
      }
    }
    if let Some(max) = obj.get("maxLength").and_then(Value::as_u64) {
      if (s.chars().count() as u64) > max {
        errs.push(format!("{path}: maxLength {max} < {}", s.chars().count()));
      }
    }
  }

  // --- number-specific ----------------------------------------------------
  if let Some(n) = instance.as_f64() {
    if let Some(min) = obj.get("minimum").and_then(Value::as_f64) {
      if n < min {
        errs.push(format!("{path}: minimum {min} > {n}"));
      }
    }
    if let Some(max) = obj.get("maximum").and_then(Value::as_f64) {
      if n > max {
        errs.push(format!("{path}: maximum {max} < {n}"));
      }
    }
  }

  // --- array-specific -----------------------------------------------------
  if let Some(arr) = instance.as_array() {
    if let Some(min) = obj.get("minItems").and_then(Value::as_u64) {
      if (arr.len() as u64) < min {
        errs.push(format!("{path}: minItems {min} > {}", arr.len()));
      }
    }
    if let Some(max) = obj.get("maxItems").and_then(Value::as_u64) {
      if (arr.len() as u64) > max {
        errs.push(format!("{path}: maxItems {max} < {}", arr.len()));
      }
    }
    if obj.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
      for i in 0..arr.len() {
        for j in (i + 1)..arr.len() {
          if arr[i] == arr[j] {
            errs.push(format!("{path}: uniqueItems violated at index {i}/{j}"));
            break;
          }
        }
      }
    }
    if let Some(item_schema) = obj.get("items") {
      for (idx, item) in arr.iter().enumerate() {
        validate(root, item_schema, item, &format!("{path}/{idx}"), errs);
      }
    }
  }

  // --- object-specific ----------------------------------------------------
  if let Some(map) = instance.as_object() {
    if let Some(min) = obj.get("minProperties").and_then(Value::as_u64) {
      if (map.len() as u64) < min {
        errs.push(format!("{path}: minProperties {min} > {}", map.len()));
      }
    }

    // required
    if let Some(Value::Array(req)) = obj.get("required") {
      for key in req.iter().filter_map(Value::as_str) {
        if !map.contains_key(key) {
          errs.push(format!("{path}: missing required key `{key}`"));
        }
      }
    }

    let props = obj.get("properties").and_then(Value::as_object);

    // properties
    if let Some(p) = props {
      for (k, v) in map {
        if let Some(sub_schema) = p.get(k) {
          validate(root, sub_schema, v, &format!("{path}/{k}"), errs);
        }
      }
    }

    // additionalProperties
    match obj.get("additionalProperties") {
      Some(Value::Bool(false)) => {
        for k in map.keys() {
          let known = props.map(|p| p.contains_key(k)).unwrap_or(false);
          if !known {
            errs.push(format!("{path}: unknown property `{k}` (additionalProperties:false)"));
          }
        }
      }
      Some(Value::Object(_)) => {
        let ap_schema = obj.get("additionalProperties").unwrap();
        for (k, v) in map {
          let known = props.map(|p| p.contains_key(k)).unwrap_or(false);
          if !known {
            validate(root, ap_schema, v, &format!("{path}/{k}"), errs);
          }
        }
      }
      _ => {} // true or absent: anything goes
    }
  }
}

fn instance_type(instance: &Value) -> &'static str {
  match instance {
    Value::Null => "null",
    Value::Bool(_) => "boolean",
    Value::Number(n) => {
      if n.is_i64() || n.is_u64() {
        "integer"
      } else {
        "number"
      }
    }
    Value::String(_) => "string",
    Value::Array(_) => "array",
    Value::Object(_) => "object",
  }
}

fn instance_type_matches(instance: &Value, t: &str) -> bool {
  match t {
    "null" => instance.is_null(),
    "boolean" => instance.is_boolean(),
    "string" => instance.is_string(),
    "array" => instance.is_array(),
    "object" => instance.is_object(),
    "integer" => instance.is_i64() || instance.is_u64(),
    "number" => instance.is_number(),
    _ => true,
  }
}

/// Resolve a JSON-Pointer-style `$ref` of the form `#/$defs/Name` (and
/// `#/foo/bar` more generally). Returns `None` when the pointer cannot
/// be resolved.
fn resolve_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
  let pointer = reference.strip_prefix('#')?;
  let mut current = root;
  for raw_segment in pointer.split('/').filter(|s| !s.is_empty()) {
    // unescape JSON Pointer segments (~1 → /, ~0 → ~)
    let segment = raw_segment.replace("~1", "/").replace("~0", "~");
    current = match current {
      Value::Object(map) => map.get(&segment)?,
      Value::Array(arr) => arr.get(segment.parse::<usize>().ok()?)?,
      _ => return None,
    };
  }
  Some(current)
}

/// Tiny regex matcher tailored to the patterns used in the V2 manifest
/// schema. Supports anchors `^`/`$`, character classes `[...]` (incl.
/// ranges and a leading `\\`), escapes `\\.`/`\\\\`, repetition `+`/`*`/`?`/
/// `{n,m}`, `(?:..)` non-capturing groups, alternation `|` *only* inside
/// such groups, and the literal characters used by the schema's patterns.
/// Always anchored to a full match if the pattern starts with `^` and ends
/// with `$`; otherwise a substring match (per JSON Schema semantics).
fn regex_match(pattern: &str, haystack: &str) -> bool {
  let bytes: Vec<char> = pattern.chars().collect();
  let mut anchored_start = false;
  let mut anchored_end = false;
  let mut start = 0;
  let mut end = bytes.len();
  if bytes.first() == Some(&'^') {
    anchored_start = true;
    start = 1;
  }
  if bytes.last() == Some(&'$') {
    anchored_end = true;
    end = end.saturating_sub(1);
  }
  let core: String = bytes[start..end].iter().collect();
  let target_chars: Vec<char> = haystack.chars().collect();

  let starts: Vec<usize> = if anchored_start {
    vec![0]
  } else {
    (0..=target_chars.len()).collect()
  };
  for s in starts {
    if let Some(end_pos) = match_here(&core, 0, &target_chars, s) {
      if !anchored_end || end_pos == target_chars.len() {
        return true;
      }
    }
  }
  false
}

/// Try to match the pattern starting at `pi` against `text` starting at `ti`.
/// Returns the end position in `text` on success.
fn match_here(pattern: &str, pi: usize, text: &[char], ti: usize) -> Option<usize> {
  let pat: Vec<char> = pattern.chars().collect();
  match_inner(&pat, pi, text, ti)
}

fn match_inner(pat: &[char], mut pi: usize, text: &[char], mut ti: usize) -> Option<usize> {
  while pi < pat.len() {
    // Parse one atom (literal char / escaped / class / group), with optional quantifier.
    let (atom_end, atom_matcher): (usize, Box<dyn Fn(char) -> bool>);
    if pat[pi] == '\\' && pi + 1 < pat.len() {
      let c = pat[pi + 1];
      atom_end = pi + 2;
      atom_matcher = Box::new(move |x: char| x == c);
    } else if pat[pi] == '.' {
      atom_end = pi + 1;
      atom_matcher = Box::new(|x: char| x != '\n');
    } else if pat[pi] == '[' {
      let close = find_unescaped(pat, pi + 1, ']')?;
      let class: Vec<char> = pat[pi + 1..close].to_vec();
      atom_end = close + 1;
      atom_matcher = Box::new(move |x: char| char_class_match(&class, x));
    } else if pat[pi] == '(' {
      // Only support (?:...) non-capturing groups with optional |-alternation.
      if pi + 2 < pat.len() && pat[pi + 1] == '?' && pat[pi + 2] == ':' {
        let close = find_matching_paren(pat, pi)?;
        let inner: String = pat[pi + 3..close].iter().collect();
        // Split alternations at top level.
        let alternatives = split_top_alternations(&inner);
        let quant_start = close + 1;
        let (quant_lo, quant_hi, after_quant) = parse_quant(pat, quant_start);
        // Try to match group `quant_lo..=quant_hi` times.
        return try_quant_group(&alternatives, quant_lo, quant_hi, pat, after_quant, text, ti);
      } else {
        // Treat a non-(?: paren as literal — should never happen in our schema.
        atom_end = pi + 1;
        let c = pat[pi];
        atom_matcher = Box::new(move |x: char| x == c);
      }
    } else {
      let c = pat[pi];
      atom_end = pi + 1;
      atom_matcher = Box::new(move |x: char| x == c);
    }

    let (lo, hi, next_pi) = parse_quant(pat, atom_end);

    // Greedy match with backtracking.
    let max = hi.unwrap_or(text.len() - ti.min(text.len()));
    let mut count = 0usize;
    while count < max && ti + count < text.len() && (*atom_matcher)(text[ti + count]) {
      count += 1;
    }
    while count + 1 > lo {
      let consumed = count;
      if let Some(end_pos) = match_inner(pat, next_pi, text, ti + consumed) {
        return Some(end_pos);
      }
      if count == 0 {
        break;
      }
      count -= 1;
    }
    if lo == 0 {
      // try with zero matches if loop exited with count == 0
      if let Some(end_pos) = match_inner(pat, next_pi, text, ti) {
        return Some(end_pos);
      }
    }
    // Failure: re-walk one fixed match (count == lo) before giving up.
    let mut fixed = 0usize;
    while fixed < lo {
      if ti + fixed >= text.len() || !(*atom_matcher)(text[ti + fixed]) {
        return None;
      }
      fixed += 1;
    }
    ti += fixed;
    pi = next_pi;
  }
  Some(ti)
}

fn try_quant_group(
  alternatives: &[String],
  lo: usize,
  hi: Option<usize>,
  outer_pat: &[char],
  outer_after_quant: usize,
  text: &[char],
  ti: usize,
) -> Option<usize> {
  // Iterative greedy: try the maximum number of repetitions then back off.
  let max = hi.unwrap_or(text.len() - ti.min(text.len()));
  fn rec(alts: &[String], rem: usize, text: &[char], ti: usize) -> Vec<usize> {
    if rem == 0 {
      return vec![ti];
    }
    let mut out = Vec::new();
    for alt in alts {
      let alt_chars: Vec<char> = alt.chars().collect();
      if let Some(end_pos) = match_inner(&alt_chars, 0, text, ti) {
        for nxt in rec(alts, rem - 1, text, end_pos) {
          out.push(nxt);
        }
      }
    }
    out
  }
  // Try repetition counts from `max` down to `lo`.
  for n in (lo..=max).rev() {
    let candidates = rec(alternatives, n, text, ti);
    for c in candidates {
      if let Some(end_pos) = match_inner(outer_pat, outer_after_quant, text, c) {
        return Some(end_pos);
      }
    }
  }
  None
}

fn split_top_alternations(s: &str) -> Vec<String> {
  let chars: Vec<char> = s.chars().collect();
  let mut out = Vec::new();
  let mut buf = String::new();
  let mut depth = 0i32;
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if c == '\\' && i + 1 < chars.len() {
      buf.push(c);
      buf.push(chars[i + 1]);
      i += 2;
      continue;
    }
    if c == '(' {
      depth += 1;
    } else if c == ')' {
      depth -= 1;
    } else if c == '|' && depth == 0 {
      out.push(std::mem::take(&mut buf));
      i += 1;
      continue;
    }
    buf.push(c);
    i += 1;
  }
  out.push(buf);
  out
}

fn parse_quant(pat: &[char], pos: usize) -> (usize, Option<usize>, usize) {
  if pos >= pat.len() {
    return (1, Some(1), pos);
  }
  match pat[pos] {
    '*' => (0, None, pos + 1),
    '+' => (1, None, pos + 1),
    '?' => (0, Some(1), pos + 1),
    '{' => {
      // {n} or {n,m}
      if let Some(close) = pat[pos..].iter().position(|&c| c == '}') {
        let close_abs = pos + close;
        let inner: String = pat[pos + 1..close_abs].iter().collect();
        if let Some((a, b)) = inner.split_once(',') {
          let lo = a.parse::<usize>().unwrap_or(0);
          let hi = if b.is_empty() { None } else { b.parse::<usize>().ok() };
          (lo, hi, close_abs + 1)
        } else if let Ok(n) = inner.parse::<usize>() {
          (n, Some(n), close_abs + 1)
        } else {
          (1, Some(1), pos)
        }
      } else {
        (1, Some(1), pos)
      }
    }
    _ => (1, Some(1), pos),
  }
}

fn find_unescaped(pat: &[char], start: usize, target: char) -> Option<usize> {
  let mut i = start;
  while i < pat.len() {
    if pat[i] == '\\' && i + 1 < pat.len() {
      i += 2;
      continue;
    }
    if pat[i] == target {
      return Some(i);
    }
    i += 1;
  }
  None
}

fn find_matching_paren(pat: &[char], open: usize) -> Option<usize> {
  let mut depth = 0i32;
  let mut i = open;
  while i < pat.len() {
    if pat[i] == '\\' && i + 1 < pat.len() {
      i += 2;
      continue;
    }
    if pat[i] == '(' {
      depth += 1;
    } else if pat[i] == ')' {
      depth -= 1;
      if depth == 0 {
        return Some(i);
      }
    }
    i += 1;
  }
  None
}

fn char_class_match(class: &[char], x: char) -> bool {
  // Handle a leading `^` negation.
  let (negated, body): (bool, &[char]) = if class.first() == Some(&'^') {
    (true, &class[1..])
  } else {
    (false, class)
  };
  let mut i = 0;
  let mut hit = false;
  while i < body.len() {
    let cur = if body[i] == '\\' && i + 1 < body.len() {
      let c = body[i + 1];
      i += 2;
      c
    } else {
      let c = body[i];
      i += 1;
      c
    };
    // Check for range `a-b`.
    if i + 1 < body.len() && body[i] == '-' && body[i + 1] != ']' {
      let next = if body[i + 1] == '\\' && i + 2 < body.len() {
        let c = body[i + 2];
        i += 3;
        c
      } else {
        let c = body[i + 1];
        i += 2;
        c
      };
      if x >= cur && x <= next {
        hit = true;
      }
    } else if x == cur {
      hit = true;
    }
  }
  if negated { !hit } else { hit }
}

// ─── Self-tests for the embedded validator ──────────────────────────────────

#[cfg(test)]
mod self_tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn regex_anchors_and_classes() {
    assert!(regex_match("^[a-z0-9]+(?:-[a-z0-9]+)*$", "default"));
    assert!(regex_match("^[a-z0-9]+(?:-[a-z0-9]+)*$", "report-2"));
    assert!(!regex_match("^[a-z0-9]+(?:-[a-z0-9]+)*$", "Default"));
    assert!(regex_match("^#[0-9a-fA-F]{6}$", "#1F2937"));
    assert!(!regex_match("^#[0-9a-fA-F]{6}$", "#1F293"));
    assert!(regex_match(
      "^[0-9]+\\.[0-9]+(?:\\.(?:[0-9]+|x))?(?:-[A-Za-z0-9.-]+)?$",
      "0.15.x"
    ));
    assert!(regex_match(
      "^[0-9]+\\.[0-9]+(?:\\.(?:[0-9]+|x))?(?:-[A-Za-z0-9.-]+)?$",
      "0.15.1"
    ));
    assert!(regex_match("^[A-Za-z0-9_./-]+\\.typ$", "main.typ"));
    assert!(!regex_match("^[A-Za-z0-9_./-]+\\.typ$", "main.txt"));
  }

  #[test]
  fn validator_rejects_extra_property() {
    let schema = json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["a"],
      "properties": { "a": { "type": "string" } }
    });
    let mut errs = Vec::new();
    validate(&schema, &schema, &json!({ "a": "ok", "b": 1 }), "", &mut errs);
    assert!(!errs.is_empty(), "extra prop must fail");
  }

  #[test]
  fn validator_accepts_with_ref() {
    let schema = json!({
      "$defs": { "X": { "type": "string", "const": "yes" } },
      "type": "object",
      "additionalProperties": false,
      "required": ["a"],
      "properties": { "a": { "$ref": "#/$defs/X" } }
    });
    let mut errs = Vec::new();
    validate(&schema, &schema, &json!({ "a": "yes" }), "", &mut errs);
    assert!(errs.is_empty(), "ref should resolve: {errs:?}");
  }
}
