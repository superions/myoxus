// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::auth::{AuthStore, AuthUser, InMemoryAuthStore};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::document_graph::{DocumentGraphLimits, DocumentGraphService};
use myoxus_application::document_metadata::DocumentMetadataService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::{WorkspaceName, WorkspaceStore};
use myoxus_domain::document_graph::{
  DocumentGraphDirection, DocumentGraphEdge, DocumentGraphIndexState, DocumentGraphIndexSummary, DocumentGraphLinkKind,
  DocumentGraphMetadataFilter, DocumentGraphNode, DocumentGraphOccurrence, DocumentGraphPage, DocumentGraphQuery,
  DocumentGraphReindexReason, DocumentGraphStaleState, DocumentGraphTargetState,
};
use myoxus_domain::entities::{
  DocRole, DocumentMetadataAudience, DocumentMetadataFieldValue, DocumentMetadataJournal,
  DocumentMetadataMaterializationSummary, DocumentMetadataPatch, DocumentMetadataPolicy, DocumentMetadataProjection,
  DocumentMetadataSource, DocumentMetadataSystemFacts,
};
use myoxus_domain::repositories::{DocumentGraphRepository, DocumentMetadataRepository, PageRequest, RepoResult};
use uuid::Uuid;

struct CountingGraphRepository {
  workspace_id: Uuid,
  user_id: Uuid,
  auth: Arc<InMemoryAuthStore>,
  revoke_workspace_membership: AtomicBool,
  edges: Vec<DocumentGraphEdge>,
  nodes: HashMap<Uuid, DocumentGraphNode>,
  node_reads: Mutex<HashMap<Uuid, usize>>,
}

#[async_trait]
impl DocumentGraphRepository for CountingGraphRepository {
  async fn replace_doc_occurrences(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _source_updated_at: Option<DateTime<Utc>>,
    _occurrences: Vec<DocumentGraphOccurrence>,
  ) -> RepoResult<()> {
    unreachable!("read test must not write graph occurrences")
  }

  async fn mark_doc_graph_stale(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _reason: DocumentGraphReindexReason,
  ) -> RepoResult<()> {
    unreachable!("read test must not mark graph state")
  }

  async fn mark_doc_graph_queued(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _reason: DocumentGraphReindexReason,
  ) -> RepoResult<()> {
    unreachable!("read test must not mark graph state")
  }

  async fn mark_doc_graph_extracting(&self, _workspace_id: Uuid, _doc_id: Uuid) -> RepoResult<()> {
    unreachable!("read test must not mark graph state")
  }

  async fn mark_doc_graph_failed(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _error_code: &str,
    _error_message: &str,
  ) -> RepoResult<()> {
    unreachable!("read test must not mark graph state")
  }

  async fn mark_doc_graph_deleted(&self, _workspace_id: Uuid, _doc_id: Uuid) -> RepoResult<()> {
    unreachable!("read test must not mark graph state")
  }

  async fn list_doc_occurrences(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _direction: DocumentGraphDirection,
    _page: PageRequest,
  ) -> RepoResult<Vec<DocumentGraphOccurrence>> {
    unreachable!("workspace graph read must not list document occurrences")
  }

  async fn list_workspace_edges(
    &self,
    workspace_id: Uuid,
    _query: DocumentGraphQuery,
  ) -> RepoResult<Vec<DocumentGraphEdge>> {
    assert_eq!(workspace_id, self.workspace_id);
    if self.revoke_workspace_membership.swap(false, Ordering::SeqCst) {
      self
        .auth
        .delete_member(self.workspace_id, self.user_id)
        .await
        .expect("remove workspace role after the request-level guard");
    }
    Ok(self.edges.clone())
  }

  async fn list_edge_occurrences(
    &self,
    _workspace_id: Uuid,
    _source_doc_id: Uuid,
    _target_workspace_id: Option<Uuid>,
    _target_doc_id: Option<Uuid>,
    _raw_target_doc_id: &str,
    _link_kind: DocumentGraphLinkKind,
    _target_state: DocumentGraphTargetState,
    _page: PageRequest,
  ) -> RepoResult<Vec<DocumentGraphOccurrence>> {
    unreachable!("the fixture disables occurrence loading")
  }

  async fn get_index_state(&self, _workspace_id: Uuid, _doc_id: Uuid) -> RepoResult<Option<DocumentGraphIndexState>> {
    unreachable!("workspace graph read must not load one index state")
  }

  async fn get_document_node(&self, workspace_id: Uuid, doc_id: Uuid) -> RepoResult<Option<DocumentGraphNode>> {
    assert_eq!(
      self.nodes.get(&doc_id).map(|node| node.workspace_id),
      Some(workspace_id),
      "target resolved in its actual scope"
    );
    *self
      .node_reads
      .lock()
      .expect("node-read counter lock")
      .entry(doc_id)
      .or_default() += 1;
    Ok(self.nodes.get(&doc_id).cloned())
  }

  async fn get_workspace_index_summary(&self, workspace_id: Uuid) -> RepoResult<DocumentGraphIndexSummary> {
    Ok(DocumentGraphIndexSummary {
      workspace_id,
      current_count: self.nodes.len() as i64,
      stale_count: 0,
      queued_count: 0,
      extracting_count: 0,
      failed_count: 0,
      deleted_count: 0,
      missing_state_count: 0,
    })
  }

  async fn list_reindex_candidates(&self, _workspace_id: Uuid, _limit: i64) -> RepoResult<Vec<Uuid>> {
    unreachable!("read test must not list reindex candidates")
  }

  async fn list_workspaces_with_reindex_candidates(&self, _limit: i64) -> RepoResult<Vec<Uuid>> {
    unreachable!("read test must not list reindex candidates")
  }
}

struct CountingMetadataRepository {
  projections: HashMap<Uuid, DocumentMetadataProjection>,
  projection_reads: Mutex<HashMap<Uuid, usize>>,
}

#[async_trait]
impl DocumentMetadataRepository for CountingMetadataRepository {
  async fn workspace_id_for_document(&self, doc_id: Uuid) -> RepoResult<Option<Uuid>> {
    Ok(self.projections.get(&doc_id).map(|projection| projection.workspace_id))
  }

  async fn get_projection(&self, doc_id: Uuid, _workspace_id: Uuid) -> RepoResult<Option<DocumentMetadataProjection>> {
    Ok(self.projections.get(&doc_id).cloned())
  }

  async fn get_projection_versioned(
    &self,
    doc_id: Uuid,
    _workspace_id: Uuid,
  ) -> RepoResult<Option<(String, DocumentMetadataProjection)>> {
    *self
      .projection_reads
      .lock()
      .expect("projection-read counter lock")
      .entry(doc_id)
      .or_default() += 1;
    Ok(
      self
        .projections
        .get(&doc_id)
        .cloned()
        .map(|projection| ("v1".to_string(), projection)),
    )
  }

  async fn projection_version(&self, doc_id: Uuid, _workspace_id: Uuid) -> RepoResult<Option<String>> {
    Ok(self.projections.contains_key(&doc_id).then(|| "v1".to_string()))
  }

  async fn apply_patch(&self, _doc_id: Uuid, _actor_id: Uuid, _patch: &DocumentMetadataPatch) -> RepoResult<()> {
    unreachable!("read test must not mutate metadata")
  }

  async fn rematerialize_workspace_defaults(
    &self,
    _workspace_id: Uuid,
    _actor_id: Option<Uuid>,
  ) -> RepoResult<DocumentMetadataMaterializationSummary> {
    unreachable!("read test must not materialize metadata")
  }

  async fn mark_current_version(
    &self,
    _doc_id: Uuid,
    _version_id: Uuid,
    _versioned_at: DateTime<Utc>,
    _actor_id: Uuid,
  ) -> RepoResult<()> {
    unreachable!("read test must not mutate metadata")
  }

  async fn transition_status(&self, _doc_id: Uuid, _status_id: Uuid, _actor_id: Uuid) -> RepoResult<()> {
    unreachable!("read test must not mutate metadata")
  }
}

fn node(workspace_id: Uuid, doc_id: Uuid) -> DocumentGraphNode {
  DocumentGraphNode {
    workspace_id,
    doc_id: Some(doc_id),
    raw_doc_id: doc_id.to_string(),
    title: Some(format!("Document {doc_id}")),
    document_type: None,
    status: None,
    classification: None,
    deleted: false,
    redacted: false,
  }
}

fn edge(workspace_id: Uuid, source_doc_id: Uuid, target_doc_id: Uuid) -> DocumentGraphEdge {
  DocumentGraphEdge {
    target_workspace_id: Some(workspace_id),
    source_doc_id,
    target_doc_id: Some(target_doc_id),
    raw_target_doc_id: target_doc_id.to_string(),
    target_state: DocumentGraphTargetState::Available,
    link_kind: DocumentGraphLinkKind::InlineReference,
    occurrence_count: 1,
    first_occurrence_preview: Some("private preview".to_string()),
    stale_state: DocumentGraphStaleState::Current,
    occurrences: Vec::new(),
  }
}

fn projection(doc_id: Uuid, workspace_id: Uuid, status: Option<&str>) -> DocumentMetadataProjection {
  let now = Utc::now();
  DocumentMetadataProjection {
    doc_id,
    workspace_id,
    projection_version: "v1".to_string(),
    metadata_revision: 1,
    metadata_updated_at: None,
    metadata_updated_by: None,
    system: DocumentMetadataSystemFacts {
      created_at: now,
      updated_at: now,
      created_by: None,
      updated_by: None,
      metadata_updated_at: None,
      metadata_updated_by: None,
    },
    fields: status
      .map(|status| DocumentMetadataFieldValue {
        key: "status".to_string(),
        source: DocumentMetadataSource::Document,
        reference: None,
        text_value: Some(status.to_string()),
        timestamp_value: None,
        date_value: None,
        user_id: None,
      })
      .into_iter()
      .collect(),
    audience: Vec::<DocumentMetadataAudience>::new(),
    template: None,
    journal: DocumentMetadataJournal { journal_date: None },
    presentation: None,
    integration: None,
    policy: DocumentMetadataPolicy::default(),
  }
}

#[tokio::test]
async fn graph_read_materializes_distinct_nodes_once_and_keeps_target_redaction() {
  let user_id = Uuid::new_v4();
  let auth = Arc::new(InMemoryAuthStore::default());
  auth.insert_user(AuthUser {
    id: user_id,
    email: "graph-reader@example.invalid".to_string(),
    name: Some("Graph reader".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });
  let workspace = auth
    .create_workspace(user_id, WorkspaceName::parse("Graph fixture").expect("workspace name"))
    .await
    .expect("create in-memory workspace");

  let sources = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
  let foreign_workspace = Uuid::new_v4();
  let foreign_target = Uuid::new_v4();
  let foreign_denied = Uuid::new_v4();
  let shared_target = Uuid::new_v4();
  let denied_target = Uuid::new_v4();
  for doc_id in sources.into_iter().chain([shared_target]) {
    auth.set_doc_role(user_id, doc_id, DocRole::Reader);
  }

  auth.set_doc_role(user_id, foreign_target, DocRole::Reader);
  let readable_doc_ids = sources
    .into_iter()
    .chain([shared_target, foreign_target])
    .collect::<Vec<_>>();
  let mut nodes = readable_doc_ids
    .iter()
    .copied()
    .chain([denied_target])
    .map(|doc_id| (doc_id, node(workspace.id, doc_id)))
    .collect::<HashMap<_, _>>();
  nodes.get_mut(&shared_target).unwrap().raw_doc_id = "same-local-key".into();
  let mut foreign_node = node(foreign_workspace, foreign_target);
  foreign_node.raw_doc_id = "same-local-key".into();
  nodes.insert(foreign_target, foreign_node);
  nodes.insert(foreign_denied, node(foreign_workspace, foreign_denied));
  let mut foreign_edge = edge(workspace.id, sources[0], foreign_target);
  foreign_edge.target_workspace_id = Some(foreign_workspace);
  foreign_edge.raw_target_doc_id = "same-local-key".into();
  let mut denied_foreign_edge = edge(workspace.id, sources[3], foreign_denied);
  denied_foreign_edge.target_workspace_id = Some(foreign_workspace);
  let mut edges = vec![
    edge(workspace.id, sources[0], shared_target),
    edge(workspace.id, sources[1], shared_target),
    edge(workspace.id, sources[2], shared_target),
    edge(workspace.id, sources[3], denied_target),
  ];
  for edge in &mut edges {
    if edge.target_doc_id == Some(shared_target) {
      edge.raw_target_doc_id = "same-local-key".into();
    }
  }
  edges.extend([foreign_edge, denied_foreign_edge]);
  let graph_repo = Arc::new(CountingGraphRepository {
    workspace_id: workspace.id,
    user_id,
    auth: auth.clone(),
    revoke_workspace_membership: AtomicBool::new(true),
    edges,
    nodes,
    node_reads: Mutex::new(HashMap::new()),
  });
  let projections = readable_doc_ids
    .iter()
    .copied()
    .map(|doc_id| {
      let status = (doc_id == shared_target || doc_id == foreign_target || doc_id == sources[3]).then_some("keep");
      (
        doc_id,
        projection(
          doc_id,
          if doc_id == foreign_target {
            foreign_workspace
          } else {
            workspace.id
          },
          status,
        ),
      )
    })
    .collect();
  let metadata_repo = Arc::new(CountingMetadataRepository {
    projections,
    projection_reads: Mutex::new(HashMap::new()),
  });
  let service = DocumentGraphService::new(
    graph_repo.clone(),
    Arc::new(DocService::new(Arc::new(PanicDocStore))),
    Arc::new(PermissionService::new(auth.clone() as Arc<dyn AuthStore>)),
    Arc::new(DocumentMetadataService::new(metadata_repo.clone())),
    None,
    None,
    None,
    DocumentGraphLimits::default(),
  );

  let result = service
    .read_workspace_graph(
      user_id,
      workspace.id,
      DocumentGraphQuery {
        focus_doc_id: None,
        direction: DocumentGraphDirection::Both,
        page: DocumentGraphPage { first: 20, offset: 0 },
        metadata_filter: Some(DocumentGraphMetadataFilter {
          statuses: vec!["keep".to_string()],
          ..Default::default()
        }),
        include_occurrences: false,
      },
    )
    .await
    .expect("assemble permission-aware graph");

  assert_eq!(result.edges.len(), 6);
  let same_keys = result
    .nodes
    .iter()
    .filter(|node| node.raw_doc_id == "same-local-key")
    .collect::<Vec<_>>();
  assert_eq!(
    same_keys.len(),
    2,
    "same local keys in different workspaces never collapse"
  );
  assert!(
    same_keys
      .iter()
      .any(|node| node.workspace_id == foreign_workspace && node.doc_id == Some(foreign_target))
  );
  let denied_foreign = result
    .edges
    .iter()
    .find(|edge| edge.raw_target_doc_id == foreign_denied.to_string())
    .unwrap();
  assert_eq!(denied_foreign.target_state, DocumentGraphTargetState::Redacted);
  assert_eq!(denied_foreign.target_doc_id, None);
  let redacted = result
    .edges
    .iter()
    .find(|edge| edge.raw_target_doc_id == denied_target.to_string())
    .expect("redacted target edge remains visible through its matching source");
  assert_eq!(redacted.target_state, DocumentGraphTargetState::Redacted);
  assert_eq!(redacted.target_doc_id, None);
  assert_eq!(redacted.first_occurrence_preview, None);
  assert!(redacted.occurrences.is_empty());

  let node_reads = graph_repo.node_reads.lock().expect("node-read counter lock");
  let projection_reads = metadata_repo
    .projection_reads
    .lock()
    .expect("projection-read counter lock");
  for doc_id in readable_doc_ids {
    assert_eq!(node_reads.get(&doc_id), Some(&1), "node {doc_id} was reloaded");
    assert_eq!(
      projection_reads.get(&doc_id),
      Some(&1),
      "metadata projection {doc_id} was reloaded"
    );
  }
  assert_eq!(node_reads.get(&foreign_denied), None);
  assert_eq!(projection_reads.get(&foreign_denied), None);
  assert_eq!(node_reads.get(&denied_target), None);
  assert_eq!(projection_reads.get(&denied_target), None);
}
