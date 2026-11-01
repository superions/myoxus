//! `doc metadata` subcommand — inspect and update canonical document metadata.
//!
//! Read/write/validation commands use the native document-metadata projection.
//! Status transitions still use the shared status graph service because it owns
//! transition policy and version creation.

use std::sync::Arc;

use anyhow::{Context, bail};
use chrono::{DateTime, Utc};
use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::{PgPool, Row};
use tabled::Tabled;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::document_metadata::{
  DocumentMetadataProjectionMode, DocumentMetadataService, DocumentMetadataValidationService,
};
use myoxus_application::document_metadata_policy::{DocumentStatusTransitionRequest, DocumentStatusTransitionService};
use myoxus_domain::entities::{DocumentMetadataPatch, DocumentMetadataProjection, DocumentMetadataValidation};
use myoxus_domain::repositories::DocumentMetadataPolicyRepository;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::document_version::PgDocumentVersionRepository;

use crate::output::{print_json, print_single};
use crate::services::Services;

#[derive(Subcommand)]
pub enum MetadataCommand {
  /// Show the effective canonical metadata for a document.
  Show(DocArgs),
  /// Patch normal metadata. Status changes are intentionally not accepted here.
  Set(SetArgs),
  /// Validate the current effective metadata.
  Validate(DocArgs),
  /// Transition document status through the server-authoritative transition service.
  Transition(TransitionArgs),
}

#[derive(Args, Debug)]
pub struct DocArgs {
  /// Document UUID.
  #[arg(long)]
  pub doc: String,
}

#[derive(Args, Debug)]
pub struct SetArgs {
  /// Document UUID.
  #[arg(long)]
  pub doc: String,
  /// Optional actor UUID. Defaults to `docs.updated_by`/`docs.created_by`.
  #[arg(long)]
  pub actor: Option<String>,
  /// Document type key or UUID.
  #[arg(long = "type")]
  pub document_type: Option<String>,
  /// Classification key or UUID.
  #[arg(long)]
  pub classification: Option<String>,
  /// Review due date as RFC3339 timestamp.
  #[arg(long)]
  pub review_due_at: Option<String>,
  /// Valid-from date as RFC3339 timestamp.
  #[arg(long)]
  pub valid_from: Option<String>,
  /// Valid-until date as RFC3339 timestamp.
  #[arg(long)]
  pub valid_until: Option<String>,
  /// Business document number.
  #[arg(long)]
  pub document_number: Option<String>,
  /// BCP-47 language tag.
  #[arg(long)]
  pub language: Option<String>,
}

#[derive(Args, Debug)]
pub struct TransitionArgs {
  /// Document UUID.
  #[arg(long)]
  pub doc: String,
  /// Target status key or UUID in the document's active status schema.
  #[arg(long)]
  pub to: String,
  /// Optional actor UUID. Defaults to `docs.updated_by`/`docs.created_by`.
  #[arg(long)]
  pub actor: Option<String>,
  /// Force version creation when the transition allows it.
  #[arg(long, default_value_t = false)]
  pub create_version: bool,
}

#[derive(Tabled, Serialize)]
pub struct MetadataSummaryRow {
  pub doc_id: String,
  pub workspace_id: String,
  pub status_id: String,
  pub status: String,
  pub document_type_id: String,
  pub document_type: String,
  pub classification_id: String,
  pub current_version_id: String,
  pub dirty_since_current_version: bool,
  pub review_due_at: String,
  pub valid_until: String,
  pub valid: bool,
  pub missing_required_metadata_fields: String,
  pub blocked_actions: String,
}

#[derive(Tabled, Serialize)]
pub struct ValidationRow {
  pub doc_id: String,
  pub valid: bool,
  pub errors: usize,
  pub warnings: usize,
  pub missing_required_metadata_fields: String,
  pub blocked_actions: String,
}

pub async fn run(cmd: MetadataCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  match cmd {
    MetadataCommand::Show(args) => show(args, svc, json).await,
    MetadataCommand::Set(args) => set(args, svc, json).await,
    MetadataCommand::Validate(args) => validate(args, svc, json).await,
    MetadataCommand::Transition(args) => transition(args, svc, json).await,
  }
}

#[instrument(skip(svc), level = "info")]
async fn show(args: DocArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  let (workspace_id, _) = doc_workspace_and_actor(&svc.pool, doc_id).await?;
  let metadata = load_metadata(svc, doc_id, workspace_id).await?;
  if json {
    print_json(&metadata);
  } else {
    let validation = validate_metadata(svc, &metadata).await?;
    print_single(&metadata_summary(&metadata, Some(&validation)), false);
  }
  Ok(())
}

#[instrument(skip(svc), level = "info")]
async fn set(args: SetArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  let (workspace_id, default_actor) = doc_workspace_and_actor(&svc.pool, doc_id).await?;
  let actor_id = parse_optional_uuid(args.actor.as_deref(), "actor")?.unwrap_or(default_actor);

  let document_type_id = match args.document_type.as_deref() {
    Some(value) => Some(Some(resolve_document_type(&svc.pool, value).await?)),
    None => None,
  };
  let classification_id = match args.classification.as_deref() {
    Some(value) => Some(Some(resolve_classification(&svc.pool, value).await?)),
    None => None,
  };
  let language_id = match args.language.as_deref() {
    Some(value) => Some(Some(resolve_language(&svc.pool, value).await?)),
    None => None,
  };

  let patch = DocumentMetadataPatch {
    document_type_id,
    classification_id,
    review_due_at: args
      .review_due_at
      .as_deref()
      .map(|value| parse_datetime(value, "review-due-at"))
      .transpose()?
      .map(Some),
    valid_from: args
      .valid_from
      .as_deref()
      .map(|value| parse_datetime(value, "valid-from"))
      .transpose()?
      .map(Some),
    valid_until: args
      .valid_until
      .as_deref()
      .map(|value| parse_datetime(value, "valid-until"))
      .transpose()?
      .map(Some),
    document_number: args.document_number.map(Some),
    language_id,
    ..DocumentMetadataPatch::default()
  };

  let metadata_service = DocumentMetadataService::new(Arc::new(PgDocumentMetadataRepository::new(svc.pool.clone())));
  metadata_service
    .set_metadata(doc_id, actor_id, patch)
    .await
    .map_err(|err| anyhow::anyhow!("set document metadata: {err}"))?;
  let metadata = metadata_service
    .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
    .await
    .map_err(|err| anyhow::anyhow!("load document metadata after set: {err}"))?;
  info!(%doc_id, %workspace_id, %actor_id, "CLI document metadata patched");
  if json {
    print_json(&serde_json::json!({ "metadata": metadata }));
  } else {
    let validation = validate_metadata(svc, &metadata).await?;
    print_single(&metadata_summary(&metadata, Some(&validation)), false);
  }
  Ok(())
}

#[instrument(skip(svc), level = "info")]
async fn validate(args: DocArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  let (workspace_id, _) = doc_workspace_and_actor(&svc.pool, doc_id).await?;
  let metadata = load_metadata(svc, doc_id, workspace_id).await?;
  let validation = validate_metadata(svc, &metadata).await?;
  if json {
    print_json(&validation);
  } else {
    print_single(&validation_row(doc_id, &validation), false);
  }
  if !validation.valid() {
    bail!("document metadata are invalid");
  }
  Ok(())
}

#[instrument(skip(svc), level = "warn")]
async fn transition(args: TransitionArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  let (workspace_id, default_actor) = doc_workspace_and_actor(&svc.pool, doc_id).await?;
  let actor_id = parse_optional_uuid(args.actor.as_deref(), "actor")?.unwrap_or(default_actor);
  let repo = Arc::new(PgDocumentMetadataPolicyRepository::new(svc.pool.clone()));
  let version_repo = Arc::new(PgDocumentVersionRepository::new(svc.pool.clone()));
  let metadata = load_metadata(svc, doc_id, workspace_id).await?;
  let from_status = metadata
    .fields
    .iter()
    .find(|field| field.key == "status")
    .and_then(|field| field.reference.as_ref())
    .map(|reference| reference.id)
    .context("document has no effective source status")?;
  let to_status = resolve_status_in_schema(&svc.pool, from_status, &args.to).await?;

  let metadata_service = DocumentMetadataService::new(Arc::new(PgDocumentMetadataRepository::new(svc.pool.clone())));
  let transition_service =
    DocumentStatusTransitionService::with_versioning(repo, Arc::new(svc.doc.clone()), version_repo, metadata_service);
  let validation = transition_service
    .transition_with_request(DocumentStatusTransitionRequest {
      doc_id,
      workspace_id,
      from_status_id: from_status,
      to_status_id: to_status,
      actor_id: Some(actor_id),
      actor_roles: Vec::new(),
      create_version: args.create_version,
    })
    .await
    .map_err(|err| anyhow::anyhow!("transition document status: {err}"))?;
  warn!(%doc_id, %workspace_id, %actor_id, %to_status, valid = validation.valid(), "CLI document status transition completed");
  if json {
    print_json(&validation);
  } else {
    print_single(&validation_row(doc_id, &validation), false);
  }
  if !validation.valid() {
    bail!("document status transition blocked by validation");
  }
  Ok(())
}

async fn load_metadata(svc: &Services, doc_id: Uuid, workspace_id: Uuid) -> anyhow::Result<DocumentMetadataProjection> {
  DocumentMetadataService::new(Arc::new(PgDocumentMetadataRepository::new(svc.pool.clone())))
    .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
    .await
    .map_err(|err| anyhow::anyhow!("load document metadata: {err}"))
}

async fn load_metadata_field_definitions(
  svc: &Services,
) -> anyhow::Result<Vec<myoxus_domain::entities::DocumentMetadataFieldDefinition>> {
  PgDocumentMetadataPolicyRepository::new(svc.pool.clone())
    .list_metadata_field_definitions()
    .await
    .map_err(|err| anyhow::anyhow!("load document metadata definitions: {err}"))
}

async fn validate_metadata(
  svc: &Services,
  metadata: &DocumentMetadataProjection,
) -> anyhow::Result<DocumentMetadataValidation> {
  let definitions = load_metadata_field_definitions(svc).await?;
  Ok(DocumentMetadataValidationService::new().validate(
    &definitions,
    metadata,
    myoxus_application::document_metadata_policy::DocumentMetadataAction::Read,
  ))
}

fn metadata_summary(
  metadata: &DocumentMetadataProjection,
  validation: Option<&DocumentMetadataValidation>,
) -> MetadataSummaryRow {
  let status = metadata.fields.iter().find(|field| field.key == "status");
  let document_type = metadata.fields.iter().find(|field| field.key == "documentType");
  let classification = metadata.fields.iter().find(|field| field.key == "classification");
  let version = metadata.fields.iter().find(|field| field.key == "version");
  let review_due_at = metadata.fields.iter().find(|field| field.key == "reviewDueAt");
  let valid_until = metadata.fields.iter().find(|field| field.key == "validUntil");
  MetadataSummaryRow {
    doc_id: metadata.doc_id.to_string(),
    workspace_id: metadata.workspace_id.to_string(),
    status_id: status
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.id.to_string())
      .unwrap_or_default(),
    status: status
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.label.clone())
      .unwrap_or_default(),
    document_type_id: document_type
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.id.to_string())
      .unwrap_or_default(),
    document_type: document_type
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.label.clone())
      .unwrap_or_default(),
    classification_id: classification
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.id.to_string())
      .unwrap_or_default(),
    current_version_id: version
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.id.to_string())
      .unwrap_or_default(),
    dirty_since_current_version: version.and_then(|field| field.text_value.as_deref()) == Some("dirty"),
    review_due_at: review_due_at
      .and_then(|field| field.timestamp_value)
      .map(|value| value.to_rfc3339())
      .unwrap_or_default(),
    valid_until: valid_until
      .and_then(|field| field.timestamp_value)
      .map(|value| value.to_rfc3339())
      .unwrap_or_default(),
    valid: validation.is_none_or(DocumentMetadataValidation::valid),
    missing_required_metadata_fields: validation
      .map(|validation| validation.missing_required_metadata_fields.join(","))
      .unwrap_or_default(),
    blocked_actions: validation
      .map(|validation| validation.blocked_actions.join(","))
      .unwrap_or_default(),
  }
}

fn validation_row(doc_id: Uuid, validation: &DocumentMetadataValidation) -> ValidationRow {
  ValidationRow {
    doc_id: doc_id.to_string(),
    valid: validation.valid(),
    errors: validation.errors.len(),
    warnings: validation.warnings.len(),
    missing_required_metadata_fields: validation.missing_required_metadata_fields.join(","),
    blocked_actions: validation.blocked_actions.join(","),
  }
}

async fn resolve_document_type(pool: &PgPool, value: &str) -> anyhow::Result<Uuid> {
  if let Ok(id) = Uuid::parse_str(value) {
    return Ok(id);
  }
  sqlx::query_scalar("SELECT id FROM document_type_definition WHERE key = $1 AND is_active")
    .bind(value)
    .fetch_optional(pool)
    .await
    .context("resolve document type")?
    .with_context(|| format!("unknown document type key: {value}"))
}

async fn resolve_classification(pool: &PgPool, value: &str) -> anyhow::Result<Uuid> {
  if let Ok(id) = Uuid::parse_str(value) {
    return Ok(id);
  }
  sqlx::query_scalar("SELECT id FROM document_classification_definition WHERE key = $1 AND is_active")
    .bind(value)
    .fetch_optional(pool)
    .await
    .context("resolve classification")?
    .with_context(|| format!("unknown classification key: {value}"))
}

async fn resolve_language(pool: &PgPool, value: &str) -> anyhow::Result<Uuid> {
  if let Ok(id) = Uuid::parse_str(value) {
    return Ok(id);
  }
  sqlx::query_scalar("SELECT id FROM language_definition WHERE key = $1 AND is_active")
    .bind(value)
    .fetch_optional(pool)
    .await
    .context("resolve language")?
    .with_context(|| format!("unknown language key: {value}"))
}

async fn resolve_status_in_schema(pool: &PgPool, from_status_id: Uuid, value: &str) -> anyhow::Result<Uuid> {
  if let Ok(id) = Uuid::parse_str(value) {
    return Ok(id);
  }
  sqlx::query_scalar(
    "SELECT target.id \
     FROM document_status_value source \
     JOIN document_status_value target ON target.schema_id = source.schema_id \
     WHERE source.id = $1 AND target.key = $2 AND target.is_active = true",
  )
  .bind(from_status_id)
  .bind(value)
  .fetch_optional(pool)
  .await
  .context("resolve target status")?
  .with_context(|| format!("unknown status key in active schema: {value}"))
}

fn parse_uuid(value: &str, field: &str) -> anyhow::Result<Uuid> {
  Uuid::parse_str(value).with_context(|| format!("invalid {field} UUID: {value}"))
}

fn parse_optional_uuid(value: Option<&str>, field: &str) -> anyhow::Result<Option<Uuid>> {
  value.map(|raw| parse_uuid(raw, field)).transpose()
}

fn parse_datetime(value: &str, field: &str) -> anyhow::Result<DateTime<Utc>> {
  DateTime::parse_from_rfc3339(value)
    .map(|value| value.with_timezone(&Utc))
    .with_context(|| format!("invalid {field} RFC3339 timestamp: {value}"))
}

async fn doc_workspace_and_actor(pool: &PgPool, doc_id: Uuid) -> anyhow::Result<(Uuid, Uuid)> {
  let row = sqlx::query(
    "SELECT workspace_id, COALESCE(updated_by, created_by) AS actor_id \
     FROM docs WHERE id = $1 AND deleted_at IS NULL",
  )
  .bind(doc_id)
  .fetch_optional(pool)
  .await
  .context("load document metadata")?
  .with_context(|| format!("document not found: {doc_id}"))?;

  let workspace_id = row
    .get::<Option<Uuid>, _>("workspace_id")
    .with_context(|| format!("document has no workspace: {doc_id}"))?;
  let actor_id = row
    .get::<Option<Uuid>, _>("actor_id")
    .with_context(|| format!("document has no default actor; pass --actor explicitly: {doc_id}"))?;
  Ok((workspace_id, actor_id))
}
