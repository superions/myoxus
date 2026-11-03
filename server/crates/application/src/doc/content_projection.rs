// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical document projections derived from the complete Yjs state.
//!
//! This service owns projection and export orchestration. It never persists a
//! second document model: every representation starts with
//! [`DocLoadService::load_full_doc_with_revision`] and one shared public-render IR instance.

use std::{collections::BTreeSet, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use myoxus_public_render::{
  Block, DocumentBadge, InlineText, NativeTableIdentity, PrivateHtmlRenderOptions, PublicDocIr, PublicList,
  RenderDiagnostic, apply_private_asset_paths, document_from_yjs, is_external_asset_source,
  render_private_document_html,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

mod native_text;
use native_text::{PrivateBlocks, restore_native_text_targets};

/// Project an already captured complete document for format adapters. Preserve
/// private text, list ordering and table identities without exposing the
/// structured-response pagination contract or reloading a newer revision.
pub(crate) fn project_snapshot_for_export(
  workspace_id: Uuid,
  doc_id: Uuid,
  title: &str,
  snapshot: &[u8],
) -> Result<PublicDocIr, DocumentProjectionError> {
  let mut ir = myoxus_public_render::document_from_yjs_for_editing(workspace_id, doc_id, title, "Private", snapshot)
    .map_err(|_| DocumentProjectionError::Projection)?;
  restore_native_text_targets(&mut ir);
  Ok(ir)
}

use super::DocLoadService;
use crate::public::PUBLIC_RENDERER_VERSION;

pub const DOCUMENT_PROJECTION_SCHEMA: &str = "myoxus.document-projection.v1";
const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 200;
const MAX_SERIALIZED_BLOCK_BYTES: usize = 1024 * 1024;
pub const DEFAULT_DOCUMENT_EXPORT_MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationReadbackUnavailableReason {
  ReadAccessDenied,
  AssetAccessDenied,
  ProjectionFailed,
  OutputLimit,
  AffectedBlockUnavailable,
  LegacyCommitUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MutationReadbackStatus {
  Complete,
  Unavailable { reason: MutationReadbackUnavailableReason },
}

/// A bounded view of affected live blocks, never a silently truncated page.
pub struct DocumentMutationReadback {
  pub blocks: Vec<Block>,
  pub status: MutationReadbackStatus,
  pub requires_blob_read: bool,
  pub native_text: std::collections::BTreeMap<String, yjs::native_text::NativeBlockText>,
}

/// Search/list projection derived from the same public-render IR used by
/// document exports. Keeping this conversion here prevents background indexing
/// from inventing a second interpretation of editor blocks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPlainTextProjection {
  pub title: String,
  pub plain_text: String,
}

pub fn project_yjs_plain_text(
  workspace_id: Uuid,
  doc_id: Uuid,
  fallback_title: &str,
  yjs: &[u8],
) -> Result<DocumentPlainTextProjection, DocumentProjectionError> {
  let ir = document_from_yjs(workspace_id, doc_id, fallback_title, "Private", yjs)
    .map_err(|_| DocumentProjectionError::Projection)?;
  Ok(DocumentPlainTextProjection {
    title: ir.document.title.clone(),
    plain_text: ir_to_plain_text(&ir),
  })
}

impl DocumentMutationReadback {
  pub fn serialized_blocks(&self) -> impl Serialize + '_ {
    PrivateBlocks {
      blocks: &self.blocks,
      native: &self.native_text,
    }
  }

  pub fn unavailable(reason: MutationReadbackUnavailableReason) -> Self {
    Self {
      blocks: Vec::new(),
      status: MutationReadbackStatus::Unavailable { reason },
      requires_blob_read: false,
      native_text: Default::default(),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentRepresentation {
  Structured,
  Html,
  Markdown,
  PlainText,
  RawYjs,
}

impl DocumentRepresentation {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Structured => "structured",
      Self::Html => "html",
      Self::Markdown => "markdown",
      Self::PlainText => "plain_text",
      Self::RawYjs => "raw_yjs",
    }
  }
}

#[derive(Debug, Clone)]
pub struct DocumentProjectionRequest {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub fallback_title: String,
  pub metadata_badges: Vec<DocumentBadge>,
  pub representation: DocumentRepresentation,
  pub cursor: Option<String>,
  pub limit: Option<usize>,
  pub theme_css_url: String,
  pub selector: Option<DocumentSelector>,
  pub neighbor_context: usize,
}

/// Select a native content block (including its descendants), a heading section,
/// or headings only. Targeted pages are flat: child payloads are not duplicated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "blockId", rename_all = "snake_case")]
pub enum DocumentSelector {
  Block(String),
  Section(String),
  Outline,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedBlockIdentity {
  pub block_id: String,
  pub parent_ids: Vec<String>,
  pub parent_count: usize,
  pub parents_complete: bool,
  pub child_ids: Vec<String>,
  pub child_count: usize,
  pub children_complete: bool,
  pub context: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSelection {
  pub selector: DocumentSelector,
  /// All selected content and requested neighbors delivered, without projection loss.
  pub complete: bool,
  pub total_blocks: usize,
  pub identities: Vec<SelectedBlockIdentity>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentProjectionEnvelope {
  pub schema_version: &'static str,
  pub revision: i64,
  pub document: ProjectedDocument,
  pub projection: ProjectionState,
  pub page: ProjectionPage,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub selection: Option<DocumentSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedDocument {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub title: String,
  pub metadata_badges: Vec<DocumentBadge>,
  pub blocks: Vec<Block>,
  /// Coordinates of tables actually returned on this page, not other source tables.
  pub table_identities: std::collections::BTreeMap<String, NativeTableIdentity>,
  pub assets: Vec<DocumentAsset>,
  pub native_text: std::collections::BTreeMap<String, yjs::native_text::NativeBlockText>,
}

impl Serialize for ProjectedDocument {
  fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeStruct;
    let mut state =
      serializer.serialize_struct("ProjectedDocument", 6 + usize::from(!self.table_identities.is_empty()))?;
    state.serialize_field("workspaceId", &self.workspace_id)?;
    state.serialize_field("docId", &self.doc_id)?;
    state.serialize_field("title", &self.title)?;
    state.serialize_field("metadataBadges", &self.metadata_badges)?;
    state.serialize_field(
      "blocks",
      &PrivateBlocks {
        blocks: &self.blocks,
        native: &self.native_text,
      },
    )?;
    if !self.table_identities.is_empty() {
      state.serialize_field("tableIdentities", &self.table_identities)?;
    }
    state.serialize_field("assets", &self.assets)?;
    state.end()
  }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAsset {
  pub source: String,
  pub alt: String,
  pub blob_read: BlobReadToolCall,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BlobReadArguments {
  pub workspace_id: Uuid,
  pub key: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BlobReadToolCall {
  pub tool: &'static str,
  pub arguments: BlobReadArguments,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionState {
  pub source: &'static str,
  pub complete: bool,
  pub diagnostics: Vec<RenderDiagnostic>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionPage {
  pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExportEnvelope {
  pub schema_version: &'static str,
  pub revision: i64,
  pub format: &'static str,
  pub media_type: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub renderer_version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub okf: Option<crate::document_metadata::okf::OkfProjection>,
  pub data: String,
  pub lossy: bool,
  pub complete: bool,
  pub diagnostics: Vec<RenderDiagnostic>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub assets: Vec<PrivateDocumentAsset>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PrivateDocumentAsset {
  Blob {
    path: String,
    media_type: String,
    size: u64,
    blob_read: BlobReadToolCall,
    #[serde(skip)]
    source_key: String,
  },
  External {
    url: String,
  },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum DocumentContentProjection {
  Structured(DocumentProjectionEnvelope),
  Export(DocumentExportEnvelope),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DocumentProjectionError {
  #[error("document projection load failed")]
  Load,
  #[error("projection cursor is invalid")]
  InvalidCursor,
  #[error("projection cursor is stale")]
  StaleCursor,
  #[error("projection page size must be between 1 and {MAX_PAGE_SIZE}")]
  InvalidPageSize,
  #[error("document selection is invalid")]
  InvalidSelector,
  #[error("selected native content block was not found")]
  SelectedBlockNotFound,
  #[error("projected block '{block_id}' exceeds {MAX_SERIALIZED_BLOCK_BYTES} bytes")]
  BlockTooLarge { block_id: String },
  #[error("document export exceeds the configured MCP output limit")]
  ExportTooLarge,
  #[error("document projection failed")]
  Projection,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorPayload {
  schema_version: String,
  workspace_id: Uuid,
  doc_id: Uuid,
  position: usize,
  source_hash: String,
  signature: String,
}

#[derive(Clone)]
pub struct DocumentContentProjectionService {
  html_catalog: Option<Arc<dyn myoxus_public_render::HtmlRendererProvider>>,
  load: Arc<DocLoadService>,
  cursor_key: Arc<[u8]>,
  max_output_bytes: usize,
  markdown_references: Option<crate::markdown::MarkdownReferenceLookup>,
  okf_context: Option<crate::document_metadata::okf::OkfReadContext>,
}

impl DocumentContentProjectionService {
  /// Project exact affected IDs from the private state returned by a commit.
  /// The caller must reauthorize reads; this path performs no current-head load.
  #[tracing::instrument(skip_all, fields(%workspace_id, doc_id = %committed.doc_id, revision = committed.sequence))]
  pub fn project_mutation(
    &self,
    workspace_id: Uuid,
    committed: &super::DocContentMutationCommit,
    affected_ids: &[String],
  ) -> DocumentMutationReadback {
    use MutationReadbackUnavailableReason as Reason;
    let removed: BTreeSet<&str> = committed.removed_block_ids.iter().map(String::as_str).collect();
    let wanted: BTreeSet<&str> = affected_ids
      .iter()
      .map(String::as_str)
      .filter(|id| !removed.contains(id))
      .collect();
    if wanted.len() > MAX_PAGE_SIZE {
      return DocumentMutationReadback::unavailable(Reason::OutputLimit);
    }
    if wanted.is_empty() {
      return DocumentMutationReadback {
        blocks: Vec::new(),
        status: MutationReadbackStatus::Complete,
        requires_blob_read: false,
        native_text: Default::default(),
      };
    }
    let Ok(mut ir) = myoxus_public_render::document_from_yjs_for_editing(
      workspace_id,
      committed.doc_id,
      "",
      "Private",
      &committed.state,
    ) else {
      return DocumentMutationReadback::unavailable(Reason::ProjectionFailed);
    };
    reject_insecure_private_assets(&mut ir);
    restore_native_text_targets(&mut ir);
    let mut blocks = Vec::new();
    let mut found = BTreeSet::new();
    collect_affected_blocks(&ir.document.blocks, &wanted, &mut found, &mut blocks);
    // A native citation card is an expected partial projection, not a readback
    // failure; only non-citation projection gaps (mutation_partial) qualify.
    if found.len() != wanted.len() || ir.mutation_partial {
      return DocumentMutationReadback::unavailable(Reason::AffectedBlockUnavailable);
    }
    let envelope_bytes = serde_json::to_vec(&(
      affected_ids,
      &committed.inserted_block_ids,
      &committed.removed_block_ids,
    ))
    .map_or(usize::MAX, |bytes| bytes.len().saturating_add(1024));
    if blocks.iter().any(|block| {
      serde_json::to_vec(&PrivateBlocks {
        blocks: std::slice::from_ref(block),
        native: &ir.native_text,
      })
      .map_or(true, |bytes| bytes.len() > MAX_SERIALIZED_BLOCK_BYTES)
    }) || serde_json::to_vec(&PrivateBlocks {
      blocks: &blocks,
      native: &ir.native_text,
    })
    .map_or(true, |bytes| {
      bytes.len().saturating_add(envelope_bytes) > self.max_output_bytes
    }) {
      return DocumentMutationReadback::unavailable(Reason::OutputLimit);
    }
    DocumentMutationReadback {
      blocks,
      status: MutationReadbackStatus::Complete,
      requires_blob_read: !ir.document.assets.is_empty(),
      native_text: ir.native_text,
    }
  }

  /// Create a projection service with a caller-owned cursor signing key.
  ///
  /// API adapters should derive this from authenticated server-side identity,
  /// never from request fields. The key signs navigation state only; ACL is
  /// still re-evaluated before every projection call.
  pub fn new(load: Arc<DocLoadService>, cursor_key: impl Into<Arc<[u8]>>) -> Self {
    Self {
      load,
      html_catalog: None,
      cursor_key: cursor_key.into(),
      max_output_bytes: DEFAULT_DOCUMENT_EXPORT_MAX_BYTES,
      markdown_references: None,
      okf_context: None,
    }
  }

  pub fn with_html_catalog(mut self, catalog: Option<Arc<dyn myoxus_public_render::HtmlRendererProvider>>) -> Self {
    self.html_catalog = catalog;
    self
  }

  /// Override the serialized export-envelope ceiling supplied by server config.
  pub fn with_max_output_bytes(mut self, max_output_bytes: usize) -> Self {
    self.max_output_bytes = max_output_bytes.max(1);
    self
  }

  /// Supply the caller's bounded, already-authorized Markdown target inventory.
  pub fn with_markdown_references(mut self, references: crate::markdown::MarkdownReferenceLookup) -> Self {
    self.markdown_references = Some(references);
    self
  }

  /// Opt in only for current Markdown reads, after native metadata/tag authorization.
  pub fn with_okf_context(mut self, context: crate::document_metadata::okf::OkfReadContext) -> Self {
    self.okf_context = Some(context);
    self
  }

  pub async fn project(
    &self,
    request: DocumentProjectionRequest,
  ) -> Result<DocumentContentProjection, DocumentProjectionError> {
    let state = self
      .load
      .load_full_doc_with_revision(request.workspace_id, request.doc_id)
      .await
      .map_err(|_| DocumentProjectionError::Load)?;
    self.project_payload(request, &state.payload, state.revision)
  }

  /// Project a caller-owned materialization and its matching committed sequence.
  /// The caller must obtain both from the same read or mutation commit; a later
  /// current-head lookup would mislabel content and invalidate preconditions.
  pub fn project_payload(
    &self,
    request: DocumentProjectionRequest,
    yjs: &[u8],
    revision: i64,
  ) -> Result<DocumentContentProjection, DocumentProjectionError> {
    self.project_payload_with_html_options(request, yjs, revision, None)
  }

  /// A caller-owned snapshot with captured private HTML styling; no document write.
  pub fn project_portable_html(
    &self,
    request: DocumentProjectionRequest,
    yjs: &[u8],
    options: PrivateHtmlRenderOptions,
  ) -> Result<DocumentContentProjection, DocumentProjectionError> {
    self.project_payload_with_html_options(request, yjs, 0, Some(options))
  }

  fn project_payload_with_html_options(
    &self,
    request: DocumentProjectionRequest,
    yjs: &[u8],
    revision: i64,
    html_options: Option<PrivateHtmlRenderOptions>,
  ) -> Result<DocumentContentProjection, DocumentProjectionError> {
    if request.neighbor_context > 10
      || (request.neighbor_context != 0 && request.selector.is_none())
      || (request.selector.is_some() && request.representation != DocumentRepresentation::Structured)
      || (request.neighbor_context != 0 && request.selector == Some(DocumentSelector::Outline))
    {
      return Err(DocumentProjectionError::InvalidSelector);
    }
    if request.representation == DocumentRepresentation::RawYjs {
      return self.checked_export(DocumentExportEnvelope {
        schema_version: DOCUMENT_PROJECTION_SCHEMA,
        revision,
        format: DocumentRepresentation::RawYjs.as_str(),
        media_type: "application/vnd.yjs-update",
        renderer_version: None,
        okf: None,
        data: base64::engine::general_purpose::STANDARD.encode(yjs),
        lossy: false,
        complete: true,
        diagnostics: Vec::new(),
        assets: Vec::new(),
      });
    }

    let project = if request.representation == DocumentRepresentation::Structured {
      myoxus_public_render::document_from_yjs_for_editing
    } else {
      document_from_yjs
    };
    let mut ir = project(
      request.workspace_id,
      request.doc_id,
      &request.fallback_title,
      "Private",
      yjs,
    )
    .map_err(|_| DocumentProjectionError::Projection)?;
    ir.document.metadata_badges = request.metadata_badges;
    let renderer_diagnostic_count = ir.diagnostics.len();
    reject_insecure_private_assets(&mut ir);
    let markdown_policy_diagnostics = ir.diagnostics[renderer_diagnostic_count..].to_vec();
    let complete = ir.diagnostics.is_empty();

    match request.representation {
      DocumentRepresentation::Structured => self.structured(
        ir,
        request.cursor,
        request.limit,
        revision,
        request.selector,
        request.neighbor_context,
      ),
      DocumentRepresentation::Html => {
        let renderer = self
          .html_catalog
          .as_ref()
          .ok_or(DocumentProjectionError::Projection)?
          .renderer()
          .map_err(|_| DocumentProjectionError::Projection)?;
        let paths = apply_private_asset_paths(&mut ir);
        let html = render_private_document_html(
          &renderer,
          &ir,
          &html_options.unwrap_or(PrivateHtmlRenderOptions {
            theme_css_url: request.theme_css_url,
            ..Default::default()
          }),
        )
        .map_err(|_| DocumentProjectionError::Projection)?;
        let mut assets = paths
          .into_iter()
          .map(|asset| PrivateDocumentAsset::Blob {
            path: asset.relative_path,
            media_type: "application/octet-stream".to_string(),
            size: 0,
            blob_read: BlobReadToolCall {
              tool: "blob_read",
              arguments: BlobReadArguments {
                workspace_id: request.workspace_id,
                key: asset.source.clone(),
              },
            },
            source_key: asset.source,
          })
          .collect::<Vec<_>>();
        assets.extend(
          ir.document
            .assets
            .iter()
            .filter(|asset| is_external_asset_source(&asset.source))
            .map(|asset| PrivateDocumentAsset::External {
              url: asset.source.clone(),
            }),
        );
        self.checked_export(DocumentExportEnvelope {
          schema_version: DOCUMENT_PROJECTION_SCHEMA,
          revision,
          format: DocumentRepresentation::Html.as_str(),
          media_type: "text/html",
          renderer_version: Some(renderer.renderer_version(PUBLIC_RENDERER_VERSION)),
          okf: None,
          data: html.html,
          lossy: false,
          complete,
          diagnostics: ir.diagnostics,
          assets,
        })
      }
      DocumentRepresentation::Markdown => {
        let policy = crate::markdown::MarkdownProjectionPolicy {
          omit_insecure_external_images: true,
        };
        let projected = match &self.markdown_references {
          Some(references) => {
            crate::markdown::project_document_with_references(yjs, &request.fallback_title, policy, references)
          }
          None => crate::markdown::project_document_with_policy(yjs, &request.fallback_title, policy),
        }
        .map_err(|_| DocumentProjectionError::Projection)?;
        let mut diagnostics = markdown_policy_diagnostics;
        diagnostics.extend(projected.diagnostics.iter().map(|diagnostic| {
          let (code, message) = match diagnostic.code {
            yjs::MarkdownDiagnosticCode::UnresolvedDocumentReference => (
              "markdown_document_reference_unresolved",
              "A document reference could not be resolved for Markdown projection.",
            ),
            yjs::MarkdownDiagnosticCode::UnsupportedDocumentReference => (
              "markdown_document_reference_unsupported",
              "A document reference uses navigation data that Markdown cannot represent.",
            ),
            yjs::MarkdownDiagnosticCode::OmittedNativeMetadata => (
              "markdown_native_metadata_omitted",
              "Native block metadata was omitted from Markdown projection.",
            ),
            yjs::MarkdownDiagnosticCode::MissingNativeSource => (
              "markdown_native_source_missing",
              "A native block has no source content to project as Markdown.",
            ),
            yjs::MarkdownDiagnosticCode::UnsupportedNativeContent => (
              "markdown_native_content_unsupported",
              "Native document content is not representable as Markdown.",
            ),
            yjs::MarkdownDiagnosticCode::MissingChildBlock => (
              "markdown_child_block_missing",
              "The native document tree references a missing child block.",
            ),
            yjs::MarkdownDiagnosticCode::NormalizedHighlight => (
              "markdown_highlight_normalized",
              "A concrete editor highlight color was normalized to Markdown highlight presence.",
            ),
            yjs::MarkdownDiagnosticCode::NormalizedAnnotation => (
              "markdown_annotation_normalized",
              "A sole inline annotation normalizes to a standalone block on Markdown re-import.",
            ),
            yjs::MarkdownDiagnosticCode::UnsupportedAnnotation => (
              "markdown_annotation_unsupported",
              "An annotation body is retained completely, but the target Markdown dialect cannot represent it faithfully.",
            ),
            yjs::MarkdownDiagnosticCode::UnsupportedCallout => (
              "markdown_callout_unsupported",
              "Callout source is outside the admitted editable note subset.",
            ),
            yjs::MarkdownDiagnosticCode::UnreferencedFootnote => (
              "markdown_footnote_unreferenced",
              "An unreferenced parent-local footnote definition was preserved in Markdown.",
            ),
            yjs::MarkdownDiagnosticCode::NormalizedEndnote => (
              "markdown_endnote_placement_normalized",
              "Endnote content is preserved as a standard Markdown footnote; endnote placement is lost and re-import defaults to footnotes.",
            ),
            yjs::MarkdownDiagnosticCode::UnsupportedMath => (
              "markdown_math_unsupported",
              "Formula source is retained outside the supported native placement or delimiter grammar.",
            ),
          };
          RenderDiagnostic {
            code: code.to_string(),
            message: message.to_string(),
            block_id: None,
          }
        }));
        if projected.partial {
          diagnostics.push(RenderDiagnostic {
            code: "markdown_projection_partial".to_string(),
            message: "Some document content is not representable as Markdown.".to_string(),
            block_id: None,
          });
        }
        let okf = self.okf_context.as_ref().map(|context| {
          crate::document_metadata::okf::project(
            context,
            myoxus_public_render::seo::knowledge_document_excerpt(&ir, &context.title),
            &projected.citations,
          )
        });
        let data = match &okf {
          Some(metadata) => metadata
            .markdown(&projected.markdown)
            .map_err(|_| DocumentProjectionError::Projection)?,
          None => projected.markdown,
        };
        self.checked_export(DocumentExportEnvelope {
          schema_version: DOCUMENT_PROJECTION_SCHEMA,
          revision,
          format: DocumentRepresentation::Markdown.as_str(),
          media_type: "text/markdown",
          renderer_version: None,
          okf,
          data,
          lossy: true,
          complete: diagnostics.is_empty(),
          diagnostics,
          assets: Vec::new(),
        })
      }
      DocumentRepresentation::PlainText => {
        let content = ir_to_plain_text(&ir);
        self.checked_export(DocumentExportEnvelope {
          schema_version: DOCUMENT_PROJECTION_SCHEMA,
          revision,
          format: DocumentRepresentation::PlainText.as_str(),
          media_type: "text/plain",
          renderer_version: None,
          okf: None,
          data: content,
          lossy: true,
          complete,
          diagnostics: ir.diagnostics,
          assets: Vec::new(),
        })
      }
      DocumentRepresentation::RawYjs => unreachable!(),
    }
  }

  fn checked_export(
    &self,
    envelope: DocumentExportEnvelope,
  ) -> Result<DocumentContentProjection, DocumentProjectionError> {
    let bytes = serde_json::to_vec(&envelope)
      .map_err(|_| DocumentProjectionError::Projection)?
      .len();
    if bytes > self.max_output_bytes {
      return Err(DocumentProjectionError::ExportTooLarge);
    }
    Ok(DocumentContentProjection::Export(envelope))
  }

  fn structured(
    &self,
    mut ir: PublicDocIr,
    cursor: Option<String>,
    limit: Option<usize>,
    revision: i64,
    selector: Option<DocumentSelector>,
    neighbor_context: usize,
  ) -> Result<DocumentContentProjection, DocumentProjectionError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
      return Err(DocumentProjectionError::InvalidPageSize);
    }
    restore_native_text_targets(&mut ir);
    let (selected_blocks, context_ids) = match selector.as_ref() {
      Some(selector) => select_blocks(&ir.document.blocks, &ir.native_children, selector, neighbor_context)?,
      None => (ir.document.blocks.clone(), BTreeSet::new()),
    };
    for block in &selected_blocks {
      let size = serde_json::to_vec(&PrivateBlocks {
        blocks: std::slice::from_ref(block),
        native: &ir.native_text,
      })
      .map_err(|_| DocumentProjectionError::Projection)?
      .len();
      let identities = table_identities_for_blocks(std::slice::from_ref(block), &ir.native_tables);
      let identity_bytes = if identities.is_empty() {
        0
      } else {
        serde_json::to_vec(&identities)
          .map_err(|_| DocumentProjectionError::Projection)?
          .len()
      };
      let size = size.saturating_add(identity_bytes);
      if size > MAX_SERIALIZED_BLOCK_BYTES {
        return Err(DocumentProjectionError::BlockTooLarge {
          block_id: block.block_id().to_string(),
        });
      }
    }

    // Include the committed sequence, not just visible blocks: title-only and
    // non-rendered native changes must invalidate a continuation too. Equivalent
    // compaction encodings of the same committed state remain interchangeable.
    let ordered_blocks = serde_json::to_vec(&ir.document.blocks).map_err(|_| DocumentProjectionError::Projection)?;
    let mut source = Sha256::new();
    source.update(revision.to_le_bytes());
    source.update(ordered_blocks);
    if let Some(selector) = &selector {
      // Bind continuations to the selection as well as the committed state.
      // Legacy unselected cursors retain their original hash and signature.
      source
        .update(serde_json::to_vec(&(selector, neighbor_context)).map_err(|_| DocumentProjectionError::Projection)?);
    }
    let source_hash = hex::encode(source.finalize());
    let position = cursor
      .as_deref()
      .map(|cursor| self.decode_cursor(cursor, ir.document.workspace_id, ir.document.doc_id, &source_hash))
      .transpose()?
      .unwrap_or(0);
    if position > selected_blocks.len() {
      return Err(DocumentProjectionError::InvalidCursor);
    }
    let end = position.saturating_add(limit).min(selected_blocks.len());
    let next_cursor = (end < selected_blocks.len())
      .then(|| self.encode_cursor(ir.document.workspace_id, ir.document.doc_id, end, &source_hash));
    let page_blocks = selected_blocks[position..end].to_vec();
    let table_identities = table_identities_for_blocks(&page_blocks, &ir.native_tables);
    let asset_refs = if selector.is_some() {
      // Resolve only assets actually present on this page, including its own
      // caption. Filtering the whole manifest by source would include unrelated
      // captions and duplicate entries when many blocks reuse the same blob.
      page_blocks
        .iter()
        .filter_map(|block| match block {
          Block::Image { asset, .. } if !asset.source.is_empty() && !is_external_asset_source(&asset.source) => {
            Some(asset)
          }
          _ => None,
        })
        .collect::<Vec<_>>()
    } else {
      ir.document
        .assets
        .iter()
        .filter(|asset| !is_external_asset_source(&asset.source))
        .collect()
    };
    let assets = asset_refs
      .into_iter()
      .map(|asset| DocumentAsset {
        source: asset.source.clone(),
        alt: asset.alt.clone(),
        blob_read: BlobReadToolCall {
          tool: "blob_read",
          arguments: BlobReadArguments {
            workspace_id: ir.document.workspace_id,
            key: asset.source.clone(),
          },
        },
      })
      .collect();
    let complete = ir.diagnostics.is_empty();
    // Build the reverse links once, rather than scanning the complete native
    // graph separately for every block in a selected page.
    let mut native_parents: std::collections::BTreeMap<&str, BTreeSet<&str>> = Default::default();
    if selector.is_some() {
      for (parent, children) in &ir.native_children {
        for child in children {
          native_parents.entry(child).or_default().insert(parent);
        }
      }
    }
    let selection = selector.map(|selector| DocumentSelection {
      selector,
      complete: end == selected_blocks.len() && complete,
      total_blocks: selected_blocks.len(),
      identities: page_blocks
        .iter()
        .map(|block| {
          let block_id = block.block_id().to_string();
          let children = ir.native_children.get(&block_id).cloned().unwrap_or_default();
          let parents = native_parents.get(block_id.as_str()).cloned().unwrap_or_default();
          SelectedBlockIdentity {
            parent_count: parents.len(),
            parents_complete: parents.len() <= MAX_PAGE_SIZE,
            parent_ids: parents.into_iter().take(MAX_PAGE_SIZE).map(str::to_string).collect(),
            child_ids: children.iter().take(MAX_PAGE_SIZE).cloned().collect(),
            child_count: children.len(),
            children_complete: children.len() <= MAX_PAGE_SIZE,
            context: context_ids.contains(&block_id),
            block_id,
          }
        })
        .collect(),
    });
    let envelope = DocumentProjectionEnvelope {
      schema_version: DOCUMENT_PROJECTION_SCHEMA,
      revision,
      document: ProjectedDocument {
        workspace_id: ir.document.workspace_id,
        doc_id: ir.document.doc_id,
        title: ir.document.title,
        metadata_badges: ir.document.metadata_badges,
        blocks: page_blocks,
        native_text: ir.native_text,
        table_identities,
        assets,
      },
      projection: ProjectionState {
        source: "yjs",
        complete,
        diagnostics: ir.diagnostics,
      },
      page: ProjectionPage { next_cursor },
      selection,
    };
    if serde_json::to_vec(&envelope)
      .map_err(|_| DocumentProjectionError::Projection)?
      .len()
      > self.max_output_bytes
    {
      return Err(DocumentProjectionError::ExportTooLarge);
    }
    Ok(DocumentContentProjection::Structured(envelope))
  }

  fn encode_cursor(&self, workspace_id: Uuid, doc_id: Uuid, position: usize, source_hash: &str) -> String {
    let signature = self.sign_cursor(workspace_id, doc_id, position, source_hash);
    URL_SAFE_NO_PAD.encode(
      serde_json::to_vec(&CursorPayload {
        schema_version: DOCUMENT_PROJECTION_SCHEMA.to_string(),
        workspace_id,
        doc_id,
        position,
        source_hash: source_hash.to_string(),
        signature,
      })
      .expect("cursor payload is serializable"),
    )
  }

  fn decode_cursor(
    &self,
    cursor: &str,
    workspace_id: Uuid,
    doc_id: Uuid,
    source_hash: &str,
  ) -> Result<usize, DocumentProjectionError> {
    let bytes = URL_SAFE_NO_PAD
      .decode(cursor)
      .map_err(|_| DocumentProjectionError::InvalidCursor)?;
    let payload: CursorPayload = serde_json::from_slice(&bytes).map_err(|_| DocumentProjectionError::InvalidCursor)?;
    if payload.schema_version != DOCUMENT_PROJECTION_SCHEMA
      || payload.workspace_id != workspace_id
      || payload.doc_id != doc_id
    {
      return Err(DocumentProjectionError::InvalidCursor);
    }
    let expected = self.sign_cursor(workspace_id, doc_id, payload.position, &payload.source_hash);
    if !constant_time_eq(expected.as_bytes(), payload.signature.as_bytes()) {
      return Err(DocumentProjectionError::InvalidCursor);
    }
    if payload.source_hash != source_hash {
      return Err(DocumentProjectionError::StaleCursor);
    }
    Ok(payload.position)
  }

  fn sign_cursor(&self, workspace_id: Uuid, doc_id: Uuid, position: usize, source_hash: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&self.cursor_key).expect("HMAC accepts arbitrary key lengths");
    mac.update(DOCUMENT_PROJECTION_SCHEMA.as_bytes());
    mac.update(workspace_id.as_bytes());
    mac.update(doc_id.as_bytes());
    mac.update(&position.to_be_bytes());
    mac.update(source_hash.as_bytes());
    hex::encode(mac.finalize().into_bytes())
  }
}

fn flatten_content(blocks: &[Block], output: &mut Vec<Block>) {
  for block in blocks {
    match block {
      Block::List { list, .. } => {
        for item in &list.items {
          let flat = myoxus_public_render::PublicListItem {
            block_id: item.block_id.clone(),
            text: item.text.clone(),
            todo_checked: item.todo_checked,
            children: Vec::new(),
          };
          output.push(Block::List {
            block_id: item.block_id.clone(),
            list: PublicList {
              kind: list.kind,
              items: vec![flat],
            },
          });
          flatten_content(&item.children, output);
        }
      }
      Block::Callout {
        block_id,
        title,
        text,
        appearance,
        children,
        native_callout,
      } => {
        output.push(Block::Callout {
          block_id: block_id.clone(),
          title: title.clone(),
          text: text.clone(),
          appearance: *appearance,
          native_callout: native_callout.clone(),
          children: Vec::new(),
        });
        flatten_content(children, output);
      }
      Block::FootnoteDefinition {
        block_id,
        label,
        placement,
        number,
        reference_order,
        children,
        backlinks,
      } => {
        output.push(Block::FootnoteDefinition {
          block_id: block_id.clone(),
          label: label.clone(),
          placement: *placement,
          number: *number,
          reference_order: *reference_order,
          children: Vec::new(),
          backlinks: backlinks.clone(),
        });
        flatten_content(children, output);
      }
      _ => output.push(block.clone()),
    }
  }
}

fn select_blocks(
  blocks: &[Block],
  native_children: &std::collections::BTreeMap<String, Vec<String>>,
  selector: &DocumentSelector,
  neighbors: usize,
) -> Result<(Vec<Block>, BTreeSet<String>), DocumentProjectionError> {
  let mut flat = Vec::new();
  flatten_content(blocks, &mut flat);
  if selector == &DocumentSelector::Outline {
    flat.retain(|block| matches!(block, Block::Heading { .. }));
    return Ok((flat, BTreeSet::new()));
  }
  let (DocumentSelector::Block(id) | DocumentSelector::Section(id)) = selector else {
    unreachable!()
  };
  let selected_indices = match selector {
    DocumentSelector::Block(_) => {
      // Empty/fallback reading placeholders are not persisted block identities.
      if !native_children.contains_key(id) {
        return Err(DocumentProjectionError::SelectedBlockNotFound);
      }
      // Paragraph descendants can be flattened by the reading IR too. Follow
      // native links, not only nested IR payloads, and bound cyclic input by IDs.
      let mut wanted = BTreeSet::new();
      let mut pending = vec![id.as_str()];
      while let Some(id) = pending.pop() {
        if !wanted.insert(id) {
          continue;
        }
        if let Some(children) = native_children.get(id) {
          pending.extend(children.iter().map(String::as_str));
        }
      }
      flat
        .iter()
        .enumerate()
        .filter_map(|(index, block)| wanted.contains(block.block_id()).then_some(index))
        .collect::<BTreeSet<_>>()
    }
    DocumentSelector::Section(_) => {
      let start = flat
        .iter()
        .position(|block| block.block_id() == id)
        .ok_or(DocumentProjectionError::SelectedBlockNotFound)?;
      let Block::Heading { level, .. } = &flat[start] else {
        return Err(DocumentProjectionError::InvalidSelector);
      };
      let end = flat
        .iter()
        .enumerate()
        .skip(start + 1)
        .find_map(|(index, block)| match block {
          Block::Heading { level: next, .. } if next <= level => Some(index),
          _ => None,
        })
        .unwrap_or(flat.len());
      (start..end).collect()
    }
    DocumentSelector::Outline => unreachable!(),
  };
  let start = *selected_indices
    .first()
    .ok_or(DocumentProjectionError::SelectedBlockNotFound)?;
  let end = selected_indices.last().unwrap() + 1;
  let before = start.saturating_sub(neighbors);
  let after = end.saturating_add(neighbors).min(flat.len());
  let context = flat[before..start]
    .iter()
    .chain(flat[end..after].iter())
    .map(|block| block.block_id().to_string())
    .collect();
  Ok((
    flat
      .into_iter()
      .enumerate()
      .filter_map(|(index, block)| {
        (selected_indices.contains(&index) || (before..start).contains(&index) || (end..after).contains(&index))
          .then_some(block)
      })
      .collect(),
    context,
  ))
}

fn table_identities_for_blocks(
  blocks: &[Block],
  source: &std::collections::BTreeMap<String, NativeTableIdentity>,
) -> std::collections::BTreeMap<String, NativeTableIdentity> {
  let mut identities = std::collections::BTreeMap::new();
  for block in blocks {
    match block {
      Block::Table { block_id, .. } => {
        if let Some(identity) = source.get(block_id) {
          identities.insert(block_id.clone(), identity.clone());
        }
      }
      Block::Callout { children, .. } | Block::FootnoteDefinition { children, .. } => {
        identities.extend(table_identities_for_blocks(children, source));
      }
      Block::List { list, .. } => {
        for item in &list.items {
          identities.extend(table_identities_for_blocks(&item.children, source));
        }
      }
      _ => {}
    }
  }
  identities
}

fn collect_affected_blocks(
  blocks: &[Block],
  wanted: &BTreeSet<&str>,
  found: &mut BTreeSet<String>,
  selected: &mut Vec<Block>,
) {
  for block in blocks {
    if wanted.contains(block.block_id()) && found.insert(block.block_id().to_string()) {
      selected.push(block.clone());
    }
    match block {
      Block::Callout { children, .. } | Block::FootnoteDefinition { children, .. } => {
        collect_affected_blocks(children, wanted, found, selected)
      }
      Block::List { list, .. } => {
        for item in &list.items {
          // The public IR groups adjacent native list blocks. An affected item
          // is still addressable by its own ID, including non-leading items.
          if wanted.contains(item.block_id.as_str()) && found.insert(item.block_id.clone()) {
            selected.push(Block::List {
              block_id: item.block_id.clone(),
              list: PublicList {
                kind: list.kind,
                items: vec![item.clone()],
              },
            });
          }
          collect_affected_blocks(&item.children, wanted, found, selected);
        }
      }
      _ => {}
    }
  }
}

fn reject_insecure_private_assets(ir: &mut PublicDocIr) {
  let insecure = ir
    .document
    .assets
    .iter()
    .filter(|asset| asset.source.starts_with("http://"))
    .map(|asset| asset.source.clone())
    .collect::<std::collections::HashSet<_>>();
  if insecure.is_empty() {
    return;
  }
  ir.document.assets.retain(|asset| !insecure.contains(&asset.source));
  fn reject(
    blocks: &mut [Block],
    insecure: &std::collections::HashSet<String>,
    diagnostics: &mut Vec<RenderDiagnostic>,
  ) {
    for block in blocks {
      match block {
        Block::Image { block_id, asset } if insecure.contains(&asset.source) => {
          asset.source.clear();
          asset.public_url = None;
          diagnostics.push(RenderDiagnostic {
            code: "insecure_external_asset".to_string(),
            message: "An insecure external image was omitted from the private projection.".to_string(),
            block_id: Some(block_id.clone()),
          });
        }
        Block::FootnoteDefinition { children, .. } | Block::Callout { children, .. } => {
          reject(children, insecure, diagnostics)
        }
        Block::List { list, .. } => {
          for item in &mut list.items {
            reject(&mut item.children, insecure, diagnostics);
          }
        }
        _ => {}
      }
    }
  }
  reject(&mut ir.document.blocks, &insecure, &mut ir.diagnostics);
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
  if left.len() != right.len() {
    return false;
  }
  left
    .iter()
    .zip(right)
    .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
    == 0
}

fn ir_to_plain_text(ir: &PublicDocIr) -> String {
  render_plain_text_blocks(&ir.document.blocks).trim_end().to_string()
}

fn render_plain_text_blocks(blocks: &[Block]) -> String {
  let mut output = String::new();
  for block in blocks {
    match block {
      Block::Paragraph { text, .. } | Block::Heading { text, .. } | Block::Quote { text, .. } => {
        push_line(&mut output, &render_plain_inline(text));
      }
      Block::List { list, .. } => {
        for item in &list.items {
          push_line(&mut output, &render_plain_inline(&item.text));
          output.push_str(&render_plain_text_blocks(&item.children));
        }
      }
      Block::Callout {
        title, text, children, ..
      } => {
        if let Some(title) = title {
          push_line(&mut output, if title.is_empty() { "Note" } else { title });
        }
        if !text.is_empty() {
          push_line(&mut output, &render_plain_inline(text));
        }
        output.push_str(&render_plain_text_blocks(children));
      }
      Block::FootnoteDefinition {
        placement,
        number,
        children,
        ..
      } => {
        push_line(
          &mut output,
          &myoxus_public_render::ir::local_note_name(*placement, *number, "en"),
        );
        output.push_str(&render_plain_text_blocks(children));
      }
      Block::Code { text, .. } => push_line(&mut output, text),
      Block::Mermaid { source, .. } => push_line(&mut output, source),
      Block::Divider { .. } => push_line(&mut output, ""),
      Block::Image { asset, .. } if !asset.alt.is_empty() => push_line(&mut output, &asset.alt),
      Block::Image { .. } => {}
      Block::BookmarkCard { url, title, .. } => {
        push_line(&mut output, if title.is_empty() { url } else { title });
      }
      Block::Table { rows, .. } => {
        for row in rows {
          let cells = row.iter().map(|cell| render_plain_inline(cell)).collect::<Vec<_>>();
          push_line(&mut output, &cells.join("\t"));
        }
      }
      Block::TablePlaceholder { .. } | Block::UnsupportedBlock { .. } => {
        push_line(&mut output, "[Unsupported content]");
      }
    }
  }
  output
}

fn render_plain_inline(parts: &[InlineText]) -> String {
  parts.iter().map(|part| part.text.as_str()).collect()
}

fn push_line(output: &mut String, line: &str) {
  output.push_str(line);
  output.push_str("\n\n");
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::PanicDocStore;
  use yrs::updates::decoder::Decode;
  use yrs::{Map, ReadTxn, Transact};

  fn html_catalog_fixture() -> Arc<myoxus_public_render::HtmlRenderer> {
    static CAPTURED: std::sync::OnceLock<Arc<myoxus_public_render::HtmlRenderer>> = std::sync::OnceLock::new();
    CAPTURED
      .get_or_init(|| {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
        let files = myoxus_public_render::HTML_CATALOG_FILES
          .iter()
          .map(|name| (name.to_string(), std::fs::read(root.join(name)).unwrap()))
          .collect();
        Arc::new(myoxus_public_render::HtmlRenderer::from_files(files).unwrap())
      })
      .clone()
  }
  fn service() -> DocumentContentProjectionService {
    DocumentContentProjectionService::new(
      Arc::new(DocLoadService::new(Arc::new(PanicDocStore))),
      Arc::<[u8]>::from(b"projection-test-secret".as_slice()),
    )
    .with_html_catalog(Some(html_catalog_fixture()))
  }

  fn request(workspace_id: Uuid, doc_id: Uuid, limit: usize) -> DocumentProjectionRequest {
    DocumentProjectionRequest {
      workspace_id,
      doc_id,
      fallback_title: "Projection".to_string(),
      metadata_badges: Vec::new(),
      representation: DocumentRepresentation::Structured,
      cursor: None,
      limit: Some(limit),
      theme_css_url: "/api/branding/theme.css".to_string(),
      selector: None,
      neighbor_context: 0,
    }
  }

  #[test]
  fn mutation_projection_never_loads_and_reports_bounds_or_unavailable_targets() {
    use super::MutationReadbackUnavailableReason as Reason;
    let workspace_id = Uuid::new_v4();
    let original = crate::markdown::markdown_to_yjs("Readback", "Original").expect("native fixture");
    let mutation = yjs::DocumentMutation::AppendBlocks {
      fragment: crate::doc::document_fragment_from_markdown("Inserted").expect("fragment"),
    };
    let applied = yjs::apply_document_mutation(&original, &mutation).expect("native mutation");
    let mut committed = crate::doc::DocContentMutationCommit {
      doc_id: Uuid::new_v4(),
      sequence: 42,
      delta: applied.delta,
      state: applied.state,
      inserted_block_ids: applied.inserted_block_ids,
      removed_block_ids: Vec::new(),
      updated_block_ids: applied.updated_block_ids,
      recovery_history_id: None,
    };
    let ids = committed.inserted_block_ids.clone();
    // PanicDocStore makes an accidental current-head read a hard test failure.
    let readback = service().project_mutation(workspace_id, &committed, &ids);
    assert_eq!(readback.status, MutationReadbackStatus::Complete);
    assert_eq!(readback.blocks.len(), 1);
    assert_eq!(readback.blocks[0].block_id(), ids[0]);
    assert!(
      serde_json::to_string(&readback.blocks)
        .expect("blocks")
        .contains("Inserted")
    );
    let unavailable = |result: DocumentMutationReadback, reason: Reason| {
      assert!(result.blocks.is_empty());
      assert_eq!(result.status, MutationReadbackStatus::Unavailable { reason });
    };
    unavailable(
      service()
        .with_max_output_bytes(1)
        .project_mutation(workspace_id, &committed, &ids),
      Reason::OutputLimit,
    );
    unavailable(
      service().project_mutation(workspace_id, &committed, &["missing".to_string()]),
      Reason::AffectedBlockUnavailable,
    );
    let many = (0..201).map(|index| index.to_string()).collect::<Vec<_>>();
    unavailable(
      service().project_mutation(workspace_id, &committed, &many),
      Reason::OutputLimit,
    );
    committed.state = vec![255];
    unavailable(
      service().project_mutation(workspace_id, &committed, &ids),
      Reason::ProjectionFailed,
    );
    committed.removed_block_ids = ids.clone();
    let removed = service().project_mutation(workspace_id, &committed, &ids);
    assert_eq!(removed.status, MutationReadbackStatus::Complete);
    assert!(removed.blocks.is_empty());
  }

  #[test]
  fn structured_projection_pages_stable_block_ids_and_detects_stale_cursor() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let original = crate::markdown::markdown_to_yjs("Projection", "First\n\nSecond").expect("fixture");
    let projected = service()
      .project_payload(request(workspace_id, doc_id, 1), &original, 0)
      .expect("first page");
    let DocumentContentProjection::Structured(first) = projected else {
      panic!("structured projection expected");
    };
    assert_eq!(first.document.blocks.len(), 1);
    assert!(!first.document.blocks[0].block_id().is_empty());
    let wire = serde_json::to_value(&first.document.blocks[0]).expect("block wire JSON");
    assert!(wire["kind"].is_string());
    assert!(wire["blockId"].is_string());
    assert!(wire.get("type").is_none() && wire.get("block_id").is_none());
    let cursor = first.page.next_cursor.expect("next cursor");

    let mut second_request = request(workspace_id, doc_id, 1);
    second_request.cursor = Some(cursor.clone());
    let DocumentContentProjection::Structured(second) = service()
      .project_payload(second_request.clone(), &original, 0)
      .expect("second page")
    else {
      panic!("structured projection expected");
    };
    assert_ne!(
      first.document.blocks[0].block_id(),
      second.document.blocks[0].block_id()
    );

    assert_eq!(
      DocumentContentProjectionService::new(
        Arc::new(DocLoadService::new(Arc::new(PanicDocStore))),
        Arc::<[u8]>::from(&b"different-server-secret"[..]),
      )
      .project_payload(second_request.clone(), &original, 0),
      Err(DocumentProjectionError::InvalidCursor)
    );

    let equivalent = yrs::Doc::new();
    equivalent
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&original).expect("decode fixture"))
      .expect("apply fixture");
    equivalent
      .get_or_insert_map("client:ephemeral")
      .insert(&mut equivalent.transact_mut(), "connected", true);
    let equivalent = equivalent
      .transact()
      .encode_state_as_update_v1(&yrs::StateVector::default());
    service()
      .project_payload(second_request.clone(), &equivalent, 0)
      .expect("non-document Yjs state must not invalidate a semantic block cursor");

    assert_eq!(
      service().project_payload(second_request.clone(), &original, 1),
      Err(DocumentProjectionError::StaleCursor),
      "a newer committed state invalidates the cursor even when rendered blocks are equal"
    );

    let changed = crate::markdown::markdown_to_yjs("Projection", "Changed\n\nSecond").expect("changed fixture");
    assert_eq!(
      service().project_payload(second_request, &changed, 0),
      Err(DocumentProjectionError::StaleCursor)
    );
  }

  #[test]
  fn html_and_structured_views_share_rich_semantics_and_private_assets() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let yjs = crate::markdown::markdown_to_yjs(
      "Projection",
      "## Heading\n\n**Bold** and [link](https://example.test)\n\n![Diagram](private/diagram.png)\n\n![Unselected caption](private/diagram.png)",
    )
    .expect("fixture");
    let DocumentContentProjection::Structured(whole) = service()
      .project_payload(request(workspace_id, doc_id, 50), &yjs, 0)
      .unwrap()
    else {
      panic!("structured")
    };
    assert_eq!(whole.document.assets.len(), 2);
    let mut selected_request = request(workspace_id, doc_id, 1);
    selected_request.selector = Some(DocumentSelector::Block(whole.document.blocks[1].block_id().to_string()));
    let DocumentContentProjection::Structured(selected) = service().project_payload(selected_request, &yjs, 0).unwrap()
    else {
      panic!("structured")
    };
    assert!(
      selected.document.assets.is_empty(),
      "unselected assets must not enter selected output or its blob authorization"
    );
    let mut image_request = request(workspace_id, doc_id, 1);
    image_request.selector = Some(DocumentSelector::Block(whole.document.blocks[2].block_id().to_string()));
    let DocumentContentProjection::Structured(image) = service().project_payload(image_request, &yjs, 0).unwrap()
    else {
      panic!("structured")
    };
    assert_eq!(image.document.assets, whole.document.assets[..1]);
    assert!(!serde_json::to_string(&image).unwrap().contains("Unselected caption"));
    let mut html_request = request(workspace_id, doc_id, 50);
    html_request.representation = DocumentRepresentation::Html;
    let DocumentContentProjection::Export(html) = service().project_payload(html_request, &yjs, 0).expect("html")
    else {
      panic!("HTML export expected");
    };
    assert_eq!(html.format, "html");
    assert_eq!(html.media_type, "text/html");
    assert_eq!(
      html.renderer_version,
      Some(html_catalog_fixture().renderer_version(PUBLIC_RENDERER_VERSION))
    );
    assert!(!html.lossy);
    assert!(html.data.contains("<h2"));
    assert!(html.data.contains("<strong>Bold</strong>"));
    assert!(html.data.contains("assets/"));
    assert!(!html.data.contains("/public/"));
    let PrivateDocumentAsset::Blob {
      source_key, blob_read, ..
    } = &html.assets[0]
    else {
      panic!("private image must be a blob manifest entry");
    };
    assert_eq!(source_key, "private/diagram.png");
    assert_eq!(blob_read.arguments.key, "private/diagram.png");
    let wire = serde_json::to_value(&html).expect("HTML export wire JSON");
    assert!(wire["assets"][0].get("mediaType").is_some());
    assert!(wire["assets"][0].get("blobRead").is_some());
    assert!(wire["assets"][0].get("media_type").is_none());
  }

  #[test]
  fn private_html_omits_insecure_external_images_with_a_safe_diagnostic() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let yjs =
      crate::markdown::markdown_to_yjs("Projection", "![Insecure](http://example.test/image.png)").expect("fixture");
    let DocumentContentProjection::Structured(whole) = service()
      .project_payload(request(workspace_id, doc_id, 1), &yjs, 0)
      .unwrap()
    else {
      panic!("structured")
    };
    let mut selected_request = request(workspace_id, doc_id, 1);
    selected_request.selector = Some(DocumentSelector::Block(whole.document.blocks[0].block_id().to_string()));
    let DocumentContentProjection::Structured(selected) = service().project_payload(selected_request, &yjs, 0).unwrap()
    else {
      panic!("structured")
    };
    assert!(
      selected.document.assets.is_empty(),
      "policy placeholders must not produce empty blob keys"
    );
    assert_eq!(selected.projection.diagnostics, whole.projection.diagnostics);
    assert!(!selected.selection.unwrap().complete);
    let mut html_request = request(workspace_id, doc_id, 50);
    html_request.representation = DocumentRepresentation::Html;
    let DocumentContentProjection::Export(html) = service().project_payload(html_request, &yjs, 0).expect("html")
    else {
      panic!("HTML export expected");
    };
    assert!(!html.complete);
    assert!(
      html
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "insecure_external_asset")
    );
    assert!(!html.data.contains("http://example.test/image.png"));
    assert!(html.data.contains("data-myoxus-role=\"public-asset-placeholder\""));
  }

  #[test]
  fn footnote_private_html_text_and_mutation_boundaries_keep_complete_parent_content() {
    let source = include_str!("../../../../../build/fixtures/markdown/obsidian-vault/Structured footnotes.md");
    let payload = crate::markdown::markdown_to_yjs("Footnotes", source).unwrap();
    let mut req = request(Uuid::new_v4(), Uuid::new_v4(), 50);
    req.representation = DocumentRepresentation::Html;
    let DocumentContentProjection::Export(html) = service().project_payload(req, &payload, 1).unwrap() else {
      panic!("HTML");
    };
    assert!(html.complete);
    assert_eq!(html.assets.len(), 1);
    assert_eq!(html.data.matches("role=\"doc-footnote\"").count(), 2);
    assert_eq!(html.data.matches("Definition body with").count(), 1);
    let plain = project_yjs_plain_text(Uuid::nil(), Uuid::nil(), "Footnotes", &payload)
      .unwrap()
      .plain_text;
    assert_eq!(plain.matches("[Footnote 1]").count(), 2);
    assert!(!plain.contains("[^Research]"));
    for body in [
      "Completed task",
      "Pending task",
      "Definition heading",
      "literal[^not-a-reference]",
      "left\tcenter\tright",
      "one\ttwo\tthree",
      "Footnote 2",
    ] {
      assert!(plain.contains(body), "missing {body}");
    }
    let fragment = crate::doc::content_mutation::document_fragment_from_yjs(&payload).unwrap();
    assert_eq!(
      fragment
        .blocks
        .iter()
        .filter(|block| matches!(block, yjs::DocumentFragmentBlock::FootnoteDefinition { .. }))
        .count(),
      2
    );
    assert!(
      serde_json::to_string(&fragment)
        .unwrap()
        .contains("Definition body with")
    );
    assert!(crate::doc::content_mutation::document_fragment_from_markdown("Normal **paragraph**").is_ok());
    let insecure = crate::markdown::markdown_to_yjs(
      "Footnotes",
      "Body[^a]\n\n[^a]: ![private](http://example.test/image.png)\n",
    )
    .unwrap();
    let mut req = request(Uuid::new_v4(), Uuid::new_v4(), 50);
    req.representation = DocumentRepresentation::Html;
    let DocumentContentProjection::Export(html) = service().project_payload(req, &insecure, 1).unwrap() else {
      panic!("HTML");
    };
    assert!(!html.complete);
    assert!(html.diagnostics.iter().any(|d| d.code == "insecure_external_asset"));
    assert!(!html.data.contains("http://example.test/image.png"));
  }

  #[test]
  fn endnote_standard_markdown_loss_is_visible_in_the_existing_export_envelope() {
    use yrs::StateVector;
    let binary =
      crate::markdown::markdown_to_yjs("Endnote", "Body[^label].\n\n[^label]: **Complete body**.\n").unwrap();
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    txn.apply_update(yrs::Update::decode_v1(&binary).unwrap()).unwrap();
    let definition = blocks
      .iter(&txn)
      .find_map(|(_, value)| {
        let yrs::Out::YMap(block) = value else { return None };
        block.get(&txn, "prop:label").map(|_| block)
      })
      .unwrap();
    definition.insert(&mut txn, "prop:placement", "endnote");
    let payload = txn.encode_state_as_update_v1(&StateVector::default());
    drop(txn);
    let mut req = request(Uuid::new_v4(), Uuid::new_v4(), 50);
    req.representation = DocumentRepresentation::Markdown;
    let DocumentContentProjection::Export(output) = service().project_payload(req, &payload, 1).unwrap() else {
      panic!("Markdown")
    };
    assert!(output.data.contains("[^label]: **Complete body**."));
    assert!(output.lossy);
    assert!(!output.complete);
    assert_eq!(
      output
        .diagnostics
        .iter()
        .filter(|d| d.code == "markdown_endnote_placement_normalized")
        .count(),
      1
    );
    let plain = project_yjs_plain_text(Uuid::nil(), Uuid::nil(), "Endnote", &payload)
      .unwrap()
      .plain_text;
    assert!(plain.contains("[Endnote 1]"));
    assert!(plain.contains("Endnote 1\n"));
    assert!(!plain.contains("[^label]"));
  }

  #[test]
  fn raw_yjs_returns_complete_merged_payload_without_lossy_projection() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let yjs = crate::markdown::markdown_to_yjs("Projection", "Body").expect("fixture");
    let mut raw_request = request(workspace_id, doc_id, 50);
    raw_request.representation = DocumentRepresentation::RawYjs;
    let DocumentContentProjection::Export(raw) = service().project_payload(raw_request, &yjs, 0).expect("raw") else {
      panic!("raw export expected");
    };
    assert!(!raw.lossy);
    assert_eq!(raw.media_type, "application/vnd.yjs-update");
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(raw.data).unwrap(), yjs);
  }

  #[test]
  fn export_envelope_is_rejected_instead_of_truncated() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let yjs = crate::markdown::markdown_to_yjs("Projection", "Body").expect("fixture");
    let mut export_request = request(workspace_id, doc_id, 50);
    export_request.representation = DocumentRepresentation::PlainText;
    assert_eq!(
      service()
        .with_max_output_bytes(8)
        .project_payload(export_request, &yjs, 0),
      Err(DocumentProjectionError::ExportTooLarge)
    );
  }
}
