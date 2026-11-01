// SPDX-License-Identifier: AGPL-3.0-or-later
//! Markdown import: Git repository files -> Workspace documents.
//!
//! Reads Markdown files from the Git working tree, parses frontmatter
//! to identify existing bindings, and converts content back to Yjs
//! binary format for storage in the Myoxus doc system.

use std::fmt;
use std::path::Path;

use tracing::{debug, instrument, trace, warn};
use uuid::Uuid;

use super::export::{ExportFrontmatter, GitSyncWriterScope, split_markdown_file};
use crate::markdown::content_hash;

/// Result of importing a single file from the Git working tree.
#[derive(Debug)]
pub struct ImportedDoc {
  /// The sync_id from frontmatter (None if file has no valid frontmatter).
  pub sync_id: Option<Uuid>,
  /// The doc_id from frontmatter (None if new document).
  pub doc_id: Option<Uuid>,
  /// Document title (from frontmatter or derived from filename).
  pub title: String,
  /// Markdown content (without frontmatter).
  pub markdown: String,
  /// Content hash for change detection.
  pub content_hash: String,
  /// Relative path in the repo.
  pub repo_path: String,
  /// Import classification.
  pub classification: ImportClassification,
}

/// How the imported file was classified based on its frontmatter state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportClassification {
  /// Has valid frontmatter with sync_id — update existing binding.
  ExistingDoc,
  /// No frontmatter — new document created externally in Git.
  NewDoc,
  /// Frontmatter is malformed — quarantine, don't silently assign.
  MalformedFrontmatter,
}

impl fmt::Display for ImportClassification {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::ExistingDoc => f.write_str("ExistingDoc"),
      Self::NewDoc => f.write_str("NewDoc"),
      Self::MalformedFrontmatter => f.write_str("MalformedFrontmatter"),
    }
  }
}

/// Parse a single Markdown file from the Git working tree.
#[instrument(skip(file_content))]
pub fn parse_imported_file(repo_path: &str, file_content: &str) -> Result<ImportedDoc, String> {
  if super::overview::is_git_overview_marked(file_content) {
    return Err("read-only overview requires manifest classification before document import".into());
  }
  let (frontmatter_yaml, markdown) = split_markdown_file(file_content);

  let (sync_id, doc_id, title, classification) = match frontmatter_yaml {
    Some(yaml) => match ExportFrontmatter::from_yaml(&yaml) {
      Some(fm) => {
        debug!(sync_id = %fm.sync_id, doc_id = %fm.doc_id, "valid frontmatter");
        (
          Some(fm.sync_id),
          Some(fm.doc_id),
          fm.title,
          ImportClassification::ExistingDoc,
        )
      }
      None => {
        warn!(repo_path, "malformed frontmatter — quarantining");
        let title = title_from_path(repo_path);
        (None, None, title, ImportClassification::MalformedFrontmatter)
      }
    },
    None => {
      let title = title_from_path(repo_path);
      debug!(repo_path, derived_title = %title, "no frontmatter — treating as new doc");
      (None, None, title, ImportClassification::NewDoc)
    }
  };

  let hash = content_hash(&markdown);
  Ok(ImportedDoc {
    sync_id,
    doc_id,
    title,
    markdown,
    content_hash: hash,
    repo_path: repo_path.to_string(),
    classification,
  })
}

/// Derive a title from a file path: `"content/folder/my-doc.md"` -> `"My Doc"`.
fn title_from_path(path: &str) -> String {
  let stem = Path::new(path)
    .file_stem()
    .and_then(|s| s.to_str())
    .unwrap_or("Untitled");
  // Convert slug back to title: "my-doc" -> "My Doc"
  stem
    .split('-')
    .map(|word| {
      let mut chars = word.chars();
      match chars.next() {
        Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()),
        None => String::new(),
      }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

/// Scan a directory for all Markdown files, recursively.
///
/// Returns pairs of `(relative_path, file_content)`.
/// Hidden directories (starting with `.`) and symlinks are skipped
/// to prevent infinite loops and unexpected file inclusions.
#[instrument(skip(root))]
pub fn scan_markdown_files(root: &Path, prefix: &str) -> Result<Vec<(String, String)>, String> {
  scan_markdown_files_scoped(root, prefix, &GitSyncWriterScope::new(Vec::new()))
}

/// Prune excluded directories before touching their bytes. A delegated child
/// may contain unreadable or non-UTF-8 Markdown that belongs to its own writer.
pub fn scan_markdown_files_scoped(
  root: &Path,
  prefix: &str,
  scope: &GitSyncWriterScope,
) -> Result<Vec<(String, String)>, String> {
  let mut files = Vec::new();
  let prefix = prefix.trim_end_matches('/');
  scan_dir_recursive(root, prefix, &mut files, scope)?;
  debug!(count = files.len(), "scanned markdown files");
  Ok(files)
}

fn scan_dir_recursive(
  dir: &Path,
  prefix: &str,
  files: &mut Vec<(String, String)>,
  scope: &GitSyncWriterScope,
) -> Result<(), String> {
  let entries = std::fs::read_dir(dir).map_err(|e| format!("read dir failed: {e}"))?;
  for entry in entries {
    let entry = entry.map_err(|e| format!("dir entry error: {e}"))?;
    let path = entry.path();

    // Skip symlinks to avoid infinite loops and unexpected inclusions
    if path.is_symlink() {
      trace!(path = %path.display(), "skipping symlink");
      continue;
    }

    if path.is_dir() {
      let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
      if name.starts_with('.') {
        continue; // skip .git etc
      }
      let sub_prefix = if prefix.is_empty() {
        name.to_string()
      } else {
        format!("{prefix}/{name}")
      };
      if !scope.excludes(&sub_prefix).map_err(|error| error.to_string())? {
        scan_dir_recursive(&path, &sub_prefix, files, scope)?;
      }
    } else if path
      .extension()
      .and_then(|e| e.to_str())
      .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
      let rel_path = if prefix.is_empty() {
        path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string()
      } else {
        format!("{prefix}/{}", path.file_name().and_then(|n| n.to_str()).unwrap_or(""))
      };
      if scope.excludes(&rel_path).map_err(|error| error.to_string())? {
        continue;
      }
      let content = std::fs::read_to_string(&path).map_err(|e| format!("read file {}: {e}", path.display()))?;
      trace!(path = %rel_path, "found markdown file");
      files.push((rel_path, content));
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  // ── Frontmatter-based classification ────────────────────────────────

  #[test]
  fn parse_with_valid_frontmatter_classifies_as_existing() {
    let content = "---\nsync_id: 11111111-1111-1111-1111-111111111111\ndoc_id: 22222222-2222-2222-2222-222222222222\nworkspace_id: 33333333-3333-3333-3333-333333333333\ntitle: \"Test Doc\"\n---\nHello world\n";
    let result = parse_imported_file("content/test.md", content).unwrap();

    assert_eq!(result.classification, ImportClassification::ExistingDoc);
    assert_eq!(
      result.sync_id,
      Some(Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap())
    );
    assert_eq!(
      result.doc_id,
      Some(Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap())
    );
    assert_eq!(result.title, "Test Doc");
    assert!(result.markdown.contains("Hello world"));
    assert_eq!(result.content_hash.len(), 64);
  }

  #[test]
  fn parse_without_frontmatter_classifies_as_new() {
    let content = "Just some plain markdown\n\nWith two paragraphs.\n";
    let result = parse_imported_file("content/my-doc.md", content).unwrap();

    assert_eq!(result.classification, ImportClassification::NewDoc);
    assert!(result.sync_id.is_none());
    assert!(result.doc_id.is_none());
    assert_eq!(result.title, "My Doc");
    assert!(result.markdown.contains("Just some plain markdown"));
  }

  #[test]
  fn parse_with_malformed_frontmatter_quarantines() {
    // Has frontmatter delimiters but invalid content (missing required fields)
    let content = "---\nrandom_key: some_value\n---\nBody text\n";
    let result = parse_imported_file("content/bad-file.md", content).unwrap();

    assert_eq!(result.classification, ImportClassification::MalformedFrontmatter);
    assert!(result.sync_id.is_none());
    assert!(result.doc_id.is_none());
    assert_eq!(result.title, "Bad File");
  }

  // ── Title derivation from path ──────────────────────────────────────

  #[test]
  fn title_from_simple_slug() {
    assert_eq!(title_from_path("content/my-doc.md"), "My Doc");
  }

  #[test]
  fn title_from_nested_path() {
    assert_eq!(title_from_path("content/folder/sub/hello-world.md"), "Hello World");
  }

  #[test]
  fn title_from_single_word() {
    assert_eq!(title_from_path("readme.md"), "Readme");
  }

  #[test]
  fn title_from_path_no_extension() {
    assert_eq!(title_from_path("content/notes"), "Notes");
  }

  #[test]
  fn title_from_path_with_underscores_kept_as_one_word() {
    // Underscores are not split — only hyphens
    assert_eq!(title_from_path("my_notes.md"), "My_notes");
  }

  // ── Content hash stability ──────────────────────────────────────────

  #[test]
  fn same_content_produces_same_hash() {
    let a = parse_imported_file("a.md", "Hello\n").unwrap();
    let b = parse_imported_file("b.md", "Hello\n").unwrap();
    assert_eq!(a.content_hash, b.content_hash);
  }

  #[test]
  fn different_content_produces_different_hash() {
    let a = parse_imported_file("a.md", "Hello\n").unwrap();
    let b = parse_imported_file("b.md", "World\n").unwrap();
    assert_ne!(a.content_hash, b.content_hash);
  }

  // ── Directory scanning ──────────────────────────────────────────────

  #[test]
  fn scan_finds_markdown_files_recursively() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    // Create test structure
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("top.md"), "# Top").unwrap();
    fs::write(root.join("sub/nested.md"), "# Nested").unwrap();
    fs::write(root.join("ignored.txt"), "not markdown").unwrap();

    let files = scan_markdown_files(root, "content").unwrap();

    let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    assert!(paths.contains(&"content/top.md"), "should find top.md");
    assert!(paths.contains(&"content/sub/nested.md"), "should find nested.md");
    assert_eq!(files.len(), 2, "should skip .txt file");
    use super::super::{
      export::{GitSyncManifest, GitSyncManifestOverview},
      overview::classify_git_overview_paths,
    };
    let workspace = Uuid::new_v4();
    let marker = crate::workspace_overview::markdown::GIT_OVERVIEW_MARKER;
    let mut manifest = GitSyncManifest::new(workspace, "capture".into(), vec![], vec![]);
    manifest.overview = Some(GitSyncManifestOverview {
      repo_path: "content/README.md".into(),
      content_hash: content_hash(marker),
    });
    let captured = [
      ("content/README.md", b"user edited derived page".as_slice()),
      ("content/readme-user.md", b"ordinary README".as_slice()),
    ];
    let owned = classify_git_overview_paths(workspace, Some(&manifest), std::iter::empty(), captured).unwrap();
    assert_eq!(owned.into_iter().collect::<Vec<_>>(), ["content/README.md"]);
    assert!(
      classify_git_overview_paths(workspace, Some(&manifest), std::iter::empty(), std::iter::empty()).is_ok(),
      "missing generated output remains read-only"
    );
    assert!(
      classify_git_overview_paths(
        workspace,
        None,
        std::iter::empty(),
        [("content/copied.md", marker.as_bytes())]
      )
      .is_err()
    );
    assert!(
      classify_git_overview_paths(workspace, Some(&manifest), ["content/readme.MD"], std::iter::empty()).is_err()
    );
    assert!(parse_imported_file("content/README.md", marker).is_err());
    assert_eq!(
      parse_imported_file("content/readme.md", "ordinary README")
        .unwrap()
        .classification,
      ImportClassification::NewDoc
    );
  }

  #[test]
  fn scan_normalizes_trailing_prefix_slash() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("top.md"), "# Top").unwrap();

    let files = scan_markdown_files(dir.path(), "content/").unwrap();

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "content/top.md");
  }

  #[test]
  fn scan_skips_hidden_directories() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/config.md"), "# Git config").unwrap();
    fs::write(root.join("visible.md"), "# Visible").unwrap();

    let files = scan_markdown_files(root, "").unwrap();

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "visible.md");
  }

  #[test]
  fn scan_empty_directory_returns_empty() {
    let dir = tempfile::tempdir().unwrap();
    let files = scan_markdown_files(dir.path(), "root").unwrap();
    assert!(files.is_empty());
  }

  #[test]
  fn scan_with_empty_prefix() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("doc.md"), "content").unwrap();

    let files = scan_markdown_files(dir.path(), "").unwrap();

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "doc.md");
  }
}
