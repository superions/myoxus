// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authoritative create/get PDF orchestration shared by transport adapters.
//! History and cancellation retain their existing owners.
use super::{
  dispatch::*,
  error::{PdfExportError, PdfExportErrorDetails, Result},
  jobs::{CompletedPdfExportJobInsert, PdfExportJob, PdfExportJobInsert, PdfExportJobStore},
  render::SyncRenderOutcome,
};
use crate::{
  audit::AuditRecorder,
  doc::DocService,
  permission::{AccessController, PermissionService},
};
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::entities::{DocumentVersion, DocumentVersionEvent, DocumentVersionKind};
use myoxus_domain::repositories::*;
use myoxus_pdf_export::template_v2::LoadedTemplate;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

/// Startup defaults only. Live render limits stay with the existing worker adapter.
#[derive(Clone, Debug)]
pub struct PdfExportDefaults {
  pub default_paper_size: String,
  pub default_color_profile: String,
  pub default_image_quality: String,
  pub heading_font_scale: f64,
  pub body_font_scale: f64,
  pub main_web_locale: String,
  pub max_concurrent_per_workspace: i64,
  pub sync_threshold_blocks: usize,
}

/// An immutable PDF source uses the established history capture request ledger.
/// Its key survives MCP admission recovery, so a crashed render cannot recapture
/// a later document state or create a second automatic named version.
#[derive(Clone)]
pub struct ReplayablePdfSource {
  pub request_key: Uuid,
  pub fingerprint: Vec<u8>,
}

pub struct PdfEnqueueOutcome {
  pub id: String,
  pub created: bool,
}

/// Ports materialize existing Infrastructure/Worker capabilities; they own no job policy.
#[async_trait::async_trait]
pub trait PdfExportBackend: Send + Sync {
  fn ensure_database(&self) -> Result<()>;
  async fn theme(&self, workspace_id: Uuid) -> Result<PdfThemeContext>;
  async fn template(&self, selector: &str) -> Result<LoadedTemplate>;
  async fn render(&self, request: PdfExportRenderRequest) -> Result<SyncRenderOutcome>;
  async fn render_snapshot(
    &self,
    _request: PdfExportRenderRequest,
    _source: Vec<u8>,
    _created_at: chrono::DateTime<chrono::Utc>,
  ) -> Result<super::render::SnapshotRenderedPdf> {
    Err(PdfExportError::new("Snapshot rendering is unavailable"))
  }
  /// Remove only an artifact whose job transaction is confirmed rolled back.
  async fn remove_unpublished_pdf(&self, workspace_id: Uuid, blob_id: Uuid) -> Result<()>;
  /// None means the existing queue-less fixture mode; production always supplies a queue.
  async fn enqueue(
    &self,
    payload: serde_json::Value,
    stable_job_id: Option<Uuid>,
  ) -> std::result::Result<Option<PdfEnqueueOutcome>, String>;
}

pub struct PdfExportRenderRequest {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub render_inputs: serde_json::Value,
  pub input: PdfExportDispatchInput,
  pub theme: PdfThemeContext,
  pub sync_threshold_blocks: usize,
  pub template_files: Option<std::collections::HashMap<String, Vec<u8>>>,
}

#[derive(Clone)]
pub struct PdfExportService {
  pub permission: Arc<PermissionService>,
  pub doc: DocService,
  pub jobs: Arc<dyn PdfExportJobStore>,
  pub pdf_template_repo: Option<Arc<dyn PdfTemplateRepository>>,
  pub pdf_assignment_repo: Option<Arc<dyn PdfWorkspaceTemplateAssignmentRepository>>,
  pub pdf_render_audit_repo: Option<Arc<dyn PdfExportRenderAuditRepository>>,
  pub document_version_repo: Option<Arc<dyn DocumentVersionRepository>>,
  pub document_version_settings_repo: Option<Arc<dyn DocumentVersioningSettingsRepository>>,
  pub document_metadata_policy_repo: Option<Arc<dyn DocumentMetadataPolicyRepository>>,
  pub document_metadata_service: Option<crate::document_metadata::DocumentMetadataService>,
  pub audit: AuditRecorder,
  pub defaults: PdfExportDefaults,
  pub backend: Arc<dyn PdfExportBackend>,
}
#[derive(Clone, Debug)]
pub struct PdfExportCreateRequest {
  /// Resolved workspace identity.
  pub workspace_id: Uuid,
  /// Document identity resolved through the workspace-scoped document key owner.
  pub doc_id: Uuid,
  /// Template selector — accepts the kebab-case slug
  /// (`"default"`/`"report"`/`"letter"`) or a UUID. The slug path is
  /// preserved for backward compat with clients that have not migrated
  /// to UUIDs; both forms resolve through the V2 registry.
  pub template_id: String,
  /// Override locale (BCP-47, e.g. `"de-AT"`). Falls through to the
  /// brand default and finally to the server default when `None`.
  pub locale: Option<String>,
  /// Per-render override for the paper size: `"A4"`, `"Letter"`, `"A3"`,
  /// `"A5"`, or `"16:9"`. The renderer consumes these V2 literals directly.
  pub paper_size: Option<String>,
  /// Page orientation. Always available independent of template capabilities.
  /// Defaults to portrait for every export.
  pub orientation: Option<String>,
  /// Image quality tier. Accepts `"low"` / `"med"` / `"high"` /
  /// `"lossless"`. This per-render value overrides `pdf_export_settings`
  /// and is persisted in the render-input/audit snapshot.
  pub image_quality: Option<String>,
  /// Omitted/blank profiles resolve to PDF/A-2u for new admission only.
  /// Captured jobs and matching receipts retain their original writer.
  /// Accepted values are
  /// `"standard"`, `"pdfa-1b"`, `"pdfa-2b"`, `"pdfa-2u"`, `"pdfa-3b"` and
  /// `"pdfua-1"`. PDF/X is intentionally not accepted until the renderer
  /// has a proven PDF/X output path.
  pub compliance_profile: Option<String>,
  /// Cover-page override; absence uses the selected template default.
  pub cover_page: Option<bool>,
  /// TOC behavior — `"off"` / `"auto"` / `"force"`.
  pub toc_behavior: Option<String>,
  /// Footer layout from the selected template capability; absence keeps its default.
  pub footer_style: Option<String>,
  /// Page-number format independent of the selected footer layout.
  pub page_numbering: Option<String>,
  /// Color treatment applied to the effective document palette.
  pub color_variant: Option<String>,
  /// Confidentiality watermark label. Must be present in the
  /// manifest's `confidentialityLabels` allowed-set.
  pub confidentiality_label: Option<String>,
  /// Free-form template inputs validated against the manifest's
  /// `inputs_schema`. Persisted on `pdf_export_render_audit.l3_inputs`
  /// for compliance.
  pub typed_inputs: Option<serde_json::Value>,
  /// Document-version selector from the export dialog.
  ///
  /// `latest` means "current document state"; if document versioning is
  /// enabled and `on_pdf_export` is configured, the server captures a named
  /// snapshot before rendering. A UUID pins the render to that named version's
  /// DocHistory snapshot.
  pub document_version_id: Option<String>,
}

async fn load_pdf_export_metadata_snapshot(
  state: &PdfExportService,
  workspace_id: Uuid,
  doc_id: Uuid,
  version_override: Option<&DocumentVersion>,
) -> Result<(serde_json::Value, serde_json::Value)> {
  use crate::document_metadata::{
    DocumentMetadataProjectionMode, DocumentMetadataServiceError, DocumentMetadataValidationService,
  };
  use crate::document_metadata_policy::DocumentMetadataAction;

  let repo = state
    .document_metadata_policy_repo
    .clone()
    .ok_or_else(|| PdfExportError::new("document metadata repository is not configured on this server"))?;
  let definitions = repo
    .list_metadata_field_definitions()
    .await
    .map_err(|e| PdfExportError::new(e.to_string()))?;
  let metadata_service = state
    .document_metadata_service
    .clone()
    .ok_or_else(|| PdfExportError::new("document metadata service is not configured on this server"))?;
  let projection = metadata_service
    .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
    .await
    .map_err(|e| match e {
      DocumentMetadataServiceError::NotFound => {
        validation_error("document is not available in this workspace", "doc_id")
      }
      other => PdfExportError::new(other.to_string()),
    })?;
  let validation =
    DocumentMetadataValidationService::new().validate(&definitions, &projection, DocumentMetadataAction::ExportPdf);
  if !validation.valid() {
    warn!(
      workspace_id = %workspace_id,
      doc_id = %doc_id,
      missing = ?validation.missing_required_metadata_fields,
      blocked_actions = ?validation.blocked_actions,
      "pdf export blocked by document-metadata validation"
    );
    return Err(document_metadata_export_error(&validation));
  }

  let current_version = if let Some(version) = version_override {
    Some(version.clone())
  } else if let Some(version_repo) = state.document_version_repo.clone() {
    if let Some(version_id) = metadata_field(&projection, "version")
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.id)
    {
      version_repo
        .get(version_id)
        .await
        .map_err(|e| PdfExportError::new(e.to_string()))?
    } else {
      None
    }
  } else {
    None
  };
  let mut snapshot = document_metadata_render_snapshot(&projection, &validation, current_version.as_ref());
  // Capture attribution at dispatch: queued exports must not pick up later
  // profile edits. The title comes from the selected Yjs revision in the builder.
  if let Some(attribution) = state
    .doc
    .store()
    .get_doc_attribution(workspace_id, doc_id)
    .await
    .map_err(|e| PdfExportError::new(e.to_string()))?
  {
    let mut authors = Vec::new();
    for name in [attribution.created_by_name, attribution.updated_by_name]
      .into_iter()
      .flatten()
    {
      if !name.trim().is_empty() && !authors.contains(&name) {
        authors.push(name);
      }
    }
    snapshot["author"] = serde_json::json!(authors.join(", "));
    snapshot["createdAt"] = serde_json::json!(attribution.created_at);
    snapshot["updatedAt"] = serde_json::json!(attribution.updated_at);
  }
  let validation_json = serde_json::to_value(&validation).map_err(|e| PdfExportError::new(e.to_string()))?;
  Ok((snapshot, validation_json))
}

async fn resolve_document_version_for_export(
  state: &PdfExportService,
  workspace_id: Uuid,
  doc_id: Uuid,
  actor_id: Uuid,
  selector: Option<&str>,
  source: Option<&ReplayablePdfSource>,
) -> Result<Option<ResolvedDocumentVersion>> {
  let Some(raw_selector) = selector.map(str::trim).filter(|s| !s.is_empty()) else {
    return Ok(None);
  };

  let settings_repo = state
    .document_version_settings_repo
    .clone()
    .ok_or_else(|| PdfExportError::new("document version settings repository is not configured on this server"))?;
  let version_repo = state
    .document_version_repo
    .clone()
    .ok_or_else(|| PdfExportError::new("document version repository is not configured on this server"))?;
  let metadata_service = state
    .document_metadata_service
    .clone()
    .ok_or_else(|| PdfExportError::new("document metadata service is not configured on this server"))?;
  let doc_workspace = match metadata_service.workspace_id_for_document(doc_id).await {
    Ok(workspace_id) => Some(workspace_id),
    Err(crate::document_metadata::DocumentMetadataServiceError::NotFound) => None,
    Err(error) => return Err(PdfExportError::new(error.to_string())),
  };
  if doc_workspace != Some(workspace_id) {
    warn!(
      workspace_id = %workspace_id,
      doc_id = %doc_id,
      actor_id = %actor_id,
      doc_workspace_id = ?doc_workspace,
      "pdf export: document-version selector rejected because doc is not in workspace"
    );
    return Err(validation_error(
      "document is not available in this workspace",
      "document_version_id",
    ));
  }

  let settings = settings_repo
    .get(doc_id)
    .await
    .map_err(|e| PdfExportError::new(e.to_string()))?;

  if !settings.enabled {
    return Err(validation_error(
      "document versioning is disabled for this document",
      "document_version_id",
    ));
  }

  if raw_selector == "latest" {
    let auto_pdf = settings
      .auto_version_on
      .iter()
      .any(|trigger| matches!(trigger, myoxus_domain::entities::AutoVersionTrigger::OnPdfExport));
    if !auto_pdf {
      debug!(
        workspace_id = %workspace_id,
        doc_id = %doc_id,
        actor_id = %actor_id,
        "pdf export: latest document state selected without auto-version trigger"
      );
      return Ok(None);
    }

    // PDF export auto-versioning is a normal document-version event: it
    // captures the current merged Yjs state into `doc_histories` and creates a
    // named `document_version`. It is intentionally unrelated to Git-Sync
    // baselines or `git_sync_version_links`, which are sync provenance only.
    let create_service =
      crate::document_version::DocumentVersionCreateService::new(Arc::new(state.doc.clone()), version_repo.clone());
    let request = crate::document_version::DocumentVersionCreateRequest {
      doc_id,
      workspace_id,
      actor_id,
      requested_label: None,
      description: Some("Automatically created before PDF export".to_string()),
      event: DocumentVersionEvent::PdfExport,
      kind: DocumentVersionKind::Exported,
    };
    let version = match source {
      Some(source) => {
        create_service
          .create_idempotent(request, source.request_key, source.fingerprint.clone())
          .await
      }
      None => create_service.create(request).await,
    }
    .map_err(|e| PdfExportError::new(e.to_string()))?;
    return Ok(Some(ResolvedDocumentVersion {
      id: version.id,
      label: version.label.clone(),
      history_id: version.doc_history_id,
      version,
    }));
  }

  let version_id = Uuid::parse_str(raw_selector)
    .map_err(|_| validation_error("invalid document version id", "document_version_id"))?;
  let version = version_repo
    .get(version_id)
    .await
    .map_err(|e| PdfExportError::new(e.to_string()))?
    .ok_or_else(|| validation_error("document version not found", "document_version_id"))?;
  if version.workspace_id != workspace_id || version.doc_id != doc_id {
    warn!(
      workspace_id = %workspace_id,
      doc_id = %doc_id,
      actor_id = %actor_id,
      version_id = %version_id,
      version_workspace_id = %version.workspace_id,
      version_doc_id = %version.doc_id,
      "pdf export: document version does not belong to requested doc/workspace"
    );
    return Err(validation_error(
      "document version is not available for this document",
      "document_version_id",
    ));
  }
  debug!(
    workspace_id = %workspace_id,
    doc_id = %doc_id,
    actor_id = %actor_id,
    version_id = %version_id,
    history_id = version.doc_history_id,
    label = %version.label,
    "pdf export: named document version selected"
  );
  Ok(Some(ResolvedDocumentVersion {
    id: version.id,
    label: version.label.clone(),
    history_id: version.doc_history_id,
    version,
  }))
}

async fn record_export_start_audit(
  actor: AuditActor,
  state: &PdfExportService,
  job_id: Uuid,
  workspace_id: Uuid,
  doc_id: Uuid,
  template_id: &str,
  path: &'static str,
) {
  state
    .audit
    .record(AuditEvent::mutation(
      "pdf_export.start",
      AuditCategory::PdfExportConfig,
      Some(AuditTarget::entity("pdf_export_job", job_id, None)),
      actor,
      None,
      Some(serde_json::json!({
        "jobId": job_id.to_string(),
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "templateId": template_id,
        "path": path,
      })),
    ))
    .await;
}

impl PdfExportService {
  /// Preserve shipped GraphQL polling access: requester or current workspace reader.
  /// Consumers with stricter document checks must perform them before exposing the result.
  #[instrument(skip_all, level = "debug")]
  pub async fn get(&self, actor_user_id: Uuid, job_id: Uuid) -> Result<PdfExportJob> {
    let job = self
      .jobs
      .get(job_id)
      .await
      .map_err(|e| PdfExportError::new(e.to_string()))?
      .ok_or_else(|| PdfExportError::new("job not found"))?;
    if job.requested_by != actor_user_id {
      self
        .permission
        .assert(
          &crate::permission::WorkspaceResource {
            user_id: actor_user_id,
            workspace_id: job.workspace_id,
          },
          myoxus_domain::permission::WorkspaceAction::Read,
        )
        .await
        .map_err(PdfExportError::authorization)?;
    }
    debug!(job_id = %job_id, user_id = %actor_user_id, "pdf export job polled");
    Ok(job)
  }

  /// Validate the canonical request before reuse, version capture, audit and rendering.
  /// The authenticated principal authorizes work independently of the supplied
  /// audit actor, retaining GraphQL's existing system-actor fallback.
  #[instrument(skip_all)]
  pub async fn create(
    &self,
    actor: AuditActor,
    actor_user_id: Uuid,
    input: PdfExportCreateRequest,
  ) -> Result<PdfExportJob> {
    self.create_inner(actor, actor_user_id, input, None).await
  }

  /// Durable callers select the workspace default without changing assignments.
  #[instrument(skip_all)]
  pub async fn create_replayable(
    &self,
    actor: AuditActor,
    actor_user_id: Uuid,
    input: PdfExportCreateRequest,
    source: ReplayablePdfSource,
  ) -> Result<PdfExportJob> {
    self.create_inner(actor, actor_user_id, input, Some(source)).await
  }

  /// Recheck current export policy before exposing a durable create replay.
  pub async fn assert_create_access(&self, user_id: Uuid, workspace_id: Uuid, doc_id: Uuid) -> Result<()> {
    self
      .permission
      .assert(
        &crate::permission::WorkspaceResource { user_id, workspace_id },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(PdfExportError::authorization)?;
    self
      .permission
      .assert(
        &crate::permission::DocResource {
          user_id,
          workspace_id,
          doc_id,
        },
        myoxus_domain::permission::DocAction::Read,
      )
      .await
      .map_err(PdfExportError::authorization)?;
    load_pdf_export_metadata_snapshot(self, workspace_id, doc_id, None).await?;
    Ok(())
  }

  /// Reconcile the existing queue edge after a committed admission acknowledgement
  /// or enqueue was lost. Stable Redis IDs prevent duplicate queued work.
  pub async fn resume_queued(&self, actor: AuditActor, user_id: Uuid, job_id: Uuid) -> Result<()> {
    let job = self.get(user_id, job_id).await?;
    if job.status != "queued" {
      return Ok(());
    }
    let enqueued = self
      .backend
      .enqueue(
        serde_json::json!({"job_id": job.id, "workspace_id": job.workspace_id.to_string(),
      "doc_id": job.doc_id.to_string(), "template_id": &job.template_id, "render_inputs": &job.render_inputs}),
        Some(job.id),
      )
      .await
      .map_err(|_| {
        PdfExportError::new("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED: retry the same PDF key to reconcile the queue")
      })?;
    if enqueued.is_some_and(|outcome| outcome.created) {
      record_export_start_audit(
        actor,
        self,
        job.id,
        job.workspace_id,
        job.doc_id,
        &job.template_id,
        "async",
      )
      .await;
    }
    Ok(())
  }

  async fn create_inner(
    &self,
    actor: AuditActor,
    actor_user_id: Uuid,
    mut input: PdfExportCreateRequest,
    source: Option<ReplayablePdfSource>,
  ) -> Result<PdfExportJob> {
    let state = self;
    let workspace_uuid = input.workspace_id;
    let doc_uuid = input.doc_id;
    use super::capability_validator::{CapabilityViolation, validate_inputs_against_manifest};
    use super::render_context::PdfExportInputV2;
    // SEC: workspace Read-permission MUST be enforced before any
    // template / capability work — otherwise a non-member can probe the
    // template registry through the response shape (TemplateError vs.
    // CapabilityViolation vs. Forbidden) and learn which
    // templates exist + what capabilities they declare. The check
    // runs before the registry lookup because the V2 mutation does template
    // work before rendering.
    state
      .permission
      .assert(
        &crate::permission::WorkspaceResource {
          user_id: actor_user_id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(PdfExportError::authorization)?;

    // Resolve the factory profile only for new admission. Durable callers replay
    // matching receipts before entering here; queued resumption uses captured
    // inputs. Missing profiles in old captures still mean standard in the writer.
    input.compliance_profile = Some(
      input
        .compliance_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("pdfa-2u")
        .to_owned(),
    );

    // Resolve the template via the V2 registry — accepts slug or UUID.
    // The registry's caching layer is shared with the worker/sync render path.
    if source.is_some() && input.template_id.is_empty() {
      input.template_id = self
        .pdf_assignment_repo
        .as_ref()
        .ok_or_else(|| PdfExportError::new("PDF template assignment repository is not configured"))?
        .list_for_workspace(workspace_uuid)
        .await
        .map_err(|e| PdfExportError::new(e.to_string()))?
        .into_iter()
        .find(|assignment| assignment.is_default)
        .map(|assignment| assignment.template_id.to_string())
        .ok_or_else(|| {
          validation_error(
            "select template_id; this workspace has no default PDF template",
            "template_id",
          )
        })?;
    }
    let loaded = state.backend.template(&input.template_id).await?;

    // Resolve the physical format before capability validation. This keeps
    // workspace/global defaults backward compatible while ensuring a narrowed
    // template allow-list is authoritative before a job can be dispatched.
    let theme_context = state.backend.theme(workspace_uuid).await?;
    let effective_paper_size = non_empty_option(input.paper_size.as_ref())
      .or_else(|| non_empty_option(theme_context.default_paper_size.as_ref()))
      .unwrap_or_else(|| state.defaults.default_paper_size.clone());
    let effective_paper_size = validate_render_paper_size(&effective_paper_size)?;

    // Normalize the shared request into the existing manifest validator input.
    let image_quality = match input.image_quality.as_deref() {
      None => None,
      Some(raw) => Some(parse_image_quality(raw)?),
    };
    let typed_inputs = input
      .typed_inputs
      .as_ref()
      .cloned()
      .unwrap_or_else(|| serde_json::Value::Null);
    let app_input = PdfExportInputV2 {
      workspace_id: workspace_uuid,
      doc_id: doc_uuid,
      template_id: loaded.id,
      locale: input.locale.clone(),
      paper_size: Some(effective_paper_size.clone()),
      image_quality,
      compliance_profile: input.compliance_profile.clone(),
      cover_page: input.cover_page,
      toc_behavior: Some(
        input
          .toc_behavior
          .clone()
          .unwrap_or_else(|| loaded.manifest.capabilities.toc_behavior.default.as_str().to_owned()),
      ),
      footer_style: Some(
        input
          .footer_style
          .clone()
          .unwrap_or_else(|| loaded.manifest.capabilities.footer_style.default.as_str().to_owned()),
      ),
      page_numbering: Some(
        input
          .page_numbering
          .clone()
          .unwrap_or_else(|| loaded.manifest.capabilities.page_numbering.default.as_str().to_owned()),
      ),
      color_variant: Some(
        input
          .color_variant
          .clone()
          .unwrap_or_else(|| loaded.manifest.capabilities.color_variant.default.as_str().to_owned()),
      ),
      confidentiality_label: input.confidentiality_label.clone(),
      typed_inputs,
    };

    // Run the capability validator. An off-capability input never reaches
    // the renderer.
    let violations = validate_inputs_against_manifest(&app_input, &loaded.manifest);
    if !violations.is_empty() {
      warn!(
        template_id = %loaded.id,
        violation_count = violations.len(),
        "exportPdf: input rejected by capability validator"
      );
      let summary = violations
        .iter()
        .map(|v| match v {
          CapabilityViolation::CapabilityDisabled { field } => format!("{field}: capability disabled"),
          CapabilityViolation::ValueNotAllowed { field, value, allowed } => {
            format!("{field}: `{value}` not in {allowed:?}")
          }
          CapabilityViolation::LocaleNotDeclared { locale } => format!("locale: `{locale}` not declared"),
          CapabilityViolation::TypedInputsSchemaFailed { errors } => {
            // Compact one-line summary; the full structured list lives
            // in `extensions.violationsJson` so clients can render it.
            let n = errors.len();
            let first = errors
              .first()
              .map(|e| e.to_string())
              .unwrap_or_else(|| "unknown".into());
            if n == 1 {
              format!("typed_inputs: {first}")
            } else {
              format!("typed_inputs: {first} (+ {} more)", n - 1)
            }
          }
        })
        .collect::<Vec<_>>()
        .join("; ");
      let mut err = PdfExportError::new(format!("input rejected by template capabilities: {summary}"));
      err.extensions = Some({
        let mut ext = PdfExportErrorDetails::default();
        ext.set("class", "CapabilityViolation");
        // Surface the violation list as JSON-serialised text so async-graphql's
        // typed `Value` doesn't have to round-trip a `serde_json::Value`. Clients
        // parse the string back into JSON.
        ext.set(
          "violationsJson",
          serde_json::to_string(&violations).unwrap_or_else(|_| "[]".to_string()),
        );
        ext
      });
      return Err(err);
    }

    if let Some(raw) = input.compliance_profile.as_deref() {
      validate_compliance_profile(raw)?;
    }

    let dispatch_input = PdfExportDispatchInput {
      workspace_id: input.workspace_id.to_string(),
      doc_id: input.doc_id.to_string(),
      template_id: loaded.id.to_string(),
      locale: input.locale.clone(),
      paper_size: Some(effective_paper_size),
      orientation: input.orientation.clone(),
      heading_font_scale: None,
      body_font_scale: None,
      image_quality: input.image_quality.clone(),
      compliance_profile: input.compliance_profile.clone(),
      color_profile: None,
      ligatures_enabled: None,
      cover_page: input.cover_page,
      toc_behavior: app_input.toc_behavior,
      footer_style: app_input.footer_style,
      page_numbering: app_input.page_numbering,
      color_variant: app_input.color_variant,
      confidentiality_label: input.confidentiality_label.clone(),
      typed_inputs: input.typed_inputs.as_ref().cloned(),
      document_version_id: input.document_version_id.clone(),
      resolved_document_version_id: None,
      version_label: None,
      doc_history_id: None,
      latest_idempotency_key: None,
      document_metadata_snapshot: None,
      metadata_validation: None,
    };

    self
      .dispatch(
        actor,
        actor_user_id,
        dispatch_input,
        source,
        template_bundle_digest(&loaded),
      )
      .await
  }

  async fn dispatch(
    &self,
    actor: AuditActor,
    actor_user_id: Uuid,
    mut input: PdfExportDispatchInput,
    source: Option<ReplayablePdfSource>,
    template_digest: String,
  ) -> Result<PdfExportJob> {
    let state = self;
    let workspace_uuid =
      Uuid::parse_str(&input.workspace_id).map_err(|_| PdfExportError::new("invalid workspace_id"))?;
    let doc_uuid = Uuid::parse_str(&input.doc_id).map_err(|_| PdfExportError::new("invalid doc_id"))?;
    self
      .permission
      .assert(
        &crate::permission::WorkspaceResource {
          user_id: actor_user_id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(PdfExportError::authorization)?;
    state.backend.ensure_database()?;
    let job_store = state.jobs.clone();

    let template_id = input.template_id.clone();
    let theme_context = state.backend.theme(workspace_uuid).await?;
    let (locale, _) = apply_effective_pdf_defaults(
      &mut input,
      &theme_context,
      &state.defaults,
      &state.defaults.main_web_locale,
    )?;

    // Public selections are resolved to a canonical UUID before dispatch;
    // aliases must not bypass the workspace assignment boundary.
    {
      let tpl_uuid = Uuid::parse_str(&template_id)
        .map_err(|_| PdfExportError::new("PDF dispatch requires a resolved template UUID"))?;
      let assignment_repo = state
        .pdf_assignment_repo
        .clone()
        .ok_or_else(|| PdfExportError::new("PDF template assignment repository is not configured"))?;
      let assignment = assignment_repo
        .get(workspace_uuid, tpl_uuid)
        .await
        .map_err(|e| PdfExportError::new(e.to_string()))?;
      if assignment.is_none() {
        warn!(
          workspace_id = %workspace_uuid,
          template_id = %tpl_uuid,
          user_id = %actor_user_id,
          "pdf export: template not assigned to workspace — refused"
        );
        let mut err = PdfExportError::new("selected pdf template is not available for this workspace");
        err.extensions = Some({
          let mut ext = PdfExportErrorDetails::default();
          ext.set("class", "Forbidden");
          ext.set("templateId", tpl_uuid.to_string());
          ext.set("workspaceId", workspace_uuid.to_string());
          ext
        });
        return Err(err);
      }
    }

    let requested_document_version_id = input.document_version_id.clone();
    let mut resolved_document_version = None;
    if requested_document_version_id
      .as_deref()
      .is_some_and(|selector| selector != "latest")
    {
      let resolved = resolve_document_version_for_export(
        state,
        workspace_uuid,
        doc_uuid,
        actor_user_id,
        requested_document_version_id.as_deref(),
        source.as_ref(),
      )
      .await?;
      if let Some(resolved) = resolved {
        apply_resolved_document_version(&mut input, &resolved);
        resolved_document_version = Some(resolved);
      }
    }

    // Export validation is deliberately before idempotency and before the
    // `latest` auto-version side effect. A stale successful job must not allow
    // callers to bypass a policy that now blocks export, and a blocked export
    // must not create a visible document version.
    let (metadata_snapshot, metadata_validation) = load_pdf_export_metadata_snapshot(
      state,
      workspace_uuid,
      doc_uuid,
      resolved_document_version.as_ref().map(|v| &v.version),
    )
    .await?;
    input.document_metadata_snapshot = Some(metadata_snapshot);
    input.metadata_validation = Some(metadata_validation);

    // Hash the validated user request before resolving `latest` into a
    // freshly created auto-version. Otherwise double-clicks would create a
    // different label and bypass the existing 60-second idempotency window.
    // Reuse is qualified by the already validated bundle snapshot, so both
    // regular and latest-selector retries observe same-version file changes.
    input.latest_idempotency_key = stable_latest_idempotency_key(&input, &theme_context)
      .map(|key| stable_hash_value(&serde_json::json!([key, &template_digest])));
    let mut idempotency_inputs = build_render_inputs(&input, &theme_context);
    idempotency_inputs["template_content_sha256"] = serde_json::json!(&template_digest);
    let options_hash = compute_render_inputs_hash(&doc_uuid, &template_id, &idempotency_inputs);

    // Idempotency check: recent non-failed job for same doc + options *by the
    // same user*. Per-user scoping (PDFREV-SEC-01) prevents a workspace member
    // from receiving a job_id whose download blob was rendered for someone
    // else — without this the download URL is served by REST under the new
    // caller's session even though the row's requested_by is unrelated.
    if source.is_none() {
      let existing = job_store
        .find_recent_matching(workspace_uuid, doc_uuid, &options_hash, actor_user_id)
        .await
        .map_err(|e| PdfExportError::new(e.to_string()))?;

      if let Some(job) = existing {
        debug!(
          workspace_id = %workspace_uuid,
          doc_id = %doc_uuid,
          user_id = %actor_user_id,
          "returning existing pdf export job (idempotent)"
        );
        return Ok(job);
      }

      if let Some(latest_key) = input.latest_idempotency_key.as_deref() {
        let existing_latest = job_store
          .find_recent_latest(workspace_uuid, doc_uuid, &template_id, actor_user_id, latest_key)
          .await
          .map_err(|e| PdfExportError::new(e.to_string()))?;

        if let Some(job) = existing_latest {
          debug!(
            workspace_id = %workspace_uuid,
            doc_id = %doc_uuid,
            user_id = %actor_user_id,
            "returning existing latest pdf export job (stable idempotency key)"
          );
          return Ok(job);
        }
      }
    }

    // Per-workspace concurrency cap. Idempotency catches double-clicks on the
    // *same* doc; this catches a workspace flooding the queue with many
    // distinct docs. Counts only active rows from the last hour so that
    // forgotten "running" rows (e.g. after a worker crash without finished_at
    // being written) don't lock out the workspace forever.
    let max_concurrent = state.defaults.max_concurrent_per_workspace;
    let active_count = job_store
      .count_active_for_workspace(workspace_uuid)
      .await
      .map_err(|e| PdfExportError::new(e.to_string()))?;
    if active_count >= max_concurrent {
      warn!(
        workspace_id = %workspace_uuid,
        active = active_count,
        max = max_concurrent,
        "pdf export: per-workspace concurrency limit reached"
      );
      let mut err = PdfExportError::new(format!(
        "workspace already has {active_count} active pdf export jobs (max {max_concurrent})"
      ));
      err.extensions = Some({
        let mut ext = PdfExportErrorDetails::default();
        ext.set("class", "Throttled");
        ext.set("limit", max_concurrent);
        ext.set("active", active_count);
        ext
      });
      return Err(err);
    }

    if requested_document_version_id.as_deref() == Some("latest") {
      let resolved = resolve_document_version_for_export(
        state,
        workspace_uuid,
        doc_uuid,
        actor_user_id,
        requested_document_version_id.as_deref(),
        source.as_ref(),
      )
      .await?;
      if let Some(resolved) = resolved {
        apply_resolved_document_version(&mut input, &resolved);
        let (metadata_snapshot, metadata_validation) =
          load_pdf_export_metadata_snapshot(state, workspace_uuid, doc_uuid, Some(&resolved.version)).await?;
        input.document_metadata_snapshot = Some(metadata_snapshot);
        input.metadata_validation = Some(metadata_validation);
      }
    }

    let mut source_digest = None;
    if let Some(source) = source.as_ref() {
      if input.doc_history_id.is_none() {
        use crate::doc::history::{
          DocHistoryOrigin, HistoryCapture, HistoryCaptureIdempotency, HistoryCaptureProvenance, HistorySaveRequest,
        };
        let captured = self
          .doc
          .history
          .save_current(HistorySaveRequest {
            workspace_id: workspace_uuid,
            doc_id: doc_uuid,
            provenance: HistoryCaptureProvenance {
              origin: DocHistoryOrigin::PdfExport,
              actor_id: Some(actor_user_id),
            },
            named: None,
            idempotency: HistoryCaptureIdempotency {
              actor_id: actor_user_id,
              request_key: source.request_key,
              fingerprint: source.fingerprint.clone(),
            },
          })
          .await
          .map_err(|e| PdfExportError::new(e.to_string()))?;
        match captured.capture {
          HistoryCapture::Snapshot(history_id) => input.doc_history_id = Some(history_id),
          HistoryCapture::Version(version) => apply_resolved_document_version(
            &mut input,
            &ResolvedDocumentVersion {
              id: version.id,
              label: version.label.clone(),
              history_id: version.doc_history_id,
              version,
            },
          ),
          HistoryCapture::Unchanged => return Err(PdfExportError::new("PDF source capture unexpectedly skipped")),
        }
      }
      let history = self
        .doc
        .history_entry(input.doc_history_id.expect("pinned source above"))
        .await
        .map_err(|e| PdfExportError::new(e.to_string()))?
        .filter(|entry| entry.workspace_id == workspace_uuid && entry.doc_id == doc_uuid)
        .ok_or_else(|| validation_error("selected PDF source is no longer available", "document_version_id"))?;
      source_digest = Some(hex::encode(Sha256::digest(&history.snapshot)));
    }
    let mut render_inputs = build_render_inputs(&input, &theme_context);
    render_inputs["template_content_sha256"] = serde_json::json!(&template_digest);
    if let Some(digest) = source_digest {
      render_inputs["source_content_sha256"] = serde_json::json!(digest);
    }

    let options_hash = if source.is_some() {
      compute_render_inputs_hash(&doc_uuid, &template_id, &render_inputs)
    } else {
      options_hash
    };
    let l3_inputs = build_l3_inputs(&input, &theme_context);

    // ── P-PDF-TPL-AUDIT-01: render audit trail (compliance) ────────────────
    // Pre-generate the job UUID here so the audit row can reference it
    // BEFORE any pdf_export_jobs row exists. The audit insert is on the
    // synchronous critical path — a DB failure aborts the render so a
    // missing audit entry never goes unnoticed.
    let job_id = Uuid::new_v4();
    let audit_repo = state
      .pdf_render_audit_repo
      .clone()
      .ok_or_else(|| PdfExportError::new("PDF render audit repository is not configured"))?;
    {
      use myoxus_domain::entities::PdfExportRenderAudit;
      let render_appearance_hash = effective_pdf_render_appearance_hash(&theme_context);

      // Resolve the template-version string. UUID-form `template_id` reads
      // the row's `version`; slug-form system templates keep the slug as a
      // sentinel so audits stay decipherable.
      let (template_uuid_audit, template_version) = if let Ok(tpl_uuid) = Uuid::parse_str(&template_id) {
        let template_repo = state
          .pdf_template_repo
          .clone()
          .ok_or_else(|| PdfExportError::new("PDF template repository is not configured"))?;
        let version = template_repo
          .get_by_id(tpl_uuid)
          .await
          .map_err(|e| PdfExportError::new(e.to_string()))?
          .map(|template| template.version)
          .unwrap_or_else(|| "unknown".into());
        (Some(tpl_uuid), version)
      } else {
        (None, format!("slug:{template_id}"))
      };

      let classification = input.confidentiality_label.clone();

      let audit = PdfExportRenderAudit {
        id: Uuid::nil(), // implementation allocates
        job_id,
        actor_id: actor_user_id,
        workspace_id: workspace_uuid,
        doc_id: doc_uuid,
        doc_version_label: input.version_label.clone(),
        document_version_id: input
          .resolved_document_version_id
          .as_deref()
          .and_then(|id| Uuid::parse_str(id).ok()),
        template_id: template_uuid_audit,
        template_version,
        render_appearance_hash,
        locale: locale.clone(),
        classification,
        l3_inputs,
        document_metadata_snapshot: input
          .document_metadata_snapshot
          .clone()
          .unwrap_or_else(|| serde_json::json!({})),
        metadata_validation: input
          .metadata_validation
          .clone()
          .unwrap_or_else(|| serde_json::json!({})),
        created_at: chrono::DateTime::<chrono::Utc>::default(), // implementation defaults to now()
      };
      audit_repo.record(&audit).await.map_err(|e| {
        warn!(
          workspace_id = %workspace_uuid,
          doc_id = %doc_uuid,
          error = %e,
          "pdf export render audit insert failed — aborting render to preserve compliance trail"
        );
        PdfExportError::new(format!("pdf export aborted: render audit could not be recorded: {e}"))
      })?;
      info!(
        job_id = %job_id,
        workspace_id = %workspace_uuid,
        doc_id = %doc_uuid,
        actor_id = %actor_user_id,
        "pdf export render audit recorded"
      );
    }

    // ─── Sync path (P6) ────────────────────────────────────────────────────
    // For small documents we render inline so the client gets a downloadable
    // PDF on the first round-trip. Above the configured block threshold we
    // fall through to the async/queued path. `sync_threshold_blocks == 0`
    // disables the sync path entirely (used by integration tests that assert
    // queued status, see helpers::build_test_app).
    let sync_threshold = state.defaults.sync_threshold_blocks;
    if sync_threshold > 0 {
      let outcome = state
        .backend
        .render(PdfExportRenderRequest {
          workspace_id: workspace_uuid,
          doc_id: doc_uuid,
          render_inputs: render_inputs.clone(),
          input: input.clone(),
          theme: theme_context.clone(),
          sync_threshold_blocks: sync_threshold,
          template_files: None,
        })
        .await?;

      match outcome {
        SyncRenderOutcome::Rendered {
          blob_id,
          size_bytes,
          page_count,
          unmapped_font_families,
          renderer_diagnostics,
        } => {
          render_inputs["renderer_diagnostics"] = renderer_diagnostics;
          let page_count_i32: i32 = i32::try_from(page_count).unwrap_or(i32::MAX);
          let inserted = job_store
            .insert_completed(&CompletedPdfExportJobInsert {
              job: PdfExportJobInsert {
                id: job_id,
                workspace_id: workspace_uuid,
                doc_id: doc_uuid,
                requested_by: actor_user_id,
                template_id: template_id.clone(),
                render_inputs: render_inputs.clone(),
                options_hash: options_hash.clone(),
              },
              output_blob_id: blob_id,
              page_count: page_count_i32,
              unmapped_font_families,
            })
            .await;
          let persisted_job = match inserted {
            Ok(job) => job,
            Err(error) => match job_store.get(job_id).await {
              Ok(Some(job)) if job.output_blob_id == Some(blob_id) => job,
              Ok(None) => {
                state.backend.remove_unpublished_pdf(workspace_uuid, blob_id).await?;
                return Err(PdfExportError::new(error.to_string()));
              }
              _ => {
                return Err(PdfExportError::new(
                  "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED: PDF publication durability is uncertain",
                ));
              }
            },
          };
          info!(
            workspace_id = %workspace_uuid,
            doc_id = %doc_uuid,
            user_id = %actor_user_id,
            blob_id = %blob_id,
            size_bytes = size_bytes,
            "pdf export rendered synchronously"
          );
          let job = persisted_job;
          let job_uuid = job.id;
          record_export_start_audit(
            actor.clone(),
            state,
            job_uuid,
            workspace_uuid,
            doc_uuid,
            &template_id,
            "sync",
          )
          .await;
          return Ok(job);
        }
        SyncRenderOutcome::TooLargeForSync => {
          debug!(
            workspace_id = %workspace_uuid,
            doc_id = %doc_uuid,
            threshold = sync_threshold,
            "pdf sync: doc above threshold — falling through to async path"
          );
          // fall through to async insert + enqueue below
        }
        SyncRenderOutcome::Failed {
          class,
          detail: _,
          renderer_diagnostics,
        } => {
          warn!(
            workspace_id = %workspace_uuid,
            doc_id = %doc_uuid,
            class = %class,
            "pdf sync: render failed — surfacing error to client"
          );
          // PDFREV-SEC-03 — never put `detail` on the wire. The renderer
          // produces detail strings that may contain Typst compiler source
          // snippets, asset paths, opendal/S3 backend codes, or workspace-
          // internal block UUIDs. It must not enter logs; the client
          // gets a deterministic one-liner keyed off the stable class.
          let mut err = PdfExportError::new(safe_sync_error_summary(class).to_string());
          err.extensions = Some({
            let mut ext = PdfExportErrorDetails::default();
            ext.set("class", class);
            if let Some(report) = renderer_diagnostics {
              ext.set("renderer_diagnostics", report);
            }
            ext
          });
          return Err(err);
        }
      }
    }

    // Insert new job — `id` is the pre-generated UUID we already used for
    // the render-audit row above so the two stay correlated.
    let persisted_job = job_store
      .insert_queued(&PdfExportJobInsert {
        id: job_id,
        workspace_id: workspace_uuid,
        doc_id: doc_uuid,
        requested_by: actor_user_id,
        template_id: template_id.clone(),
        render_inputs: render_inputs.clone(),
        options_hash: options_hash.clone(),
      })
      .await
      .map_err(|e| {
        warn!(error = %e, workspace_id = %workspace_uuid, doc_id = %doc_uuid, "failed to insert pdf export job");
        PdfExportError::new(e.to_string())
      })?;

    let job = persisted_job;

    // Enqueue the job into the Redis `pdf-export` queue so the worker handler
    // picks it up. Without this push the row sits forever as `queued`.
    //
    // A queue-less fixture backend keeps the DB row as-is so
    // existing assertion-style tests still see `status = queued`.
    {
      let payload = serde_json::json!({
        "job_id": job.id,
        "workspace_id": workspace_uuid.to_string(),
        "doc_id": doc_uuid.to_string(),
        "template_id": &job.template_id,
        // SQL JSON normalization must be identical on initial enqueue and
        // replay: Redis's existing stable-ID owner compares the encoded data.
        "render_inputs": &job.render_inputs,
      });
      match state.backend.enqueue(payload, source.as_ref().map(|_| job.id)).await {
        Ok(Some(enqueued)) => {
          debug!(
            job_id = %job.id,
            redis_job_id = %enqueued.id,
            "pdf export: redis job pushed"
          );
        }
        Ok(None) => {
          debug!(job_id = %job.id, "pdf export: no redis queue configured — DB row only (test mode)");
        }
        Err(e) => {
          if source.is_some() {
            return Err(PdfExportError::new(
              "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED: retry the same PDF key to reconcile the queue",
            ));
          }
          // Mark the row as failed so the client sees a deterministic state.
          warn!(
            job_id = %job.id,
            error = %e,
            "pdf export: redis enqueue failed — marking job failed"
          );
          if let Err(mark_error) = job_store
            .mark_enqueue_failed(job.id, &format!("redis enqueue failed: {e}"))
            .await
          {
            warn!(job_id = %job.id, error = %mark_error, "failed to persist PDF enqueue failure");
          }
          return Err(PdfExportError::new(format!("failed to enqueue pdf export job: {e}")));
        }
      }
    }

    info!(
      job_id = %job.id,
      workspace_id = %workspace_uuid,
      doc_id = %doc_uuid,
      user_id = %actor_user_id,
      "pdf export job enqueued"
    );
    let job_uuid = job.id;
    record_export_start_audit(
      actor.clone(),
      state,
      job_uuid,
      workspace_uuid,
      doc_uuid,
      &template_id,
      "async",
    )
    .await;
    Ok(job)
  }
}

impl PdfExportService {
  /// Capture default assignment, template bytes and theme before rendering an
  /// ephemeral source. The identity is not a persisted document/history row.
  pub async fn prepare_snapshot_render(
    &self,
    workspace_id: Uuid,
    identity: Uuid,
    locale: String,
  ) -> Result<PdfExportRenderRequest> {
    let assignment = self
      .pdf_assignment_repo
      .as_ref()
      .ok_or_else(|| PdfExportError::new("PDF assignment repository unavailable"))?
      .list_for_workspace(workspace_id)
      .await
      .map_err(|_| PdfExportError::new("PDF assignments unavailable"))?
      .into_iter()
      .find(|a| a.is_default)
      .ok_or_else(|| validation_error("This workspace has no default PDF template", "template_id"))?;
    let loaded = self.backend.template(&assignment.template_id.to_string()).await?;
    let theme = self.backend.theme(workspace_id).await?;
    let mut input = PdfExportDispatchInput {
      workspace_id: workspace_id.to_string(),
      doc_id: identity.to_string(),
      template_id: loaded.id.to_string(),
      locale: Some(locale),
      compliance_profile: Some("pdfa-2u".into()),
      ..Default::default()
    };
    apply_effective_pdf_defaults(&mut input, &theme, &self.defaults, &self.defaults.main_web_locale)?;
    validate_compliance_profile(input.compliance_profile.as_deref().unwrap_or("pdfa-2u"))?;
    let capabilities = &loaded.manifest.capabilities;
    input.toc_behavior = Some(capabilities.toc_behavior.default.as_str().to_owned());
    input.footer_style = Some(capabilities.footer_style.default.as_str().to_owned());
    input.page_numbering = Some(capabilities.page_numbering.default.as_str().to_owned());
    input.color_variant = Some(capabilities.color_variant.default.as_str().to_owned());
    let check = super::render_context::PdfExportInputV2 {
      workspace_id,
      doc_id: identity,
      template_id: loaded.id,
      locale: input.locale.clone(),
      paper_size: input.paper_size.clone(),
      image_quality: input.image_quality.as_deref().map(parse_image_quality).transpose()?,
      compliance_profile: input.compliance_profile.clone(),
      cover_page: None,
      toc_behavior: input.toc_behavior.clone(),
      footer_style: input.footer_style.clone(),
      page_numbering: input.page_numbering.clone(),
      color_variant: input.color_variant.clone(),
      confidentiality_label: None,
      typed_inputs: serde_json::Value::Null,
    };
    if !super::capability_validator::validate_inputs_against_manifest(&check, &loaded.manifest).is_empty() {
      return Err(PdfExportError::new(
        "Assigned PDF template does not accept answer export settings",
      ));
    }
    let mut render_inputs = build_render_inputs(&input, &theme);
    render_inputs["template_content_sha256"] = serde_json::json!(template_bundle_digest(&loaded));
    Ok(PdfExportRenderRequest {
      workspace_id,
      doc_id: identity,
      render_inputs,
      input,
      theme,
      sync_threshold_blocks: usize::MAX,
      template_files: Some(loaded.files),
    })
  }
}
