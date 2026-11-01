//! GraphQL contract for the server-authoritative Document Graph.
//!
//! Resolvers in this module are read-only for normal users. They do not expose
//! reindex mutations; queue and CLI entry points share the application service
//! but stay outside the user GraphQL contract.

use async_graphql::{Context, Enum, Error, ErrorExtensions, ID, InputObject, Result, SimpleObject};
use chrono::{DateTime, Utc};
use myoxus_application::document_graph::{DocumentGraphService, DocumentGraphServiceError, ERR_SERVICE_UNAVAILABLE};
use myoxus_domain::document_graph as domain;
use myoxus_domain::ids::{DocId, WorkspaceId};
use std::{
  collections::{HashMap, HashSet},
  sync::Arc,
};

use super::DatabaseDocumentReferenceObjectType;
use crate::graphql::utils::{require_session, resolve_doc_id};
use crate::state::ApiState;

const ERR_IDENTITY_INVARIANT: &str = "MIX_GRAPH_IDENTITY_INVARIANT";

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DocumentGraphDirection", rename_items = "PascalCase")]
pub enum DocumentGraphDirectionType {
  Incoming,
  Outgoing,
  Both,
}

impl From<DocumentGraphDirectionType> for domain::DocumentGraphDirection {
  fn from(value: DocumentGraphDirectionType) -> Self {
    match value {
      DocumentGraphDirectionType::Incoming => Self::Incoming,
      DocumentGraphDirectionType::Outgoing => Self::Outgoing,
      DocumentGraphDirectionType::Both => Self::Both,
    }
  }
}

impl From<domain::DocumentGraphDirection> for DocumentGraphDirectionType {
  fn from(value: domain::DocumentGraphDirection) -> Self {
    match value {
      domain::DocumentGraphDirection::Incoming => Self::Incoming,
      domain::DocumentGraphDirection::Outgoing => Self::Outgoing,
      domain::DocumentGraphDirection::Both => Self::Both,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DocumentGraphLinkKind", rename_items = "PascalCase")]
pub enum DocumentGraphLinkKindType {
  InlineReference,
  EmbedLinkedDoc,
  EmbedSyncedDoc,
  SurfaceRef,
  DatabaseCellReference,
}

impl From<domain::DocumentGraphLinkKind> for DocumentGraphLinkKindType {
  fn from(value: domain::DocumentGraphLinkKind) -> Self {
    match value {
      domain::DocumentGraphLinkKind::InlineReference => Self::InlineReference,
      domain::DocumentGraphLinkKind::EmbedLinkedDoc => Self::EmbedLinkedDoc,
      domain::DocumentGraphLinkKind::EmbedSyncedDoc => Self::EmbedSyncedDoc,
      domain::DocumentGraphLinkKind::SurfaceRef => Self::SurfaceRef,
      domain::DocumentGraphLinkKind::DatabaseCellReference => Self::DatabaseCellReference,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DocumentGraphTargetState", rename_items = "PascalCase")]
pub enum DocumentGraphTargetStateType {
  Available,
  Redacted,
  Deleted,
  Missing,
  Unresolved,
}

impl From<domain::DocumentGraphTargetState> for DocumentGraphTargetStateType {
  fn from(value: domain::DocumentGraphTargetState) -> Self {
    match value {
      domain::DocumentGraphTargetState::Available => Self::Available,
      domain::DocumentGraphTargetState::Redacted => Self::Redacted,
      domain::DocumentGraphTargetState::Deleted => Self::Deleted,
      domain::DocumentGraphTargetState::Missing => Self::Missing,
      domain::DocumentGraphTargetState::Unresolved => Self::Unresolved,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DocumentGraphStaleState", rename_items = "PascalCase")]
pub enum DocumentGraphStaleStateType {
  Current,
  Stale,
  Queued,
  Extracting,
  Failed,
  Deleted,
}

impl From<domain::DocumentGraphStaleState> for DocumentGraphStaleStateType {
  fn from(value: domain::DocumentGraphStaleState) -> Self {
    match value {
      domain::DocumentGraphStaleState::Current => Self::Current,
      domain::DocumentGraphStaleState::Stale => Self::Stale,
      domain::DocumentGraphStaleState::Queued => Self::Queued,
      domain::DocumentGraphStaleState::Extracting => Self::Extracting,
      domain::DocumentGraphStaleState::Failed => Self::Failed,
      domain::DocumentGraphStaleState::Deleted => Self::Deleted,
    }
  }
}

#[derive(InputObject, Clone)]
pub struct DocumentGraphMetadataFilterInput {
  #[graphql(default)]
  pub statuses: Vec<String>,
  #[graphql(default)]
  pub document_types: Vec<String>,
  #[graphql(default)]
  pub classifications: Vec<String>,
}

impl From<DocumentGraphMetadataFilterInput> for domain::DocumentGraphMetadataFilter {
  fn from(value: DocumentGraphMetadataFilterInput) -> Self {
    Self {
      statuses: value.statuses,
      document_types: value.document_types,
      classifications: value.classifications,
    }
  }
}

#[derive(InputObject, Clone)]
pub struct DocumentGraphInput {
  pub focus_doc_id: Option<ID>,
  pub direction: DocumentGraphDirectionType,
  pub first: Option<i32>,
  pub after: Option<String>,
  pub metadata_filter: Option<DocumentGraphMetadataFilterInput>,
  pub include_occurrences: Option<bool>,
}

#[derive(InputObject, Clone)]
pub struct DocumentLinksInput {
  pub doc_id: ID,
  pub direction: DocumentGraphDirectionType,
  pub first: Option<i32>,
  pub after: Option<String>,
  pub include_occurrences: Option<bool>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DocumentGraphNodeType")]
pub struct DocumentGraphNodeObjectType {
  pub workspace_id: ID,
  pub doc_id: Option<ID>,
  pub raw_doc_id: String,
  pub title: Option<String>,
  pub document_type: Option<String>,
  pub status: Option<String>,
  pub classification: Option<String>,
  pub deleted: bool,
  pub redacted: bool,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DocumentGraphOccurrenceType")]
pub struct DocumentGraphOccurrenceObjectType {
  pub id: ID,
  pub source_doc_id: ID,
  pub source_block_id: String,
  pub source_parent_block_id: Option<String>,
  pub source_parent_flavour: Option<String>,
  pub target_workspace_id: Option<ID>,
  pub raw_target_doc_id: String,
  pub target_doc_id: Option<ID>,
  pub link_kind: DocumentGraphLinkKindType,
  pub params_json: async_graphql::Json<serde_json::Value>,
  pub markdown_preview: Option<String>,
  pub target_state: DocumentGraphTargetStateType,
  pub extracted_at: DateTime<Utc>,
  pub source_updated_at: Option<DateTime<Utc>>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DocumentGraphEdgeType")]
pub struct DocumentGraphEdgeObjectType {
  pub source_doc_id: ID,
  pub target_doc_id: Option<ID>,
  pub target_workspace_id: Option<ID>,
  pub raw_target_doc_id: String,
  pub target_state: DocumentGraphTargetStateType,
  pub link_kind: DocumentGraphLinkKindType,
  pub occurrence_count: i64,
  pub first_occurrence_preview: Option<String>,
  pub stale_state: DocumentGraphStaleStateType,
  pub occurrences: Vec<DocumentGraphOccurrenceObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DocumentGraphIndexStatusType")]
pub struct DocumentGraphIndexStatusObjectType {
  pub stale_state: Option<DocumentGraphStaleStateType>,
  pub indexed_at: Option<DateTime<Utc>>,
  pub queued_at: Option<DateTime<Utc>>,
  pub started_at: Option<DateTime<Utc>>,
  pub failed_at: Option<DateTime<Utc>>,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub attempt_count: i32,
  pub occurrence_count: i32,
  pub current_count: i64,
  pub stale_count: i64,
  pub queued_count: i64,
  pub extracting_count: i64,
  pub failed_count: i64,
  pub deleted_count: i64,
  pub missing_state_count: i64,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DocumentGraphResult")]
pub struct DocumentGraphResultObjectType {
  pub nodes: Vec<DocumentGraphNodeObjectType>,
  pub edges: Vec<DocumentGraphEdgeObjectType>,
  pub database_references: Vec<DatabaseDocumentReferenceObjectType>,
  pub index_status: DocumentGraphIndexStatusObjectType,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DocumentLinksResult")]
pub struct DocumentLinksResultObjectType {
  pub nodes: Vec<DocumentGraphNodeObjectType>,
  pub edges: Vec<DocumentGraphEdgeObjectType>,
  pub database_references: Vec<DatabaseDocumentReferenceObjectType>,
  pub index_status: DocumentGraphIndexStatusObjectType,
}

pub(crate) async fn read_workspace_document_graph(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: DocumentGraphInput,
) -> Result<DocumentGraphResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let focus_doc_id = match input.focus_doc_id.as_ref() {
    Some(document_key) => Some(resolve_doc_id(&state, workspace_id, document_key.as_str()).await?),
    None => None,
  };
  let service = document_graph_service(&state)?;
  let query = domain::DocumentGraphQuery {
    focus_doc_id,
    direction: input.direction.into(),
    page: domain::DocumentGraphPage {
      first: input.first.unwrap_or(100).clamp(1, i32::MAX) as i64,
      offset: parse_offset(input.after.as_deref())?,
    },
    metadata_filter: input.metadata_filter.map(Into::into),
    include_occurrences: input.include_occurrences.unwrap_or(false),
  };
  let model = service
    .read_workspace_graph(snapshot.user.id, workspace_id, query)
    .await
    .map_err(map_document_graph_error)?;
  map_graph_result(&state, workspace_id, model).await
}

pub(crate) async fn read_document_links(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: DocumentLinksInput,
) -> Result<DocumentLinksResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let service = document_graph_service(&state)?;
  let document_id = resolve_doc_id(&state, workspace_id, input.doc_id.as_str()).await?;
  let model = service
    .read_document_links(
      snapshot.user.id,
      workspace_id,
      document_id,
      input.direction.into(),
      domain::DocumentGraphPage {
        first: input.first.unwrap_or(100).clamp(1, i32::MAX) as i64,
        offset: parse_offset(input.after.as_deref())?,
      },
      input.include_occurrences.unwrap_or(false),
    )
    .await
    .map_err(map_document_graph_error)?;
  let result = map_graph_result(&state, workspace_id, model).await?;
  Ok(DocumentLinksResultObjectType {
    nodes: result.nodes,
    edges: result.edges,
    database_references: result.database_references,
    index_status: result.index_status,
  })
}

pub(crate) async fn read_document_graph_index_status(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  doc_id: Option<ID>,
) -> Result<DocumentGraphIndexStatusObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let service = document_graph_service(&state)?;
  let document_id = match doc_id.as_ref() {
    Some(document_key) => Some(resolve_doc_id(&state, workspace_id, document_key.as_str()).await?),
    None => None,
  };
  let (summary, state) = service
    .index_status(snapshot.user.id, workspace_id, document_id)
    .await
    .map_err(map_document_graph_error)?;
  Ok(map_index_status(summary, state))
}

fn document_graph_service(state: &Arc<ApiState>) -> Result<Arc<DocumentGraphService>> {
  state
    .document_graph_service()
    .ok_or_else(|| graph_error(ERR_SERVICE_UNAVAILABLE, "document graph service is not configured"))
}

fn parse_offset(after: Option<&str>) -> Result<i64> {
  match after {
    Some(value) if !value.trim().is_empty() => value
      .parse::<i64>()
      .map(|value| value.max(0))
      .map_err(|_| graph_error(myoxus_application::document_graph::ERR_QUERY_INVALID, "invalid cursor")),
    _ => Ok(0),
  }
}

async fn map_graph_result(
  state: &Arc<ApiState>,
  workspace_id: WorkspaceId,
  model: domain::DocumentGraphReadModel,
) -> Result<DocumentGraphResultObjectType> {
  // Resolve identities only inside the already-authorized node/edge scopes.
  let mut by_workspace = HashMap::<WorkspaceId, HashSet<DocId>>::new();
  for node in &model.nodes {
    if let Some(id) = node.doc_id {
      by_workspace.entry(node.workspace_id).or_default().insert(id);
    }
  }
  for edge in &model.edges {
    by_workspace.entry(workspace_id).or_default().insert(edge.source_doc_id);
    if let (Some(scope), Some(id)) = (edge.target_workspace_id, edge.target_doc_id) {
      by_workspace.entry(scope).or_default().insert(id);
    }
    for occurrence in &edge.occurrences {
      by_workspace
        .entry(occurrence.workspace_id)
        .or_default()
        .insert(occurrence.source_doc_id);
      if let (Some(scope), Some(id)) = (occurrence.target_workspace_id, occurrence.target_doc_id) {
        by_workspace.entry(scope).or_default().insert(id);
      }
    }
  }
  for reference in &model.database_references {
    if let Some(id) = reference.resolved_target_doc_id {
      if let Some(scope) = reference.target_workspace_id {
        by_workspace.entry(scope).or_default().insert(id);
      }
    }
  }
  let mut document_keys = HashMap::new();
  for (scope, ids) in by_workspace {
    document_keys.extend(
      state
        .doc()
        .resolve_external_doc_ids(scope, &ids.into_iter().collect::<Vec<_>>())
        .await
        .map_err(|_| {
          graph_error(
            ERR_SERVICE_UNAVAILABLE,
            "document graph identity projection unavailable",
          )
        })?,
    );
  }
  map_graph_result_with_keys(model, &document_keys)
}

fn map_graph_result_with_keys(
  model: domain::DocumentGraphReadModel,
  document_keys: &HashMap<DocId, String>,
) -> Result<DocumentGraphResultObjectType> {
  Ok(DocumentGraphResultObjectType {
    nodes: model
      .nodes
      .into_iter()
      .map(|node| map_node(node, document_keys))
      .collect::<Result<Vec<_>>>()?,
    edges: model
      .edges
      .into_iter()
      .map(|edge| map_edge(edge, &document_keys))
      .collect::<Result<Vec<_>>>()?,
    database_references: model
      .database_references
      .into_iter()
      .map(|reference| {
        let target_doc_id = reference.resolved_target_doc_id.map(|doc_id| {
          document_keys
            .get(&doc_id)
            .cloned()
            .unwrap_or_else(|| reference.raw_target_doc_id.clone())
        });
        let mut mapped = DatabaseDocumentReferenceObjectType::from(reference);
        mapped.target_doc_id = target_doc_id.map(ID::from);
        mapped
      })
      .collect(),
    index_status: map_index_status(model.index_summary, None),
  })
}

fn map_node(
  node: domain::DocumentGraphNode,
  document_keys: &HashMap<DocId, String>,
) -> Result<DocumentGraphNodeObjectType> {
  let doc_id = node
    .doc_id
    .map(|doc_id| require_projected_source_key(document_keys, doc_id).map(ID::from))
    .transpose()?;
  Ok(DocumentGraphNodeObjectType {
    doc_id,
    workspace_id: ID::from(node.workspace_id),
    raw_doc_id: node.raw_doc_id,
    title: node.title,
    document_type: node.document_type,
    status: node.status,
    classification: node.classification,
    deleted: node.deleted,
    redacted: node.redacted,
  })
}

fn map_edge(
  edge: domain::DocumentGraphEdge,
  document_keys: &HashMap<DocId, String>,
) -> Result<DocumentGraphEdgeObjectType> {
  let redacted = edge.target_state == domain::DocumentGraphTargetState::Redacted;
  let source_doc_id = require_projected_source_key(document_keys, edge.source_doc_id)?;
  let target_doc_id = edge
    .target_doc_id
    .map(|doc_id| projected_target_key(document_keys, doc_id, &edge.raw_target_doc_id, edge.target_state))
    .transpose()?;
  Ok(DocumentGraphEdgeObjectType {
    source_doc_id: ID::from(source_doc_id),
    target_doc_id: if redacted { None } else { target_doc_id.map(ID::from) },
    target_workspace_id: edge.target_workspace_id.map(ID::from),
    raw_target_doc_id: edge.raw_target_doc_id,
    target_state: edge.target_state.into(),
    link_kind: edge.link_kind.into(),
    occurrence_count: edge.occurrence_count,
    first_occurrence_preview: if redacted { None } else { edge.first_occurrence_preview },
    stale_state: edge.stale_state.into(),
    occurrences: if redacted {
      Vec::new()
    } else {
      edge
        .occurrences
        .into_iter()
        .map(|occurrence| map_occurrence(occurrence, document_keys))
        .collect::<Result<Vec<_>>>()?
    },
  })
}

fn map_occurrence(
  occurrence: domain::DocumentGraphOccurrence,
  document_keys: &HashMap<DocId, String>,
) -> Result<DocumentGraphOccurrenceObjectType> {
  let source_doc_id = require_projected_source_key(document_keys, occurrence.source_doc_id)?;
  let target_doc_id = occurrence
    .target_doc_id
    .map(|doc_id| {
      projected_target_key(
        document_keys,
        doc_id,
        &occurrence.raw_target_doc_id,
        occurrence.target_state,
      )
    })
    .transpose()?;
  Ok(DocumentGraphOccurrenceObjectType {
    id: ID::from(occurrence.id.to_string()),
    source_doc_id: ID::from(source_doc_id),
    source_block_id: occurrence.source_block_id,
    source_parent_block_id: occurrence.source_parent_block_id,
    source_parent_flavour: occurrence.source_parent_flavour,
    target_workspace_id: occurrence.target_workspace_id.map(ID::from),
    raw_target_doc_id: occurrence.raw_target_doc_id,
    target_doc_id: target_doc_id.map(ID::from),
    link_kind: occurrence.link_kind.into(),
    params_json: async_graphql::Json(occurrence.params_json),
    markdown_preview: Some(occurrence.markdown_preview),
    target_state: occurrence.target_state.into(),
    extracted_at: occurrence.extracted_at,
    source_updated_at: occurrence.source_updated_at,
  })
}

fn require_projected_source_key(document_keys: &HashMap<DocId, String>, doc_id: DocId) -> Result<String> {
  document_keys.get(&doc_id).cloned().ok_or_else(|| {
    graph_error(
      ERR_IDENTITY_INVARIANT,
      "document graph source identity projection missing",
    )
  })
}

fn projected_target_key(
  document_keys: &HashMap<DocId, String>,
  doc_id: DocId,
  raw_target_doc_id: &str,
  target_state: domain::DocumentGraphTargetState,
) -> Result<String> {
  match target_state {
    domain::DocumentGraphTargetState::Available => document_keys.get(&doc_id).cloned().ok_or_else(|| {
      graph_error(
        ERR_IDENTITY_INVARIANT,
        "document graph target identity projection missing",
      )
    }),
    domain::DocumentGraphTargetState::Deleted
    | domain::DocumentGraphTargetState::Missing
    | domain::DocumentGraphTargetState::Unresolved
    | domain::DocumentGraphTargetState::Redacted => Ok(raw_target_doc_id.to_string()),
  }
}

fn map_index_status(
  summary: domain::DocumentGraphIndexSummary,
  state: Option<domain::DocumentGraphIndexState>,
) -> DocumentGraphIndexStatusObjectType {
  DocumentGraphIndexStatusObjectType {
    stale_state: state.as_ref().map(|state| state.stale_state.into()),
    indexed_at: state.as_ref().and_then(|state| state.indexed_at),
    queued_at: state.as_ref().and_then(|state| state.queued_at),
    started_at: state.as_ref().and_then(|state| state.started_at),
    failed_at: state.as_ref().and_then(|state| state.failed_at),
    error_code: state.as_ref().and_then(|state| state.error_code.clone()),
    error_message: state.as_ref().and_then(|state| state.error_message.clone()),
    attempt_count: state.as_ref().map(|state| state.attempt_count).unwrap_or(0),
    occurrence_count: state.as_ref().map(|state| state.occurrence_count).unwrap_or(0),
    current_count: summary.current_count,
    stale_count: summary.stale_count,
    queued_count: summary.queued_count,
    extracting_count: summary.extracting_count,
    failed_count: summary.failed_count,
    deleted_count: summary.deleted_count,
    missing_state_count: summary.missing_state_count,
  }
}

fn map_document_graph_error(error: DocumentGraphServiceError) -> Error {
  graph_error(error.code, error.message)
}

fn graph_error(code: &'static str, message: impl Into<String>) -> Error {
  Error::new(message.into()).extend_with(|_, e| {
    e.set("code", code);
    e.set("type", code);
    e.set("name", code);
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use uuid::Uuid;

  fn assert_identity_invariant(error: Error, internal_id: DocId) {
    assert!(
      error.message.contains("identity projection missing"),
      "unexpected projection error: {error:?}"
    );
    assert!(
      !error.message.contains(&internal_id.to_string()),
      "identity invariant error must not disclose the internal UUID"
    );
    assert_eq!(
      error.extensions.as_ref().and_then(|extensions| extensions.get("code")),
      Some(&async_graphql::Value::from(ERR_IDENTITY_INVARIANT))
    );
  }

  fn occurrence(source_doc_id: DocId, target_doc_id: Option<DocId>) -> domain::DocumentGraphOccurrence {
    let now = Utc::now();
    domain::DocumentGraphOccurrence {
      id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      source_doc_id,
      source_block_id: "block".to_string(),
      source_position: serde_json::Value::Null,
      target_workspace_id: None,
      source_parent_block_id: None,
      source_parent_flavour: None,
      raw_target_doc_id: "external-target".to_string(),
      target_doc_id,
      link_kind: domain::DocumentGraphLinkKind::InlineReference,
      params_json: serde_json::json!({}),
      params_key: "params".to_string(),
      markdown_preview: "target".to_string(),
      target_state: domain::DocumentGraphTargetState::Available,
      extracted_at: now,
      source_updated_at: Some(now),
      created_at: now,
    }
  }

  fn edge(
    source_doc_id: DocId,
    target_doc_id: Option<DocId>,
    occurrences: Vec<domain::DocumentGraphOccurrence>,
  ) -> domain::DocumentGraphEdge {
    domain::DocumentGraphEdge {
      target_workspace_id: None,
      source_doc_id,
      target_doc_id,
      raw_target_doc_id: "external-target".to_string(),
      target_state: domain::DocumentGraphTargetState::Available,
      link_kind: domain::DocumentGraphLinkKind::InlineReference,
      occurrence_count: occurrences.len() as i64,
      first_occurrence_preview: Some("target".to_string()),
      stale_state: domain::DocumentGraphStaleState::Current,
      occurrences,
    }
  }

  #[test]
  fn graph_projection_fails_closed_when_any_required_external_key_is_missing() {
    let source_doc_id = Uuid::new_v4();
    let occurrence_source_doc_id = Uuid::new_v4();
    let target_doc_id = Uuid::new_v4();

    let Err(node_error) = map_node(
      domain::DocumentGraphNode {
        workspace_id: Uuid::new_v4(),
        doc_id: Some(source_doc_id),
        raw_doc_id: "external-source".to_string(),
        title: None,
        document_type: None,
        status: None,
        classification: None,
        deleted: false,
        redacted: false,
      },
      &HashMap::new(),
    ) else {
      panic!("node without external projection must fail closed");
    };
    assert_identity_invariant(node_error, source_doc_id);

    let Err(edge_error) = map_edge(edge(source_doc_id, None, Vec::new()), &HashMap::new()) else {
      panic!("edge source without external projection must fail closed");
    };
    assert_identity_invariant(edge_error, source_doc_id);

    let source_keys = HashMap::from([(source_doc_id, "external-source".to_string())]);
    let Err(occurrence_error) = map_edge(
      edge(source_doc_id, None, vec![occurrence(occurrence_source_doc_id, None)]),
      &source_keys,
    ) else {
      panic!("occurrence source without external projection must fail closed");
    };
    assert_identity_invariant(occurrence_error, occurrence_source_doc_id);

    let Err(target_error) = map_edge(edge(source_doc_id, Some(target_doc_id), Vec::new()), &source_keys) else {
      panic!("available target without external projection must fail closed");
    };
    assert_identity_invariant(target_error, target_doc_id);
  }
}
