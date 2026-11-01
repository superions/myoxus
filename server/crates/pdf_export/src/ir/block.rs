// SPDX-License-Identifier: AGPL-3.0-or-later
use serde::{Deserialize, Serialize};

use super::inline::InlineSpan;

// ─── Shared primitives ───────────────────────────────────────────────────────

/// A resolved binary asset (image, embedded attachment content).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetData {
  pub mime: String,
  #[serde(with = "serde_bytes")]
  pub bytes: Vec<u8>,
  /// Original filename hint (for Content-Disposition in attachments).
  pub filename: Option<String>,
}

/// A reference to a blob asset (pre-resolution; used before the asset resolver runs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobRef {
  pub blob_id: String,
  pub mime_hint: Option<String>,
}

/// Resolved or unresolved image: if resolved, `data` is Some.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRef {
  pub blob: BlobRef,
  /// Alt text / caption from the block's caption field.
  pub caption: Option<Vec<InlineSpan>>,
  /// Width hint in points (may be None = fit to column).
  pub width_hint: Option<f64>,
  pub height_hint: Option<f64>,
  /// Resolved image bytes. Set by the AssetResolver.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub data: Option<AssetData>,
}

/// Inline styles for rich text (Delta format from Yjs Y.Text).
pub type RichText = Vec<InlineSpan>;

// ─── Heading level ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HeadingLevel {
  H1 = 1,
  H2 = 2,
  H3 = 3,
  H4 = 4,
  H5 = 5,
  H6 = 6,
}

// ─── List ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListType {
  Bulleted,
  Numbered,
  Todo,
  Toggle,
}

// ─── Callout ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalloutVariant {
  Info,
  Warning,
  Note,
  Tip,
}

// ─── Table ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCell {
  pub content: RichText,
  pub is_header: bool,
  pub col_span: u16,
  pub row_span: u16,
  /// Column alignment: "left" | "center" | "right"
  pub align: Option<String>,
  /// Concrete content paint resolved from the dispatch snapshot, never a CSS expression.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub fill: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub foreground: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRow {
  pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableAppearance {
  Grid,
  Ruled,
  Plain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableDensity {
  Normal,
  Compact,
}

// ─── Code block ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeBlock {
  pub language: Option<String>,
  pub code: String,
  pub caption: Option<RichText>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MermaidDiagram {
  pub source: String,
  pub title: Option<RichText>,
  pub caption: Option<RichText>,
}

// ─── Embed/Bookmark card ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedCard {
  pub url: String,
  pub title: Option<String>,
  pub description: Option<String>,
  pub favicon: Option<BlobRef>,
  /// "loom" | "figma" | "youtube" | "github" | "linked-doc" | "bookmark" | "other"
  pub embed_kind: String,
}

// ─── Database / Table-view ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseColumn {
  pub name: String,
  /// "text" | "number" | "date" | "select" | "multi-select" | "checkbox" | "url" | "email" | "file"
  pub data_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseTableView {
  pub columns: Vec<DatabaseColumn>,
  pub rows: Vec<Vec<RichText>>,
}

// ─── Edgeless snapshot ───────────────────────────────────────────────────────

/// V1: always a raster PNG snapshot of the canvas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgelessSnapshot {
  #[serde(with = "serde_bytes")]
  pub png_bytes: Vec<u8>,
  pub width_px: u32,
  pub height_px: u32,
  pub caption: Option<RichText>,
}

/// V1 size envelope for client-supplied edgeless raster snapshots
/// (`myoxus:surface`, `myoxus:surface-ref`, `myoxus:frame`,
/// `myoxus:mindmap`).
///
/// The contract is symmetric: clients downscale before upload, the
/// server rejects anything that still exceeds the envelope so a single
/// runaway canvas cannot blow up the renderer or the blob store. The
/// constants are exposed so client and server agree on the same limits
/// without an out-of-band magic-number drift.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EdgelessSnapshotLimits {
  /// Maximum length of either canvas axis (`width_px`, `height_px`).
  pub max_canvas_dimension_px: u32,
  /// Maximum total pixel count `width_px * height_px`.
  pub max_canvas_total_pixels: u64,
  /// Maximum encoded PNG byte length.
  pub max_snapshot_size_bytes: usize,
}

impl EdgelessSnapshotLimits {
  /// Per-axis ceiling — 8192 px (matches `todo/pdf-refactoring.md` P8).
  pub const MAX_CANVAS_DIMENSION_PX: u32 = 8192;
  /// Total-pixel ceiling — 4096 × 4096 = 16,777,216 px.
  pub const MAX_CANVAS_TOTAL_PIXELS: u64 = 4096 * 4096;
  /// Encoded PNG byte ceiling — 32 MiB.
  pub const MAX_SNAPSHOT_SIZE_BYTES: usize = 32 * 1024 * 1024;

  pub const DEFAULT: Self = Self {
    max_canvas_dimension_px: Self::MAX_CANVAS_DIMENSION_PX,
    max_canvas_total_pixels: Self::MAX_CANVAS_TOTAL_PIXELS,
    max_snapshot_size_bytes: Self::MAX_SNAPSHOT_SIZE_BYTES,
  };
}

impl Default for EdgelessSnapshotLimits {
  fn default() -> Self {
    Self::DEFAULT
  }
}

/// A single way an [`EdgelessSnapshot`] can violate
/// [`EdgelessSnapshotLimits`]. `Display` produces the human-readable
/// reason carried inside [`crate::RenderError::SnapshotLimitExceeded`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotLimitViolation {
  DimensionExceeded { axis: &'static str, value: u32, max: u32 },
  TotalPixelsExceeded { value: u64, max: u64 },
  SizeExceeded { bytes: usize, max: usize },
}

impl std::fmt::Display for SnapshotLimitViolation {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::DimensionExceeded { axis, value, max } => {
        write!(f, "{axis} {value}px exceeds max {max}px")
      }
      Self::TotalPixelsExceeded { value, max } => {
        write!(f, "{value} total pixels exceeds max {max}")
      }
      Self::SizeExceeded { bytes, max } => {
        write!(f, "{bytes}B encoded PNG exceeds max {max}B")
      }
    }
  }
}

impl EdgelessSnapshot {
  /// Builder-emitted placeholder before client capture lands. Validation
  /// must skip these — they carry no bytes and render as a blank slot.
  pub fn is_empty_placeholder(&self) -> bool {
    self.png_bytes.is_empty() && self.width_px == 0 && self.height_px == 0
  }

  /// Check the snapshot fits within `limits`. Empty placeholders always
  /// pass. Returns the *first* violation observed; callers are expected
  /// to show this verbatim to the user.
  pub fn validate(&self, limits: &EdgelessSnapshotLimits) -> Result<(), SnapshotLimitViolation> {
    if self.is_empty_placeholder() {
      return Ok(());
    }
    if self.width_px > limits.max_canvas_dimension_px {
      return Err(SnapshotLimitViolation::DimensionExceeded {
        axis: "width",
        value: self.width_px,
        max: limits.max_canvas_dimension_px,
      });
    }
    if self.height_px > limits.max_canvas_dimension_px {
      return Err(SnapshotLimitViolation::DimensionExceeded {
        axis: "height",
        value: self.height_px,
        max: limits.max_canvas_dimension_px,
      });
    }
    let total = (self.width_px as u64).saturating_mul(self.height_px as u64);
    if total > limits.max_canvas_total_pixels {
      return Err(SnapshotLimitViolation::TotalPixelsExceeded {
        value: total,
        max: limits.max_canvas_total_pixels,
      });
    }
    if self.png_bytes.len() > limits.max_snapshot_size_bytes {
      return Err(SnapshotLimitViolation::SizeExceeded {
        bytes: self.png_bytes.len(),
        max: limits.max_snapshot_size_bytes,
      });
    }
    Ok(())
  }
}

// ─── AI Chat transcript ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatMessage {
  pub role: String,
  pub content: RichText,
}

// ─── Block ───────────────────────────────────────────────────────────────────

/// Every block variant in the Virgultum/Myoxus document model that the IR must handle.
///
/// Flavour strings (e.g. `myoxus:paragraph`) are the canonical Yjs block
/// identifiers post-`resolve_flavour`. Pre-rebrand snapshots may still
/// store `affine:*` on disk; the Yjs builder normalizes them to `myoxus:*`
/// before constructing IR.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
  // ── Container blocks ────────────────────────────────────────────────────
  /// `myoxus:page` — root container. Children are the document body.
  Page { title: RichText, children: Vec<Block> },

  /// `myoxus:note` — a note container (e.g. within a page).
  Note { children: Vec<Block> },

  /// Explicit endnote or retained unused body after the main document flow.
  /// Numbers and return links are transient export projection, never Yjs props.
  LocalNoteDefinition {
    definition_id: String,
    placement: yjs::footnote::FootnotePlacement,
    number: Option<u32>,
    references: usize,
    children: Vec<Block>,
  },

  /// `myoxus:edgeless-text` — inline text element on an edgeless canvas.
  EdgelessText { content: RichText, children: Vec<Block> },

  // ── Text blocks ─────────────────────────────────────────────────────────
  /// `myoxus:paragraph` with `prop:type = "text"` or no explicit type.
  Paragraph { content: RichText, children: Vec<Block> },

  /// `myoxus:paragraph` with `prop:type = "quote"`.
  Quote { content: RichText, children: Vec<Block> },

  /// `myoxus:paragraph` with `prop:type = "h1"`..`"h6"`.
  Heading {
    level: HeadingLevel,
    content: RichText,
    children: Vec<Block>,
  },

  /// `myoxus:list` — bulleted, numbered, todo, or toggle.
  List {
    list_type: ListType,
    content: RichText,
    /// Todo checkbox state (only meaningful when list_type = Todo).
    checked: bool,
    children: Vec<Block>,
  },

  /// `myoxus:code` — code block with optional language.
  Code(CodeBlock),

  /// `myoxus:mermaid` — first-class Mermaid diagram source and metadata.
  Mermaid(MermaidDiagram),

  /// `myoxus:divider`.
  Divider,

  /// `myoxus:callout` — callout box with variant styling.
  Callout {
    variant: CalloutVariant,
    emoji: Option<String>,
    content: RichText,
    children: Vec<Block>,
  },

  /// `myoxus:latex` — block-level LaTeX math.
  LatexBlock { source: String },

  // ── Media blocks ────────────────────────────────────────────────────────
  /// `myoxus:image` — raster or vector image.
  Image(ImageRef),

  /// `myoxus:attachment` — file attachment (shown as icon + filename + size).
  Attachment {
    blob: BlobRef,
    name: Option<String>,
    size_bytes: Option<u64>,
    mime: Option<String>,
  },

  /// `myoxus:bookmark` — external URL bookmark card.
  Bookmark(EmbedCard),

  /// `myoxus:embed-*` — any embed (loom, figma, youtube, github, linked-doc).
  Embed(EmbedCard),

  // ── Database / Table ────────────────────────────────────────────────────
  /// `myoxus:table` — simple grid table.
  Table {
    rows: Vec<TableRow>,
    caption: Option<RichText>,
    /// Ordered native pixel widths, consumed as relative tracks rather than page dimensions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    column_widths: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    header_rows: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    appearance: Option<TableAppearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    density: Option<TableDensity>,
  },

  /// `myoxus:database` — database block rendered as a table view.
  Database(DatabaseTableView),

  // ── Edgeless / Surface ──────────────────────────────────────────────────
  /// `myoxus:surface` — full edgeless canvas (V1: raster snapshot).
  Surface(EdgelessSnapshot),

  /// `myoxus:surface-ref` — embedded frame from edgeless referenced in doc mode.
  SurfaceRef(EdgelessSnapshot),

  /// `myoxus:frame` — a frame on the edgeless canvas (V1: raster snapshot).
  Frame(EdgelessSnapshot),

  /// `myoxus:mindmap` — mind-map (V1: raster snapshot).
  Mindmap(EdgelessSnapshot),

  // ── AI blocks ───────────────────────────────────────────────────────────
  /// `myoxus:ai-chat` — AI chat transcript.
  AiChat { messages: Vec<AiChatMessage> },

  // ── Fallback ────────────────────────────────────────────────────────────
  /// Unknown or unsupported block flavour — preserved for forward-compatibility.
  Unknown {
    flavour: String,
    text_fallback: Option<RichText>,
  },
}

impl Block {
  /// Canonical Myoxus flavour string for the IR variant.
  ///
  /// Matches the post-`resolve_flavour` form used by the Yjs builder
  /// (see `crates/yjs::resolve_flavour` and the normalization commit
  /// `4c384b1d05`). `Block::Unknown` returns the raw flavour as-stored
  /// because that is the only variant where the original string is
  /// preserved.
  pub fn flavour_name(&self) -> &str {
    match self {
      Block::Page { .. } => "myoxus:page",
      Block::Note { .. } => "myoxus:note",
      Block::LocalNoteDefinition { .. } => "myoxus:footnote-definition",
      Block::EdgelessText { .. } => "myoxus:edgeless-text",
      Block::Paragraph { .. } => "myoxus:paragraph/text",
      Block::Quote { .. } => "myoxus:paragraph/quote",
      Block::Heading { .. } => "myoxus:paragraph/heading",
      Block::List { .. } => "myoxus:list",
      Block::Code(_) => "myoxus:code",
      Block::Mermaid(_) => "myoxus:mermaid",
      Block::Divider => "myoxus:divider",
      Block::Callout { .. } => "myoxus:callout",
      Block::LatexBlock { .. } => "myoxus:latex",
      Block::Image(_) => "myoxus:image",
      Block::Attachment { .. } => "myoxus:attachment",
      Block::Bookmark(_) => "myoxus:bookmark",
      Block::Embed(_) => "myoxus:embed",
      Block::Table { .. } => "myoxus:table",
      Block::Database(_) => "myoxus:database",
      Block::Surface(_) => "myoxus:surface",
      Block::SurfaceRef(_) => "myoxus:surface-ref",
      Block::Frame(_) => "myoxus:frame",
      Block::Mindmap(_) => "myoxus:mindmap",
      Block::AiChat { .. } => "myoxus:ai-chat",
      Block::Unknown { flavour, .. } => flavour,
    }
  }

  /// First-reference footnote bodies are ordinary blocks carried by an inline
  /// entry. Existing limit, asset and preflight owners must inspect them too.
  pub(crate) fn for_each_local_footnote_body(&self, f: &mut impl FnMut(&[Block])) {
    let mut inspect = |spans: &[InlineSpan]| {
      for span in spans {
        if let InlineSpan::LocalFootnote { body: Some(body), .. } = span {
          f(body);
        }
      }
    };
    match self {
      Block::Paragraph { content, .. }
      | Block::Quote { content, .. }
      | Block::Heading { content, .. }
      | Block::List { content, .. }
      | Block::Callout { content, .. } => inspect(content),
      Block::Table { rows, .. } => {
        for row in rows {
          for cell in &row.cells {
            inspect(&cell.content);
          }
        }
      }
      _ => {}
    }
  }

  /// Recursively count all blocks (for limit checking).
  pub fn count_all(&self) -> usize {
    let children = match self {
      Block::Page { children, .. }
      | Block::Note { children }
      | Block::LocalNoteDefinition { children, .. }
      | Block::EdgelessText { children, .. }
      | Block::Paragraph { children, .. }
      | Block::Quote { children, .. }
      | Block::Heading { children, .. }
      | Block::List { children, .. }
      | Block::Callout { children, .. } => children.iter().map(|c| c.count_all()).sum::<usize>(),
      _ => 0,
    };
    let mut note_blocks = 0;
    self.for_each_local_footnote_body(&mut |body| {
      note_blocks += body.iter().map(Block::count_all).sum::<usize>();
    });
    1 + children + note_blocks
  }

  /// Walk the block tree and invoke `f` on every embedded
  /// [`EdgelessSnapshot`] (Surface / SurfaceRef / Frame / Mindmap).
  pub fn for_each_snapshot<F: FnMut(&EdgelessSnapshot)>(&self, f: &mut F) {
    self.for_each_local_footnote_body(&mut |body| {
      for block in body {
        block.for_each_snapshot(f);
      }
    });
    match self {
      Block::Surface(s) | Block::SurfaceRef(s) | Block::Frame(s) | Block::Mindmap(s) => f(s),
      Block::Page { children, .. }
      | Block::Note { children }
      | Block::LocalNoteDefinition { children, .. }
      | Block::EdgelessText { children, .. }
      | Block::Paragraph { children, .. }
      | Block::Quote { children, .. }
      | Block::Heading { children, .. }
      | Block::List { children, .. }
      | Block::Callout { children, .. } => {
        for child in children {
          child.for_each_snapshot(f);
        }
      }
      _ => {}
    }
  }
}
