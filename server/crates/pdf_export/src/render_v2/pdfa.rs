// SPDX-License-Identifier: AGPL-3.0-or-later
//! PDF/A helpers and explicit external PDF/A/PDF/UA validator profiles.
//!
//! Native Typst serialization owns each export's standards and XMP. These
//! pure IR-preflight/XMP helpers do not replace that writer or independent
//! validation. The HTTP adapter lives in `myoxus-infrastructure`; sync and
//! queued publication share its validator contract through the worker pipeline.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, instrument, warn};

use crate::ir::IrDocument;
use crate::ir::block::Block;
use crate::ir::inline::InlineSpan;

// ─── Profile + preflight ────────────────────────────────────────────────────

/// Admitted PDF/A levels. Level U adds Unicode mapping to the archival
/// guarantees; tagging and accessibility remain separate contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfaProfile {
  /// `PDF/A-1b` — most conservative; rejects transparency, JBIG2, …
  Pdfa1b,
  /// `PDF/A-2b` — adds JPEG 2000, transparency, layers.
  Pdfa2b,
  /// `PDF/A-2u` — PDF/A-2 with Unicode text mapping.
  Pdfa2u,
  /// `PDF/A-3b` — adds embedded files (use for invoices that carry the
  /// machine-readable XML alongside the visible page).
  Pdfa3b,
}

impl PdfaProfile {
  /// PDF/A part and conformance marker used by the XMP helper.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Pdfa1b => "1B",
      Self::Pdfa2b => "2B",
      Self::Pdfa2u => "2U",
      Self::Pdfa3b => "3B",
    }
  }

  /// XMP `pdfaid:part` value (the digit that goes into the part
  /// metadata).
  pub fn part(self) -> u8 {
    match self {
      Self::Pdfa1b => 1,
      Self::Pdfa2b | Self::Pdfa2u => 2,
      Self::Pdfa3b => 3,
    }
  }

  /// Native REST flavour ID. Unknown IDs can trigger veraPDF's fallback
  /// profile, so the HTTP consumer also checks the returned profile name.
  pub fn verapdf_rest_slug(self) -> &'static str {
    match self {
      Self::Pdfa1b => "1b",
      Self::Pdfa2b => "2b",
      Self::Pdfa2u => "2u",
      Self::Pdfa3b => "3b",
    }
  }

  /// Identity supplied by the configured veraPDF profile/report contract.
  pub fn report_name(self) -> &'static str {
    match self {
      Self::Pdfa1b => "PDF/A-1b validation profile",
      Self::Pdfa2b => "PDF/A-2b validation profile",
      Self::Pdfa2u => "PDF/A-2u validation profile",
      Self::Pdfa3b => "PDF/A-3b validation profile",
    }
  }
}

/// Explicit external-validation target; archival preflight/XMP helpers retain PdfaProfile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerapdfProfile {
  Pdfa(PdfaProfile),
  Pdfua1,
}

impl From<PdfaProfile> for VerapdfProfile {
  fn from(profile: PdfaProfile) -> Self {
    Self::Pdfa(profile)
  }
}

impl VerapdfProfile {
  pub fn verapdf_rest_slug(self) -> &'static str {
    match self {
      Self::Pdfa(profile) => profile.verapdf_rest_slug(),
      Self::Pdfua1 => "ua1",
    }
  }
  pub fn report_name(self) -> &'static str {
    match self {
      Self::Pdfa(profile) => profile.report_name(),
      Self::Pdfua1 => "PDF/UA-1 validation profile",
    }
  }
  pub fn failure_class(self) -> &'static str {
    match self {
      Self::Pdfa(_) => "PdfaValidationFailed",
      Self::Pdfua1 => "PdfuaValidationFailed",
    }
  }
}

/// Facts supplied to the optional IR preflight helper. Native serialization
/// remains responsible for actual font embedding and output intents.
#[derive(Debug, Clone)]
pub struct PdfaPreflightInputs<'a> {
  pub doc: &'a IrDocument,
  /// Profile the caller is targeting.
  pub profile: PdfaProfile,
  /// Caller assurance that configured font programs are available for embedding.
  /// Bundled theme fonts and approved add-ons have separate catalog owners.
  pub all_fonts_embedded: bool,
  /// True when the workspace has an active ICC profile pinned via
  /// `pdf_export_settings.default_color_profile_id`. PDF/A demands
  /// an output-intent ICC profile for any non-grayscale render.
  pub icc_pinned: bool,
}

/// One finding from the optional IR preflight helper.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PdfaFinding {
  pub code: PdfaCode,
  pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfaCode {
  /// One or more workspace / template fonts cannot be embedded
  /// (license blocked, missing approval, …).
  FontNotEmbeddable,
  /// No ICC profile pinned — output intent cannot be written.
  IccNotPinned,
  /// Document carries an inline JavaScript reference (e.g. a link
  /// span with `javascript:` href). PDF/A bans interactive scripting.
  JavaScriptAction,
}

#[derive(Debug, Error)]
pub enum PdfaError {
  #[error("pdfa preflight rejected the render: {0}")]
  PreflightFailed(String),
  #[error("verapdf client transport: {0}")]
  Transport(String),
  #[error("verapdf reported validation failures: {0}")]
  ValidationFailed(String),
}

/// Run all pre-flight checks. Returns an empty list when the IR /
/// context are PDF/A-ready; otherwise the caller must abort the render
/// with `PdfaCode`-keyed errors.
#[instrument(skip(inputs), fields(profile = ?inputs.profile))]
pub fn pdfa_preflight(inputs: &PdfaPreflightInputs<'_>) -> Vec<PdfaFinding> {
  let mut findings = Vec::new();

  if !inputs.all_fonts_embedded {
    findings.push(PdfaFinding {
      code: PdfaCode::FontNotEmbeddable,
      message: "PDF/A requires every glyph to come from an embedded font; one or more requested fonts are not approved"
        .into(),
    });
  }
  if !inputs.icc_pinned {
    findings.push(PdfaFinding {
      code: PdfaCode::IccNotPinned,
      message: "PDF/A requires a pinned ICC output-intent profile; pdf export settings carry none".into(),
    });
  }

  let mut state = JsScanState { found: false };
  scan_for_javascript(&inputs.doc.root, &mut state);
  if state.found {
    findings.push(PdfaFinding {
      code: PdfaCode::JavaScriptAction,
      message: "document contains a `javascript:` link target; PDF/A forbids interactive JavaScript".into(),
    });
  }

  if !findings.is_empty() {
    warn!(?findings, "pdfa preflight failed");
  } else {
    debug!("pdfa preflight clean");
  }
  findings
}

struct JsScanState {
  found: bool,
}

fn scan_for_javascript(block: &Block, state: &mut JsScanState) {
  if state.found {
    return;
  }
  block.for_each_local_footnote_body(&mut |body| {
    for child in body {
      scan_for_javascript(child, state);
    }
  });
  match block {
    Block::Paragraph { content, children, .. }
    | Block::Heading { content, children, .. }
    | Block::Quote { content, children, .. }
    | Block::List { content, children, .. }
    | Block::Callout { content, children, .. } => {
      for span in content {
        if let InlineSpan::Text { marks, .. } = span
          && let Some(href) = &marks.link
          && href.trim_start().to_lowercase().starts_with("javascript:")
        {
          state.found = true;
          return;
        }
      }
      for c in children {
        scan_for_javascript(c, state);
        if state.found {
          return;
        }
      }
    }
    Block::Page { children, .. }
    | Block::Note { children }
    | Block::LocalNoteDefinition { children, .. }
    | Block::EdgelessText { children, .. } => {
      for c in children {
        scan_for_javascript(c, state);
        if state.found {
          return;
        }
      }
    }
    _ => {}
  }
}

// ─── XMP metadata ────────────────────────────────────────────────────────────

/// Inputs to the standalone XMP helper. Product PDF serialization uses
/// Typst's native metadata writer.
#[derive(Debug, Clone)]
pub struct XmpMetadata<'a> {
  pub title: &'a str,
  pub author: &'a str,
  pub subject: Option<&'a str>,
  pub keywords: &'a [String],
  pub creator_tool: &'a str,
  pub producer: &'a str,
  pub conformance: PdfaProfile,
}

/// Render the XMP packet as a UTF-8 byte slice. The output is suitable
/// for embedding in a `<x:xmpmeta>` stream right after the PDF header.
///
/// We hand-roll the XML because the writes are tiny + deterministic +
/// every PDF library that takes XMP wants the bytes verbatim. Going
/// through a generic XML builder for ~12 elements would only add
/// dependencies.
pub fn build_xmp_metadata(meta: &XmpMetadata<'_>) -> Vec<u8> {
  let title = xml_escape(meta.title);
  let author = xml_escape(meta.author);
  let subject = meta.subject.map(xml_escape).unwrap_or_default();
  let creator_tool = xml_escape(meta.creator_tool);
  let producer = xml_escape(meta.producer);
  let part = meta.conformance.part();
  let conformance = meta.conformance.as_str().chars().last().unwrap_or('B');

  let keywords_li: String = meta
    .keywords
    .iter()
    .map(|k| format!("        <rdf:li xml:lang=\"x-default\">{}</rdf:li>\n", xml_escape(k)))
    .collect();

  format!(
    r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
      xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <dc:title>
        <rdf:Alt><rdf:li xml:lang="x-default">{title}</rdf:li></rdf:Alt>
      </dc:title>
      <dc:creator>
        <rdf:Seq><rdf:li>{author}</rdf:li></rdf:Seq>
      </dc:creator>
      <dc:description>
        <rdf:Alt><rdf:li xml:lang="x-default">{subject}</rdf:li></rdf:Alt>
      </dc:description>
      <dc:subject>
        <rdf:Bag>
{keywords_li}        </rdf:Bag>
      </dc:subject>
      <xmp:CreatorTool>{creator_tool}</xmp:CreatorTool>
      <pdf:Producer>{producer}</pdf:Producer>
      <pdfaid:part>{part}</pdfaid:part>
      <pdfaid:conformance>{conformance}</pdfaid:conformance>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#
  )
  .into_bytes()
}

fn xml_escape(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&apos;")
}

// ─── veraPDF client ─────────────────────────────────────────────────────────

/// Trait for the veraPDF validator client. Behind a trait so tests
/// can swap in a deterministic mock; the production impl is
/// the infrastructure HTTP adapter; [`HttpVerapdfClient`] owns its URL contract.
#[async_trait::async_trait]
pub trait VerapdfClient: Send + Sync {
  /// Validate a rendered PDF against the requested profile.
  ///
  /// Transport/client failures return `Err`; the actual conformance verdict
  /// stays in [`VerapdfReport::passed`] so callers can preserve veraPDF's
  /// diagnostics and map the negative report to the product error class that
  /// matches the surrounding render path.
  async fn validate(&self, pdf_bytes: &[u8], profile: VerapdfProfile) -> Result<VerapdfReport, PdfaError>;
}

/// Result of a veraPDF run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerapdfReport {
  pub passed: bool,
  /// Diagnostic strings the validator produced. Empty when `passed`
  /// is true.
  pub failures: Vec<String>,
}

/// Production HTTP client configuration for the veraPDF REST endpoint.
///
/// Configuration is intentionally minimal: caller passes the base URL and a
/// per-request timeout. The production reqwest implementation lives in
/// `myoxus-infrastructure`; this type only owns the stable URL builder so the
/// renderer crate stays HTTP-client-free.
#[derive(Debug, Clone)]
pub struct HttpVerapdfClient {
  pub base_url: String,
  pub timeout: Duration,
}

impl HttpVerapdfClient {
  pub fn new(base_url: impl Into<String>, timeout: Duration) -> Self {
    Self {
      base_url: base_url.into(),
      timeout,
    }
  }

  /// Build the validate URL for a given profile. Exposed for tests so
  /// they can assert the URL shape without hitting the network.
  pub fn validate_url(&self, profile: VerapdfProfile) -> String {
    format!(
      "{}/api/validate/{}",
      self.base_url.trim_end_matches('/'),
      profile.verapdf_rest_slug()
    )
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ir::block::HeadingLevel;
  use crate::ir::inline::TextMarks;
  use crate::ir::{Branding, DocumentMetadata, ExportOptions};
  use uuid::Uuid;

  fn doc(root: Block) -> IrDocument {
    IrDocument {
      version: crate::ir::CURRENT_IR_VERSION,
      metadata: DocumentMetadata {
        doc_id: Uuid::nil(),
        workspace_id: Uuid::nil(),
        title: None,
        author: None,
        created_at: None,
        updated_at: None,
        workspace_name: None,
        branding: Branding::default(),
      },
      options: ExportOptions::default(),
      assets: Default::default(),
      root,
    }
  }

  fn page(children: Vec<Block>) -> Block {
    Block::Page {
      title: vec![],
      children,
    }
  }

  /// `INV-PDFA-01`: a clean preflight (fonts embedded + ICC pinned +
  /// no JS) returns zero findings.
  #[test]
  fn inv_pdfa01_clean_preflight_zero_findings() {
    let d = doc(page(vec![Block::Heading {
      level: HeadingLevel::H1,
      content: vec![InlineSpan::Text {
        text: "Title".into(),
        marks: Default::default(),
      }],
      children: vec![],
    }]));
    let findings = pdfa_preflight(&PdfaPreflightInputs {
      doc: &d,
      profile: PdfaProfile::Pdfa1b,
      all_fonts_embedded: true,
      icc_pinned: true,
    });
    assert!(findings.is_empty(), "expected clean preflight, got {findings:?}");
  }

  /// `INV-PDFA-02` (`P-PDF-TPL-PDFA-01-06`): missing XMP / no ICC
  /// pinned would fail veraPDF — surfaced at preflight time.
  #[test]
  fn inv_pdfa02_missing_icc_fails_preflight() {
    let d = doc(page(vec![]));
    let findings = pdfa_preflight(&PdfaPreflightInputs {
      doc: &d,
      profile: PdfaProfile::Pdfa1b,
      all_fonts_embedded: true,
      icc_pinned: false,
    });
    assert!(findings.iter().any(|f| f.code == PdfaCode::IccNotPinned));
  }

  /// `INV-PDFA-03` (`P-PDF-TPL-PDFA-01-07`): JavaScript link target
  /// stripped/blocked at preflight. The PDF never gets rendered with
  /// the JS reference embedded.
  #[test]
  fn inv_pdfa03_javascript_action_caught_at_preflight() {
    let marks = TextMarks {
      link: Some("javascript:alert(1)".into()),
      ..Default::default()
    };
    let d = doc(page(vec![Block::Paragraph {
      content: vec![InlineSpan::Text {
        text: "click".into(),
        marks,
      }],
      children: vec![],
    }]));
    let findings = pdfa_preflight(&PdfaPreflightInputs {
      doc: &d,
      profile: PdfaProfile::Pdfa1b,
      all_fonts_embedded: true,
      icc_pinned: true,
    });
    assert!(
      findings.iter().any(|f| f.code == PdfaCode::JavaScriptAction),
      "expected JavaScriptAction finding, got {findings:?}"
    );
  }

  /// XMP packet contains the conformance level and embeds title /
  /// author safely (XML-escaped).
  #[test]
  fn xmp_metadata_round_trips_and_escapes() {
    let xmp = build_xmp_metadata(&XmpMetadata {
      title: "<Quarterly Report>",
      author: "Alice & Bob",
      subject: Some("Test"),
      keywords: &["one".into(), "two".into()],
      creator_tool: "Myoxus PDF",
      producer: "Typst v0.15.1",
      conformance: PdfaProfile::Pdfa1b,
    });
    let s = String::from_utf8(xmp).expect("utf8");
    assert!(s.contains("<pdfaid:part>1</pdfaid:part>"));
    assert!(s.contains("<pdfaid:conformance>B</pdfaid:conformance>"));
    assert!(s.contains("&lt;Quarterly Report&gt;"));
    assert!(s.contains("Alice &amp; Bob"));
    assert!(s.contains("<rdf:li xml:lang=\"x-default\">one</rdf:li>"));
  }

  /// veraPDF URL builder produces the expected REST shape.
  #[test]
  fn verapdf_url_shape() {
    let client = HttpVerapdfClient::new("http://verapdf:8080/", Duration::from_secs(10));
    assert_eq!(
      client.validate_url(PdfaProfile::Pdfa2b.into()),
      "http://verapdf:8080/api/validate/2b"
    );
  }
}
