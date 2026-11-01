// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typst World implementation for the Myoxus PDF export engine.
//!
//! The world provides fonts, the main source document, and a virtual
//! file system serving bundle-local modules/data and document blob assets.
//! Network access and arbitrary filesystem access are never granted —
//! only explicit virtual paths are resolvable.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use typst::Library;
use typst::LibraryExt;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;

/// Namespace prefix for blob asset virtual paths inside the Typst World.
/// A path like `blob:abc123` is served from the IR's asset map.
pub const BLOB_PATH_PREFIX: &str = "blob:";

// One unaddressable identity avoids both bundle main.typ collisions and leaking
// a new entry in Typst's bounded global FileId interner for every export.
static GENERATED_MAIN: LazyLock<FileId> = LazyLock::new(|| {
  FileId::unique(RootedPath::new(
    VirtualRoot::Project,
    VirtualPath::new("/main.typ").expect("static main path"),
  ))
});

fn is_sfnt_font(path: &Path) -> bool {
  let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
    return false;
  };
  matches!(ext.to_ascii_lowercase().as_str(), "ttf" | "otf")
}

/// Read a raw SFNT font file. Logs a warn and returns `None` on I/O errors
/// so the loader can continue with other candidates.
fn read_sfnt_bytes(path: &Path) -> Option<Bytes> {
  match std::fs::read(path) {
    Ok(raw) => Some(Bytes::new(raw)),
    Err(err) => {
      tracing::warn!(font = %path.display(), error = %err, "skipping unreadable font file");
      None
    }
  }
}

/// Typst World implementation.
///
/// - Fonts are loaded from `typst-assets` (embedded standard fonts) plus any
///   TTF/OTF files discovered in `extra_font_dirs` at construction time.
///   WOFF2 files are intentionally ignored on this hot path: browser font
///   assets must not be decompressed by the Typst renderer.
/// - The main source is a dynamically generated Typst document string.
/// - Bundle files and document blob assets have disjoint virtual namespaces.
pub struct TypstWorld {
  library: LazyHash<Library>,
  book: LazyHash<FontBook>,
  fonts: Vec<Font>,
  main_id: FileId,
  main: Source,
  /// Blob ID → raw bytes for inline assets (images, etc.).
  blobs: HashMap<String, Bytes>,
  bundle_files: HashMap<String, Bytes>,
  /// Optional base date for `today()`.
  base_date: Option<Datetime>,
}

impl TypstWorld {
  /// Create a world with the given Typst source and blob assets.
  ///
  /// `source` is the complete generated `.typ` document.
  /// `blobs` maps blob IDs (without the `blob:` prefix) to their raw bytes.
  /// `extra_font_dirs` is scanned for `.ttf` / `.otf` files at construction.
  /// `.woff2` files are ignored because Typst consumes raw SFNT fonts here.
  pub fn new(source: String, blobs: HashMap<String, Bytes>, extra_font_dirs: &[PathBuf]) -> Self {
    let mut book = FontBook::new();
    let mut fonts = Vec::new();

    // Phase 0: typst-assets baseline (Linux Libertine, NewCM, DejaVu Mono…).
    for data in typst_assets::fonts() {
      let bytes = Bytes::new(data);
      for font in Font::iter(bytes) {
        book.push(font.info().clone());
        fonts.push(font);
      }
    }

    // Collect SFNT candidates from all extra dirs, sorted for deterministic
    // ordering. WOFF2 and other browser/static assets are ignored.
    let mut sfnt_candidates: Vec<PathBuf> = Vec::new();
    for dir in extra_font_dirs {
      let Ok(entries) = std::fs::read_dir(dir) else {
        continue;
      };
      for entry in entries.flatten() {
        let path = entry.path();
        if is_sfnt_font(&path) {
          sfnt_candidates.push(path);
        }
      }
    }
    sfnt_candidates.sort();

    for path in &sfnt_candidates {
      let Some(bytes) = read_sfnt_bytes(path) else {
        continue;
      };
      for font in Font::iter(bytes) {
        book.push(font.info().clone());
        fonts.push(font);
      }
    }

    let main_id = *GENERATED_MAIN;
    let main = Source::new(main_id, source);

    Self {
      library: LazyHash::new(Library::default()),
      book: LazyHash::new(book),
      fonts,
      main_id,
      main,
      blobs,
      bundle_files: HashMap::new(),
      base_date: None,
    }
  }

  /// Install bundle-local files without granting filesystem or package access.
  /// Keys must be canonical relative paths. Colons reserve the document blob
  /// namespace; normalization aliases are rejected rather than overwritten.
  pub fn with_bundle_files(mut self, files: &HashMap<String, Vec<u8>>) -> FileResult<Self> {
    for (path, bytes) in files {
      let virtual_path = VirtualPath::new(path).map_err(|_| FileError::AccessDenied)?;
      if path.is_empty()
        || path.contains(':')
        || path.contains('\0')
        || path.starts_with('@')
        || virtual_path.get_without_slash() != path
      {
        return Err(FileError::AccessDenied);
      }
      self.bundle_files.insert(path.clone(), Bytes::new(bytes.clone()));
    }
    Ok(self)
  }

  /// Override the base date for deterministic PDF metadata.
  pub fn with_date(mut self, date: Datetime) -> Self {
    self.base_date = Some(date);
    self
  }

  /// Returns `true` when the given family name resolves to at least one
  /// indexed Font in the FontBook.
  ///
  /// Used by the render pipeline to reject unknown workspace-chosen fonts
  /// before Typst can silently substitute another family.
  pub fn has_family(&self, family: &str) -> bool {
    self.book.select_family(family).next().is_some() || self.book.select_family(&family.to_lowercase()).next().is_some()
  }
}

impl typst::World for TypstWorld {
  fn library(&self) -> &LazyHash<Library> {
    &self.library
  }

  fn book(&self) -> &LazyHash<FontBook> {
    &self.book
  }

  fn main(&self) -> FileId {
    self.main_id
  }

  fn source(&self, id: FileId) -> FileResult<Source> {
    if id == self.main_id {
      return Ok(self.main.clone());
    }
    if id.root() != &VirtualRoot::Project {
      return Err(FileError::AccessDenied);
    }
    let path = id.vpath().get_without_slash();
    let bytes = self
      .bundle_files
      .get(path)
      .ok_or_else(|| FileError::NotFound(path.into()))?;
    let text = std::str::from_utf8(bytes).map_err(|_| FileError::InvalidUtf8)?;
    Ok(Source::new(id, text.to_owned()))
  }

  fn file(&self, id: FileId) -> FileResult<Bytes> {
    if id.root() != &VirtualRoot::Project {
      return Err(FileError::AccessDenied);
    }
    let vpath = id.vpath().get_without_slash().to_owned();
    // Serve blob assets: paths formatted as "blob:<blob_id>"
    if let Some(blob_id) = vpath.strip_prefix(BLOB_PATH_PREFIX) {
      if let Some(bytes) = self.blobs.get(blob_id) {
        return Ok(bytes.clone());
      }
      return Err(FileError::NotFound(PathBuf::from(vpath)));
    }
    self
      .bundle_files
      .get(&vpath)
      .cloned()
      .ok_or_else(|| FileError::NotFound(vpath.into()))
  }

  fn font(&self, index: usize) -> Option<Font> {
    self.fonts.get(index).cloned()
  }

  fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
    let _ = offset;
    if let Some(base) = self.base_date {
      return Some(base);
    }
    // Fixed epoch for reproducibility when no date override is set.
    Datetime::from_ymd(2000, 1, 1)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;
  use typst::text::FontVariant;

  fn count_typst_assets_fonts() -> usize {
    let mut n = 0;
    for data in typst_assets::fonts() {
      let bytes = Bytes::new(data);
      n += Font::iter(bytes).count();
    }
    n
  }

  /// INV-FONT-WOFF2-HOTPATH: a `.woff2` file dropped in an extra font dir is
  /// ignored by the Typst renderer. WOFF2 is a browser delivery asset; the
  /// PDF hot path must only index raw SFNT fonts.
  #[test]
  fn inv_font_woff2_extra_dir_ignores_woff2_fonts() {
    let baseline = count_typst_assets_fonts();

    // Use the real bundled Inter regular woff2 from server/static/fonts.
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .unwrap()
      .parent()
      .unwrap()
      .to_path_buf();
    let inter = repo_root.join("static/fonts/inter-regular-latin.woff2");
    assert!(
      inter.exists(),
      "expected bundled woff2 at {} — invariant precondition",
      inter.display()
    );

    let dir = TempDir::new().expect("tempdir");
    std::fs::copy(&inter, dir.path().join("inter-regular-latin.woff2")).expect("copy woff2");

    let world = TypstWorld::new(String::new(), HashMap::new(), &[dir.path().to_path_buf()]);

    assert_eq!(
      world.fonts.len(),
      baseline,
      "WOFF2 files in extra_font_dirs must not be decompressed or indexed"
    );
  }

  /// INV-FONT-NON-FONT: non-font extensions (`.txt`, `.md`, `.json`) in an
  /// extra font dir are silently skipped — we never feed garbage bytes to
  /// `Font::iter`.
  #[test]
  fn inv_font_non_font_files_are_skipped() {
    let baseline = count_typst_assets_fonts();
    let dir = TempDir::new().expect("tempdir");
    std::fs::write(dir.path().join("readme.txt"), b"not a font").unwrap();
    std::fs::write(dir.path().join("manifest.json"), b"{}").unwrap();
    std::fs::write(dir.path().join("foo.md"), b"# nope").unwrap();

    let world = TypstWorld::new(String::new(), HashMap::new(), &[dir.path().to_path_buf()]);
    assert_eq!(
      world.fonts.len(),
      baseline,
      "non-font files must not affect the FontBook"
    );
  }

  /// Decompress the bundled `inter-regular-latin.woff2` to a TTF blob —
  /// used by SFNT-only tests as a stand-in TTF source. We exercise the
  /// WOFF2 → TTF path here intentionally (the loader test below needs an
  /// in-memory TTF that is byte-equal across re-runs); the real bundled
  /// `inter-vf.ttf` is exercised by the integration tests.
  fn synth_inter_ttf() -> Vec<u8> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .unwrap()
      .parent()
      .unwrap()
      .to_path_buf();
    let woff2 = repo_root.join("static/fonts/inter-regular-latin.woff2");
    let raw = std::fs::read(&woff2).expect("read source woff2");
    let mut cursor = std::io::Cursor::new(raw);
    woff2_patched::convert_woff2_to_ttf(&mut cursor).expect("decode inter woff2 → ttf")
  }

  /// INV-FONT-SFNT-ONLY: when both `inter-regular.ttf` and
  /// `inter-regular.woff2` exist, only the TTF is indexed. The WOFF2 is
  /// ignored regardless of whether it duplicates or complements an SFNT face.
  #[test]
  fn inv_font_loader_indexes_ttf_and_ignores_woff2() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .unwrap()
      .parent()
      .unwrap()
      .to_path_buf();
    let inter_woff2 = repo_root.join("static/fonts/inter-regular-latin.woff2");

    let dir = TempDir::new().expect("tempdir");
    let ttf_path = dir.path().join("inter-regular.ttf");
    let woff2_path = dir.path().join("inter-regular-latin.woff2");
    std::fs::write(&ttf_path, synth_inter_ttf()).expect("write ttf");
    std::fs::copy(&inter_woff2, &woff2_path).expect("copy woff2");

    let world = TypstWorld::new(String::new(), HashMap::new(), &[dir.path().to_path_buf()]);

    let inter_count = world
      .fonts
      .iter()
      .filter(|f| f.info().family.eq_ignore_ascii_case("inter"))
      .count();
    assert_eq!(
      inter_count, 1,
      "expected exactly one Inter entry from TTF; WOFF2 must be ignored, got {inter_count}"
    );

    let kept = world
      .fonts
      .iter()
      .find(|f| f.info().family.eq_ignore_ascii_case("inter"))
      .expect("inter font present");
    let ttf_bytes_len = synth_inter_ttf().len();
    assert_eq!(
      kept.data().len(),
      ttf_bytes_len,
      "kept Inter Font must be the TTF (size match)"
    );
  }

  /// INV-FONT-WOFF2-COMPLEMENT-IGNORED: a WOFF2 whose family is not covered
  /// by the TTF set is still ignored. There is no WOFF2 complement phase in
  /// the PDF renderer hot path.
  #[test]
  fn inv_font_woff2_does_not_complement_missing_variants() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .unwrap()
      .parent()
      .unwrap()
      .to_path_buf();
    let kalam_woff2 = repo_root.join("static/fonts/kalam-regular-latin.woff2");
    assert!(
      kalam_woff2.exists(),
      "expected bundled kalam-regular-latin.woff2 — invariant precondition"
    );

    let dir = TempDir::new().expect("tempdir");
    std::fs::write(dir.path().join("inter-regular.ttf"), synth_inter_ttf()).expect("write ttf");
    std::fs::copy(&kalam_woff2, dir.path().join("kalam-regular-latin.woff2")).expect("copy kalam woff2");

    let world = TypstWorld::new(String::new(), HashMap::new(), &[dir.path().to_path_buf()]);

    let has_inter = world
      .fonts
      .iter()
      .any(|f| f.info().family.eq_ignore_ascii_case("inter"));
    let has_kalam = world
      .fonts
      .iter()
      .any(|f| f.info().family.to_lowercase().contains("kalam"));
    assert!(has_inter, "Inter (from TTF) must be indexed");
    assert!(
      !has_kalam,
      "Kalam from WOFF2 must not be indexed, even as a different family"
    );
  }

  /// INV-FONT-DETERMINISTIC: the loader is order-independent w.r.t. the
  /// directory's filesystem listing. Adding the same files to two
  /// independent tempdirs (in different creation order) must yield the
  /// same set of indexed `(family, weight, style)` tuples.
  #[test]
  fn inv_font_loader_is_deterministic() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .unwrap()
      .parent()
      .unwrap()
      .to_path_buf();
    let inter_woff2 = repo_root.join("static/fonts/inter-regular-latin.woff2");
    let inter_ttf = repo_root.join("static/fonts/inter-vf.ttf");
    let kalam = repo_root.join("static/fonts/kalam-regular-latin.woff2");

    fn variants(world: &TypstWorld) -> std::collections::BTreeSet<(String, FontVariant)> {
      world
        .fonts
        .iter()
        .map(|f| (f.info().family.to_lowercase(), f.info().variant))
        .collect()
    }

    let a = TempDir::new().expect("tempdir");
    std::fs::copy(&inter_ttf, a.path().join("inter-vf.ttf")).unwrap();
    std::fs::copy(&inter_woff2, a.path().join("inter-regular-latin.woff2")).unwrap();
    std::fs::copy(&kalam, a.path().join("kalam-regular-latin.woff2")).unwrap();
    let world_a = TypstWorld::new(String::new(), HashMap::new(), &[a.path().to_path_buf()]);

    let b = TempDir::new().expect("tempdir");
    std::fs::copy(&kalam, b.path().join("kalam-regular-latin.woff2")).unwrap();
    std::fs::copy(&inter_woff2, b.path().join("inter-regular-latin.woff2")).unwrap();
    std::fs::copy(&inter_ttf, b.path().join("inter-vf.ttf")).unwrap();
    let world_b = TypstWorld::new(String::new(), HashMap::new(), &[b.path().to_path_buf()]);

    assert_eq!(
      variants(&world_a),
      variants(&world_b),
      "loader must be order-independent — same files → same indexed variants"
    );
  }
}
