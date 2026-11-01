// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-24-CLI-FOLLOWUP-01` — Source-scan lint that enforces the
//! "blobs first, DB second" pattern in CLI mutating commands.
//!
//! ## Why
//!
//! After the CLI templates-upload regression (LRN-20260430-PDF-CLI-BLOB-ORDER)
//! the project rule is: any code path that mixes blob writes with DB
//! inserts MUST write the blobs first, track them in a vector, then
//! insert the DB rows — with cleanup of the tracked blobs on DB
//! failure. The reverse ordering produces orphan DB rows that point at
//! non-existent storage keys, which surface as silent breakage at
//! render time.
//!
//! Reviewing every PR against the CLI's PDF surface for this property
//! is error-prone (the bug looks innocuous on a first read). This
//! test runs at compile/test time, scans the CLI source for the
//! anti-pattern, and fails the test run loudly so the regression
//! shows up in CI before it ships.
//!
//! ## What it checks
//!
//! For every mutating PDF subcommand body in `crates/cli/src/pdf.rs`,
//! we walk the function source and assert that **the first DB-write call**
//! appears AFTER the first call to `blob_store.put_template_file(` /
//! `put_brand_asset(` / `put_font(` within the same function. Functions that
//! write blobs only OR DB rows only are skipped — the ordering rule applies
//! only when both kinds of writes coexist.
//!
//! ## What it deliberately does NOT check
//!
//! - The lint is purely lexical (no AST parse) and assumes the CLI
//!   stays on the convention of `blob_store: &PdfBlobStore`-style
//!   variable names. A clever rename (`my_store.put_template_file(`)
//!   would slip through. The cost of a real syn-based parser
//!   (`syn = "2"` + walking the fn bodies) is not worth it for a
//!   single CLI file with stable conventions.
//! - We don't check that the cleanup-on-failure path exists. That's a
//!   separate concern — covered by the function's own logic and the
//!   unit/integration tests around `templates_upload`.

use std::path::PathBuf;

/// Path to the CLI's pdf module — single source of truth for the lint.
fn pdf_source_path() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/pdf.rs")
}

/// Function bodies the lint covers. The list is explicit (rather than
/// "every async fn in pdf.rs") so unit-test functions, helpers and
/// list-style read-only functions never get flagged.
const COVERED_FNS: &[&str] = &["templates_upload", "brand_set_logo", "fonts_upload"];

/// Substrings that count as a "blob write" call.
const BLOB_WRITE_TOKENS: &[&str] = &["put_template_file(", "put_brand_asset(", "put_font("];

/// Substrings that count as a "DB write" call.
///
/// `repo.create(` is the canonical insert call, but mutating commands
/// also use owner-specific write methods. The lint is permissive — any of
/// these appearing BEFORE a blob write is suspicious.
const DB_WRITE_TOKENS: &[&str] = &[
  "repo.create(",
  ".create(",
  "set_document_logo_blob(",
  "upsert_pdf_export_settings(",
];

#[test]
fn blob_write_must_precede_db_write_in_pdf_cli() {
  let src = std::fs::read_to_string(pdf_source_path()).expect("read pdf.rs");

  for fn_name in COVERED_FNS {
    let body = extract_fn_body(&src, fn_name)
      .unwrap_or_else(|| panic!("blob-db-order lint: could not find body of `{fn_name}` in pdf.rs"));

    let first_blob = first_match_offset(body, BLOB_WRITE_TOKENS);
    let first_db = first_match_offset(body, DB_WRITE_TOKENS);

    // Function writes both kinds: ordering rule applies. Functions that write
    // blobs only or DB rows only are intentionally ignored.
    if let (Some(blob_offset), Some(db_offset)) = (first_blob, first_db) {
      assert!(
        blob_offset < db_offset,
        "blob-db-order lint: `{fn_name}` writes a DB row BEFORE the first blob upload \
         (DB token at byte {db_offset}, first blob token at byte {blob_offset}). \
         See LRN-20260430-PDF-CLI-BLOB-ORDER — blobs must be written first, \
         with rollback-on-DB-failure."
      );
    }
  }
}

/// Cheap lexical extraction of a function body. Finds `fn <name>(`,
/// then returns the substring between the first `{` after the
/// signature and the matching `}` (depth-counted). Returns `None` if
/// the function is missing or the braces don't balance.
fn extract_fn_body<'a>(src: &'a str, fn_name: &str) -> Option<&'a str> {
  let needle = format!("fn {fn_name}(");
  let start = src.find(&needle)?;
  // First `{` after the signature.
  let body_open = src[start..].find('{')? + start;
  // Walk until the matching `}` ignoring braces inside string/char
  // literals or line comments. This is a heuristic — false positives
  // (e.g. `'{'` inside a string) would only widen the slice and not
  // cause a missed lint hit, so we accept the simplification.
  let bytes = src.as_bytes();
  let mut depth = 0i32;
  let mut i = body_open;
  let mut in_line_comment = false;
  let mut in_block_comment = false;
  let mut in_string = false;
  let mut string_quote = b'"';
  while i < bytes.len() {
    let b = bytes[i];
    if in_line_comment {
      if b == b'\n' {
        in_line_comment = false;
      }
      i += 1;
      continue;
    }
    if in_block_comment {
      if b == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
        in_block_comment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if in_string {
      if b == b'\\' && i + 1 < bytes.len() {
        i += 2;
        continue;
      }
      if b == string_quote {
        in_string = false;
      }
      i += 1;
      continue;
    }
    // Not in any literal/comment context — interpret structurally.
    if b == b'/' && i + 1 < bytes.len() {
      match bytes[i + 1] {
        b'/' => {
          in_line_comment = true;
          i += 2;
          continue;
        }
        b'*' => {
          in_block_comment = true;
          i += 2;
          continue;
        }
        _ => {}
      }
    }
    if b == b'"' || b == b'\'' {
      // Skip raw-string `r#"..."#` openings — fall through to treat
      // the next `"` as the close quote (good enough for the `r"..."`
      // and `r#"..."#` shapes used in the CLI).
      in_string = true;
      string_quote = b'"';
      i += 1;
      continue;
    }
    if b == b'{' {
      depth += 1;
    } else if b == b'}' {
      depth -= 1;
      if depth == 0 {
        return Some(&src[body_open..=i]);
      }
    }
    i += 1;
  }
  None
}

/// Return the byte offset of the earliest occurrence of any of
/// `tokens` in `src`, or `None` if none match.
fn first_match_offset(src: &str, tokens: &[&str]) -> Option<usize> {
  tokens.iter().filter_map(|t| src.find(t)).min()
}

#[cfg(test)]
mod self_tests {
  use super::*;

  /// Sanity: `extract_fn_body` finds and returns a complete body when
  /// asked for an existing function in the real CLI source.
  #[test]
  fn extract_fn_body_finds_real_function() {
    let src = std::fs::read_to_string(pdf_source_path()).expect("read pdf.rs");
    let body = extract_fn_body(&src, "templates_upload").expect("templates_upload must exist");
    assert!(body.starts_with('{') && body.ends_with('}'));
    // Should at least mention the staged loop and the repo.
    assert!(body.contains("staged"));
    assert!(body.contains("PgPdfTemplateRepository"));
  }

  /// Sanity: an unknown function name returns None instead of panicking.
  #[test]
  fn extract_fn_body_returns_none_for_unknown() {
    let src = "fn other_thing() { println!(\"hi\"); }";
    assert!(extract_fn_body(src, "ghost").is_none());
  }

  /// Sanity: the offset finder picks the earliest match across all tokens.
  #[test]
  fn first_match_picks_earliest() {
    let src = "alpha .upsert( beta repo.create( gamma";
    let off = first_match_offset(src, &["repo.create(", ".upsert("]).expect("match");
    // Expected to match `.upsert(` (earlier) not `repo.create(`.
    assert_eq!(&src[off..off + ".upsert(".len()], ".upsert(");
  }
}
