// SPDX-License-Identifier: AGPL-3.0-or-later
use super::json::DatabaseSnapshotImportBundle;
use crate::database::{
  DatabaseImportExportService, DatabaseResult, DatabaseServiceError, ERR_JSON_INVALID, ERR_JSON_MISSING_FILE,
};
use crate::doc::DocSpaceKind;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
use yrs::{Update, updates::decoder::Decode};

#[derive(Debug, Clone)]
pub(in crate::database) struct PendingSnapshotContentDocument {
  pub(in crate::database) row_id: DatabaseRowId,
  pub(in crate::database) content: DatabaseSnapshotContentDocument,
}

#[derive(Debug, Clone)]
pub(in crate::database) struct PendingSnapshotRowTemplateContent {
  pub(in crate::database) row_template_id: Uuid,
  pub(in crate::database) content: DatabaseSnapshotContentDocument,
}

pub(in crate::database) struct SnapshotContentMaterializationPlan {
  pub(in crate::database) document_ids: HashMap<String, DocId>,
  pub(in crate::database) replacements: HashMap<String, String>,
}

pub(in crate::database) enum SnapshotContentExportOutcome {
  Included(DatabaseSnapshotContentDocument),
  Omitted(String),
}
const SNAPSHOT_DOCUMENT_URI_PREFIX: &str = "myoxus-snapshot-document:";
const SNAPSHOT_ASSET_URI_PREFIX: &str = "myoxus-snapshot-asset:";
fn snapshot_rewrite_client_id(content_document_id: DocId, document_key: &str) -> u64 {
  let mut digest = Sha256::new();
  digest.update(content_document_id.as_bytes());
  digest.update(document_key.as_bytes());
  let digest = digest.finalize();
  let candidate = u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix")) & ((1_u64 << 53) - 1);
  candidate.max(1)
}

pub(in crate::database) fn snapshot_document_uri(document_key: &str) -> String {
  format!(
    "{SNAPSHOT_DOCUMENT_URI_PREFIX}{}",
    url::form_urlencoded::byte_serialize(document_key.as_bytes()).collect::<String>()
  )
}

pub(in crate::database) fn snapshot_asset_uri(asset_key: &str) -> String {
  format!(
    "{SNAPSHOT_ASSET_URI_PREFIX}{}",
    url::form_urlencoded::byte_serialize(asset_key.as_bytes()).collect::<String>()
  )
}
impl DatabaseImportExportService {
  pub(super) async fn plan_snapshot_content_materialization(
    &self,
    workspace_id: WorkspaceId,
    bundle: &DatabaseSnapshotImportBundle,
  ) -> DatabaseResult<SnapshotContentMaterializationPlan> {
    let document_ids = bundle
      .content_documents
      .iter()
      .map(|pending| pending.content.document_key.clone())
      .chain(
        bundle
          .row_template_contents
          .iter()
          .map(|pending| pending.content.document_key.clone()),
      )
      .map(|key| (key, Uuid::new_v4()))
      .collect::<HashMap<_, _>>();
    let mut replacements = document_ids
      .iter()
      .map(|(key, document_id)| (snapshot_document_uri(key), document_id.to_string()))
      .collect::<HashMap<_, _>>();
    let asset_keys = bundle
      .content_documents
      .iter()
      .flat_map(|pending| pending.content.asset_keys.iter().cloned())
      .chain(
        bundle
          .row_template_contents
          .iter()
          .flat_map(|pending| pending.content.asset_keys.iter().cloned()),
      )
      .collect::<HashSet<_>>();
    if !asset_keys.is_empty() {
      let blob_service =
        self.blob_service.as_ref().cloned().ok_or_else(|| {
          DatabaseServiceError::new(ERR_JSON_MISSING_FILE, "workspace blob service is not configured")
        })?;
      for asset_key in asset_keys {
        let metadata = blob_service
          .get_blob_metadata(workspace_id, &asset_key)
          .await
          .map_err(|error| DatabaseServiceError::new(ERR_JSON_MISSING_FILE, error.to_string()))?
          .filter(|metadata| metadata.deleted_at.is_none())
          .ok_or_else(|| {
            DatabaseServiceError::new(
              ERR_JSON_MISSING_FILE,
              format!("snapshot content asset '{asset_key}' is unavailable in the target workspace"),
            )
          })?;
        replacements.insert(snapshot_asset_uri(&asset_key), metadata.key);
      }
    }
    Ok(SnapshotContentMaterializationPlan {
      document_ids,
      replacements,
    })
  }

  /// Materialize every explicit portable Row body before the Database
  /// transaction. All ids are preallocated so cross-document links can be
  /// rewritten in one deterministic pass. A later Database failure compensates
  /// every created document before returning the original error.
  pub(super) async fn materialize_snapshot_content_documents(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    bundle: &mut DatabaseSnapshotImportBundle,
    plan: &SnapshotContentMaterializationPlan,
  ) -> DatabaseResult<Vec<DocId>> {
    if bundle.content_documents.is_empty() {
      return Ok(Vec::new());
    }
    let mut prepared = Vec::with_capacity(bundle.content_documents.len());
    for pending in bundle.content_documents.clone() {
      let document_id = *plan
        .document_ids
        .get(&pending.content.document_key)
        .expect("validated snapshot content keys are preallocated");
      let update = STANDARD
        .decode(pending.content.yjs_update_base64.as_bytes())
        .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
      let rewritten = yjs::rewrite_snapshot_resource_uris(&update, &plan.replacements)
        .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error))?;
      prepared.push((pending, document_id, rewritten));
    }

    let mut created = Vec::with_capacity(prepared.len());
    for (pending, document_id, rewritten) in prepared {
      if let Err(error) = self
        .doc_service
        .create_doc(
          workspace_id,
          document_id,
          crate::database::editing::rules::clean_title(Some(pending.content.title.clone())),
          false,
          actor,
        )
        .await
      {
        self.compensate_snapshot_content_documents(workspace_id, &created).await;
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          format!("failed to create imported content document: {error}"),
        ));
      }
      created.push(document_id);
      if let Err(error) = self
        .doc_service
        .push_update_raw(workspace_id, document_id, rewritten, DocSpaceKind::Workspace)
        .await
      {
        self.compensate_snapshot_content_documents(workspace_id, &created).await;
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          format!("failed to persist imported content document: {error}"),
        ));
      }
      let row = bundle
        .rows
        .iter_mut()
        .chain(bundle.updated_rows.iter_mut())
        .find(|row| row.row.id == pending.row_id)
        .expect("pending snapshot content targets an imported Row");
      row.row.content_document_id = Some(document_id);
    }
    Ok(created)
  }

  pub(super) async fn materialize_snapshot_row_templates(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    bundle: &mut DatabaseSnapshotImportBundle,
    plan: &SnapshotContentMaterializationPlan,
  ) -> DatabaseResult<Vec<crate::template_registry::PortableDatabaseRowTemplate>> {
    if bundle.row_template_contents.is_empty() {
      return Ok(Vec::new());
    }
    let registry = self
      .template_registry
      .as_ref()
      .cloned()
      .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "Template Registry is not configured"))?;
    let mut prepared = Vec::with_capacity(bundle.row_template_contents.len());
    for pending in bundle.row_template_contents.clone() {
      let workspace_doc_id = *plan
        .document_ids
        .get(&pending.content.document_key)
        .expect("validated template content key is preallocated");
      let update = STANDARD
        .decode(pending.content.yjs_update_base64.as_bytes())
        .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
      let rewritten = yjs::rewrite_snapshot_resource_uris(&update, &plan.replacements)
        .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error))?;
      prepared.push((pending, workspace_doc_id, rewritten));
    }
    let mut created = Vec::new();
    for (pending, workspace_doc_id, rewritten) in prepared {
      let materialized = match registry
        .create_portable_database_row_template(workspace_id, workspace_doc_id, &pending.content.title, rewritten, actor)
        .await
      {
        Ok(materialized) => materialized,
        Err(error) => {
          self.compensate_snapshot_row_templates(workspace_id, &created).await;
          return Err(DatabaseServiceError::new(
            ERR_JSON_INVALID,
            format!("failed to import Row template content: {error}"),
          ));
        }
      };
      let Some(row_template) = bundle
        .row_templates
        .iter_mut()
        .find(|template| template.id == pending.row_template_id)
      else {
        registry
          .compensate_portable_database_row_template(workspace_id, &materialized)
          .await;
        self.compensate_snapshot_row_templates(workspace_id, &created).await;
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          "imported Row template is missing",
        ));
      };
      row_template.template_id = materialized.template_id;
      created.push(materialized);
    }
    Ok(created)
  }

  pub(super) async fn compensate_snapshot_row_templates(
    &self,
    workspace_id: WorkspaceId,
    templates: &[crate::template_registry::PortableDatabaseRowTemplate],
  ) {
    let registry = self.template_registry.as_ref().cloned();
    if let Some(registry) = registry {
      for template in templates.iter().rev() {
        registry
          .compensate_portable_database_row_template(workspace_id, template)
          .await;
      }
    }
  }

  pub(super) async fn compensate_snapshot_content_documents(&self, workspace_id: WorkspaceId, document_ids: &[DocId]) {
    for document_id in document_ids.iter().rev() {
      if let Err(error) = self.doc_service.delete_doc(workspace_id, *document_id).await {
        tracing::error!(
          workspace_id = %workspace_id,
          content_document_id = %document_id,
          error = %error,
          "failed to compensate imported Row content document"
        );
      }
    }
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "snapshot export keeps all provenance and asset boundaries explicit"
  )]
  pub(super) async fn export_snapshot_content_document(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content_document_id: DocId,
    document_key: String,
    fallback_title: &str,
    reverse_replacements: &HashMap<String, String>,
    asset_local_ids: &HashMap<String, String>,
    transfer: bool,
  ) -> DatabaseResult<SnapshotContentExportOutcome> {
    let Some(projection) = self
      .rows
      .resolve_content_document(actor, workspace_id, Some(content_document_id))
      .await?
    else {
      if transfer {
        return Err(DatabaseServiceError::new(
          myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::SourceDocumentMissing.as_str(),
          "owned content document is missing",
        ));
      }
      return Ok(SnapshotContentExportOutcome::Omitted("state Missing".to_string()));
    };
    if projection.state != DatabaseRowContentDocumentState::Available {
      if transfer {
        let code = if projection.state == DatabaseRowContentDocumentState::Missing {
          myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::SourceDocumentMissing.as_str()
        } else {
          crate::database::ERR_FORBIDDEN
        };
        return Err(DatabaseServiceError::new(code, "owned content document is unavailable"));
      }
      return Ok(SnapshotContentExportOutcome::Omitted(format!(
        "state {:?}",
        projection.state
      )));
    }
    let update = self
      .doc_service
      .load_full_doc(workspace_id, content_document_id)
      .await
      .map_err(|error| {
        DatabaseServiceError::new(
          ERR_JSON_INVALID,
          format!("failed to export optional Row content document: {error}"),
        )
      })?;
    if update.len() > self.limits.notion_max_bytes {
      return Ok(SnapshotContentExportOutcome::Omitted(format!(
        "size {} exceeds the document limit {}",
        update.len(),
        self.limits.notion_max_bytes
      )));
    }
    if transfer {
      let asset_keys = yjs::extract_portable_asset_references(&update)
        .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error))?
        .into_iter()
        .map(|asset| asset.source_key)
        .collect();
      return Ok(SnapshotContentExportOutcome::Included(
        DatabaseSnapshotContentDocument {
          document_key,
          title: projection.title.unwrap_or_else(|| fallback_title.to_string()),
          yjs_update_base64: STANDARD.encode(update),
          asset_keys,
        },
      ));
    }
    let references = yjs::extract_document_references_from_yjs(&update)
      .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error))?;
    let resource_values =
      yjs::collect_yjs_resource_values(&update).map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error))?;
    let mut replacements = reverse_replacements.clone();
    for reference in references.occurrences {
      replacements
        .entry(reference.raw_target_doc_id.clone())
        .or_insert_with(|| snapshot_document_uri(&Self::opaque_snapshot_reference_key(&reference.raw_target_doc_id)));
    }
    let portable_update = yjs::rewrite_resource_values_deterministic(
      &update,
      &replacements,
      snapshot_rewrite_client_id(content_document_id, &document_key),
    )
    .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error))?;
    let mut asset_keys = asset_local_ids
      .iter()
      .filter(|(live_key, _)| resource_values.contains(*live_key))
      .map(|(_, local_key)| local_key.clone())
      .collect::<Vec<_>>();
    asset_keys.sort();
    Ok(SnapshotContentExportOutcome::Included(
      DatabaseSnapshotContentDocument {
        document_key,
        title: projection.title.unwrap_or_else(|| fallback_title.to_string()),
        yjs_update_base64: STANDARD.encode(portable_update),
        asset_keys,
      },
    ))
  }

  /// Validate the portable content envelope without touching document or blob
  /// storage. Apply consumes exactly the bytes proven safe by this pass.
  pub(super) fn validate_snapshot_content_documents(
    &self,
    snapshot: &DatabaseSnapshot,
    errors: &mut Vec<DatabaseJsonDiagnostic>,
  ) {
    let manifest_keys = snapshot
      .files_manifest
      .iter()
      .map(|entry| entry.blob_key.as_str())
      .collect::<HashSet<_>>();
    let documents = snapshot
      .database
      .rows
      .iter()
      .enumerate()
      .filter_map(|(index, row)| {
        row
          .content_document
          .as_ref()
          .map(|document| (format!("$.database.rows[{index}].contentDocument"), document))
      })
      .chain(
        snapshot
          .database
          .row_templates
          .iter()
          .enumerate()
          .filter_map(|(index, template)| {
            template
              .content_document
              .as_ref()
              .map(|document| (format!("$.database.rowTemplates[{index}].contentDocument"), document))
          }),
      )
      .collect::<Vec<_>>();
    Self::validate_snapshot_content_document_entries(&documents, &manifest_keys, self.limits.notion_max_bytes, errors);
  }

  /// Validate the shared Row/Row-template content envelope. Keeping this
  /// function free of repositories and services makes the Preview no-write
  /// boundary explicit and lets tests exercise every rejection causally.
  pub(in crate::database) fn validate_snapshot_content_document_entries(
    documents: &[(String, &DatabaseSnapshotContentDocument)],
    manifest_keys: &HashSet<&str>,
    max_content_bytes: usize,
    errors: &mut Vec<DatabaseJsonDiagnostic>,
  ) {
    let mut document_keys = HashSet::new();
    for (path, document) in documents {
      if document.document_key.trim().is_empty()
        || Uuid::parse_str(document.document_key.trim()).is_ok()
        || !document_keys.insert(document.document_key.as_str())
      {
        errors.push(Self::json_diag(
          ERR_JSON_INVALID,
          format!("{path}.documentKey"),
          "Content document keys must be unique, non-empty snapshot-local identifiers",
        ));
      }
      let mut sorted_assets = document.asset_keys.clone();
      sorted_assets.sort();
      sorted_assets.dedup();
      if sorted_assets != document.asset_keys {
        errors.push(Self::json_diag(
          ERR_JSON_INVALID,
          format!("{path}.assetKeys"),
          "Content document assetKeys must be unique and sorted",
        ));
      }
      for asset_key in &document.asset_keys {
        if !manifest_keys.contains(asset_key.as_str()) {
          errors.push(Self::json_diag(
            ERR_JSON_MISSING_FILE,
            format!("{path}.assetKeys"),
            format!("Content document references asset key '{asset_key}' missing from filesManifest"),
          ));
        }
      }
      match STANDARD.decode(document.yjs_update_base64.as_bytes()) {
        Ok(update) if update.len() <= max_content_bytes && STANDARD.encode(&update) == document.yjs_update_base64 => {
          if let Err(error) = Update::decode_v1(&update) {
            errors.push(Self::json_diag(
              ERR_JSON_INVALID,
              format!("{path}.yjsUpdateBase64"),
              format!("Content document is not a valid Yjs v1 update: {error}"),
            ));
          }
        }
        Ok(_) => errors.push(Self::json_diag(
          ERR_JSON_INVALID,
          format!("{path}.yjsUpdateBase64"),
          "Content document must use padded RFC 4648 Base64 and stay within the document size limit",
        )),
        Err(error) => errors.push(Self::json_diag(
          ERR_JSON_INVALID,
          format!("{path}.yjsUpdateBase64"),
          format!("Content document Base64 is invalid: {error}"),
        )),
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use std::collections::BTreeMap;

  fn portable_content(document_key: &str, update: Vec<u8>, asset_keys: Vec<&str>) -> DatabaseSnapshotContentDocument {
    DatabaseSnapshotContentDocument {
      document_key: document_key.to_string(),
      title: "Portable body".to_string(),
      yjs_update_base64: STANDARD.encode(update),
      asset_keys: asset_keys.into_iter().map(str::to_string).collect(),
    }
  }

  #[test]
  fn notion_body_asset_rewrite_updates_yjs_and_manifest_key_together() {
    let mut builder = yjs::YjsDocumentBuilder::new("Imported Page");
    builder.push_image(&snapshot_asset_uri("assets/source.png"), "Diagram");
    let content = portable_content("row-content-0", builder.encode(), vec!["assets/source.png"]);
    let database = DatabaseSnapshotDatabase {
      managed_template: None,
      id: "database-0".to_string(),
      profile_kind: DatabaseProfileKind::Generic,
      profile_structure_preset: None,
      profile_config: serde_json::json!({}),
      title: "Imported".to_string(),
      description: None,
      fields: Vec::new(),
      views: Vec::new(),
      field_roles: Vec::new(),
      view_roles: Vec::new(),
      rows: vec![DatabaseSnapshotRow {
        id: "row-0".to_string(),
        title: "Imported Page".to_string(),
        position: 0,
        content_document: Some(content),
        row_kind: DatabaseRowKind::Record,
        source: None,
        cells: Vec::new(),
        projections: Vec::new(),
      }],
      row_templates: Vec::new(),
    };
    let mut snapshot = DatabaseSnapshot {
      schema_version: DATABASE_SNAPSHOT_SCHEMA_VERSION,
      exported_at: Utc::now(),
      source: DatabaseSnapshotSource {
        product: "notion".to_string(),
        format: "notion-html".to_string(),
        database_id: None,
        exported_by: None,
      },
      database,
      databases: Vec::new(),
      files_manifest: Vec::new(),
      workspace_tags_manifest: Vec::new(),
      diagnostics: Vec::new(),
    };

    DatabaseImportExportService::rewrite_notion_content_asset_keys(
      &mut snapshot,
      &BTreeMap::from([("assets/source.png".to_string(), "notion/imported.png".to_string())]),
    )
    .expect("Notion body assets rewrite through the existing materialization map");

    let content = snapshot.database.rows[0]
      .content_document
      .as_ref()
      .expect("portable Row content");
    assert_eq!(content.asset_keys, vec!["notion/imported.png"]);
    let update = STANDARD
      .decode(content.yjs_update_base64.as_bytes())
      .expect("rewritten Yjs update");
    let resources = yjs::collect_yjs_resource_values(&update).expect("rewritten resource inventory");
    assert!(resources.contains(&snapshot_asset_uri("notion/imported.png")));
    assert!(!resources.contains(&snapshot_asset_uri("assets/source.png")));
  }

  #[test]
  fn json_snapshot_content_validation_accepts_one_shared_portable_contract() {
    let row = portable_content(
      "row-content-0",
      crate::markdown::markdown_to_yjs("Row", "A portable body").expect("Yjs fixture"),
      vec!["asset_0"],
    );
    let template = portable_content(
      "row-template-content-0",
      crate::markdown::markdown_to_yjs("Template", "A template body").expect("Yjs fixture"),
      Vec::new(),
    );
    let documents = vec![
      ("$.database.rows[0].contentDocument".to_string(), &row),
      ("$.database.rowTemplates[0].contentDocument".to_string(), &template),
    ];
    let manifest_keys = HashSet::from(["asset_0"]);
    let mut errors = Vec::new();

    DatabaseImportExportService::validate_snapshot_content_document_entries(
      &documents,
      &manifest_keys,
      1024 * 1024,
      &mut errors,
    );

    assert!(errors.is_empty(), "valid portable content must pass: {errors:#?}");
  }

  #[test]
  fn json_snapshot_content_validation_rejects_ambiguous_or_unportable_content() {
    let duplicate = portable_content(
      "duplicate-key",
      crate::markdown::markdown_to_yjs("First", "Body").expect("Yjs fixture"),
      vec!["asset_0"],
    );
    let mut repeated = duplicate.clone();
    repeated.asset_keys = vec!["asset_1".to_string(), "asset_0".to_string()];
    let uuid_key = portable_content(
      &Uuid::new_v4().to_string(),
      b"not a Yjs update".to_vec(),
      vec!["missing_asset"],
    );
    let mut noncanonical_base64 = portable_content("unpadded", vec![0, 0], Vec::new());
    noncanonical_base64.yjs_update_base64 = noncanonical_base64.yjs_update_base64.trim_end_matches('=').to_string();
    let documents = vec![
      ("$.database.rows[0].contentDocument".to_string(), &duplicate),
      ("$.database.rows[1].contentDocument".to_string(), &repeated),
      ("$.database.rowTemplates[0].contentDocument".to_string(), &uuid_key),
      (
        "$.database.rowTemplates[1].contentDocument".to_string(),
        &noncanonical_base64,
      ),
    ];
    let manifest_keys = HashSet::from(["asset_0", "asset_1"]);
    let mut errors = Vec::new();

    DatabaseImportExportService::validate_snapshot_content_document_entries(
      &documents,
      &manifest_keys,
      1024 * 1024,
      &mut errors,
    );

    assert!(
      errors
        .iter()
        .any(|error| { error.path.as_deref() == Some("$.database.rows[1].contentDocument.documentKey") }),
      "duplicate document keys must fail: {errors:#?}"
    );
    assert!(
      errors
        .iter()
        .any(|error| error.path.as_deref() == Some("$.database.rows[1].contentDocument.assetKeys")),
      "asset keys must be sorted and unique: {errors:#?}"
    );
    assert!(
      errors
        .iter()
        .any(|error| { error.path.as_deref() == Some("$.database.rowTemplates[0].contentDocument.documentKey") }),
      "live UUID-shaped document keys must fail: {errors:#?}"
    );
    assert!(
      errors.iter().any(|error| error.code == ERR_JSON_MISSING_FILE),
      "manifest misses must fail: {errors:#?}"
    );
    assert!(
      errors
        .iter()
        .any(|error| { error.path.as_deref() == Some("$.database.rowTemplates[0].contentDocument.yjsUpdateBase64") }),
      "invalid Yjs must fail: {errors:#?}"
    );
    assert!(
      errors
        .iter()
        .any(|error| { error.path.as_deref() == Some("$.database.rowTemplates[1].contentDocument.yjsUpdateBase64") }),
      "unpadded Base64 must fail: {errors:#?}"
    );
  }
}
