// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQLx helpers for transactional initial document provenance decisions.
//!
//! This module is intentionally narrow: server-side import paths still own
//! their payload persistence, but they must not create `docs` rows without the
//! same resolver/audit decision used by first cloud sync.

use chrono::Utc;
use sqlx::PgConnection;
use tracing::instrument;
use uuid::Uuid;

use myoxus_application::doc::{
  InitialDocumentProvenance, InitialDocumentProvenanceMode, InitialDocumentProvenanceSource,
  ResolvedInitialDocumentProvenanceMode, resolve_initial_document_provenance,
};

pub struct ImportedWorkspaceDocumentCreate<'a> {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub title: &'a str,
  pub actor_user_id: Uuid,
  pub client_format: &'a str,
  pub provenance: &'a InitialDocumentProvenance,
  pub update_existing_title: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedWorkspaceDocumentCreateResult {
  pub created: bool,
}

/// Shared transaction-lock identity for every workspace document
/// materialization path. Import and sync callers must use the same key before
/// testing row existence, otherwise both can become apparent first writers.
pub(crate) fn workspace_document_first_create_lock_key(workspace_id: Uuid, document_key: &str) -> String {
  format!("doc-first-create:workspace:{workspace_id}:{document_key}")
}

fn resolved_provenance_mode_storage(mode: ResolvedInitialDocumentProvenanceMode) -> &'static str {
  match mode {
    ResolvedInitialDocumentProvenanceMode::ServerObservedFirstSync => "server_observed_first_sync",
    ResolvedInitialDocumentProvenanceMode::OfflineSync => "offline_sync",
    ResolvedInitialDocumentProvenanceMode::ExplicitImport => "explicit_import",
  }
}

fn requested_provenance_mode_storage(mode: InitialDocumentProvenanceMode) -> &'static str {
  match mode {
    InitialDocumentProvenanceMode::OfflineSync => "offline_sync",
    InitialDocumentProvenanceMode::ExplicitImport => "explicit_import",
  }
}

/// Ensure that an imported workspace document has a canonical `docs` row.
///
/// The caller must execute payload writes in the same transaction after this
/// helper returns. Existing documents are not treated as first-create winners;
/// their late provenance is recorded as `ignored_existing_document` only.
///
/// This helper is also used by Git-Sync imports. It creates/updates the
/// relational `docs` head and provenance audit for a normal workspace page;
/// it does not mutate the workspace root document's `meta.pages` hierarchy.
/// Any caller that wants a visible tree placement must do that through the
/// explicit root-meta path, not as a side effect of Git/Markdown materializing
/// a snapshot.
#[instrument(skip(conn, input), fields(workspace_id = %input.workspace_id, doc_id = %input.doc_id, actor_user_id = %input.actor_user_id))]
pub async fn ensure_imported_workspace_document(
  conn: &mut PgConnection,
  input: ImportedWorkspaceDocumentCreate<'_>,
) -> Result<ImportedWorkspaceDocumentCreateResult, sqlx::Error> {
  ensure_imported_workspace_document_at(conn, input, None).await
}

/// The same native writer with a trusted server preparation time, shared by
/// Git's pre-push projection and atomic SQL result. Never use a payload clock.
#[instrument(skip(conn, input), fields(workspace_id = %input.workspace_id, doc_id = %input.doc_id))]
pub async fn ensure_imported_workspace_document_at(
  conn: &mut PgConnection,
  input: ImportedWorkspaceDocumentCreate<'_>,
  received_at_server: Option<chrono::DateTime<Utc>>,
) -> Result<ImportedWorkspaceDocumentCreateResult, sqlx::Error> {
  let document_key = input.doc_id.to_string();
  let lock_key = workspace_document_first_create_lock_key(input.workspace_id, &document_key);
  sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
    .bind(lock_key)
    .execute(&mut *conn)
    .await?;

  let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1)")
    .bind(input.doc_id)
    .fetch_one(&mut *conn)
    .await?;

  if !exists {
    let received_at_server = received_at_server.unwrap_or_else(Utc::now);
    let resolved = resolve_initial_document_provenance(
      input.workspace_id,
      input.doc_id,
      Some(input.actor_user_id),
      InitialDocumentProvenanceSource::TrustedImport,
      Some(input.client_format),
      None,
      Some(input.provenance),
      received_at_server,
    );

    sqlx::query(
      r#"INSERT INTO docs (
           id, workspace_id, title, is_workspace_root,
           created_by, updated_by, created_at, updated_at
         )
         VALUES ($1, $2, $3, false, $4, $5, $6, $7)"#,
    )
    .bind(input.doc_id)
    .bind(input.workspace_id)
    .bind(input.title)
    .bind(resolved.applied_created_by)
    .bind(resolved.applied_updated_by)
    .bind(resolved.applied_created_at)
    .bind(resolved.applied_updated_at)
    .execute(&mut *conn)
    .await?;

    let raw_provenance = serde_json::to_value(input.provenance).unwrap_or(serde_json::Value::Null);
    sqlx::query(
      r#"INSERT INTO document_initial_sync_audit (
           doc_id, workspace_id, actor_user_id, client_instance_id, source_property_doc_revision,
           idempotency_key, provenance_mode, received_at_server, resolution_kind, decision_code,
           raw_provenance, normalized_provenance, applied_created_at, applied_updated_at,
           applied_created_by, applied_updated_by, rejected_fields
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'created',$9,$10,$11,$12,$13,$14,$15,$16)"#,
    )
    .bind(input.doc_id)
    .bind(input.workspace_id)
    .bind(input.actor_user_id)
    .bind(input.provenance.client_instance_id.as_deref())
    .bind(input.provenance.source_property_doc_revision.as_deref())
    .bind(&resolved.idempotency_key)
    .bind(resolved_provenance_mode_storage(resolved.provenance_mode))
    .bind(resolved.received_at_server)
    .bind(&resolved.decision_code)
    .bind(raw_provenance)
    .bind(&resolved.normalized_provenance)
    .bind(resolved.applied_created_at)
    .bind(resolved.applied_updated_at)
    .bind(resolved.applied_created_by)
    .bind(resolved.applied_updated_by)
    .bind(&resolved.rejected_fields)
    .execute(&mut *conn)
    .await?;

    return Ok(ImportedWorkspaceDocumentCreateResult { created: true });
  }

  if input.update_existing_title {
    sqlx::query(
      r#"UPDATE docs
         SET title = $3,
             updated_at = COALESCE($4, now())
         WHERE id = $1 AND workspace_id = $2"#,
    )
    .bind(input.doc_id)
    .bind(input.workspace_id)
    .bind(input.title)
    .bind(received_at_server)
    .execute(&mut *conn)
    .await?;
  }

  let idempotency_key = input
    .provenance
    .idempotency_key
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned)
    .unwrap_or_else(|| myoxus_application::doc::provenance::server_first_sync_key(input.workspace_id, input.doc_id));
  let raw_provenance = serde_json::to_value(input.provenance).unwrap_or(serde_json::Value::Null);
  let normalized_provenance = serde_json::json!({
    "existingDocument": true,
    "docId": input.doc_id,
    "workspaceId": input.workspace_id,
    "clientFormat": input.client_format,
  });

  sqlx::query(
    r#"INSERT INTO document_initial_sync_audit (
         doc_id, workspace_id, actor_user_id, client_instance_id, source_property_doc_revision,
         idempotency_key, provenance_mode, received_at_server, resolution_kind, decision_code,
         raw_provenance, normalized_provenance, rejected_fields
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),'ignored_existing_document','document_already_exists',$8,$9,$10)
       ON CONFLICT (doc_id, idempotency_key) DO NOTHING"#,
  )
  .bind(input.doc_id)
  .bind(input.workspace_id)
  .bind(input.actor_user_id)
  .bind(input.provenance.client_instance_id.as_deref())
  .bind(input.provenance.source_property_doc_revision.as_deref())
  .bind(&idempotency_key)
  .bind(requested_provenance_mode_storage(input.provenance.provenance_mode))
  .bind(raw_provenance)
  .bind(normalized_provenance)
  .bind(serde_json::json!({ "systemFacts": "document_already_exists" }))
  .execute(&mut *conn)
  .await?;

  Ok(ImportedWorkspaceDocumentCreateResult { created: false })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn explicit_import_mode_uses_storage_value() {
    assert_eq!(
      requested_provenance_mode_storage(InitialDocumentProvenanceMode::ExplicitImport),
      "explicit_import"
    );
  }
}
