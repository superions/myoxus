// SPDX-License-Identifier: AGPL-3.0-or-later
//! `templates` subcommand — list, import, and export template catalog entries.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tabled::Tabled;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::template_registry::{
  ImportTemplateBundleRequest, TemplateDefaultReplacementRequest, TemplateRegistryService,
  bundle::{Manifest, parse_bundle_with_filename, validate_manifest},
  suggestions::{TemplateSuggestionRequest, TemplateSuggestionSurface},
};
use myoxus_domain::ids::{DatabaseId, UserId, WorkspaceId};
use myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore;

use crate::output::{print_json, print_output};
use crate::services::Services;

mod feature_bundle;
mod release_recovery;
pub use feature_bundle::{FeatureBundleCommand, run_feature_bundle};
pub use release_recovery::preview as preview_release_recovery;

// ---------------------------------------------------------------------------
// Subcommand definitions
// ---------------------------------------------------------------------------

/// Subcommands for `templates`.
#[derive(Subcommand)]
pub enum TemplatesCommand {
  /// Validate or deterministically pack native Feature Bundle sources, offline.
  #[command(subcommand)]
  FeatureBundle(FeatureBundleCommand),
  /// Admit a release candidate without services; optional private output captures publication bytes.
  ValidateSourceSet {
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    against_root: Option<PathBuf>,
    /// Independent packaged expectation; defaults to this executable's static assets.
    #[arg(long)]
    release_manifest: Option<PathBuf>,
    #[arg(long)]
    optional_catalog: Option<PathBuf>,
    #[arg(long)]
    prepared_root: Option<PathBuf>,
  },
  /// Validate a complete Database YAML catalog without connecting to services.
  ValidateDatabases {
    /// Database-template directory containing catalog.yaml.
    #[arg(long)]
    root: PathBuf,
    /// Existing Database directory whose current selections must not be downgraded.
    #[arg(long)]
    against_root: Option<PathBuf>,
  },
  /// List all template catalog entries.
  List,
  /// Import a template bundle (ZIP or JSON).
  Import(TemplatesImportArgs),
  /// Export a single template as a JSON bundle.
  Export(TemplatesExportArgs),

  // ── Builtin Bridge (P125-TPL-S-09) ───────────────────────────────────────
  /// Show a single catalog entry (including source, builder_version).
  Show(TemplatesShowArgs),
  /// Bump the builder_version of a builtin template slug.
  BumpBuilderVersion(TemplatesBumpArgs),
  /// Archive a template (disable + set archived_at).
  Archive(TemplatesArchiveArgs),
  /// Enable a template (set status = active).
  Enable(TemplatesEnableArgs),
  /// List / set template default policies.
  DefaultPolicy(TemplatesDefaultPolicyArgs),
  /// List workspace_template_instances for a template.
  ListInstances(TemplatesListInstancesArgs),
  /// Dry-run contextual template suggestions for a workspace surface.
  Suggest(TemplatesSuggestArgs),
  /// Diagnose row-template bindings for one Workspace Database.
  RowTemplates(TemplatesRowTemplatesArgs),
  /// Inspect or repair unambiguous Registry/document attribution gaps.
  RepairAttribution(crate::template_repair::TemplateRepairArgs),
  /// Explicitly replace uncustomized system sources with the admitted Feature release.
  RecoverRelease(release_recovery::RecoveryArgs),
  /// Replace eligible assignments after a shipped default changes.
  ReplaceDefault(TemplatesReplaceDefaultArgs),
}

/// Arguments for `templates import`.
#[derive(Args, Debug)]
pub struct TemplatesImportArgs {
  /// Path to the template bundle file (.zip or .json).
  pub bundle_path: PathBuf,
}

/// Arguments for `templates export`.
#[derive(Args, Debug)]
pub struct TemplatesExportArgs {
  /// Template ID (UUID) to export.
  pub template_id: String,

  /// Output file path. Defaults to `<slug>-<version>.json` in the current directory.
  #[arg(long, short = 'o')]
  pub output: Option<PathBuf>,
}

/// Arguments for `templates show`.
#[derive(Args, Debug)]
pub struct TemplatesShowArgs {
  /// Template ID (UUID) or slug.
  pub id_or_slug: String,
}

/// Arguments for `templates bump-builder-version`.
#[derive(Args, Debug)]
pub struct TemplatesBumpArgs {
  /// Template slug (e.g. business-daily).
  pub slug: String,
}

/// Arguments for `templates archive`.
#[derive(Args, Debug)]
pub struct TemplatesArchiveArgs {
  /// Template ID (UUID) to archive.
  pub template_id: String,
}

/// Arguments for `templates enable`.
#[derive(Args, Debug)]
pub struct TemplatesEnableArgs {
  /// Template ID (UUID) to enable.
  pub template_id: String,
}

/// Arguments for `templates default-policy`.
#[derive(Args, Debug)]
pub struct TemplatesDefaultPolicyArgs {
  /// List all default policies (default action when no sub-arg given).
  #[arg(long)]
  pub list: bool,

  /// Template ID to set a default policy for.
  #[arg(long)]
  pub template_id: Option<String>,

  /// Set apply_to_new_workspaces flag (true/false).
  #[arg(long)]
  pub apply: Option<bool>,
}

/// Arguments for `templates replace-default`.
#[derive(Args, Debug)]
pub struct TemplatesReplaceDefaultArgs {
  /// Catalog slug of the centrally managed source being replaced.
  #[arg(long)]
  pub source_slug: String,
  /// Catalog slug of the published bundle replacement.
  #[arg(long)]
  pub replacement_slug: String,
  /// Continue strictly after this source policy UUID.
  #[arg(long)]
  pub after_policy_id: Option<Uuid>,
  /// Maximum number of source policies to inspect.
  #[arg(long, default_value_t = 100)]
  pub limit: usize,
  /// Apply eligible replacements. Without this flag the command is read-only.
  #[arg(long)]
  pub apply: bool,
}

/// Arguments for `templates list-instances`.
#[derive(Args, Debug)]
pub struct TemplatesListInstancesArgs {
  /// Template ID (UUID) to list workspace instances for.
  pub template_id: String,

  /// Optional workspace ID filter.
  #[arg(long)]
  pub workspace_id: Option<String>,
}

/// Arguments for `templates suggest`.
#[derive(Args, Debug)]
pub struct TemplatesSuggestArgs {
  /// Workspace UUID.
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  /// Actor UUID used for normal workspace/doc/template permission checks.
  #[arg(long)]
  pub actor_user_id: UserId,
  /// Product surface requesting suggestions.
  #[arg(long, value_enum)]
  pub surface: TemplateSuggestSurfaceArg,
  /// Locale used by builtin reconcile lookup.
  #[arg(long, default_value = "en")]
  pub locale: String,
  /// Client version marker passed to the suggestion service.
  #[arg(long, default_value_t = 0)]
  pub client_version: u32,
  /// Optional document type metadata value.
  #[arg(long)]
  pub document_type_id: Option<Uuid>,
  /// Optional status metadata value.
  #[arg(long)]
  pub status_id: Option<Uuid>,
  /// Optional classification metadata value.
  #[arg(long)]
  pub classification_id: Option<Uuid>,
  /// Optional mode string from the creation surface.
  #[arg(long)]
  pub mode: Option<String>,
  /// Optional collection context.
  #[arg(long)]
  pub collection_id: Option<Uuid>,
  /// Optional current document context.
  #[arg(long)]
  pub current_doc_id: Option<Uuid>,
  /// Maximum number of suggestions.
  #[arg(long)]
  pub first: Option<usize>,
}

/// Arguments for `templates row-templates`.
#[derive(Args, Debug)]
pub struct TemplatesRowTemplatesArgs {
  /// Database UUID.
  #[arg(long)]
  pub database_id: DatabaseId,
  /// Actor UUID used for normal Workspace Database ACL checks.
  #[arg(long)]
  pub actor_user_id: UserId,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum TemplateSuggestSurfaceArg {
  SidebarNewPage,
  AllPagesNewPage,
  CollectionNewPage,
  DatabaseRowTemplate,
  StarterBar,
  JournalOnboarding,
  JournalSidebarFooter,
}

impl From<TemplateSuggestSurfaceArg> for TemplateSuggestionSurface {
  fn from(value: TemplateSuggestSurfaceArg) -> Self {
    match value {
      TemplateSuggestSurfaceArg::SidebarNewPage => Self::SidebarNewPage,
      TemplateSuggestSurfaceArg::AllPagesNewPage => Self::AllPagesNewPage,
      TemplateSuggestSurfaceArg::CollectionNewPage => Self::CollectionNewPage,
      TemplateSuggestSurfaceArg::DatabaseRowTemplate => Self::DatabaseRowTemplate,
      TemplateSuggestSurfaceArg::StarterBar => Self::StarterBar,
      TemplateSuggestSurfaceArg::JournalOnboarding => Self::JournalOnboarding,
      TemplateSuggestSurfaceArg::JournalSidebarFooter => Self::JournalSidebarFooter,
    }
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Display row for `templates list`.
#[derive(Tabled, Serialize)]
pub struct TemplateListRow {
  /// Template UUID.
  pub id: String,
  /// Human-readable slug.
  pub slug: String,
  /// Display title.
  pub title: String,
  /// Lifecycle status.
  pub status: String,
  /// Number of revisions.
  pub revision_count: i64,
  /// Latest revision version (or `—` if none).
  pub latest_version: String,
  /// Latest revision state (or `—`).
  pub latest_state: String,
}

#[derive(Tabled, Serialize)]
pub struct TemplateSuggestionRow {
  pub template_id: String,
  pub slug: String,
  pub title: String,
  pub score: i32,
  pub available: bool,
  pub instance_state: String,
  pub reasons: String,
}

#[derive(Tabled, Serialize)]
pub struct RowTemplateBindingRow {
  pub row_template_id: String,
  pub template_id: String,
  pub name: String,
  pub enabled: bool,
  pub is_default: bool,
  pub available: bool,
  pub reconcile_required: bool,
  pub detached: bool,
  pub disabled: bool,
  pub archived: bool,
}

// ---------------------------------------------------------------------------
// JSON bundle format (import / export)
// ---------------------------------------------------------------------------

/// JSON bundle format used for CLI import/export.
///
/// The `ydoc` field carries the raw content bytes encoded as base64.
#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateBundleJson {
  /// Template slug.
  pub slug: String,
  /// Display title.
  pub title: String,
  /// Optional description.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// Optional category.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub category: Option<String>,
  /// Tags.
  #[serde(default)]
  pub tags: Vec<String>,
  /// Semantic version.
  pub version: String,
  /// SHA-256 checksum of the content bytes.
  pub checksum: String,
  /// Raw content bytes encoded as base64.
  pub ydoc: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `templates` subcommand.
pub async fn run(cmd: TemplatesCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  let pool = &svc.pool;
  match cmd {
    TemplatesCommand::FeatureBundle(command) => run_feature_bundle(&command),
    TemplatesCommand::ValidateDatabases { root, against_root } => {
      if let Some(installed) = against_root {
        myoxus_infrastructure::database_templates::validate_database_template_preparation(&root, &installed)?;
      } else {
        myoxus_infrastructure::database_templates::load_database_template_catalog(&root)?;
      }
      Ok(())
    }
    TemplatesCommand::ValidateSourceSet {
      root,
      against_root,
      release_manifest,
      optional_catalog,
      prepared_root,
    } => {
      validate_source_set(
        &root,
        against_root.as_deref(),
        release_manifest.as_deref(),
        optional_catalog.as_deref(),
        prepared_root.as_deref(),
      )?;
      Ok(())
    }
    TemplatesCommand::List => list(pool, json).await,
    TemplatesCommand::Import(args) => import(args, pool).await,
    TemplatesCommand::Export(args) => export(args, pool, json).await,
    TemplatesCommand::Show(args) => show(args, pool, json).await,
    TemplatesCommand::BumpBuilderVersion(args) => bump_builder_version(args, svc, json).await,
    TemplatesCommand::Archive(args) => archive(args, svc).await,
    TemplatesCommand::Enable(args) => enable(args, svc).await,
    TemplatesCommand::DefaultPolicy(args) => default_policy(args, pool, json).await,
    TemplatesCommand::ListInstances(args) => list_instances(args, pool, json).await,
    TemplatesCommand::Suggest(args) => suggest(args, svc, json).await,
    TemplatesCommand::RowTemplates(args) => row_templates(args, svc, json).await,
    TemplatesCommand::RepairAttribution(args) => crate::template_repair::run(args, pool, json).await,
    TemplatesCommand::RecoverRelease(args) => release_recovery::run(args, svc, json).await,
    TemplatesCommand::ReplaceDefault(args) => replace_default(args, svc, json).await,
  }
}

#[derive(Tabled, Serialize)]
struct TemplateDefaultReplacementRow {
  policy_id: String,
  workspace_id: String,
  outcome: String,
  detail: String,
  retired_source_doc_id: String,
  replacement_source_doc_id: String,
}

async fn replace_default(args: TemplatesReplaceDefaultArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let rows = svc
    .template_registry
    .replace_default_assignments(TemplateDefaultReplacementRequest {
      source_slug: &args.source_slug,
      replacement_slug: &args.replacement_slug,
      after_policy_id: args.after_policy_id,
      limit: args.limit,
      apply: args.apply,
    })
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?
    .into_iter()
    .map(|result| TemplateDefaultReplacementRow {
      policy_id: result.policy_id.to_string(),
      workspace_id: result.workspace_id.to_string(),
      outcome: result.outcome,
      detail: result.detail,
      retired_source_doc_id: result.retired_source_doc_id.unwrap_or_default(),
      replacement_source_doc_id: result.replacement_source_doc_id.unwrap_or_default(),
    })
    .collect::<Vec<_>>();
  print_output(&rows, json);
  Ok(())
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

type TemplateListSqlRow = (
  Uuid,
  String,
  String,
  String,
  Option<i64>,
  Option<String>,
  Option<String>,
);

type TemplateExportEntryRow = (
  Uuid,
  String,
  String,
  Option<String>,
  Option<String>,
  Vec<String>,
  String,
);

#[instrument(skip(pool))]
async fn list(pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // Fetch all catalog entries with revision counts and latest revision info.
  let rows: Vec<TemplateListSqlRow> = sqlx::query_as(
    r#"
      SELECT
        t.id,
        t.slug,
        t.title,
        t.status,
        COUNT(r.id)::BIGINT AS revision_count,
        (
          SELECT r2.version
          FROM template_revisions r2
          WHERE r2.template_id = t.id
          ORDER BY r2.created_at DESC
          LIMIT 1
        ) AS latest_version,
        (
          SELECT r3.state
          FROM template_revisions r3
          WHERE r3.template_id = t.id
          ORDER BY r3.created_at DESC
          LIMIT 1
        ) AS latest_state
      FROM template_catalog_entries t
      LEFT JOIN template_revisions r ON r.template_id = t.id
      GROUP BY t.id, t.slug, t.title, t.status
      ORDER BY t.created_at DESC
    "#,
  )
  .fetch_all(pool)
  .await
  .context("failed to query template catalog")?;

  let display: Vec<TemplateListRow> = rows
    .into_iter()
    .map(
      |(id, slug, title, status, revision_count, latest_version, latest_state)| TemplateListRow {
        id: id.to_string(),
        slug,
        title,
        status,
        revision_count: revision_count.unwrap_or(0),
        latest_version: latest_version.unwrap_or_else(|| "—".to_string()),
        latest_state: latest_state.unwrap_or_else(|| "—".to_string()),
      },
    )
    .collect();

  if display.is_empty() {
    println!("No templates found.");
    return Ok(());
  }

  print_output(&display, json);
  Ok(())
}

async fn suggest(args: TemplatesSuggestArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let result = svc
    .template_suggestions
    .suggest(TemplateSuggestionRequest {
      workspace_id: args.workspace_id,
      user_id: Some(args.actor_user_id),
      surface: args.surface.into(),
      locale: args.locale,
      client_version: args.client_version,
      document_type_id: args.document_type_id,
      status_id: args.status_id,
      classification_id: args.classification_id,
      mode: args.mode,
      collection_id: args.collection_id,
      current_doc_id: args.current_doc_id,
      first: args.first,
      after: None,
      library: None,
    })
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;

  let rows = result
    .items
    .into_iter()
    .map(|item| TemplateSuggestionRow {
      template_id: item.template_id.to_string(),
      slug: item.slug,
      title: item.title,
      score: item.score,
      available: item.available,
      instance_state: item.instance_state.unwrap_or_default(),
      reasons: item
        .reasons
        .into_iter()
        .map(|reason| format!("{reason:?}"))
        .collect::<Vec<_>>()
        .join(","),
    })
    .collect::<Vec<_>>();
  print_output(&rows, json);
  Ok(())
}

async fn row_templates(args: TemplatesRowTemplatesArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let bindings = svc
    .databases
    .editing
    .list_row_template_bindings(args.actor_user_id, args.database_id, &svc.template_registry)
    .await
    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
  let rows = bindings
    .into_iter()
    .map(|binding| RowTemplateBindingRow {
      row_template_id: binding.row_template.id.to_string(),
      template_id: binding.row_template.template_id.to_string(),
      name: binding.row_template.name,
      enabled: binding.row_template.enabled,
      is_default: binding.row_template.is_default,
      available: binding.template_available,
      reconcile_required: binding.reconcile_required,
      detached: binding.detached,
      disabled: binding.disabled,
      archived: binding.archived,
    })
    .collect::<Vec<_>>();
  print_output(&rows, json);
  Ok(())
}

#[instrument(skip(pool))]
async fn import(args: TemplatesImportArgs, pool: &PgPool) -> anyhow::Result<()> {
  let bundle_path = &args.bundle_path;

  if !bundle_path.exists() {
    bail!("bundle file not found: {}", bundle_path.display());
  }

  let filename = bundle_path.file_name().and_then(|n| n.to_str()).unwrap_or("import");

  info!(path = %bundle_path.display(), "templates.import.start");

  let raw_bytes =
    std::fs::read(bundle_path).with_context(|| format!("could not read bundle file: {}", bundle_path.display()))?;

  // Determine if this is a JSON bundle or a ZIP bundle.
  let (manifest_data, _content_bytes, checksum) = if filename.ends_with(".json") {
    // JSON bundle format.
    let bundle: TemplateBundleJson =
      serde_json::from_slice(&raw_bytes).context("could not parse JSON bundle — invalid format")?;

    let content = B64.decode(&bundle.ydoc).context("ydoc field is not valid base64")?;
    let checksum = bundle.checksum.clone();

    let manifest = Manifest {
      template_id: bundle.slug.clone(),
      version: bundle.version.clone(),
      title: bundle.title.clone(),
      description: bundle.description.clone(),
      category: bundle.category.clone(),
      tags: bundle.tags.clone(),
      locale: None,
      kind: None,
      min_server_version: None,
      checksum: Some(checksum.clone()),
      localized_contents: std::collections::BTreeMap::new(),
      title_policy: None,
      purpose: None,
    };

    (manifest, content, checksum)
  } else {
    // ZIP bundle format.
    let parsed = parse_bundle_with_filename(&raw_bytes, filename)
      .map_err(|e| anyhow::anyhow!("could not parse ZIP bundle: {e}"))?;

    let errors = validate_manifest(&parsed.manifest);
    let fatal: Vec<_> = errors
      .iter()
      .filter(|e| e.severity == myoxus_application::template_registry::bundle::ValidationSeverity::Error)
      .collect();

    if !fatal.is_empty() {
      for err in &fatal {
        eprintln!("Validation error [{}]: {}", err.code, err.message);
      }
      bail!("bundle failed validation with {} fatal error(s)", fatal.len());
    }

    for warn_item in errors
      .iter()
      .filter(|e| e.severity == myoxus_application::template_registry::bundle::ValidationSeverity::Warning)
    {
      warn!(code = %warn_item.code, message = %warn_item.message, "bundle validation warning");
      eprintln!("Warning [{}]: {}", warn_item.code, warn_item.message);
    }

    let checksum = parsed.content_checksum.clone();
    (parsed.manifest, parsed.content_bytes, checksum)
  };

  // Build service and call import_template_bundle.
  let store = Arc::new(SqlxTemplateRegistryStore::new(pool.clone()));
  let service = TemplateRegistryService::new(store);

  let (_entry, revision) = service
    .import_template_bundle(ImportTemplateBundleRequest {
      slug: &manifest_data.template_id,
      title: &manifest_data.title,
      description: manifest_data.description.as_deref(),
      category: manifest_data.category.as_deref(),
      tags: manifest_data.tags.clone(),
      version: &manifest_data.version,
      bundle_blob_id: &checksum, // use checksum as bundle_blob_id (no blob storage in CLI)
      preview_blob_id: None,
      checksum: &checksum,
      manifest: serde_json::to_value(&manifest_data).unwrap_or_default(),
      created_by: None,
    })
    .await
    .map_err(|e| anyhow::anyhow!("import failed: {e}"))?;

  println!("Template imported successfully.");
  println!("  Slug     : {}", manifest_data.template_id);
  println!("  Title    : {}", manifest_data.title);
  println!("  Version  : {}", manifest_data.version);
  println!("  Revision : {}", revision.id);
  println!("  State    : {}", revision.state);
  println!();
  println!("Note: revision is in Draft state. Use the admin UI to validate and publish.");

  info!(
      slug = %manifest_data.template_id,
      version = %manifest_data.version,
      revision_id = %revision.id,
      "templates.import.done"
  );

  Ok(())
}

#[instrument(skip(pool))]
async fn export(args: TemplatesExportArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let template_id: Uuid = args
    .template_id
    .parse()
    .with_context(|| format!("invalid template UUID: {}", args.template_id))?;

  info!(template_id = %template_id, "templates.export.start");

  // Load catalog entry.
  let entry_row: Option<TemplateExportEntryRow> = sqlx::query_as(
    r#"
        SELECT id, slug, title, description, category, tags, status
        FROM template_catalog_entries
        WHERE id = $1
      "#,
  )
  .bind(template_id)
  .fetch_optional(pool)
  .await
  .context("could not query template catalog")?;

  let (id, slug, title, description, category, tags, status) =
    entry_row.ok_or_else(|| anyhow::anyhow!("template not found: {}", template_id))?;

  // Load the latest published revision (fall back to latest draft if none published).
  let revision_row: Option<(Uuid, String, String, Option<String>)> = sqlx::query_as(
    r#"
      SELECT id, version, state, checksum
      FROM template_revisions
      WHERE template_id = $1
      ORDER BY
        CASE state
          WHEN 'published' THEN 0
          WHEN 'validated' THEN 1
          WHEN 'draft' THEN 2
          ELSE 3
        END ASC,
        created_at DESC
      LIMIT 1
    "#,
  )
  .bind(template_id)
  .fetch_optional(pool)
  .await
  .context("could not query revisions")?;

  let (rev_id, version, state, checksum) =
    revision_row.ok_or_else(|| anyhow::anyhow!("template {} has no revisions", template_id))?;

  // The bundle content is not stored in the DB (it lives in blob storage).
  // For the CLI export we produce a JSON bundle with metadata only.
  // If content bytes were stored, they would be base64-encoded here.
  // We set ydoc to an empty base64 string and note the limitation.
  warn!(
      template_id = %id,
      revision_id = %rev_id,
      "CLI export does not include ydoc content (no blob storage access) — metadata-only export"
  );

  let bundle = TemplateBundleJson {
    slug: slug.clone(),
    title: title.clone(),
    description: description.clone(),
    category: category.clone(),
    tags: tags.clone(),
    version: version.clone(),
    checksum: checksum.clone().unwrap_or_default(),
    ydoc: B64.encode(b""), // placeholder — content not available via CLI without blob storage
  };

  let bundle_json = serde_json::to_string_pretty(&bundle).context("could not serialize export bundle")?;

  // Determine output path.
  let output_path = args
    .output
    .unwrap_or_else(|| PathBuf::from(format!("{}-{}.json", slug, version)));

  std::fs::write(&output_path, &bundle_json)
    .with_context(|| format!("could not write to: {}", output_path.display()))?;

  if json {
    print_json(&bundle);
  } else {
    println!("Template exported.");
    println!("  ID       : {id}");
    println!("  Slug     : {slug}");
    println!("  Title    : {title}");
    println!("  Version  : {version}");
    println!("  State    : {state}");
    println!("  Status   : {status}");
    println!("  Output   : {}", output_path.display());
    println!();
    println!("Note: ydoc content is not included (no blob storage access in CLI context).");
  }

  info!(
      template_id = %id,
      revision_id = %rev_id,
      output = %output_path.display(),
      "templates.export.done"
  );

  Ok(())
}

// ── Builtin Bridge Commands (P125-TPL-S-09) ───────────────────────────────────

#[instrument(skip(pool))]
async fn show(args: TemplatesShowArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  use myoxus_application::template_registry::TemplateRegistryStore as _;
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let entry = if let Ok(id) = Uuid::parse_str(&args.id_or_slug) {
    store.get_catalog_entry(id).await.context("DB error")?
  } else {
    store
      .get_catalog_entry_by_slug(&args.id_or_slug)
      .await
      .context("DB error")?
  };
  let entry = entry.with_context(|| format!("template not found: {}", args.id_or_slug))?;

  if json {
    print_json(&serde_json::json!({
      "id": entry.id,
      "slug": entry.slug,
      "title": entry.title,
      "source": entry.source.as_str(),
      "builderVersion": entry.builder_version,
      "minClientVersion": entry.min_client_version,
      "status": format!("{:?}", entry.status),
      "category": entry.category,
      "tags": entry.tags,
    }));
  } else {
    println!("Template: {}", entry.title);
    println!("  ID              : {}", entry.id);
    println!("  Slug            : {}", entry.slug);
    println!("  Source          : {}", entry.source.as_str());
    println!(
      "  Builder version : {}",
      entry
        .builder_version
        .map(|v| v.to_string())
        .unwrap_or_else(|| "—".to_string())
    );
    println!("  Min client ver  : {}", entry.min_client_version);
    println!("  Status          : {:?}", entry.status);
    println!("  Category        : {}", entry.category.as_deref().unwrap_or("—"));
    println!("  Tags            : {}", entry.tags.join(", "));
  }
  Ok(())
}

#[instrument(skip(svc))]
async fn bump_builder_version(args: TemplatesBumpArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let (new_version, _) = svc
    .template_registry
    .bump_builder_version(&args.slug)
    .await
    .context("bump_builder_version failed")?;

  if json {
    print_json(&serde_json::json!({ "slug": args.slug, "newBuilderVersion": new_version }));
  } else {
    println!("Builder version bumped.");
    println!("  Slug    : {}", args.slug);
    println!("  Version : {new_version}");
  }
  Ok(())
}

#[instrument(skip(svc))]
async fn archive(args: TemplatesArchiveArgs, svc: &Services) -> anyhow::Result<()> {
  let id = Uuid::parse_str(&args.template_id).context("invalid template_id UUID")?;
  let entry = svc
    .template_registry
    .transition_catalog(
      id,
      myoxus_domain::template_registry::TemplateStatus::Archived,
      false,
      myoxus_domain::audit::AuditActor::system(),
      &svc.audit,
      "cli",
    )
    .await
    .map_err(|error| map_catalog_transition_error(error, id))?;
  println!("Template archived: {} ({})", entry.slug, id);
  Ok(())
}

#[instrument(skip(svc))]
async fn enable(args: TemplatesEnableArgs, svc: &Services) -> anyhow::Result<()> {
  let id = Uuid::parse_str(&args.template_id).context("invalid template_id UUID")?;
  let entry = svc
    .template_registry
    .transition_catalog(
      id,
      myoxus_domain::template_registry::TemplateStatus::Active,
      true,
      myoxus_domain::audit::AuditActor::system(),
      &svc.audit,
      "cli",
    )
    .await
    .map_err(|error| map_catalog_transition_error(error, id))?;
  println!("Template enabled: {} ({})", entry.slug, id);
  Ok(())
}

fn map_catalog_transition_error(error: myoxus_application::auth::AuthError, id: Uuid) -> anyhow::Error {
  use myoxus_application::auth::AuthError;
  match error {
    AuthError::NotFound(_) => anyhow::anyhow!("template not found: {id}"),
    AuthError::InvalidInput(message) => anyhow::anyhow!(message),
    error => anyhow::Error::new(error).context("update failed"),
  }
}

#[instrument(skip(pool))]
async fn default_policy(args: TemplatesDefaultPolicyArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  use myoxus_application::template_registry::TemplateRegistryStore as _;
  let store = SqlxTemplateRegistryStore::new(pool.clone());

  if let (Some(tid_str), Some(apply)) = (&args.template_id, args.apply) {
    let template_id = Uuid::parse_str(tid_str).context("invalid template_id")?;
    store
      .set_default_policy_apply_flag(template_id, apply)
      .await
      .context("set_default_policy_apply_flag failed")?;
    println!("Default policy apply_to_new_workspaces = {apply} set for {template_id}");
    return Ok(());
  }

  // Default: list
  let policies = store
    .list_default_policies()
    .await
    .context("list_default_policies failed")?;
  if json {
    print_json(
      &policies
        .iter()
        .map(|p| {
          serde_json::json!({
            "templateId": p.template_id,
            "applyToNewWorkspaces": p.apply_to_new_workspaces,
            "selectionMode": format!("{:?}", p.selection_mode),
            "provisioningMode": format!("{:?}", p.provisioning_mode),
          })
        })
        .collect::<Vec<_>>(),
    );
  } else {
    println!("{} default policies", policies.len());
    for p in &policies {
      println!(
        "  {} — apply={} sel={:?} prov={:?}",
        p.template_id, p.apply_to_new_workspaces, p.selection_mode, p.provisioning_mode
      );
    }
  }
  Ok(())
}

#[instrument(skip(pool))]
async fn list_instances(args: TemplatesListInstancesArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let template_id = Uuid::parse_str(&args.template_id).context("invalid template_id UUID")?;

  let mut q = sqlx::QueryBuilder::new(
    "SELECT workspace_id, state, expected_hash, locale_hash, last_synced_at
     FROM workspace_template_instances WHERE template_id = ",
  );
  q.push_bind(template_id);
  if let Some(wid_str) = &args.workspace_id {
    let wid = Uuid::parse_str(wid_str).context("invalid workspace_id UUID")?;
    q.push(" AND workspace_id = ");
    q.push_bind(wid);
  }
  q.push(" ORDER BY last_synced_at DESC NULLS LAST LIMIT 100");

  let rows = q.build().fetch_all(pool).await.context("query failed")?;

  if json {
    let out: Vec<serde_json::Value> = rows
      .iter()
      .map(|r| {
        use sqlx::Row;
        serde_json::json!({
          "workspaceId": r.get::<Uuid, _>("workspace_id").to_string(),
          "state": r.get::<String, _>("state"),
          "expectedHash": r.get::<Option<String>, _>("expected_hash"),
          "localeHash": r.get::<Option<String>, _>("locale_hash"),
        })
      })
      .collect();
    print_json(&out);
  } else {
    println!("{} instances for template {template_id}", rows.len());
    for r in &rows {
      use sqlx::Row;
      println!(
        "  {} — {} (locale={})",
        r.get::<Uuid, _>("workspace_id"),
        r.get::<String, _>("state"),
        r.get::<Option<String>, _>("locale_hash").as_deref().unwrap_or("—"),
      );
    }
  }
  Ok(())
}

/// Read-only unless a fresh private prepared root is supplied. Publication uses
/// these captured bytes and never reopens authoring paths after admission.
pub fn validate_source_set(
  root: &std::path::Path,
  against: Option<&std::path::Path>,
  release_manifest: Option<&std::path::Path>,
  optional_catalog: Option<&std::path::Path>,
  prepared_root: Option<&std::path::Path>,
) -> myoxus_domain::repositories::RepoResult<()> {
  let packaged_manifest;
  let release_manifest = if let Some(path) = release_manifest {
    path
  } else {
    packaged_manifest = myoxus_infrastructure::feature_bundles::packaged_feature_release_manifest()?;
    &packaged_manifest
  };
  let prepared = myoxus_infrastructure::feature_bundles::prepare_feature_source_set(
    root,
    against,
    release_manifest,
    optional_catalog,
  )?;
  if let Some(output) = prepared_root {
    myoxus_infrastructure::feature_bundles::write_prepared_feature_source_set(&prepared, output)?;
  }
  Ok(())
}
