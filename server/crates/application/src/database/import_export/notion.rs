// SPDX-License-Identifier: AGPL-3.0-or-later
use super::content::*;
use crate::database::access;
use crate::database::{
  DatabaseImportExportService, DatabaseResult, DatabaseServiceError, ERR_JSON_INVALID, ERR_JSON_MISSING_FILE,
  ERR_NOTION_BODY_APPLY_FAILED, ERR_NOTION_HTML_INVALID,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::PageRequest;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

/// Internal helper that pairs a parsed Notion result with the
/// original archive name so the snapshot adapter can write a stable
/// `source.label` into the resulting `DatabaseSnapshot`.
struct NotionPayload {
  parse: super::notion_import::NotionParseResult,
  zip_name: Option<String>,
}
/// P-DB-29R: outcome of resolving a single Notion People identity
/// against the active workspace membership list.
#[derive(Debug, Clone, PartialEq, Eq)]
enum NotionPeopleResolution {
  /// A single workspace member matches the identity. The wrapped id
  /// is used as the cell value.
  Matched(UserId),
  /// More than one workspace member matches; the operator must pick
  /// one manually before the cell can be filled.
  Ambiguous,
  /// No workspace member matches; the cell stays empty.
  Unmatched,
}
impl DatabaseImportExportService {
  /// P-DB-32: Notion-oriented export. The snapshot is projected
  /// through the neutral `notion_import` module so the same code
  /// path that renders the import preview is also used for the
  /// export. Returns one HTML page per database inside the
  /// snapshot plus the union of diagnostics produced by the
  /// projection step. CLI / MCP / GraphQL all consume this method
  /// directly so the Notion contract stays server-owned and never
  /// forks between adapters.
  pub async fn export_notion(
    &self,
    actor: UserId,
    database_id: DatabaseId,
  ) -> DatabaseResult<super::notion_import::NotionHtmlExport> {
    let snapshot = self.export_snapshot(actor, database_id).await?;
    Ok(super::notion_import::export_snapshot_as_notion_html(&snapshot))
  }

  /// P-DB-29: Notion HTML / ZIP preview. The Notion payload is parsed
  /// by the neutral `notion_import` module into a
  /// [`DatabaseSnapshot`], then re-serialised so the existing JSON
  /// import code path can preview it. Diagnostics from the parser
  /// and the snapshot adapter are merged into the preview payload so
  /// the Web UI can surface them in the same panel that renders CSV
  /// and JSON import diagnostics.
  pub async fn preview_notion_import(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content: &[u8],
  ) -> DatabaseResult<DatabaseJsonPreview> {
    let notion_result = self.parse_notion_payload(content)?;
    let source_zip_name = notion_result.zip_name.as_deref();
    let notion_built = super::notion_import::build_snapshot_from_notion(&notion_result.parse, source_zip_name);
    let serialised = serde_json::to_vec(&notion_built.snapshot)
      .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
    let mut preview = self
      .preview_json_import_with_options(actor, workspace_id, &serialised, DatabaseJsonImportOptions::default())
      .await?;
    // Merge the Notion-specific diagnostics so the Web UI can show
    // the `MIX_DATABASE_NOTION_*` codes alongside the JSON preview
    // warnings.
    preview
      .warnings
      .extend(Self::notion_diagnostics_to_json(&notion_built.diagnostics));
    preview.matched_page_count = notion_built.matched_page_count;
    preview.content_document_count = notion_built.content_document_count;
    preview.empty_page_count = notion_built.empty_page_count;
    preview.body_block_count = notion_built.body_block_count;
    preview.rewritten_internal_link_count = notion_built.rewritten_internal_link_count;
    Ok(preview)
  }

  /// P-DB-29: Notion HTML / ZIP apply. Mirrors `preview_notion_import`
  /// but routes through `import_json_with_options` so the import
  /// mode, conflict strategy, dry-run flag and target Database id
  /// all keep working. Asset materialisation runs before the JSON
  /// import and any uploaded blob keys are soft-deleted if the
  /// surrounding transaction cannot commit (the JSON half is
  /// automatically rolled back by the native import writer's
  /// atomic transaction).
  pub async fn import_notion(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content: &[u8],
    options: DatabaseJsonImportOptions,
  ) -> DatabaseResult<DatabaseJsonImportResult> {
    let notion_result = self.parse_notion_payload(content)?;
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    // Resolve membership after authorization and before uploading assets or committing the native snapshot;
    // storage failure cannot turn an imported People column into an empty match set.
    let accepted_members = if notion_result.parse.databases.is_empty() {
      Vec::new()
    } else {
      self
        .workspace_store
        .accepted_members_for_lookup(workspace_id)
        .await
        .map_err(crate::database::workspace_lookup_error)?
    };
    let source_zip_name = notion_result.zip_name.as_deref();
    let notion_built = super::notion_import::build_snapshot_from_notion(&notion_result.parse, source_zip_name);
    // P-DB-29R: asset materialisation is wired in
    // `materialize_notion_assets` below; the JSON apply step uses the
    // returned `uploaded_blob_keys` list to soft-delete every uploaded
    // blob when the JSON half fails after the upload ran.
    let mut asset_diagnostics: Vec<super::notion_import::NotionDiagnostic> = Vec::new();
    let mut uploaded_blob_keys: Vec<String> = Vec::new();
    let mut snapshot = notion_built.snapshot;
    if !notion_result.parse.assets.is_empty() {
      let materialisation = self
        .materialize_notion_assets(actor, workspace_id, &notion_result.parse, &snapshot)
        .await;
      asset_diagnostics.extend(materialisation.diagnostics);
      uploaded_blob_keys.extend(materialisation.uploaded_blob_keys.iter().cloned());
      // Rewrite the snapshot manifest entries so the JSON import
      // references the new workspace keys. The `files_manifest` only
      // summarises distinct blobs, so we also walk the row + template
      // cells to rewrite the Files-cell `blob_key` reference; without
      // that step the persisted cell would point at the archive path
      // (e.g. `cover.png`) and downstream download/preview consumers
      // would 404 against the actual workspace key
      // (`notion/<hash>/cover.png`).
      for entry in snapshot.files_manifest.iter_mut() {
        if let Some(new_key) = materialisation.rewritten_keys.get(&entry.blob_key) {
          entry.blob_key = new_key.clone();
        }
      }
      let rewrite_files_snapshot_cell = |cell: &mut DatabaseSnapshotCellValue| {
        if !matches!(cell.field_type, DatabaseFieldType::Files) {
          return;
        }
        let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Files(files_value)) = &mut cell.value else {
          return;
        };
        for file_entry in files_value.files.iter_mut() {
          if let Some(new_key) = materialisation.rewritten_keys.get(&file_entry.blob_key) {
            file_entry.blob_key = new_key.clone();
          }
        }
      };
      let rewrite_files_snapshot_data = |data: &mut DatabaseSnapshotCellValueData| {
        let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Files(files_value)) = data else {
          return;
        };
        for file_entry in files_value.files.iter_mut() {
          if let Some(new_key) = materialisation.rewritten_keys.get(&file_entry.blob_key) {
            file_entry.blob_key = new_key.clone();
          }
        }
      };
      for row in snapshot.database.rows.iter_mut() {
        for cell in row.cells.iter_mut() {
          rewrite_files_snapshot_cell(cell);
        }
      }
      for template in snapshot.database.row_templates.iter_mut() {
        for (_local_field_id, cell_data) in template.initial_cell_values.iter_mut() {
          rewrite_files_snapshot_data(cell_data);
        }
      }
      if let Err(error) = Self::rewrite_notion_content_asset_keys(&mut snapshot, &materialisation.rewritten_keys) {
        if !uploaded_blob_keys.is_empty() {
          self
            .compensate_uploaded_notion_assets(workspace_id, &uploaded_blob_keys)
            .await;
        }
        return Err(error);
      }
    }
    let mut diagnostics: Vec<super::notion_import::NotionDiagnostic> = notion_built.diagnostics;
    diagnostics.extend(asset_diagnostics);
    let has_content_documents = snapshot.database.rows.iter().any(|row| row.content_document.is_some());
    let serialised =
      serde_json::to_vec(&snapshot).map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
    let import_result = self
      .import_json_with_options(actor, workspace_id, &serialised, options, None)
      .await;
    let mut result = match import_result {
      Ok(result) => result,
      Err(error) => {
        // P-DB-29: blob rollback. The JSON half is already reverted
        // by the atomic native import transaction; we
        // only need to soft-delete any blobs we uploaded so the
        // workspace blob store has no orphans.
        if !uploaded_blob_keys.is_empty() {
          self
            .compensate_uploaded_notion_assets(workspace_id, &uploaded_blob_keys)
            .await;
        }
        if has_content_documents && matches!(error.code, ERR_JSON_INVALID | ERR_JSON_MISSING_FILE) {
          return Err(DatabaseServiceError::new(
            ERR_NOTION_BODY_APPLY_FAILED,
            format!(
              "Notion Page body apply failed and all materialized resources were compensated: {}",
              error.message
            ),
          ));
        }
        return Err(error);
      }
    };
    // P-DB-29R: walk the persisted database and resolve any
    // `Users` field that originated from a Notion People column
    // against active workspace members. Matched values become real
    // `Users` cells; ambiguous / unmatched values stay as empty
    // `Users` cells with row-local diagnostics so the Web UI can
    // surface the resolution state to the operator.
    let database_id = result.database.database.id;
    let people_diagnostics = self
      .resolve_notion_people(actor, workspace_id, database_id, &notion_result.parse, accepted_members)
      .await;
    diagnostics.extend(people_diagnostics);
    result.warnings.extend(Self::notion_diagnostics_to_json(&diagnostics));
    Ok(result)
  }

  /// Carry the existing Notion asset materialization result into portable Row
  /// bodies. The reserved URI is retained until the P-DB-38B document
  /// materializer resolves it to a live workspace key; only its snapshot-local
  /// key changes here.
  pub(in crate::database) fn rewrite_notion_content_asset_keys(
    snapshot: &mut DatabaseSnapshot,
    rewritten_keys: &BTreeMap<String, String>,
  ) -> DatabaseResult<()> {
    if rewritten_keys.is_empty() {
      return Ok(());
    }
    let mut replacements = HashMap::new();
    for database in std::iter::once(&snapshot.database).chain(snapshot.databases.iter()) {
      for content in database
        .rows
        .iter()
        .filter_map(|row| row.content_document.as_ref())
        .chain(
          database
            .row_templates
            .iter()
            .filter_map(|template| template.content_document.as_ref()),
        )
      {
        let uri = snapshot_document_uri(&content.document_key);
        replacements.insert(uri.clone(), uri);
      }
    }
    for (source, target) in rewritten_keys {
      replacements.insert(snapshot_asset_uri(source), snapshot_asset_uri(target));
    }

    let rewrite_content = |content: &mut DatabaseSnapshotContentDocument| -> DatabaseResult<()> {
      let update = STANDARD
        .decode(content.yjs_update_base64.as_bytes())
        .map_err(|error| DatabaseServiceError::new(ERR_NOTION_HTML_INVALID, error.to_string()))?;
      let rewritten = yjs::rewrite_snapshot_resource_uris(&update, &replacements)
        .map_err(|error| DatabaseServiceError::new(ERR_NOTION_HTML_INVALID, error))?;
      content.yjs_update_base64 = STANDARD.encode(rewritten);
      for asset_key in &mut content.asset_keys {
        if let Some(target) = rewritten_keys.get(asset_key) {
          *asset_key = target.clone();
        }
      }
      content.asset_keys.sort();
      content.asset_keys.dedup();
      Ok(())
    };
    for database in std::iter::once(&mut snapshot.database).chain(snapshot.databases.iter_mut()) {
      for row in &mut database.rows {
        if let Some(content) = &mut row.content_document {
          rewrite_content(content)?;
        }
      }
      for template in &mut database.row_templates {
        if let Some(content) = &mut template.content_document {
          rewrite_content(content)?;
        }
      }
    }
    Ok(())
  }

  /// P-DB-29R: post-apply pass that walks the persisted Notion
  /// database, looks up active workspace members by display name and
  /// exact handle for every People cell, and writes back the matched
  /// `User`/`Users` cell values. Each matched identity produces a
  /// `MIX_DATABASE_NOTION_PEOPLE_MATCHED` info diagnostic, each
  /// ambiguous or unmatched identity produces
  /// `MIX_DATABASE_NOTION_PEOPLE_AMBIGUOUS` /
  /// `MIX_DATABASE_NOTION_PEOPLE_UNMATCHED` warnings.
  async fn resolve_notion_people(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    parse: &super::notion_import::NotionParseResult,
    candidates: Vec<myoxus_domain::entities::WorkspaceMemberLookupRow>,
  ) -> Vec<super::notion_import::NotionDiagnostic> {
    let mut diagnostics = Vec::new();
    let Some(database) = parse.databases.first() else {
      return diagnostics;
    };
    if candidates.is_empty() {
      // No members means every People identity is unmatched. Emit a
      // single workspace-wide diagnostic so the operator knows the
      // apply succeeded but People cells stayed empty.
      diagnostics.push(super::notion_import::NotionDiagnostic::new(
        super::notion_import::NotionDiagnosticCode::PeopleUnmatched,
        super::notion_import::NotionDiagnosticSeverity::Warning,
        "$.people".to_string(),
        "Notion People columns were imported as empty `Users` cells because the workspace \
         has no accepted members to resolve identities against"
          .to_string(),
      ));
      return diagnostics;
    }
    // List the persisted rows in stable order so the index from the
    // Notion parse maps onto the created database one-to-one.
    let rows = match self
      .view_query_repo
      .list_rows(
        database_id,
        PageRequest {
          offset: 0,
          limit: i64::MAX,
        },
      )
      .await
    {
      Ok(list) => list,
      Err(error) => {
        tracing::warn!(
          workspace_id = %workspace_id,
          database_id = %database_id,
          error = %error,
          "notion people resolution: failed to list rows; skipping"
        );
        return diagnostics;
      }
    };
    let fields = match self.schema_repo.list_fields(database_id).await {
      Ok(list) => list,
      Err(error) => {
        tracing::warn!(
          workspace_id = %workspace_id,
          database_id = %database_id,
          error = %error,
          "notion people resolution: failed to list fields; skipping"
        );
        return diagnostics;
      }
    };
    // The parser stamps the row's `properties[i].kind` from
    // `database.properties[i].kind` but does not propagate the
    // schema's column name to the row cell. The snapshot adapter
    // persists each non-title column through the canonical Database field
    // repository row keyed by that schema-level column name, so the right
    // lookup is: row.property.kind == People → use the column_index
    // to read the schema name from `database.properties`, then look
    // up the persisted field id by name. This makes the
    // resolution robust to row cells that the parser filled in with
    // a synthetic `Column N` name.
    let mut user_fields_by_name: std::collections::HashMap<String, Vec<DatabaseFieldId>> =
      std::collections::HashMap::new();
    for field in &fields {
      if !matches!(field.field_type, DatabaseFieldType::Users) {
        continue;
      }
      user_fields_by_name
        .entry(field.name.clone())
        .or_default()
        .push(field.id);
    }
    if user_fields_by_name.is_empty() {
      return diagnostics;
    }
    for (row_index, notion_row) in database.rows.iter().enumerate() {
      let Some(persisted) = rows.get(row_index) else {
        break;
      };
      let persisted_row_id = persisted.row.id;
      for (column_index, property) in notion_row.properties.iter().enumerate() {
        if !matches!(property.kind, super::notion_import::NotionPropertyKind::People) {
          continue;
        }
        let Some(schema_property) = database.properties.get(column_index) else {
          continue;
        };
        let schema_name = &schema_property.name;
        let Some(field_ids) = user_fields_by_name.get(schema_name) else {
          continue;
        };
        let Some(field_id) = field_ids.first().copied() else {
          continue;
        };
        if property.people.is_empty() {
          continue;
        }
        // Per-identity resolution state: which user ids were matched
        // (possibly empty for Ambiguous/Unmatched) and which Notion
        // diagnostic code to emit when no match lands.
        let mut resolved: Vec<(String, Vec<UserId>)> = Vec::new();
        let mut resolutions: Vec<NotionPeopleResolution> = Vec::new();
        let mut matched_count: usize = 0;
        let mut matched_user_ids: Vec<UserId> = Vec::new();
        for identity in &property.people {
          match Self::match_workspace_member(&candidates, identity) {
            NotionPeopleResolution::Matched(user_id) => {
              resolved.push((identity.clone(), vec![user_id]));
              resolutions.push(NotionPeopleResolution::Matched(user_id));
              matched_user_ids.push(user_id);
              matched_count += 1;
            }
            NotionPeopleResolution::Ambiguous => {
              resolved.push((identity.clone(), Vec::new()));
              resolutions.push(NotionPeopleResolution::Ambiguous);
            }
            NotionPeopleResolution::Unmatched => {
              resolved.push((identity.clone(), Vec::new()));
              resolutions.push(NotionPeopleResolution::Unmatched);
            }
          }
        }
        // Collapse the per-identity resolution into a single
        // `Users` cell. Matched user ids are deduplicated while
        // preserving the first-seen order so a Notion row with two
        // references to the same workspace member does not produce a
        // duplicate user cell.
        let mut deduped: Vec<UserId> = Vec::new();
        for (_, user_ids) in &resolved {
          for user_id in user_ids {
            if !deduped.contains(user_id) {
              deduped.push(*user_id);
            }
          }
        }
        // Only update the cell if at least one identity matched.
        if matched_count > 0 {
          match self
            .rows
            .update_cell_value(
              actor,
              database_id,
              persisted_row_id,
              field_id,
              DatabaseCellValueData::Users(deduped.clone()),
            )
            .await
          {
            Ok(_) => {
              for identity in &property.people {
                if resolved
                  .iter()
                  .find(|(id, _)| id == identity)
                  .map(|(_, ids)| !ids.is_empty())
                  .unwrap_or(false)
                {
                  diagnostics.push(super::notion_import::NotionDiagnostic::new(
                    super::notion_import::NotionDiagnosticCode::PeopleMatched,
                    super::notion_import::NotionDiagnosticSeverity::Info,
                    format!("$.rows[{row_index}].cells[{column_index}]"),
                    format!(
                      "Notion People value '{}' resolved to {} workspace member id(s)",
                      identity,
                      resolved
                        .iter()
                        .find(|(id, _)| id == identity)
                        .map(|(_, ids)| ids.len())
                        .unwrap_or(0)
                    ),
                  ));
                }
              }
              let matched_ids = matched_user_ids.len();
              let _ = matched_ids;
            }
            Err(error) => {
              tracing::warn!(
                workspace_id = %workspace_id,
                database_id = %database_id,
                row_id = %persisted_row_id,
                field_id = %field_id,
                error = %error,
                "notion people resolution: failed to update cell"
              );
              for identity in &property.people {
                diagnostics.push(super::notion_import::NotionDiagnostic::new(
                  super::notion_import::NotionDiagnosticCode::PeopleUnmatched,
                  super::notion_import::NotionDiagnosticSeverity::Warning,
                  format!("$.rows[{row_index}].cells[{column_index}]"),
                  format!(
                    "Notion People value '{}' could not be applied as a `Users` cell: {error}; \
                     the cell stays empty",
                    identity
                  ),
                ));
              }
            }
          }
        } else {
          // Emit one diagnostic per ambiguous / unmatched identity so
          // the operator can see exactly which ones need manual
          // reconciliation. Empty cells stay as-is.
          for (identity, resolution) in property.people.iter().zip(resolutions.iter()) {
            let (code, message) = match resolution {
              NotionPeopleResolution::Matched(_) => continue,
              NotionPeopleResolution::Ambiguous => (
                super::notion_import::NotionDiagnosticCode::PeopleAmbiguous,
                format!(
                  "Notion People value '{}' matched more than one workspace member; \
                   the cell stays empty until the operator resolves the ambiguity",
                  identity
                ),
              ),
              NotionPeopleResolution::Unmatched => (
                super::notion_import::NotionDiagnosticCode::PeopleUnmatched,
                format!(
                  "Notion People value '{}' did not match any workspace member; \
                   the cell stays empty",
                  identity
                ),
              ),
            };
            diagnostics.push(super::notion_import::NotionDiagnostic::new(
              code,
              super::notion_import::NotionDiagnosticSeverity::Warning,
              format!("$.rows[{row_index}].cells[{column_index}]"),
              message,
            ));
          }
        }
      }
    }
    diagnostics
  }

  /// P-DB-29R: resolve a single Notion People identity against the
  /// pre-loaded list of workspace members. A value matches a single
  /// workspace member when its display name (trimmed, case-folded)
  /// or its email-style handle matches exactly one candidate.
  fn match_workspace_member(
    candidates: &[myoxus_domain::entities::WorkspaceMemberLookupRow],
    identity: &str,
  ) -> NotionPeopleResolution {
    let trimmed = identity.trim();
    if trimmed.is_empty() {
      return NotionPeopleResolution::Unmatched;
    }
    let folded = trimmed.to_ascii_lowercase();
    let mut name_matches: Vec<UserId> = Vec::new();
    let mut handle_matches: Vec<UserId> = Vec::new();
    for candidate in candidates {
      if candidate.display_name.to_ascii_lowercase() == folded {
        name_matches.push(candidate.user_id);
      } else if candidate
        .handle
        .as_deref()
        .map(|handle| handle.to_ascii_lowercase() == folded)
        .unwrap_or(false)
      {
        handle_matches.push(candidate.user_id);
      }
    }
    if name_matches.len() == 1 {
      return NotionPeopleResolution::Matched(name_matches[0]);
    }
    if name_matches.len() > 1 {
      return NotionPeopleResolution::Ambiguous;
    }
    if handle_matches.len() == 1 {
      return NotionPeopleResolution::Matched(handle_matches[0]);
    }
    if handle_matches.len() > 1 {
      return NotionPeopleResolution::Ambiguous;
    }
    NotionPeopleResolution::Unmatched
  }

  /// P-DB-29: upload the archive bytes for every Notion Files cell
  /// that resolves to an asset inside the uploaded ZIP. Returns the
  /// rewrite map and the upload key list; if no `BlobService` is
  /// configured the helper is a no-op (the assets are still recorded
  /// as Materialized diagnostics by the snapshot adapter so the
  /// preview surfaces the missing integration).
  async fn materialize_notion_assets(
    &self,
    _actor: UserId,
    workspace_id: WorkspaceId,
    parse_result: &super::notion_import::NotionParseResult,
    snapshot: &DatabaseSnapshot,
  ) -> super::notion_import::NotionAssetMaterialization {
    let blob_service = match self.blob_service.as_ref().cloned() {
      Some(service) => service,
      None => {
        // Without a BlobService wired the helper still returns a
        // NotionAssetMaterialization with zero rewrites; the snapshot
        // adapter's existing AssetMissing diagnostics stay in place so
        // the Web UI surfaces the missing-blob-store config as a
        // warning.
        return super::notion_import::NotionAssetMaterialization::default();
      }
    };
    // P-DB-29R: pre-upload every manifest entry that resolves to an
    // archive body. The neutral helper is sync, so the async upload
    // happens here and its outcome is recorded in a `BTreeMap` the
    // helper closure reads. Each upload is a single-part blob write
    // through the trusted `BlobService::upload_single_part_blob` entry
    // point; the snapshot adapter has already validated the manifest
    // entries (safe paths, MIME, size) so the only remaining failure
    // modes are store-side rejections. Every rejection is surfaced as
    // a `Rejected` variant so the helper emits the matching
    // `MIX_DATABASE_NOTION_ASSET_REJECTED` diagnostic.
    let mut precomputed: std::collections::BTreeMap<String, super::notion_import::NotionAssetUpload> =
      std::collections::BTreeMap::new();
    for entry in &snapshot.files_manifest {
      let Some((_archive_path, body)) = parse_result
        .assets
        .iter()
        .find(|(path, _)| super::notion_import::matches_asset_path(&entry.blob_key, path))
      else {
        continue;
      };
      let workspace_key = super::notion_import::notion_asset_blob_key(&entry.blob_key);
      let mime = entry
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
      let digest = {
        let mut hasher = Sha256::new();
        hasher.update(body);
        hex::encode(hasher.finalize())
      };
      let upload_result = blob_service
        .upload_single_part_blob(
          workspace_id,
          &workspace_key,
          Bytes::copy_from_slice(body),
          &mime,
          Some(mime.clone()),
          Some(digest.as_str()),
        )
        .await;
      let outcome = match upload_result {
        Ok(metadata) => super::notion_import::NotionAssetUpload::Uploaded {
          workspace_blob_key: metadata.key,
        },
        Err(error) => super::notion_import::NotionAssetUpload::Rejected {
          reason: format!(
            "notion asset '{}' ({} bytes, mime={}) could not be uploaded to the workspace \
             blob store under '{}': {}",
            entry.blob_key,
            body.len(),
            mime,
            workspace_key,
            error
          ),
        },
      };
      precomputed.insert(entry.blob_key.clone(), outcome);
    }
    // Walk the manifest a second time to drive the helper: this time
    // the helper only emits diagnostics, because every upload outcome
    // is already known. This keeps the public helper's contract
    // (sync, closure-based) intact while letting the production
    // caller run the actual async upload path.
    let mut materialisation = super::notion_import::NotionAssetMaterialization::default();
    for entry in &snapshot.files_manifest {
      let Some(outcome) = precomputed.get(&entry.blob_key).cloned() else {
        continue;
      };
      let body = parse_result
        .assets
        .iter()
        .find(|(path, _)| super::notion_import::matches_asset_path(&entry.blob_key, path))
        .map(|(_, body)| body);
      let _workspace_key = super::notion_import::notion_asset_blob_key(&entry.blob_key);
      let mime = entry
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
      match outcome {
        super::notion_import::NotionAssetUpload::Uploaded { workspace_blob_key } => {
          materialisation
            .rewritten_keys
            .insert(entry.blob_key.clone(), workspace_blob_key.clone());
          materialisation.uploaded_blob_keys.push(workspace_blob_key.clone());
          let body_len = body.map(|b| b.len()).unwrap_or(0);
          materialisation
            .diagnostics
            .push(super::notion_import::NotionDiagnostic::new(
              super::notion_import::NotionDiagnosticCode::AssetMaterialized,
              super::notion_import::NotionDiagnosticSeverity::Info,
              format!("$.assets[{}]", entry.blob_key),
              format!(
                "Notion ZIP asset '{}' was uploaded to the workspace blob store as '{}' \
               ({} bytes, mime={})",
                entry.blob_key, workspace_blob_key, body_len, mime
              ),
            ));
        }
        super::notion_import::NotionAssetUpload::Rejected { reason } => {
          materialisation
            .diagnostics
            .push(super::notion_import::NotionDiagnostic::new(
              super::notion_import::NotionDiagnosticCode::AssetRejected,
              super::notion_import::NotionDiagnosticSeverity::Warning,
              format!("$.assets[{}]", entry.blob_key),
              format!(
                "Notion ZIP asset '{}' could not be uploaded during apply: {}; \
               the cell preserves the original path so the operator can re-upload manually",
                entry.blob_key, reason
              ),
            ));
        }
      }
    }
    // Surface a single, apply-time "no blob store configured" diagnostic
    // whenever the manifest mentions assets but the helper found
    // nothing to upload. This keeps the legacy preview path honest:
    // operators see why the workspace blob never appears.
    if snapshot
      .files_manifest
      .iter()
      .any(|entry| parse_result.assets.contains_key(&entry.blob_key))
      && materialisation.uploaded_blob_keys.is_empty()
      && materialisation.rewritten_keys.is_empty()
      && materialisation.diagnostics.is_empty()
    {
      materialisation
        .diagnostics
        .push(super::notion_import::NotionDiagnostic::new(
          super::notion_import::NotionDiagnosticCode::AssetMissing,
          super::notion_import::NotionDiagnosticSeverity::Warning,
          "$.files_manifest".to_string(),
          "Notion ZIP referenced file assets but the BlobService path produced no uploads; \
         verify the server is configured with a workspace blob store before retrying"
            .to_string(),
        ));
    }
    materialisation
  }

  /// P-DB-29: soft-delete every blob key uploaded during a Notion
  /// import whose JSON apply step returned an error. The JSON
  /// transaction has already rolled back at this point; this step
  /// only has to clean up the workspace blob store.
  async fn compensate_uploaded_notion_assets(&self, workspace_id: WorkspaceId, blob_keys: &[String]) {
    let Some(blob_service) = self.blob_service.as_ref().cloned() else {
      return;
    };
    let now = chrono::Utc::now();
    for key in blob_keys {
      if let Err(error) = blob_service.soft_delete_blob(workspace_id, key, now).await {
        tracing::warn!(
          workspace_id = %workspace_id,
          blob_key = %key,
          error = %error,
          "notion asset rollback: failed to soft-delete uploaded blob"
        );
      }
    }
  }

  /// Helper: parse a Notion payload (ZIP or single HTML) and detect
  /// the source kind. Returns the parsed Notion result plus the
  /// original filename for the snapshot adapter.
  fn parse_notion_payload(&self, content: &[u8]) -> DatabaseResult<NotionPayload> {
    use super::notion_import::{NotionSource, parse_notion_html, parse_notion_zip};
    // Heuristic: ZIPs start with `PK\x03\x04`. Anything else is
    // treated as a single Notion HTML page.
    let is_zip = content.len() >= 4 && &content[..4] == b"PK\x03\x04";
    if is_zip {
      let parse = parse_notion_zip(content);
      Ok(NotionPayload {
        parse,
        zip_name: Some("notion-export.zip".to_string()),
      })
    } else {
      let parse = parse_notion_html(content);
      // `parse.source` is `Html` here; this branch is taken for
      // raw HTML uploads where there is no archive name.
      let _ = NotionSource::Html;
      Ok(NotionPayload { parse, zip_name: None })
    }
  }

  /// Convert a slice of Notion diagnostics into the JSON diagnostic
  /// shape so the Web UI can render them in the same panel.
  fn notion_diagnostics_to_json(diagnostics: &[super::notion_import::NotionDiagnostic]) -> Vec<DatabaseJsonDiagnostic> {
    diagnostics
      .iter()
      .map(|diag| DatabaseJsonDiagnostic {
        code: diag.code.clone(),
        source: "notion".to_string(),
        path: Some(diag.path.clone()),
        message: diag.message.clone(),
      })
      .collect()
  }
}
