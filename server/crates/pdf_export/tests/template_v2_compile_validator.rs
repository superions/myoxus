// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for the V2 template compile validator.

use std::collections::HashMap;
use std::time::Duration;

use myoxus_pdf_export::template_v2::compile_validator::{
  CompileError, render_preview_pdf_bytes_with_limits_and_permit, render_stub_pdf_bytes,
  render_stub_pdf_bytes_with_timeout, validate_template_compiles_with_timeout,
};

mod common;

/// Slim down the bundled V2 default template to the file pair the compile
/// validator inspects. Other bundle entries (i18n JSON, `main.typ`) are
/// irrelevant to the theme + preamble syntax checks exercised here, and
/// keeping the test bundle minimal makes broken-syntax mutations easier
/// to author.
fn default_template_files() -> HashMap<String, Vec<u8>> {
  let bundle = common::default_template_bundle();
  let mut files = HashMap::new();
  files.insert("theme.typ".into(), bundle["theme.typ"].clone());
  files.insert("preamble.typ".into(), bundle["preamble.typ"].clone());
  files
}

fn minimal_manifest() -> myoxus_domain::pdf_template_manifest::PdfTemplateManifest {
  serde_json::from_str(include_str!("fixtures/minimal_manifest_v2.json")).expect("fixture manifest must deserialise")
}

/// INV-VAL-01: the registered default template compiles the stub document without error.
#[tokio::test]
async fn inv_val01_default_template_validates() {
  let files = default_template_files();
  let manifest = minimal_manifest();
  let result = validate_template_compiles_with_timeout(&files, &manifest, Duration::from_secs(30)).await;
  assert!(result.is_ok(), "default template must compile cleanly: {result:?}");
}

/// INV-VAL-01B: the representative preview preserves content in the rendered PDF.
#[tokio::test]
async fn inv_val01b_stub_preview_returns_pdf_bytes() {
  let files = default_template_files();
  let manifest = minimal_manifest();
  let bytes = render_preview_pdf_bytes_with_limits_and_permit(&files, &manifest, "de", Default::default(), ())
    .await
    .expect("stub preview must render");
  let pdf = lopdf::Document::load_mem(&bytes).expect("preview PDF must parse");
  assert!(pdf.get_pages().len() > 1, "the preview must exercise page flow");
  let text = pdf_extract::extract_text_from_mem(&bytes).expect("preview text must be selectable");
  for required in [
    "Projektbericht",
    "Hinweis zur Einordnung",
    "Fußnote zur Zusammenfassung",
    "Endnote:",
  ] {
    assert!(text.contains(required), "missing rendered preview content: {required}");
  }
}

/// INV-VAL-01C: caller-provided preview watchdog is honored.
#[tokio::test(flavor = "multi_thread")]
async fn inv_val01c_stub_preview_timeout_uses_caller_deadline() {
  let files = default_template_files();
  let manifest = minimal_manifest();
  let result = render_stub_pdf_bytes_with_timeout(&files, &manifest, Duration::from_nanos(1)).await;
  assert!(
    matches!(result, Err(CompileError::Timeout)),
    "preview render must honor the caller timeout, got: {result:?}"
  );
}

/// INV-VAL-02: a template whose `theme.typ` contains a syntax error is rejected.
#[tokio::test]
async fn inv_val02_broken_typst_syntax_rejected() {
  let mut files = default_template_files();
  // Prepend an incomplete `#let` binding so Typst raises a parse/compile error.
  let mut broken = b"#let x =\n".to_vec();
  broken.extend_from_slice(files["theme.typ"].as_slice());
  files.insert("theme.typ".into(), broken);

  let manifest = minimal_manifest();
  let result = validate_template_compiles_with_timeout(&files, &manifest, Duration::from_secs(30)).await;
  assert!(
    matches!(result, Err(CompileError::CompileFailed { .. })),
    "broken syntax must yield CompileFailed, got: {result:?}"
  );
}

/// INV-VAL-03: a runaway loop template is rejected by the watchdog pipeline.
///
/// Typst 0.15 detects infinite loops early via its own loop detector and
/// raises a "loop seems to be infinite" diagnostic before the OS timeout
/// fires. The validator is still required to reject the template; whether the
/// rejection arrives via `CompileError::Timeout` (watchdog) or via
/// `CompileError::CompileFailed` (Typst's internal loop-detector) is an
/// implementation detail of the Typst version in use.
///
/// The watchdog timeout is set to 5 s so CI is not blocked for 120 s.
#[tokio::test(flavor = "multi_thread")]
async fn inv_val03_infinite_loop_is_rejected() {
  let mut files = default_template_files();
  files.insert("preamble.typ".into(), b"#while calc.odd(1) {}".to_vec());

  let manifest = minimal_manifest();
  let result = validate_template_compiles_with_timeout(&files, &manifest, Duration::from_secs(5)).await;
  let is_rejected = matches!(
    &result,
    Err(CompileError::Timeout) | Err(CompileError::CompileFailed { .. })
  );
  assert!(
    is_rejected,
    "runaway template must be rejected (Timeout or CompileFailed), got: {result:?}"
  );
  // Verify the rejection is not a false negative: the error must be
  // attributable to the loop, not an unrelated compile issue.
  if let Err(CompileError::CompileFailed { diagnostics }) = &result {
    let is_loop_error = diagnostics.iter().any(|d| d.contains("loop") || d.contains("infinite"));
    assert!(
      is_loop_error,
      "CompileFailed rejection must reference the loop, got diagnostics: {diagnostics:?}"
    );
  }
}

/// Observe the actual production child, rather than a Tokio sleep or Typst's
/// early infinite-loop rejection. This finite template must outlive its deadline.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn inv_val04_timeout_reaps_compiler_and_next_preview_succeeds() {
  let mut files = default_template_files();
  files.insert(
    "preamble.typ".into(),
    b"#for n in range(10000) { for m in range(10000) { let s = str(n + m) } }".to_vec(),
  );
  let manifest = minimal_manifest();
  let task =
    tokio::spawn(async move { render_stub_pdf_bytes_with_timeout(&files, &manifest, Duration::from_secs(1)).await });
  let pid = wait_for_compiler().await;
  let result = task.await.expect("preview caller");
  assert!(
    matches!(result, Err(CompileError::Timeout)),
    "finite work must reach deadline: {result:?}"
  );
  assert!(
    !std::path::Path::new(&format!("/proc/{pid}")).exists(),
    "compiler must be stopped and reaped before Timeout"
  );
  let pdf = render_stub_pdf_bytes(&default_template_files(), &minimal_manifest())
    .await
    .expect("subsequent preview");
  assert!(pdf.starts_with(b"%PDF-"));
}

#[cfg(target_os = "linux")]
async fn wait_for_compiler() -> u32 {
  let started = std::time::Instant::now();
  loop {
    for task in std::fs::read_dir("/proc/self/task").expect("task inventory") {
      let children = std::fs::read_to_string(task.expect("task entry").path().join("children")).unwrap_or_default();
      for pid in children.split_whitespace() {
        let exe = std::fs::read_link(format!("/proc/{pid}/exe"));
        if exe.is_ok_and(|path| path.file_name().is_some_and(|name| name == "myoxus-pdf-compiler")) {
          return pid.parse().expect("child pid");
        }
      }
    }
    assert!(
      started.elapsed() < Duration::from_secs(2),
      "production compiler must start"
    );
    tokio::time::sleep(Duration::from_millis(5)).await;
  }
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn cancellation_retains_admission_until_compiler_is_reaped() {
  use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  };
  struct Permit(Arc<AtomicBool>);
  impl Drop for Permit {
    fn drop(&mut self) {
      self.0.store(true, Ordering::Release);
    }
  }
  let released = Arc::new(AtomicBool::new(false));
  let permit = Permit(released.clone());
  let mut files = default_template_files();
  files.insert(
    "preamble.typ".into(),
    b"#for n in range(10000) { for m in range(10000) { let s = str(n + m) } }".to_vec(),
  );
  let task = tokio::spawn(async move {
    myoxus_pdf_export::template_v2::compile_validator::render_stub_pdf_bytes_with_permit(
      &files,
      &minimal_manifest(),
      Duration::from_secs(30),
      permit,
    )
    .await
  });
  let pid = wait_for_compiler().await;
  assert!(!released.load(Ordering::Acquire));
  task.abort();
  assert!(task.await.expect_err("cancel caller").is_cancelled());
  let deadline = std::time::Instant::now() + Duration::from_secs(2);
  while !released.load(Ordering::Acquire) {
    assert!(
      std::time::Instant::now() < deadline,
      "supervisor must finish cancellation"
    );
    tokio::time::sleep(Duration::from_millis(5)).await;
  }
  assert!(
    !std::path::Path::new(&format!("/proc/{pid}")).exists(),
    "permit must outlive compiler"
  );
}

#[tokio::test]
async fn local_modules_and_nested_data_reach_validation_and_preview() {
  let files = common::local_import_bundle();
  let manifest = minimal_manifest();
  validate_template_compiles_with_timeout(&files, &manifest, Duration::from_secs(30))
    .await
    .expect("nested bundle must pass upload validation");
  let bytes = render_stub_pdf_bytes(&files, &manifest)
    .await
    .expect("nested bundle preview");
  let text = pdf_extract::extract_text_from_mem(&bytes).expect("selectable preview text");
  assert!(
    text.contains("BUNDLE LOCAL IMPORT VERIFIED"),
    "nested JSON content missing: {text}"
  );
}

#[tokio::test]
async fn inaccessible_bundle_sources_fail_validation_and_preview() {
  let manifest = minimal_manifest();
  for (name, files) in common::invalid_local_import_bundles() {
    let validation = validate_template_compiles_with_timeout(&files, &manifest, Duration::from_secs(30)).await;
    assert!(
      matches!(validation, Err(CompileError::CompileFailed { .. })),
      "{name}: {validation:?}"
    );
    let preview = render_stub_pdf_bytes(&files, &manifest).await;
    assert!(
      matches!(preview, Err(CompileError::CompileFailed { .. })),
      "{name}: {preview:?}"
    );
  }
}

#[tokio::test]
async fn documentation_preview_uses_manifest_defaults_and_localized_toc() {
  let files = common::documentation_template_bundle();
  let mut manifest: myoxus_domain::pdf_template_manifest::PdfTemplateManifest =
    serde_json::from_str(include_str!("../../../templates/pdf/myoxus-doc/manifest.json")).unwrap();
  for (locale, label) in [
    ("en", "Contents"),
    ("de", "Inhaltsverzeichnis"),
    ("fr", "Table des matières"),
    ("es", "Índice"),
  ] {
    manifest.capabilities.language.default = locale.into();
    let bytes = render_stub_pdf_bytes(files, &manifest)
      .await
      .expect("documentation preview");
    let text = common::pdf_page_text(&bytes).join("\n");
    assert_eq!(text.matches(label).count(), 1, "one localized TOC for {locale}: {text}");
    assert!(text.contains("Myoxus Validator"), "cover author missing");
    assert!(text.contains("Cell 2"), "body table missing");
  }
  manifest.capabilities.cover_page.default = false;
  manifest.capabilities.toc_behavior.default = myoxus_domain::pdf_template_manifest::PdfTocBehavior::Off;
  let bytes = render_stub_pdf_bytes(files, &manifest).await.expect("no-cover preview");
  let text = common::pdf_page_text(&bytes).join("\n");
  assert!(!text.contains("Myoxus Validator"), "disabled cover was rendered");
  assert!(!text.contains("Índice"), "disabled TOC was rendered");
  assert!(text.contains("Cell 2"));
}
