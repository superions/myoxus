//! `database` subcommand — Database diagnostics and CSV operations.
//!
//! The CLI intentionally goes through the Database application services instead of
//! reading product tables directly. That keeps ACL, validation, CSV limits,
//! projection semantics and future service hooks aligned with GraphQL/Web.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Args, Subcommand, ValueEnum};
use myoxus_application::database::{
  DatabaseFormulaRecomputeOutcome, DatabaseRollupRecomputeOutcome, DatabaseServiceError,
  LegacyDatabaseMigrationApplyResult, LegacyDatabaseMigrationPlan,
};
use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseCsvDelimiter, DatabaseCsvDialect, DatabaseCsvImportOptions, DatabaseField,
  DatabaseJsonConflictStrategy, DatabaseJsonImportMode, DatabaseJsonImportOptions, DatabaseRecord, DatabaseSummary,
  DatabaseView,
};
use myoxus_domain::ids::{DatabaseId, DatabaseViewId, DocId, UserId, WorkspaceId};
use myoxus_domain::repositories::PageRequest;
use serde::Serialize;
use tabled::Tabled;
use tracing::{info, instrument};

use crate::output::{print_json, print_output, print_single};
use crate::services::Services;

#[derive(Subcommand)]
pub enum DatabaseCommand {
  /// List admitted Project assistant descriptors without creating content.
  Assistants(DatabaseAssistantListArgs),
  /// Prepare a Project; write only with the explicitly reviewed plan digest.
  Project(DatabaseAssistantProjectArgs),
  /// Read accepted Project setup and its fixed results without resuming writes.
  ProjectStatus(DatabaseAssistantRequestArgs),
  /// Request stopping accepted setup while preserving its existing contents.
  ProjectStop(DatabaseAssistantRequestArgs),
  /// List Databases in one workspace.
  List(DatabaseListArgs),
  /// Show one Database with fields and views.
  Show(DatabaseShowArgs),
  /// List rows and rendered cell payloads for one database.
  Rows(DatabaseRowsArgs),
  /// List saved views for one database.
  Views(DatabaseShowArgs),
  /// Export one database or view as CSV.
  ExportCsv(DatabaseExportCsvArgs),
  /// Preview a CSV import without writing data.
  ImportCsvPreview(DatabaseImportCsvArgs),
  /// Import a CSV file into a new Database.
  ImportCsv(DatabaseImportCsvArgs),
  /// Export one database as a Myoxus JSON snapshot.
  ExportJson(DatabaseExportJsonArgs),
  /// Preview a Myoxus JSON snapshot import without writing data.
  ImportJsonPreview(DatabaseImportJsonArgs),
  /// Import a Myoxus JSON snapshot using create / replace / merge modes.
  ImportJson(DatabaseImportJsonArgs),
  /// Export one database as a Notion-oriented HTML page set.
  ExportNotion(DatabaseExportNotionArgs),
  /// Preview a Notion HTML / ZIP import without writing data.
  ImportNotionPreview(DatabaseImportNotionArgs),
  /// Import a Notion HTML / ZIP archive.
  ImportNotion(DatabaseImportNotionArgs),
  /// Preview migration of persisted editor-local Databases without writes.
  MigrateLegacyPreview(DatabaseMigrateLegacyArgs),
  /// Migrate persisted editor-local Databases to server-backed references.
  MigrateLegacy(DatabaseMigrateLegacyArgs),
  /// Recompute stale Rollup and/or Formula projections.
  RecomputeProjections(DatabaseRecomputeArgs),
}

#[derive(Args, Debug)]
pub struct ActorArgs {
  /// User UUID whose normal workspace/doc permissions are used.
  #[arg(long)]
  pub actor_user_id: UserId,
}

#[derive(Args, Debug)]
pub struct DatabaseAssistantListArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  #[arg(long)]
  pub workspace_id: WorkspaceId,
}
#[derive(Args, Debug)]
pub struct DatabaseAssistantProjectArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  #[arg(long)]
  pub package_id: String,
  #[arg(long)]
  pub package_version: String,
  #[arg(long)]
  pub package_digest: String,
  /// JSON map of declared tagged native values (at most 1 MiB including tags).
  #[arg(long)]
  pub answers: PathBuf,
  /// Apply only this canonical reviewed plan; omission performs no writes.
  #[arg(long, requires = "request_id")]
  pub confirm_plan: Option<String>,
  /// Stable request UUID, retained across lost responses and explicit resumes.
  #[arg(long)]
  pub request_id: Option<uuid::Uuid>,
  /// Explicitly accept changed reviewed effects for the same reserved results.
  #[arg(long, requires = "confirm_plan")]
  pub admission_confirmation: Option<String>,
  /// Prepared locale, required for confirmation; preparation may inherit the actor.
  #[arg(long)]
  pub locale: Option<String>,
  /// Native document consumer version, required only for selected documents.
  #[arg(long)]
  pub client_version: Option<u32>,
}

#[derive(Args, Debug)]
pub struct DatabaseAssistantRequestArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  #[arg(long)]
  pub request_id: uuid::Uuid,
}

#[derive(Args, Debug)]
pub struct DatabaseListArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Workspace UUID.
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  /// Maximum records to return.
  #[arg(long, default_value_t = 50)]
  pub limit: i64,
  /// Offset for paginated reads.
  #[arg(long, default_value_t = 0)]
  pub offset: i64,
}

#[derive(Args, Debug)]
pub struct DatabaseShowArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Database UUID.
  #[arg(long)]
  pub database_id: DatabaseId,
}

#[derive(Args, Debug)]
pub struct DatabaseRowsArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Database UUID.
  #[arg(long)]
  pub database_id: DatabaseId,
  /// Maximum rows to return.
  #[arg(long, default_value_t = 50)]
  pub limit: i64,
  /// Offset for paginated reads.
  #[arg(long, default_value_t = 0)]
  pub offset: i64,
}

#[derive(Args, Debug)]
pub struct DatabaseExportCsvArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Database UUID.
  #[arg(long)]
  pub database_id: DatabaseId,
  /// Optional saved view UUID. When omitted, the service exports database order.
  #[arg(long)]
  pub view_id: Option<DatabaseViewId>,
  /// Write CSV to this file. When omitted in human mode, CSV is printed to stdout.
  #[arg(long, short = 'o')]
  pub output: Option<PathBuf>,
}

#[derive(Args, Debug)]
pub struct DatabaseImportCsvArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Workspace UUID where the new database will be created.
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  /// Title for the imported Database.
  #[arg(long)]
  pub database_title: String,
  /// CSV file path.
  pub csv_path: PathBuf,
}

#[derive(Args, Debug)]
pub struct DatabaseExportJsonArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Database UUID.
  #[arg(long)]
  pub database_id: DatabaseId,
  /// Write JSON snapshot to this file. When omitted in human mode, JSON is printed to stdout.
  #[arg(long, short = 'o')]
  pub output: Option<PathBuf>,
}

#[derive(Args, Debug)]
pub struct DatabaseImportJsonArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Workspace UUID.
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  /// Import mode: create (new database), replace or merge.
  #[arg(long, value_enum, default_value_t = DatabaseJsonImportCliMode::Create)]
  pub mode: DatabaseJsonImportCliMode,
  /// Optional target database UUID. Required for replace / merge modes.
  #[arg(long)]
  pub target_database_id: Option<DatabaseId>,
  /// Optional target workspace UUID when the snapshot needs to land in
  /// a different workspace than the actor's default.
  #[arg(long)]
  pub target_workspace_id: Option<WorkspaceId>,
  /// Conflict strategy. Defaults to abort.
  #[arg(long, value_enum, default_value_t = DatabaseJsonConflictCliStrategy::Abort)]
  pub conflict_strategy: DatabaseJsonConflictCliStrategy,
  /// Required acknowledgement for `replace` mode. Without this flag
  /// the import refuses to wipe the target database.
  #[arg(long, default_value_t = false)]
  pub confirm_destructive: bool,
  /// Parse + plan without writing data.
  #[arg(long, default_value_t = false)]
  pub dry_run: bool,
  /// JSON snapshot file path.
  pub json_path: PathBuf,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[clap(rename_all = "snake_case")]
pub enum DatabaseJsonConflictCliStrategy {
  Abort,
  Rename,
  Overwrite,
}

impl From<DatabaseJsonConflictCliStrategy> for DatabaseJsonConflictStrategy {
  fn from(value: DatabaseJsonConflictCliStrategy) -> Self {
    match value {
      DatabaseJsonConflictCliStrategy::Abort => DatabaseJsonConflictStrategy::Abort,
      DatabaseJsonConflictCliStrategy::Rename => DatabaseJsonConflictStrategy::Rename,
      DatabaseJsonConflictCliStrategy::Overwrite => DatabaseJsonConflictStrategy::Overwrite,
    }
  }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[clap(rename_all = "snake_case")]
pub enum DatabaseJsonImportCliMode {
  Create,
  Replace,
  Merge,
}

impl From<DatabaseJsonImportCliMode> for DatabaseJsonImportMode {
  fn from(value: DatabaseJsonImportCliMode) -> Self {
    match value {
      DatabaseJsonImportCliMode::Create => DatabaseJsonImportMode::Create,
      DatabaseJsonImportCliMode::Replace => DatabaseJsonImportMode::Replace,
      DatabaseJsonImportCliMode::Merge => DatabaseJsonImportMode::Merge,
    }
  }
}

#[derive(Args, Debug)]
pub struct DatabaseExportNotionArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Database UUID.
  #[arg(long)]
  pub database_id: DatabaseId,
  /// Output directory for the Notion HTML pages. When omitted, the CLI prints
  /// the resulting pages to stdout (one HTML block per page) for piping.
  #[arg(long, short = 'o')]
  pub output_dir: Option<PathBuf>,
}

#[derive(Args, Debug)]
pub struct DatabaseImportNotionArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Workspace UUID where the new database will be created.
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  /// Import mode.
  #[arg(long, value_enum, default_value_t = DatabaseJsonImportCliMode::Create)]
  pub mode: DatabaseJsonImportCliMode,
  /// Optional target database UUID. Required for replace / merge modes.
  #[arg(long)]
  pub target_database_id: Option<DatabaseId>,
  /// Conflict strategy. Defaults to abort.
  #[arg(long, value_enum, default_value_t = DatabaseJsonConflictCliStrategy::Abort)]
  pub conflict_strategy: DatabaseJsonConflictCliStrategy,
  /// Required acknowledgement for `replace` mode.
  #[arg(long, default_value_t = false)]
  pub confirm_destructive: bool,
  /// Parse + plan without writing data.
  #[arg(long, default_value_t = false)]
  pub dry_run: bool,
  /// Notion HTML / ZIP file path.
  pub notion_path: PathBuf,
}

#[derive(Args, Debug)]
pub struct DatabaseRecomputeArgs {
  /// Optional workspace UUID. Omit to process stale projections globally.
  #[arg(long)]
  pub workspace_id: Option<WorkspaceId>,
  /// Maximum projection tasks to inspect.
  #[arg(long, default_value_t = 100)]
  pub limit: i64,
  /// Maximum databases represented in one batch.
  #[arg(long, default_value_t = 25)]
  pub database_limit: i64,
  /// Projection family to recompute.
  #[arg(long, value_enum, default_value_t = RecomputeKind::All)]
  pub kind: RecomputeKind,
}

#[derive(Args, Debug)]
pub struct DatabaseMigrateLegacyArgs {
  #[command(flatten)]
  pub actor: ActorArgs,
  /// Workspace containing the persisted documents.
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  /// Document to inspect or migrate. Repeat for multiple documents.
  #[arg(long = "document-id", required = true)]
  pub document_ids: Vec<DocId>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum RecomputeKind {
  All,
  Rollups,
  Formulas,
}

#[derive(Serialize, Tabled)]
struct DatabaseListRow {
  id: String,
  workspace_id: String,
  title: String,
  fields: usize,
  views: usize,
  rows: i64,
  updated_at: String,
}

#[derive(Serialize, Tabled)]
struct DatabaseFieldRow {
  id: String,
  name: String,
  field_type: String,
  required: bool,
  position: i32,
}

#[derive(Serialize, Tabled)]
struct DatabaseViewRow {
  id: String,
  name: String,
  view_kind: String,
  position: i32,
  config: String,
}

#[derive(Serialize, Tabled)]
struct DatabaseRowOutput {
  id: String,
  content_document_id: String,
  title: String,
  redacted: bool,
  cells: String,
  updated_at: String,
}

#[derive(Serialize, Tabled)]
struct CsvExportRow {
  database_id: String,
  view_id: String,
  file_name: String,
  content_type: String,
  rows: i32,
  columns: i32,
  output: String,
}

#[derive(Serialize, Tabled)]
struct ProjectionRecomputeRow {
  kind: String,
  requested: i64,
  recomputed: i64,
  failed: i64,
  skipped: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDatabaseMigrationReferenceOutput {
  source_document_id: String,
  block_id: String,
  target_database_id: String,
  target_view_id: Option<String>,
  already_migrated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDatabaseMigrationPlanOutput {
  database_ids: Vec<String>,
  block_references: Vec<LegacyDatabaseMigrationReferenceOutput>,
  field_count: usize,
  row_count: usize,
  cell_count: usize,
  view_count: usize,
  diagnostics: Vec<myoxus_workspace_import::WorkspaceImportDiagnostic>,
  apply_allowed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDatabaseMigrationApplyOutput {
  plan: LegacyDatabaseMigrationPlanOutput,
  created_database_ids: Vec<String>,
  migrated_block_count: usize,
}

pub async fn run(cmd: DatabaseCommand, svc: &Services, json: bool) -> Result<()> {
  match cmd {
    DatabaseCommand::Assistants(args) => assistant_list(args, svc, json).await,
    DatabaseCommand::Project(args) => assistant_project(args, svc, json).await,
    DatabaseCommand::ProjectStatus(args) => assistant_project_request(args, svc, json, false).await,
    DatabaseCommand::ProjectStop(args) => assistant_project_request(args, svc, json, true).await,
    DatabaseCommand::List(args) => list(args, svc, json).await,
    DatabaseCommand::Show(args) => show(args, svc, json).await,
    DatabaseCommand::Rows(args) => rows(args, svc, json).await,
    DatabaseCommand::Views(args) => views(args, svc, json).await,
    DatabaseCommand::ExportCsv(args) => export_csv(args, svc, json).await,
    DatabaseCommand::ImportCsvPreview(args) => import_csv_preview(args, svc, json).await,
    DatabaseCommand::ImportCsv(args) => import_csv(args, svc, json).await,
    DatabaseCommand::ExportJson(args) => export_json(args, svc, json).await,
    DatabaseCommand::ImportJsonPreview(args) => import_json_preview(args, svc, json).await,
    DatabaseCommand::ImportJson(args) => import_json(args, svc, json).await,
    DatabaseCommand::ExportNotion(args) => export_notion(args, svc, json).await,
    DatabaseCommand::ImportNotionPreview(args) => import_notion_preview(args, svc, json).await,
    DatabaseCommand::ImportNotion(args) => import_notion(args, svc, json).await,
    DatabaseCommand::MigrateLegacyPreview(args) => migrate_legacy_preview(args, svc, json).await,
    DatabaseCommand::MigrateLegacy(args) => migrate_legacy(args, svc, json).await,
    DatabaseCommand::RecomputeProjections(args) => recompute_projections(args, svc, json).await,
  }
}

async fn migrate_legacy_preview(args: DatabaseMigrateLegacyArgs, svc: &Services, json: bool) -> Result<()> {
  let limits = svc.workspace_import_policy().await?.limits;
  let plan = svc
    .databases
    .import_export
    .preview_legacy_database_migration(args.actor.actor_user_id, args.workspace_id, &args.document_ids, limits)
    .await
    .map_err(map_database_error)?;
  print_json_or_debug(&legacy_migration_plan_output(plan), json);
  Ok(())
}

async fn migrate_legacy(args: DatabaseMigrateLegacyArgs, svc: &Services, json: bool) -> Result<()> {
  let limits = svc.workspace_import_policy().await?.limits;
  let result = svc
    .databases
    .import_export
    .apply_legacy_database_migration(args.actor.actor_user_id, args.workspace_id, &args.document_ids, limits)
    .await
    .map_err(map_database_error)?;
  print_json_or_debug(&legacy_migration_apply_output(result), json);
  Ok(())
}

async fn list(args: DatabaseListArgs, svc: &Services, json: bool) -> Result<()> {
  let records = svc
    .databases
    .views
    .list_databases(
      args.actor.actor_user_id,
      args.workspace_id,
      page(args.limit, args.offset),
      Default::default(),
    )
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&records);
  } else {
    let rows = records.iter().map(summary_row).collect::<Vec<_>>();
    print_output(&rows, false);
  }
  Ok(())
}

async fn show(args: DatabaseShowArgs, svc: &Services, json: bool) -> Result<()> {
  let record = svc
    .databases
    .definition
    .get_database(args.actor.actor_user_id, args.database_id)
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&record);
  } else {
    print_single(&record_row(&record), false);
    print_output(&field_rows(&record.fields), false);
    print_output(&view_rows(&record.views)?, false);
  }
  Ok(())
}

async fn rows(args: DatabaseRowsArgs, svc: &Services, json: bool) -> Result<()> {
  let page = svc
    .databases
    .views
    .list_rows(
      args.actor.actor_user_id,
      args.database_id,
      page(args.limit, args.offset),
    )
    .await
    .map_err(map_database_error)?;
  if json {
    let rows = page
      .rows
      .iter()
      .map(|row| row_output(&row.row, &row.cells, row.redacted))
      .collect::<Result<Vec<_>>>()?;
    print_json(&serde_json::json!({
      "rows": rows,
      "totalCount": page.total_count,
    }));
  } else {
    let rows = page
      .rows
      .iter()
      .map(|row| row_output(&row.row, &row.cells, row.redacted))
      .collect::<Result<Vec<_>>>()?;
    print_output(&rows, false);
  }
  Ok(())
}

async fn views(args: DatabaseShowArgs, svc: &Services, json: bool) -> Result<()> {
  let record = svc
    .databases
    .definition
    .get_database(args.actor.actor_user_id, args.database_id)
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&record.views);
  } else {
    print_output(&view_rows(&record.views)?, false);
  }
  Ok(())
}

async fn export_csv(args: DatabaseExportCsvArgs, svc: &Services, json: bool) -> Result<()> {
  let export = svc
    .databases
    .import_export
    .export_csv(
      args.actor.actor_user_id,
      args.database_id,
      args.view_id,
      DatabaseCsvDialect {
        delimiter: DatabaseCsvDelimiter::Comma,
        ..Default::default()
      },
    )
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&export);
    return Ok(());
  }
  if let Some(path) = args.output.as_ref() {
    std::fs::write(path, export.content.as_bytes())
      .with_context(|| format!("write Database CSV export to {}", path.display()))?;
    print_single(
      &CsvExportRow {
        database_id: export.database_id.to_string(),
        view_id: export.view_id.map(|id| id.to_string()).unwrap_or_default(),
        file_name: export.file_name,
        content_type: export.content_type,
        rows: export.row_count,
        columns: export.column_count,
        output: path.display().to_string(),
      },
      false,
    );
  } else {
    print!("{}", export.content);
  }
  Ok(())
}

async fn import_csv_preview(args: DatabaseImportCsvArgs, svc: &Services, json: bool) -> Result<()> {
  let content =
    std::fs::read(&args.csv_path).with_context(|| format!("read Database CSV file {}", args.csv_path.display()))?;
  let preview = svc
    .databases
    .import_export
    .preview_csv_import(
      args.actor.actor_user_id,
      args.workspace_id,
      args.database_title,
      content.as_slice(),
      DatabaseCsvImportOptions::default(),
    )
    .await
    .map_err(map_database_error)?;
  print_json_or_debug(&preview, json);
  Ok(())
}

async fn import_csv(args: DatabaseImportCsvArgs, svc: &Services, json: bool) -> Result<()> {
  let content =
    std::fs::read(&args.csv_path).with_context(|| format!("read Database CSV file {}", args.csv_path.display()))?;
  let result = svc
    .databases
    .import_export
    .import_csv(
      args.actor.actor_user_id,
      args.workspace_id,
      args.database_title,
      content.as_slice(),
      DatabaseCsvImportOptions::default(),
    )
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&result);
  } else {
    print_single(&record_row(&result.database), false);
    println!(
      "Created {} fields, {} rows and {} content documents; skipped {} rows.",
      result.created_field_count, result.created_row_count, result.created_doc_count, result.skipped_row_count
    );
    if !result.warnings.is_empty() {
      print_json(&result.warnings);
    }
  }
  Ok(())
}

fn build_import_options(args: &DatabaseImportJsonArgs) -> DatabaseJsonImportOptions {
  DatabaseJsonImportOptions {
    mode: args.mode.into(),
    conflict_strategy: args.conflict_strategy.into(),
    target_workspace_id: args.target_workspace_id.or(Some(args.workspace_id)),
    target_database_id: args.target_database_id,
    dry_run: args.dry_run,
    field_mapping: Default::default(),
    confirm_destructive: args.confirm_destructive,
  }
}

fn build_notion_import_options(args: &DatabaseImportNotionArgs) -> DatabaseJsonImportOptions {
  DatabaseJsonImportOptions {
    mode: args.mode.into(),
    conflict_strategy: args.conflict_strategy.into(),
    target_workspace_id: Some(args.workspace_id),
    target_database_id: args.target_database_id,
    dry_run: args.dry_run,
    field_mapping: Default::default(),
    confirm_destructive: args.confirm_destructive,
  }
}

async fn export_json(args: DatabaseExportJsonArgs, svc: &Services, json: bool) -> Result<()> {
  let export = svc
    .databases
    .import_export
    .export_json(args.actor.actor_user_id, args.database_id)
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&export);
    return Ok(());
  }
  if let Some(path) = args.output.as_ref() {
    std::fs::write(path, export.content.as_bytes())
      .with_context(|| format!("write Database JSON export to {}", path.display()))?;
    println!(
      "Wrote {} ({} bytes, content-type {})",
      path.display(),
      export.content.len(),
      export.content_type
    );
  } else {
    print!("{}", export.content);
  }
  Ok(())
}

async fn import_json_preview(args: DatabaseImportJsonArgs, svc: &Services, json: bool) -> Result<()> {
  let content =
    std::fs::read(&args.json_path).with_context(|| format!("read Database JSON file {}", args.json_path.display()))?;
  let preview = svc
    .databases
    .import_export
    .preview_json_import_with_options(
      args.actor.actor_user_id,
      args.workspace_id,
      content.as_slice(),
      build_import_options(&args),
    )
    .await
    .map_err(map_database_error)?;
  print_json_or_debug(&preview, json);
  Ok(())
}

async fn import_json(args: DatabaseImportJsonArgs, svc: &Services, json: bool) -> Result<()> {
  let content =
    std::fs::read(&args.json_path).with_context(|| format!("read Database JSON file {}", args.json_path.display()))?;
  let result = svc
    .databases
    .import_export
    .import_json_with_options(
      args.actor.actor_user_id,
      args.workspace_id,
      content.as_slice(),
      build_import_options(&args),
      None,
    )
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&result);
  } else {
    print_single(&record_row(&result.database), false);
    println!(
      "Imported database (mode={:?}, strategy={:?}, dry_run={}) — created {} fields / {} rows / {} templates, updated {} rows, skipped {} rows, missing files {}.",
      result.mode,
      result.conflict_strategy,
      result.dry_run,
      result.created_field_count,
      result.created_row_count,
      result.created_template_count,
      result.updated_row_count,
      result.skipped_row_count,
      result.missing_file_count,
    );
    if !result.warnings.is_empty() {
      print_json(&result.warnings);
    }
    if !result.conflict_warnings.is_empty() {
      print_json(&result.conflict_warnings);
    }
  }
  Ok(())
}

#[instrument(skip(svc, args), fields(actor_id = %args.actor.actor_user_id, database_id = %args.database_id, output_dir = ?args.output_dir.as_ref().map(|p| p.display().to_string())))]
async fn export_notion(args: DatabaseExportNotionArgs, svc: &Services, json: bool) -> Result<()> {
  info!("cli: notion export starting");
  let export = svc
    .databases
    .import_export
    .export_notion(args.actor.actor_user_id, args.database_id)
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&export);
    return Ok(());
  }
  if let Some(dir) = args.output_dir.as_ref() {
    std::fs::create_dir_all(dir).with_context(|| format!("create Notion export directory {}", dir.display()))?;
    for page in &export.pages {
      let path = dir.join(&page.filename);
      std::fs::write(&path, page.content.as_bytes())
        .with_context(|| format!("write Notion page to {}", path.display()))?;
      println!("Wrote {} ({} bytes).", path.display(), page.content.len());
    }
  } else {
    for page in &export.pages {
      println!("----- {} -----", page.title);
      println!("{}", page.content);
    }
  }
  if !export.diagnostics.is_empty() {
    eprintln!("Notion export emitted {} diagnostic(s).", export.diagnostics.len());
    for diag in &export.diagnostics {
      eprintln!(
        "  {}:{} {} — {}",
        diag.severity.as_str(),
        diag.code,
        diag.path,
        diag.message
      );
    }
  }
  Ok(())
}

#[instrument(skip(svc, args), fields(actor_id = %args.actor.actor_user_id, workspace_id = %args.workspace_id, notion_path = %args.notion_path.display()))]
async fn import_notion_preview(args: DatabaseImportNotionArgs, svc: &Services, json: bool) -> Result<()> {
  info!("cli: notion import preview starting");
  let content =
    std::fs::read(&args.notion_path).with_context(|| format!("read Notion archive {}", args.notion_path.display()))?;
  // The dry-run / strategy / mode flags are surfaced on the preview
  // payload by the JSON-import layer; the Notion preview delegates to
  // the same code path so the wizard UI can render diagnostics
  // consistently for both archive types.
  let notion_result = svc
    .databases
    .import_export
    .preview_notion_import(args.actor.actor_user_id, args.workspace_id, content.as_slice())
    .await
    .map_err(map_database_error)?;
  print_json_or_debug(&notion_result, json);
  Ok(())
}

#[instrument(skip(svc, args), fields(actor_id = %args.actor.actor_user_id, workspace_id = %args.workspace_id, notion_path = %args.notion_path.display()))]
async fn import_notion(args: DatabaseImportNotionArgs, svc: &Services, json: bool) -> Result<()> {
  info!("cli: notion import apply starting");
  let content =
    std::fs::read(&args.notion_path).with_context(|| format!("read Notion archive {}", args.notion_path.display()))?;
  let options = build_notion_import_options(&args);
  let result = svc
    .databases
    .import_export
    .import_notion(args.actor.actor_user_id, args.workspace_id, content.as_slice(), options)
    .await
    .map_err(map_database_error)?;
  if json {
    print_json(&result);
  } else {
    print_single(&record_row(&result.database), false);
    println!(
      "Imported Notion database (mode={:?}, strategy={:?}, dry_run={}) — created {} fields / {} rows / {} templates, updated {} rows, skipped {} rows, missing files {}.",
      result.mode,
      result.conflict_strategy,
      result.dry_run,
      result.created_field_count,
      result.created_row_count,
      result.created_template_count,
      result.updated_row_count,
      result.skipped_row_count,
      result.missing_file_count,
    );
    if !result.warnings.is_empty() {
      print_json(&result.warnings);
    }
    if !result.conflict_warnings.is_empty() {
      print_json(&result.conflict_warnings);
    }
  }
  Ok(())
}

async fn recompute_projections(args: DatabaseRecomputeArgs, svc: &Services, json: bool) -> Result<()> {
  let mut rows = Vec::new();
  if matches!(args.kind, RecomputeKind::All | RecomputeKind::Rollups) {
    rows.push(rollup_row(
      svc
        .databases
        .projection
        .recompute_stale_rollups(args.workspace_id, args.limit, args.database_limit, "cli")
        .await
        .map_err(map_database_error)?,
    ));
  }
  if matches!(args.kind, RecomputeKind::All | RecomputeKind::Formulas) {
    rows.push(formula_row(
      svc
        .databases
        .projection
        .recompute_stale_formulas(args.workspace_id, args.limit, args.database_limit, "cli")
        .await
        .map_err(map_database_error)?,
    ));
  }
  print_output(&rows, json);
  Ok(())
}

fn page(limit: i64, offset: i64) -> PageRequest {
  PageRequest {
    limit: limit.max(1),
    offset: offset.max(0),
  }
}

fn record_row(record: &DatabaseRecord) -> DatabaseListRow {
  DatabaseListRow {
    id: record.database.id.to_string(),
    workspace_id: record.database.workspace_id.to_string(),
    title: record.database.title.clone(),
    fields: record.fields.len(),
    views: record.views.len(),
    rows: record.row_count,
    updated_at: record.database.updated_at.to_rfc3339(),
  }
}

fn summary_row(summary: &DatabaseSummary) -> DatabaseListRow {
  DatabaseListRow {
    id: summary.id.to_string(),
    workspace_id: summary.workspace_id.to_string(),
    title: summary.title.clone(),
    fields: summary.field_count.try_into().unwrap_or(usize::MAX),
    views: summary.view_count.try_into().unwrap_or(usize::MAX),
    rows: summary.row_count,
    updated_at: summary.updated_at.to_rfc3339(),
  }
}

fn field_rows(fields: &[DatabaseField]) -> Vec<DatabaseFieldRow> {
  fields
    .iter()
    .map(|field| DatabaseFieldRow {
      id: field.id.to_string(),
      name: field.name.clone(),
      field_type: field.field_type.as_str().to_string(),
      required: field.required,
      position: field.position,
    })
    .collect()
}

fn view_rows(views: &[DatabaseView]) -> Result<Vec<DatabaseViewRow>> {
  views
    .iter()
    .map(|view| {
      Ok(DatabaseViewRow {
        id: view.id.to_string(),
        name: view.name.clone(),
        view_kind: view.view_kind.as_str().to_string(),
        position: view.position,
        config: serde_json::to_string(&view.config).context("serialize Database view config")?,
      })
    })
    .collect()
}

fn row_output(
  row: &myoxus_domain::database::DatabaseRow,
  cells: &[myoxus_domain::database::DatabaseCellValue],
  redacted: bool,
) -> Result<DatabaseRowOutput> {
  Ok(DatabaseRowOutput {
    id: row.id.to_string(),
    content_document_id: row
      .content_document_id
      .map(|document_id| document_id.to_string())
      .unwrap_or_default(),
    title: if redacted {
      "<redacted>".to_string()
    } else {
      row.title.clone()
    },
    redacted,
    cells: serde_json::to_string(
      &cells
        .iter()
        .map(|cell| {
          serde_json::json!({
            "fieldId": cell.field_id,
            "fieldType": cell.field_type.as_str(),
            "value": display_cell_value(&cell.value),
          })
        })
        .collect::<Vec<_>>(),
    )
    .context("serialize Database row cells")?,
    updated_at: row.updated_at.to_rfc3339(),
  })
}

fn display_cell_value(value: &DatabaseCellValueData) -> serde_json::Value {
  match value {
    DatabaseCellValueData::Text(value)
    | DatabaseCellValueData::Select(value)
    | DatabaseCellValueData::Status(value)
    | DatabaseCellValueData::Url(value)
    | DatabaseCellValueData::Email(value)
    | DatabaseCellValueData::Phone(value) => serde_json::Value::String(value.clone()),
    DatabaseCellValueData::RichText(value) => serde_json::json!(value),
    DatabaseCellValueData::Number(value) | DatabaseCellValueData::Percent(value) => serde_json::json!(value),
    DatabaseCellValueData::Currency(value) => serde_json::json!(value),
    DatabaseCellValueData::Duration(value) => serde_json::json!(value),
    DatabaseCellValueData::Checkbox(value) => serde_json::json!(value),
    DatabaseCellValueData::Date(value) => serde_json::json!(value),
    DatabaseCellValueData::DateTime(value) => serde_json::json!(value),
    DatabaseCellValueData::Files(value) => serde_json::json!(value),
    DatabaseCellValueData::UniqueId(value) => serde_json::json!(value),
    DatabaseCellValueData::MultiSelect(value) => serde_json::json!(value),
    DatabaseCellValueData::Tags(value) => serde_json::json!(value),
    DatabaseCellValueData::User(value)
    | DatabaseCellValueData::CreatedBy(value)
    | DatabaseCellValueData::UpdatedBy(value) => serde_json::json!(value),
    DatabaseCellValueData::Users(value) => serde_json::json!(value),
    DatabaseCellValueData::DocumentLink(value) => {
      let mut reference = serde_json::json!({ "docId": value.doc_id });
      if let Some(workspace_id) = value.workspace_id {
        reference["workspaceId"] = serde_json::json!(workspace_id);
      }
      reference
    }
    DatabaseCellValueData::Relation(value) => serde_json::json!(value),
    DatabaseCellValueData::Rollup(value) => serde_json::json!(value),
    DatabaseCellValueData::Formula(value) => serde_json::json!(value),
    DatabaseCellValueData::CreatedTime(value) | DatabaseCellValueData::UpdatedTime(value) => {
      serde_json::json!(value)
    }
  }
}

fn rollup_row(outcome: DatabaseRollupRecomputeOutcome) -> ProjectionRecomputeRow {
  ProjectionRecomputeRow {
    kind: "rollups".to_string(),
    requested: outcome.requested_count,
    recomputed: outcome.recomputed_count,
    failed: outcome.failed_count,
    skipped: outcome.skipped_count,
  }
}

fn formula_row(outcome: DatabaseFormulaRecomputeOutcome) -> ProjectionRecomputeRow {
  ProjectionRecomputeRow {
    kind: "formulas".to_string(),
    requested: outcome.requested_count,
    recomputed: outcome.recomputed_count,
    failed: outcome.failed_count,
    skipped: outcome.skipped_count,
  }
}

fn legacy_migration_plan_output(plan: LegacyDatabaseMigrationPlan) -> LegacyDatabaseMigrationPlanOutput {
  LegacyDatabaseMigrationPlanOutput {
    database_ids: plan
      .databases
      .iter()
      .map(|database| database.target_id.to_string())
      .collect(),
    block_references: plan
      .block_references
      .into_iter()
      .map(|reference| LegacyDatabaseMigrationReferenceOutput {
        source_document_id: reference.source_document_id,
        block_id: reference.block_id,
        target_database_id: reference.target_database_id.to_string(),
        target_view_id: reference.target_view_id.map(|id| id.to_string()),
        already_migrated: reference.already_migrated,
      })
      .collect(),
    field_count: plan.field_count,
    row_count: plan.row_count,
    cell_count: plan.cell_count,
    view_count: plan.view_count,
    diagnostics: plan.diagnostics,
    apply_allowed: plan.apply_allowed,
  }
}

fn legacy_migration_apply_output(result: LegacyDatabaseMigrationApplyResult) -> LegacyDatabaseMigrationApplyOutput {
  LegacyDatabaseMigrationApplyOutput {
    plan: legacy_migration_plan_output(result.plan),
    created_database_ids: result
      .created_database_ids
      .into_iter()
      .map(|id| id.to_string())
      .collect(),
    migrated_block_count: result.migrated_block_count,
  }
}

fn map_database_error(error: DatabaseServiceError) -> anyhow::Error {
  anyhow::anyhow!("{}: {}", error.code, error.message)
}

fn print_json_or_debug<T>(value: &T, json: bool)
where
  T: Serialize + std::fmt::Debug,
{
  if json {
    print_json(value);
  } else {
    println!("{value:#?}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;

  #[test]
  fn p10_database_cli_formats_projection_values_as_json_scalars() {
    let now = Utc::now();
    let user_id = uuid::Uuid::nil();
    assert_eq!(
      display_cell_value(&DatabaseCellValueData::CreatedTime(now)),
      serde_json::json!(now)
    );
    assert_eq!(
      display_cell_value(&DatabaseCellValueData::UpdatedBy(user_id)),
      serde_json::json!(user_id)
    );
  }

  #[test]
  fn p10_database_cli_clamps_negative_page_inputs_before_service_limits() {
    let page = page(-5, -10);
    assert_eq!(page.limit, 1);
    assert_eq!(page.offset, 0);
  }

  #[test]
  fn legacy_migration_cli_projection_excludes_document_and_database_payloads() {
    let database_id = DatabaseId::new_v4();
    let document_id = DocId::new_v4();
    let plan = LegacyDatabaseMigrationPlan {
      databases: vec![myoxus_application::database::LegacyDatabasePlan {
        source_id: "sensitive-source-id".to_string(),
        target_id: database_id,
        title: "Sensitive Database title".to_string(),
        fields: Vec::new(),
        views: Vec::new(),
        rows: Vec::new(),
      }],
      block_references: vec![myoxus_application::database::LegacyDatabaseBlockReferencePlan {
        source_document_id: document_id.to_string(),
        block_id: "database-block".to_string(),
        target_database_id: database_id,
        target_view_id: None,
        already_migrated: false,
      }],
      diagnostics: Vec::new(),
      field_count: 4,
      row_count: 3,
      cell_count: 8,
      view_count: 2,
      apply_allowed: true,
    };

    let mut blocked_plan = plan.clone();
    blocked_plan
      .diagnostics
      .push(myoxus_workspace_import::WorkspaceImportDiagnostic::blocking(
        myoxus_workspace_import::WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
        "legacy Database cannot be migrated",
      ));
    blocked_plan.apply_allowed = false;
    let encoded_preview =
      serde_json::to_string(&legacy_migration_plan_output(blocked_plan)).expect("redacted CLI preview projection");
    assert!(encoded_preview.contains(&database_id.to_string()));
    assert!(encoded_preview.contains(&document_id.to_string()));
    assert!(encoded_preview.contains("\"fieldCount\":4"));
    assert!(encoded_preview.contains("MIX_WORKSPACE_IMPORT_DATABASE_INVALID"));

    let encoded_apply = serde_json::to_string(&legacy_migration_apply_output(LegacyDatabaseMigrationApplyResult {
      plan,
      created_database_ids: vec![database_id],
      migrated_block_count: 1,
    }))
    .expect("redacted CLI apply projection");
    assert!(encoded_apply.contains(&format!("\"createdDatabaseIds\":[\"{database_id}\"]")));
    assert!(encoded_apply.contains("\"migratedBlockCount\":1"));

    for encoded in [encoded_preview, encoded_apply] {
      assert!(!encoded.contains("sensitive-source-id"));
      assert!(!encoded.contains("Sensitive Database title"));
      assert!(!encoded.contains("\"fields\""));
      assert!(!encoded.contains("\"rows\""));
      assert!(!encoded.contains("\"cells\""));
    }
  }

  #[test]
  fn pdb32_cli_json_import_cli_mode_round_trips_to_domain_enum() {
    assert!(matches!(
      DatabaseJsonImportCliMode::Create,
      DatabaseJsonImportCliMode::Create
    ));
    assert!(matches!(
      DatabaseJsonImportMode::from(DatabaseJsonImportCliMode::Replace),
      DatabaseJsonImportMode::Replace
    ));
    assert!(matches!(
      DatabaseJsonImportMode::from(DatabaseJsonImportCliMode::Merge),
      DatabaseJsonImportMode::Merge
    ));
  }

  #[test]
  fn pdb32_cli_conflict_strategy_round_trips_to_domain_enum() {
    assert!(matches!(
      DatabaseJsonConflictStrategy::from(DatabaseJsonConflictCliStrategy::Abort),
      DatabaseJsonConflictStrategy::Abort
    ));
    assert!(matches!(
      DatabaseJsonConflictStrategy::from(DatabaseJsonConflictCliStrategy::Rename),
      DatabaseJsonConflictStrategy::Rename
    ));
    assert!(matches!(
      DatabaseJsonConflictStrategy::from(DatabaseJsonConflictCliStrategy::Overwrite),
      DatabaseJsonConflictStrategy::Overwrite
    ));
  }

  #[test]
  fn pdb32_cli_build_import_options_threads_flags_into_domain_struct() {
    let workspace = WorkspaceId::nil();
    let target_db = DatabaseId::new_v4();
    let args = DatabaseImportJsonArgs {
      actor: ActorArgs {
        actor_user_id: UserId::new_v4(),
      },
      workspace_id: workspace,
      mode: DatabaseJsonImportCliMode::Replace,
      target_database_id: Some(target_db),
      target_workspace_id: None,
      conflict_strategy: DatabaseJsonConflictCliStrategy::Rename,
      confirm_destructive: true,
      dry_run: true,
      json_path: PathBuf::from("/tmp/snapshot.database.json"),
    };
    let opts = build_import_options(&args);
    assert!(matches!(opts.mode, DatabaseJsonImportMode::Replace));
    assert!(matches!(opts.conflict_strategy, DatabaseJsonConflictStrategy::Rename));
    assert!(opts.dry_run);
    assert!(opts.confirm_destructive);
    assert_eq!(opts.target_database_id, Some(target_db));
    // Without an explicit target_workspace_id, the actor's workspace
    // is used as the default so the service has somewhere to land the
    // new Database.
    assert_eq!(opts.target_workspace_id, Some(workspace));
  }

  #[test]
  fn pdb32_cli_export_json_args_default_output_is_none_for_stdout() {
    let args = DatabaseExportJsonArgs {
      actor: ActorArgs {
        actor_user_id: UserId::new_v4(),
      },
      database_id: DatabaseId::new_v4(),
      output: None,
    };
    assert!(args.output.is_none());
  }

  #[test]
  fn pdb32_cli_export_notion_args_default_output_dir_is_none_for_stdout() {
    let args = DatabaseExportNotionArgs {
      actor: ActorArgs {
        actor_user_id: UserId::new_v4(),
      },
      database_id: DatabaseId::new_v4(),
      output_dir: None,
    };
    assert!(args.output_dir.is_none());
  }

  #[test]
  fn pdb32_cli_import_notion_args_honor_destructive_and_dry_run_flags() {
    let args = DatabaseImportNotionArgs {
      actor: ActorArgs {
        actor_user_id: UserId::new_v4(),
      },
      workspace_id: WorkspaceId::new_v4(),
      mode: DatabaseJsonImportCliMode::Merge,
      target_database_id: Some(DatabaseId::new_v4()),
      conflict_strategy: DatabaseJsonConflictCliStrategy::Overwrite,
      confirm_destructive: false,
      dry_run: true,
      notion_path: PathBuf::from("/tmp/notes.html"),
    };
    let opts = build_notion_import_options(&args);
    assert!(matches!(opts.mode, DatabaseJsonImportMode::Merge));
    assert!(matches!(
      opts.conflict_strategy,
      DatabaseJsonConflictStrategy::Overwrite
    ));
    assert!(opts.dry_run);
    assert!(!opts.confirm_destructive);
  }
}

#[tracing::instrument(skip_all)]
async fn assistant_list(args: DatabaseAssistantListArgs, svc: &Services, json: bool) -> Result<()> {
  svc
    .databases
    .views
    .assert_workspace_read(args.actor.actor_user_id, args.workspace_id)
    .await
    .map_err(map_database_error)?;
  print_json_or_debug(
    &svc
      .assistant_packages
      .list(myoxus_domain::assistant_package::AssistantPackageContext::ProjectCreation),
    json,
  );
  Ok(())
}
#[tracing::instrument(skip_all)]
async fn assistant_project(args: DatabaseAssistantProjectArgs, svc: &Services, json: bool) -> Result<()> {
  use myoxus_domain::assistant_package::{AssistantPackageIdentity, AssistantValue};
  use std::io::Read;
  let mut bytes = Vec::new();
  std::fs::File::open(&args.answers)?
    .take(myoxus_domain::assistant_package::ASSISTANT_INPUT_MAX_BYTES as u64 + 1)
    .read_to_end(&mut bytes)?;
  anyhow::ensure!(
    bytes.len() <= myoxus_domain::assistant_package::ASSISTANT_INPUT_MAX_BYTES,
    "assistant answers exceed 1 MiB"
  );
  let answers: std::collections::BTreeMap<String, AssistantValue> =
    serde_json::from_slice(&bytes).context("decode bounded typed assistant answers")?;
  let identity = AssistantPackageIdentity {
    id: args.package_id,
    version: args.package_version,
    digest: args.package_digest,
  };
  anyhow::ensure!(
    args.confirm_plan.is_none() || args.locale.is_some(),
    "--confirm-plan requires the prepared --locale"
  );
  let locale = match args.locale {
    Some(locale) => locale,
    None => svc
      .auth
      .get_user_preferences(args.actor.actor_user_id)
      .await?
      .values
      .locale
      .unwrap_or_else(|| svc.default_locale()),
  };
  if let Some(confirmation) = args.confirm_plan {
    let request_id = args.request_id.context("--confirm-plan requires --request-id")?;
    let result = svc
      .workspace
      .create_project_starter(
        args.actor.actor_user_id,
        args.workspace_id,
        myoxus_application::workspace::ProjectStarterInput {
          request_id,
          package: identity,
          answers,
          locale,
          client_version: args.client_version,
          plan_digest: confirmation,
          admission_confirmation: args.admission_confirmation,
        },
        &svc.assistant_packages,
      )
      .await?;
    print_json_or_debug(&assistant_project_outcome(result), json);
  } else {
    let plan = svc
      .assistant_packages
      .prepare_project(
        args.actor.actor_user_id,
        args.workspace_id,
        &identity,
        answers,
        &locale,
        args.client_version,
      )
      .await
      .map_err(map_database_error)?;
    let digest = myoxus_application::workspace::assistant_packages::plan_digest(&plan);
    print_json_or_debug(&serde_json::json!({"plan":plan,"planDigest":digest}), json);
  }
  Ok(())
}

fn assistant_project_outcome(value: myoxus_application::workspace::ProjectStarterOutcome) -> serde_json::Value {
  use myoxus_application::workspace::ProjectStarterStatus;
  let initial_key = &value
    .current_review
    .as_ref()
    .unwrap_or(&value.accepted.plan)
    .initial_view_key;
  let initial = value
    .database
    .as_ref()
    .and_then(|record| record.database.managed_installation.as_ref())
    .and_then(|installation| installation.view_bindings.get(initial_key))
    .copied();
  let status = match value.status {
    ProjectStarterStatus::Ready => "ready",
    ProjectStarterStatus::Pending => "pending",
    ProjectStarterStatus::StopRequested => "stopRequested",
    ProjectStarterStatus::Stopped => "stopped",
    ProjectStarterStatus::ReReviewRequired => "reReviewRequired",
    ProjectStarterStatus::Unavailable => "unavailable",
  };
  let documents = value
    .documents
    .into_iter()
    .map(|document| {
      serde_json::json!({
        "componentId":document.component_id,"reservedDocumentId":document.reserved_document_id,
        "externalId":document.external_id,"created":document.created,"placed":document.placed,
      })
    })
    .collect::<Vec<_>>();
  let accepted = value.accepted;
  // Historical acknowledgement is not current Open authority. Keep reservation
  // facts, but expose document results only through the native authorized views.
  serde_json::json!({
    "accepted":{
      "operation":accepted.operation,"actorId":accepted.actor_id,"workspaceId":accepted.workspace_id,
      "requestId":accepted.request_id,"fingerprint":accepted.fingerprint,"plan":accepted.plan,
      "ids":accepted.ids,"state":accepted.state,"admission":accepted.admission,
    },
    "documents":documents,"placementComplete":accepted.progress.placement_complete,
    "currentReview":value.current_review,"database":value.database,"initialViewId":initial,
    "status":status,"reasonCode":value.reason_code,
  })
}

async fn assistant_project_request(
  args: DatabaseAssistantRequestArgs,
  svc: &Services,
  json: bool,
  stop: bool,
) -> Result<()> {
  let result = if stop {
    Some(
      svc
        .workspace
        .stop_project_starter(
          args.actor.actor_user_id,
          args.workspace_id,
          args.request_id,
          &svc.assistant_packages,
        )
        .await?,
    )
  } else {
    svc
      .workspace
      .get_project_starter(
        args.actor.actor_user_id,
        args.workspace_id,
        args.request_id,
        &svc.assistant_packages,
      )
      .await?
  };
  print_json_or_debug(&result.map(assistant_project_outcome), json);
  Ok(())
}
