//! `doc versions` subcommand — manage named document versions from the admin CLI.
//!
//! The CLI writes directly to PostgreSQL like the other operator commands, but
//! snapshot creation and restore go through [`DocService`] so Yjs history
//! semantics stay identical to the API path.

use std::sync::Arc;

use anyhow::{Context, bail};
use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::{PgPool, Row};
use tabled::Tabled;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::document_version::{
  DocumentVersionCreateRequest, DocumentVersionCreateService, DocumentVersionRestoreService,
};
use myoxus_domain::entities::{AutoVersionTrigger, DocumentVersion};
use myoxus_domain::repositories::{DocumentVersionRepository, DocumentVersioningSettingsRepository};
use myoxus_infrastructure::document_version::{PgDocumentVersionRepository, PgDocumentVersioningSettingsRepository};

use crate::doc_metadata;
use crate::output::{print_output, print_single};
use crate::services::Services;

#[derive(Subcommand)]
pub enum DocCommand {
  /// Bounded SQL/leaf/root page projection inspection and exact repair.
  #[command(subcommand)]
  Projection(crate::doc_projection::ProjectionCommand),
  /// Named snapshot/version management.
  #[command(subcommand)]
  Versions(VersionsCommand),
  /// Canonical document metadata and status transitions.
  #[command(subcommand)]
  Metadata(doc_metadata::MetadataCommand),
}

#[derive(Subcommand)]
pub enum VersionsCommand {
  /// List named versions for one document.
  List(ListArgs),
  /// Capture the current document state as a named version.
  Create(CreateArgs),
  /// Pin a named version so retention-GC cannot prune it.
  Pin(IdArgs),
  /// Clear the pinned flag of a named version.
  Unpin(IdArgs),
  /// Restore a named version as a new append-only document update.
  Restore(RestoreArgs),
  /// Show or mutate per-document versioning settings.
  #[command(subcommand)]
  Settings(SettingsCommand),
}

#[derive(Args, Debug)]
pub struct ListArgs {
  /// Document UUID.
  #[arg(long)]
  pub doc: String,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
  /// Document UUID.
  #[arg(long)]
  pub doc: String,
  /// Human-readable, per-document unique label.
  #[arg(long)]
  pub label: String,
  /// Optional description shown in version pickers.
  #[arg(long)]
  pub description: Option<String>,
  /// Optional actor UUID. Defaults to `docs.updated_by`/`docs.created_by`.
  #[arg(long)]
  pub actor: Option<String>,
}

#[derive(Args, Debug)]
pub struct IdArgs {
  /// Document-version UUID.
  #[arg(long)]
  pub id: String,
}

#[derive(Args, Debug)]
pub struct RestoreArgs {
  /// Document-version UUID to restore.
  #[arg(long)]
  pub id: String,
  /// Optional actor UUID. Defaults to the source version's `created_by`.
  #[arg(long)]
  pub actor: Option<String>,
}

#[derive(Subcommand)]
pub enum SettingsCommand {
  /// Show effective settings for a document. Missing rows return defaults.
  Show(SettingsShowArgs),
  /// Upsert versioning settings for a document.
  Set(SettingsSetArgs),
}

#[derive(Args, Debug)]
pub struct SettingsShowArgs {
  /// Document UUID.
  #[arg(long)]
  pub doc: String,
}

#[derive(Args, Debug)]
pub struct SettingsSetArgs {
  /// Document UUID.
  #[arg(long)]
  pub doc: String,
  /// Enable or disable user-visible auto-versioning.
  #[arg(long)]
  pub enabled: Option<bool>,
  /// Number of unpinned versions retained by nightly GC.
  #[arg(long)]
  pub retention_count: Option<i32>,
  /// Comma-separated triggers: on_publish,on_pdf_export,daily.
  #[arg(long, value_delimiter = ',')]
  pub triggers: Option<Vec<String>>,
}

#[derive(Tabled, Serialize)]
pub struct VersionRow {
  pub id: String,
  pub doc_id: String,
  pub workspace_id: String,
  pub version_no: String,
  pub label: String,
  pub description: String,
  pub event: String,
  pub kind: String,
  pub created_by: String,
  pub created_at: String,
  pub pinned: bool,
  pub is_protected: bool,
  pub doc_history_id: i64,
  pub current_version_id: String,
  pub is_current_document_version: bool,
  pub dirty_since_current_version: bool,
}

#[derive(Tabled, Serialize)]
pub struct SettingsRow {
  pub doc_id: String,
  pub enabled: bool,
  pub retention_count: i32,
  pub auto_version_on: String,
}

#[derive(Debug, Clone, Copy)]
struct DocumentVersionHead {
  current_version_id: Option<Uuid>,
  dirty_since_current_version: bool,
}

pub async fn run(cmd: DocCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  match cmd {
    DocCommand::Projection(cmd) => crate::doc_projection::run(cmd, svc, json).await,
    DocCommand::Versions(cmd) => match cmd {
      VersionsCommand::List(args) => list(args, &svc.pool, json).await,
      VersionsCommand::Create(args) => create(args, svc, json).await,
      VersionsCommand::Pin(args) => pin(args, &svc.pool, json).await,
      VersionsCommand::Unpin(args) => unpin(args, &svc.pool, json).await,
      VersionsCommand::Restore(args) => restore(args, svc, json).await,
      VersionsCommand::Settings(cmd) => match cmd {
        SettingsCommand::Show(args) => settings_show(args, &svc.pool, json).await,
        SettingsCommand::Set(args) => settings_set(args, &svc.pool, json).await,
      },
    },
    DocCommand::Metadata(cmd) => doc_metadata::run(cmd, svc, json).await,
  }
}

#[instrument(skip(pool), level = "info")]
async fn list(args: ListArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  let repo = PgDocumentVersionRepository::new(pool.clone());
  let version_head = document_version_head(pool, doc_id).await?;
  let rows: Vec<VersionRow> = repo
    .list_for_doc(doc_id)
    .await
    .context("list document versions")?
    .into_iter()
    .map(|version| version_row(version, version_head))
    .collect();
  print_output(&rows, json);
  Ok(())
}

#[instrument(skip(svc), level = "info")]
async fn create(args: CreateArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  let label = sanitize_label(args.label)?;
  let description = sanitize_description(args.description);
  let (workspace_id, default_actor) = doc_workspace_and_actor(&svc.pool, doc_id).await?;
  let actor_id = parse_optional_uuid(args.actor.as_deref(), "actor")?.unwrap_or(default_actor);
  let version_repo = Arc::new(PgDocumentVersionRepository::new(svc.pool.clone()));
  let service = DocumentVersionCreateService::new(Arc::new(svc.doc.clone()), version_repo);
  let version = service
    .create(DocumentVersionCreateRequest::manual(
      doc_id,
      workspace_id,
      actor_id,
      Some(label),
      description,
    ))
    .await
    .map_err(|err| anyhow::anyhow!("create document version: {err}"))?;
  let version_head = document_version_head(&svc.pool, doc_id).await?;

  info!(%doc_id, %workspace_id, %actor_id, version_id = %version.id, history_id = version.doc_history_id, "CLI document version created");
  print_single(&version_row(version, version_head), json);
  Ok(())
}

#[instrument(skip(pool), level = "info")]
async fn pin(args: IdArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  set_pinned(args, pool, json, true).await
}

#[instrument(skip(pool), level = "info")]
async fn unpin(args: IdArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  set_pinned(args, pool, json, false).await
}

async fn set_pinned(args: IdArgs, pool: &PgPool, json: bool, pinned: bool) -> anyhow::Result<()> {
  let version_id = parse_uuid(&args.id, "id")?;
  let repo = PgDocumentVersionRepository::new(pool.clone());
  if pinned {
    repo.pin(version_id).await.context("pin document version")?;
  } else {
    repo.unpin(version_id).await.context("unpin document version")?;
  }
  let version = repo
    .get(version_id)
    .await
    .context("reload document version")?
    .with_context(|| format!("document version not found after pin update: {version_id}"))?;
  let version_head = document_version_head(pool, version.doc_id).await?;
  info!(%version_id, pinned, "CLI document version pin state changed");
  print_single(&version_row(version, version_head), json);
  Ok(())
}

#[instrument(skip(svc), level = "warn")]
async fn restore(args: RestoreArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let version_id = parse_uuid(&args.id, "id")?;
  let repo = PgDocumentVersionRepository::new(svc.pool.clone());
  let source = repo
    .get(version_id)
    .await
    .context("load source document version")?
    .with_context(|| format!("document version not found: {version_id}"))?;
  let actor_id = parse_optional_uuid(args.actor.as_deref(), "actor")?.unwrap_or(source.created_by);

  let restore_service = DocumentVersionRestoreService::new(Arc::new(svc.doc.clone()), Arc::new(repo));
  let restored = restore_service
    .restore(&source, actor_id, None)
    .await
    .map_err(|err| anyhow::anyhow!("restore document version: {err}"))?;
  let version_head = document_version_head(&svc.pool, restored.doc_id).await?;

  warn!(
    source_version_id = %version_id,
    new_version_id = %restored.id,
    doc_id = %restored.doc_id,
    actor_id = %actor_id,
    "CLI document version restored"
  );
  print_single(&version_row(restored, version_head), json);
  Ok(())
}

#[instrument(skip(pool), level = "info")]
async fn settings_show(args: SettingsShowArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  let repo = PgDocumentVersioningSettingsRepository::new(pool.clone());
  let settings = repo.get(doc_id).await.context("load document versioning settings")?;
  print_single(
    &settings_row(
      settings.doc_id,
      settings.enabled,
      settings.retention_count,
      &settings.auto_version_on,
    ),
    json,
  );
  Ok(())
}

#[instrument(skip(pool), level = "info")]
async fn settings_set(args: SettingsSetArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let doc_id = parse_uuid(&args.doc, "doc")?;
  assert_doc_exists(pool, doc_id).await?;
  let repo = PgDocumentVersioningSettingsRepository::new(pool.clone());

  if let Some(retention_count) = args.retention_count
    && !(1..=50).contains(&retention_count)
  {
    bail!("retention-count must be between 1 and 50");
  }

  if let Some(triggers) = args.triggers.as_ref() {
    let parsed = triggers
      .iter()
      .map(|trigger| parse_trigger(trigger))
      .collect::<anyhow::Result<Vec<_>>>()?;
    repo
      .set_triggers(doc_id, &parsed)
      .await
      .context("set auto-version triggers")?;
  }
  if let Some(retention_count) = args.retention_count {
    repo
      .set_retention_count(doc_id, retention_count)
      .await
      .context("set retention count")?;
  }
  if let Some(enabled) = args.enabled {
    repo.set_enabled(doc_id, enabled).await.context("set enabled flag")?;
  }

  let settings = repo.get(doc_id).await.context("reload document versioning settings")?;
  info!(
    %doc_id,
    enabled = settings.enabled,
    retention_count = settings.retention_count,
    triggers = ?settings.auto_version_on,
    "CLI document versioning settings updated"
  );
  print_single(
    &settings_row(
      settings.doc_id,
      settings.enabled,
      settings.retention_count,
      &settings.auto_version_on,
    ),
    json,
  );
  Ok(())
}

fn version_row(version: DocumentVersion, version_head: DocumentVersionHead) -> VersionRow {
  let current_version_id = version_head.current_version_id;
  VersionRow {
    id: version.id.to_string(),
    doc_id: version.doc_id.to_string(),
    workspace_id: version.workspace_id.to_string(),
    version_no: version.version_no.map(|value| value.to_string()).unwrap_or_default(),
    label: version.label,
    description: version.description.unwrap_or_default(),
    event: version.event.as_str().to_string(),
    kind: version.kind.as_str().to_string(),
    created_by: version.created_by.to_string(),
    created_at: version.created_at.to_rfc3339(),
    pinned: version.is_pinned,
    is_protected: version.is_protected,
    doc_history_id: version.doc_history_id,
    current_version_id: current_version_id.map(|id| id.to_string()).unwrap_or_default(),
    is_current_document_version: current_version_id == Some(version.id),
    dirty_since_current_version: version_head.dirty_since_current_version,
  }
}

async fn document_version_head(pool: &PgPool, doc_id: Uuid) -> anyhow::Result<DocumentVersionHead> {
  let row = sqlx::query(
    "SELECT current_version_id, dirty_since_current_version FROM docs WHERE id = $1 AND deleted_at IS NULL",
  )
  .bind(doc_id)
  .fetch_optional(pool)
  .await
  .context("load document version metadata head")?
  .with_context(|| format!("document not found: {doc_id}"))?;
  Ok(DocumentVersionHead {
    current_version_id: row.get("current_version_id"),
    dirty_since_current_version: row.get("dirty_since_current_version"),
  })
}

fn settings_row(doc_id: Uuid, enabled: bool, retention_count: i32, triggers: &[AutoVersionTrigger]) -> SettingsRow {
  SettingsRow {
    doc_id: doc_id.to_string(),
    enabled,
    retention_count,
    auto_version_on: triggers
      .iter()
      .map(AutoVersionTrigger::as_str)
      .collect::<Vec<_>>()
      .join(","),
  }
}

fn sanitize_label(label: String) -> anyhow::Result<String> {
  let trimmed = label.trim();
  if trimmed.is_empty() {
    bail!("label must not be empty");
  }
  if trimmed.len() > 160 {
    bail!("label must be at most 160 bytes");
  }
  Ok(trimmed.to_string())
}

fn sanitize_description(description: Option<String>) -> Option<String> {
  description.and_then(|value| {
    let trimmed = value.trim();
    if trimmed.is_empty() {
      None
    } else {
      Some(trimmed.chars().take(2048).collect())
    }
  })
}

fn parse_uuid(value: &str, field: &str) -> anyhow::Result<Uuid> {
  Uuid::parse_str(value).with_context(|| format!("invalid {field} UUID: {value}"))
}

fn parse_optional_uuid(value: Option<&str>, field: &str) -> anyhow::Result<Option<Uuid>> {
  value.map(|raw| parse_uuid(raw, field)).transpose()
}

fn parse_trigger(value: &str) -> anyhow::Result<AutoVersionTrigger> {
  match value.trim() {
    "on_publish" | "on-publish" => Ok(AutoVersionTrigger::OnPublish),
    "on_pdf_export" | "on-pdf-export" => Ok(AutoVersionTrigger::OnPdfExport),
    "daily" => Ok(AutoVersionTrigger::Daily),
    other => bail!("invalid trigger '{other}', expected on_publish,on_pdf_export,daily"),
  }
}

async fn assert_doc_exists(pool: &PgPool, doc_id: Uuid) -> anyhow::Result<()> {
  let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1 AND deleted_at IS NULL)")
    .bind(doc_id)
    .fetch_one(pool)
    .await
    .context("check document existence")?;
  if !exists {
    bail!("document not found: {doc_id}");
  }
  Ok(())
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
