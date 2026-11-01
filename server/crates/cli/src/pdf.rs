//! `pdf` subcommand — PDF-Export V2 administrative operations.
//!
//! Mirrors the GraphQL admin surface (`P-PDF-TPL-07`/`P-PDF-TPL-08`/
//! `P-PDF-TPL-09`/`P-PDF-TPL-FONT-01`/`P-PDF-TPL-AUDIT-01`) for ops + scripted
//! environments where running a browser-driven admin UI is impractical
//! (CI, on-call, fleet automation).
//!
//! ## Implemented subcommands
//!
//! | Subcommand                                         | Delivery package                |
//! |----------------------------------------------------|---------------------------------|
//! | `pdf audit purge --before <iso8601>`               | `P-PDF-TPL-AUDIT-01-04`         |
//! | `pdf templates list [--include-deleted]`           | `P-PDF-TPL-24-01`               |
//! | `pdf templates upload --slug … --files <dir>`      | `P-PDF-TPL-24-02`               |
//! | `pdf templates delete --id <uuid>`                 | `P-PDF-TPL-24-03`               |
//! | `pdf templates assign …`                           | `P-PDF-TPL-24-04`               |
//! | `pdf templates unassign …`                         | `P-PDF-TPL-24-05`               |
//! | `pdf templates migrate-engine --from … --to …`     | `P-DEPS-20260802-01`             |
//! | `pdf brand show --workspace <uuid>`                | `P-PDF-TPL-25-01`               |
//! | `pdf brand set-logo …`                             | `P-PDF-TPL-25-02`               |
//! | `pdf brand set-text …`                             | `P-PDF-TPL-25-03`               |
//! | `pdf brand set-defaults …`                         | `P-PDF-TPL-25-04`               |
//! | `pdf fonts list [--status …]`                      | `P-PDF-TPL-26-01`               |
//! | `pdf fonts upload --file …`                        | `P-PDF-TPL-26-02`               |
//! | `pdf fonts approve --id <uuid>`                    | `P-PDF-TPL-26-03`               |
//! | `pdf fonts reject --id <uuid> --reason <s>`        | `P-PDF-TPL-26-04`               |
//!
//! ## Storage root
//!
//! Most mutating subcommands that write blobs (template upload, brand set-logo,
//! font upload) use a [`StorageAdapter`] backed by a local filesystem path.
//! The path defaults to `./storage` so the CLI mirrors the production
//! `storage.root` setting from `server/config/default.yaml`. Override
//! per-invocation with `--storage-root <path>` when the server uses a
//! different mount point — the CLI must write to **the same path the API
//! server reads from**, otherwise the uploaded blob is invisible to the
//! renderer and the row points at a key that never resolves.
//! Engine migration is the exception: it resolves the production FS/S3/R2
//! adapter from static server configuration and never uses this helper path.

use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use clap::{Args, Subcommand};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tabled::Tabled;
use tracing::{info, warn};
use uuid::Uuid;

use myoxus_application::pdf_export::font_validator::validate_font_bytes;
use myoxus_application::pdf_export::svg_sanitizer::sanitize_svg;
use myoxus_domain::entities::{
  PdfDocumentBrandLogoSlot, PdfFont, PdfFontLicense, PdfFontLicenseStatus, PdfTemplate, PdfTemplateFile,
};
use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use myoxus_domain::repositories::{
  PdfDocumentBrandLogoAsset, PdfExportRenderAuditRepository, PdfFontRepository, PdfTemplateRepository,
  PdfWorkspaceBrandAssetRepository, PdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfExportRenderAuditRepository, PgPdfFontRepository, PgPdfTemplateRepository,
  PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

use crate::output::{print_json, print_output};
use crate::services::Services;

/// Default filesystem path used to construct the blob-store operator when no
/// `--storage-root` flag is given. Matches `storage.root` in the bundled
/// `server/config/default.yaml`. Must agree with the API server's storage
/// configuration; otherwise blobs the CLI writes are invisible to the renderer.
const DEFAULT_STORAGE_ROOT: &str = "./storage";

/// Top-level subcommands grouped under `pdf`.
#[derive(Subcommand)]
pub enum PdfCommand {
  /// Render-audit management.
  #[command(subcommand)]
  Audit(AuditCommand),
  /// Template inventory + lifecycle (upload, delete, assignment).
  #[command(subcommand)]
  Templates(TemplatesCommand),
  /// Workspace document-branding and PDF export settings inspection + mutation.
  #[command(subcommand)]
  Brand(BrandCommand),
  /// Font library inventory + lifecycle (upload, approve, reject).
  #[command(subcommand)]
  Fonts(FontsCommand),
}

/// Subcommands for `pdf audit`.
#[derive(Subcommand)]
pub enum AuditCommand {
  /// Permanently delete render-audit rows older than the given date.
  ///
  /// `--before` is interpreted as an exclusive upper bound. Without
  /// `--confirm` the command prints the row count that **would** be
  /// deleted but performs no writes — matching the existing
  /// destructive-CLI confirmation pattern (`workspaces delete`,
  /// `users delete`).
  ///
  /// Compliance note: render-audit rows are immutable by design; this
  /// command exists only to satisfy storage-retention policies. Operators
  /// who run it should already have the legal sign-off on file.
  Purge(AuditPurgeArgs),
}

#[derive(Args)]
pub struct AuditPurgeArgs {
  /// Exclusive upper bound on `created_at`. Accepts `YYYY-MM-DD` (which
  /// is interpreted as `00:00 UTC` on that day) or any RFC-3339
  /// timestamp (`2026-04-01T00:00:00Z`).
  #[arg(long)]
  pub before: String,
  /// Without this flag the command runs in dry-run mode — prints the
  /// row count that would be deleted but does not modify the table.
  #[arg(long, default_value_t = false)]
  pub confirm: bool,
}

// ─── pdf templates ──────────────────────────────────────────────────────────

#[derive(Subcommand)]
pub enum TemplatesCommand {
  /// List every registered PDF-Export template (excluding soft-deleted
  /// rows by default).
  List(TemplatesListArgs),
  /// Upload a new template bundle (manifest + bundle files) to the registry.
  Upload(TemplatesUploadArgs),
  /// Soft-delete a template. Refuses while active workspace assignments exist.
  Delete(TemplatesDeleteArgs),
  /// Grant a workspace access to a template.
  Assign(TemplatesAssignArgs),
  /// Revoke a workspace's access to a template.
  Unassign(TemplatesUnassignArgs),
  /// Validate or atomically migrate stored templates to a new Typst line.
  MigrateEngine(TemplatesMigrateEngineArgs),
}

#[derive(Args)]
pub struct TemplatesMigrateEngineArgs {
  /// Existing Typst major/minor line, for example `0.14`.
  #[arg(long)]
  pub from: String,
  /// Target Typst major/minor line embedded by this server, for example `0.15`.
  #[arg(long)]
  pub to: String,
  /// Publish the migration. Without this flag the command is read-only.
  #[arg(long, default_value_t = false)]
  pub confirm: bool,
}

#[derive(Args)]
pub struct TemplatesListArgs {
  /// Include soft-deleted templates (`deleted_at IS NOT NULL`) in the
  /// output. Useful for forensic / audit work.
  #[arg(long, default_value_t = false)]
  pub include_deleted: bool,
}

#[derive(Args)]
pub struct TemplatesUploadArgs {
  /// Stable kebab-case slug. Must be unique among active templates.
  #[arg(long)]
  pub slug: String,
  /// Human-readable display name.
  #[arg(long)]
  pub name: String,
  /// Semver-style version string (free-form, used for display only).
  #[arg(long)]
  pub version: String,
  /// Path to the `manifest.json` file describing the template's
  /// capabilities + asset list. Validated against
  /// [`PdfTemplateManifest`] before any DB writes.
  #[arg(long)]
  pub manifest: PathBuf,
  /// Path to the directory holding the bundle files. Each file in the
  /// manifest's `assets` array must exist as `{files_dir}/{relative_path}`.
  #[arg(long = "files")]
  pub files_dir: PathBuf,
  /// UUID of the admin user recorded as `created_by`. Defaults to the
  /// first admin in the database when omitted so operators do not have to
  /// memorise the admin id.
  #[arg(long)]
  pub created_by: Option<String>,
  /// Override the storage root used by the blob writer. Must match the
  /// API server's `storage.root` so the renderer can locate the blobs.
  #[arg(long, default_value = DEFAULT_STORAGE_ROOT)]
  pub storage_root: String,
}

#[derive(Args)]
pub struct TemplatesDeleteArgs {
  /// Template UUID to soft-delete.
  #[arg(long)]
  pub id: Uuid,
}

#[derive(Args)]
pub struct TemplatesAssignArgs {
  /// Workspace UUID that will gain access to the template.
  #[arg(long)]
  pub workspace: Uuid,
  /// Template UUID to assign.
  #[arg(long)]
  pub template: Uuid,
  /// Mark this template as the workspace's default template after assignment.
  /// The previous default (if any) is cleared atomically inside `set_default`.
  #[arg(long, default_value_t = false)]
  pub default: bool,
  /// UUID of the admin user recorded as `assigned_by`. Defaults to the
  /// first admin in the database when omitted.
  #[arg(long)]
  pub by: Option<String>,
}

#[derive(Args)]
pub struct TemplatesUnassignArgs {
  /// Workspace UUID to revoke access from.
  #[arg(long)]
  pub workspace: Uuid,
  /// Template UUID to remove from the workspace.
  #[arg(long)]
  pub template: Uuid,
}

#[derive(Tabled, Serialize)]
struct TemplatesRow {
  pub slug: String,
  pub version: String,
  pub schema_version: String,
  pub name: String,
  pub created_at: String,
  pub deleted: String,
}

async fn templates_list(args: TemplatesListArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let repo: Arc<dyn PdfTemplateRepository> = Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  let rows = repo.list(args.include_deleted).await?;
  let view: Vec<TemplatesRow> = rows
    .iter()
    .map(|t| TemplatesRow {
      slug: t.slug.clone(),
      version: t.version.clone(),
      schema_version: t.schema_version.clone(),
      name: t.name.clone(),
      created_at: t.created_at.to_rfc3339(),
      deleted: t.deleted_at.map(|d| d.to_rfc3339()).unwrap_or_else(|| "-".into()),
    })
    .collect();
  print_output(&view, json);
  Ok(())
}

#[derive(Serialize)]
struct UploadSummary {
  template_id: Uuid,
  slug: String,
  files_uploaded: usize,
  blob_keys: Vec<String>,
}

/// Upload a new template bundle.
///
/// Steps:
/// 1. Read + parse `manifest.json` against [`PdfTemplateManifest`] (full
///    schema validation runs in `serde::Deserialize`).
/// 2. For every entry in the manifest's `assets` array, read the file from
///    `files_dir` (refuses if the file is missing — atomic-or-nothing).
/// 3. `created_by` defaults to the first admin user when omitted.
/// 4. Create the `pdf_templates` row + all `pdf_template_files` rows in a
///    single transaction (`PdfTemplateRepository::create` is transactional).
/// 5. Upload every bundle file to the blob store.
///
/// The Typst compile-validator is intentionally **not** run here — operators
/// already have direct DB access; failing-fast on a malformed bundle is the
/// admin UI's responsibility, not the operator-tool's.
async fn templates_upload(args: TemplatesUploadArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let manifest_bytes =
    std::fs::read(&args.manifest).map_err(|e| anyhow::anyhow!("read manifest {}: {e}", args.manifest.display()))?;
  let manifest_value: serde_json::Value = serde_json::from_slice(&manifest_bytes)
    .map_err(|e| anyhow::anyhow!("manifest {} is not valid JSON: {e}", args.manifest.display()))?;
  // Round-trip through the strongly-typed manifest so the CLI rejects the
  // upload with the same diagnostics the GraphQL surface uses.
  let parsed: PdfTemplateManifest = serde_json::from_value(manifest_value.clone())
    .map_err(|e| anyhow::anyhow!("manifest fails schema validation: {e}"))?;

  let creator = match &args.created_by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --created-by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };

  // Read every declared asset before we touch the DB. This keeps the
  // upload atomic — a missing file fails the command before any row exists.
  let mut staged: Vec<(String, Vec<u8>, String)> = Vec::with_capacity(parsed.assets.len());
  for asset_path in &parsed.assets {
    let on_disk = args.files_dir.join(asset_path);
    let bytes = std::fs::read(&on_disk).map_err(|e| {
      anyhow::anyhow!(
        "declared asset {} missing on disk ({}): {e}",
        asset_path,
        on_disk.display()
      )
    })?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha = format!("{:x}", hasher.finalize());
    staged.push((asset_path.clone(), bytes, sha));
  }

  let template_id = Uuid::new_v4();

  // Atomicity: write blobs FIRST, then the DB rows. This mirrors the
  // GraphQL `uploadPdfTemplate` flow and gives the GC a coherent state
  // to reason about — orphan blobs are cheap to detect and prune
  // (content-addressed by template_id), while orphan DB rows pointing
  // at missing blobs would silently break renders. If the DB insert
  // fails after we wrote blobs, we delete them on the way out.
  //
  // The reverse ordering (DB first, blobs second) was the original
  // implementation; it produced inconsistent state when a blob upload
  // failed mid-loop — DB rows kept pointing at non-existent storage
  // keys until an operator manually removed the row.
  let blob_store = pdf_blob_store(&args.storage_root)?;
  let mut written_blobs: Vec<String> = Vec::with_capacity(staged.len());
  let mut file_records: Vec<PdfTemplateFile> = Vec::with_capacity(staged.len());
  for (path, bytes, sha) in &staged {
    let (blob_key, blob_sha) = match blob_store.put_template_file(template_id, path, bytes).await {
      Ok(v) => v,
      Err(e) => {
        // Best-effort cleanup of any blobs we already wrote so the
        // bucket is not littered with half-uploads.
        for key in &written_blobs {
          let _ = blob_store.delete(key).await;
        }
        anyhow::bail!("blob upload for `{}` failed: {e}", path);
      }
    };
    if &blob_sha != sha {
      // The blob store reported a different sha than we computed
      // ourselves — refuse the upload because the on-disk and
      // on-store contents will not match what the renderer hashes.
      for key in &written_blobs {
        let _ = blob_store.delete(key).await;
      }
      let _ = blob_store.delete(&blob_key).await;
      anyhow::bail!(
        "blob store reported sha256 `{}` for `{}` but we computed `{}`",
        blob_sha,
        path,
        sha
      );
    }
    written_blobs.push(blob_key.clone());
    file_records.push(PdfTemplateFile {
      template_id,
      file_path: path.clone(),
      blob_key,
      content_hash: sha.clone(),
    });
  }

  let template = PdfTemplate {
    id: template_id,
    slug: args.slug.clone(),
    name: args.name.clone(),
    version: args.version.clone(),
    schema_version: parsed.schema_version.clone(),
    manifest: manifest_value,
    created_by: Some(creator),
    created_at: Utc::now(),
    deleted_at: None,
  };

  let repo: Arc<dyn PdfTemplateRepository> = Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  if let Err(e) = repo.create(&template, &file_records, None).await {
    // The DB insert lost a race (slug conflict, FK violation, …) — undo
    // the blobs so the bucket reflects the DB.
    for key in &written_blobs {
      let _ = blob_store.delete(key).await;
    }
    anyhow::bail!("pdf_templates insert failed: {e}");
  }
  let blob_keys = written_blobs;

  info!(
    template_id = %template_id,
    slug = %args.slug,
    files = blob_keys.len(),
    "pdf template uploaded via CLI"
  );

  let summary = UploadSummary {
    template_id,
    slug: args.slug,
    files_uploaded: blob_keys.len(),
    blob_keys,
  };
  if json {
    print_json(&summary);
  } else {
    println!(
      "Uploaded template {} (slug={}, {} files) ✓",
      summary.template_id, summary.slug, summary.files_uploaded,
    );
    for k in &summary.blob_keys {
      println!("  blob: {k}");
    }
  }
  Ok(())
}

#[derive(Serialize)]
struct TemplatesDeleteSummary {
  id: Uuid,
  deleted: bool,
  refused_active_assignments: Option<usize>,
}

async fn templates_delete(args: TemplatesDeleteArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let repo: Arc<dyn PdfTemplateRepository> = Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  let assignments: Arc<dyn PdfWorkspaceTemplateAssignmentRepository> =
    Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone()));

  let Some(existing) = repo.get_by_id(args.id).await? else {
    let summary = TemplatesDeleteSummary {
      id: args.id,
      deleted: false,
      refused_active_assignments: None,
    };
    if json {
      print_json(&summary);
    } else {
      println!("Template {} not found — no-op.", args.id);
    }
    return Ok(());
  };
  if existing.deleted_at.is_some() {
    let summary = TemplatesDeleteSummary {
      id: args.id,
      deleted: false,
      refused_active_assignments: None,
    };
    if json {
      print_json(&summary);
    } else {
      println!("Template {} is already soft-deleted — no-op.", args.id);
    }
    return Ok(());
  }

  let active = assignments.list_for_template(args.id).await?;
  if !active.is_empty() {
    let count = active.len();
    let summary = TemplatesDeleteSummary {
      id: args.id,
      deleted: false,
      refused_active_assignments: Some(count),
    };
    if json {
      print_json(&summary);
    } else {
      println!(
        "Refused: template {} still has {} active workspace assignment(s). \
        Run `pdf templates unassign --workspace <ws> --template {}` for each first.",
        args.id, count, args.id,
      );
    }
    return Ok(());
  }

  repo.soft_delete(args.id, None).await?;
  info!(template_id = %args.id, slug = %existing.slug, "pdf template soft-deleted via CLI");

  let summary = TemplatesDeleteSummary {
    id: args.id,
    deleted: true,
    refused_active_assignments: None,
  };
  if json {
    print_json(&summary);
  } else {
    println!("Soft-deleted template {} (slug={}) ✓", args.id, existing.slug);
  }
  Ok(())
}

#[derive(Serialize)]
struct AssignSummary {
  workspace: Uuid,
  template: Uuid,
  assigned: bool,
  set_as_default: bool,
}

async fn templates_assign(args: TemplatesAssignArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let assignments: Arc<dyn PdfWorkspaceTemplateAssignmentRepository> =
    Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone()));
  let by = match &args.by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };

  assignments.assign(args.workspace, args.template, by, None).await?;
  let mut set_default = false;
  if args.default {
    assignments.set_default(args.workspace, args.template, by, None).await?;
    set_default = true;
  }

  info!(
    workspace_id = %args.workspace,
    template_id = %args.template,
    set_default,
    "pdf template assigned via CLI"
  );

  let summary = AssignSummary {
    workspace: args.workspace,
    template: args.template,
    assigned: true,
    set_as_default: set_default,
  };
  if json {
    print_json(&summary);
  } else {
    println!(
      "Assigned template {} to workspace {}{} ✓",
      args.template,
      args.workspace,
      if set_default { " (default)" } else { "" }
    );
  }
  Ok(())
}

#[derive(Serialize)]
struct UnassignSummary {
  workspace: Uuid,
  template: Uuid,
  unassigned: bool,
}

async fn templates_unassign(args: TemplatesUnassignArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let assignments: Arc<dyn PdfWorkspaceTemplateAssignmentRepository> =
    Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone()));
  assignments.unassign(args.workspace, args.template, None).await?;
  info!(
    workspace_id = %args.workspace,
    template_id = %args.template,
    "pdf template unassigned via CLI"
  );
  let summary = UnassignSummary {
    workspace: args.workspace,
    template: args.template,
    unassigned: true,
  };
  if json {
    print_json(&summary);
  } else {
    println!(
      "Unassigned template {} from workspace {} ✓",
      args.template, args.workspace,
    );
  }
  Ok(())
}

// ─── pdf brand ──────────────────────────────────────────────────────────────

#[derive(Subcommand)]
pub enum BrandCommand {
  /// Show document-branding and PDF export settings for a workspace. Prints a default-filled
  /// stub when the workspace has not yet been configured (matches the
  /// GraphQL `documentBrandingProfile`/`pdfExportSettings` semantics).
  Show(BrandShowArgs),
  /// Upload a document-branding logo (PNG passed through, SVG sanitized via `usvg`).
  SetLogo(BrandSetLogoArgs),
  /// Update workspace document-branding footer text.
  SetText(BrandSetTextArgs),
  /// Update the workspace-level PDF export settings tuple
  /// (paper-size, locale, color-profile, image-quality, ligatures).
  SetDefaults(BrandSetDefaultsArgs),
}

#[derive(Args)]
pub struct BrandShowArgs {
  /// Workspace UUID.
  #[arg(long)]
  pub workspace: Uuid,
}

#[derive(Args)]
pub struct BrandSetLogoArgs {
  /// Workspace UUID.
  #[arg(long)]
  pub workspace: Uuid,
  /// Which slot to populate: `large` (cover-page hero) or `small` (header).
  #[arg(long)]
  pub kind: String,
  /// Path to the logo file. Extensions `.png`, `.svg` are recognised; any
  /// other content type is refused.
  #[arg(long)]
  pub file: PathBuf,
  /// UUID of the admin recorded as `updated_by`. Defaults to first admin.
  #[arg(long)]
  pub by: Option<String>,
  /// Storage root (must match `storage.root` in the API server config).
  #[arg(long, default_value = DEFAULT_STORAGE_ROOT)]
  pub storage_root: String,
}

#[derive(Args)]
pub struct BrandSetTextArgs {
  #[arg(long)]
  pub workspace: Uuid,
  /// Free-form footer line. Pass an empty string to clear.
  #[arg(long)]
  pub footer_text: Option<String>,
  #[arg(long)]
  pub by: Option<String>,
}

#[derive(Args)]
pub struct BrandSetDefaultsArgs {
  #[arg(long)]
  pub workspace: Uuid,
  /// Default paper size (`A4`, `Letter`, `A3`, `A5`).
  #[arg(long)]
  pub paper_size: Option<String>,
  /// Default BCP-47 locale (e.g. `en`, `de`).
  #[arg(long)]
  pub locale: Option<String>,
  /// Color profile name (`sRGB`, `CMYK_FOGRA39`, `CMYK_SWOP`).
  #[arg(long)]
  pub color_profile: Option<String>,
  /// Image quality tier (`low`, `med`, `high`, `lossless`).
  #[arg(long)]
  pub image_quality: Option<String>,
  /// Whether to enable OpenType ligatures.
  #[arg(long)]
  pub ligatures: Option<bool>,
  #[arg(long)]
  pub by: Option<String>,
}

async fn brand_show(args: BrandShowArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let repo: Arc<dyn PdfWorkspaceBrandAssetRepository> = Arc::new(PgPdfWorkspaceBrandAssetRepository::new(pool.clone()));
  let row = repo.get(args.workspace).await?;
  match row {
    Some(brand) => {
      let body = serde_json::to_value(&brand)?;
      if json {
        print_json(&body);
      } else {
        println!("{}", serde_json::to_string_pretty(&body)?);
      }
    }
    None => {
      let stub = serde_json::json!({
        "workspaceId": args.workspace.to_string(),
        "configured": false,
        "message": "no document-branding or PDF export settings row exists yet — the GraphQL surface returns default-filled stubs",
      });
      if json {
        print_json(&stub);
      } else {
        println!("{}", serde_json::to_string_pretty(&stub)?);
      }
    }
  }
  Ok(())
}

async fn brand_set_logo(args: BrandSetLogoArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let kind = match args.kind.to_ascii_lowercase().as_str() {
    "large" => "large",
    "small" => "small",
    other => anyhow::bail!("invalid --kind {other:?}; expected 'large' or 'small'"),
  };
  let raw = std::fs::read(&args.file).map_err(|e| anyhow::anyhow!("read {}: {e}", args.file.display()))?;
  if raw.is_empty() {
    anyhow::bail!("logo file `{}` is empty", args.file.display());
  }

  // Magic-byte sniff is the source of truth for the format — the file
  // extension is hint-only. This mirrors the GraphQL `uploadDocumentBrandLogo`
  // implementation in `pdf_workspace.rs::detect_logo_kind` and catches
  // disguised payloads (an SVG renamed to `.png` would have bypassed
  // the previous extension-only check and been pass-through-uploaded
  // without sanitization). We still cross-check extension vs. content
  // and refuse the upload on mismatch — operators usually don't rename
  // files; a mismatch is more likely a misconfigured pipeline than an
  // intentional rename.
  let format = sniff_logo_format(&raw)?;
  let extension_hint = args
    .file
    .extension()
    .and_then(|s| s.to_str())
    .map(str::to_ascii_lowercase)
    .unwrap_or_default();
  let extension_implied = match extension_hint.as_str() {
    "" => None, // operator may pipe stdin → tmpfile with no extension; tolerate
    "png" => Some(LogoFormat::Png),
    "svg" => Some(LogoFormat::Svg),
    other => {
      anyhow::bail!("unsupported logo extension `.{other}`; only .png and .svg are accepted");
    }
  };
  if let Some(implied) = extension_implied
    && implied != format
  {
    anyhow::bail!(
      "extension `.{}` does not match the file content (magic bytes indicate {}); \
       refusing upload to prevent unsanitised SVG content from masquerading as PNG",
      extension_hint,
      format.as_str(),
    );
  }

  // SVG → sanitize via usvg AST round-trip; PNG → pass through.
  let (bytes, ext) = match format {
    LogoFormat::Svg => {
      let cleaned = sanitize_svg(&raw).map_err(|e| anyhow::anyhow!("svg sanitize failed: {e}"))?;
      (cleaned.bytes, "svg")
    }
    LogoFormat::Png => (raw, "png"),
  };

  // Resolve `by` BEFORE any blob upload so a missing-admin error fails
  // the command without littering the bucket with an orphan upload.
  let by = match &args.by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };

  let blob_store = pdf_blob_store(&args.storage_root)?;
  let asset_kind = format!("{kind}.{ext}");
  let (blob_key, blob_sha) = blob_store
    .put_brand_asset(args.workspace, &asset_kind, &bytes)
    .await
    .map_err(|e| anyhow::anyhow!("blob upload failed: {e}"))?;

  // From this point on we must roll back the blob if any later step
  // fails — orphan blobs are GC-friendly but orphan DB rows pointing at
  // them are silent breakage (LRN-20260430-PDF-CLI-BLOB-ORDER).
  let repo: Arc<dyn PdfWorkspaceBrandAssetRepository> = Arc::new(PgPdfWorkspaceBrandAssetRepository::new(pool.clone()));
  let logo_slot = match kind {
    "large" => PdfDocumentBrandLogoSlot::Large,
    "small" => PdfDocumentBrandLogoSlot::Small,
    _ => unreachable!("kind validated above"),
  };
  if let Err(e) = repo
    .set_document_logo_blob(
      args.workspace,
      logo_slot,
      Some(PdfDocumentBrandLogoAsset {
        blob_key: blob_key.clone(),
        sha256: blob_sha.clone(),
        mime: match format {
          LogoFormat::Png => "image/png",
          LogoFormat::Svg => "image/svg+xml",
        }
        .to_string(),
        byte_size: bytes.len() as i64,
      }),
      by,
      Utc::now(),
      None,
    )
    .await
  {
    // Roll back the blob we just uploaded so the bucket reflects the DB.
    let _ = blob_store.delete(&blob_key).await;
    anyhow::bail!("document-logo update failed: {e}");
  }

  // Keep committed prior keys readable for captured exports. Only a failed
  // operation's new, immutable key can be removed as compensation.
  info!(
    workspace_id = %args.workspace,
    kind,
    blob_key = %blob_key,
    "document brand logo uploaded via CLI"
  );

  let summary = serde_json::json!({
    "workspaceId": args.workspace.to_string(),
    "kind": kind,
    "blobKey": blob_key,
    "size": bytes.len(),
  });
  if json {
    print_json(&summary);
  } else {
    println!(
      "Uploaded {} logo for workspace {} → {} ({} bytes) ✓",
      kind,
      args.workspace,
      blob_key,
      bytes.len()
    );
  }
  Ok(())
}

async fn brand_set_text(args: BrandSetTextArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let by = match &args.by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };
  // Empty string -> null (clear); None -> leave unchanged. Organisation
  // identity is global and is not modified through this workspace command.
  let footer_text = match args.footer_text {
    Some(footer) if footer.is_empty() => None,
    Some(footer) => Some(footer),
    None => anyhow::bail!("brand set-text requires --footer-text; pass an empty string to clear it"),
  };
  let repo: Arc<dyn PdfWorkspaceBrandAssetRepository> = Arc::new(PgPdfWorkspaceBrandAssetRepository::new(pool.clone()));
  repo
    .set_document_branding_text(args.workspace, footer_text.clone(), by, Utc::now(), None)
    .await?;

  info!(
    workspace_id = %args.workspace,
    "document branding text updated via CLI"
  );

  let body = serde_json::to_value(repo.get(args.workspace).await?)?;
  if json {
    print_json(&body);
  } else {
    println!("Updated document branding text for workspace {} ✓", args.workspace);
    println!("{}", serde_json::to_string_pretty(&body)?);
  }
  Ok(())
}

async fn brand_set_defaults(args: BrandSetDefaultsArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // Pre-validate enum-style strings so a typo produces a fast error
  // before the upsert. The GraphQL surface enforces the same set; keep
  // the lists in lockstep.
  if let Some(p) = &args.paper_size {
    let valid = ["A4", "Letter", "A3", "A5"];
    if !valid.contains(&p.as_str()) {
      anyhow::bail!("invalid --paper-size {p:?}; expected one of {valid:?}");
    }
  }
  if let Some(c) = &args.color_profile {
    let valid = ["sRGB", "CMYK_FOGRA39", "CMYK_SWOP"];
    if !valid.contains(&c.as_str()) {
      anyhow::bail!("invalid --color-profile {c:?}; expected one of {valid:?}");
    }
  }
  if let Some(q) = &args.image_quality {
    let valid = ["low", "med", "high", "lossless"];
    if !valid.contains(&q.as_str()) {
      anyhow::bail!("invalid --image-quality {q:?}; expected one of {valid:?}");
    }
  }

  let by = match &args.by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };
  let repo: Arc<dyn PdfWorkspaceBrandAssetRepository> = Arc::new(PgPdfWorkspaceBrandAssetRepository::new(pool.clone()));
  let patch = myoxus_domain::repositories::PdfExportSettingsPatch {
    workspace_id: args.workspace,
    default_paper_size: args.paper_size.map(Some),
    default_locale: args.locale.map(Some),
    default_color_profile: args.color_profile.map(Some),
    default_image_quality: args.image_quality.map(Some),
    ligatures_enabled: args.ligatures,
    updated_at: Utc::now(),
    updated_by: by,
    ..Default::default()
  };
  repo.upsert_pdf_export_settings(&patch, None).await?;

  info!(
    workspace_id = %args.workspace,
    "pdf export settings updated via CLI"
  );

  let body = serde_json::to_value(repo.get(args.workspace).await?)?;
  if json {
    print_json(&body);
  } else {
    println!("Updated PDF export settings for workspace {} ✓", args.workspace);
    println!("{}", serde_json::to_string_pretty(&body)?);
  }
  Ok(())
}

// ─── pdf fonts ──────────────────────────────────────────────────────────────

#[derive(Subcommand)]
pub enum FontsCommand {
  /// List uploaded fonts. Filter by license-status to triage the
  /// approval queue.
  List(FontsListArgs),
  /// Upload a font binary (TTF/OTF/WOFF/WOFF2). Validates magic bytes,
  /// extracts the family/style/weight/license metadata, and dedups by
  /// SHA-256.
  Upload(FontsUploadArgs),
  /// Mark a font as approved for use in PDF exports.
  Approve(FontsApproveArgs),
  /// Mark a font as rejected (must not be used for rendering).
  Reject(FontsRejectArgs),
}

#[derive(Args)]
pub struct FontsListArgs {
  /// Optional status filter (`pending`, `approved`, `rejected`).
  /// Without this flag every row is returned regardless of status.
  #[arg(long)]
  pub status: Option<String>,
}

#[derive(Args)]
pub struct FontsUploadArgs {
  /// Path to the font binary on disk.
  #[arg(long)]
  pub file: PathBuf,
  /// SPDX-style license override. Used when the font's `name` table does
  /// not carry a recognisable license string (`OFL-1.1`, `Apache-2.0`,
  /// `MIT`, `GPL`, `Proprietary`, or any free-form string).
  #[arg(long)]
  pub license: Option<String>,
  /// Admin UUID recorded as `uploaded_by`. Defaults to first admin.
  #[arg(long)]
  pub by: Option<String>,
  /// Storage root (must match `storage.root` in the API server config).
  #[arg(long, default_value = DEFAULT_STORAGE_ROOT)]
  pub storage_root: String,
}

#[derive(Args)]
pub struct FontsApproveArgs {
  /// Font UUID to approve.
  #[arg(long)]
  pub id: Uuid,
  /// SPDX-style license override (rare: only when the recorded license
  /// needs to change at approval time). Applied as a separate UPDATE
  /// before the status transition so the audit trail captures both.
  #[arg(long)]
  pub license: Option<String>,
  /// Admin UUID recorded as `approved_by`. Defaults to first admin.
  #[arg(long)]
  pub by: Option<String>,
}

#[derive(Args)]
pub struct FontsRejectArgs {
  /// Font UUID to reject.
  #[arg(long)]
  pub id: Uuid,
  /// Free-form reason text logged to tracing for forensic context.
  /// Not persisted in `pdf_fonts`; the row's `license_status` flips to
  /// `rejected` and the rationale lives in the structured log only.
  #[arg(long)]
  pub reason: String,
  /// Admin UUID recorded as `approved_by` (the column is reused for
  /// the reviewer of the rejection). Defaults to first admin.
  #[arg(long)]
  pub by: Option<String>,
}

#[derive(Tabled, Serialize)]
struct FontsRow {
  pub family_name: String,
  pub style: String,
  pub weight: i32,
  pub license: String,
  pub license_status: String,
  pub uploaded_at: String,
  pub sha256_short: String,
}

async fn fonts_list(args: FontsListArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let repo: Arc<dyn PdfFontRepository> = Arc::new(PgPdfFontRepository::new(pool.clone()));
  let status = match args.status.as_deref() {
    Some("pending") => Some(PdfFontLicenseStatus::Pending),
    Some("approved") => Some(PdfFontLicenseStatus::Approved),
    Some("rejected") => Some(PdfFontLicenseStatus::Rejected),
    Some(other) => anyhow::bail!("invalid --status {other:?}; expected pending|approved|rejected"),
    None => None,
  };
  let rows = repo.list(status).await?;
  let view: Vec<FontsRow> = rows
    .iter()
    .map(|f| FontsRow {
      family_name: f.family_name.clone(),
      style: f.style.clone(),
      weight: f.weight,
      // PdfFontLicense / PdfFontLicenseStatus serialise as their canonical
      // strings via serde — easier than chasing explicit Display impls
      // and keeps the CLI output in lockstep with the GraphQL surface.
      license: serde_json::to_value(&f.license)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{:?}", f.license)),
      license_status: serde_json::to_value(&f.license_status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{:?}", f.license_status)),
      uploaded_at: f.uploaded_at.to_rfc3339(),
      sha256_short: f.sha256.chars().take(12).collect(),
    })
    .collect();
  print_output(&view, json);
  Ok(())
}

async fn fonts_upload(args: FontsUploadArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let raw = std::fs::read(&args.file).map_err(|e| anyhow::anyhow!("read {}: {e}", args.file.display()))?;
  if raw.is_empty() {
    anyhow::bail!("font binary is empty");
  }
  let metadata = validate_font_bytes(&raw).map_err(|e| anyhow::anyhow!("font binary failed validation: {e}"))?;

  let resolved_license = match (args.license.as_deref(), metadata.detected_license.clone()) {
    (Some(""), _) => anyhow::bail!("--license must not be empty"),
    (Some(explicit), _) => license_from_string(explicit.trim()),
    (None, Some(detected)) => detected,
    (None, None) => anyhow::bail!(
      "could not auto-detect a license — pass `--license` explicitly with an SPDX-style identifier (e.g. OFL-1.1, Apache-2.0, MIT, GPL, Proprietary)"
    ),
  };

  let mut hasher = Sha256::new();
  hasher.update(&raw);
  let sha256 = format!("{:x}", hasher.finalize());

  let repo: Arc<dyn PdfFontRepository> = Arc::new(PgPdfFontRepository::new(pool.clone()));
  if let Some(existing) = repo.get_by_sha256(&sha256).await? {
    anyhow::bail!(
      "conflict: font with this content (sha256={}) already exists as id={}",
      existing.sha256,
      existing.id
    );
  }

  let by = match &args.by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };

  let blob_store = pdf_blob_store(&args.storage_root)?;
  let blob_key = blob_store
    .put_font(&sha256, metadata.container.extension(), &raw)
    .await
    .map_err(|e| anyhow::anyhow!("blob upload failed: {e}"))?;

  let row = PdfFont {
    id: Uuid::new_v4(),
    family_name: metadata.family_name.clone(),
    style: metadata.style.clone(),
    weight: i32::from(metadata.weight),
    blob_key: blob_key.clone(),
    sha256: sha256.clone(),
    license: resolved_license.clone(),
    license_status: PdfFontLicenseStatus::Pending,
    uploaded_by: Some(by),
    uploaded_at: Utc::now(),
    approved_by: None,
    approved_at: None,
  };

  if let Err(e) = repo.create(&row, None).await {
    // Clean up the blob if the DB insert lost a race against a parallel
    // upload; this operation owns the immutable staging key.
    let _ = blob_store.delete(&blob_key).await;
    anyhow::bail!("font create failed: {e}");
  }

  info!(
    font_id = %row.id,
    family_name = %row.family_name,
    style = %row.style,
    weight = row.weight,
    sha256 = %row.sha256,
    blob_key = %blob_key,
    "font uploaded via CLI"
  );

  let summary = serde_json::json!({
    "id": row.id.to_string(),
    "familyName": row.family_name,
    "style": row.style,
    "weight": row.weight,
    "license": serde_json::to_value(&row.license)?,
    "licenseStatus": serde_json::to_value(&row.license_status)?,
    "blobKey": blob_key,
    "sha256": row.sha256,
    "size": raw.len(),
  });
  if json {
    print_json(&summary);
  } else {
    println!(
      "Uploaded font {} ({} {} {}, {} bytes, sha256={}) ✓",
      row.id,
      row.family_name,
      row.style,
      row.weight,
      raw.len(),
      row.sha256,
    );
  }
  Ok(())
}

async fn fonts_approve(args: FontsApproveArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let by = match &args.by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };
  let repo: Arc<dyn PdfFontRepository> = Arc::new(PgPdfFontRepository::new(pool.clone()));
  let Some(_existing) = repo.get(args.id).await? else {
    anyhow::bail!("font {} not found", args.id);
  };

  // License and approval change together under the repository row lock.
  let license_override = args.license.as_deref().map(|value| license_from_string(value.trim()));
  let after = repo
    .set_status(
      args.id,
      PdfFontLicenseStatus::Approved,
      Some(by),
      license_override,
      None,
    )
    .await?;
  info!(font_id = %args.id, by = %by, "pdf font approved via CLI");

  let body = serde_json::json!({
    "id": after.id.to_string(),
    "familyName": after.family_name,
    "style": after.style,
    "license": serde_json::to_value(&after.license)?,
    "licenseStatus": serde_json::to_value(&after.license_status)?,
    "approvedBy": after.approved_by.map(|u| u.to_string()),
    "approvedAt": after.approved_at.map(|t| t.to_rfc3339()),
  });
  if json {
    print_json(&body);
  } else {
    println!("Approved font {} ({} {}) ✓", after.id, after.family_name, after.style);
  }
  Ok(())
}

async fn fonts_reject(args: FontsRejectArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let by = match &args.by {
    Some(s) => Uuid::parse_str(s).map_err(|e| anyhow::anyhow!("invalid --by uuid: {e}"))?,
    None => first_admin(pool).await?,
  };
  let repo: Arc<dyn PdfFontRepository> = Arc::new(PgPdfFontRepository::new(pool.clone()));
  let Some(_existing) = repo.get(args.id).await? else {
    anyhow::bail!("font {} not found", args.id);
  };
  repo
    .set_status(args.id, PdfFontLicenseStatus::Rejected, Some(by), None, None)
    .await?;
  // The trusted CLI keeps its existing no-audit policy. Raw operator text
  // is not retained in tracing; GraphQL rejection owns the structured audit reason.
  warn!(
    font_id = %args.id,
    by = %by,
    reason_len = args.reason.chars().count(),
    "pdf font rejected via CLI"
  );
  let after = repo.get(args.id).await?.expect("just-rejected font must exist");
  let body = serde_json::json!({
    "id": after.id.to_string(),
    "familyName": after.family_name,
    "style": after.style,
    "licenseStatus": serde_json::to_value(&after.license_status)?,
    "approvedBy": after.approved_by.map(|u| u.to_string()),
    "approvedAt": after.approved_at.map(|t| t.to_rfc3339()),
    "reason": args.reason,
  });
  if json {
    print_json(&body);
  } else {
    println!(
      "Rejected font {} ({} {}) — reason: {} ✓",
      after.id, after.family_name, after.style, args.reason,
    );
  }
  Ok(())
}

/// Dispatch the `pdf` subcommand.
pub async fn run(cmd: PdfCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  let pool = &services.pool;
  match cmd {
    PdfCommand::Audit(AuditCommand::Purge(args)) => audit_purge(args, pool, json).await,
    PdfCommand::Templates(TemplatesCommand::List(args)) => templates_list(args, pool, json).await,
    PdfCommand::Templates(TemplatesCommand::Upload(args)) => templates_upload(args, pool, json).await,
    PdfCommand::Templates(TemplatesCommand::Delete(args)) => templates_delete(args, pool, json).await,
    PdfCommand::Templates(TemplatesCommand::Assign(args)) => templates_assign(args, pool, json).await,
    PdfCommand::Templates(TemplatesCommand::Unassign(args)) => templates_unassign(args, pool, json).await,
    PdfCommand::Templates(TemplatesCommand::MigrateEngine(args)) => {
      templates_migrate_engine(args, services, json).await
    }
    PdfCommand::Brand(BrandCommand::Show(args)) => brand_show(args, pool, json).await,
    PdfCommand::Brand(BrandCommand::SetLogo(args)) => brand_set_logo(args, pool, json).await,
    PdfCommand::Brand(BrandCommand::SetText(args)) => brand_set_text(args, pool, json).await,
    PdfCommand::Brand(BrandCommand::SetDefaults(args)) => brand_set_defaults(args, pool, json).await,
    PdfCommand::Fonts(FontsCommand::List(args)) => fonts_list(args, pool, json).await,
    PdfCommand::Fonts(FontsCommand::Upload(args)) => fonts_upload(args, pool, json).await,
    PdfCommand::Fonts(FontsCommand::Approve(args)) => fonts_approve(args, pool, json).await,
    PdfCommand::Fonts(FontsCommand::Reject(args)) => fonts_reject(args, pool, json).await,
  }
}

async fn templates_migrate_engine(
  args: TemplatesMigrateEngineArgs,
  services: &Services,
  json: bool,
) -> anyhow::Result<()> {
  run_template_engine_migration(args, &services.pool, services.blob_storage()?, json).await
}

/// Run the recovery-safe engine migration with the configured production blob
/// adapter and without materializing unrelated live `app_configs` overrides.
pub async fn run_template_engine_migration(
  args: TemplatesMigrateEngineArgs,
  pool: &PgPool,
  blobs: Arc<dyn myoxus_application::ports::BlobStoragePort>,
  json: bool,
) -> anyhow::Result<()> {
  let migration = myoxus_infrastructure::pdf_export::TemplateEngineMigrationService::new(pool.clone(), blobs);
  let report = if args.confirm {
    migration.confirm(&args.from, &args.to).await?
  } else {
    migration.preflight(&args.from, &args.to).await?
  };

  if json {
    print_json(&report);
    return Ok(());
  }
  let mode = if report.dry_run { "DRY-RUN" } else { "CONFIRMED" };
  println!(
    "{mode}: Typst {} -> {} checked {} administrator template(s); {} require migration, {} already current",
    report.from,
    report.to,
    report.templates.len(),
    report.migrated,
    report.already_current
  );
  for item in &report.templates {
    println!(
      "- {} ({}) {:?}: {} -> {}; manifest {} -> {}; {} file(s) verified; compile passed: {}",
      item.slug,
      item.template_id,
      item.action,
      item.previous_engine,
      item.target_engine,
      item.previous_manifest_hash,
      item.target_manifest_hash,
      item.file_hashes.len(),
      item.compiled
    );
  }
  if report.dry_run && report.migrated > 0 {
    println!("Re-run with --confirm during the documented maintenance window to publish atomically.");
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// pdf audit purge
// ---------------------------------------------------------------------------

async fn audit_purge(args: AuditPurgeArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let before = parse_before(&args.before)?;

  // Always count first so the operator gets a deterministic preview before
  // any destructive op — and so dry-run reports the same number that would
  // have been deleted.
  let preview: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_export_render_audit WHERE created_at < $1")
    .bind(before)
    .fetch_one(pool)
    .await?;
  let preview_u64: u64 = preview.try_into().unwrap_or(0);

  if !args.confirm {
    let summary = PurgeSummary {
      before,
      dry_run: true,
      rows_affected: preview_u64,
    };
    if json {
      print_json(&summary);
    } else {
      println!(
        "DRY-RUN: would delete {} render-audit row(s) created before {} (re-run with --confirm to apply)",
        preview_u64,
        before.to_rfc3339()
      );
    }
    return Ok(());
  }

  // Real run. Use the production repository so any future schema /
  // observability changes (`#[instrument]`, metrics, etc.) flow through.
  let repo: Arc<dyn PdfExportRenderAuditRepository> = Arc::new(PgPdfExportRenderAuditRepository::new(pool.clone()));
  let rows_affected = repo.purge_before(before).await?;
  info!(
    before = %before.to_rfc3339(),
    rows_affected,
    "pdf render audit purge complete"
  );

  let summary = PurgeSummary {
    before,
    dry_run: false,
    rows_affected,
  };
  if json {
    print_json(&summary);
  } else {
    println!(
      "Deleted {} render-audit row(s) created before {}",
      rows_affected,
      before.to_rfc3339()
    );
  }
  Ok(())
}

#[derive(serde::Serialize)]
struct PurgeSummary {
  before: DateTime<Utc>,
  dry_run: bool,
  rows_affected: u64,
}

/// Parse the `--before` argument. Accepts:
///   • `YYYY-MM-DD`  — interpreted as midnight UTC on that day
///   • RFC-3339      — passed straight through to `DateTime::parse_from_rfc3339`
fn parse_before(raw: &str) -> anyhow::Result<DateTime<Utc>> {
  if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
    return Ok(dt.with_timezone(&Utc));
  }
  if let Ok(date) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
    let naive = date
      .and_hms_opt(0, 0, 0)
      .expect("00:00:00 must always be a valid time-of-day");
    return Ok(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc));
  }
  anyhow::bail!(
    "could not parse --before {raw:?} (expected YYYY-MM-DD or RFC-3339 timestamp like 2026-04-01T00:00:00Z)"
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Construct a [`PdfBlobStore`] backed by a local-FS opendal operator
/// rooted at `storage_root`. Operators are expected to point this at the
/// same directory the API server uses (`storage.root` in the YAML config).
fn pdf_blob_store(storage_root: &str) -> anyhow::Result<Arc<PdfBlobStore>> {
  let adapter = StorageAdapter::new_fs(storage_root)
    .map_err(|e| anyhow::anyhow!("storage adapter for `{}` failed: {e}", storage_root))?;
  Ok(Arc::new(PdfBlobStore::new(adapter.operator())))
}

/// Look up the first admin user. Used by mutating commands that need an
/// `actor_user_id` / `created_by` value but were invoked without an
/// explicit `--by` / `--created-by` flag.
async fn first_admin(pool: &PgPool) -> anyhow::Result<Uuid> {
  let row: Option<(Uuid,)> =
    sqlx::query_as("SELECT id FROM users WHERE is_admin = true ORDER BY created_at ASC LIMIT 1")
      .fetch_optional(pool)
      .await?;
  row
    .map(|(id,)| id)
    .ok_or_else(|| anyhow::anyhow!("no admin user found in users table — pass --by / --created-by explicitly"))
}

/// PNG magic bytes (8 bytes). Stable spec from RFC 2083 §3.1.
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Recognised brand-logo container formats.
///
/// Mirrors the GraphQL surface's `LogoFormat` (`pdf_workspace.rs`) so
/// the CLI and the API agree on which formats land in the blob store
/// — admin UI and operator-tool must produce byte-identical artifacts
/// for the same logical input.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
enum LogoFormat {
  Png,
  Svg,
}

impl LogoFormat {
  fn as_str(self) -> &'static str {
    match self {
      Self::Png => "png",
      Self::Svg => "svg",
    }
  }
}

/// Identify a brand-logo upload's format from its raw bytes alone.
///
/// PNG is detected via the 8-byte magic signature. Anything else is
/// assumed to be SVG and handed to the usvg sanitizer — usvg refuses
/// non-SVG payloads at parse time, so a corrupted or non-image stream
/// still surfaces as a hard error rather than silently writing
/// garbage to the blob store.
///
/// We deliberately do not inspect the file extension here: extensions
/// are user-controlled metadata and a renamed file (`.png` →
/// `evil.svg`) would otherwise bypass the sniff. The CLI cross-checks
/// the extension hint against this result later for early operator
/// feedback, but the magic-byte sniff is always authoritative.
fn sniff_logo_format(bytes: &[u8]) -> anyhow::Result<LogoFormat> {
  if bytes.len() >= PNG_SIGNATURE.len() && bytes[..PNG_SIGNATURE.len()] == PNG_SIGNATURE {
    return Ok(LogoFormat::Png);
  }
  // Heuristic SVG check: skip leading whitespace + UTF-8 BOM + any XML
  // declaration / DOCTYPE / comment, then expect to see `<svg` at the
  // top of the document. usvg would also reject anything that isn't
  // SVG, but emitting a clear error here lets operators distinguish
  // "wrong format" from "broken SVG".
  let mut prefix: &[u8] = bytes;
  if prefix.starts_with(&[0xEF, 0xBB, 0xBF]) {
    prefix = &prefix[3..];
  }
  while let Some(first) = prefix.first().copied() {
    if first == b' ' || first == b'\t' || first == b'\r' || first == b'\n' {
      prefix = &prefix[1..];
      continue;
    }
    break;
  }
  // Accept `<?xml` (declaration) — usvg handles it; or `<!--` (comment);
  // or the `<svg` opener directly. Reject anything else loudly.
  if prefix.starts_with(b"<?xml") || prefix.starts_with(b"<!--") || prefix.starts_with(b"<!DOCTYPE") {
    return Ok(LogoFormat::Svg);
  }
  if prefix.len() >= 4 && prefix[..4].eq_ignore_ascii_case(b"<svg") {
    return Ok(LogoFormat::Svg);
  }
  anyhow::bail!(
    "logo format unrecognised — expected PNG (magic `\\x89PNG`) or SVG (\
     leading `<?xml`/`<!DOCTYPE`/`<svg`), got bytes `{:02x?}…`",
    &bytes[..bytes.len().min(8)]
  )
}

/// Map an SPDX-style license string to a [`PdfFontLicense`].
///
/// Recognises the canonical short names (`OFL-1.1`, `Apache-2.0`, `MIT`,
/// `GPL`, `Proprietary`); any other value is preserved as
/// [`PdfFontLicense::Other`] so operators can record bespoke commercial
/// licenses verbatim.
fn license_from_string(s: &str) -> PdfFontLicense {
  match s {
    "OFL-1.1" => PdfFontLicense::Ofl11,
    "Apache-2.0" => PdfFontLicense::Apache20,
    "MIT" => PdfFontLicense::Mit,
    "GPL" => PdfFontLicense::Gpl,
    "Proprietary" => PdfFontLicense::Proprietary,
    other => PdfFontLicense::Other(other.to_owned()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// `--before` parsing accepts both shorthand and full RFC-3339.
  #[test]
  fn parse_before_accepts_yyyy_mm_dd() {
    let dt = parse_before("2026-04-30").expect("ok");
    assert_eq!(dt.to_rfc3339(), "2026-04-30T00:00:00+00:00");
  }

  #[test]
  fn parse_before_accepts_rfc3339() {
    let dt = parse_before("2026-04-30T13:45:00Z").expect("ok");
    assert_eq!(dt.to_rfc3339(), "2026-04-30T13:45:00+00:00");
  }

  #[test]
  fn parse_before_rejects_garbage() {
    assert!(parse_before("not a date").is_err());
    assert!(parse_before("").is_err());
  }

  #[test]
  fn license_from_string_recognises_canonical_names() {
    assert!(matches!(license_from_string("OFL-1.1"), PdfFontLicense::Ofl11));
    assert!(matches!(license_from_string("Apache-2.0"), PdfFontLicense::Apache20));
    assert!(matches!(license_from_string("MIT"), PdfFontLicense::Mit));
    assert!(matches!(license_from_string("GPL"), PdfFontLicense::Gpl));
    assert!(matches!(
      license_from_string("Proprietary"),
      PdfFontLicense::Proprietary
    ));
    match license_from_string("CC-BY-SA-4.0") {
      PdfFontLicense::Other(s) => assert_eq!(s, "CC-BY-SA-4.0"),
      other => panic!("unexpected variant for unknown license: {other:?}"),
    }
  }

  // ── sniff_logo_format ────────────────────────────────────────────────────

  /// PNG magic bytes are recognised as PNG even with extra trailing data.
  #[test]
  fn sniff_logo_recognises_png_magic() {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06");
    assert_eq!(sniff_logo_format(&bytes).unwrap(), LogoFormat::Png);
  }

  /// SVG via XML declaration prefix.
  #[test]
  fn sniff_logo_recognises_svg_xml_decl() {
    let bytes = br#"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>"#;
    assert_eq!(sniff_logo_format(bytes).unwrap(), LogoFormat::Svg);
  }

  /// SVG via direct `<svg` opener (no XML decl).
  #[test]
  fn sniff_logo_recognises_svg_bare() {
    let bytes = br#"<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>"#;
    assert_eq!(sniff_logo_format(bytes).unwrap(), LogoFormat::Svg);
  }

  /// SVG with leading whitespace + UTF-8 BOM is still recognised.
  #[test]
  fn sniff_logo_tolerates_bom_and_whitespace() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(b"\n  \t<svg></svg>");
    assert_eq!(sniff_logo_format(&bytes).unwrap(), LogoFormat::Svg);
  }

  /// SVG case-insensitive opener (`<SVG` is legal XML markup).
  #[test]
  fn sniff_logo_svg_opener_is_case_insensitive() {
    assert_eq!(sniff_logo_format(b"<SVG>x</SVG>").unwrap(), LogoFormat::Svg);
  }

  /// Random binary content (e.g. JPEG, GIF) is rejected — neither PNG
  /// magic nor SVG-shaped. Operators must explicitly convert to one of
  /// the supported formats.
  #[test]
  fn sniff_logo_rejects_unknown_format() {
    // JPEG SOI marker.
    let bytes = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00";
    assert!(sniff_logo_format(bytes).is_err());
    // GIF magic.
    assert!(sniff_logo_format(b"GIF89a").is_err());
    // Plain text that isn't XML/SVG.
    assert!(sniff_logo_format(b"hello world\n").is_err());
  }

  /// Empty input does not look like PNG or SVG and is rejected loudly.
  #[test]
  fn sniff_logo_rejects_empty() {
    assert!(sniff_logo_format(b"").is_err());
  }

  /// Truncated PNG (signature shorter than 8 bytes) does NOT match the
  /// PNG branch and falls through to the SVG checker, which then also
  /// fails. Important so a 4-byte garbage payload is not silently
  /// classified as PNG.
  #[test]
  fn sniff_logo_rejects_truncated_png_signature() {
    assert!(sniff_logo_format(&PNG_SIGNATURE[..4]).is_err());
  }
}
