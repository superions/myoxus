// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP create/poll adapters over the authoritative PDF and history owners.

use super::{
  McpAuthContext, McpToolState, assert_doc_permission, assert_workspace_permission, begin_mcp_idempotency_with_payload,
  finish_or_abort_mcp_write, mcp_json_response, mcp_result_string, resolve_external_document_for_mcp,
  resolve_external_document_ids_for_mcp, with_internal_document_identity,
};
use myoxus_application::{
  audit::AuditActor,
  auth::AuthError,
  mcp::{McpDocumentResponseBuilder, McpDocumentWriteCommit},
  pdf_export::{
    error::PdfExportError,
    jobs::PdfExportJob,
    service::{PdfExportCreateRequest, PdfExportService, ReplayablePdfSource},
  },
};
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

type HandlerError = (i32, String);

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CreateParams {
  workspace_id: Uuid,
  external_id: String,
  idempotency_key: String,
  template_id: Option<String>,
  locale: Option<String>,
  paper_size: Option<String>,
  orientation: Option<String>,
  image_quality: Option<String>,
  compliance_profile: Option<String>,
  cover_page: Option<bool>,
  toc_behavior: Option<String>,
  footer_style: Option<String>,
  page_numbering: Option<String>,
  color_variant: Option<String>,
  confidentiality_label: Option<String>,
  document_version_id: Option<String>,
  typed_inputs: Option<Value>,
}

fn service(state: &McpToolState) -> Result<Arc<PdfExportService>, HandlerError> {
  state
    .pdf_export_service
    .clone()
    .ok_or_else(|| (-32002, "PDF export service is not configured".into()))
}

pub(super) async fn create(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, HandlerError> {
  let mut input: CreateParams = serde_json::from_value(params.clone()).map_err(|error| (-32602, error.to_string()))?;
  if input.template_id.as_ref().is_some_and(|value| value.trim().is_empty()) {
    return Err((
      -32602,
      "template_id must not be empty; omit it to consume the workspace default".into(),
    ));
  }
  if let Some(selector) = input.document_version_id.as_mut() {
    *selector = selector.trim().to_owned();
    if !selector.is_empty() && selector != "latest" {
      *selector = Uuid::parse_str(selector)
        .map_err(|_| (-32602, "document_version_id must be latest or a version UUID".into()))?
        .to_string();
    }
    if selector.is_empty() {
      input.document_version_id = None;
    }
  }
  assert_workspace_permission(state, auth.user_id, input.workspace_id, WorkspaceAction::Read).await?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, input.workspace_id, &input.external_id).await?;
  assert_doc_permission(
    state,
    auth.user_id,
    input.workspace_id,
    resolved.internal_id,
    DocAction::Read,
  )
  .await?;
  let service = service(state)?;
  service
    .assert_create_access(auth.user_id, input.workspace_id, resolved.internal_id)
    .await
    .map_err(map_error)?;
  if !state.idempotency.document_transaction_recovery() {
    return Err((-32002, "Durable PDF export idempotency is not configured".into()));
  }
  let mut semantic =
    serde_json::to_value(&input).map_err(|_| (-32602, "PDF arguments could not be normalized".into()))?;
  semantic
    .as_object_mut()
    .expect("typed parameter object")
    .remove("idempotency_key");
  semantic["external_id"] = json!(resolved.internal_id);
  let guard =
    match begin_mcp_idempotency_with_payload("pdf_export_create", params, Some(&semantic), auth, state).await? {
      Ok(guard) => guard,
      Err(response) => {
        let id = mcp_result_string(&response, "jobId")
          .and_then(|value| Uuid::parse_str(&value).ok())
          .ok_or_else(|| (-32002, "PDF replay job identity is unavailable".into()))?;
        service
          .resume_queued(AuditActor::api_key(auth.user_id, auth.key_id), auth.user_id, id)
          .await
          .map_err(map_error)?;
        return Ok(response);
      }
    };
  let source = ReplayablePdfSource {
    request_key: Uuid::new_v5(
      &auth.key_id,
      format!("myoxus:pdf-export-source:{}", input.idempotency_key).as_bytes(),
    ),
    fingerprint: hex::decode(crate::idempotency::payload_sha256(&semantic)?).expect("SHA-256 hex"),
  };
  let request = PdfExportCreateRequest {
    workspace_id: input.workspace_id,
    doc_id: resolved.internal_id,
    template_id: input.template_id.unwrap_or_default(),
    locale: input.locale,
    paper_size: input.paper_size,
    orientation: input.orientation,
    image_quality: input.image_quality,
    compliance_profile: input.compliance_profile,
    cover_page: input.cover_page,
    toc_behavior: input.toc_behavior,
    footer_style: input.footer_style,
    page_numbering: input.page_numbering,
    color_variant: input.color_variant,
    confidentiality_label: input.confidentiality_label,
    typed_inputs: input.typed_inputs,
    document_version_id: input.document_version_id,
  };
  let origin = state.server_origin.clone();
  let external_id = resolved.external_id;
  let builder: McpDocumentResponseBuilder = Arc::new(move |commit| {
    let McpDocumentWriteCommit::PdfExport(job) = commit else {
      return Err(AuthError::InvalidInput("unexpected PDF receipt owner".into()));
    };
    Ok(with_internal_document_identity(
      mcp_json_response(job_value(job, &external_id, &origin)),
      job.doc_id,
    ))
  });
  let state = state.clone();
  let auth = auth.clone();
  // The admitted render owns completion even if the HTTP waiter disconnects.
  // Its source and final response use the existing history/job transactions;
  // periodic renewal prevents a long bounded render from losing admission.
  let task = tokio::spawn(async move {
    let row_id = match &guard {
      crate::idempotency::Guard::Pending { row_id, .. } => *row_id,
      _ => return Err((-32002, "Durable PDF admission is required".into())),
    };
    let result = {
      let operation = guard.document_write_with_response(&auth, builder.clone(), async {
        let job = service
          .create_replayable(
            AuditActor::api_key(auth.user_id, auth.key_id),
            auth.user_id,
            request,
            source,
          )
          .await
          .map_err(map_error)?;
        builder(McpDocumentWriteCommit::PdfExport(&job))
          .map_err(|_| (-32002, "PDF result could not be serialized".into()))
      });
      tokio::pin!(operation);
      // Renewal can wait on the receipt lock held by the job transaction.
      // Poll it alongside completion rather than awaiting it inside a branch,
      // which would prevent the lock holder from making progress.
      let renewal = async {
        loop {
          tokio::time::sleep(std::time::Duration::from_secs(15)).await;
          if !matches!(state.idempotency.renew(row_id).await, Ok(true)) {
            return Err((
              -32002,
              "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED: PDF admission renewal failed; retry the same key".into(),
            ));
          }
        }
      };
      tokio::pin!(renewal);
      tokio::select! {
        result = &mut operation => result,
        failure = &mut renewal => failure,
      }
    };
    finish_or_abort_mcp_write(guard, &state, &auth, result).await
  });
  task.await.map_err(|_| {
    (
      -32002,
      "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED: PDF completion was interrupted; retry the same key".into(),
    )
  })?
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetParams {
  job_id: Uuid,
}

pub(super) async fn get(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, HandlerError> {
  let input: GetParams = serde_json::from_value(params.clone()).map_err(|error| (-32602, error.to_string()))?;
  let service = service(state)?;
  let job = service.get(auth.user_id, input.job_id).await.map_err(map_error)?;
  assert_workspace_permission(state, auth.user_id, job.workspace_id, WorkspaceAction::Read).await?;
  assert_doc_permission(state, auth.user_id, job.workspace_id, job.doc_id, DocAction::Read).await?;
  let ids = resolve_external_document_ids_for_mcp(&state.doc_service, job.workspace_id, &[job.doc_id]).await?;
  let external_id = ids
    .get(&job.doc_id)
    .ok_or_else(|| (-32004, "Document not found".into()))?;
  Ok(with_internal_document_identity(
    mcp_json_response(job_value(&job, external_id, &state.server_origin)),
    job.doc_id,
  ))
}

fn job_value(job: &PdfExportJob, external_id: &str, origin: &str) -> Value {
  let available = job.status == "done"
    && job.output_blob_id.is_some()
    && !job.expires_at.is_some_and(|expiry| expiry <= chrono::Utc::now());
  let url = available.then(|| format!("{}/api/pdf-export/{}/download", origin.trim_end_matches('/'), job.id));
  let revision = job
    .render_inputs
    .get("source_content_sha256")
    .and_then(Value::as_str)
    .map(|digest| json!({"kind":"yjs_sha256", "value": digest}));
  let report = job.render_inputs.get("renderer_diagnostics").and_then(Value::as_array);
  let findings = bounded_findings(report);
  json!({
    "jobId": job.id, "workspaceId": job.workspace_id, "externalId": external_id,
    "templateId": job.template_id, "status": job.status, "execution":job.sync_or_async,
    "createdAt":job.created_at, "startedAt":job.started_at, "finishedAt":job.finished_at,
    "artifactExpiresAt":job.expires_at, "pageCount":job.page_count, "errorClass":job.error_class,
    "source":{"documentVersionId":job.render_inputs.get("document_version_id"),
      "versionLabel":job.render_inputs.get("version_label"), "historyId":job.render_inputs.get("doc_history_id"), "revision":revision},
    "delivery":{"available":available,"url":url,"authentication":"session_or_api_key","apiKeyScope":"read:docs"},
    "diagnostics":{"unmappedFontFamilies":job.unmapped_font_families.iter().take(32).map(|name| name.chars().take(256).collect::<String>()).collect::<Vec<_>>(),
      "findings":findings,
      "coverage":if report.is_some() {"pipeline_reported"} else if matches!(job.status.as_str(), "queued" | "running") {"pending"} else {"unavailable"}},
  })
}

fn bounded_findings(report: Option<&Vec<Value>>) -> Vec<Value> {
  report
    .into_iter()
    .flatten()
    .filter_map(|entry| {
      let code = entry.get("code")?.as_str()?;
      if !matches!(code, "missing_asset" | "unsupported_block" | "missing_canvas_snapshot") {
        return None;
      }
      Some(json!({"code":code, "count":entry.get("count")?.as_u64()?}))
    })
    .take(3)
    .collect()
}

fn map_error(error: PdfExportError) -> HandlerError {
  if error.authorization.is_some() {
    return (-32003, "Permission denied: PDF export access required".into());
  }
  if error.message.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED") {
    return (-32002, error.message);
  }
  if error.message == "job not found" {
    return (-32004, error.message);
  }
  if let Some(details) = error.extensions {
    match details.0.get("class").and_then(Value::as_str) {
      Some("Forbidden") => return (-32003, "Permission denied: PDF template access required".into()),
      Some("Throttled") => return (-32002, "PDF workspace render capacity is unavailable".into()),
      // Admission validation uses this class too; its field contract must stay
      // actionable instead of being mistaken for a compiler failure.
      Some("UnsupportedComplianceProfile")
        if details.0.get("field").and_then(Value::as_str) == Some("compliance_profile") =>
      {
        return (-32602, json!({"message":error.message,"details":details.0}).to_string());
      }
      Some(
        class @ ("TooLarge"
        | "Timeout"
        | "RenderError"
        | "DecodeError"
        | "AssetError"
        | "TemplateError"
        | "StorageError"
        | "UnsupportedComplianceProfile"
        | "PdfaValidationFailed"
        | "PdfuaValidationFailed"
        | "MemoryLimit"),
      ) => {
        let report = details.0.get("renderer_diagnostics").and_then(Value::as_array);
        // Only the established class and bounded counts cross this boundary;
        // compiler source, storage errors and private asset paths stay private.
        return (
          -32012,
          json!({"class":class, "diagnostics":{
            "coverage":if report.is_some() {"pipeline_reported"} else {"unavailable"},
            "findings":bounded_findings(report)
          }})
          .to_string(),
        );
      }
      _ => {}
    }
    return (-32602, json!({"message":error.message,"details":details.0}).to_string());
  }
  (-32002, "PDF export service could not complete the operation".into())
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::pdf_export::error::PdfExportErrorDetails;

  #[test]
  fn synchronous_pipeline_classes_keep_safe_pdf_failure_results() {
    for class in [
      "TooLarge",
      "Timeout",
      "RenderError",
      "DecodeError",
      "AssetError",
      "TemplateError",
      "StorageError",
      "UnsupportedComplianceProfile",
      "PdfaValidationFailed",
      "PdfuaValidationFailed",
      "MemoryLimit",
    ] {
      let mut details = PdfExportErrorDetails::default();
      details.set("class", class);
      details.set("private_source", "private compiler source /private/asset");
      details.set(
        "renderer_diagnostics",
        json!([
          {"code":"missing_asset", "count":2, "path":"/private/asset"},
          {"code":"private_extension", "count":1}
        ]),
      );
      let mut error = PdfExportError::new("private compiler source /private/asset");
      error.extensions = Some(details);
      let (code, message) = map_error(error);
      assert_eq!(code, -32012, "pipeline class {class}");
      let result: Value = serde_json::from_str(&message).expect("bounded failure JSON");
      assert_eq!(
        result,
        json!({"class":class, "diagnostics":{
          "coverage":"pipeline_reported", "findings":[{"code":"missing_asset","count":2}]
        }}),
      );
      assert!(!message.contains("private"));
    }

    let mut details = PdfExportErrorDetails::default();
    details.set("field", "paper_size");
    let mut invalid = PdfExportError::new("invalid paper_size");
    invalid.extensions = Some(details);
    let (code, message) = map_error(invalid);
    assert_eq!(code, -32602, "canonical field errors stay actionable");
    assert_eq!(
      serde_json::from_str::<Value>(&message).unwrap()["details"]["field"],
      "paper_size"
    );

    let mut details = PdfExportErrorDetails::default();
    details.set("class", "UnsupportedComplianceProfile");
    details.set("field", "compliance_profile");
    let mut invalid = PdfExportError::new("unsupported compliance_profile");
    invalid.extensions = Some(details);
    let (code, message) = map_error(invalid);
    assert_eq!(code, -32602, "unsupported input profiles retain field validation");
    let result: Value = serde_json::from_str(&message).unwrap();
    assert_eq!(result["details"]["field"], "compliance_profile");
    assert_eq!(result["details"]["class"], "UnsupportedComplianceProfile");
  }
}
