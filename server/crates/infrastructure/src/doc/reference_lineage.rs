// SPDX-License-Identifier: AGPL-3.0-or-later
//! Projection of immutable history references through committed transfer lineage.
//!
//! Every occurrence remains bound to its original snapshot. Parent operation
//! IDs prove causal composition without replaying shifted rich-text offsets or
//! using workspace ownership/timestamps as historical provenance.

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::doc::history::DocHistoryReferenceLineage;
use myoxus_application::workspace_content_operation::copy::{
  apply_native_reference_plan, native_document_reference_targets, prepare_native_reference_plan_with_resolver,
};
use myoxus_application::workspace_content_operation::move_publication::WorkspaceContentMoveRevisionManifest;
use myoxus_application::workspace_content_operation::{
  WorkspaceContentNativeReferencePlan, WorkspaceContentReferenceDecision as Decision,
};
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentErrorCode, WorkspaceContentIdMapping, WorkspaceContentResourceKind, WorkspaceContentResourceRef,
};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

fn invalid_lineage() -> AuthError {
  AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().into())
}

/// Read and validate the complete causal chain for one exact history row.
/// Only a receipt matching the admitted operation is a committed predecessor.
async fn committed_chain(
  tx: &mut Transaction<'_, Postgres>,
  history_id: i64,
  doc_id: Uuid,
  snapshot: &[u8],
) -> AuthResult<Option<Vec<(Uuid, DocHistoryReferenceLineage)>>> {
  let rows = sqlx::query(
    "SELECT m.operation_id, m.manifest FROM workspace_content_move_revision_manifests m
     JOIN workspace_content_operations o ON o.id=m.operation_id
     WHERE (m.manifest->'history_reference_lineage') @> $1::jsonb
       AND (EXISTS(SELECT 1 FROM workspace_content_move_publications p WHERE p.operation_id=o.id AND p.manifest_hash=o.manifest_hash)
         OR EXISTS(SELECT 1 FROM workspace_content_extract_publications p WHERE p.operation_id=o.id AND p.manifest_hash=o.manifest_hash))",
  ).bind(serde_json::json!([{ "history_id": history_id }]))
    .fetch_all(&mut **tx).await.map_err(super::SqlxDocStore::map_db_err)?;
  let hash = hex::encode(Sha256::digest(snapshot));
  let mut pending = BTreeMap::new();
  for row in rows {
    let operation_id: Uuid = row.get("operation_id");
    let manifest: WorkspaceContentMoveRevisionManifest =
      serde_json::from_value(row.get("manifest")).map_err(|_| invalid_lineage())?;
    let mut matches = manifest
      .history_reference_lineage
      .into_iter()
      .filter(|item| item.history_id == history_id);
    let Some(item) = matches.next() else {
      return Ok(None);
    };
    if matches.next().is_some() || item.doc_id != doc_id || item.plan.snapshot_sha256 != hash {
      return Ok(None);
    }
    if item.plan.validate().is_err() {
      return Ok(None);
    }
    pending.insert(operation_id, item);
  }
  let mut chain: Vec<(Uuid, DocHistoryReferenceLineage)> = Vec::new();
  let mut parent = None;
  while !pending.is_empty() {
    let next = pending
      .iter()
      .filter(|(_, item)| item.previous_operation_id == parent)
      .map(|(id, _)| *id)
      .collect::<Vec<_>>();
    if next.len() != 1 {
      return Ok(None);
    }
    let id = next[0];
    let item = pending.remove(&id).ok_or_else(invalid_lineage)?;
    if let Some((_, prior)) = chain.last() {
      if item.plan.source != prior.plan.source
        || item.plan.occurrences.len() != prior.plan.occurrences.len()
        || item
          .plan
          .occurrences
          .iter()
          .zip(&prior.plan.occurrences)
          .any(|(next, prev)| {
            next.position != prev.position
              || next.expected_id != prev.expected_id
              || next.expected_workspace_id != prev.expected_workspace_id
              || next.resource != prev.resource
              || (matches!(prev.decision, Decision::Omit) && !matches!(next.decision, Decision::Omit))
              || (matches!(prev.decision, Decision::Unavailable) && !matches!(next.decision, Decision::Unavailable))
          })
      {
        return Ok(None);
      }
    }
    parent = Some(id);
    chain.push((id, item));
  }
  Ok(Some(chain))
}

async fn initial_plan(
  tx: &mut Transaction<'_, Postgres>,
  history_id: i64,
  doc_id: Uuid,
  source: &WorkspaceContentResourceRef,
  snapshot: &[u8],
  mappings: &[WorkspaceContentIdMapping],
) -> AuthResult<Option<WorkspaceContentNativeReferencePlan>> {
  // Opaque, undecodable retained history stays retained. Its original decoder
  // still owns the read failure; it must not become a new transfer blocker.
  let inventory_valid = yjs::extract_portable_asset_references(snapshot).is_ok();
  if !inventory_valid {
    return Ok(None);
  }
  match native_document_reference_targets(source, snapshot) {
    Ok(_) => {}
    Err(AuthError::InvalidInput(_)) => return Ok(None),
    Err(error) => return Err(error),
  };
  let origin: Option<Uuid> =
    sqlx::query_scalar("SELECT reference_workspace_id FROM doc_histories WHERE id=$1 AND doc_id=$2")
      .bind(history_id)
      .bind(doc_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(super::SqlxDocStore::map_db_err)?;
  let previously_moved: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM workspace_content_move_revision_manifests m
       WHERE (m.manifest->'documents') @> $1::jsonb
         AND (EXISTS(SELECT 1 FROM workspace_content_move_publications p WHERE p.operation_id=m.operation_id)
           OR EXISTS(SELECT 1 FROM workspace_content_extract_publications p WHERE p.operation_id=m.operation_id)))",
  )
  .bind(serde_json::json!([{ "doc_id": doc_id }]))
  .fetch_one(&mut **tx)
  .await
  .map_err(super::SqlxDocStore::map_db_err)?;
  let proved_origin = origin.or_else(|| (!previously_moved).then_some(source.workspace_id()));
  let plan_source = WorkspaceContentResourceRef::new(
    proved_origin.unwrap_or(source.workspace_id()),
    WorkspaceContentResourceKind::Document,
    source.resource_id(),
  )
  .map_err(|_| invalid_lineage())?;
  let targets = native_document_reference_targets(&plan_source, snapshot)?;
  let mut exists = BTreeMap::new();
  for target in targets {
    let canonical = crate::workspace_content_operation::resolve_document_reference_in_tx(tx, &target).await?;
    exists.insert(target, canonical);
  }
  let mut plan = prepare_native_reference_plan_with_resolver(&plan_source, snapshot, mappings, true, |target| {
    std::future::ready(Ok(exists.get(&target).cloned().flatten()))
  })
  .await?;
  if proved_origin.is_none() {
    for occurrence in &mut plan.occurrences {
      if occurrence.expected_workspace_id.is_none() {
        mark_unavailable(occurrence);
      }
    }
  }
  Ok(Some(plan))
}

fn mark_unavailable(item: &mut myoxus_application::workspace_content_operation::WorkspaceContentReferenceOccurrence) {
  let asset = item
    .resource
    .as_ref()
    .is_some_and(|resource| resource.kind() == WorkspaceContentResourceKind::Blob)
    || matches!(&item.position, yjs::NativeReferencePosition::BlockProperty { property, .. } if property.ends_with("sourceId"))
    || matches!(&item.position, yjs::NativeReferencePosition::TextAttribute { path, .. } if path.last().is_some_and(|key| key=="blobId"));
  item.resource = None;
  item.decision = if asset { Decision::Omit } else { Decision::Unavailable };
}

pub(crate) async fn capture_in_tx(
  tx: &mut Transaction<'_, Postgres>,
  doc_id: Uuid,
  source: &WorkspaceContentResourceRef,
  mappings: &[WorkspaceContentIdMapping],
) -> AuthResult<Vec<DocHistoryReferenceLineage>> {
  let rows = sqlx::query("SELECT id, snapshot FROM doc_histories WHERE doc_id=$1 AND workspace_id=$2 ORDER BY id")
    .bind(doc_id)
    .bind(source.workspace_id())
    .fetch_all(&mut **tx)
    .await
    .map_err(super::SqlxDocStore::map_db_err)?;
  let mut result = Vec::new();
  for row in rows {
    let history_id: i64 = row.get("id");
    let snapshot: Vec<u8> = row.get("snapshot");
    let Some(chain) = committed_chain(tx, history_id, doc_id, &snapshot).await? else {
      continue;
    };
    let (previous_operation_id, mut plan) = if let Some((id, prior)) = chain.last() {
      (Some(*id), prior.plan.clone())
    } else {
      let Some(plan) = initial_plan(tx, history_id, doc_id, source, &snapshot, mappings).await? else {
        continue;
      };
      (None, plan)
    };
    if previous_operation_id.is_some() {
      for occurrence in &mut plan.occurrences {
        let current = match &occurrence.decision {
          Decision::Keep { target } | Decision::Remap { target } => target,
          Decision::Omit | Decision::Unavailable => continue,
        };
        if let Some(mapping) = mappings.iter().find(|mapping| &mapping.source == current) {
          occurrence.decision = Decision::Remap {
            target: mapping.target.clone(),
          };
        }
      }
    }
    result.push(DocHistoryReferenceLineage {
      history_id,
      doc_id,
      previous_operation_id,
      plan,
    });
  }
  Ok(result)
}

pub(crate) async fn project_snapshot_in_tx(
  tx: &mut Transaction<'_, Postgres>,
  history_id: i64,
  doc_id: Uuid,
  workspace_id: Uuid,
  snapshot: &[u8],
) -> AuthResult<Vec<u8>> {
  let Some(chain) = committed_chain(tx, history_id, doc_id, snapshot).await? else {
    let source =
      WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Document, doc_id.to_string())
        .map_err(|_| invalid_lineage())?;
    let targets = match native_document_reference_targets(&source, snapshot) {
      Ok(targets) => targets,
      Err(AuthError::InvalidInput(_)) => return Ok(snapshot.to_vec()),
      Err(error) => return Err(error),
    };
    let mut plan = prepare_native_reference_plan_with_resolver(&source, snapshot, &[], true, |target| {
      std::future::ready(Ok(targets.contains(&target).then_some(target)))
    })
    .await?;
    for item in &mut plan.occurrences {
      mark_unavailable(item);
    }
    return Ok(
      apply_native_reference_plan(snapshot, &plan, history_client_id(history_id, snapshot, &plan)?)?.full_state,
    );
  };
  let plan = if let Some((_, item)) = chain.last() {
    Some(item.plan.clone())
  } else {
    let transferred: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_content_move_revision_manifests m WHERE (m.manifest->'documents') @> $1::jsonb AND (EXISTS(SELECT 1 FROM workspace_content_move_publications p WHERE p.operation_id=m.operation_id) OR EXISTS(SELECT 1 FROM workspace_content_extract_publications p WHERE p.operation_id=m.operation_id)))")
      .bind(serde_json::json!([{ "doc_id": doc_id }])).fetch_one(&mut **tx).await.map_err(super::SqlxDocStore::map_db_err)?;
    let origin: Option<Uuid> =
      sqlx::query_scalar("SELECT reference_workspace_id FROM doc_histories WHERE id=$1 AND doc_id=$2")
        .bind(history_id)
        .bind(doc_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(super::SqlxDocStore::map_db_err)?;
    if !transferred || origin == Some(workspace_id) {
      return Ok(snapshot.to_vec());
    }

    let route: Option<String> = sqlx::query_scalar("SELECT external_id FROM docs WHERE id=$1 AND workspace_id=$2")
      .bind(doc_id)
      .bind(workspace_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(super::SqlxDocStore::map_db_err)?;
    let Some(route) = route else {
      return Ok(snapshot.to_vec());
    };
    let source = WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Document, route)
      .map_err(|_| invalid_lineage())?;
    initial_plan(tx, history_id, doc_id, &source, snapshot, &[]).await?
  };
  let Some(plan) = plan else {
    return Ok(snapshot.to_vec());
  };
  // One projection against original positions; omitted inline atoms cannot
  // shift a later transfer's selectors. Stored snapshots are never rewritten.
  Ok(apply_native_reference_plan(snapshot, &plan, history_client_id(history_id, snapshot, &plan)?)?.full_state)
}

fn history_client_id(history_id: i64, snapshot: &[u8], plan: &WorkspaceContentNativeReferencePlan) -> AuthResult<u64> {
  let mut hash = Sha256::new();
  hash.update(b"myoxus.history.reference-projection");
  hash.update(history_id.to_be_bytes());
  hash.update(snapshot);
  // A restored projection can enter the live Yjs document. Different lineage
  // decisions must not reuse its client/clock range on a later Move or Undo.
  hash.update(serde_json::to_vec(plan).map_err(|_| invalid_lineage())?);
  let digest = hash.finalize();
  Ok((u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix")) & ((1_u64 << 53) - 1)).max(1))
}

pub(crate) fn assets_from_lineage(items: &[DocHistoryReferenceLineage]) -> BTreeSet<WorkspaceContentResourceRef> {
  items
    .iter()
    .flat_map(|item| &item.plan.occurrences)
    .filter_map(|item| match &item.decision {
      Decision::Keep { target } | Decision::Remap { target } if target.kind() == WorkspaceContentResourceKind::Blob => {
        Some(target.clone())
      }
      _ => None,
    })
    .collect()
}
