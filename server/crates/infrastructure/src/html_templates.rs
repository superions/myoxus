// SPDX-License-Identifier: AGPL-3.0-or-later
use std::{
  collections::BTreeMap,
  io::Read,
  path::{Path, PathBuf},
  sync::{Arc, OnceLock},
};

use myoxus_public_render::{HTML_CATALOG_FILES, HtmlRenderer, HtmlRendererProvider};

const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;

/// One capture per process. CLI non-HTML commands never touch the filesystem;
/// the API explicitly resolves this provider before admitting traffic.
pub struct FilesystemHtmlCatalog {
  root: PathBuf,
  captured: OnceLock<Result<Arc<HtmlRenderer>, String>>,
}

impl FilesystemHtmlCatalog {
  pub fn new(root: PathBuf) -> Self {
    Self {
      root,
      captured: OnceLock::new(),
    }
  }
}

impl HtmlRendererProvider for FilesystemHtmlCatalog {
  fn renderer(&self) -> Result<&HtmlRenderer, String> {
    self
      .captured
      .get_or_init(|| capture(&self.root).map(Arc::new))
      .as_ref()
      .map(Arc::as_ref)
      .map_err(Clone::clone)
  }
}

#[tracing::instrument(skip_all)]
fn capture(root: &Path) -> Result<HtmlRenderer, String> {
  let root = root
    .canonicalize()
    .map_err(|_| "HTML catalog root is unavailable".to_string())?;
  let mut files = BTreeMap::new();
  let mut total = 0;
  for &relative in HTML_CATALOG_FILES {
    let path = root.join(relative);
    let canonical = path
      .canonicalize()
      .map_err(|_| format!("required HTML catalog file unavailable: {relative}"))?;
    if !canonical.starts_with(&root) {
      return Err(format!("HTML catalog path escapes root: {relative}"));
    }
    let mut cursor = root.clone();
    for component in Path::new(relative).components() {
      cursor.push(component);
      if std::fs::symlink_metadata(&cursor)
        .map_err(|err| err.to_string())?
        .file_type()
        .is_symlink()
      {
        return Err(format!("HTML catalog symlink is not allowed: {relative}"));
      }
    }
    let expected = std::fs::metadata(&canonical).map_err(|err| err.to_string())?;
    if !expected.is_file() {
      return Err(format!("HTML catalog input is not a regular file: {relative}"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&canonical).map_err(|err| err.to_string())?;
    let opened = file.metadata().map_err(|err| err.to_string())?;
    if !opened.is_file() {
      return Err(format!("HTML catalog input changed to a nonregular file: {relative}"));
    }
    #[cfg(unix)]
    {
      use std::os::unix::fs::MetadataExt;
      if expected.dev() != opened.dev() || expected.ino() != opened.ino() {
        return Err(format!("HTML catalog input changed during capture: {relative}"));
      }
    }
    let mut bytes = Vec::new();
    file
      .take(MAX_FILE_BYTES as u64 + 1)
      .read_to_end(&mut bytes)
      .map_err(|err| err.to_string())?;
    total += bytes.len();
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES || total > MAX_CATALOG_BYTES {
      return Err(format!(
        "HTML catalog input is empty or exceeds byte limits: {relative}"
      ));
    }
    files.insert(relative.to_string(), bytes);
  }
  HtmlRenderer::from_files(files)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
    for &name in HTML_CATALOG_FILES {
      let destination = root.path().join(name);
      std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
      std::fs::copy(source.join(name), destination).unwrap();
    }
    root
  }

  #[test]
  fn html_capture_is_lazy_once_and_content_identifies_every_input() {
    let root = fixture();
    let provider = FilesystemHtmlCatalog::new(root.path().to_path_buf());
    let css = root.path().join("assets/public.css");
    let original = std::fs::read_to_string(&css).unwrap();
    std::fs::write(&css, format!("{original}\n/* before capture */")).unwrap();
    let captured = provider.renderer().unwrap();
    assert!(captured.public_css().contains("before capture"));
    let hash = captured.content_hash().to_string();
    std::fs::write(&css, format!("{original}\n/* after capture */")).unwrap();
    assert_eq!(provider.renderer().unwrap().content_hash(), hash);
    assert!(!provider.renderer().unwrap().public_css().contains("after capture"));
    let reloaded = FilesystemHtmlCatalog::new(root.path().to_path_buf());
    assert_ne!(reloaded.renderer().unwrap().content_hash(), hash);
    std::fs::remove_dir_all(root.path()).unwrap();
    assert_eq!(provider.renderer().unwrap().content_hash(), hash);
  }

  #[test]
  fn missing_nonregular_oversized_and_symlinked_inputs_are_rejected() {
    for kind in [
      "missing",
      "directory",
      "oversized",
      "empty",
      "symlink",
      "directory-symlink",
    ] {
      let root = fixture();
      let target = root.path().join("assets/public.css");
      match kind {
        "missing" => std::fs::remove_file(&target).unwrap(),
        "directory" => {
          std::fs::remove_file(&target).unwrap();
          std::fs::create_dir(&target).unwrap();
        }
        "oversized" => std::fs::write(&target, vec![b' '; MAX_FILE_BYTES + 1]).unwrap(),
        "empty" => std::fs::write(&target, []).unwrap(),
        #[cfg(unix)]
        "symlink" => {
          std::fs::remove_file(&target).unwrap();
          std::os::unix::fs::symlink(root.path().join("assets/public.js"), &target).unwrap();
        }
        #[cfg(unix)]
        "directory-symlink" => {
          std::fs::rename(root.path().join("assets"), root.path().join("other-assets")).unwrap();
          std::os::unix::fs::symlink(root.path().join("other-assets"), root.path().join("assets")).unwrap();
        }
        _ => continue,
      }
      assert!(capture(root.path()).is_err(), "{kind} must fail closed");
    }
    assert!(
      FilesystemHtmlCatalog::new(PathBuf::from("/nonexistent-html-catalog"))
        .renderer()
        .is_err()
    );
  }
}
