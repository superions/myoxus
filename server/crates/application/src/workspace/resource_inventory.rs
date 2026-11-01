// SPDX-License-Identifier: AGPL-3.0-or-later
//! Current authorized workspace resources, never an event/history ledger.

use crate::{
  auth::{AuthError, AuthResult},
  doc::DocService,
  organizer::{OrganizerService, OrganizerSnapshotNode},
  permission::PermissionService,
  workspace::WorkspaceService,
  workspace_content_operation::link::WorkspaceContentLinkService,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use myoxus_domain::{entities::Doc, permission::WorkspaceAction};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
  collections::{BTreeMap, HashMap},
  sync::Arc,
};
use uuid::Uuid;

pub const DOCUMENT_CANDIDATE_BATCH: i64 = 200;
pub const DOCUMENT_CANDIDATE_BUDGET: i64 = 4_000;

/// Candidate identity filtering shared by list/search, completion and inventory.
pub async fn readable_live_document_keys(
  doc: &DocService,
  permission: &PermissionService,
  actor: Uuid,
  workspace: Uuid,
  candidates: &[Uuid],
) -> AuthResult<HashMap<Uuid, String>> {
  let readable = permission.readable_doc_ids(actor, workspace, candidates).await?;
  let ids = candidates
    .iter()
    .copied()
    .filter(|id| *id != workspace && readable.contains(id))
    .collect::<Vec<_>>();
  doc.resolve_external_doc_ids(workspace, &ids).await
}

/// Offsets count consumed candidates, not visible rows. Retain the first readable
/// sentinel for the next page; a scan budget is continuation, not workspace size.
/// Callers admit the containing workspace and transport scopes separately; this
/// shared scan owns the current per-document identity/ACL intersection only.
pub async fn readable_document_page(
  doc: &DocService,
  permission: &PermissionService,
  actor: Uuid,
  workspace: Uuid,
  offset: i64,
  limit: usize,
  prefix: &str,
) -> AuthResult<(Vec<Doc>, Option<i64>)> {
  if offset < 0 || !(1..=200).contains(&limit) {
    return Err(AuthError::InvalidInput("Invalid document page".into()));
  }
  let mut items = Vec::new();
  let mut position = offset;
  let mut next = None;
  'scan: while position - offset < DOCUMENT_CANDIDATE_BUDGET {
    let docs = doc
      .list_workspace_docs(workspace, DOCUMENT_CANDIDATE_BATCH, position)
      .await?;
    let ids = docs
      .iter()
      .filter(|row| row.deleted_at.is_none() && !row.is_workspace_root)
      .map(|row| row.id)
      .collect::<Vec<_>>();
    let readable = readable_live_document_keys(doc, permission, actor, workspace, &ids).await?;
    for row in &docs {
      if readable.get(&row.id).is_some_and(|key| key.starts_with(prefix)) {
        if items.len() == limit {
          next = Some(position);
          break 'scan;
        }
        items.push(row.clone());
      }
      position = position
        .checked_add(1)
        .ok_or_else(|| AuthError::InvalidInput("Invalid cursor".into()))?;
    }
    if docs.len() < DOCUMENT_CANDIDATE_BATCH as usize {
      break;
    }
    if position - offset >= DOCUMENT_CANDIDATE_BUDGET {
      next = Some(position);
    }
  }
  Ok((items, next))
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDocument {
  pub external_id: String,
  pub title: String,
  pub content_revision: i64,
  pub metadata_revision: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInventoryPage {
  pub mode: &'static str,
  pub workspace_id: Uuid,
  pub documents: Vec<InventoryDocument>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub next_cursor: Option<String>,
  pub structure: Value,
}

/// Internal comparison state shared by observers of one key/workspace. It has
/// only the authorized projection; no raw root revision or hidden row can alter it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceObservation {
  pub documents: BTreeMap<String, InventoryDocument>,
  pub structure: Value,
}

#[derive(Clone)]
pub struct WorkspaceResourceInventory {
  workspace: WorkspaceService,
  doc: DocService,
  permission: Arc<PermissionService>,
  links: WorkspaceContentLinkService,
}

impl WorkspaceResourceInventory {
  pub fn new(
    workspace: WorkspaceService,
    doc: DocService,
    permission: Arc<PermissionService>,
    links: WorkspaceContentLinkService,
  ) -> Self {
    Self {
      workspace,
      doc,
      permission,
      links,
    }
  }

  /// Each page resolves current membership and ACLs. It is not a frozen snapshot;
  /// reconnect/readback must start again rather than infer historical continuity.
  #[tracing::instrument(skip_all)]
  pub async fn page(
    &self,
    actor: Uuid,
    workspace: Uuid,
    offset: i64,
    limit: usize,
    max_bytes: usize,
  ) -> AuthResult<WorkspaceInventoryPage> {
    self.admit(actor, workspace).await?;
    let (documents, next) = self.document_page(actor, workspace, offset, limit).await?;
    let page = WorkspaceInventoryPage {
      mode: "current_state",
      workspace_id: workspace,
      documents,
      next_cursor: next.map(|position| STANDARD.encode(position.to_string())),
      structure: self.structure(actor, workspace).await?,
    };
    let bytes =
      serde_json::to_vec(&page).map_err(|_| AuthError::Storage("Workspace resource serialization failed".into()))?;
    if bytes.len() > max_bytes {
      return Err(AuthError::InvalidInput("Workspace resource exceeds byte budget".into()));
    }
    Ok(page)
  }

  async fn admit(&self, actor: Uuid, workspace: Uuid) -> AuthResult<()> {
    if !self
      .workspace
      .list_workspaces(actor)
      .await?
      .iter()
      .any(|row| row.id == workspace && row.deleted_at.is_none())
      || !self
        .permission
        .get_effective_workspace_role(actor, workspace)
        .await?
        .is_some_and(|role| role.can(WorkspaceAction::Read))
    {
      return Err(AuthError::ActionForbidden);
    }
    Ok(())
  }

  async fn document_page(
    &self,
    actor: Uuid,
    workspace: Uuid,
    offset: i64,
    limit: usize,
  ) -> AuthResult<(Vec<InventoryDocument>, Option<i64>)> {
    let (docs, next) = readable_document_page(&self.doc, &self.permission, actor, workspace, offset, limit, "").await?;
    // System documents are structure owners, not public content-revision rows.
    // Excluding them prevents hidden root/Organizer edits becoming generic hints.
    let docs = docs
      .into_iter()
      .filter(|doc| !doc.blocked && !doc.external_id.starts_with("db$") && !doc.external_id.starts_with("userdata$"))
      .collect::<Vec<_>>();
    let ids = docs.iter().map(|doc| doc.id).collect::<Vec<_>>();
    let identities = self.doc.preview_source_identities(workspace, &ids).await?;
    let mut documents = docs
      .into_iter()
      .filter_map(|doc| {
        let identity = identities.get(&doc.id)?;
        (!identity.deleted).then(|| InventoryDocument {
          external_id: doc.external_id,
          title: identity.title.clone(),
          content_revision: identity.revision,
          metadata_revision: identity.metadata_revision,
        })
      })
      .collect::<Vec<_>>();
    documents.sort_by(|left, right| left.external_id.cmp(&right.external_id));
    Ok((documents, next))
  }

  /// Reconcile all current pages in metadata batches, loading visible structure
  /// once. This has no total-workspace cap and never materializes content bodies.
  #[tracing::instrument(skip_all)]
  pub async fn observe(&self, actor: Uuid, workspace: Uuid, max_bytes: usize) -> AuthResult<WorkspaceObservation> {
    self.admit(actor, workspace).await?;
    let mut documents = BTreeMap::new();
    let mut offset = Some(0);
    while let Some(position) = offset {
      let (page, next) = self.document_page(actor, workspace, position, 200).await?;
      if serde_json::to_vec(&page)
        .map_err(|_| AuthError::Storage("Inventory comparison failed".into()))?
        .len()
        > max_bytes
      {
        return Err(AuthError::InvalidInput(
          "Workspace document page exceeds byte budget".into(),
        ));
      }
      documents.extend(page.into_iter().map(|row| (row.external_id.clone(), row)));
      offset = next;
    }
    let structure = self.structure(actor, workspace).await?;
    if serde_json::to_vec(&structure)
      .map_err(|_| AuthError::Storage("Structure comparison failed".into()))?
      .len()
      > max_bytes
    {
      return Err(AuthError::InvalidInput(
        "Workspace structure exceeds byte budget".into(),
      ));
    }
    Ok(WorkspaceObservation { documents, structure })
  }

  async fn structure(&self, actor: Uuid, workspace: Uuid) -> AuthResult<Value> {
    let organizer = OrganizerService::new(self.doc.clone());
    for _ in 0..2 {
      let snapshot = organizer
        .snapshot(workspace)
        .await
        .map_err(|_| AuthError::Storage("Organizer unavailable".into()))?;
      let (revision, rows) = self
        .links
        .visible_links(actor, workspace)
        .await
        .map_err(|_| AuthError::Storage("Visible workspace structure unavailable".into()))?;
      if snapshot.revision != revision {
        continue;
      }
      let mut folders = Vec::new();
      let mut stack = snapshot.roots.iter().collect::<Vec<&OrganizerSnapshotNode>>();
      while let Some(node) = stack.pop() {
        if node.row.is_folder() {
          folders
            .push(json!({"id":node.row.id,"name":node.row.data,"parentId":node.row.parent_id,"index":node.row.index}));
          stack.extend(node.children.iter());
        }
      }
      let mut entries = rows
        .into_iter()
        .map(|row| {
          json!({"id":row.id,"parentId":row.parent_id,"targetType":row.row_type,
        "targetKey":row.data,"targetWorkspaceId":row.target_workspace_id,"index":row.index})
        })
        .collect::<Vec<_>>();
      folders.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
      entries.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
      // Never include the global Organizer revision in the public projection.
      return Ok(json!({"folders":folders,"entries":entries}));
    }
    Err(AuthError::Storage(
      "Workspace structure changed during projection; retry read".into(),
    ))
  }
}
