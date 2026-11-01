// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared test helpers for the V2 render pipeline.
//!
//! Provides bundled template files (theme + preamble + i18n)
//! as a `HashMap<String, Vec<u8>>` so tests can drive `render_to_pdf_v2`
//! without each one re-implementing the file lookup. The bundle is read
//! lazily from `templates/pdf/{template}/` and cached
//! in `OnceLock`s for the lifetime of the test binary.

use std::collections::HashMap;
use std::sync::OnceLock;

#[allow(dead_code)]
static DEFAULT_BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();
#[allow(dead_code)]
static REPORT_BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();
#[allow(dead_code)]
static DOCUMENTATION_BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();
#[allow(dead_code)]
static LETTER_BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();
#[allow(dead_code)]
static PRESENTATION_CLEAN_BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();
#[allow(dead_code)]
static PRESENTATION_FOCUS_BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();
#[allow(dead_code)]
static PRESENTATION_NAVIGATOR_BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();

/// Load the V2 system `default` template bundle from the
/// `myoxus-pdf-export-templates` crate.
///
/// Tests previously relied on the V1 `Template::lookup("default")` path —
/// after the V1→V2 cut-over (`P-PDF-TPL-06-04-CUTOVER`, 2026-04-30) the
/// bundle is sourced from the same files the system-template seeder ships
/// to the database, ensuring tests render against the same artefact that
/// production serves.
#[allow(dead_code)]
pub fn default_template_bundle() -> &'static HashMap<String, Vec<u8>> {
  DEFAULT_BUNDLE.get_or_init(|| template_bundle("default"))
}

/// Load the V2 system `report` template bundle from the same checked-in
/// template directory the seeder publishes to the database.
#[allow(dead_code)]
pub fn report_template_bundle() -> &'static HashMap<String, Vec<u8>> {
  REPORT_BUNDLE.get_or_init(|| template_bundle("report"))
}

/// Load the V2 system `letter` template bundle from the same checked-in
/// template directory the seeder publishes to the database.
#[allow(dead_code)]
pub fn letter_template_bundle() -> &'static HashMap<String, Vec<u8>> {
  LETTER_BUNDLE.get_or_init(|| template_bundle("letter"))
}

#[allow(dead_code)]
pub fn documentation_template_bundle() -> &'static HashMap<String, Vec<u8>> {
  DOCUMENTATION_BUNDLE.get_or_init(|| template_bundle("myoxus-doc"))
}

#[allow(dead_code)]
pub fn presentation_clean_template_bundle() -> &'static HashMap<String, Vec<u8>> {
  PRESENTATION_CLEAN_BUNDLE.get_or_init(|| template_bundle("presentation-clean"))
}

#[allow(dead_code)]
pub fn presentation_focus_template_bundle() -> &'static HashMap<String, Vec<u8>> {
  PRESENTATION_FOCUS_BUNDLE.get_or_init(|| template_bundle("presentation-focus"))
}

#[allow(dead_code)]
pub fn presentation_navigator_template_bundle() -> &'static HashMap<String, Vec<u8>> {
  PRESENTATION_NAVIGATOR_BUNDLE.get_or_init(|| template_bundle("presentation-navigator"))
}

fn template_bundle(template: &str) -> HashMap<String, Vec<u8>> {
  let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
  let shared = manifest_dir.join("../../templates/pdf");
  let base = shared.join(template);
  let read = |name: &str| {
    // Presentation vendor inputs use the common catalog owner; documentation
    // retains its template-local vendor files, exactly as the startup loader does.
    let path = if template.starts_with("presentation-") && name.starts_with("vendor/") {
      shared.join(name)
    } else {
      base.join(name)
    };
    std::fs::read(&path).unwrap_or_else(|e| panic!("read template fixture {}: {e}", path.display()))
  };
  let manifest: serde_json::Value = serde_json::from_slice(&read("manifest.json")).expect("bundle manifest");
  manifest["assets"]
    .as_array()
    .expect("manifest assets")
    .iter()
    .map(|path| {
      let path = path.as_str().expect("asset path");
      (path.to_owned(), read(path))
    })
    .collect()
}

/// The imported main.typ is a bundle module, never the generated document.
/// A nested JSON read makes both source and binary-file resolution observable.
#[allow(dead_code)]
pub fn local_import_bundle() -> HashMap<String, Vec<u8>> {
  let mut files = default_template_bundle().clone();
  files
    .get_mut("preamble.typ")
    .unwrap()
    .extend_from_slice(b"\n#import \"main.typ\": label\n#text(label)\n");
  files.insert("main.typ".into(), b"#import \"modules/label.typ\": label\n".to_vec());
  files.insert(
    "modules/label.typ".into(),
    b"#import \"nested/value.typ\": label\n".to_vec(),
  );
  files.insert(
    "modules/nested/value.typ".into(),
    b"#let label = json(\"../../data/label.json\").label\n".to_vec(),
  );
  files.insert(
    "data/label.json".into(),
    br#"{"label":"BUNDLE LOCAL IMPORT VERIFIED"}"#.to_vec(),
  );
  files
}

/// Each mutation must fail in upload validation, preview and production render.
#[allow(dead_code)]
pub fn invalid_local_import_bundles() -> Vec<(&'static str, HashMap<String, Vec<u8>>)> {
  let mut cases = Vec::new();
  for (name, source) in [
    ("missing source", b"#import \"missing.typ\": label".as_slice()),
    ("invalid UTF-8", b"\xff\xfe".as_slice()),
    ("outside root", b"#import \"../../../escape.typ\": label".as_slice()),
    ("host path", b"#let label = read(\"/etc/passwd\")".as_slice()),
    ("package", b"#import \"@preview/ilm:2.1.1\": label".as_slice()),
    ("blob source", b"#import \"/blob:label\": label".as_slice()),
    ("missing data", b"#let label = read(\"missing.json\")".as_slice()),
  ] {
    let mut files = local_import_bundle();
    files.insert("modules/nested/value.typ".into(), source.to_vec());
    cases.push((name, files));
  }
  for path in ["blob:label", "../escape.typ", "/main.typ", "modules/../main.typ"] {
    let mut files = local_import_bundle();
    files.insert(path.into(), b"#let label = \"COLLISION\"".to_vec());
    cases.push((path, files));
  }
  cases
}

/// pdf-extract caches font resource names across pages in its whole-document
/// API. Typst may reuse a name for a different subset on another page. Reset
/// the processor per page and propagate every extraction error explicitly.
#[allow(dead_code)]
pub fn pdf_page_text(bytes: &[u8]) -> Vec<String> {
  let document = lopdf::Document::load_mem(bytes).expect("parse rendered PDF");
  document
    .get_pages()
    .keys()
    .map(|number| {
      let mut text = String::new();
      let mut output = pdf_extract::PlainTextOutput::new(&mut text);
      pdf_extract::output_doc_page(&document, &mut output, *number).expect("extract complete PDF page");
      text
    })
    .collect()
}

/// Inspect fonts selected by actual text-showing operators, not unused embedded
/// resources. Every selected font must carry its font program and Unicode map.
#[allow(dead_code)]
pub fn pdf_text_runs(bytes: &[u8]) -> Vec<PdfTextRun> {
  let pdf = lopdf::Document::load_mem(bytes).expect("parse PDF fonts");
  let mut selected = Vec::new();
  for (page_number, page) in pdf.get_pages() {
    let fonts = pdf.get_page_fonts(page).expect("page font resources");
    let encodings: std::collections::BTreeMap<_, _> = fonts
      .iter()
      .map(|(name, font)| {
        let encoding = font.get_font_encoding(&pdf).expect("selected font encoding");
        (name.clone(), encoding)
      })
      .collect();
    let content =
      lopdf::content::Content::decode(&pdf.get_page_content(page).expect("page content")).expect("text operators");
    let mut current = None;
    let mut size = 0.0;
    let mut stack = Vec::new();
    for op in content.operations {
      if op.operator == "q" {
        stack.push((current.clone(), size));
      }
      if op.operator == "Q" {
        (current, size) = stack.pop().expect("balanced graphics state");
      }
      if op.operator == "Tf" {
        current = Some(op.operands[0].as_name().expect("selected font").to_vec());
        size = op.operands[1].as_float().expect("text size");
      }
      let has_text = op.operands.iter().any(|value| match value {
        lopdf::Object::String(bytes, _) => !bytes.is_empty(),
        lopdf::Object::Array(values) => values
          .iter()
          .any(|value| matches!(value,lopdf::Object::String(bytes,_) if !bytes.is_empty())),
        _ => false,
      });
      if has_text && matches!(op.operator.as_str(), "Tj" | "TJ" | "'" | "\"") {
        let font = fonts
          .get(current.as_ref().expect("font before text"))
          .expect("referenced text font");
        let unicode = pdf
          .get_object(font.get(b"ToUnicode").expect("Unicode mapping").as_reference().unwrap())
          .unwrap()
          .as_stream()
          .unwrap();
        assert!(!unicode.content.is_empty(), "selected text has a Unicode map");
        let descendant = pdf
          .get_dictionary(
            font.get(b"DescendantFonts").unwrap().as_array().unwrap()[0]
              .as_reference()
              .unwrap(),
          )
          .unwrap();
        let descriptor = pdf
          .get_dictionary(descendant.get(b"FontDescriptor").unwrap().as_reference().unwrap())
          .unwrap();
        let program = [b"FontFile".as_slice(), b"FontFile2".as_slice(), b"FontFile3".as_slice()]
          .into_iter()
          .find_map(|key| {
            descriptor
              .has(key)
              .then(|| descriptor.get(key).expect("font program field"))
          })
          .expect("selected font is embedded");
        assert!(
          !pdf
            .get_object(program.as_reference().unwrap())
            .unwrap()
            .as_stream()
            .unwrap()
            .content
            .is_empty()
        );
        let encoding = encodings.get(current.as_ref().unwrap()).expect("page-local encoding");
        assert!(
          matches!(encoding, lopdf::Encoding::UnicodeMapEncoding(_)),
          "selected text uses its page-local Unicode map"
        );
        assert_eq!(font.get(b"Encoding").unwrap().as_name().unwrap(), b"Identity-H");
        let glyph_map = if descendant.has(b"CIDToGIDMap") {
          let (_, map) = pdf.dereference(descendant.get(b"CIDToGIDMap").unwrap()).unwrap();
          if let lopdf::Object::Name(name) = map {
            assert_eq!(name, b"Identity");
            None
          } else {
            Some(map.as_stream().expect("CID-to-glyph map").get_plain_content().unwrap())
          }
        } else {
          None
        };
        let mut glyphs = Vec::new();
        let mut text = String::new();
        for value in op.operands.iter().flat_map(|value| match value {
          lopdf::Object::Array(values) => values.as_slice(),
          value => std::slice::from_ref(value),
        }) {
          if let lopdf::Object::String(bytes, _) = value {
            text.push_str(&encoding.bytes_to_string(bytes).expect("decode displayed Unicode"));
            assert_eq!(bytes.len() % 2, 0, "complete Identity-H character codes");
            glyphs.extend(bytes.chunks_exact(2).map(|pair| {
              let cid = u16::from_be_bytes([pair[0], pair[1]]);
              glyph_map.as_ref().map_or(cid, |map| {
                let offset = usize::from(cid) * 2;
                let glyph = map.get(offset..offset + 2).expect("selected CID has a glyph mapping");
                u16::from_be_bytes([glyph[0], glyph[1]])
              })
            }));
          }
        }
        selected.push(PdfTextRun {
          page: page_number,
          text,
          glyphs,
          font: String::from_utf8(font.get(b"BaseFont").unwrap().as_name().unwrap().to_vec()).unwrap(),
          size,
        });
      }
    }
  }
  assert!(!selected.is_empty(), "actual PDF text selects fonts");
  selected
}

/// Actual text-showing operation, with the selected page-local font and size.
#[allow(dead_code)]
pub struct PdfTextRun {
  pub page: u32,
  pub text: String,
  pub glyphs: Vec<u16>,
  pub font: String,
  pub size: f32,
}

#[allow(dead_code)]
pub fn pdf_selected_fonts(bytes: &[u8]) -> std::collections::BTreeSet<String> {
  pdf_text_runs(bytes).into_iter().map(|run| run.font).collect()
}

/// Read only structural K edges; parent pointers deliberately do not recurse.
#[allow(dead_code)]
pub fn pdf_structure_elements(bytes: &[u8]) -> Vec<(String, Option<String>)> {
  fn visit(pdf: &lopdf::Document, value: &lopdf::Object, out: &mut Vec<(String, Option<String>)>) {
    let (_, value) = pdf.dereference(value).expect("structural reference");
    match value {
      lopdf::Object::Array(values) => {
        for value in values {
          visit(pdf, value, out)
        }
      }
      lopdf::Object::Dictionary(dict) => {
        if dict.has(b"S") {
          out.push((
            String::from_utf8(dict.get(b"S").unwrap().as_name().unwrap().to_vec()).unwrap(),
            dict
              .has(b"Alt")
              .then(|| lopdf::decode_text_string(dict.get(b"Alt").unwrap()).unwrap()),
          ));
        }
        if dict.has(b"K") {
          visit(pdf, dict.get(b"K").unwrap(), out);
        }
      }
      lopdf::Object::Integer(_) => {}
      other => panic!("unexpected structural child: {other:?}"),
    }
  }
  let pdf = lopdf::Document::load_mem(bytes).expect("parse real PDF structure");
  let mut out = Vec::new();
  visit(
    &pdf,
    pdf
      .catalog()
      .unwrap()
      .get(b"StructTreeRoot")
      .expect("native structure tree"),
    &mut out,
  );
  assert!(!out.is_empty(), "nonempty native structure tree");
  out
}
