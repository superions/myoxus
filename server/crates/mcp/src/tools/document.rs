// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin MCP adapters for canonical document projection and mutation services.

use std::sync::Arc;

use myoxus_application::auth::AuthError;
use myoxus_application::doc::{
  DocumentContentProjection, DocumentContentProjectionService, DocumentFragment, DocumentFragmentDiagnostics,
  DocumentMutation, DocumentMutationReadback, DocumentProjectionError, DocumentProjectionRequest,
  DocumentRepresentation, DocumentSelector, MutationReadbackStatus, MutationReadbackUnavailableReason,
  PrivateDocumentAsset, document_fragment_from_yjs_with_diagnostics,
};
use myoxus_application::ports::blob::BlobStatus;
use myoxus_application::public::{
  DocumentPublicationError, PublicAclDecision, PublicDocumentMode, document_metadata_badges,
};
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use super::{
  McpAuthContext, McpToolState, assert_doc_permission, assert_workspace_permission, authorized_markdown_references,
  begin_mcp_idempotency, begin_mcp_idempotency_with_payload, check_workspace_membership, finish_or_abort_mcp_write,
  load_document_metadata, mcp_json_response, parse_uuid, resolve_doc_in_workspace, resolve_external_document_for_mcp,
  with_internal_document_identity,
};

type HandlerError = (i32, String);

pub(super) async fn publication_get(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  validate_publication_keys(params, &["workspace_id", "external_id"])?;
  let (workspace_id, resolved) = require_publication_access(params, auth, state, false).await?;
  Ok(mcp_json_response(
    publication_status(state, workspace_id, resolved.internal_id, &resolved.external_id).await?,
  ))
}

pub(super) async fn publication_set(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  validate_publication_keys(
    params,
    &["workspace_id", "external_id", "public", "mode", "idempotency_key"],
  )?;
  let public = params
    .get("public")
    .and_then(Value::as_bool)
    .ok_or_else(|| (-32602, "public must be a non-null boolean".to_string()))?;
  let mode = parse_publication_mode(params, public)?;
  let (workspace_id, resolved) = require_publication_access(params, auth, state, true).await?;
  let doc_id = resolved.internal_id;
  let semantic_payload = json!({
    "workspace_id": workspace_id,
    "document_id": doc_id,
    "public": public,
    "mode": mode.map(PublicDocumentMode::persistence_value),
  });
  let guard =
    match begin_mcp_idempotency_with_payload("doc_publication_set", params, Some(&semantic_payload), auth, state)
      .await?
    {
      Ok(guard) => guard,
      Err(response) => return Ok(response),
    };

  let result = async {
    let service = state.document_publication_service.as_ref().ok_or_else(|| {
      (
        -32002,
        "Document publication service is not enabled on this MCP server".to_string(),
      )
    })?;
    service
      .set_mode(auth.user_id, workspace_id, doc_id, mode)
      .await
      .map_err(map_publication_error)?;
    Ok(with_internal_document_identity(
      mcp_json_response(publication_status(state, workspace_id, doc_id, &resolved.external_id).await?),
      doc_id,
    ))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

async fn require_publication_access(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  write: bool,
) -> Result<(uuid::Uuid, super::ResolvedExternalDocument), HandlerError> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }
  if write && !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_id = required_non_empty(params, "external_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, resolved.internal_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, resolved.internal_id, DocAction::Read).await?;
  if write {
    assert_doc_permission(
      state,
      auth.user_id,
      workspace_id,
      resolved.internal_id,
      DocAction::Publish,
    )
    .await?;
  }
  Ok((workspace_id, resolved))
}

fn parse_publication_mode(params: &Value, public: bool) -> Result<Option<PublicDocumentMode>, HandlerError> {
  let raw = match params.get("mode") {
    None => None,
    Some(Value::String(value)) => Some(value.as_str()),
    Some(_) => return Err((-32602, "mode must be a non-null string".to_string())),
  };
  if !public && raw.is_some() {
    return Err((-32602, "mode is not allowed when public is false".to_string()));
  }
  if !public {
    return Ok(None);
  }
  match raw.unwrap_or("Page") {
    "Page" => Ok(Some(PublicDocumentMode::Page)),
    "Edgeless" => Ok(Some(PublicDocumentMode::Edgeless)),
    _ => Err((-32602, "mode must be Page or Edgeless".to_string())),
  }
}

async fn publication_status(
  state: &McpToolState,
  workspace_id: uuid::Uuid,
  doc_id: uuid::Uuid,
  external_id: &str,
) -> Result<Value, HandlerError> {
  let doc = resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  let repository = state.public_repository.as_ref().ok_or_else(|| {
    (
      -32002,
      "Public repository is not enabled on this MCP server".to_string(),
    )
  })?;
  let repository_allows = matches!(
    repository
      .decide_document(workspace_id, doc_id, String::new())
      .await
      .map_err(|error| (
        -32002,
        format!("Failed to evaluate public document availability: {error}")
      ))?,
    PublicAclDecision::Allow(_)
  );
  let publicly_accessible = state.public_delivery_enabled && repository_allows;
  let public_url = if publicly_accessible {
    Some(public_document_url(&state.server_origin, workspace_id, external_id)?)
  } else {
    None
  };
  Ok(json!({
    "workspaceId": workspace_id,
    "externalId": external_id,
    "public": doc.public_mode.is_some(),
    "mode": doc.public_mode,
    "publiclyAccessible": publicly_accessible,
    "publicUrl": public_url,
  }))
}

fn public_document_url(origin: &str, workspace_id: uuid::Uuid, external_id: &str) -> Result<String, HandlerError> {
  let mut url = Url::parse(origin).map_err(|_| (-32002, "Configured server origin is invalid".to_string()))?;
  url.set_query(None);
  url.set_fragment(None);
  url.set_path("");
  url
    .path_segments_mut()
    .map_err(|_| {
      (
        -32002,
        "Configured server origin cannot contain path segments".to_string(),
      )
    })?
    .extend(["public", &workspace_id.to_string(), external_id]);
  Ok(url.into())
}

fn validate_publication_keys(params: &Value, allowed: &[&str]) -> Result<(), HandlerError> {
  let object = params
    .as_object()
    .ok_or_else(|| (-32602, "Tool arguments must be an object".to_string()))?;
  if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
    return Err((-32602, format!("Unknown parameter: {key}")));
  }
  if object.values().any(Value::is_null) {
    return Err((-32602, "Null parameters are not allowed".to_string()));
  }
  Ok(())
}

fn map_publication_error(error: DocumentPublicationError) -> HandlerError {
  match error {
    DocumentPublicationError::Authorization(AuthError::ActionForbidden) => {
      (-32003, "Document publication permission denied".to_string())
    }
    DocumentPublicationError::Authorization(AuthError::NotFound(_)) | DocumentPublicationError::NotFound => {
      (-32004, "Document not found".to_string())
    }
    DocumentPublicationError::Authorization(AuthError::InvalidInput(message)) => (-32602, message),
    DocumentPublicationError::DeliveryUnavailable => {
      (-32002, "Public publishing is unavailable for this server".to_string())
    }
    DocumentPublicationError::WorkspaceUnavailable => (
      -32602,
      "Workspace must be public with sharing enabled before publishing documents".to_string(),
    ),
    error => (-32002, format!("Document publication failed: {error}")),
  }
}

pub(super) async fn read_doc(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let structured = project_authorized_document(params, auth, state).await?;
  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string(&structured).unwrap_or_default()}],
    "structuredContent": structured,
  }))
}

/// Read immutable content with current ACLs, independently of the live version head.
#[tracing::instrument(skip_all)]
pub(super) async fn version_read(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  validate_publication_keys(
    params,
    &["workspace_id", "external_id", "version_id", "cursor", "limit"],
  )?;
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_id = required_non_empty(params, "external_id")?;
  let version_id = parse_uuid(params, "version_id")?;
  let cursor = params
    .get("cursor")
    .map(|value| {
      value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| (-32602, "cursor must be a non-null string".into()))
    })
    .transpose()?;
  let limit = params
    .get("limit")
    .map(|value| {
      value
        .as_u64()
        .filter(|v| (1..=200).contains(v))
        .map(|v| v as usize)
        .ok_or_else(|| (-32602, "limit must be between 1 and 200".into()))
    })
    .transpose()?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Read).await?;
  let (version, snapshot) = state
    .document_services
    .version_snapshot(workspace_id, doc_id, version_id)
    .await
    .map_err(|_| (-32002, "Named version snapshot could not be loaded".into()))?
    .ok_or_else(|| (-32004, "Named version snapshot not found for this document".into()))?;

  // Domain-separated cursor key binds the exact version, raw snapshot and reader.
  // Internal projection sequence zero is not a live revision and is not exposed.
  let mut key = Sha256::new();
  key.update(b"myoxus.mcp.named-version-read.v1\0");
  key.update((state.document_cursor_signing_key.len() as u64).to_le_bytes());
  key.update(&state.document_cursor_signing_key);
  for id in [auth.user_id, workspace_id, doc_id, version_id] {
    key.update(id.as_bytes());
  }
  key.update(Sha256::digest(&snapshot));
  let service = DocumentContentProjectionService::new(
    state.doc_service.load.clone(),
    Arc::<[u8]>::from(key.finalize().to_vec()),
  )
  .with_html_catalog(state.html_catalog.clone())
  .with_historical_fields()
  .with_max_output_bytes(state.document_export_max_bytes);
  let projection = service
    .project_payload(
      DocumentProjectionRequest {
        workspace_id,
        doc_id,
        fallback_title: String::new(),
        metadata_badges: Vec::new(),
        representation: DocumentRepresentation::Structured,
        cursor,
        limit,
        theme_css_url: String::new(),
        selector: None,
        neighbor_context: 0,
      },
      &snapshot,
      0,
    )
    .map_err(map_projection_error)?;
  if projection_has_private_assets(&projection) {
    assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsRead).await?;
  }
  let mut content = serde_json::to_value(projection)
    .map_err(|_| (-32002, "Named version projection could not be serialized".into()))?;
  content.as_object_mut().expect("projection object").remove("revision");
  content["versionId"] = json!(version.id);
  content["docHistoryId"] = json!(version.doc_history_id);
  content["projection"]["source"] = json!("named_version_snapshot");
  let document = content["document"].as_object_mut().expect("structured document");
  document.remove("docId");
  document.insert("externalId".into(), json!(resolved.external_id));
  if serde_json::to_vec(&content).map_or(true, |bytes| bytes.len() > state.document_export_max_bytes) {
    return Err(map_projection_error(DocumentProjectionError::ExportTooLarge));
  }
  super::document_semantics::redact_mentions(&mut content, workspace_id, auth, state).await;
  Ok(mcp_json_response(content))
}

/// Restore through the existing atomic history owner; this response contains
/// committed facts only, so replay never loads a newer head or historical body.
#[tracing::instrument(skip_all)]
pub(super) async fn version_restore(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  validate_publication_keys(
    params,
    &[
      "workspace_id",
      "external_id",
      "version_id",
      "confirm_restore",
      "expected_revision",
      "idempotency_key",
    ],
  )?;
  if params.get("confirm_restore").and_then(Value::as_bool) != Some(true) {
    return Err((-32602, "confirm_restore must be true".into()));
  }
  let expected_sequence =
    parse_expected_sequence(params)?.ok_or_else(|| (-32602, "expected_revision is required".into()))?;
  let version_id = parse_uuid(params, "version_id")?;
  let (workspace_id, resolved) = require_document_write_access(params, auth, state).await?;
  let doc_id = resolved.internal_id;
  let semantic = json!({"workspaceId":workspace_id,"docId":doc_id,"versionId":version_id,"confirmRestore":true,"expectedRevision":expected_sequence});
  let guard =
    match begin_mcp_idempotency_with_payload("doc_version_restore", params, Some(&semantic), auth, state).await? {
      Ok(guard) => guard,
      Err(response) => return Ok(response),
    };
  let external_id = resolved.external_id.clone();
  let builder: myoxus_application::mcp::McpDocumentResponseBuilder = Arc::new(move |outcome| {
    let myoxus_application::mcp::McpDocumentWriteCommit::HistoryRestore(commit) = outcome else {
      return Err(AuthError::InvalidInput("unexpected named restore receipt".into()));
    };
    named_restore_response(commit, workspace_id, doc_id, version_id, &external_id)
  });
  let result = guard
    .document_write_with_response(auth, builder.clone(), async {
      let commit = state
        .document_services
        .restore_version(
          workspace_id,
          doc_id,
          version_id,
          myoxus_application::audit::AuditActor::api_key(auth.user_id, auth.key_id),
          expected_sequence,
        )
        .await
        .map_err(map_version_restore_error)?;
      builder(myoxus_application::mcp::McpDocumentWriteCommit::HistoryRestore(&commit))
        .map_err(|_| (-32002, "Named restore result could not be serialized".into()))
    })
    .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn named_restore_response(
  commit: &myoxus_application::doc::history::HistoryRestoreCommit,
  workspace_id: uuid::Uuid,
  doc_id: uuid::Uuid,
  source_version_id: uuid::Uuid,
  external_id: &str,
) -> myoxus_application::auth::AuthResult<Value> {
  let version = commit
    .version
    .as_ref()
    .filter(|v| v.doc_id == doc_id && v.workspace_id == workspace_id)
    .ok_or_else(|| AuthError::Storage("named restore returned no matching version".into()))?;
  Ok(with_internal_document_identity(
    mcp_json_response(json!({
      "workspaceId":workspace_id,"externalId":external_id,"sourceVersionId":source_version_id,
      "versionId":version.id,"docHistoryId":version.doc_history_id,"label":version.label,"versionNo":version.version_no,
      "sequence":commit.sequence,"revision":commit.sequence,"recoveryHistoryId":commit.recovery_history_id,
      "restoredAt":commit.committed_at.to_rfc3339(),
    })),
    doc_id,
  ))
}

fn map_version_restore_error(error: myoxus_application::document_version::DocumentVersionRestoreError) -> HandlerError {
  use myoxus_application::doc::history::HistoryCaptureError;
  use myoxus_application::document_version::DocumentVersionRestoreError;
  match error {
    DocumentVersionRestoreError::History(HistoryCaptureError::Document(error)) => map_mutation_error(error),
    DocumentVersionRestoreError::History(HistoryCaptureError::StaleEntry) => {
      (-32004, "Named version history is no longer available".into())
    }
    DocumentVersionRestoreError::Label(_) => (-32602, "Named restore label could not be prepared".into()),
    _ => (-32002, "Named version could not be restored".into()),
  }
}

/// Shared read boundary for tool and resource transports. Authorize before loading
/// content, and keep projection limits and private-asset checks identical.
pub(crate) async fn project_authorized_document(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_id = required_non_empty(params, "external_id")?;
  let representation = parse_representation(params)?;
  let include_okf = match params.get("include_okf_frontmatter") {
    None => false,
    Some(Value::Bool(value)) => *value,
    Some(_) => return Err((-32602, "include_okf_frontmatter must be a boolean".into())),
  };
  if params
    .as_object()
    .is_some_and(|params| params.contains_key("include_okf_frontmatter"))
    && params.get("representation").and_then(Value::as_str) != Some("markdown")
  {
    return Err((
      -32602,
      "include_okf_frontmatter requires representation markdown".into(),
    ));
  }
  let (selector, neighbor_context) = parse_document_selector(params, representation)?;
  let cursor = params.get("cursor").and_then(Value::as_str).map(str::to_string);
  let limit = params
    .get("limit")
    .and_then(Value::as_u64)
    .map(|value| usize::try_from(value).unwrap_or(usize::MAX));

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  let doc_meta = resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Read).await?;

  if !include_okf {
    state.doc_service.load.fire_view_tracking(
      workspace_id,
      doc_id,
      auth.user_id,
      true,
      state.workspace_service.clone(),
    );
  }

  let metadata = load_document_metadata(state.document_services.as_ref(), doc_id, workspace_id).await?;
  let policy = state
    .document_services
    .policy(doc_id, workspace_id)
    .await
    .map_err(|error| (-32002, format!("document metadata policy load failed: {error}")))?;
  let metadata_badges = document_metadata_badges(&metadata, &policy.definitions);
  let references = if representation == DocumentRepresentation::Markdown {
    Some(authorized_markdown_references(state, auth.user_id, workspace_id).await?)
  } else {
    None
  };
  let source_references = references.clone();
  let mut service = DocumentContentProjectionService::new(
    state.doc_service.load.clone(),
    state.document_cursor_signing_key.clone(),
  )
  .with_html_catalog(state.html_catalog.clone())
  .with_field_source(state.document_services.field_context_source(), Some(auth.user_id))
  .with_max_output_bytes(state.document_export_max_bytes);
  if let Some(references) = references {
    service = service.with_markdown_references(references);
  }
  if include_okf {
    let tags = state
      .workspace_tag_service
      .as_ref()
      .ok_or_else(|| (-32002, "Canonical tag service unavailable".to_owned()))?;
    let ids = tags
      .document_tag_ids(auth.user_id, workspace_id, doc_id)
      .await
      .map_err(|_| (-32002, "Canonical tag assignments unavailable".to_owned()))?;
    let tags = tags
      .resolve_tags(auth.user_id, workspace_id, &ids)
      .await
      .map_err(|_| (-32002, "Canonical tags unavailable".to_owned()))?;
    let status_mapping = metadata
      .fields
      .iter()
      .find(|field| field.key == "status")
      .and_then(|field| field.text_value.as_ref())
      .and_then(|value| serde_json::from_value(json!(value)).ok());
    service = service.with_okf_context(myoxus_application::document_metadata::okf::OkfReadContext {
      workspace_id,
      external_id: resolved.external_id.clone(),
      title: doc_meta.title.clone(),
      imported_properties: doc_meta
        .meta
        .pointer("/obsidian/properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default(),
      metadata,
      status_mapping,
      tags,
      markdown_references: source_references.clone(),
    });
  }
  let mut projection = service
    .project(DocumentProjectionRequest {
      workspace_id,
      doc_id,
      fallback_title: doc_meta.title,
      metadata_badges,
      representation,
      selector,
      neighbor_context,
      cursor,
      limit,
      theme_css_url: format!("/api/branding/theme.css?workspaceId={workspace_id}"),
    })
    .await
    .map_err(map_projection_error)?;
  if let DocumentContentProjection::Export(export) = &mut projection
    && let Some(okf) = &mut export.okf
  {
    let body = export
      .data
      .split_once("\n---\n")
      .map(|(_, body)| body.to_owned())
      .ok_or_else(|| (-32002, "Generated OKF frontmatter boundary unavailable".to_owned()))?;
    myoxus_application::document_metadata::okf::enrich_sources(
      okf,
      auth.user_id,
      &state.doc_service,
      &state.permission_service,
      state.document_services.as_ref(),
      source_references.as_ref().map(|lookup| (workspace_id, lookup)),
      state.blob_service.as_deref(),
    )
    .await;
    export.data = okf
      .markdown(&body)
      .map_err(|_| (-32002, "OKF serialization failed".to_owned()))?;
  }
  if projection_has_private_assets(&projection) {
    assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsRead).await?;
  }
  resolve_private_asset_metadata(&mut projection, state).await?;
  if serde_json::to_vec(&projection).map_or(true, |value| value.len() > state.document_export_max_bytes) {
    return Err((
      -32002,
      "MIX_MCP_DOCUMENT_EXPORT_TOO_LARGE: document export exceeds the configured output limit".to_string(),
    ));
  }
  let mut structured = serde_json::to_value(projection).map_err(|_| {
    (
      -32002,
      "MIX_MCP_DOCUMENT_PROJECTION_SERIALIZATION: document projection could not be serialized".to_string(),
    )
  })?;
  if let Some(document) = structured.get_mut("document").and_then(Value::as_object_mut) {
    document.remove("docId");
    document.insert("externalId".to_string(), json!(resolved.external_id));
  }
  super::document_semantics::redact_mentions(&mut structured, workspace_id, auth, state).await;
  Ok(structured)
}

fn projection_has_private_assets(projection: &DocumentContentProjection) -> bool {
  match projection {
    DocumentContentProjection::Structured(structured) => !structured.document.assets.is_empty(),
    DocumentContentProjection::Export(export) => export
      .assets
      .iter()
      .any(|asset| matches!(asset, PrivateDocumentAsset::Blob { .. })),
  }
}

async fn resolve_private_asset_metadata(
  projection: &mut DocumentContentProjection,
  state: &McpToolState,
) -> Result<(), (i32, String)> {
  let DocumentContentProjection::Export(export) = projection else {
    return Ok(());
  };
  if !export
    .assets
    .iter()
    .any(|asset| matches!(asset, PrivateDocumentAsset::Blob { .. }))
  {
    return Ok(());
  }
  let service = state.blob_service.as_ref().ok_or_else(|| {
    (
      -32002,
      "MIX_MCP_DOCUMENT_ASSET_SERVICE_UNAVAILABLE: blob metadata service is unavailable".to_string(),
    )
  })?;
  for asset in &mut export.assets {
    let PrivateDocumentAsset::Blob {
      media_type,
      size,
      source_key,
      blob_read,
      ..
    } = asset
    else {
      continue;
    };
    let metadata = service
      .get_blob_metadata(blob_read.arguments.workspace_id, source_key)
      .await
      .map_err(|_| {
        (
          -32002,
          "MIX_MCP_DOCUMENT_ASSET_LOOKUP_FAILED: private asset metadata could not be resolved".to_string(),
        )
      })?
      .filter(|metadata| metadata.deleted_at.is_none() && metadata.status == BlobStatus::Completed)
      .ok_or_else(|| {
        (
          -32004,
          "MIX_MCP_DOCUMENT_ASSET_NOT_FOUND: private document asset is not readable".to_string(),
        )
      })?;
    *media_type = metadata.mime;
    *size = metadata.size;
  }
  Ok(())
}

pub(super) async fn update_doc(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let (workspace_id, resolved) = require_document_write_access(params, auth, state).await?;
  let doc_id = resolved.internal_id;
  let expected_sequence = parse_expected_sequence(params)?;
  let (fragment, diagnostics) = parse_fragment_with_diagnostics(params, true, workspace_id, auth, state).await?;
  let confirm = params
    .get("confirm_replace_all")
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let mutation = DocumentMutation::ReplaceAll { fragment };
  let semantic_payload = canonical_mutation_payload(workspace_id, doc_id, &mutation, Some(confirm), expected_sequence)?;
  let guard =
    match begin_mcp_idempotency_with_payload("update_doc", params, Some(&semantic_payload), auth, state).await? {
      Ok(guard) => guard,
      Err(response) => return authorize_replayed_readback(response, workspace_id, doc_id, auth, state).await,
    };
  let result = guard
    .document_write_with_response(auth, fragment_response_builder(params, &diagnostics), async {
      let committed = state
        .doc_service
        .mutate_content(
          workspace_id,
          doc_id,
          Some(auth.user_id),
          mutation,
          confirm,
          expected_sequence,
        )
        .await
        .map_err(map_mutation_error)?;
      let affected_block_ids = affected_block_ids(params, &committed);
      let readback = project_affected_blocks(workspace_id, &committed, &affected_block_ids, auth, state).await;
      Ok(with_internal_document_identity(
        mcp_json_response(with_fragment_diagnostics(
          json!({
            "externalId": resolved.external_id,
            "operation": "replace_all",
            "sequence": committed.sequence,
            "revision": committed.sequence,
            "affectedBlockIds": affected_block_ids,
            "updatedBlocks": super::document_semantics::private_blocks(&readback, workspace_id, auth, state).await,
            "readback": readback.status,
            "insertedBlockIds": committed.inserted_block_ids,
            "removedBlockIds": committed.removed_block_ids,
            "recoveryHistoryId": committed.recovery_history_id,
          }),
          &diagnostics,
        )),
        doc_id,
      ))
    })
    .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn doc_patch(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let (workspace_id, resolved) = require_document_write_access(params, auth, state).await?;
  let doc_id = resolved.internal_id;
  let expected_sequence = parse_expected_sequence(params)?;
  let operation = params
    .get("operation")
    .and_then(Value::as_str)
    .ok_or_else(|| (-32602, "operation is required".to_string()))?;
  validate_patch_arguments(params, operation)?;
  if operation == "update_title" {
    let title = required_non_empty(params, "title")?;
    // The shipped title payload already includes any supplied revision. Keep
    // its hash stable for revisionless retries across this capability update.
    let guard = match begin_mcp_idempotency("doc_patch", params, auth, state).await? {
      Ok(guard) => guard,
      Err(response) => return Ok(response),
    };
    let result = guard
      .document_write(auth, params, async {
        let committed = state
          .doc_service
          .rename_page(workspace_id, doc_id, auth.user_id, title, expected_sequence)
          .await
          .map_err(map_mutation_error)?;
        Ok(with_internal_document_identity(
          mcp_json_response(json!({
            "externalId": resolved.external_id,
            "operation": "update_title",
            "revision": committed.leaf.as_ref().map(|delta| delta.sequence),
            "affectedBlockIds": [],
            "leafSequence": committed.leaf.as_ref().map(|delta| delta.sequence),
            "rootSequence": committed.workspace_root.sequence,
            "updatedAt": committed.committed_at.to_rfc3339(),
          })),
          doc_id,
        ))
      })
      .await;
    return finish_or_abort_mcp_write(guard, state, auth, result).await;
  }
  let (fragment, diagnostics) =
    if crate::tool_registry::patch_operation_fields(operation).is_some_and(|(_, _, fragment)| fragment) {
      let (fragment, diagnostics) = parse_fragment_with_diagnostics(params, false, workspace_id, auth, state).await?;
      (Some(fragment), diagnostics)
    } else {
      (None, DocumentFragmentDiagnostics::default())
    };
  let mut mutation = match operation {
    "append_blocks" | "append" => DocumentMutation::AppendBlocks {
      fragment: fragment.ok_or_else(|| (-32602, "fragment is required".to_string()))?,
    },
    "prepend_blocks" | "prepend" => DocumentMutation::PrependBlocks {
      fragment: fragment.ok_or_else(|| (-32602, "fragment is required".to_string()))?,
    },
    "insert_after_block" => DocumentMutation::InsertAfterBlock {
      block_id: required_non_empty(params, "block_id")?,
      fragment: fragment.ok_or_else(|| (-32602, "fragment is required".to_string()))?,
    },
    "replace_block" => DocumentMutation::ReplaceBlock {
      block_id: required_non_empty(params, "block_id")?,
      fragment: fragment.ok_or_else(|| (-32602, "fragment is required".to_string()))?,
    },
    "replace_heading_section" => DocumentMutation::ReplaceHeadingSection {
      heading: required_non_empty(params, "heading")?,
      fragment: fragment.ok_or_else(|| (-32602, "fragment is required".to_string()))?,
    },
    "append_to_heading" => DocumentMutation::AppendToHeading {
      heading: required_non_empty(params, "heading")?,
      fragment: fragment.ok_or_else(|| (-32602, "fragment is required".to_string()))?,
    },
    "delete_block" => DocumentMutation::DeleteBlock {
      block_id: required_non_empty(params, "block_id")?,
    },
    "move_block" => DocumentMutation::MoveBlock {
      block_id: required_non_empty(params, "block_id")?,
      after_block_id: params.get("after_block_id").and_then(Value::as_str).map(str::to_string),
      parent_block_id: params
        .get("parent_block_id")
        .and_then(Value::as_str)
        .map(str::to_string),
    },
    "edit_annotation" => DocumentMutation::EditAnnotation {
      block_id: required_non_empty(params, "block_id")?,
      annotation_id: params["annotation_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| (-32602, "annotation_id is required".into()))?
        .to_string(),
      start: params["start"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| (-32602, "start is required".into()))?,
      range_unit: params
        .get("range_unit")
        .map(|value| serde_json::from_value(value.clone()).map_err(|_| (-32602, "Invalid range_unit".into())))
        .transpose()?,
      replacement: params["replacement"]
        .as_str()
        .ok_or_else(|| (-32602, "replacement is required".into()))?
        .into(),
      expected_text: params.get("expected_text").and_then(Value::as_str).map(str::to_string),
      row_id: params.get("row_id").and_then(Value::as_str).map(str::to_string),
      column_id: params.get("column_id").and_then(Value::as_str).map(str::to_string),
    },
    "edit_text" => DocumentMutation::EditText {
      block_id: required_non_empty(params, "block_id")?,
      start: params
        .get("start")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| (-32602, "start is required".to_string()))?,
      end: params
        .get("end")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| (-32602, "end is required".to_string()))?,
      replacement: params
        .get("replacement")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string(),
      replacement_spans: parse_replacement_spans(params)?,
      text_field: parse_text_field(params)?,
      range_unit: params
        .get("range_unit")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|_| {
          (
            -32602,
            "range_unit must be utf8_bytes, utf16_code_units or unicode_scalars".to_string(),
          )
        })?,
      expected_text: params
        .get("expected_text")
        .map(|value| {
          value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| (-32602, "expected_text must be a string".to_string()))
        })
        .transpose()?,
    },
    "update_table_row_properties" | "update_table_column_properties" => {
      DocumentMutation::UpdateTableCoordinateProperties {
        block_id: required_non_empty(params, "block_id")?,
        axis: if operation == "update_table_row_properties" {
          yjs::DocumentTableAxis::Row
        } else {
          yjs::DocumentTableAxis::Column
        },
        id: required_non_empty(
          params,
          if operation == "update_table_row_properties" {
            "row_id"
          } else {
            "column_id"
          },
        )?,
        properties: serde_json::from_value(
          params
            .get("properties")
            .cloned()
            .ok_or_else(|| (-32602, "properties is required".into()))?,
        )
        .map_err(|_| (-32602, "invalid table coordinate properties".into()))?,
      }
    }
    "insert_table_row" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Row,
      change: yjs::DocumentTableAxisChange::Insert {
        after_id: params
          .get("after_row_id")
          .map(|v| {
            v.as_str()
              .map(str::to_string)
              .ok_or_else(|| (-32602, "after_row_id must be a string".into()))
          })
          .transpose()?,
      },
    },
    "delete_table_row" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Row,
      change: yjs::DocumentTableAxisChange::Delete {
        id: required_non_empty(params, "row_id")?,
      },
    },
    "move_table_row" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Row,
      change: yjs::DocumentTableAxisChange::Move {
        id: required_non_empty(params, "row_id")?,
        after_id: params
          .get("after_row_id")
          .map(|v| {
            v.as_str()
              .map(str::to_string)
              .ok_or_else(|| (-32602, "after_row_id must be a string".into()))
          })
          .transpose()?,
      },
    },
    "duplicate_table_row" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Row,
      change: yjs::DocumentTableAxisChange::Duplicate {
        id: required_non_empty(params, "row_id")?,
      },
    },
    "clear_table_row" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Row,
      change: yjs::DocumentTableAxisChange::Clear {
        id: required_non_empty(params, "row_id")?,
      },
    },
    "insert_table_column" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Column,
      change: yjs::DocumentTableAxisChange::Insert {
        after_id: params
          .get("after_column_id")
          .map(|v| {
            v.as_str()
              .map(str::to_string)
              .ok_or_else(|| (-32602, "after_column_id must be a string".into()))
          })
          .transpose()?,
      },
    },
    "delete_table_column" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Column,
      change: yjs::DocumentTableAxisChange::Delete {
        id: required_non_empty(params, "column_id")?,
      },
    },
    "move_table_column" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Column,
      change: yjs::DocumentTableAxisChange::Move {
        id: required_non_empty(params, "column_id")?,
        after_id: params
          .get("after_column_id")
          .map(|v| {
            v.as_str()
              .map(str::to_string)
              .ok_or_else(|| (-32602, "after_column_id must be a string".into()))
          })
          .transpose()?,
      },
    },
    "duplicate_table_column" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Column,
      change: yjs::DocumentTableAxisChange::Duplicate {
        id: required_non_empty(params, "column_id")?,
      },
    },
    "clear_table_column" => DocumentMutation::EditTableAxis {
      block_id: required_non_empty(params, "block_id")?,
      axis: yjs::DocumentTableAxis::Column,
      change: yjs::DocumentTableAxisChange::Clear {
        id: required_non_empty(params, "column_id")?,
      },
    },
    "edit_table_cell" => DocumentMutation::EditTableCell {
      block_id: required_non_empty(params, "block_id")?,
      row_id: required_non_empty(params, "row_id")?,
      column_id: required_non_empty(params, "column_id")?,
      start: required_text_position(params, "start")?,
      end: required_text_position(params, "end")?,
      replacement: params
        .get("replacement")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string(),
      replacement_spans: parse_replacement_spans(params)?,
      range_unit: params
        .get("range_unit")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|_| {
          (
            -32602,
            "range_unit must be utf8_bytes, utf16_code_units or unicode_scalars".into(),
          )
        })?,
      expected_text: params
        .get("expected_text")
        .map(|value| {
          value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| (-32602, "expected_text must be a string".into()))
        })
        .transpose()?,
    },
    "format_text" => DocumentMutation::FormatText {
      block_id: required_non_empty(params, "block_id")?,
      start: required_text_position(params, "start")?,
      end: required_text_position(params, "end")?,
      formatting: parse_text_formatting(params)?,
      row_id: params
        .get("row_id")
        .map(|_| required_non_empty(params, "row_id"))
        .transpose()?,
      column_id: params
        .get("column_id")
        .map(|_| required_non_empty(params, "column_id"))
        .transpose()?,
      range_unit: params
        .get("range_unit")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|_| {
          (
            -32602,
            "range_unit must be utf8_bytes, utf16_code_units or unicode_scalars".into(),
          )
        })?,
      expected_text: params
        .get("expected_text")
        .map(|value| {
          value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| (-32602, "expected_text must be a string".into()))
        })
        .transpose()?,
    },
    "duplicate_block" => DocumentMutation::DuplicateBlock {
      block_id: required_non_empty(params, "block_id")?,
    },
    "split_block" => DocumentMutation::SplitBlock {
      block_id: required_non_empty(params, "block_id")?,
      position: required_text_position(params, "position")?,
      range_unit: params
        .get("range_unit")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|_| (-32602, "range_unit is invalid".to_string()))?,
    },
    "join_blocks" => DocumentMutation::JoinBlocks {
      block_id: required_non_empty(params, "block_id")?,
      source_block_id: required_non_empty(params, "source_block_id")?,
    },
    "convert_block" => DocumentMutation::ConvertBlock {
      block_id: required_non_empty(params, "block_id")?,
      block_kind: serde_json::from_value(params.get("block_kind").cloned().unwrap_or(Value::Null))
        .map_err(|_| (-32602, "block_kind is invalid".to_string()))?,
    },
    "update_block_properties" => DocumentMutation::UpdateBlockProperties {
      block_id: required_non_empty(params, "block_id")?,
      properties: serde_json::from_value(
        params
          .get("properties")
          .cloned()
          .ok_or_else(|| (-32602, "properties is required".to_string()))?,
      )
      .map_err(|_| (-32602, "properties is invalid".to_string()))?,
    },
    "update_citation" => DocumentMutation::UpdateCitation {
      label: required_non_empty(params, "label")?,
      new_label: params.get("new_label").and_then(Value::as_str).map(str::to_string),
      reference: params.get("reference").cloned(),
    },
    _ => {
      return Err((
        -32602,
        "operation must be append_blocks, prepend_blocks, insert_after_block, replace_block, replace_heading_section, append_to_heading, delete_block, move_block, convert_block, duplicate_block, split_block, join_blocks, edit_text, edit_annotation, format_text, edit_table_cell, insert_table_row, delete_table_row, move_table_row, duplicate_table_row, clear_table_row, insert_table_column, delete_table_column, move_table_column, duplicate_table_column, clear_table_column, update_table_row_properties, update_table_column_properties, update_block_properties or update_citation"
          .to_string(),
      ));
    }
  };
  if let DocumentMutation::EditText {
    replacement_spans: Some(spans),
    ..
  }
  | DocumentMutation::EditTableCell {
    replacement_spans: Some(spans),
    ..
  } = &mut mutation
  {
    super::document_semantics::authorize_spans(spans, workspace_id, auth, state, &mut Default::default()).await?;
  }
  // A newly supplied citation target must be resolvable and readable in its
  // selected workspace, rechecked on every replay. Untouched historical
  // references stay native.
  if let DocumentMutation::UpdateCitation {
    reference: Some(reference),
    ..
  } = &mut mutation
  {
    super::document_semantics::authorize_citation_reference(reference, workspace_id, auth, state).await?;
  }
  myoxus_application::doc::normalize_document_mutation(&mut mutation).map_err(map_mutation_error)?;
  let semantic_payload = canonical_mutation_payload(workspace_id, doc_id, &mutation, None, expected_sequence)?;
  let guard =
    match begin_mcp_idempotency_with_payload("doc_patch", params, Some(&semantic_payload), auth, state).await? {
      Ok(guard) => guard,
      Err(response) => return authorize_replayed_readback(response, workspace_id, doc_id, auth, state).await,
    };
  let result = guard
    .document_write_with_response(auth, fragment_response_builder(params, &diagnostics), async {
      let operation_name = mutation.name();
      let committed = state
        .doc_service
        .mutate_content(
          workspace_id,
          doc_id,
          Some(auth.user_id),
          mutation,
          false,
          expected_sequence,
        )
        .await
        .map_err(map_mutation_error)?;
      let affected_block_ids = affected_block_ids(params, &committed);
      let readback = project_affected_blocks(workspace_id, &committed, &affected_block_ids, auth, state).await;
      Ok(with_internal_document_identity(
        mcp_json_response(with_fragment_diagnostics(
          json!({
            "externalId": resolved.external_id,
            "operation": operation_name,
            "sequence": committed.sequence,
            "revision": committed.sequence,
            "affectedBlockIds": affected_block_ids,
            "updatedBlocks": super::document_semantics::private_blocks(&readback, workspace_id, auth, state).await,
            "readback": readback.status,
            "insertedBlockIds": committed.inserted_block_ids,
            "removedBlockIds": committed.removed_block_ids,
          }),
          &diagnostics,
        )),
        doc_id,
      ))
    })
    .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn parse_text_field(params: &Value) -> Result<Option<yjs::DocumentTextField>, HandlerError> {
  params
    .get("text_field")
    .map(|value| serde_json::from_value(value.clone()).map_err(|_| (-32602, "text_field must be text or title".into())))
    .transpose()
}

fn parse_replacement_spans(params: &Value) -> Result<Option<Vec<yjs::DocumentTextSegment>>, HandlerError> {
  params
    .get("replacement_spans")
    .map(|value| {
      if !valid_rich_field_spans(value) {
        return Err((-32602, "replacement_spans is invalid".into()));
      }
      serde_json::from_value(value.clone()).map_err(|_| (-32602, "replacement_spans is invalid".into()))
    })
    .transpose()
}

fn required_text_position(params: &Value, field: &str) -> Result<u32, HandlerError> {
  params
    .get(field)
    .and_then(Value::as_u64)
    .and_then(|value| u32::try_from(value).ok())
    .ok_or_else(|| (-32602, format!("{field} is required")))
}

fn parse_text_formatting(params: &Value) -> Result<myoxus_application::doc::DocumentTextFormatting, HandlerError> {
  let value = params
    .get("formatting")
    .ok_or_else(|| (-32602, "formatting is required".into()))?;
  if !value
    .as_object()
    .is_some_and(|fields| fields.values().all(|value| !value.is_null()))
  {
    return Err((-32602, "formatting must contain explicit non-null changes".into()));
  }
  let formatting = serde_json::from_value(value.clone()).map_err(|_| (-32602, "formatting is invalid".into()))?;
  myoxus_application::doc::normalize_text_formatting(formatting).map_err(map_mutation_error)
}

// Reject unrelated fields before idempotency admission or any native write.
fn validate_patch_arguments(params: &Value, operation: &str) -> Result<(), (i32, String)> {
  let invalid = || {
    (
      -32602,
      "MIX_MCP_DOCUMENT_PATCH_ARGUMENTS: invalid operation arguments".to_string(),
    )
  };
  let (required, optional, fragment) = crate::tool_registry::patch_operation_fields(operation).ok_or_else(invalid)?;
  let object = params.as_object().ok_or_else(invalid)?;
  let common = [
    "workspace_id",
    "external_id",
    "operation",
    "idempotency_key",
    "expected_revision",
  ];
  if object.keys().any(|key| {
    !common.contains(&key.as_str())
      && !required.contains(&key.as_str())
      && !optional.contains(&key.as_str())
      && !(fragment && ["fragment", "content_markdown", "strict_loss"].contains(&key.as_str()))
  }) || required.iter().any(|key| !object.contains_key(*key))
  {
    return Err(invalid());
  }
  if matches!(operation, "edit_text" | "edit_table_cell")
    && (object.contains_key("replacement") == object.contains_key("replacement_spans"))
  {
    return Err(invalid());
  }
  if matches!(operation, "format_text" | "edit_annotation")
    && (object.contains_key("row_id") != object.contains_key("column_id"))
  {
    return Err(invalid());
  }
  if operation == "edit_annotation"
    && ["annotation_id", "row_id", "column_id"].iter().any(|key| {
      object
        .get(*key)
        .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
    })
  {
    return Err(invalid());
  }
  if operation == "update_citation"
    && (object.get("new_label").is_some_and(|value| !value.is_string())
      || object.get("reference").is_some_and(|value| !value.is_object()))
  {
    return Err(invalid());
  }
  for key in ["block_id", "after_block_id", "parent_block_id", "heading", "title"] {
    if let Some(value) = object.get(key) {
      if value.as_str().is_none_or(|value| value.trim().is_empty()) {
        return Err(invalid());
      }
    }
  }
  for (key, max) in [
    ("annotation_id", 4096),
    ("title", 1024),
    ("heading", 512),
    ("replacement", 1048576),
    ("expected_text", 1048576),
    ("content_markdown", 1048576),
  ] {
    if object
      .get(key)
      .is_some_and(|value| value.as_str().is_none_or(|value| value.chars().count() > max))
    {
      return Err(invalid());
    }
  }
  if let Some(properties) = object.get("properties") {
    let properties = properties.as_object().ok_or_else(invalid)?;
    let valid = if matches!(
      operation,
      "update_table_row_properties" | "update_table_column_properties"
    ) {
      serde_json::from_value::<yjs::DocumentTableCoordinateProperties>(Value::Object(properties.clone())).is_ok()
    } else {
      serde_json::from_value::<yjs::DocumentBlockProperties>(Value::Object(properties.clone())).is_ok()
    };
    // Explicit clears use set/remove contracts, never null-as-omission.
    if properties.is_empty() || !valid || properties.values().any(Value::is_null) {
      return Err(invalid());
    }
    for (key, value) in properties {
      let valid = match key.as_str() {
        "headerRows" => value.as_u64().is_some(),
        "headingLevel" => value.as_u64().is_some_and(|value| (1..=6).contains(&value)),
        "listKind" => value
          .as_str()
          .is_some_and(|value| ["bulleted", "numbered", "todo"].contains(&value)),
        "checked" => value.is_boolean(),
        "language" => value.as_str().is_some_and(|value| value.chars().count() <= 128),
        "alt" | "title" | "url" => value.as_str().is_some_and(|value| value.chars().count() <= 4096),
        _ => true,
      };
      if !valid {
        return Err(invalid());
      }
    }
  }
  Ok(())
}

fn canonical_mutation_payload(
  workspace_id: uuid::Uuid,
  doc_id: uuid::Uuid,
  mutation: &DocumentMutation,
  confirm_replace_all: Option<bool>,
  expected_sequence: Option<i64>,
) -> Result<Value, (i32, String)> {
  let mutation = serde_json::to_value(mutation).map_err(|_| {
    (
      -32602,
      "MIX_MCP_IDEMPOTENCY_PAYLOAD_INVALID: document mutation cannot be serialized".to_string(),
    )
  })?;
  Ok(json!({
    "workspaceId": workspace_id,
    "internalDocId": doc_id,
    "mutation": mutation,
    "confirmReplaceAll": confirm_replace_all,
    "expectedRevision": expected_sequence,
  }))
}

pub(super) fn affected_block_ids(
  params: &Value,
  committed: &myoxus_application::doc::DocContentMutationCommit,
) -> Vec<String> {
  let mut ids = committed
    .inserted_block_ids
    .iter()
    .chain(committed.removed_block_ids.iter())
    .chain(committed.updated_block_ids.iter())
    .cloned()
    .collect::<Vec<_>>();
  if let Some(block_id) = params.get("block_id").and_then(Value::as_str) {
    ids.push(block_id.to_string());
  }
  ids.sort();
  ids.dedup();
  ids
}

async fn project_affected_blocks(
  workspace_id: uuid::Uuid,
  committed: &myoxus_application::doc::DocContentMutationCommit,
  affected_ids: &[String],
  auth: &McpAuthContext,
  state: &McpToolState,
) -> DocumentMutationReadback {
  if !can_read_mutation(workspace_id, committed.doc_id, auth, state).await {
    return DocumentMutationReadback::unavailable(MutationReadbackUnavailableReason::ReadAccessDenied);
  }
  let readback = DocumentContentProjectionService::new(
    state.doc_service.load.clone(),
    state.document_cursor_signing_key.clone(),
  )
  .with_html_catalog(state.html_catalog.clone())
  .with_max_output_bytes(state.document_export_max_bytes)
  .project_mutation(workspace_id, committed, affected_ids);
  if readback.requires_blob_read
    && assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsRead)
      .await
      .is_err()
  {
    return DocumentMutationReadback::unavailable(MutationReadbackUnavailableReason::AssetAccessDenied);
  }
  readback
}

async fn can_read_mutation(
  workspace_id: uuid::Uuid,
  doc_id: uuid::Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> bool {
  auth.has_scope("read:docs")
    && check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id)
      .await
      .is_ok()
    && resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id)
      .await
      .is_ok()
    && assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Read)
      .await
      .is_ok()
}

/// Replay retains its original commit's content, but never its old read grant.
/// Pre-upgrade responses lack a proven commit-bound projection and are explicit
/// unavailable results rather than a reread of today's document head.
async fn authorize_replayed_readback(
  mut response: Value,
  workspace_id: uuid::Uuid,
  doc_id: uuid::Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let mut payload = response
    .get("structuredContent")
    .cloned()
    .or_else(|| {
      response
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str(text).ok())
    })
    .ok_or_else(|| {
      (
        -32002,
        "MIX_MCP_IDEMPOTENCY_INVALID_RESPONSE: mutation readback is unavailable".to_string(),
      )
    })?;
  let reason = if !can_read_mutation(workspace_id, doc_id, auth, state).await {
    Some(MutationReadbackUnavailableReason::ReadAccessDenied)
  } else if payload.get("readback").is_none() {
    Some(MutationReadbackUnavailableReason::LegacyCommitUnavailable)
  } else if contains_image(&payload["updatedBlocks"])
    && assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsRead)
      .await
      .is_err()
  {
    Some(MutationReadbackUnavailableReason::AssetAccessDenied)
  } else {
    None
  };
  let changed = if let Some(reason) = reason {
    payload["updatedBlocks"] = json!([]);
    payload["readback"] = json!(MutationReadbackStatus::Unavailable { reason });
    true
  } else {
    super::document_semantics::redact_mentions(&mut payload, workspace_id, auth, state).await
  };
  if changed {
    response["content"] = mcp_json_response(payload.clone())["content"].clone();
    if response.get("structuredContent").is_some() {
      response["structuredContent"] = payload;
    }
  }
  Ok(response)
}

fn contains_image(value: &Value) -> bool {
  match value {
    Value::Object(object) => {
      object.get("kind").and_then(Value::as_str) == Some("image") || object.values().any(contains_image)
    }
    Value::Array(values) => values.iter().any(contains_image),
    _ => false,
  }
}

pub(super) fn parse_expected_sequence(params: &Value) -> Result<Option<i64>, (i32, String)> {
  match params.get("expected_revision") {
    None => Ok(None),
    Some(value) => value
      .as_i64()
      .filter(|value| *value >= 0)
      .map(Some)
      .ok_or_else(|| (-32602, "expected_revision must be a non-negative integer".to_string())),
  }
}

pub(super) async fn require_document_write_access(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<(uuid::Uuid, super::ResolvedExternalDocument), (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_id = required_non_empty(params, "external_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Update).await?;
  Ok((workspace_id, resolved))
}

pub(super) async fn parse_fragment(
  params: &Value,
  allow_empty: bool,
  workspace_id: uuid::Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<DocumentFragment, (i32, String)> {
  parse_fragment_with_diagnostics(params, allow_empty, workspace_id, auth, state)
    .await
    .map(|(fragment, _)| fragment)
}

pub(super) async fn parse_fragment_with_diagnostics(
  params: &Value,
  allow_empty: bool,
  workspace_id: uuid::Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<(DocumentFragment, DocumentFragmentDiagnostics), (i32, String)> {
  let references = match params.get("content_markdown").and_then(Value::as_str) {
    Some(markdown) if !markdown.trim().is_empty() => {
      Some(authorized_markdown_references(state, auth.user_id, workspace_id).await?)
    }
    _ => None,
  };
  let (mut fragment, diagnostics) = parse_fragment_resolved(params, allow_empty, references.as_ref())?;
  if params.get("fragment").is_some() {
    super::document_semantics::authorize_fragment(&mut fragment, workspace_id, auth, state).await?;
  }
  Ok((fragment, diagnostics))
}

fn parse_fragment_resolved(
  params: &Value,
  allow_empty: bool,
  references: Option<&myoxus_application::markdown::MarkdownReferenceLookup>,
) -> Result<(DocumentFragment, DocumentFragmentDiagnostics), (i32, String)> {
  let structured = params.get("fragment");
  let markdown = params.get("content_markdown");
  if structured.is_some() && markdown.is_some() {
    return Err((
      -32602,
      "MIX_MCP_DOCUMENT_FRAGMENT_AMBIGUOUS: specify fragment or content_markdown, not both".to_string(),
    ));
  }
  let strict = match params.get("strict_loss") {
    None => false,
    Some(value) => value
      .as_bool()
      .ok_or_else(|| (-32602, "strict_loss must be a boolean".into()))?,
  };
  let (fragment, diagnostics) = if let Some(value) = structured {
    validate_structured_fragment(value)?;
    (
      serde_json::from_value::<DocumentFragment>(value.clone())
        .map_err(|_| (-32602, "fragment does not match DocumentFragment".to_string()))?,
      DocumentFragmentDiagnostics::default(),
    )
  } else if let Some(markdown) = markdown.and_then(Value::as_str) {
    if markdown.chars().count() > 1_048_576 {
      return Err((-32602, "content_markdown exceeds its input bound".into()));
    }
    if markdown.trim().is_empty() {
      (
        DocumentFragment {
          schema_version: yjs::DOCUMENT_FRAGMENT_SCHEMA.to_string(),
          blocks: Vec::new(),
        },
        DocumentFragmentDiagnostics::default(),
      )
    } else {
      let references = references.ok_or_else(|| (-32002, "MIX_MCP_DOCUMENT_REFERENCE_LOOKUP_FAILED".to_string()))?;
      let imported =
        myoxus_application::markdown::prepare_markdown_import_with_references("Fragment", markdown, references)
          .map_err(|_| (-32602, "MIX_MCP_DOCUMENT_MARKDOWN_INVALID".to_string()))?;
      let (fragment, mut diagnostics) =
        document_fragment_from_yjs_with_diagnostics(&imported.yjs_binary).map_err(map_mutation_error)?;
      diagnostics.record_markdown(&imported.diagnostics);
      (fragment, diagnostics)
    }
  } else {
    return Err((-32602, "fragment is required".to_string()));
  };
  if fragment.schema_version != yjs::DOCUMENT_FRAGMENT_SCHEMA {
    return Err((
      -32602,
      format!("fragment.schemaVersion must be {}", yjs::DOCUMENT_FRAGMENT_SCHEMA),
    ));
  }
  if !allow_empty && fragment.blocks.is_empty() {
    return Err((-32602, "fragment must contain at least one block".to_string()));
  }
  if strict && diagnostics.diagnostic_count > 0 {
    return Err((
      -32602,
      "MIX_MCP_DOCUMENT_NORMALIZATION_LOSS: strict_loss rejected input normalization before writing".into(),
    ));
  }
  yjs::document_mutation::validate_mutation_fragment(&DocumentMutation::ReplaceAll {
    fragment: fragment.clone(),
  })
  .map_err(|_| (-32602, "fragment is invalid".to_string()))?;
  Ok((fragment, diagnostics))
}

fn fields(value: &Value, allowed: &[&str]) -> bool {
  value
    .as_object()
    .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}

fn valid_structured_spans(value: &Value) -> bool {
  value.as_array().is_some_and(|spans| {
    spans.iter().all(|span| {
      span.get("mention").is_none_or(|mention| {
        fields(mention, &["member"])
          && mention
            .get("member")
            .and_then(Value::as_str)
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
          && span.get("text").and_then(Value::as_str) == Some(" ")
          && ["reference", "footnote", "annotationId"]
            .iter()
            .all(|key| span.get(*key).is_none())
          && span.get("link").is_none_or(Value::is_null)
      }) && span.get("annotationId").is_none_or(|id| {
        id.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 4096)
          && span["text"].as_str().is_some_and(|text| !text.is_empty())
          && fields(
            span,
            &[
              "text",
              "annotationId",
              "bold",
              "italic",
              "strike",
              "code",
              "underline",
              "link",
            ],
          )
          && ["bold", "italic", "strike", "code", "underline"]
            .iter()
            .all(|key| span.get(*key).is_none_or(|value| value.as_bool() == Some(false)))
          && span.get("link").is_none_or(Value::is_null)
      }) && span.get("underline").is_none_or(Value::is_boolean)
        && ["color", "background", "labelTone"]
          .iter()
          .all(|key| span.get(*key).is_none_or(Value::is_string))
        && span.get("footnote").is_none_or(Value::is_object)
        && span.get("reference").is_none_or(|reference| {
          fields(reference, &["pageId", "title"])
            && reference
              .get("pageId")
              .and_then(Value::as_str)
              .is_some_and(|id| !id.trim().is_empty() && id.len() <= 4096)
            && reference.get("title").is_none_or(|v| {
              v.as_str()
                .is_some_and(|t| !t.trim().is_empty() && t.chars().count() <= 1024)
            })
            && span.get("text").and_then(Value::as_str) == Some(" ")
            && span.get("footnote").is_none()
            && span.get("link").is_none_or(Value::is_null)
        })
        && span.get("latex").is_none_or(|latex| {
          latex.as_str().is_some()
            && span.get("text").and_then(Value::as_str) == Some(" ")
            && span.get("link").is_none_or(Value::is_null)
            && span.get("reference").is_none()
            && span.get("footnote").is_none()
            && span.get("annotationId").is_none()
            && span.get("mention").is_none()
            && ["color", "background", "labelTone"]
              .iter()
              .all(|key| span.get(*key).is_none())
            && ["bold", "italic", "strike", "code", "underline"]
              .iter()
              .all(|key| span.get(*key).is_none_or(|value| value.as_bool() == Some(false)))
        })
        && fields(
          span,
          &[
            "text",
            "bold",
            "underline",
            "color",
            "background",
            "labelTone",
            "italic",
            "strike",
            "code",
            "link",
            "reference",
            "footnote",
            "annotationId",
            "mention",
            "latex",
          ],
        )
    })
  })
}

fn valid_rich_field_spans(value: &Value) -> bool {
  valid_structured_spans(value)
}

fn validate_structured_fragment(value: &Value) -> Result<(), HandlerError> {
  let invalid = || {
    (
      -32602,
      "MIX_MCP_DOCUMENT_FRAGMENT_UNSUPPORTED: unsupported structured shape".into(),
    )
  };
  fn block(value: &Value, depth: usize) -> bool {
    if depth > 64 {
      return false;
    }
    let allowed: &[&str] = match value["kind"].as_str() {
      Some("paragraph" | "quote") => &["kind", "spans", "text", "properties"],
      Some("heading") => &["kind", "level", "spans", "text", "properties"],
      Some("list_item") => &["kind", "listKind", "spans", "text", "checked", "children", "properties"],
      Some("callout") => &[
        "kind",
        "spans",
        "text",
        "properties",
        "calloutType",
        "title",
        "foldable",
        "defaultOpen",
        "children",
      ],
      Some("footnote_definition") => &["kind", "definitionId", "label", "placement", "children"],
      Some("citation_definition") => &["kind", "label", "reference"],
      Some("annotation") => &["kind", "text"],
      Some("code") => &["kind", "language", "text", "properties"],
      Some("latex") => &["kind", "latex"],
      Some("mermaid") => &["kind", "source", "title", "caption"],
      Some("divider") => &["kind"],
      Some("image") => &["kind", "source", "alt"],
      Some("bookmark") => &["kind", "url", "title"],
      Some("table") => &["kind", "rows", "headerRows", "properties"],
      _ => return false,
    };
    let text_valid = if matches!(
      value["kind"].as_str(),
      Some("paragraph" | "quote" | "heading" | "list_item" | "callout")
    ) {
      value
        .get("spans")
        .or_else(|| value.get("text"))
        .is_some_and(valid_structured_spans)
        && !(value.get("spans").is_some() && value.get("text").is_some())
    } else if value["kind"] == "table" {
      value["rows"].as_array().is_some_and(|rows| {
        value
          .get("headerRows")
          .is_none_or(|count| count.as_u64().is_some_and(|count| count <= rows.len() as u64))
          && rows.iter().all(|row| {
            row
              .as_array()
              .is_some_and(|cells| cells.iter().all(valid_structured_spans))
          })
      })
    } else {
      true
    };
    let native_fields_valid = match value["kind"].as_str() {
      Some("annotation") => value["text"].is_string(),
      Some("latex") => value["latex"].is_string(),
      Some("callout") => {
        ["calloutType", "title"]
          .iter()
          .all(|key| value.get(key).is_none_or(Value::is_string))
          && ["foldable", "defaultOpen"]
            .iter()
            .all(|key| value.get(key).is_none_or(Value::is_boolean))
      }
      Some("footnote_definition") => {
        value["definitionId"].as_str().is_some_and(|id| !id.is_empty())
          && value["label"].as_str().is_some_and(|label| !label.is_empty())
          && value
            .get("placement")
            .is_none_or(|placement| matches!(placement.as_str(), Some("footnote" | "endnote")))
          && value["children"].is_array()
      }
      Some("citation_definition") => {
        value["label"].as_str().is_some_and(|label| !label.is_empty()) && value["reference"].is_object()
      }
      _ => true,
    };
    value
      .get("properties")
      .is_none_or(|p| p.as_object().is_some_and(|p| !p.is_empty()))
      && fields(value, allowed)
      && native_fields_valid
      && text_valid
      && value.get("children").is_none_or(|children| {
        children
          .as_array()
          .is_some_and(|children| children.iter().all(|child| block(child, depth + 1)))
      })
  }
  if !fields(value, &["schemaVersion", "blocks"])
    || !value["blocks"]
      .as_array()
      .is_some_and(|blocks| blocks.iter().all(|value| block(value, 0)))
  {
    return Err(invalid());
  }
  Ok(())
}

pub(super) fn with_fragment_diagnostics(mut payload: Value, diagnostics: &DocumentFragmentDiagnostics) -> Value {
  if diagnostics.diagnostic_count > 0 {
    payload["normalizationDiagnostics"] = json!(diagnostics.diagnostics);
    payload["normalizationDiagnosticCount"] = json!(diagnostics.diagnostic_count);
    payload["normalizationDiagnosticsTruncated"] = json!(diagnostics.diagnostic_count > diagnostics.diagnostics.len());
  }
  payload
}

/// Persist the same bounded warnings with the atomic fallback receipt. A crash
/// after commit must not turn a lossy accepted input into a silent success.
pub(super) fn fragment_response_builder(
  params: &Value,
  diagnostics: &DocumentFragmentDiagnostics,
) -> myoxus_application::mcp::McpDocumentResponseBuilder {
  let params = params.clone();
  let diagnostics = diagnostics.clone();
  std::sync::Arc::new(move |commit| {
    let mut response = super::document_replay_response(&params, commit)?;
    let payload = super::mcp_result_payload(&response)
      .ok_or_else(|| AuthError::InvalidInput("MIX_MCP_IDEMPOTENCY_INVALID_RESPONSE".into()))?;
    response["content"] = mcp_json_response(with_fragment_diagnostics(payload, &diagnostics))["content"].clone();
    Ok(response)
  })
}

fn required_non_empty(params: &Value, field: &str) -> Result<String, (i32, String)> {
  let value = params
    .get(field)
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| (-32602, format!("{field} is required")))?;
  Ok(value.to_string())
}

pub(super) fn map_mutation_error(error: AuthError) -> (i32, String) {
  match error {
    AuthError::InvalidInput(code) if code.starts_with("MIX_DOCUMENT_MUTATION_CONFLICT") => (-32009, code),
    AuthError::InvalidInput(code) if code == "MIX_DOCUMENT_MUTATION_TARGET_NOT_FOUND" => (-32004, code),
    AuthError::InvalidInput(code) if code.starts_with("MIX_") => (-32602, code),
    AuthError::NotFound(_) => (-32004, "MIX_MCP_DOCUMENT_NOT_FOUND: document not found".to_string()),
    AuthError::ActionForbidden => (
      -32003,
      "MIX_MCP_DOCUMENT_FORBIDDEN: document update forbidden".to_string(),
    ),
    _ => (
      -32002,
      "MIX_MCP_DOCUMENT_MUTATION_FAILED: document mutation failed".to_string(),
    ),
  }
}

fn parse_representation(params: &Value) -> Result<DocumentRepresentation, (i32, String)> {
  if params.get("representation").is_some() && params.get("format").is_some() {
    return Err((
      -32602,
      "MIX_MCP_DOCUMENT_REPRESENTATION_AMBIGUOUS: specify representation or the deprecated format alias, not both"
        .to_string(),
    ));
  }
  let value = params
    .get("representation")
    .or_else(|| params.get("format"))
    .and_then(Value::as_str)
    .unwrap_or("structured");
  match value {
    "structured" if params.get("format").is_none() => Ok(DocumentRepresentation::Structured),
    "html" if params.get("format").is_none() => Ok(DocumentRepresentation::Html),
    "markdown" => Ok(DocumentRepresentation::Markdown),
    "plain_text" => Ok(DocumentRepresentation::PlainText),
    "raw_yjs" => Ok(DocumentRepresentation::RawYjs),
    _ => Err((
      -32602,
      "representation must be structured, html, markdown, plain_text or raw_yjs".to_string(),
    )),
  }
}

fn parse_document_selector(
  params: &Value,
  representation: DocumentRepresentation,
) -> Result<(Option<DocumentSelector>, usize), HandlerError> {
  let invalid = || {
    (-32602, "MIX_MCP_DOCUMENT_SELECTION_INVALID: use one structured block_id, heading_block_id or outline selector; neighbor_context requires a block or section and is limited to 10".to_string())
  };
  let mut selector = None;
  for (key, section) in [("block_id", false), ("heading_block_id", true)] {
    if let Some(value) = params.get(key) {
      let id = value.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?;
      if selector.is_some() {
        return Err(invalid());
      }
      selector = Some(if section {
        DocumentSelector::Section(id.to_string())
      } else {
        DocumentSelector::Block(id.to_string())
      });
    }
  }
  if let Some(outline) = params.get("outline") {
    if outline != &Value::Bool(true) || selector.is_some() {
      return Err(invalid());
    }
    selector = Some(DocumentSelector::Outline);
  }
  let neighbors = params
    .get("neighbor_context")
    .map(|value| {
      value
        .as_u64()
        .filter(|value| *value <= 10)
        .map(|value| value as usize)
        .ok_or_else(invalid)
    })
    .transpose()?
    .unwrap_or(0);
  if (selector.is_some() && representation != DocumentRepresentation::Structured)
    || (params.get("neighbor_context").is_some() && (selector.is_none() || selector == Some(DocumentSelector::Outline)))
  {
    return Err(invalid());
  }
  Ok((selector, neighbors))
}

fn map_projection_error(error: DocumentProjectionError) -> (i32, String) {
  match error {
    DocumentProjectionError::InvalidCursor => (
      -32602,
      "MIX_MCP_DOCUMENT_CURSOR_INVALID: projection cursor is invalid".to_string(),
    ),
    DocumentProjectionError::StaleCursor => (
      -32602,
      "MIX_MCP_DOCUMENT_CURSOR_STALE: document changed after the cursor was issued".to_string(),
    ),
    DocumentProjectionError::InvalidSelector => (
      -32602,
      "MIX_MCP_DOCUMENT_SELECTION_INVALID: selection is invalid".to_string(),
    ),
    DocumentProjectionError::SelectedBlockNotFound => (
      -32602,
      "MIX_MCP_DOCUMENT_BLOCK_NOT_FOUND: selected native content block was not found".to_string(),
    ),
    DocumentProjectionError::InvalidPageSize => (
      -32602,
      "MIX_MCP_DOCUMENT_PAGE_SIZE_INVALID: limit must be between 1 and 200".to_string(),
    ),
    DocumentProjectionError::BlockTooLarge { block_id } => (
      -32002,
      format!("MIX_MCP_DOCUMENT_BLOCK_TOO_LARGE: projected block '{block_id}' exceeds the server limit"),
    ),
    DocumentProjectionError::ExportTooLarge => (
      -32002,
      "MIX_MCP_DOCUMENT_EXPORT_TOO_LARGE: document export exceeds the configured output limit".to_string(),
    ),
    DocumentProjectionError::Load | DocumentProjectionError::Projection => (
      -32002,
      "MIX_MCP_DOCUMENT_PROJECTION_FAILED: document projection failed".to_string(),
    ),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn structured_formula_authoring_rejects_coalesced_or_formatted_atoms() {
    assert!(valid_structured_spans(&json!([{"text":" ","latex":"x^2"}])));
    for extra in [
      json!({"text":"  "}),
      json!({"bold":true}),
      json!({"code":true}),
      json!({"color":"red"}),
      json!({"background":"blue"}),
      json!({"labelTone":"accent"}),
      json!({"nativeLatexAttributes":{"underline":true}}),
    ] {
      let mut span = json!({"text":" ","latex":"x^2"});
      span.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
      assert!(!valid_structured_spans(&json!([span])));
    }
  }

  #[test]
  fn typed_text_formatting_rejects_unknown_null_and_empty_attribute_changes() {
    for value in [
      json!({}),
      json!({"bold":null}),
      json!({"bold":"true"}),
      json!({"latex":"x^2"}),
      json!({"reference":{}}),
      json!({"link":{"action":"remove","href":"ignored"}}),
      json!({"link":{"action":"set","href":"javascript:private"}}),
      json!({"underline":null}),
      json!({"color":{"action":"remove","value":"red"}}),
      json!({"background":{"action":"set","value":"var(--unowned)"}}),
      json!({"labelTone":{"action":"set","value":"blue"}}),
    ] {
      assert!(
        parse_text_formatting(&json!({"formatting":value})).is_err(),
        "unsupported formatting accepted: {value}"
      );
    }
    let formatting = parse_text_formatting(
      &json!({"formatting":{"bold":false,"code":true,"link":{"action":"set","href":" HTTPS://example.test "}}}),
    )
    .unwrap();
    assert_eq!(formatting.bold, Some(false));
    assert_eq!(formatting.code, Some(true));
    assert_eq!(
      formatting.link,
      Some(myoxus_application::doc::DocumentTextLinkChange::Set {
        href: "https://example.test/".into()
      })
    );
    assert!(parse_text_formatting(&json!({"formatting":{"link":{"action":"remove"}}})).is_ok());
  }

  #[test]
  fn revision_precondition_is_optional_but_supplied_values_are_never_ignored() {
    assert_eq!(parse_expected_sequence(&json!({})).unwrap(), None);
    for revision in [0, 1, i64::MAX] {
      assert_eq!(
        parse_expected_sequence(&json!({"expected_revision":revision})).unwrap(),
        Some(revision)
      );
    }
    for revision in [Value::Null, json!(-1), json!(0.5), json!("1"), json!(u64::MAX)] {
      assert_eq!(
        parse_expected_sequence(&json!({"expected_revision":revision}))
          .unwrap_err()
          .0,
        -32602
      );
    }
  }

  #[test]
  fn representation_alias_is_bounded_and_ambiguous_input_is_rejected() {
    assert_eq!(
      parse_representation(&json!({"format": "markdown"})).unwrap(),
      DocumentRepresentation::Markdown
    );
    assert!(parse_representation(&json!({"format": "structured"})).is_err());
    let error = parse_representation(&json!({"representation": "html", "format": "markdown"})).unwrap_err();
    assert!(error.1.starts_with("MIX_MCP_DOCUMENT_REPRESENTATION_AMBIGUOUS"));
  }

  #[test]
  fn empty_markdown_is_an_explicit_empty_replace_fragment() {
    let (fragment, _) = parse_fragment_resolved(&json!({"content_markdown": "  \n"}), true, None).unwrap();
    assert!(fragment.blocks.is_empty());
    assert!(parse_fragment_resolved(&json!({"content_markdown": ""}), false, None).is_err());
  }

  #[test]
  fn unsupported_html_maps_to_payload_free_markdown_error() {
    let references = myoxus_application::markdown::MarkdownReferenceLookup::new(
      "https://myoxus.test/workspace/test",
      std::iter::empty(),
    )
    .unwrap();
    let error = parse_fragment_resolved(
      &json!({"content_markdown": "valid\n\n<div data-secret='hidden'>unsafe</div>"}),
      true,
      Some(&references),
    )
    .expect_err("raw HTML must fail before mutation");
    assert_eq!(error, (-32602, "MIX_MCP_DOCUMENT_MARKDOWN_INVALID".to_string()));
    assert!(!error.1.contains("hidden"));
  }
}
