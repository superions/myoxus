use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::{debug, instrument};
use uuid::Uuid;
use yrs::types::Attrs;
use yrs::types::text::{Diff, YChange};
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, GetString, Map, ReadTxn, Text, Transact, Update};

/// Public document intermediate representation.
///
/// This IR is owned by the public HTML renderer. It is projected directly from
/// the active Virgultum/Yjs block model and deliberately does not use Markdown
/// as an intermediate format. Markdown remains an import/export boundary; the
/// public renderer consumes editor semantics such as heading type, table cells
/// and image source IDs directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicDocIr {
  pub document: Document,
  pub diagnostics: Vec<RenderDiagnostic>,
  /// Source runs are populated only for private structured editing reads.
  #[serde(skip)]
  pub native_text: std::collections::BTreeMap<String, yjs::native_text::NativeBlockText>,
  /// Native links retained for private navigation; public/export JSON stays unchanged.
  #[serde(skip)]
  pub native_children: std::collections::BTreeMap<String, Vec<String>>,
  /// Native flat-table coordinates for private editing; exports keep their schema.
  #[serde(skip)]
  pub native_tables: std::collections::BTreeMap<String, NativeTableIdentity>,
  /// Loss remaining after the private mutation bridge handles native citations.
  #[serde(skip)]
  pub mutation_partial: bool,
  /// Citation source-card payloads for the private mutation bridge only.
  #[serde(skip)]
  pub native_citations: std::collections::BTreeMap<String, (String, serde_json::Value)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeCalloutProperties {
  pub kind: Option<String>,
  pub title: Option<String>,
  pub foldable: Option<bool>,
  pub default_open: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTableIdentity {
  /// Positions match the existing projected rows/cells, including empty cells.
  pub row_ids: Vec<String>,
  pub column_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub title: String,
  pub public_mode: String,
  #[serde(default)]
  pub metadata_badges: Vec<DocumentBadge>,
  pub blocks: Vec<Block>,
  pub assets: Vec<AssetRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentBadge {
  pub key: String,
  pub label: String,
  pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceIndex {
  pub workspace_id: Uuid,
  pub title: String,
  pub description: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub folder_title: Option<String>,
  /// Already authorized and materialized through the normal document pipeline.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub introduction: Option<PublicDocIr>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub folders: Vec<WorkspaceIndexFolder>,
  pub items: Vec<WorkspaceIndexItem>,
  /// Total admitted rows before live pagination; never an internal inventory count.
  pub document_count: usize,
  /// Bounded live reads supply page links; complete retained snapshots omit them.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub previous_page: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub next_page: Option<String>,
  /// Already admitted canonical keys, in the shared configured order.
  #[serde(default)]
  pub register_columns: Vec<String>,
}

/// Only admitted public values reach this IR; people IDs and hidden sort facts
/// never belong to the serialized render input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum WorkspaceRegisterValue {
  Text(String),
  Timestamp(DateTime<Utc>),
  Labels(Vec<String>),
  Version { label: Option<String>, dirty: bool },
}

/// Format adapters supply final navigation targets, including snapshot paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceIndexFolder {
  pub title: String,
  pub href: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceIndexItem {
  /// An adapter-owned link retains cross-workspace identity or a final snapshot path.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub href: Option<String>,
  pub doc_id: Uuid,
  pub route_key: String,
  pub title: String,
  pub public_mode: String,
  #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
  pub register: std::collections::BTreeMap<String, WorkspaceRegisterValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Block {
  Paragraph {
    block_id: String,
    text: Vec<InlineText>,
  },
  Heading {
    block_id: String,
    level: u8,
    text: Vec<InlineText>,
  },
  List {
    block_id: String,
    list: PublicList,
  },
  Quote {
    block_id: String,
    text: Vec<InlineText>,
  },
  Callout {
    block_id: String,
    /// Authored native properties, separate from derived public display labels.
    #[serde(skip)]
    native_callout: NativeCalloutProperties,
    /// None is a legacy untyped callout; empty is a semantic note's default label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    text: Vec<InlineText>,
    appearance: CalloutAppearance,
    children: Vec<Block>,
  },
  /// Native parent content; children use the ordinary reading projection.
  FootnoteDefinition {
    block_id: String,
    label: String,
    #[serde(default)]
    placement: Option<yjs::footnote::FootnotePlacement>,
    #[serde(default)]
    number: Option<u32>,
    #[serde(default)]
    reference_order: Option<usize>,
    children: Vec<Block>,
    #[serde(default)]
    backlinks: Vec<String>,
  },
  Code {
    /// Native formula provenance for private mutation consumers; reading output stays unchanged.
    #[serde(skip)]
    native_latex: bool,
    block_id: String,
    language: Option<String>,
    text: String,
  },
  Mermaid {
    block_id: String,
    source: String,
    title: String,
    caption: String,
  },
  Divider {
    block_id: String,
  },
  Image {
    block_id: String,
    asset: AssetRef,
  },
  BookmarkCard {
    block_id: String,
    url: String,
    title: String,
  },
  Table {
    block_id: String,
    rows: Vec<Vec<Vec<InlineText>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    header_rows: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    appearance: Option<TableAppearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    density: Option<TableDensity>,
  },
  TablePlaceholder {
    block_id: String,
  },
  UnsupportedBlock {
    block_id: String,
    flavour: String,
  },
}

impl Block {
  /// Return the stable editor block identifier carried by every projected block.
  pub fn block_id(&self) -> &str {
    match self {
      Self::Paragraph { block_id, .. }
      | Self::Heading { block_id, .. }
      | Self::List { block_id, .. }
      | Self::Quote { block_id, .. }
      | Self::Callout { block_id, .. }
      | Self::FootnoteDefinition { block_id, .. }
      | Self::Code { block_id, .. }
      | Self::Mermaid { block_id, .. }
      | Self::Divider { block_id }
      | Self::Image { block_id, .. }
      | Self::BookmarkCard { block_id, .. }
      | Self::Table { block_id, .. }
      | Self::TablePlaceholder { block_id }
      | Self::UnsupportedBlock { block_id, .. } => block_id,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicListKind {
  Bulleted,
  Numbered,
  Todo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalloutAppearance {
  Soft,
  Accent,
  Outline,
}

impl CalloutAppearance {
  fn from_source(value: &str) -> Option<Self> {
    match value {
      "soft" => Some(Self::Soft),
      "accent" => Some(Self::Accent),
      "outline" => Some(Self::Outline),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableAppearance {
  Grid,
  Ruled,
  Plain,
}

impl TableAppearance {
  fn from_source(value: &str) -> Option<Self> {
    match value {
      "grid" => Some(Self::Grid),
      "ruled" => Some(Self::Ruled),
      "plain" => Some(Self::Plain),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableDensity {
  Normal,
  Compact,
}

impl TableDensity {
  fn from_source(value: &str) -> Option<Self> {
    match value {
      "normal" => Some(Self::Normal),
      "compact" => Some(Self::Compact),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicList {
  pub kind: PublicListKind,
  pub items: Vec<PublicListItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicListItem {
  pub block_id: String,
  pub text: Vec<InlineText>,
  pub todo_checked: Option<bool>,
  pub children: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineText {
  pub text: String,
  pub bold: bool,
  pub italic: bool,
  pub strike: bool,
  pub code: bool,
  /// Formula source, original placeholders and exact native attributes for private mutations.
  /// Keeping the placeholders preserves repeated embeds coalesced by Yjs; reading output stays unchanged.
  #[serde(skip)]
  pub latex: Option<(String, String, serde_json::Value)>,
  pub link: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub local_footnote: Option<LocalFootnoteMarker>,
  /// Retains the deployed PDF citation emission count while deriving local numbers.
  #[serde(skip)]
  pub legacy_footnote: bool,
  /// Exact native inline payload and atomic placeholders; never public serialized data.
  #[serde(skip)]
  pub native_footnote: Option<(serde_json::Value, String)>,
  // Native workspace identity is retained only for the private mutation
  // bridge; public IR serialization must not expose document keys.
  #[serde(skip)]
  pub reference: Option<yjs::MarkdownDocumentReference>,
}

/// Reading-only navigation derived from the native local block identity.
/// It never identifies a separate document or carries definition content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFootnoteMarker {
  pub definition_id: String,
  pub label: String,
  pub reference_id: String,
  pub resolved: bool,
  #[serde(default)]
  pub placement: Option<yjs::footnote::FootnotePlacement>,
  #[serde(default)]
  pub number: Option<u32>,
}

impl InlineText {
  pub fn plain(text: impl Into<String>) -> Self {
    Self {
      text: text.into(),
      bold: false,
      italic: false,
      strike: false,
      code: false,
      latex: None,
      link: None,
      local_footnote: None,
      legacy_footnote: false,
      native_footnote: None,
      reference: None,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
  pub source: String,
  pub alt: String,
  pub public_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderDiagnostic {
  pub code: String,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub block_id: Option<String>,
}

/// Budgets applied while extracting a Page excerpt from serialized Yjs.
///
/// These values are supplied by the hosting configuration owner. The renderer
/// deliberately has no defaults, environment access or mutable global policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewProjectionLimits {
  pub max_input_bytes: usize,
  pub max_source_blocks: usize,
  pub max_projected_blocks: usize,
  pub max_text_chars: usize,
  pub max_depth: usize,
  pub max_table_rows: usize,
  pub max_table_columns: usize,
  pub max_visuals: usize,
}

#[derive(Debug, Clone, Default)]
struct BlockRecord {
  opaque_database_reference: bool,
  flavour: String,
  text: Vec<InlineText>,
  children_ids: Vec<String>,
  language: String,
  block_type: String,
  url: String,
  bookmark_title: String,
  image_source: String,
  image_caption: String,
  latex: String,
  mermaid_source: String,
  diagram_title: String,
  mermaid_caption: String,
  checked: Option<bool>,
  table_rows: Vec<Vec<Vec<InlineText>>>,
  table_identity: Option<NativeTableIdentity>,
  table_header_rows: Option<usize>,
  table_appearance: Option<TableAppearance>,
  table_density: Option<TableDensity>,
  callout_appearance: Option<CalloutAppearance>,
  callout_title: Option<String>,
  native_callout: NativeCalloutProperties,
  native_citation: bool,
  footnote_label: String,
  footnote_placement: Option<yjs::footnote::FootnotePlacement>,
}

#[instrument(skip(yjs_payload))]
pub fn document_from_yjs(
  workspace_id: Uuid,
  doc_id: Uuid,
  fallback_title: &str,
  public_mode: &str,
  yjs_payload: &[u8],
) -> Result<PublicDocIr, String> {
  document_from_yjs_internal(workspace_id, doc_id, fallback_title, public_mode, yjs_payload, false)
}

/// Private structured editing uses the same decode, retaining source runs without changing exports.
pub fn document_from_yjs_for_editing(
  workspace_id: Uuid,
  doc_id: Uuid,
  fallback_title: &str,
  public_mode: &str,
  yjs_payload: &[u8],
) -> Result<PublicDocIr, String> {
  document_from_yjs_internal(workspace_id, doc_id, fallback_title, public_mode, yjs_payload, true)
}

fn document_from_yjs_internal(
  workspace_id: Uuid,
  doc_id: Uuid,
  fallback_title: &str,
  public_mode: &str,
  yjs_payload: &[u8],
  editing: bool,
) -> Result<PublicDocIr, String> {
  let projected = project_public_document_from_yjs(yjs_payload, fallback_title, editing)?;
  let mut diagnostics = projected.diagnostics;
  if projected.extraction_partial {
    diagnostics.push(RenderDiagnostic {
      code: "partial_yjs_extraction".to_string(),
      message: "Some editor blocks could not be projected into public HTML IR.".to_string(),
      block_id: None,
    });
  }
  Ok(PublicDocIr {
    document: Document {
      workspace_id,
      doc_id,
      title: projected.title,
      public_mode: public_mode.to_string(),
      metadata_badges: Vec::new(),
      blocks: projected.blocks,
      assets: projected.assets,
    },
    diagnostics,
    native_text: projected.native_text,
    native_children: projected.native_children,
    native_tables: projected.native_tables,
    native_citations: projected.native_citations,
    mutation_partial: projected.mutation_partial,
  })
}

/// Project a bounded Page excerpt without materializing every block payload.
///
/// The initial source scan reads only block identity, flavour and child links.
/// Rich text, table cells and visual properties are extracted lazily after the
/// block has been admitted by the traversal and excerpt budgets. A diagnostic
/// error is returned for invalid input, Edgeless content or a source that cannot
/// be admitted safely; those states must not be presented as an empty Page.
#[instrument(skip(yjs_payload, limits, fallback_title))]
pub fn document_excerpt_from_yjs(
  workspace_id: Uuid,
  doc_id: Uuid,
  fallback_title: &str,
  public_mode: &str,
  yjs_payload: &[u8],
  limits: &PreviewProjectionLimits,
) -> Result<PublicDocIr, RenderDiagnostic> {
  if !public_mode.eq_ignore_ascii_case("page") {
    return Err(RenderDiagnostic {
      code: "preview_unsupported_mode".to_string(),
      message: "Only Page documents support generated previews.".to_string(),
      block_id: None,
    });
  }
  if yjs_payload.len() > limits.max_input_bytes {
    return Err(RenderDiagnostic {
      code: "preview_input_limit".to_string(),
      message: format!(
        "Serialized document exceeds the configured {} byte preview input limit.",
        limits.max_input_bytes
      ),
      block_id: None,
    });
  }

  let decode_started = std::time::Instant::now();
  let doc = decode_yjs_document(yjs_payload).map_err(|message| RenderDiagnostic {
    code: "preview_invalid_yjs".to_string(),
    message,
    block_id: None,
  })?;
  let decode_us = decode_started.elapsed().as_micros() as u64;
  let projection_started = std::time::Instant::now();
  let blocks_map = doc.get_or_insert_map("blocks");
  let txn = doc.transact_mut();
  let source_count = usize::try_from(blocks_map.len(&txn)).unwrap_or(usize::MAX);
  if source_count > limits.max_source_blocks {
    return Err(RenderDiagnostic {
      code: "preview_source_block_limit".to_string(),
      message: format!(
        "Document contains {source_count} blocks, exceeding the configured {} block source limit.",
        limits.max_source_blocks
      ),
      block_id: None,
    });
  }

  let mut sources = std::collections::HashMap::with_capacity(source_count);
  for (id, value) in blocks_map.iter(&txn) {
    let yrs::Out::YMap(map) = value else {
      continue;
    };
    sources.insert(
      id.to_string(),
      PreviewBlockSource {
        flavour: get_block_string(&map, &txn, "flavour").unwrap_or_default(),
        children_ids: get_children_ids(&map, &txn),
        map,
      },
    );
  }

  let root_id = sources
    .iter()
    .find(|(_, block)| yjs::resolve_flavour(&block.flavour) == "myoxus:page")
    .map(|(id, _)| id.clone())
    .ok_or_else(|| RenderDiagnostic {
      code: "preview_missing_page_root".to_string(),
      message: "Document has no Page root.".to_string(),
      block_id: None,
    })?;

  let mut ctx = PreviewProjectionContext {
    sources: &sources,
    txn: &txn,
    limits,
    blocks: Vec::new(),
    assets: Vec::new(),
    diagnostics: Vec::new(),
    title: None,
    visited: std::collections::HashSet::new(),
    projected_blocks: 0,
    text_chars: 0,
    visuals: 0,
    stopped: false,
  };
  project_preview_block(&root_id, 0, &mut ctx);

  if ctx.stopped {
    ctx.diagnostics.push(RenderDiagnostic {
      code: "preview_excerpt_truncated".to_string(),
      message: "The Page preview excerpt reached a configured projection limit.".to_string(),
      block_id: None,
    });
  }
  bind_local_footnote_navigation(&mut ctx.blocks, &mut ctx.diagnostics);
  let title = stable_title(ctx.title.as_deref(), fallback_title);
  tracing::debug!(
    target: "myoxus_preview_perf",
    %workspace_id,
    %doc_id,
    input_bytes = yjs_payload.len(),
    source_blocks = source_count,
    projected_blocks = ctx.projected_blocks,
    decode_us,
    projection_us = projection_started.elapsed().as_micros() as u64,
    "projected preview excerpt"
  );
  Ok(PublicDocIr {
    document: Document {
      workspace_id,
      doc_id,
      title,
      public_mode: public_mode.to_string(),
      metadata_badges: Vec::new(),
      blocks: ctx.blocks,
      assets: ctx.assets,
    },
    diagnostics: ctx.diagnostics,
    native_children: Default::default(),
    native_citations: Default::default(),
    native_text: Default::default(),
    mutation_partial: false,
    native_tables: Default::default(),
  })
}

#[derive(Debug, Clone)]
struct PreviewBlockSource {
  flavour: String,
  children_ids: Vec<String>,
  map: yrs::MapRef,
}

struct PreviewProjectionContext<'a, 'doc> {
  sources: &'a std::collections::HashMap<String, PreviewBlockSource>,
  txn: &'a yrs::TransactionMut<'doc>,
  limits: &'a PreviewProjectionLimits,
  blocks: Vec<Block>,
  assets: Vec<AssetRef>,
  diagnostics: Vec<RenderDiagnostic>,
  title: Option<String>,
  visited: std::collections::HashSet<String>,
  projected_blocks: usize,
  text_chars: usize,
  visuals: usize,
  stopped: bool,
}

fn project_preview_block(id: &str, depth: usize, ctx: &mut PreviewProjectionContext<'_, '_>) {
  if ctx.stopped {
    return;
  }
  if depth > ctx.limits.max_depth {
    ctx.stopped = true;
    ctx.diagnostics.push(RenderDiagnostic {
      code: "preview_depth_limit".to_string(),
      message: format!(
        "Block nesting exceeds the configured depth limit of {}.",
        ctx.limits.max_depth
      ),
      block_id: Some(id.to_string()),
    });
    return;
  }
  if !ctx.visited.insert(id.to_string()) {
    ctx.diagnostics.push(RenderDiagnostic {
      code: "preview_block_cycle".to_string(),
      message: "A cyclic block relationship was omitted from the preview.".to_string(),
      block_id: Some(id.to_string()),
    });
    return;
  }
  let Some(source) = ctx.sources.get(id) else {
    ctx.diagnostics.push(RenderDiagnostic {
      code: "preview_missing_block".to_string(),
      message: "A referenced block is missing from the document.".to_string(),
      block_id: Some(id.to_string()),
    });
    return;
  };

  let flavour = yjs::resolve_flavour(&source.flavour);
  if matches!(flavour, "myoxus:page" | "myoxus:note" | "myoxus:surface") {
    if flavour == "myoxus:page"
      && let Some(title) = preview_block_text(source, ctx)
      && !plain_inline(&title).trim().is_empty()
    {
      ctx.title = Some(plain_inline(&title));
    }
    if flavour == "myoxus:surface" {
      if !source.children_ids.is_empty() || surface_has_content(&source.map, ctx.txn) {
        ctx.diagnostics.push(RenderDiagnostic {
          code: "preview_edgeless_unsupported".to_string(),
          message: "Edgeless surface content is not rendered as a Page preview.".to_string(),
          block_id: Some(id.to_string()),
        });
      }
      return;
    }
    for child_id in &source.children_ids {
      project_preview_block(child_id, depth + 1, ctx);
    }
    return;
  }

  // Authoring-only annotations consume source limits, not visible excerpt slots.
  if flavour == "myoxus:annotation" {
    return;
  }
  if ctx.projected_blocks >= ctx.limits.max_projected_blocks {
    ctx.stopped = true;
    return;
  }
  ctx.projected_blocks += 1;

  match flavour {
    "myoxus:paragraph" => {
      let Some(text) = preview_block_text(source, ctx) else {
        return;
      };
      let block_type = get_prop_string(&source.map, ctx.txn, "type").unwrap_or_else(|| "text".to_string());
      if block_type.starts_with('h') {
        let level = block_type
          .trim_start_matches('h')
          .parse::<u8>()
          .unwrap_or(1)
          .clamp(1, 6);
        if ctx.title.is_none() && level == 1 {
          ctx.title = Some(plain_inline(&text));
        }
        ctx.blocks.push(Block::Heading {
          block_id: id.to_string(),
          level,
          text,
        });
      } else if block_type == "quote" || plain_inline(&text).trim_start().starts_with("> ") {
        ctx.blocks.push(Block::Quote {
          block_id: id.to_string(),
          text,
        });
      } else if inline_has_content(&text) {
        ctx.blocks.push(Block::Paragraph {
          block_id: id.to_string(),
          text,
        });
      }
    }
    "myoxus:list" => {
      let Some(text) = preview_block_text(source, ctx) else {
        return;
      };
      let block_type = get_prop_string(&source.map, ctx.txn, "type").unwrap_or_else(|| "bulleted".to_string());
      let kind = match block_type.as_str() {
        "numbered" => PublicListKind::Numbered,
        "todo" => PublicListKind::Todo,
        _ => PublicListKind::Bulleted,
      };
      let parent = std::mem::take(&mut ctx.blocks);
      for child_id in &source.children_ids {
        project_preview_block(child_id, depth + 1, ctx);
      }
      let children = std::mem::replace(&mut ctx.blocks, parent);
      push_list(
        &mut ctx.blocks,
        id,
        PublicList {
          kind,
          items: vec![PublicListItem {
            block_id: id.to_string(),
            text,
            todo_checked: (kind == PublicListKind::Todo)
              .then(|| get_prop_bool(&source.map, ctx.txn, "checked").unwrap_or(false)),
            children,
          }],
        },
      );
      return;
    }
    "myoxus:quote" => {
      if let Some(text) = preview_block_text(source, ctx) {
        ctx.blocks.push(Block::Quote {
          block_id: id.to_string(),
          text,
        });
      }
    }
    "myoxus:callout" => {
      let title = if let Some(kind) = get_prop_string(&source.map, ctx.txn, "type").filter(|kind| !kind.is_empty()) {
        let remaining = ctx.limits.max_text_chars.saturating_sub(ctx.text_chars);
        let (parts, truncated) = prop_value(&source.map, ctx.txn, "title")
          .map(|value| value_to_inline_with_limit(&value, ctx.txn, remaining))
          .unwrap_or_default();
        let mut title = plain_inline(&parts);
        if title.is_empty() && !kind.eq_ignore_ascii_case("note") {
          title = kind.chars().take(remaining).collect();
          ctx.stopped |= kind.chars().count() > remaining;
        }
        ctx.text_chars = ctx.text_chars.saturating_add(title.chars().count());
        ctx.stopped |= truncated;
        Some(title)
      } else {
        None
      };
      let text = preview_block_text(source, ctx).unwrap_or_default();
      let parent = std::mem::take(&mut ctx.blocks);
      for child_id in &source.children_ids {
        project_preview_block(child_id, depth + 1, ctx);
      }
      let children = std::mem::replace(&mut ctx.blocks, parent);
      ctx.blocks.push(Block::Callout {
        block_id: id.to_string(),
        native_callout: native_callout_properties(&source.map, ctx.txn),
        title,
        text,
        appearance: get_prop_string(&source.map, ctx.txn, "appearance")
          .as_deref()
          .and_then(CalloutAppearance::from_source)
          .unwrap_or(CalloutAppearance::Soft),
        children,
      });
      return;
    }
    "myoxus:code" => {
      let text = preview_block_text(source, ctx)
        .map(|parts| plain_inline(&parts))
        .unwrap_or_default();
      ctx.blocks.push(Block::Code {
        native_latex: false,
        block_id: id.to_string(),
        language: get_prop_string(&source.map, ctx.txn, "language").and_then(non_empty),
        text,
      });
    }
    "myoxus:bpmn" => {
      // A bounded text placeholder is not permission to read source heads or
      // execute a stored preview. It consumes the normal preview text budget.
      let title = get_prop_string(&source.map, ctx.txn, "title").unwrap_or_default();
      let label = bpmn_placeholder(&title);
      let (label, truncated) = text_prefix(&label, ctx.limits.max_text_chars.saturating_sub(ctx.text_chars));
      ctx.text_chars = ctx.text_chars.saturating_add(label.chars().count());
      ctx.stopped |= truncated;
      ctx.blocks.push(Block::Paragraph {
        block_id: id.to_string(),
        text: vec![InlineText::plain(label)],
      });
      ctx.diagnostics.push(RenderDiagnostic {
        code: "preview_unsupported_block".to_string(),
        message: "BPMN is represented by its title only.".to_string(),
        block_id: Some(id.to_string()),
      });
    }
    "myoxus:mermaid" => {
      if ctx.visuals >= ctx.limits.max_visuals {
        ctx.diagnostics.push(visual_limit_diagnostic(id));
        ctx.blocks.push(Block::UnsupportedBlock {
          block_id: id.to_string(),
          flavour: flavour.to_string(),
        });
      } else {
        ctx.visuals += 1;
        ctx.blocks.push(Block::Mermaid {
          block_id: id.to_string(),
          source: get_prop_string(&source.map, ctx.txn, "source").unwrap_or_default(),
          title: get_prop_string(&source.map, ctx.txn, "title").unwrap_or_default(),
          caption: get_prop_string(&source.map, ctx.txn, "caption").unwrap_or_default(),
        });
      }
    }
    "myoxus:image" => {
      if ctx.visuals >= ctx.limits.max_visuals {
        ctx.diagnostics.push(visual_limit_diagnostic(id));
        ctx.blocks.push(Block::UnsupportedBlock {
          block_id: id.to_string(),
          flavour: flavour.to_string(),
        });
      } else if let Some(source_id) = get_prop_string(&source.map, ctx.txn, "sourceId")
        .or_else(|| get_prop_string(&source.map, ctx.txn, "url"))
        .filter(|value| !value.trim().is_empty())
      {
        ctx.visuals += 1;
        let asset = AssetRef {
          source: source_id,
          alt: get_prop_string(&source.map, ctx.txn, "caption").unwrap_or_default(),
          public_url: None,
        };
        ctx.assets.push(asset.clone());
        ctx.blocks.push(Block::Image {
          block_id: id.to_string(),
          asset,
        });
      } else {
        ctx.diagnostics.push(RenderDiagnostic {
          code: "preview_media_missing".to_string(),
          message: "Image source is unavailable for the bounded preview.".to_string(),
          block_id: Some(id.to_string()),
        });
        ctx.blocks.push(Block::UnsupportedBlock {
          block_id: id.to_string(),
          flavour: flavour.to_string(),
        });
      }
    }
    // A document/public grant does not grant private target metadata.
    "myoxus:database" if yjs::has_opaque_database_reference(&source.map, ctx.txn) => {
      ctx.blocks.push(Block::Paragraph {
        block_id: id.to_string(),
        text: vec![InlineText::plain("Target unavailable")],
      });
      return;
    }
    "myoxus:table" | "myoxus:database" => {
      let (rows, table_truncated) = extract_flat_table_rows_bounded(
        &source.map,
        ctx.txn,
        ctx.limits.max_table_rows,
        ctx.limits.max_table_columns,
        ctx.limits.max_text_chars.saturating_sub(ctx.text_chars),
      );
      let table_chars = rows
        .iter()
        .flatten()
        .flatten()
        .map(|part| part.text.chars().count())
        .sum::<usize>();
      ctx.text_chars = ctx.text_chars.saturating_add(table_chars);
      if table_truncated {
        ctx.diagnostics.push(RenderDiagnostic {
          code: "preview_table_truncated".to_string(),
          message: "Table rows, columns, or cell text exceeded the configured preview limits.".to_string(),
          block_id: Some(id.to_string()),
        });
      }
      if rows.is_empty() {
        ctx.diagnostics.push(RenderDiagnostic {
          code: "preview_table_unsupported".to_string(),
          message: "The table has no bounded flat cells available for preview.".to_string(),
          block_id: Some(id.to_string()),
        });
        ctx.blocks.push(Block::TablePlaceholder {
          block_id: id.to_string(),
        });
      } else {
        ctx.blocks.push(Block::Table {
          block_id: id.to_string(),
          header_rows: get_prop_header_rows(&source.map, ctx.txn).map(|count| count.min(rows.len())),
          appearance: get_prop_string(&source.map, ctx.txn, "appearance")
            .as_deref()
            .and_then(TableAppearance::from_source),
          density: get_prop_string(&source.map, ctx.txn, "density")
            .as_deref()
            .and_then(TableDensity::from_source),
          rows,
        });
      }
    }
    "myoxus:footnote-definition" => {
      let label = get_prop_string(&source.map, ctx.txn, "label").unwrap_or_default();
      let (label, truncated) = text_prefix(&label, ctx.limits.max_text_chars.saturating_sub(ctx.text_chars));
      ctx.text_chars = ctx.text_chars.saturating_add(label.chars().count());
      ctx.stopped |= truncated;
      let label = label.to_string();
      let parent_blocks = std::mem::take(&mut ctx.blocks);
      for child_id in &source.children_ids {
        project_preview_block(child_id, depth + 1, ctx);
      }
      let children = std::mem::replace(&mut ctx.blocks, parent_blocks);
      ctx.blocks.push(Block::FootnoteDefinition {
        block_id: id.to_string(),
        label,
        placement: yjs::footnote::read_placement(&source.map, ctx.txn).ok(),
        number: None,
        reference_order: None,
        children,
        backlinks: Vec::new(),
      });
      return;
    }
    "myoxus:divider" => ctx.blocks.push(Block::Divider {
      block_id: id.to_string(),
    }),
    other => {
      ctx.diagnostics.push(RenderDiagnostic {
        code: "preview_unsupported_block".to_string(),
        message: format!("Block flavour '{other}' is not supported in Page previews."),
        block_id: Some(id.to_string()),
      });
      ctx.blocks.push(Block::UnsupportedBlock {
        block_id: id.to_string(),
        flavour: other.to_string(),
      });
    }
  }

  for child_id in &source.children_ids {
    project_preview_block(child_id, depth + 1, ctx);
  }
}

fn preview_block_text(
  source: &PreviewBlockSource,
  ctx: &mut PreviewProjectionContext<'_, '_>,
) -> Option<Vec<InlineText>> {
  let remaining = ctx.limits.max_text_chars.saturating_sub(ctx.text_chars);
  if remaining == 0 {
    ctx.stopped = true;
    return None;
  }
  let value = prop_value(&source.map, ctx.txn, "text")
    .or_else(|| source.map.get(ctx.txn, "text"))
    .or_else(|| prop_value(&source.map, ctx.txn, "title"));
  let Some(value) = value else {
    return Some(Vec::new());
  };
  let (text, truncated) = value_to_inline_with_limit(&value, ctx.txn, remaining);
  ctx.text_chars = ctx
    .text_chars
    .saturating_add(text.iter().map(|part| part.text.chars().count()).sum::<usize>());
  ctx.stopped |= truncated;
  Some(text)
}

fn value_to_inline_with_limit(
  value: &yrs::Out,
  txn: &yrs::TransactionMut<'_>,
  remaining: usize,
) -> (Vec<InlineText>, bool) {
  match value {
    yrs::Out::YText(text) => extract_rich_text_with_limit(text, txn, Some(remaining)),
    yrs::Out::Any(Any::String(text)) => {
      let (prefix, truncated) = text_prefix(text, remaining);
      (vec![InlineText::plain(prefix.to_string())], truncated)
    }
    _ => {
      let mut parts = value_to_inline(value, txn).unwrap_or_default();
      let mut budget = remaining;
      let mut truncated = false;
      for part in &mut parts {
        let (prefix, clipped) = text_prefix(&part.text, budget);
        budget -= prefix.chars().count();
        let bytes = prefix.len();
        part.text.truncate(bytes);
        truncated |= clipped;
      }
      (parts, truncated)
    }
  }
}

fn text_prefix(text: &str, max_chars: usize) -> (&str, bool) {
  match text.char_indices().nth(max_chars) {
    Some((offset, _)) => (&text[..offset], true),
    None => (text, false),
  }
}

fn visual_limit_diagnostic(id: &str) -> RenderDiagnostic {
  RenderDiagnostic {
    code: "preview_visual_limit".to_string(),
    message: "A visual block was omitted because the configured visual budget was exhausted.".to_string(),
    block_id: Some(id.to_string()),
  }
}

struct PublicProjection {
  native_text: std::collections::BTreeMap<String, yjs::native_text::NativeBlockText>,
  native_children: std::collections::BTreeMap<String, Vec<String>>,
  native_tables: std::collections::BTreeMap<String, NativeTableIdentity>,
  title: String,
  blocks: Vec<Block>,
  assets: Vec<AssetRef>,
  extraction_partial: bool,
  diagnostics: Vec<RenderDiagnostic>,
  native_citations: std::collections::BTreeMap<String, (String, serde_json::Value)>,
  mutation_partial: bool,
}

fn project_public_document_from_yjs(
  data: &[u8],
  fallback_title: &str,
  editing: bool,
) -> Result<PublicProjection, String> {
  if data.is_empty() {
    return Ok(PublicProjection {
      native_children: Default::default(),
      native_tables: Default::default(),
      native_citations: Default::default(),
      native_text: Default::default(),
      mutation_partial: false,
      title: stable_title(None, fallback_title),
      blocks: vec![Block::Paragraph {
        block_id: "empty".to_string(),
        text: Vec::new(),
      }],
      assets: Vec::new(),
      extraction_partial: false,
      diagnostics: Vec::new(),
    });
  }

  let doc = decode_yjs_document(data)?;
  let blocks_map = doc.get_or_insert_map("blocks");
  let text_refs: Vec<(&str, yrs::TextRef)> = ["content", "text", "body", "title"]
    .iter()
    .map(|key| (*key, doc.get_or_insert_text(*key)))
    .collect();
  let txn = doc.transact_mut();
  if blocks_map.len(&txn) == 0 {
    let mut blocks = Vec::new();
    for (key, text_ref) in &text_refs {
      let text = extract_rich_text(text_ref, &txn);
      if inline_has_content(&text) {
        blocks.push(Block::Paragraph {
          block_id: format!("fallback-{key}"),
          text,
        });
      }
    }
    if blocks.is_empty() {
      blocks.push(Block::Paragraph {
        block_id: "empty".to_string(),
        text: Vec::new(),
      });
    }
    return Ok(PublicProjection {
      native_children: Default::default(),
      native_tables: Default::default(),
      native_citations: Default::default(),
      native_text: Default::default(),
      mutation_partial: true,
      title: stable_title(None, fallback_title),
      blocks,
      assets: Vec::new(),
      extraction_partial: true,
      diagnostics: Vec::new(),
    });
  }

  let opaque_descendants = yjs::opaque_database_reference_descendants(&blocks_map, &txn);
  let mut block_data = std::collections::HashMap::new();
  for (id, value) in blocks_map.iter(&txn) {
    if opaque_descendants.contains(id) {
      continue;
    }
    let yrs::Out::YMap(block_map) = value else {
      continue;
    };
    let raw_flavour = get_block_string(&block_map, &txn, "flavour").unwrap_or_default();
    if yjs::resolve_flavour(&raw_flavour) == "myoxus:database" && yjs::has_opaque_database_reference(&block_map, &txn) {
      block_data.insert(
        id.to_string(),
        BlockRecord {
          flavour: raw_flavour,
          opaque_database_reference: true,
          ..Default::default()
        },
      );
      continue;
    }

    let level = get_prop_number(&block_map, &txn, "level").unwrap_or(1).clamp(1, 6);
    let mut block_type = get_prop_string(&block_map, &txn, "type").unwrap_or_else(|| "text".to_string());
    if raw_flavour == "affine:heading" && !block_type.starts_with('h') {
      block_type = format!("h{level}");
    }
    let canonical_flavour = yjs::resolve_flavour(&raw_flavour).to_string();
    let (table_rows, table_identity) = if canonical_flavour == "myoxus:table" {
      extract_flat_table_rows(&block_map, &txn, editing)
    } else {
      (Vec::new(), None)
    };

    block_data.insert(
      id.to_string(),
      BlockRecord {
        opaque_database_reference: yjs::has_opaque_database_reference(&block_map, &txn),
        flavour: raw_flavour,
        text: get_block_text(&block_map, &txn),
        children_ids: get_children_ids(&block_map, &txn),
        language: get_prop_string(&block_map, &txn, "language").unwrap_or_default(),
        block_type,
        url: get_prop_string(&block_map, &txn, "url").unwrap_or_default(),
        bookmark_title: get_prop_string(&block_map, &txn, "title")
          .or_else(|| get_prop_string(&block_map, &txn, "name"))
          .unwrap_or_default(),
        image_source: get_prop_string(&block_map, &txn, "sourceId")
          .or_else(|| get_prop_string(&block_map, &txn, "url"))
          .unwrap_or_default(),
        image_caption: get_prop_string(&block_map, &txn, "caption").unwrap_or_default(),
        latex: get_prop_string(&block_map, &txn, "latex").unwrap_or_default(),
        mermaid_source: get_prop_string(&block_map, &txn, "source").unwrap_or_default(),
        diagram_title: get_prop_string(&block_map, &txn, "title").unwrap_or_default(),
        mermaid_caption: get_prop_string(&block_map, &txn, "caption").unwrap_or_default(),
        checked: get_prop_bool(&block_map, &txn, "checked"),
        table_rows,
        table_identity,
        table_header_rows: get_prop_header_rows(&block_map, &txn),
        table_appearance: get_prop_string(&block_map, &txn, "appearance")
          .as_deref()
          .and_then(TableAppearance::from_source),
        table_density: get_prop_string(&block_map, &txn, "density")
          .as_deref()
          .and_then(TableDensity::from_source),
        footnote_label: get_prop_string(&block_map, &txn, "label").unwrap_or_default(),
        footnote_placement: yjs::footnote::read_placement(&block_map, &txn).ok(),
        callout_appearance: get_prop_string(&block_map, &txn, "appearance")
          .as_deref()
          .and_then(CalloutAppearance::from_source),
        native_callout: native_callout_properties(&block_map, &txn),
        native_citation: yjs::markdown::native_citation_definition(&block_map, &txn).is_some(),
        callout_title: get_prop_string(&block_map, &txn, "type")
          .filter(|kind| !kind.is_empty())
          .map(|kind| {
            let title = get_prop_string(&block_map, &txn, "title").unwrap_or_default();
            if title.is_empty() && !kind.eq_ignore_ascii_case("note") {
              kind
            } else {
              title
            }
          }),
      },
    );
  }

  let root_id = block_data
    .iter()
    .find(|(_, block)| yjs::resolve_flavour(&block.flavour) == "myoxus:page")
    .map(|(id, _)| id.clone());

  let mut ctx = RenderContext {
    editing,
    block_data: &block_data,
    blocks: Vec::new(),
    assets: Vec::new(),
    title: None,
    partial: false,
    mutation_partial: false,
    diagnostics: Vec::new(),
    visited: std::collections::HashSet::new(),
    blocks_visited: 0,
  };
  if let Some(root_id) = root_id {
    render_block(&root_id, 0, &mut ctx);
  } else {
    let mut sorted_ids: Vec<_> = block_data.keys().cloned().collect();
    sorted_ids.sort();
    for id in sorted_ids {
      render_block(&id, 0, &mut ctx);
    }
    ctx.partial = true;
    ctx.mutation_partial = true;
  }

  if ctx.blocks.is_empty() {
    ctx.blocks.push(Block::Paragraph {
      block_id: "empty".to_string(),
      text: Vec::new(),
    });
  }

  bind_local_footnote_navigation(&mut ctx.blocks, &mut ctx.diagnostics);
  let title = stable_title(ctx.title.as_deref(), fallback_title);
  debug!(
    blocks_visited = ctx.blocks_visited,
    rendered_blocks = ctx.blocks.len(),
    assets = ctx.assets.len(),
    partial = ctx.partial,
    "public yjs projection complete"
  );
  Ok(PublicProjection {
    mutation_partial: ctx.mutation_partial,
    native_text: if editing {
      blocks_map
        .iter(&txn)
        .filter_map(|(id, value)| {
          if !block_data.contains_key(id) {
            return None;
          }
          let yrs::Out::YMap(block) = value else { return None };
          yjs::native_text::native_block_text(&block, &txn).map(|value| (id.to_string(), value))
        })
        .collect()
    } else {
      Default::default()
    },
    native_citations: blocks_map
      .iter(&txn)
      .filter_map(|(id, value)| {
        let yrs::Out::YMap(block) = value else { return None };
        yjs::markdown::native_citation_definition(&block, &txn).map(|value| (id.to_string(), value))
      })
      .collect(),
    native_tables: block_data
      .iter()
      .filter_map(|(id, block)| block.table_identity.clone().map(|identity| (id.clone(), identity)))
      .collect(),
    native_children: block_data
      .iter()
      .map(|(id, block)| (id.clone(), block.children_ids.clone()))
      .collect(),
    title,
    blocks: ctx.blocks,
    assets: ctx.assets,
    extraction_partial: ctx.partial,
    diagnostics: ctx.diagnostics,
  })
}

fn decode_yjs_document(data: &[u8]) -> Result<yrs::Doc, String> {
  let doc = yrs::Doc::new();
  if !data.is_empty() {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(data).map_err(|err| err.to_string())?;
    txn.apply_update(update).map_err(|err| err.to_string())?;
  }
  Ok(doc)
}

struct RenderContext<'a> {
  editing: bool,
  block_data: &'a std::collections::HashMap<String, BlockRecord>,
  blocks: Vec<Block>,
  assets: Vec<AssetRef>,
  title: Option<String>,
  partial: bool,
  mutation_partial: bool,
  diagnostics: Vec<RenderDiagnostic>,
  visited: std::collections::HashSet<String>,
  blocks_visited: u32,
}

fn render_block(id: &str, depth: usize, ctx: &mut RenderContext<'_>) {
  const MAX_BLOCK_DEPTH: usize = 100;
  if depth > MAX_BLOCK_DEPTH || !ctx.visited.insert(id.to_string()) {
    ctx.partial = true;
    ctx.mutation_partial = true;
    return;
  }
  let Some(block) = ctx.block_data.get(id) else {
    ctx.partial = true;
    ctx.mutation_partial = true;
    return;
  };
  ctx.blocks_visited += 1;

  match yjs::resolve_flavour(&block.flavour) {
    "myoxus:page" => {
      let title = plain_inline(&block.text);
      if !title.trim().is_empty() {
        ctx.title = Some(title);
      }
    }
    "myoxus:annotation" => return,
    "myoxus:paragraph" => render_paragraph_block(id, block, ctx),
    "myoxus:callout" => {
      // Callout owns its nested projection so its own rich text and children
      // remain one ordered semantic unit instead of an unsupported placeholder.
      let child_ids = block.children_ids.clone();
      let parent_blocks = std::mem::take(&mut ctx.blocks);
      for child_id in child_ids {
        render_block(&child_id, depth + 1, ctx);
      }
      let children = std::mem::replace(&mut ctx.blocks, parent_blocks);
      ctx.blocks.push(Block::Callout {
        block_id: id.to_string(),
        title: block.callout_title.clone(),
        native_callout: block.native_callout.clone(),
        text: block.text.clone(),
        appearance: block.callout_appearance.unwrap_or(CalloutAppearance::Soft),
        children,
      });
      return;
    }
    "myoxus:code" => ctx.blocks.push(Block::Code {
      native_latex: false,
      block_id: id.to_string(),
      language: non_empty(block.language.clone()),
      text: plain_inline(&block.text),
    }),
    "myoxus:bpmn" => {
      // Reuse escaped paragraph rendering, retaining the unsupported-content
      // diagnostics. Neither XML nor SVG becomes public/export content.
      ctx.partial = true;
      ctx.mutation_partial = true;
      ctx.blocks.push(Block::Paragraph {
        block_id: id.to_string(),
        text: vec![InlineText::plain(bpmn_placeholder(&block.diagram_title))],
      });
      ctx.diagnostics.push(RenderDiagnostic {
        code: "unsupported_block".to_string(),
        message: "BPMN is represented by its title only.".to_string(),
        block_id: Some(id.to_string()),
      });
    }
    "myoxus:mermaid" => ctx.blocks.push(Block::Mermaid {
      block_id: id.to_string(),
      source: block.mermaid_source.clone(),
      title: block.diagram_title.clone(),
      caption: block.mermaid_caption.clone(),
    }),
    "myoxus:list" => {
      let block = block.clone();
      render_list_block(id, &block, depth, ctx);
      return;
    }
    "myoxus:bookmark" => {
      if !block.url.trim().is_empty() {
        ctx.blocks.push(Block::BookmarkCard {
          block_id: id.to_string(),
          url: block.url.clone(),
          title: block.bookmark_title.clone(),
        });
      }
    }
    "myoxus:image" => {
      if !block.image_source.trim().is_empty() {
        let asset = AssetRef {
          source: block.image_source.clone(),
          alt: block.image_caption.clone(),
          public_url: None,
        };
        ctx.assets.push(asset.clone());
        ctx.blocks.push(Block::Image {
          block_id: id.to_string(),
          asset,
        });
      }
    }
    "myoxus:attachment" => {
      if !block.image_source.trim().is_empty() {
        ctx.blocks.push(Block::BookmarkCard {
          block_id: id.to_string(),
          url: block.image_source.clone(),
          title: block.bookmark_title.clone(),
        });
      }
    }
    "myoxus:latex" => {
      if !block.latex.trim().is_empty() {
        ctx.blocks.push(Block::Code {
          native_latex: true,
          block_id: id.to_string(),
          language: Some("latex".to_string()),
          text: block.latex.clone(),
        });
      }
    }
    "myoxus:divider" => ctx.blocks.push(Block::Divider {
      block_id: id.to_string(),
    }),
    "myoxus:database" if block.opaque_database_reference => {
      ctx.blocks.push(Block::Paragraph {
        block_id: id.to_string(),
        text: vec![InlineText::plain("Target unavailable")],
      });
      return;
    }
    "myoxus:table" | "myoxus:database" => render_table_block(id, block, ctx),
    "myoxus:embed-youtube" => {
      if !block.url.trim().is_empty() {
        ctx.blocks.push(Block::BookmarkCard {
          block_id: id.to_string(),
          url: block.url.clone(),
          title: "YouTube".to_string(),
        });
      }
    }
    "myoxus:surface" => {}
    "myoxus:footnote-definition" => {
      let parent_blocks = std::mem::take(&mut ctx.blocks);
      for child_id in &block.children_ids {
        render_block(child_id, depth + 1, ctx);
      }
      let children = std::mem::replace(&mut ctx.blocks, parent_blocks);
      ctx.blocks.push(Block::FootnoteDefinition {
        block_id: id.to_string(),
        label: block.footnote_label.clone(),
        placement: block.footnote_placement,
        number: None,
        reference_order: None,
        children,
        backlinks: Vec::new(),
      });
      return;
    }
    "myoxus:note" => {
      let child_ids = block.children_ids.clone();
      let parent_blocks = std::mem::take(&mut ctx.blocks);
      for child_id in child_ids {
        render_block(&child_id, depth + 1, ctx);
      }
      let note_blocks = std::mem::replace(&mut ctx.blocks, parent_blocks);
      ctx.blocks.extend(note_blocks);
      return;
    }
    other => {
      ctx.partial = true;
      ctx.mutation_partial |= !block.native_citation;
      ctx.blocks.push(Block::UnsupportedBlock {
        block_id: id.to_string(),
        flavour: other.to_string(),
      });
      ctx.diagnostics.push(RenderDiagnostic {
        code: "unsupported_block".to_string(),
        message: format!("Block flavour '{other}' is not supported by this projection."),
        block_id: Some(id.to_string()),
      });
    }
  }

  for child_id in &block.children_ids {
    render_block(child_id, depth + 1, ctx);
  }
}

fn render_paragraph_block(id: &str, block: &BlockRecord, ctx: &mut RenderContext<'_>) {
  if block.block_type.starts_with('h') {
    let level = block
      .block_type
      .trim_start_matches('h')
      .parse::<u8>()
      .unwrap_or(1)
      .clamp(1, 6);
    if inline_has_content(&block.text) {
      if ctx.title.is_none() && level == 1 {
        ctx.title = Some(plain_inline(&block.text));
      }
      ctx.blocks.push(Block::Heading {
        block_id: id.to_string(),
        level,
        text: block.text.clone(),
      });
    }
  } else if block.block_type == "quote" {
    ctx.blocks.push(Block::Quote {
      block_id: id.to_string(),
      text: block.text.clone(),
    });
  } else if plain_inline(&block.text).trim_start().starts_with("> ") {
    ctx.blocks.push(Block::Quote {
      block_id: id.to_string(),
      text: vec![InlineText {
        text: plain_inline(&block.text).trim_start_matches("> ").to_string(),
        ..InlineText::plain("")
      }],
    });
  } else if inline_has_content(&block.text) {
    ctx.blocks.push(Block::Paragraph {
      block_id: id.to_string(),
      text: block.text.clone(),
    });
  }
}

fn render_list_block(id: &str, block: &BlockRecord, depth: usize, ctx: &mut RenderContext<'_>) {
  if !inline_has_content(&block.text) {
    for child_id in &block.children_ids {
      render_block(child_id, depth + 1, ctx);
    }
    return;
  }

  let parent_blocks = std::mem::take(&mut ctx.blocks);
  for child_id in &block.children_ids {
    render_block(child_id, depth + 1, ctx);
  }
  let children = std::mem::replace(&mut ctx.blocks, parent_blocks);

  let kind = match block.block_type.as_str() {
    "numbered" => PublicListKind::Numbered,
    "todo" => PublicListKind::Todo,
    _ => PublicListKind::Bulleted,
  };
  let list = PublicList {
    kind,
    items: vec![PublicListItem {
      block_id: id.to_string(),
      text: block.text.clone(),
      todo_checked: (kind == PublicListKind::Todo).then_some(block.checked.unwrap_or(false)),
      children,
    }],
  };
  push_list(&mut ctx.blocks, id, list);
}

fn push_list(blocks: &mut Vec<Block>, block_id: &str, mut list: PublicList) {
  if let Some(Block::List { list: previous, .. }) = blocks.last_mut()
    && previous.kind == list.kind
  {
    previous.items.append(&mut list.items);
  } else {
    blocks.push(Block::List {
      block_id: block_id.to_string(),
      list,
    });
  }
}

fn render_table_block(id: &str, block: &BlockRecord, ctx: &mut RenderContext<'_>) {
  if ctx.editing
    && let Some(identity) = &block.table_identity
    && (identity.row_ids.is_empty() || identity.column_ids.is_empty())
  {
    // Zero axes are valid native edit targets. Public rendering retains its
    // existing placeholder; private reads never invent stored coordinates/cells.
    ctx.blocks.push(Block::Table {
      block_id: id.into(),
      rows: vec![Vec::new(); identity.row_ids.len()],
      header_rows: block.table_header_rows.map(|count| count.min(identity.row_ids.len())),
      appearance: block.table_appearance,
      density: block.table_density,
    });
    return;
  }
  if !block.table_rows.is_empty() {
    ctx.blocks.push(Block::Table {
      block_id: id.to_string(),
      rows: block.table_rows.clone(),
      header_rows: block.table_header_rows.map(|count| count.min(block.table_rows.len())),
      appearance: block.table_appearance,
      density: block.table_density,
    });
    return;
  }
  if !block.children_ids.is_empty() {
    let mut rows = Vec::new();
    for row_id in &block.children_ids {
      let Some(row_block) = ctx.block_data.get(row_id) else {
        continue;
      };
      if row_block.children_ids.is_empty() {
        if !plain_inline(&row_block.text).trim().is_empty() {
          rows.push(vec![row_block.text.clone()]);
        }
      } else {
        let mut cells = Vec::new();
        for cell_id in &row_block.children_ids {
          if let Some(cell_block) = ctx.block_data.get(cell_id) {
            cells.push(cell_block.text.clone());
          }
        }
        if !cells.is_empty() {
          rows.push(cells);
        }
      }
    }
    if !rows.is_empty() {
      ctx.blocks.push(Block::Table {
        block_id: id.to_string(),
        header_rows: block.table_header_rows.map(|count| count.min(rows.len())),
        appearance: block.table_appearance,
        density: block.table_density,
        rows,
      });
      return;
    }
  }
  ctx.partial = true;
  ctx.mutation_partial = true;
  ctx.blocks.push(Block::TablePlaceholder {
    block_id: id.to_string(),
  });
}

fn get_block_string(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<String> {
  let prefixed = format!("sys:{key}");
  block_map
    .get(txn, &prefixed)
    .or_else(|| block_map.get(txn, key))
    .and_then(|value| match value {
      yrs::Out::Any(Any::String(value)) => Some(value.to_string()),
      _ => None,
    })
}

fn get_block_text(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>) -> Vec<InlineText> {
  get_prop_inline(block_map, txn, "text")
    .or_else(|| get_direct_inline(block_map, txn, "text"))
    .or_else(|| get_prop_inline(block_map, txn, "title"))
    .unwrap_or_default()
}

fn get_prop_inline(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<Vec<InlineText>> {
  let prefixed = format!("prop:{key}");
  if let Some(value) = block_map.get(txn, &prefixed)
    && let Some(text) = value_to_inline(&value, txn)
  {
    return Some(text);
  }
  if let Some(yrs::Out::YMap(props)) = block_map.get(txn, "props")
    && let Some(value) = props.get(txn, key)
    && let Some(text) = value_to_inline(&value, txn)
  {
    return Some(text);
  }
  None
}

fn get_direct_inline(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<Vec<InlineText>> {
  block_map.get(txn, key).and_then(|value| value_to_inline(&value, txn))
}

fn bpmn_placeholder(title: &str) -> String {
  let title = title.trim();
  format!("BPMN: {}", if title.is_empty() { "BPMN Diagram" } else { title })
}

fn get_prop_string(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<String> {
  get_prop_inline(block_map, txn, key).map(|text| plain_inline(&text))
}

fn get_prop_number(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<u32> {
  prop_value(block_map, txn, key).and_then(|value| match value {
    yrs::Out::Any(Any::BigInt(value)) => Some(value as u32),
    yrs::Out::Any(Any::Number(value)) => value.as_f64().map(|value| value as u32),
    _ => None,
  })
}

/// Presence is semantic: absent legacy tables retain the renderer fallback,
/// while every malformed explicit value means an explicit zero-row header.
fn get_prop_header_rows(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>) -> Option<usize> {
  prop_value(block_map, txn, "headerRows").map(|value| match value {
    yrs::Out::Any(Any::BigInt(value)) => usize::try_from(value).unwrap_or(0),
    yrs::Out::Any(Any::Number(value)) => value
      .as_f64()
      .filter(|value| value.is_finite() && *value > 0.0)
      .map(|value| value.trunc() as usize)
      .unwrap_or(0),
    _ => 0,
  })
}

fn get_prop_bool(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<bool> {
  prop_value(block_map, txn, key).and_then(|value| match value {
    yrs::Out::Any(Any::Bool(value)) => Some(value),
    _ => None,
  })
}

fn prop_value(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<yrs::Out> {
  let prefixed = format!("prop:{key}");
  block_map.get(txn, &prefixed).or_else(|| {
    block_map.get(txn, "props").and_then(|value| match value {
      yrs::Out::YMap(props) => props.get(txn, key),
      _ => None,
    })
  })
}

fn surface_has_content(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>) -> bool {
  match prop_value(block_map, txn, "elements") {
    Some(yrs::Out::YMap(boxed)) => match boxed.get(txn, "value") {
      Some(yrs::Out::YMap(elements)) => elements.len(txn) > 0,
      Some(_) => true,
      None => boxed.iter(txn).any(|(key, _)| key != "type"),
    },
    Some(_) => true,
    None => false,
  }
}

fn get_children_ids(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>) -> Vec<String> {
  block_map
    .get(txn, "sys:children")
    .or_else(|| block_map.get(txn, "children"))
    .and_then(|value| match value {
      yrs::Out::YArray(children) => Some(
        children
          .iter(txn)
          .filter_map(|item| match item {
            yrs::Out::Any(Any::String(value)) => Some(value.to_string()),
            _ => None,
          })
          .collect(),
      ),
      _ => None,
    })
    .unwrap_or_default()
}

#[derive(Debug, Default)]
struct OrderedTableEntry {
  id: String,
  order: String,
}

fn extract_flat_table_rows(
  block_map: &yrs::MapRef,
  txn: &yrs::TransactionMut<'_>,
  editing: bool,
) -> (Vec<Vec<Vec<InlineText>>>, Option<NativeTableIdentity>) {
  let mut rows: std::collections::HashMap<String, OrderedTableEntry> = std::collections::HashMap::new();
  let mut columns: std::collections::HashMap<String, OrderedTableEntry> = std::collections::HashMap::new();
  let mut cells: std::collections::HashMap<String, Vec<InlineText>> = std::collections::HashMap::new();

  for (key, value) in block_map.iter(txn) {
    // Native editing coordinates end at the first dot. Nested repeat fields
    // belong to that same coordinate; retain the existing public-reader path.
    if let Some((row_id, field)) = if editing {
      key.strip_prefix("prop:rows.").and_then(|rest| rest.split_once('.'))
    } else {
      split_flat_key(key, "prop:rows.")
    } {
      let entry = rows.entry(row_id.to_string()).or_insert_with(|| OrderedTableEntry {
        id: row_id.to_string(),
        order: String::new(),
      });
      match field {
        "rowId" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.id = value;
          }
        }
        "order" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.order = value;
          }
        }
        _ => {}
      }
    } else if let Some((column_id, field)) = if editing {
      key.strip_prefix("prop:columns.").and_then(|rest| rest.split_once('.'))
    } else {
      split_flat_key(key, "prop:columns.")
    } {
      let entry = columns
        .entry(column_id.to_string())
        .or_insert_with(|| OrderedTableEntry {
          id: column_id.to_string(),
          order: String::new(),
        });
      match field {
        "columnId" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.id = value;
          }
        }
        "order" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.order = value;
          }
        }
        _ => {}
      }
    } else if let Some(cell_key) = key
      .strip_prefix("prop:cells.")
      .and_then(|rest| rest.strip_suffix(".text"))
      && let Some(value) = value_to_inline(&value, txn)
    {
      cells.insert(cell_key.to_string(), value);
    }
  }

  let mut rows: Vec<_> = rows.into_values().collect();
  let mut columns: Vec<_> = columns.into_values().collect();
  rows.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
  columns.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

  // Advertise only declared, unambiguous native identities. Legacy malformed
  // tables retain their reading output without pretending to be editable.
  let declared = |entries: &[OrderedTableEntry], prefix: &str, field: &str| {
    let unique = entries
      .iter()
      .map(|entry| entry.id.as_str())
      .collect::<std::collections::BTreeSet<_>>();
    unique.len() == entries.len() && entries.iter().all(|entry| {
      if entry.id.is_empty() { return false; }
      matches!(block_map.get(txn, &format!("prop:{prefix}.{}.{field}", entry.id)), Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == entry.id.as_str())
    })
  };
  let identity =
    (declared(&rows, "rows", "rowId") && declared(&columns, "columns", "columnId")).then(|| NativeTableIdentity {
      row_ids: rows.iter().map(|row| row.id.clone()).collect(),
      column_ids: columns.iter().map(|column| column.id.clone()).collect(),
    });
  if rows.is_empty() || columns.is_empty() {
    // A zero axis is a valid flat-table edit state only for an actual leaf
    // without stored cells. Keep legacy child tables and malformed cells on
    // their existing reading/unsupported path.
    let leaf = matches!(block_map.get(txn, "sys:children").or_else(|| block_map.get(txn, "children")), Some(yrs::Out::YArray(children)) if children.len(txn) == 0);
    let has_cells = block_map.keys(txn).any(|key| key.starts_with("prop:cells."));
    return (Vec::new(), if leaf && !has_cells { identity } else { None });
  }
  let projected = rows
    .iter()
    .map(|row| {
      columns
        .iter()
        .map(|column| {
          cells
            .get(&format!("{}:{}", row.id, column.id))
            .cloned()
            .unwrap_or_default()
        })
        .collect()
    })
    .collect();
  (projected, identity)
}

fn extract_flat_table_rows_bounded(
  block_map: &yrs::MapRef,
  txn: &yrs::TransactionMut<'_>,
  max_rows: usize,
  max_columns: usize,
  max_text_chars: usize,
) -> (Vec<Vec<Vec<InlineText>>>, bool) {
  if max_rows == 0 || max_columns == 0 || max_text_chars == 0 {
    return (Vec::new(), true);
  }

  let mut rows: std::collections::HashMap<String, OrderedTableEntry> = std::collections::HashMap::new();
  let mut columns: std::collections::HashMap<String, OrderedTableEntry> = std::collections::HashMap::new();
  for (key, value) in block_map.iter(txn) {
    if let Some((row_id, field)) = split_flat_key(key, "prop:rows.") {
      let entry = rows.entry(row_id.to_string()).or_insert_with(|| OrderedTableEntry {
        id: row_id.to_string(),
        order: String::new(),
      });
      match field {
        "rowId" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.id = value;
          }
        }
        "order" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.order = value;
          }
        }
        _ => {}
      }
    } else if let Some((column_id, field)) = split_flat_key(key, "prop:columns.") {
      let entry = columns
        .entry(column_id.to_string())
        .or_insert_with(|| OrderedTableEntry {
          id: column_id.to_string(),
          order: String::new(),
        });
      match field {
        "columnId" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.id = value;
          }
        }
        "order" => {
          if let Some(value) = value_to_string(&value, txn) {
            entry.order = value;
          }
        }
        _ => {}
      }
    }
  }

  let mut rows: Vec<_> = rows.into_values().collect();
  let mut columns: Vec<_> = columns.into_values().collect();
  rows.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
  columns.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
  let mut truncated = rows.len() > max_rows || columns.len() > max_columns;
  rows.truncate(max_rows);
  columns.truncate(max_columns);

  let mut consumed_chars = 0usize;
  // Spend the character budget in visible row/column order, not Y.Map order.
  // Direct lookup avoids extracting payloads from cells outside the excerpt.
  let rows = rows
    .iter()
    .map(|row| {
      columns
        .iter()
        .map(|column| {
          let remaining = max_text_chars.saturating_sub(consumed_chars);
          if remaining == 0 {
            truncated = true;
            return Vec::new();
          }
          let Some(value) = block_map.get(txn, &format!("prop:cells.{}:{}.text", row.id, column.id)) else {
            return Vec::new();
          };
          let (text, clipped) = value_to_inline_with_limit(&value, txn, remaining);
          consumed_chars += text.iter().map(|part| part.text.chars().count()).sum::<usize>();
          truncated |= clipped;
          text
        })
        .collect()
    })
    .collect();
  (rows, truncated)
}

fn split_flat_key<'key>(key: &'key str, prefix: &str) -> Option<(&'key str, &'key str)> {
  let rest = key.strip_prefix(prefix)?;
  rest.rsplit_once('.')
}

fn value_to_inline(value: &yrs::Out, txn: &yrs::TransactionMut<'_>) -> Option<Vec<InlineText>> {
  match value {
    yrs::Out::Any(Any::String(value)) => Some(vec![InlineText::plain(value.to_string())]),
    yrs::Out::Any(Any::Number(value)) => Some(vec![InlineText::plain(value.to_string())]),
    yrs::Out::Any(Any::BigInt(value)) => Some(vec![InlineText::plain(value.to_string())]),
    yrs::Out::Any(Any::Bool(value)) => Some(vec![InlineText::plain(value.to_string())]),
    yrs::Out::YText(text) => Some(extract_rich_text(text, txn)),
    _ => None,
  }
}

fn value_to_string(value: &yrs::Out, txn: &yrs::TransactionMut<'_>) -> Option<String> {
  value_to_inline(value, txn).map(|text| plain_inline(&text))
}

fn extract_rich_text<T: ReadTxn>(text_ref: &yrs::TextRef, txn: &T) -> Vec<InlineText> {
  extract_rich_text_with_limit(text_ref, txn, None).0
}

fn extract_rich_text_with_limit<T: ReadTxn>(
  text_ref: &yrs::TextRef,
  txn: &T,
  max_chars: Option<usize>,
) -> (Vec<InlineText>, bool) {
  // Yrs exposes formatted text as a per-value diff, not a range iterator. For
  // previews, that temporary allocation is bounded by the enforced source-byte
  // cap. Copy only the admitted prefix into IR without inspecting later blocks
  // or mutating the decoded document. Full-public projection remains unlimited.
  let diffs: Vec<Diff<YChange>> = text_ref.diff(txn, YChange::identity);
  let mut spans = Vec::new();
  let mut remaining = max_chars;
  let mut truncated = false;

  for diff in &diffs {
    if yjs::annotation::annotation_id(diff.attributes.as_deref()).is_some() {
      continue;
    }
    let attrs = diff.attributes.as_deref();
    // Reading renderers without MathJax retain formula meaning as visible source,
    // not the atomic inline's otherwise empty placeholder.
    let latex = attrs
      .and_then(|attrs| attrs.get("latex"))
      .and_then(|value| match value {
        Any::String(value) => Some(value.as_ref()),
        _ => None,
      });
    let reference = attr_document_reference(attrs);
    // Native links carry their readable source label in attributes, not in
    // the atomic placeholder. Public output must not expose a private target
    // key merely to recover that label; existing authorized consumers retain
    // the typed reference below for their own target binding.
    let reference_label = reference.as_ref().and_then(|reference| {
      reference
        .title
        .as_deref()
        .filter(|label| !label.is_empty())
        .or(reference.description.as_deref().filter(|label| !label.is_empty()))
    });
    let text = match &diff.insert {
      yrs::Out::Any(Any::String(value)) => latex.or(reference_label).unwrap_or(value.as_ref()),
      _ => continue,
    };
    if text.is_empty() {
      continue;
    }
    let local = attrs.and_then(|attrs| attrs.get("footnote")).and_then(|value| {
      let Any::Map(value) = value else { return None };
      if value.contains_key("reference") {
        return None;
      }
      match (value.get("definitionId"), value.get("label")) {
        (Some(Any::String(id)), Some(Any::String(label))) if !id.is_empty() && !label.is_empty() => {
          Some((id.to_string(), label.to_string()))
        }
        _ => None,
      }
    });
    if let Some((definition_id, label)) = local {
      // Equal adjacent embeds may coalesce in a Yjs delta. Preserve every
      // occurrence so each accessible marker has its own return anchor.
      for placeholder in text.chars() {
        let visible = format!("[^{label}]");
        if let Some(limit) = remaining {
          if visible.chars().count() > limit {
            truncated = true;
            break;
          }
          remaining = Some(limit - visible.chars().count());
        }
        spans.push(InlineText {
          text: visible,
          native_footnote: attrs
            .and_then(|attrs| attrs.get("footnote"))
            .map(|value| (yjs_any_to_json(value), placeholder.to_string())),
          local_footnote: Some(LocalFootnoteMarker {
            definition_id: definition_id.clone(),
            label: label.clone(),
            reference_id: String::new(),
            resolved: false,
            placement: None,
            number: None,
          }),
          ..InlineText::plain("")
        });
      }
      if truncated {
        break;
      }
      continue;
    }
    let text = if let Some(limit) = remaining {
      let (prefix, clipped) = text_prefix(text, limit);
      truncated |= clipped;
      remaining = Some(limit - prefix.chars().count());
      prefix
    } else {
      text
    };
    if text.is_empty() {
      break;
    }
    spans.push(InlineText {
      text: text.to_string(),
      bold: attr_enabled(attrs, "bold"),
      italic: attr_enabled(attrs, "italic"),
      strike: attr_enabled(attrs, "strike"),
      code: latex.is_some() || attr_enabled(attrs, "code"),
      latex: latex.map(|source| {
        (
          source.to_owned(),
          match &diff.insert {
            yrs::Out::Any(Any::String(value)) => value.to_string(),
            _ => unreachable!(),
          },
          serde_json::Value::Object(
            attrs
              .into_iter()
              .flat_map(|attrs| attrs.iter())
              .map(|(key, value)| (key.to_string(), yjs_any_to_json(value)))
              .collect(),
          ),
        )
      }),
      link: attr_link(attrs),
      reference,
      local_footnote: None,
      native_footnote: attrs.and_then(|attrs| attrs.get("footnote")).map(|value| {
        (
          yjs_any_to_json(value),
          match &diff.insert {
            yrs::Out::Any(Any::String(value)) => value.to_string(),
            _ => String::new(),
          },
        )
      }),
      legacy_footnote: attrs.is_some_and(|attrs| {
        !attrs.contains_key("latex")
          && !attrs.contains_key("reference")
          && !attrs.contains_key("mention")
          && matches!(attrs.get("footnote"), Some(Any::Map(value)) if value.contains_key("reference"))
      }),
    });
    if truncated {
      break;
    }
  }

  if spans.is_empty() && diffs.is_empty() && max_chars.is_none() {
    let plain = text_ref.get_string(txn);
    if !plain.is_empty() {
      spans.push(InlineText::plain(plain));
    }
  }
  (spans, truncated)
}

fn attr_enabled(attrs: Option<&Attrs>, key: &str) -> bool {
  attrs
    .map(|attrs| {
      attrs
        .iter()
        .any(|(attr_key, value)| attr_key.as_ref() == key && *value != Any::Null && *value != Any::Bool(false))
    })
    .unwrap_or(false)
}

fn attr_link(attrs: Option<&Attrs>) -> Option<String> {
  attrs.and_then(|attrs| {
    attrs.iter().find_map(|(attr_key, value)| {
      if attr_key.as_ref() == "link" {
        match value {
          Any::String(value) => Some(value.to_string()),
          _ => None,
        }
      } else {
        None
      }
    })
  })
}

fn attr_document_reference(attrs: Option<&Attrs>) -> Option<yjs::MarkdownDocumentReference> {
  let Any::Map(reference) = attrs?.get("reference")? else {
    return None;
  };
  let string = |key: &str| match reference.get(key) {
    Some(Any::String(value)) => Some(value.to_string()),
    _ => None,
  };
  if string("type").as_deref() != Some("LinkedPage") {
    return None;
  }
  let page_id = string("pageId").or_else(|| string("docId"))?;
  Some(yjs::MarkdownDocumentReference {
    page_id,
    title: string("title"),
    description: string("description"),
    params: reference.get("params").map(yjs_any_to_json),
  })
}

fn native_callout_properties(block: &yrs::MapRef, txn: &yrs::TransactionMut<'_>) -> NativeCalloutProperties {
  let boolean = |key: &str| match prop_value(block, txn, key) {
    Some(yrs::Out::Any(Any::Bool(value))) => Some(value),
    _ => None,
  };
  NativeCalloutProperties {
    kind: get_prop_string(block, txn, "type"),
    title: get_prop_string(block, txn, "title"),
    foldable: boolean("foldable"),
    default_open: boolean("defaultOpen"),
  }
}

fn yjs_any_to_json(value: &Any) -> serde_json::Value {
  match value {
    Any::Null | Any::Undefined => serde_json::Value::Null,
    Any::Bool(value) => serde_json::Value::Bool(*value),
    Any::Number(value) => value
      .as_f64()
      .and_then(serde_json::Number::from_f64)
      .or_else(|| value.as_i64().map(Into::into))
      .map(serde_json::Value::Number)
      .unwrap_or(serde_json::Value::Null),
    Any::BigInt(value) => serde_json::Value::Number((*value).into()),
    Any::String(value) => serde_json::Value::String(value.to_string()),
    Any::Buffer(value) => serde_json::Value::Array(
      value
        .iter()
        .map(|byte| serde_json::Value::Number((*byte).into()))
        .collect(),
    ),
    Any::Array(values) => serde_json::Value::Array(values.iter().map(yjs_any_to_json).collect()),
    Any::Map(values) => serde_json::Value::Object(
      values
        .iter()
        .map(|(key, value)| (key.clone(), yjs_any_to_json(value)))
        .collect(),
    ),
  }
}

fn plain_inline(parts: &[InlineText]) -> String {
  parts.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join("")
}

/// Native references use a protected space as their text payload. Treat the
/// reference attribute as semantic content so projection does not discard a
/// reference-only paragraph or list item as blank.
fn inline_has_content(parts: &[InlineText]) -> bool {
  parts
    .iter()
    .any(|part| part.reference.is_some() || part.legacy_footnote)
    || !plain_inline(parts).trim().is_empty()
}

fn stable_title(extracted: Option<&str>, fallback: &str) -> String {
  extracted
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .or_else(|| {
      let fallback = fallback.trim();
      (!fallback.is_empty()).then_some(fallback)
    })
    .unwrap_or("Untitled public document")
    .to_string()
}

fn non_empty(value: String) -> Option<String> {
  if value.trim().is_empty() { None } else { Some(value) }
}

/// Bind only the projected parent tree, including table cells and nested blocks.
/// A clipped excerpt or deleted definition remains visibly unresolved; it never
/// points to a different document. Numbers are derived from main-body references;
/// definition bodies do not contribute to either counter.
fn bind_local_footnote_navigation(blocks: &mut [Block], diagnostics: &mut Vec<RenderDiagnostic>) {
  use std::collections::HashMap;
  #[derive(Default)]
  struct Numbers {
    entries: HashMap<String, (yjs::footnote::FootnotePlacement, u32, usize)>,
    footnotes: u32,
    endnotes: u32,
  }
  fn reject_nested(blocks: &mut [Block], diagnostics: &mut Vec<RenderDiagnostic>) {
    fn parts(parts: &mut [InlineText], diagnostics: &mut Vec<RenderDiagnostic>) {
      for part in parts {
        if let Some(marker) = &mut part.local_footnote {
          marker.resolved = false;
          marker.number = None;
          part.text = "[?]".into();
          diagnostics.push(RenderDiagnostic {
            code: "nested_footnote_reference".into(),
            message: "Nested local note references are unsupported; the containing body is retained.".into(),
            block_id: None,
          });
        }
      }
    }
    for block in blocks {
      match block {
        Block::Paragraph { text, .. } | Block::Heading { text, .. } | Block::Quote { text, .. } => {
          parts(text, diagnostics)
        }
        Block::Callout { text, children, .. } => {
          parts(text, diagnostics);
          reject_nested(children, diagnostics);
        }
        Block::FootnoteDefinition { children, .. } => reject_nested(children, diagnostics),
        Block::List { list, .. } => {
          for item in &mut list.items {
            parts(&mut item.text, diagnostics);
            reject_nested(&mut item.children, diagnostics);
          }
        }
        Block::Table { rows, .. } => {
          for row in rows {
            for cell in row {
              parts(cell, diagnostics);
            }
          }
        }
        _ => {}
      }
    }
  }
  fn definitions(blocks: &[Block], ids: &mut HashMap<String, Option<yjs::footnote::FootnotePlacement>>) {
    for block in blocks {
      match block {
        Block::FootnoteDefinition {
          block_id,
          placement,
          children,
          ..
        } => {
          ids.insert(block_id.clone(), *placement);
          definitions(children, ids);
        }
        Block::Callout { children, .. } => definitions(children, ids),
        Block::List { list, .. } => {
          for item in &list.items {
            definitions(&item.children, ids);
          }
        }
        _ => {}
      }
    }
  }
  fn parts(
    parts: &mut [InlineText],
    ids: &HashMap<String, Option<yjs::footnote::FootnotePlacement>>,
    returns: &mut HashMap<String, Vec<String>>,
    diagnostics: &mut Vec<RenderDiagnostic>,
    numbering: &mut Numbers,
    legacy_emits: bool,
  ) {
    for part in parts {
      if part.legacy_footnote && legacy_emits {
        numbering.footnotes += 1;
      }
      if let Some(marker) = &mut part.local_footnote {
        marker.placement = ids.get(&marker.definition_id).copied().flatten();
        marker.resolved = marker.placement.is_some();
        if let Some(placement) = marker.placement {
          let next_order = numbering.entries.len() + 1;
          let entry = numbering
            .entries
            .entry(marker.definition_id.clone())
            .or_insert_with(|| {
              let counter = match placement {
                yjs::footnote::FootnotePlacement::Footnote => &mut numbering.footnotes,
                yjs::footnote::FootnotePlacement::Endnote => &mut numbering.endnotes,
              };
              *counter += 1;
              (placement, *counter, next_order)
            });
          marker.number = Some(entry.1);
          part.text = format!("[{}]", local_note_name(marker.placement, marker.number, "en"));
        }
        let references = returns.entry(marker.definition_id.clone()).or_default();
        marker.reference_id = format!("myoxus-footnote-ref-{}-{}", marker.definition_id, references.len() + 1);
        references.push(marker.reference_id.clone());
        if !marker.resolved {
          part.text = "[?]".into();
          diagnostics.push(RenderDiagnostic {
            code: if ids.contains_key(&marker.definition_id) {
              "invalid_footnote_placement"
            } else {
              "missing_footnote_definition"
            }
            .into(),
            message: "A local note target is missing or has invalid placement.".into(),
            block_id: None,
          });
        }
      }
    }
  }
  fn markers(
    blocks: &mut [Block],
    ids: &HashMap<String, Option<yjs::footnote::FootnotePlacement>>,
    returns: &mut HashMap<String, Vec<String>>,
    diagnostics: &mut Vec<RenderDiagnostic>,
    numbering: &mut Numbers,
  ) {
    for block in blocks {
      match block {
        Block::Paragraph { text, .. } | Block::Quote { text, .. } => {
          parts(text, ids, returns, diagnostics, numbering, true)
        }
        Block::Heading { text, .. } => parts(text, ids, returns, diagnostics, numbering, false),
        Block::Callout { text, children, .. } => {
          parts(text, ids, returns, diagnostics, numbering, true);
          markers(children, ids, returns, diagnostics, numbering);
        }
        // Definition bodies and detached blocks never consume main-body numbers.
        Block::FootnoteDefinition { .. } => {}
        Block::List { list, .. } => {
          for item in &mut list.items {
            parts(&mut item.text, ids, returns, diagnostics, numbering, true);
            markers(&mut item.children, ids, returns, diagnostics, numbering);
          }
        }
        Block::Table { rows, .. } => {
          for row in rows {
            for cell in row {
              parts(cell, ids, returns, diagnostics, numbering, true);
            }
          }
        }
        _ => {}
      }
    }
  }
  fn backlinks(
    blocks: &mut [Block],
    returns: &HashMap<String, Vec<String>>,
    numbering: &HashMap<String, (yjs::footnote::FootnotePlacement, u32, usize)>,
    diagnostics: &mut Vec<RenderDiagnostic>,
  ) {
    for block in blocks {
      match block {
        Block::FootnoteDefinition {
          block_id,
          children,
          backlinks: links,
          placement,
          number,
          reference_order,
          ..
        } => {
          *links = returns.get(block_id).cloned().unwrap_or_default();
          if let Some((_, value, order)) = numbering.get(block_id) {
            *number = Some(*value);
            *reference_order = Some(*order);
          }
          if placement.is_none() {
            diagnostics.push(RenderDiagnostic {
              code: "invalid_footnote_placement".into(),
              message: "A native note definition has invalid placement.".into(),
              block_id: Some(block_id.clone()),
            });
          }
          reject_nested(children, diagnostics);
          backlinks(children, returns, numbering, diagnostics);
        }
        Block::Callout { children, .. } => backlinks(children, returns, numbering, diagnostics),
        Block::List { list, .. } => {
          for item in &mut list.items {
            backlinks(&mut item.children, returns, numbering, diagnostics);
          }
        }
        _ => {}
      }
    }
  }
  let mut ids = HashMap::new();
  definitions(blocks, &mut ids);
  let mut returns = HashMap::new();
  let mut numbering = Numbers::default();
  markers(blocks, &ids, &mut returns, diagnostics, &mut numbering);
  backlinks(blocks, &returns, &numbering.entries, diagnostics);
  // Reading order is an IR projection; never rewrite native children.
  blocks.sort_by_key(|block| match block {
    Block::FootnoteDefinition { reference_order, .. } => (1, reference_order.unwrap_or(usize::MAX)),
    _ => (0, 0),
  });
}

/// Human reading copy from transient numbering; technical labels stay metadata.
pub fn local_note_name(
  placement: Option<yjs::footnote::FootnotePlacement>,
  number: Option<u32>,
  locale: &str,
) -> String {
  use yjs::footnote::FootnotePlacement::{Endnote, Footnote};
  let (foot, end, unused, missing) = match locale.split(['-', '_']).next().unwrap_or("en") {
    "de" => ("Fußnote", "Endnote", "ohne Referenz", "Fehlende Note"),
    "fr" => ("Note de bas de page", "Note de fin", "sans référence", "Note manquante"),
    "es" => ("Nota al pie", "Nota final", "sin referencia", "Nota ausente"),
    _ => ("Footnote", "Endnote", "no reference", "Missing note"),
  };
  let kind = match placement {
    Some(Footnote) => foot,
    Some(Endnote) => end,
    None => return missing.into(),
  };
  number.map_or_else(|| format!("{kind} — {unused}"), |n| format!("{kind} {n}"))
}
