//! `import-file` subcommand — import Markdown files as pages into a workspace.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::Args;
use myoxus_application::doc::{InitialDocumentProvenance, InitialDocumentProvenanceMode};
use myoxus_application::markdown::{
  AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument, MarkdownBatchReferenceInventory,
  MarkdownBatchReferenceLookup, MarkdownReferenceLookup, markdown_image_sources, prepare_markdown_batch_import,
  prepare_markdown_data_images, rewrite_markdown_image_sources,
};
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest, PortError};
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::document_metadata::initial_sync_audit::{
  ImportedWorkspaceDocumentCreate, ensure_imported_workspace_document,
};
use myoxus_infrastructure::storage::StorageAdapter;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use tracing::info;
use uuid::Uuid;

use crate::services::Services;
use crate::users::resolve_user;

const COMPLEX_SEED_DOCUMENT_VERSION: i32 = 4;

/// Arguments for the `import-file` command.
#[derive(Args)]
pub struct ImportFileArgs {
  /// User email or UUID — recorded as creator of the imported pages.
  /// Must be a member of the target workspace.
  #[arg(long)]
  pub user: String,

  /// Target workspace UUID.
  #[arg(long, group = "ws_target")]
  pub workspace: Option<Uuid>,

  /// Target workspace name (alternative to --workspace).
  #[arg(long, group = "ws_target")]
  pub workspace_name: Option<String>,

  /// Preview only — show what would be imported without writing to the database.
  #[arg(long, default_value_t = false)]
  pub dry_run: bool,

  /// Optional deterministic seed prefix.
  ///
  /// When set, each file gets a stable workspace-scoped document ID derived
  /// from this prefix and the file stem. Existing seed documents are not
  /// re-imported, but they are still re-registered in the root doc if missing.
  #[arg(long)]
  pub seed_key_prefix: Option<String>,

  /// Filesystem blob-storage root used to materialize embedded Markdown assets.
  ///
  /// Defaults to the same `MYOXUS__STORAGE__ROOT` environment variable as the
  /// API server. Container-based local seeding inherits the API container value.
  #[arg(long, env = "MYOXUS__STORAGE__ROOT", default_value = "./storage")]
  pub storage_root: PathBuf,

  /// One or more Markdown (.md) files to import.
  #[arg(required = true)]
  pub files: Vec<PathBuf>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Execute the `import-file` command.
pub async fn run(args: ImportFileArgs, svc: &Services) -> anyhow::Result<()> {
  // 1. Resolve user
  let user = resolve_user(svc, &args.user).await?;
  let user_id = user.id;
  eprintln!("User: {} ({})", user.email, user_id);

  // 2. Resolve workspace
  let workspace_id = resolve_workspace(svc, &args).await?;
  let workspace = svc
    .workspace
    .get_workspace(workspace_id)
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?
    .ok_or_else(|| anyhow::anyhow!("Workspace not found: {workspace_id}"))?;
  eprintln!("Workspace: {} ({})", workspace.name, workspace_id);

  // 3. Check membership
  check_membership(&svc.pool, workspace_id, user_id).await?;

  // 4. Reserve every identity before converting any body so forward, self and
  // cyclic references all observe the same import batch.
  let root = common_import_root(&args.files)?;
  let mut planned = Vec::with_capacity(args.files.len());
  for path in &args.files {
    let content =
      std::fs::read_to_string(path).map_err(|error| anyhow::anyhow!("cannot read {}: {error}", path.display()))?;
    if content.trim().is_empty() {
      eprintln!("  ⚠ skipping empty file: {}", path.display());
      continue;
    }
    let content = materialize_exported_image_sources(path, &content, svc.server_origin())?;
    let title = extract_title(&content, path);
    let seed_key = args
      .seed_key_prefix
      .as_deref()
      .map(|prefix| seed_import_key(prefix, path));
    let doc_id = seed_key
      .as_deref()
      .map(|key| stable_seed_doc_id(workspace_id, key))
      .unwrap_or_else(Uuid::new_v4);
    let relative_path = path
      .canonicalize()
      .map_err(|error| anyhow::anyhow!("resolve {}: {error}", path.display()))?
      .strip_prefix(&root)
      .map_err(|_| anyhow::anyhow!("{} is outside the import root", path.display()))?
      .to_string_lossy()
      .replace('\\', "/");
    planned.push((path.clone(), title, doc_id, relative_path, content));
  }
  let existing_documents = load_reference_documents(&svc.pool, workspace_id).await?;
  let batch_documents = planned
    .iter()
    .map(|(_, title, doc_id, path, _)| AuthorizedMarkdownBatchDocument {
      external_id: doc_id.to_string(),
      title: title.clone(),
      path: path.clone(),
    })
    .collect::<Vec<_>>();

  // One frozen source inventory reserves native targets before any conversion
  // can persist a forward reference. Never reread files after this preflight:
  // a concurrent edit would otherwise invalidate both the targets and limits.
  let inventory = MarkdownBatchReferenceInventory::new_with_authorized(
    &format!("{}/workspace/{workspace_id}", svc.server_origin().trim_end_matches('/')),
    existing_documents.iter().map(|(_, document)| document.clone()),
    batch_documents,
  )?;
  let replaced = planned.iter().map(|(_, _, id, _, _)| *id).collect::<HashSet<_>>();
  let mut current_snapshots = Vec::with_capacity(existing_documents.len());
  for (doc_id, document) in &existing_documents {
    if replaced.contains(doc_id) {
      continue;
    }
    // Resolve SQL identities explicitly and read snapshot plus tail. Replaced
    // seed bodies are supplied by the frozen batch instead of obsolete content.
    current_snapshots.push((
      document.external_id.clone(),
      svc.doc.load_full_doc(workspace_id, *doc_id).await?,
    ));
  }
  let inventory = inventory
    .with_target_snapshots(
      current_snapshots
        .iter()
        .map(|(id, binary)| (id.as_str(), binary.as_slice())),
    )?
    .with_import_sources(
      planned
        .iter()
        .map(|(_, _, _, path, content)| (path.as_str(), content.as_str())),
    )?;
  for (path, title, _, relative_path, content) in &planned {
    let lookup = inventory.for_source(relative_path)?;
    prepare_markdown_batch_import(title, content, &lookup)
      .map_err(|error| anyhow::anyhow!("Markdown preflight failed for {}: {error}", path.display()))?;
  }

  // 5. Process each preflighted file.
  let mut imported_pages: Vec<(Uuid, String)> = Vec::new();
  let mut skipped = 0u32;
  let blob_service = if args.dry_run {
    None
  } else {
    Some(import_blob_storage(&args.storage_root)?)
  };

  for (path, _title, reserved_doc_id, relative_path, content) in &planned {
    let lookup = inventory.for_source(relative_path)?;
    match import_single_file_with_origin(
      path,
      content,
      workspace_id,
      user_id,
      args.dry_run,
      args.seed_key_prefix.as_deref(),
      svc.server_origin(),
      Some(*reserved_doc_id),
      Some(&lookup),
      &svc.pool,
      blob_service.as_deref().map(|storage| storage as &dyn BlobStoragePort),
    )
    .await
    {
      Ok(Some((doc_id, title))) => {
        if args.dry_run {
          println!("  [dry-run] would import \"{}\" from {}", title, path.display());
        } else {
          println!("  ✓ imported \"{}\" → {}", title, doc_id);
        }
        imported_pages.push((doc_id, title));
      }
      Ok(None) => {
        skipped += 1;
      }
      Err(e) => {
        eprintln!("  ✗ {} — {}", path.display(), e);
        skipped += 1;
      }
    }
  }

  // 6. Register imported pages in workspace root doc (so they appear in sidebar)
  if !args.dry_run && !imported_pages.is_empty() {
    match register_in_root_doc(&svc.pool, workspace_id, &imported_pages).await {
      Ok(registered) => {
        eprintln!(
          "  ✓ registered {registered}/{} page(s) in workspace root doc",
          imported_pages.len()
        );
      }
      Err(e) => {
        eprintln!("  ⚠ root doc update failed (pages imported but may not appear in sidebar): {e}");
      }
    }
  }

  eprintln!(
    "\nDone. Imported: {}, Skipped: {skipped}, Total: {}",
    imported_pages.len(),
    args.files.len()
  );

  Ok(())
}

/// Freeze packaged export images into the existing data-image preparation path.
/// Only a manifest-owned document may read outside its own directory, and all
/// resolved bytes must stay inside its root or managed-prefix assets directory.
/// The existing batch resolver owns decoding and normalization of image URLs.
#[tracing::instrument(skip_all)]
fn materialize_exported_image_sources(path: &Path, content: &str, server_origin: &str) -> anyhow::Result<String> {
  use base64::Engine;
  use myoxus_application::git_sync::export::{
    GIT_SYNC_MANIFEST_PATH, GIT_SYNC_MANIFEST_SCHEMA_VERSION, GitSyncManifest,
  };
  let path = path.canonicalize()?;
  let parent = path
    .parent()
    .ok_or_else(|| anyhow::anyhow!("Markdown file has no parent"))?;
  let mut export_root = None;
  for ancestor in parent.ancestors() {
    let manifest_path = ancestor.join(GIT_SYNC_MANIFEST_PATH);
    if !manifest_path.is_file() {
      continue;
    }
    let manifest: GitSyncManifest = serde_json::from_slice(&std::fs::read(manifest_path)?).map_err(|error| {
      anyhow::anyhow!(
        "invalid Markdown export manifest JSON at {}:{}",
        error.line(),
        error.column()
      )
    })?;
    if manifest.schema_version != GIT_SYNC_MANIFEST_SCHEMA_VERSION {
      anyhow::bail!("unsupported Markdown export manifest version");
    }
    manifest
      .validate_overviews(manifest.workspace_id, std::iter::empty())
      .map_err(anyhow::Error::msg)?;
    let relative = path.strip_prefix(ancestor)?.to_string_lossy().replace('\\', "/");
    if manifest.documents.iter().any(|document| document.repo_path == relative) {
      let references = MarkdownBatchReferenceLookup::new(
        &format!(
          "{}/workspace/{}",
          server_origin.trim_end_matches('/'),
          manifest.workspace_id
        ),
        std::iter::empty(),
        &relative,
      )?;
      let managed_assets = manifest
        .overview
        .as_ref()
        .and_then(|overview| Path::new(&overview.repo_path).parent())
        .map(|parent| ancestor.join(parent).join("assets"));
      export_root = Some((ancestor, references, managed_assets));
    }
    break;
  }
  let Some((root, references, managed_assets)) = export_root else {
    return Ok(content.to_owned());
  };
  let mut asset_roots = vec![root.join("assets")];
  if let Some(managed) = managed_assets {
    if !asset_roots.contains(&managed) {
      asset_roots.push(managed);
    }
  }
  let assets = asset_roots
    .into_iter()
    .filter(|path| path.is_dir())
    .map(|path| path.canonicalize())
    .collect::<Result<Vec<_>, _>>()?;
  if assets.is_empty() {
    if markdown_image_sources(content).iter().any(|source| {
      Path::new(source)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    }) {
      anyhow::bail!("packaged Markdown images directory is missing");
    }
    return Ok(content.to_owned());
  }
  if assets.iter().any(|assets| !assets.starts_with(root)) {
    anyhow::bail!("export assets directory escapes export root");
  }
  let limits = myoxus_workspace_import::WorkspaceImportLimits::default();
  let mut replacements = HashMap::new();
  let mut total = 0u64;
  for source in markdown_image_sources(content) {
    if source.contains(':') || source.starts_with('/') {
      continue;
    }
    let relative = references
      .resolve_import_asset_path(&source)
      .ok_or_else(|| anyhow::anyhow!("Markdown image escapes export assets directory"))?;
    let candidate = root.join(relative);
    if !candidate.exists() {
      if Path::new(&source)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
      {
        anyhow::bail!("packaged Markdown image is missing");
      }
      continue;
    }
    let candidate = candidate.canonicalize()?;
    if !assets.iter().any(|assets| candidate.starts_with(assets)) {
      anyhow::bail!("Markdown image escapes export assets directory");
    }
    let mime = match candidate.extension().and_then(|extension| extension.to_str()) {
      Some("svg") => "image/svg+xml",
      Some("png") => "image/png",
      Some("jpg" | "jpeg") => "image/jpeg",
      Some("gif") => "image/gif",
      Some("webp") => "image/webp",
      Some("avif") => "image/avif",
      _ => anyhow::bail!("unsupported packaged Markdown image type"),
    };
    let size = candidate.metadata()?.len();
    total = total
      .checked_add(size)
      .ok_or_else(|| anyhow::anyhow!("Markdown image size overflow"))?;
    if size > limits.max_entry_bytes || total > limits.max_asset_bytes || replacements.len() >= limits.max_assets {
      anyhow::bail!("packaged Markdown images exceed import limits");
    }
    let bytes = std::fs::read(candidate)?;
    if bytes.len() as u64 != size {
      anyhow::bail!("packaged Markdown image changed during read");
    }
    replacements.insert(
      source,
      format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
      ),
    );
  }
  rewrite_markdown_image_sources(content, &replacements).map_err(anyhow::Error::from)
}

fn common_import_root(paths: &[PathBuf]) -> anyhow::Result<PathBuf> {
  let mut parents = paths
    .iter()
    .map(|path| {
      path
        .canonicalize()
        .map_err(|error| anyhow::anyhow!("resolve {}: {error}", path.display()))
        .map(|path| path.parent().map(Path::to_path_buf).unwrap_or(path))
    })
    .collect::<Result<Vec<_>, _>>()?;
  let mut root = parents
    .pop()
    .ok_or_else(|| anyhow::anyhow!("at least one Markdown file is required"))?;
  for parent in parents {
    while !parent.starts_with(&root) {
      root = root
        .parent()
        .ok_or_else(|| anyhow::anyhow!("cannot determine a common import root"))?
        .to_path_buf();
    }
  }
  Ok(root)
}

async fn load_reference_documents(
  pool: &PgPool,
  workspace_id: Uuid,
) -> anyhow::Result<Vec<(Uuid, AuthorizedMarkdownDocument)>> {
  Ok(sqlx::query_as::<_, (Uuid, String, String)>(
    "SELECT id, external_id, COALESCE(title, '') FROM docs WHERE workspace_id = $1 AND deleted_at IS NULL AND blocked = false AND is_workspace_root = false AND external_id NOT LIKE 'db$%' AND external_id NOT LIKE 'userdata$%'",
  )
  .bind(workspace_id)
  .fetch_all(pool)
  .await?
  .into_iter()
  .map(|(id, external_id, title)| (id, AuthorizedMarkdownDocument { external_id, title }))
  .collect())
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

async fn resolve_workspace(svc: &Services, args: &ImportFileArgs) -> anyhow::Result<Uuid> {
  if let Some(id) = args.workspace {
    return Ok(id);
  }
  if let Some(ref name) = args.workspace_name {
    let ws_id: Option<Uuid> =
      sqlx::query_scalar("SELECT id FROM workspaces WHERE name = $1 AND deleted_at IS NULL LIMIT 1")
        .bind(name)
        .fetch_optional(&svc.pool)
        .await
        .map_err(|e| anyhow::anyhow!("DB error looking up workspace by name: {e}"))?;

    return ws_id.ok_or_else(|| anyhow::anyhow!("Workspace not found by name: {name}"));
  }
  anyhow::bail!("Specify --workspace <UUID> or --workspace-name <name>");
}

// ---------------------------------------------------------------------------
// Membership check
// ---------------------------------------------------------------------------

async fn check_membership(pool: &PgPool, workspace_id: Uuid, user_id: Uuid) -> anyhow::Result<()> {
  let is_member: bool = sqlx::query_scalar(
    "SELECT EXISTS(
            SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'Accepted'
        )",
  )
  .bind(workspace_id)
  .bind(user_id)
  .fetch_one(pool)
  .await
  .map_err(|e| anyhow::anyhow!("Database error checking membership: {e}"))?;

  if !is_member {
    anyhow::bail!("User {} is not a member of workspace {}", user_id, workspace_id);
  }
  Ok(())
}

fn import_blob_storage(storage_root: &Path) -> anyhow::Result<Arc<StorageAdapter>> {
  let storage_root = storage_root
    .to_str()
    .ok_or_else(|| anyhow::anyhow!("storage root is not valid UTF-8: {}", storage_root.display()))?;
  Ok(Arc::new(StorageAdapter::new_fs(storage_root)?))
}

fn seed_import_key(prefix: &str, path: &Path) -> String {
  let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("document");
  let normalized_stem = normalize_seed_key(stem);
  let normalized_stem = if normalized_stem.is_empty() {
    "document".to_string()
  } else {
    normalized_stem
  };
  format!("{}:{}", prefix.trim(), normalized_stem)
}

fn normalize_seed_key(value: &str) -> String {
  let mut normalized = String::new();
  let mut last_was_dash = false;
  for ch in value.chars().flat_map(char::to_lowercase) {
    if ch.is_ascii_alphanumeric() {
      normalized.push(ch);
      last_was_dash = false;
    } else if !last_was_dash {
      normalized.push('-');
      last_was_dash = true;
    }
  }
  normalized.trim_matches('-').to_string()
}

fn stable_seed_doc_id(workspace_id: Uuid, seed_key: &str) -> Uuid {
  Uuid::new_v5(
    &Uuid::NAMESPACE_URL,
    format!("myoxus:workspace-seed-doc:{workspace_id}:{seed_key}").as_bytes(),
  )
}

struct SeedDocState {
  has_content: bool,
  content_hash: Option<String>,
  seed_version: Option<i32>,
}

fn seed_content_hash(content: &str) -> String {
  format!("{:x}", Sha256::digest(content.as_bytes()))
}

async fn load_seed_doc_state(pool: &PgPool, doc_id: Uuid, workspace_id: Uuid) -> anyhow::Result<Option<SeedDocState>> {
  sqlx::query_as::<_, (Option<String>, Option<i32>, bool)>(
    r#"
      SELECT d.meta->>'seed_content_hash' AS seed_content_hash,
             CASE
               WHEN d.meta ? 'seed_version'
                AND d.meta->>'seed_version' ~ '^-?[0-9]+$'
               THEN (d.meta->>'seed_version')::int
               ELSE NULL
             END AS seed_version,
             (
               EXISTS(SELECT 1 FROM doc_updates u WHERE u.doc_id = d.id AND u.workspace_id = d.workspace_id)
               OR EXISTS(SELECT 1 FROM doc_snapshots s WHERE s.doc_id = d.id AND s.workspace_id = d.workspace_id)
             ) AS has_content
        FROM docs d
       WHERE d.id = $1
         AND d.workspace_id = $2
         AND d.deleted_at IS NULL
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .fetch_optional(pool)
  .await
  .map(|row| {
    row.map(|(content_hash, seed_version, has_content)| SeedDocState {
      has_content,
      content_hash,
      seed_version,
    })
  })
  .map_err(|e| anyhow::anyhow!("Database error checking seed document state: {e}"))
}

// ---------------------------------------------------------------------------
// Single file import
// ---------------------------------------------------------------------------

/// Import a single Markdown file. Returns `Ok(Some((doc_id, title)))` on
/// success, `Ok(None)` if the file was skipped (empty), or `Err` on failure.
#[tracing::instrument(skip_all, fields(%workspace_id))]
async fn import_single_file_with_origin(
  path: &PathBuf,
  content: &str,
  workspace_id: Uuid,
  user_id: Uuid,
  dry_run: bool,
  seed_key_prefix: Option<&str>,
  server_origin: &str,
  reserved_doc_id: Option<Uuid>,
  batch_references: Option<&MarkdownBatchReferenceLookup>,
  pool: &PgPool,
  blob_service: Option<&dyn BlobStoragePort>,
) -> anyhow::Result<Option<(Uuid, String)>> {
  if content.trim().is_empty() {
    eprintln!("  ⚠ skipping empty file: {}", path.display());
    return Ok(None);
  }

  // Extract title: first line starting with "# " (not "## ")
  let title = extract_title(&content, path);

  let seed_key = seed_key_prefix.map(|prefix| seed_import_key(prefix, path));
  let seed_content_hash = seed_key.as_ref().map(|_| seed_content_hash(&content));
  let doc_id = reserved_doc_id.unwrap_or_else(|| {
    if dry_run {
      Uuid::nil()
    } else {
      seed_key
        .as_deref()
        .map(|key| stable_seed_doc_id(workspace_id, key))
        .unwrap_or_else(Uuid::new_v4)
    }
  });

  let seed_doc_state = if seed_key.is_some() {
    load_seed_doc_state(pool, doc_id, workspace_id).await?
  } else {
    None
  };
  let refresh_existing_seed_doc = seed_doc_state.as_ref().is_some_and(|state| {
    state.has_content
      && (state.content_hash.as_deref() != seed_content_hash.as_deref()
        || state.seed_version != Some(COMPLEX_SEED_DOCUMENT_VERSION))
  });
  if let Some(state) = &seed_doc_state
    && state.has_content
    && !refresh_existing_seed_doc
  {
    return Ok(Some((doc_id, title)));
  }

  // Validate the original Markdown before data-image materialization can write
  // blobs. Conversion is repeated below after safe asset URLs are substituted.
  if let Some(references) = batch_references {
    prepare_markdown_batch_import(&title, &content, references)
  } else {
    let mut documents = load_reference_documents(pool, workspace_id)
      .await?
      .into_iter()
      .map(|(_, document)| document)
      .collect::<Vec<_>>();
    documents.push(AuthorizedMarkdownDocument {
      external_id: doc_id.to_string(),
      title: title.clone(),
    });
    let references = MarkdownReferenceLookup::new(
      &format!("{}/workspace/{workspace_id}", server_origin.trim_end_matches('/')),
      documents,
    )?;
    myoxus_application::markdown::prepare_markdown_import_with_references(&title, &content, &references)
  }
  .map_err(|e| anyhow::anyhow!("Markdown preflight failed for {}: {e}", path.display()))?;

  // Decode the complete immutable image batch before SQL or external writes.
  // Publication below reuses the normal metadata/accounting fence; definitions
  // are ordinary children and never acquire a separate storage lifecycle.
  let prepared_assets = prepare_markdown_data_images(content, doc_id)
    .map_err(|error| anyhow::anyhow!("embedded Markdown asset materialization failed: {error}"))?;
  let content_for_yjs = &prepared_assets.markdown;
  if !dry_run && !prepared_assets.writes.is_empty() && blob_service.is_none() {
    anyhow::bail!("Markdown contains embedded data:image assets but no blob storage service is configured");
  }

  // Convert to Yjs binary
  let prepared = if let Some(references) = batch_references {
    prepare_markdown_batch_import(&title, &content_for_yjs, references)
  } else {
    let mut documents = load_reference_documents(pool, workspace_id)
      .await?
      .into_iter()
      .map(|(_, document)| document)
      .collect::<Vec<_>>();
    documents.push(AuthorizedMarkdownDocument {
      external_id: doc_id.to_string(),
      title: title.clone(),
    });
    let references = MarkdownReferenceLookup::new(
      &format!("{}/workspace/{workspace_id}", server_origin.trim_end_matches('/')),
      documents,
    )?;
    myoxus_application::markdown::prepare_markdown_import_with_references(&title, &content_for_yjs, &references)
  }
  .map_err(|e| anyhow::anyhow!("markdown_to_yjs failed for {}: {e}", path.display()))?;
  if !prepared.diagnostics.is_empty() {
    eprintln!(
      "  ⚠ {} Markdown document reference(s) remained unresolved or unsupported in {}",
      prepared.diagnostics.len(),
      path.display()
    );
  }
  let yjs_data = prepared.yjs_binary;
  if dry_run {
    return Ok(Some((doc_id, title)));
  }

  // Insert doc + doc_update in a transaction
  let mut tx = pool.begin().await?;
  let mut written_objects = Vec::new();
  let publication: anyhow::Result<()> = async {
    if refresh_existing_seed_doc {
      sqlx::query("DELETE FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to clear existing seed doc snapshots: {e}"))?;
      sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to clear existing seed doc updates: {e}"))?;
    }

    let initial_provenance = InitialDocumentProvenance {
      idempotency_key: Some(
        seed_key
          .as_ref()
          .map(|key| format!("cli-import-file:{workspace_id}:{key}"))
          .unwrap_or_else(|| format!("cli-import-file:{workspace_id}:{doc_id}")),
      ),
      client_family: Some("myoxus-cli".to_string()),
      client_version: None,
      client_instance_id: None,
      provenance_mode: InitialDocumentProvenanceMode::ExplicitImport,
      client_created_at: None,
      client_updated_at: None,
      client_created_by: None,
      client_updated_by: None,
      historical_user_mapping_id: None,
      source_property_doc_revision: Some(path.display().to_string()),
    };

    ensure_imported_workspace_document(
      &mut tx,
      ImportedWorkspaceDocumentCreate {
        doc_id,
        workspace_id,
        title: &title,
        actor_user_id: user_id,
        client_format: if seed_key.is_some() {
          "myoxus-cli-seed-import"
        } else {
          "myoxus-cli-import"
        },
        provenance: &initial_provenance,
        update_existing_title: seed_key.is_some(),
      },
    )
    .await
    .map_err(|e| anyhow::anyhow!("Failed to ensure imported doc row: {e}"))?;

    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence, server_timestamp)
         VALUES ($1, $2, $3, 1, NOW())",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(&yjs_data)
    .execute(&mut *tx)
    .await
    .map_err(|e| anyhow::anyhow!("Failed to insert doc_update row: {e}"))?;

    let plain_text = myoxus_application::doc::project_yjs_plain_text(workspace_id, doc_id, &title, &yjs_data)
      .map_err(|error| anyhow::anyhow!("failed to project imported plain text: {error}"))?
      .plain_text;
    if let Some(seed_key) = seed_key.as_deref() {
      sqlx::query(
        r#"
        UPDATE docs
        SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
              'plain_text', $3::text,
              'seed', 'manual-test',
              'seed_kind', 'complex-test-document',
              'seed_key', $4::text,
              'seed_version', $5::int,
              'seed_content_hash', $6::text
            ),
            deleted_at = NULL,
            updated_at = now()
        WHERE id = $1 AND workspace_id = $2
      "#,
      )
      .bind(doc_id)
      .bind(workspace_id)
      .bind(&plain_text)
      .bind(seed_key)
      .bind(COMPLEX_SEED_DOCUMENT_VERSION)
      .bind(
        seed_content_hash
          .as_deref()
          .expect("seed content hash is present when seed_key is present"),
      )
      .execute(&mut *tx)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to store imported seed metadata: {e}"))?;
    } else {
      sqlx::query(
        r#"
        UPDATE docs
        SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('plain_text', $3::text)
        WHERE id = $1 AND workspace_id = $2
      "#,
      )
      .bind(doc_id)
      .bind(workspace_id)
      .bind(&plain_text)
      .execute(&mut *tx)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to store imported plain text metadata: {e}"))?;
    }

    sqlx::query(
      r#"
      INSERT INTO search_content (workspace_id, doc_id, title, plain_text, search_vector, updated_at)
      VALUES ($1, $2, $3, $4, to_tsvector('simple', $3 || ' ' || $4), NOW())
      ON CONFLICT (workspace_id, doc_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        plain_text = EXCLUDED.plain_text,
        search_vector = EXCLUDED.search_vector,
        updated_at = EXCLUDED.updated_at
    "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(&title)
    .bind(&plain_text)
    .execute(&mut *tx)
    .await
    .map_err(|e| anyhow::anyhow!("Failed to update imported search document: {e}"))?;

    // Match normal import lock order: document identity first, accounting next.
    if !prepared_assets.writes.is_empty() {
      SqlxBlobStore::new(pool.clone())
        .reserve_markdown_import_assets_in_tx(&mut tx, workspace_id, &prepared_assets.writes)
        .await?;
    }

    if let Some(storage) = blob_service {
      for asset in &prepared_assets.writes {
        let key = format!("{workspace_id}/{}", asset.metadata.blob_key);
        match storage.read_blob(&key).await {
          Ok(existing) => {
            if existing.data != asset.bytes {
              anyhow::bail!("Markdown image conflicts with existing object bytes");
            }
          }
          Err(PortError::NotFound(_)) => {
            // An adapter can fail after creating a partial object. Record ownership
            // before writing, but never compensate an object that predated us.
            written_objects.push(key.clone());
            storage
              .write_blob(BlobWriteRequest {
                key,
                content_type: Some(asset.metadata.mime.clone()),
                body: asset.bytes.clone(),
              })
              .await?;
          }
          Err(error) => return Err(error.into()),
        }
      }
    }
    Ok(())
  }
  .await;
  let outcome = match publication {
    Ok(()) => tx.commit().await.map_err(anyhow::Error::from),
    Err(error) => {
      tx.rollback().await?;
      Err(error)
    }
  };
  if let Err(error) = outcome {
    if let Some(storage) = blob_service {
      for key in written_objects {
        // A failed COMMIT acknowledgement is not proof of rollback. The existing
        // reference fence protects both committed and concurrent blob owners.
        let mut cleanup = pool.begin().await?;
        if SqlxBlobStore::lock_unreferenced_import_object_cleanup_in_tx(&mut cleanup, &key).await? {
          storage.delete_blob(&key).await?;
        }
        cleanup.rollback().await?;
      }
    }
    return Err(error);
  }

  info!(%workspace_id, %doc_id, assets = prepared_assets.writes.len(), "published Markdown parent and normal assets");
  Ok(Some((doc_id, title)))
}

#[cfg(test)]
async fn import_single_file(
  path: &PathBuf,
  workspace_id: Uuid,
  user_id: Uuid,
  dry_run: bool,
  seed_key_prefix: Option<&str>,
  pool: &PgPool,
  blob_service: Option<&dyn BlobStoragePort>,
) -> anyhow::Result<Option<(Uuid, String)>> {
  let content = std::fs::read_to_string(path)?;
  import_single_file_with_origin(
    path,
    &content,
    workspace_id,
    user_id,
    dry_run,
    seed_key_prefix,
    "https://myoxus.test",
    None,
    None,
    pool,
    blob_service,
  )
  .await
}

// ---------------------------------------------------------------------------
// Root doc registration
// ---------------------------------------------------------------------------

struct RootDocRegistrationState {
  updates_for_merge: Vec<Vec<u8>>,
  next_sequence: i64,
}

/// Load the authoritative root-doc state used for CLI page registration.
///
/// Root docs can be compacted: `doc_snapshots.payload` then contains all
/// updates up to `last_sequence`, while `doc_updates` only contains the tail.
/// Reconstructing root metadata from `doc_updates` alone silently drops pages
/// in compacted workspaces and can write a follow-up update with a stale
/// sequence. The returned update list is therefore always `snapshot + tail`.
async fn load_root_doc_registration_state(
  pool: &PgPool,
  workspace_id: Uuid,
) -> anyhow::Result<RootDocRegistrationState> {
  let snapshot =
    sqlx::query("SELECT payload, last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $1")
      .bind(workspace_id)
      .fetch_optional(pool)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to load root doc snapshot: {e}"))?;

  let (mut updates_for_merge, snapshot_last_sequence) = match snapshot {
    Some(row) => {
      let payload: Vec<u8> = row.get("payload");
      let last_sequence: i64 = row.get("last_sequence");
      (vec![payload], last_sequence)
    }
    None => (Vec::new(), -1),
  };

  let update_rows = sqlx::query(
    "SELECT payload, sequence
       FROM doc_updates
      WHERE workspace_id = $1
        AND doc_id = $1
        AND sequence > $2
      ORDER BY sequence ASC",
  )
  .bind(workspace_id)
  .bind(snapshot_last_sequence)
  .fetch_all(pool)
  .await
  .map_err(|e| anyhow::anyhow!("Failed to load root doc update tail: {e}"))?;

  let mut max_tail_sequence = snapshot_last_sequence;
  for row in update_rows {
    let payload: Vec<u8> = row.get("payload");
    let sequence: i64 = row.get("sequence");
    max_tail_sequence = max_tail_sequence.max(sequence);
    updates_for_merge.push(payload);
  }

  let max_update_sequence: i64 =
    sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1")
      .bind(workspace_id)
      .fetch_one(pool)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to get max root doc update sequence: {e}"))?;

  Ok(RootDocRegistrationState {
    updates_for_merge,
    next_sequence: snapshot_last_sequence.max(max_tail_sequence).max(max_update_sequence) + 1,
  })
}

/// Load all root doc updates, add the imported pages to `meta.pages`, and
/// write the incremental Yjs update back as a new `doc_updates` row.
async fn register_in_root_doc(pool: &PgPool, workspace_id: Uuid, pages: &[(Uuid, String)]) -> anyhow::Result<usize> {
  let root_state = load_root_doc_registration_state(pool, workspace_id).await?;

  let page_entries: Vec<(String, String)> = pages
    .iter()
    .map(|(id, title)| (id.to_string(), title.clone()))
    .collect();

  let missing_page_entries = filter_existing_root_pages(&root_state.updates_for_merge, &page_entries)?;
  let registered_count = missing_page_entries.len();

  let directory_diff = yjs::add_pages_to_root_doc(&root_state.updates_for_merge, &missing_page_entries)
    .map_err(|e| anyhow::anyhow!("Failed to update root doc pages array: {e}"))?;
  let original_root = yjs::merge_updates(root_state.updates_for_merge.clone())
    .map_err(|e| anyhow::anyhow!("Failed to merge root doc before page registration: {e}"))?;
  let mut projected_root = if directory_diff.is_empty() {
    original_root
  } else {
    yjs::merge_updates(vec![original_root, directory_diff.clone()])
      .map_err(|e| anyhow::anyhow!("Failed to merge root page directory update: {e}"))?
  };
  let root_pages = yjs::extract_workspace_root_metadata(&projected_root)
    .map_err(|e| anyhow::anyhow!("Failed to inspect root page metadata: {e}"))?
    .pages
    .into_iter()
    .map(|page| (page.id.clone(), page))
    .collect::<HashMap<_, _>>();
  let page_ids = pages.iter().map(|(id, _)| *id).collect::<Vec<_>>();
  let timestamps = sqlx::query(
    "SELECT id,
            (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS created_at_ms,
            (EXTRACT(EPOCH FROM updated_at) * 1000)::BIGINT AS updated_at_ms
       FROM docs
      WHERE workspace_id = $1
        AND id = ANY($2)",
  )
  .bind(workspace_id)
  .bind(&page_ids)
  .fetch_all(pool)
  .await
  .map_err(|e| anyhow::anyhow!("Failed to load imported page timestamps: {e}"))?
  .into_iter()
  .map(|row| {
    (
      row.get::<Uuid, _>("id"),
      (row.get::<i64, _>("created_at_ms"), row.get::<i64, _>("updated_at_ms")),
    )
  })
  .collect::<HashMap<_, _>>();
  let mut deltas = Vec::with_capacity(pages.len() + 1);
  if !directory_diff.is_empty() {
    deltas.push(directory_diff);
  }
  for (page_id, title) in pages {
    let root_page = root_pages
      .get(&page_id.to_string())
      .ok_or_else(|| anyhow::anyhow!("Imported page {page_id} is absent from the workspace root"))?;
    if root_page.created_at_ms.is_some() && root_page.updated_at_ms.is_some() {
      continue;
    }
    let (created_at_ms, updated_at_ms) = timestamps
      .get(page_id)
      .copied()
      .ok_or_else(|| anyhow::anyhow!("Imported page {page_id} has no relational timestamp metadata"))?;
    let metadata = yjs::update_root_page_metadata(
      &projected_root,
      &page_id.to_string(),
      Some(title),
      Some(false),
      Some(created_at_ms),
      updated_at_ms,
    )
    .map_err(|e| anyhow::anyhow!("Failed to project imported page timestamps: {e}"))?;
    if metadata.matched_entries != 1 {
      anyhow::bail!("Imported page {page_id} did not resolve to exactly one root entry");
    }
    projected_root = yjs::merge_updates(vec![projected_root, metadata.update.clone()])
      .map_err(|e| anyhow::anyhow!("Failed to merge imported page timestamp projection: {e}"))?;
    deltas.push(metadata.update);
  }

  if deltas.is_empty() {
    return Ok(0);
  }
  let diff =
    yjs::merge_updates(deltas).map_err(|e| anyhow::anyhow!("Failed to merge root page registration updates: {e}"))?;

  // The sequence must be greater than both the compacted snapshot's
  // `last_sequence` and every pending update. Otherwise normal root-doc loading
  // (`snapshot + updates where sequence > last_sequence`) would ignore it.
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence, server_timestamp)
         VALUES ($1, $2, $3, $4, NOW())",
  )
  .bind(workspace_id)
  .bind(workspace_id)
  .bind(&diff)
  .bind(root_state.next_sequence)
  .execute(pool)
  .await
  .map_err(|e| anyhow::anyhow!("Failed to insert root doc update: {e}"))?;

  Ok(registered_count)
}

fn filter_existing_root_pages(
  root_updates: &[Vec<u8>],
  pages: &[(String, String)],
) -> anyhow::Result<Vec<(String, String)>> {
  if root_updates.is_empty() || pages.is_empty() {
    return Ok(pages.to_vec());
  }

  let existing_page_ids: HashSet<String> = yjs::extract_page_trash_state_from_updates(root_updates)
    .map_err(|e| anyhow::anyhow!("Failed to read client-visible root doc pages for import dedupe: {e}"))?
    .into_iter()
    // A live imported document with a trashed root entry is still invisible to
    // the browser. Let `add_pages_to_root_doc` repair that existing YMap instead
    // of deduplicating it away.
    .filter(|entry| !entry.is_trashed)
    .map(|entry| entry.id)
    .collect();

  Ok(
    pages
      .iter()
      .filter(|(page_id, _)| !existing_page_ids.contains(page_id))
      .cloned()
      .collect(),
  )
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

fn extract_title(content: &str, path: &Path) -> String {
  for line in content.lines() {
    let trimmed = line.trim();
    // Match "# Title" but not "## Subtitle"
    if trimmed.starts_with("# ") && !trimmed.starts_with("## ") {
      return trimmed[2..].trim().to_string();
    }
  }
  // Fallback: filename without extension
  path
    .file_stem()
    .and_then(|s| s.to_str())
    .unwrap_or("Untitled")
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::Row;
  use sqlx::postgres::PgPoolOptions;
  use std::io::Write;
  use tempfile::{NamedTempFile, TempDir};
  use yrs::updates::decoder::Decode;
  use yrs::{Any, Array, Map, Transact};

  fn root_page_timestamps(state: &[u8], page_id: Uuid) -> (i64, i64) {
    let doc = yrs::Doc::new();
    let meta = doc.get_or_insert_map("meta");
    doc
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(state).expect("root state must decode"))
      .expect("root state must apply");
    let txn = doc.transact();
    let pages = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(pages)) => pages,
      other => panic!("root meta.pages must be an array, got {other:?}"),
    };
    pages
      .iter(&txn)
      .find_map(|entry| {
        let yrs::Out::YMap(page) = entry else {
          return None;
        };
        let matches = matches!(
          page.get(&txn, "id"),
          Some(yrs::Out::Any(Any::String(id))) if id.as_ref() == page_id.to_string()
        );
        matches.then(|| {
          let timestamp = |key| match page.get(&txn, key) {
            Some(yrs::Out::Any(Any::Number(value))) => value.as_f64().expect("numeric timestamp") as i64,
            other => panic!("root {key} must be numeric, got {other:?}"),
          };
          (timestamp("createDate"), timestamp("updatedDate"))
        })
      })
      .expect("root projection must contain imported page")
  }

  fn test_db_url() -> String {
    std::env::var("TEST_DATABASE_URL")
      .or_else(|_| std::env::var("DATABASE_URL"))
      .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string())
  }

  #[test]
  fn canonical_plain_text_preserves_document_heading_and_body_context() {
    let markdown = r#"# Imported Doc

First paragraph.

- List item

```rust
fn main() {}
```
"#;

    let prepared = myoxus_application::markdown::prepare_markdown_import("Imported Doc", markdown).unwrap();
    let projected =
      myoxus_application::doc::project_yjs_plain_text(Uuid::nil(), Uuid::nil(), "Imported Doc", &prepared.yjs_binary)
        .unwrap();
    assert_eq!(projected.title, "Imported Doc");
    assert!(projected.plain_text.contains("Imported Doc"));
    assert!(projected.plain_text.contains("First paragraph."));
    assert!(projected.plain_text.contains("List item"));
    assert!(projected.plain_text.contains("fn main() {}"));
  }

  #[test]
  fn seed_key_normalizes_file_stem() {
    assert_eq!(
      seed_import_key("manual-test-complex-v1", Path::new("01 Editor Typography Stress.md")),
      "manual-test-complex-v1:01-editor-typography-stress"
    );
    assert_eq!(normalize_seed_key("  Übersicht + Tabellen  "), "bersicht-tabellen");
  }

  #[test]
  fn stable_seed_doc_id_is_workspace_scoped_and_repeatable() {
    let workspace_a = Uuid::parse_str("00000000-0000-0000-0000-0000000000aa").unwrap();
    let workspace_b = Uuid::parse_str("00000000-0000-0000-0000-0000000000bb").unwrap();

    let first = stable_seed_doc_id(workspace_a, "manual-test-complex-v1:alpha");
    let second = stable_seed_doc_id(workspace_a, "manual-test-complex-v1:alpha");
    let other_workspace = stable_seed_doc_id(workspace_b, "manual-test-complex-v1:alpha");

    assert_eq!(first, second);
    assert_ne!(first, other_workspace);
  }

  #[test]
  fn root_page_filter_removes_existing_pages() {
    let existing_doc_id = Uuid::new_v4().to_string();
    let new_doc_id = Uuid::new_v4().to_string();
    let initial = yjs::create_initial_workspace_doc("Test workspace");
    let first_page = yjs::add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[(existing_doc_id.clone(), "Existing".to_string())],
    )
    .expect("root page update");

    let filtered = filter_existing_root_pages(
      &[initial, first_page],
      &[
        (existing_doc_id, "Existing duplicate".to_string()),
        (new_doc_id.clone(), "New page".to_string()),
      ],
    )
    .expect("root page filter");

    assert_eq!(filtered, vec![(new_doc_id, "New page".to_string())]);
  }

  #[test]
  fn root_page_filter_reimports_client_deleted_pages() {
    let deleted_doc_id = Uuid::new_v4().to_string();
    let initial = yjs::create_initial_workspace_doc("Test workspace");
    let add_page = yjs::add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[(deleted_doc_id.clone(), "Deleted page".to_string())],
    )
    .expect("root page update");
    let full_before_delete = yjs::merge_updates(vec![initial.clone(), add_page.clone()]).expect("merge before delete");
    let delete_page = yjs::remove_pages_from_root_doc(&full_before_delete, std::slice::from_ref(&deleted_doc_id))
      .expect("root page delete")
      .update;

    let filtered = filter_existing_root_pages(
      &[initial, add_page, delete_page],
      &[(deleted_doc_id.clone(), "Deleted page restored by seed".to_string())],
    )
    .expect("root page filter");

    assert_eq!(
      filtered,
      vec![(deleted_doc_id, "Deleted page restored by seed".to_string())],
      "client-deleted root entries must not suppress seed root registration"
    );
  }

  #[test]
  fn root_page_filter_reimports_trashed_pages() {
    let trashed_doc_id = Uuid::new_v4().to_string();
    let root_update = root_doc_update_with_trashed_page(&trashed_doc_id, "Hidden seed page");

    let filtered = filter_existing_root_pages(
      &[root_update],
      &[(trashed_doc_id.clone(), "Visible seed page".to_string())],
    )
    .expect("root page filter");

    assert_eq!(
      filtered,
      vec![(trashed_doc_id, "Visible seed page".to_string())],
      "a trashed root entry is not visible in the browser and must be repaired by import"
    );
  }

  fn root_doc_update_with_trashed_page(page_id: &str, title: &str) -> Vec<u8> {
    let doc = yrs::Doc::new();
    let meta = doc.get_or_insert_map("meta");
    let mut txn = doc.transact_mut();
    meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
    let pages_arr = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => panic!("could not create root pages array"),
    };
    pages_arr.push_back(
      &mut txn,
      yrs::MapPrelim::from([
        ("id".to_string(), Any::String(page_id.to_string().into())),
        ("title".to_string(), Any::String(title.to_string().into())),
        ("trash".to_string(), Any::Bool(true)),
      ]),
    );
    txn.encode_update_v1()
  }

  #[test]
  fn complex_seed_fixtures_are_structurally_rich_and_convertible() {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("../../..")
      .join("build/fixtures/seed-documents/complex");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&fixture_dir)
      .expect("complex seed fixture dir")
      .map(|entry| entry.expect("fixture entry").path())
      .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
      .collect();
    files.sort();

    assert_eq!(
      files.len(),
      5,
      "the local-dev seed must keep five complex fixture documents"
    );

    let mut total_h4 = 0usize;
    let mut total_h5 = 0usize;
    let mut total_h6 = 0usize;
    let mut word_counts = Vec::new();
    let mut image_counts = Vec::new();

    for path in files {
      let content = std::fs::read_to_string(&path).expect("fixture content");
      let title = extract_title(&content, &path);
      let word_count = content.split_whitespace().count();
      let image_count = content.matches("data:image/").count();

      for marker in ["# ", "## ", "### ", "#### ", "##### ", "###### "] {
        assert!(
          content.lines().any(|line| line.starts_with(marker)),
          "{} must contain heading marker {marker}",
          path.display()
        );
      }
      assert!(
        content.contains("| ---"),
        "{} must contain a markdown table",
        path.display()
      );
      assert!(
        content.contains("- ") || content.contains("- ["),
        "{} must contain a bullet list",
        path.display()
      );
      assert!(
        content.contains("1. "),
        "{} must contain an ordered list",
        path.display()
      );
      assert!(
        content.contains("data:image/svg+xml"),
        "{} must contain an SVG image",
        path.display()
      );
      assert!(
        content.contains("data:image/png"),
        "{} must contain a PNG image",
        path.display()
      );
      assert!(
        content.contains("**"),
        "{} must contain bold formatting",
        path.display()
      );
      assert!(
        has_italic_emphasis(&content),
        "{} must contain italic emphasis",
        path.display()
      );
      assert!(
        content.contains("```"),
        "{} must contain a fenced code block",
        path.display()
      );

      total_h4 += content.lines().filter(|line| line.starts_with("#### ")).count();
      total_h5 += content.lines().filter(|line| line.starts_with("##### ")).count();
      total_h6 += content.lines().filter(|line| line.starts_with("###### ")).count();
      word_counts.push(word_count);
      image_counts.push(image_count);

      let yjs_data = myoxus_application::markdown::markdown_to_yjs(&title, &content).expect("fixture converts to yjs");
      assert!(
        yjs_data.len() > 1_000,
        "{} should produce a non-trivial Yjs payload",
        path.display()
      );
    }

    assert!(total_h4 >= 10, "fixture set must include at least ten H4 headings");
    assert!(total_h5 >= 10, "fixture set must include at least ten H5 headings");
    assert!(total_h6 >= 10, "fixture set must include at least ten H6 headings");
    assert!(
      word_counts.iter().copied().min().unwrap_or_default() <= 550,
      "fixture set must include a deliberately shorter document"
    );
    assert!(
      word_counts.iter().copied().max().unwrap_or_default() >= 1_800,
      "fixture set must include a deliberately long, text-heavy document"
    );
    assert!(
      image_counts.iter().copied().max().unwrap_or_default() >= 8,
      "fixture set must include a graphics-heavy document"
    );
  }

  /// Create a pool, a test user, a test workspace, and a membership.
  /// Returns (pool, user_id, workspace_id). Caller must call `cleanup()`.
  async fn setup_test_env() -> (PgPool, Uuid, Uuid) {
    let pool = PgPoolOptions::new()
      .max_connections(2)
      .connect(&test_db_url())
      .await
      .expect("Cannot connect to test DB — is Postgres running?");

    myoxus_infrastructure::migrations::run(&pool)
      .await
      .expect("migrations failed");

    let user_id = Uuid::new_v4();
    let ws_id = Uuid::new_v4();
    let ws_name = format!("test-import-{}", ws_id.simple());

    // Create user
    sqlx::query(
      "INSERT INTO users (id, name, email, email_verified_at, created_at, updated_at)
             VALUES ($1, 'Test Importer', $2, NOW(), NOW(), NOW())",
    )
    .bind(user_id)
    .bind(format!("test-import-{}@example.test", user_id.simple()))
    .execute(&pool)
    .await
    .unwrap();

    // Create workspace
    sqlx::query(
      "INSERT INTO workspaces (id, owner_user_id, name, public, created_at, updated_at)
             VALUES ($1, $2, $3, false, NOW(), NOW())",
    )
    .bind(ws_id)
    .bind(user_id)
    .bind(&ws_name)
    .execute(&pool)
    .await
    .unwrap();

    // Create membership
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
             VALUES ($1, $2, 'Collaborator', 'Accepted', NOW(), NOW())",
    )
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();

    (pool, user_id, ws_id)
  }

  async fn cleanup(pool: &PgPool, user_id: Uuid, ws_id: Uuid) {
    sqlx::query("DELETE FROM blobs WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup blobs");
    sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup workspace storage stats");
    sqlx::query("DELETE FROM search_content WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup search content");
    sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup doc updates");
    sqlx::query("DELETE FROM doc_snapshots WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup doc snapshots");
    sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup docs");
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup workspace memberships");
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(ws_id)
      .execute(pool)
      .await
      .expect("cleanup workspace");
    sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(user_id)
      .execute(pool)
      .await
      .expect("cleanup user");
  }

  fn temp_md(content: &str) -> NamedTempFile {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(content.as_bytes()).unwrap();
    f.flush().unwrap();
    f
  }

  fn test_blob_service(_pool: &PgPool) -> (TempDir, Arc<StorageAdapter>) {
    let dir = TempDir::new().expect("temp blob storage dir");
    let service = import_blob_storage(dir.path()).expect("test blob service");
    (dir, service)
  }

  fn has_italic_emphasis(content: &str) -> bool {
    has_single_delimiter_emphasis(content, b'*') || has_single_delimiter_emphasis(content, b'_')
  }

  fn has_single_delimiter_emphasis(content: &str, delimiter: u8) -> bool {
    let bytes = content.as_bytes();
    for start in 0..bytes.len() {
      if bytes[start] != delimiter {
        continue;
      }
      if start > 0 && bytes[start - 1] == delimiter {
        continue;
      }
      if bytes.get(start + 1) == Some(&delimiter) {
        continue;
      }
      for end in start + 2..bytes.len() {
        if bytes[end] != delimiter {
          continue;
        }
        if bytes.get(end + 1) == Some(&delimiter) {
          continue;
        }
        if end > 0 && bytes[end - 1] == delimiter {
          continue;
        }
        return true;
      }
    }
    false
  }

  // --- Test 1: single file creates doc + doc_update ---

  #[tokio::test]
  async fn inv_import_single_md_creates_doc_and_update() {
    let (pool, uid, wsid) = setup_test_env().await;
    let f = temp_md("# Hello\n\nSome content here.");

    let res = import_single_file(&f.path().to_path_buf(), wsid, uid, false, None, &pool, None).await;
    assert!(res.is_ok());
    let (doc_id, title) = res.unwrap().expect("should return Some");
    assert_eq!(title, "Hello");

    let doc_count: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(doc_id)
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(doc_count, 1);

    let upd_count: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(upd_count, 1);

    let audit = sqlx::query(
      "SELECT actor_user_id, provenance_mode, resolution_kind, decision_code \
       FROM document_initial_sync_audit WHERE doc_id = $1",
    )
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("initial import audit row");
    let actor_user_id: Uuid = audit.get("actor_user_id");
    let provenance_mode: String = audit.get("provenance_mode");
    let resolution_kind: String = audit.get("resolution_kind");
    let decision_code: String = audit.get("decision_code");
    assert_eq!(actor_user_id, uid);
    assert_eq!(provenance_mode, "explicit_import");
    assert_eq!(resolution_kind, "created");
    assert_eq!(decision_code, "client_provenance_applied");

    cleanup(&pool, uid, wsid).await;
  }

  // --- Test 2: title extraction ---

  #[tokio::test]
  async fn inv_import_title_extraction() {
    let with_h1 = extract_title("# My Title\n\nBody", &PathBuf::from("fallback.md"));
    assert_eq!(with_h1, "My Title");

    let no_heading = extract_title("Just text\nMore text", &PathBuf::from("notes.md"));
    assert_eq!(no_heading, "notes");

    let h2_only = extract_title("## Subtitle\nBody", &PathBuf::from("sub.md"));
    assert_eq!(h2_only, "sub");
  }

  // --- Test 3: multiple files → multiple docs ---

  #[tokio::test]
  async fn inv_import_multiple_files() {
    let (pool, uid, wsid) = setup_test_env().await;
    let f1 = temp_md("# Page One\nContent 1");
    let f2 = temp_md("# Page Two\nContent 2");
    let f3 = temp_md("# Page Three\nContent 3");

    for f in [&f1, &f2, &f3] {
      import_single_file(&f.path().to_path_buf(), wsid, uid, false, None, &pool, None)
        .await
        .unwrap();
    }

    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1 AND NOT is_workspace_root")
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(count, 3);

    cleanup(&pool, uid, wsid).await;
  }

  #[tokio::test]
  async fn inv_import_nonexistent_file_rejected_before_database_access() {
    let pool = PgPoolOptions::new()
      .connect_lazy(&test_db_url())
      .expect("lazy test pool");
    let directory = tempfile::tempdir().expect("missing-source fixture");
    let path = directory.path().join("missing.md");
    let res = import_single_file(&path, Uuid::new_v4(), Uuid::new_v4(), false, None, &pool, None).await;
    assert!(
      res.is_err(),
      "source capture must fail instead of reporting a successful empty import"
    );
  }

  // --- Test 5: non-member → rejected ---

  #[tokio::test]
  async fn inv_import_non_member_rejected() {
    let (pool, uid, wsid) = setup_test_env().await;
    let stranger_id = Uuid::new_v4();

    let err = check_membership(&pool, wsid, stranger_id).await;
    assert!(err.is_err());
    assert!(err.unwrap_err().to_string().contains("not a member"));

    cleanup(&pool, uid, wsid).await;
  }

  // --- Test 6: dry-run → no DB rows ---

  #[tokio::test]
  async fn inv_import_dry_run_no_db_changes() {
    let (pool, uid, wsid) = setup_test_env().await;
    let f = temp_md("# Dry Run Test\nShould not be persisted.");

    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .unwrap();

    let res = import_single_file(&f.path().to_path_buf(), wsid, uid, true, None, &pool, None).await;
    assert!(res.is_ok());
    let (doc_id, title) = res.unwrap().expect("dry-run returns Some");
    assert_eq!(title, "Dry Run Test");
    assert_eq!(doc_id, Uuid::nil(), "dry-run doc_id should be nil UUID");

    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(before, after, "dry-run must not create DB rows");

    cleanup(&pool, uid, wsid).await;
  }

  // --- Test 7: Yjs payload is valid and non-trivial ---

  #[tokio::test]
  async fn inv_import_yjs_payload_valid() {
    let (pool, uid, wsid) = setup_test_env().await;
    let md = "# Roundtrip\n\nHello world.\n\n- Item A\n- Item B\n";
    let f = temp_md(md);

    let res = import_single_file(&f.path().to_path_buf(), wsid, uid, false, None, &pool, None)
      .await
      .unwrap()
      .unwrap();
    let doc_id = res.0;

    let payload: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();

    assert!(
      payload.len() > 100,
      "Yjs payload should be non-trivial ({} bytes)",
      payload.len()
    );

    // Verify it's a valid Yjs v1 update by decoding
    let update = yrs::Update::decode_v1(&payload);
    assert!(update.is_ok(), "payload must be a valid Yjs v1 update");

    cleanup(&pool, uid, wsid).await;
  }

  #[tokio::test]
  async fn inv_register_root_doc_uses_snapshot_base_and_snapshot_safe_sequence() {
    let (pool, uid, wsid) = setup_test_env().await;
    let existing_id = Uuid::new_v4().to_string();
    let new_id = Uuid::new_v4();
    let initial = yjs::create_initial_workspace_doc("Compacted root workspace");
    let existing_page_update = yjs::add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[(existing_id.clone(), "Existing snapshot page".to_string())],
    )
    .expect("existing root page update");
    let snapshot_payload =
      yjs::merge_updates(vec![initial, existing_page_update]).expect("snapshot root payload merges");

    sqlx::query(
      "INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
       VALUES ($1, $1, 'Compacted root workspace', true, $2, $2)",
    )
    .bind(wsid)
    .bind(uid)
    .execute(&pool)
    .await
    .expect("insert root doc row");

    sqlx::query(
      "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
       VALUES ($1, $1, $2, 50, NOW())",
    )
    .bind(wsid)
    .bind(snapshot_payload)
    .execute(&pool)
    .await
    .expect("insert compacted root snapshot");

    sqlx::query(
      "INSERT INTO docs
         (id, workspace_id, title, created_by, updated_by, created_at, updated_at)
       VALUES
         ($1, $2, 'New seed page', $3, $3,
          '2026-09-20T10:11:12.000Z', '2026-09-21T12:13:14.000Z')",
    )
    .bind(new_id)
    .bind(wsid)
    .bind(uid)
    .execute(&pool)
    .await
    .expect("insert imported document row");

    let registered = register_in_root_doc(&pool, wsid, &[(new_id, "New seed page".to_string())])
      .await
      .expect("register page in compacted root");
    assert_eq!(registered, 1);

    let root_update = sqlx::query(
      "SELECT sequence, payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1 ORDER BY sequence DESC LIMIT 1",
    )
    .bind(wsid)
    .fetch_one(&pool)
    .await
    .expect("root update after registration");
    let sequence: i64 = root_update.get("sequence");
    assert!(
      sequence > 50,
      "root registration update must be above compacted snapshot last_sequence; got {sequence}"
    );

    let root_parts: Vec<Vec<u8>> = sqlx::query_scalar(
      "SELECT payload
         FROM (
           SELECT 0::BIGINT AS ord, payload
             FROM doc_snapshots
            WHERE workspace_id = $1
              AND doc_id = $1
           UNION ALL
           SELECT sequence AS ord, payload
             FROM doc_updates
            WHERE workspace_id = $1
              AND doc_id = $1
              AND sequence > 50
         ) root_parts
        ORDER BY ord ASC",
    )
    .bind(wsid)
    .fetch_all(&pool)
    .await
    .expect("load compacted root plus tail");
    let merged = yjs::merge_updates(root_parts).expect("merged compacted root plus tail");
    let root_pages = yjs::extract_page_trash_state(&merged).expect("extract root pages");
    let root_ids: HashSet<String> = root_pages.into_iter().map(|page| page.id).collect();
    assert!(root_ids.contains(&existing_id));
    assert!(root_ids.contains(&new_id.to_string()));
    assert_eq!(
      root_page_timestamps(&merged, new_id),
      (1_789_899_072_000, 1_789_992_794_000),
      "CLI registration must make server-created documents exportable by the Web snapshot adapter"
    );

    let duplicate = register_in_root_doc(&pool, wsid, &[(new_id, "New seed page duplicate".to_string())])
      .await
      .expect("duplicate registration check");
    assert_eq!(duplicate, 0, "snapshot-backed root dedupe must prevent duplicate pages");

    cleanup(&pool, uid, wsid).await;
  }

  #[tokio::test]
  async fn inv_import_materializes_data_image_markdown_as_blob_backed_image() {
    let (pool, uid, wsid) = setup_test_env().await;
    let (_storage_dir, blob_service) = test_blob_service(&pool);
    let md =
      "# Asset Import\n\n![Inline SVG](DATA:IMAGE/SVG+XML,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E)\n";
    let f = temp_md(md);

    let (doc_id, _) = import_single_file(
      &f.path().to_path_buf(),
      wsid,
      uid,
      false,
      Some("manual-test-complex-v1"),
      &pool,
      Some(blob_service.as_ref()),
    )
    .await
    .unwrap()
    .unwrap();

    let payload: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    let extracted = myoxus_application::markdown::yjs_to_markdown(&payload)
      .expect("imported yjs extracts")
      .expect("imported yjs has Markdown");
    assert!(
      !extracted.markdown.contains("data:image/"),
      "imported document must not keep data URLs in Yjs markdown projection:\n{}",
      extracted.markdown
    );
    assert!(
      extracted
        .markdown
        .contains(&format!("![Inline SVG](markdown-import/{doc_id}/")),
      "imported image source must be rewritten to a blob key:\n{}",
      extracted.markdown
    );

    let blob_row = sqlx::query("SELECT key, mime, status, size FROM blobs WHERE workspace_id = $1")
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .unwrap();
    let blob_key: String = blob_row.get("key");
    let mime: String = blob_row.get("mime");
    let status: String = blob_row.get("status");
    let size: i64 = blob_row.get("size");
    assert!(blob_key.starts_with(&format!("markdown-import/{doc_id}/")));
    assert!(blob_key.ends_with(".svg"));
    assert_eq!(mime, "image/svg+xml");
    assert_eq!(status, "completed");
    assert!(size > 0);

    let stored = blob_service.read_blob(&format!("{wsid}/{blob_key}")).await.unwrap();
    assert!(String::from_utf8(stored.data.to_vec()).unwrap().contains("<svg"));

    let ir =
      myoxus_public_render::document_from_yjs(wsid, doc_id, "Asset Import", "Page", &payload).expect("public ir");
    assert_eq!(ir.document.assets.len(), 1);
    assert_eq!(ir.document.assets[0].source, blob_key);

    cleanup(&pool, uid, wsid).await;
  }

  #[tokio::test]
  async fn definition_asset_commit_failure_preserves_existing_parent_and_bytes() {
    let (pool, uid, wsid) = setup_test_env().await;
    let (_storage_dir, storage) = test_blob_service(&pool);
    let trigger = format!("md_footnote_commit_{}", wsid.simple());
    let journey_pool = pool.clone();
    let journey_trigger = trigger.clone();
    let journey = tokio::spawn(async move {
      let pool = journey_pool;
      let first = "data:image/svg+xml,%3Csvg%3Eold%3C/svg%3E";
      let second = "data:image/svg+xml,%3Csvg%3Enew%3C/svg%3E";
      let original = format!("# Parent\n\nReference[^body]\n\n[^body]: ![existing]({first})\n");
      let file = temp_md(&original);
      let path = file.path().to_path_buf();
      let (id, _) = import_single_file(
        &path,
        wsid,
        uid,
        false,
        Some("footnote-assets"),
        &pool,
        Some(storage.as_ref()),
      )
      .await
      .unwrap()
      .unwrap();
      let payload_before: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
      let old = prepare_markdown_data_images(&original, id).unwrap();
      let old_key = format!("{wsid}/{}", old.writes[0].metadata.blob_key);
      let before = storage.read_blob(&old_key).await.unwrap().data;
      let updated = format!(
        "# Parent\n\nReference[^body] and repeated[^body]\n\n[^body]: ![existing]({first})\n\n    ![new]({second})\n"
      );
      std::fs::write(&path, &updated).unwrap();
      let prepared = prepare_markdown_data_images(&updated, id).unwrap();
      let new_key = format!(
        "{wsid}/{}",
        prepared
          .writes
          .iter()
          .find(|asset| asset.bytes.as_ref() == b"<svg>new</svg>")
          .unwrap()
          .metadata
          .blob_key
      );
      // Fail only this fixture, after storage writes at the SQL COMMIT boundary.
      sqlx::raw_sql(&format!("CREATE FUNCTION {journey_trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{wsid}' THEN RAISE EXCEPTION 'forced footnote asset commit failure'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER {journey_trigger} AFTER INSERT ON doc_updates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {journey_trigger}();"))
        .execute(&pool).await.unwrap();
      let error = import_single_file(
        &path,
        wsid,
        uid,
        false,
        Some("footnote-assets"),
        &pool,
        Some(storage.as_ref()),
      )
      .await
      .expect_err("commit must fail after the new object was written");
      assert!(error.to_string().contains("forced footnote asset commit failure"));
      assert_eq!(
        storage.read_blob(&old_key).await.unwrap().data,
        before,
        "pre-existing bytes are never compensation-owned"
      );
      assert!(
        matches!(storage.read_blob(&new_key).await, Err(PortError::NotFound(_))),
        "failed publication must remove only its new object"
      );
      let payload_after: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
      assert_eq!(
        payload_after, payload_before,
        "failed refresh restores the actual parent snapshot/tail"
      );
      let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root), (SELECT count(*) FROM blobs WHERE workspace_id=$1), (SELECT count(*) FROM document_initial_sync_audit WHERE workspace_id=$1)")
        .bind(wsid).fetch_one(&pool).await.unwrap();
      assert_eq!(
        counts,
        (1, 1, 1),
        "the definition has no separate document or audit identity"
      );
    });
    let result = journey.await;
    sqlx::raw_sql(&format!(
      "DROP TRIGGER IF EXISTS {trigger} ON doc_updates; DROP FUNCTION IF EXISTS {trigger}();"
    ))
    .execute(&pool)
    .await
    .expect("remove only the fixture's deferred trigger");
    cleanup(&pool, uid, wsid).await;
    result.expect("definition asset commit failure journey");
  }

  #[tokio::test]
  async fn unsupported_html_fails_before_document_or_data_image_blob_write() {
    let (pool, uid, wsid) = setup_test_env().await;
    let (storage_dir, blob_service) = test_blob_service(&pool);
    let f = temp_md(
      "![data](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E)\n\n<div data-secret='hidden'>unsupported</div>",
    );
    let docs_before: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .expect("document count before rejected import");

    let error = import_single_file(
      &f.path().to_path_buf(),
      wsid,
      uid,
      false,
      None,
      &pool,
      Some(blob_service.as_ref()),
    )
    .await
    .expect_err("raw HTML import must fail");
    assert!(error.to_string().contains("unsupported raw HTML in Markdown"));
    assert!(!error.to_string().contains("hidden"));

    let docs_after: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .expect("document count after rejected import");
    let blob_count: i64 = sqlx::query_scalar("SELECT count(*) FROM blobs WHERE workspace_id = $1")
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .expect("blob count after rejected import");
    assert_eq!(docs_after, docs_before, "rejected import must not create a document");
    assert_eq!(blob_count, 0, "rejected import must not register a blob");
    assert_eq!(
      std::fs::read_dir(storage_dir.path()).expect("read blob root").count(),
      0,
      "rejected import must not write blob bytes"
    );

    cleanup(&pool, uid, wsid).await;
  }

  #[tokio::test]
  async fn inv_seed_import_is_idempotent_for_same_workspace_and_file() {
    let (pool, uid, wsid) = setup_test_env().await;
    let f = temp_md("# Seeded fixture\n\nRepeated imports must keep one document.");
    let path = f.path().to_path_buf();

    let first = import_single_file(&path, wsid, uid, false, Some("manual-test-complex-v1"), &pool, None)
      .await
      .unwrap()
      .unwrap();
    let second = import_single_file(&path, wsid, uid, false, Some("manual-test-complex-v1"), &pool, None)
      .await
      .unwrap()
      .unwrap();

    assert_eq!(first.0, second.0);

    let doc_count: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(first.0)
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(doc_count, 1);

    let update_count: i64 =
      sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1 AND workspace_id = $2")
        .bind(first.0)
        .bind(wsid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(update_count, 1);

    let hash: Option<String> = sqlx::query_scalar("SELECT meta->>'seed_content_hash' FROM docs WHERE id = $1")
      .bind(first.0)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(
      hash.as_deref(),
      Some(seed_content_hash("# Seeded fixture\n\nRepeated imports must keep one document.").as_str())
    );
    let version: Option<i32> = sqlx::query_scalar("SELECT (meta->>'seed_version')::int FROM docs WHERE id = $1")
      .bind(first.0)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(version, Some(COMPLEX_SEED_DOCUMENT_VERSION));

    cleanup(&pool, uid, wsid).await;
  }

  #[tokio::test]
  async fn inv_seed_import_refreshes_changed_fixture_content_without_duplicates() {
    let (pool, uid, wsid) = setup_test_env().await;
    let f = temp_md("# Seeded fixture\n\nOld content.");
    let path = f.path().to_path_buf();

    let first = import_single_file(&path, wsid, uid, false, Some("manual-test-complex-v1"), &pool, None)
      .await
      .unwrap()
      .unwrap();
    std::fs::write(
      &path,
      "# Seeded fixture\n\nNew content with searchable marker refreshed-fixture.",
    )
    .unwrap();
    let second = import_single_file(&path, wsid, uid, false, Some("manual-test-complex-v1"), &pool, None)
      .await
      .unwrap()
      .unwrap();

    assert_eq!(first.0, second.0);

    let doc_count: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(first.0)
      .bind(wsid)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(doc_count, 1);

    let update_count: i64 =
      sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1 AND workspace_id = $2")
        .bind(first.0)
        .bind(wsid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(update_count, 1);

    let plain_text: String = sqlx::query_scalar("SELECT meta->>'plain_text' FROM docs WHERE id = $1")
      .bind(first.0)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert!(plain_text.contains("refreshed-fixture"));

    let hash: Option<String> = sqlx::query_scalar("SELECT meta->>'seed_content_hash' FROM docs WHERE id = $1")
      .bind(first.0)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(
      hash.as_deref(),
      Some(seed_content_hash("# Seeded fixture\n\nNew content with searchable marker refreshed-fixture.").as_str())
    );
    let version: Option<i32> = sqlx::query_scalar("SELECT (meta->>'seed_version')::int FROM docs WHERE id = $1")
      .bind(first.0)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(version, Some(COMPLEX_SEED_DOCUMENT_VERSION));

    cleanup(&pool, uid, wsid).await;
  }

  #[tokio::test]
  async fn inv_seed_import_refreshes_same_content_when_seed_version_changes() {
    let (pool, uid, wsid) = setup_test_env().await;
    let f = temp_md("# Seeded fixture\n\nSame content should refresh when the importer format changes.");
    let path = f.path().to_path_buf();

    let first = import_single_file(&path, wsid, uid, false, Some("manual-test-complex-v1"), &pool, None)
      .await
      .unwrap()
      .unwrap();

    sqlx::query(
      r#"
        UPDATE docs
           SET meta = jsonb_set(
             jsonb_set(meta, '{seed_version}', '2'::jsonb),
             '{plain_text}',
             to_jsonb('stale plain text from previous seed format'::text)
           )
         WHERE id = $1
           AND workspace_id = $2
      "#,
    )
    .bind(first.0)
    .bind(wsid)
    .execute(&pool)
    .await
    .unwrap();

    let second = import_single_file(&path, wsid, uid, false, Some("manual-test-complex-v1"), &pool, None)
      .await
      .unwrap()
      .unwrap();

    assert_eq!(first.0, second.0);

    let update_count: i64 =
      sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1 AND workspace_id = $2")
        .bind(first.0)
        .bind(wsid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(update_count, 1);

    let plain_text: String = sqlx::query_scalar("SELECT meta->>'plain_text' FROM docs WHERE id = $1")
      .bind(first.0)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert!(plain_text.contains("Same content should refresh"));
    assert!(!plain_text.contains("stale plain text"));

    let version: Option<i32> = sqlx::query_scalar("SELECT (meta->>'seed_version')::int FROM docs WHERE id = $1")
      .bind(first.0)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(version, Some(COMPLEX_SEED_DOCUMENT_VERSION));

    cleanup(&pool, uid, wsid).await;
  }

  // --- Test 8: CLI-RV-03c: DB failure in membership check propagates as error ---

  #[tokio::test]
  async fn inv_cli_rv03c_db_failure_propagates_not_masked() {
    // Connect to a real pool, then close it to simulate DB failure.
    let pool = PgPoolOptions::new()
      .max_connections(1)
      .connect(&test_db_url())
      .await
      .expect("Cannot connect to test DB");

    // Close the pool — all subsequent queries will fail with a pool error.
    pool.close().await;

    let ws_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();

    let result = check_membership(&pool, ws_id, user_id).await;

    // The critical assertion: a closed-pool error must propagate as Err,
    // NOT be silently converted to "not a member" (the old unwrap_or(false) bug).
    assert!(result.is_err(), "DB failure must propagate as Err");
    let msg = result.unwrap_err().to_string();
    assert!(
      msg.contains("Database error"),
      "error must be a DB error, not 'not a member'; got: {msg}"
    );
    assert!(
      !msg.contains("not a member"),
      "DB failure must NOT be masked as 'not a member'; got: {msg}"
    );
  }
}
