// SPDX-License-Identifier: AGPL-3.0-or-later
//! `export-docs` subcommand using the canonical Git-Sync projection.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use anyhow::Context;
use clap::{Args, ValueEnum};
use myoxus_application::git_sync::export::{
  ExportFrontmatter, GIT_SYNC_MANIFEST_PATH, GitSyncManifest, GitSyncManifestDocument, PathPlanDocument,
  compose_markdown_file, paths_by_document, plan_document_paths,
};
use myoxus_application::git_sync::projection;
use myoxus_application::markdown::{
  AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument, MarkdownBatchReferenceInventory,
  MarkdownProjectionPolicy, project_document_in_batch_with_images,
};
use myoxus_application::organizer::OrganizerService;
use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::services::Services;

#[derive(Args)]
pub struct ExportDocsArgs {
  #[arg(long, group = "ws_target")]
  pub workspace: Option<Uuid>,

  #[arg(long, group = "ws_target")]
  pub workspace_name: Option<String>,

  #[arg(long, short = 'o')]
  pub output: Option<PathBuf>,

  /// Export target. The established Git-oriented directory export remains the default.
  #[arg(long, value_enum, default_value_t = ExportDocsFormat::Git)]
  pub format: ExportDocsFormat,

  /// Authorized workspace reader. Required only for `--format obsidian`.
  #[arg(long)]
  pub actor_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ExportDocsFormat {
  Git,
  Obsidian,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportItem {
  object_id: Uuid,
  path: String,
  content_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportIssue {
  object_id: Uuid,
  reason_code: &'static str,
  detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
  workspace_id: Uuid,
  output_directory: String,
  manifest_path: String,
  exported: Vec<ExportItem>,
  skipped: Vec<ExportIssue>,
  failed: Vec<ExportIssue>,
}

struct ConvertedDocument {
  doc_id: Uuid,
  external_id: String,
  sync_id: Uuid,
  title: String,
  payload: Vec<u8>,
  organizer_entry_id: Option<String>,
  organizer_folder_ids: Vec<String>,
  folder_names: Vec<String>,
  updated_at: chrono::DateTime<chrono::Utc>,
}

struct ExistingDocumentBinding {
  sync_id: Uuid,
  repo_path: String,
}

pub async fn run(args: ExportDocsArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = resolve_workspace(&svc.pool, &args).await?;
  if args.format == ExportDocsFormat::Obsidian {
    let actor_id = args.actor_id.context("--actor-id is required for --format obsidian")?;
    let artifact = svc.workspace_export()?.export(actor_id, workspace_id).await?;
    let output = args.output.unwrap_or_else(|| PathBuf::from(&artifact.filename));
    std::fs::write(&output, &artifact.bytes)
      .with_context(|| format!("write Obsidian vault export {}", output.display()))?;
    if json {
      println!(
        "{}",
        serde_json::json!({
          "workspaceId": workspace_id,
          "output": output,
          "sizeBytes": artifact.bytes.len(),
          "report": artifact.report,
        })
      );
    } else {
      println!("Exported Obsidian vault to {}", output.display());
    }
    return Ok(());
  }
  let workspace_name = get_workspace_name(&svc.pool, workspace_id).await?;
  let output_dir = args.output.unwrap_or_else(|| PathBuf::from(&workspace_name));
  let (profile_id, root_path, manifest_path) = effective_profile_root(&svc.pool, workspace_id).await?;
  let observed = if output_dir.exists() {
    crate::git_sync::read_worktree(&output_dir)?
  } else {
    BTreeMap::new()
  };
  eprintln!(
    "Exporting workspace {workspace_name} ({workspace_id}) to {}",
    output_dir.display()
  );
  let prepared = prepare_git_export(svc, workspace_id, profile_id, &root_path, &manifest_path, &observed).await?;
  std::fs::create_dir_all(&output_dir)?;
  for path in &prepared.retired {
    let destination = output_dir.join(path);
    if destination.is_file() {
      std::fs::remove_file(destination)?;
    }
  }
  let mut failed = prepared.failed;
  let load_failures = failed.len();
  let mut exported = Vec::new();
  // Ordinary write failures keep their existing per-document JSON result. Do
  // not advertise a new manifest/README batch containing a failed destination.
  for document in &prepared.manifest.documents {
    let output = output_dir.join(&document.repo_path);
    let result = (|| -> std::io::Result<()> {
      if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
      }
      std::fs::write(&output, &prepared.files[&document.repo_path])
    })();
    match result {
      Ok(()) => exported.push(ExportItem {
        object_id: document.doc_id,
        path: document.repo_path.clone(),
        content_hash: document.content_hash.clone(),
      }),
      Err(error) => failed.push(ExportIssue {
        object_id: document.doc_id,
        reason_code: "OUTPUT_WRITE_FAILED",
        detail: format!("{}: {error}", output.display()),
      }),
    }
  }
  if failed.len() == load_failures {
    for (path, bytes) in &prepared.files {
      if path == &manifest_path || prepared.manifest.documents.iter().any(|doc| doc.repo_path == *path) {
        continue;
      }
      let destination = output_dir.join(path);
      if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
      }
      std::fs::write(destination, bytes)?;
    }
    let control = output_dir.join(&manifest_path);
    std::fs::create_dir_all(control.parent().expect("manifest parent"))?;
    std::fs::write(control, &prepared.files[&manifest_path])?;
  }
  let result = ExportResult {
    workspace_id,
    output_directory: output_dir.display().to_string(),
    manifest_path: manifest_path.clone(),
    exported,
    skipped: Vec::new(),
    failed,
  };
  if json {
    println!("{}", serde_json::to_string(&result)?);
  } else {
    println!(
      "Exported {} document(s), skipped {}, failed {}. Manifest: {}",
      result.exported.len(),
      result.skipped.len(),
      result.failed.len(),
      output_dir.join(&manifest_path).display()
    );
  }
  if !result.failed.is_empty() {
    anyhow::bail!("{} document export(s) failed", result.failed.len());
  }
  Ok(())
}

pub(crate) struct PreparedGitExport {
  pub manifest: GitSyncManifest,
  pub files: BTreeMap<String, Vec<u8>>,
  pub documents: Vec<myoxus_application::git_sync::bootstrap::BootstrapDocument>,
  pub retired: Vec<String>,
  failed: Vec<ExportIssue>,
}
impl PreparedGitExport {
  pub fn ensure_complete(&self) -> anyhow::Result<()> {
    anyhow::ensure!(
      self.failed.is_empty(),
      "{} document projection(s) failed",
      self.failed.len()
    );
    Ok(())
  }
}

/// One native batch for both directory export and the disabled-profile bootstrap.
/// The profile/root and observed tree are explicit, never inferred by bootstrap
/// from another enabled profile belonging to the workspace.
pub(crate) async fn prepare_git_export(
  svc: &Services,
  workspace_id: Uuid,
  profile_id: Option<Uuid>,
  root_path: &str,
  manifest_path: &str,
  observed: &BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<PreparedGitExport> {
  let mut scope = myoxus_application::git_sync::export::GitSyncWriterScope::new(Vec::new());
  if let Some(profile_id) = profile_id {
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(svc.pool.clone());
    let profile = store.get_profile(profile_id).await?;
    if profile.workspace_id != workspace_id || profile.manifest_path != manifest_path || profile.root_path != root_path
    {
      anyhow::bail!("Git-Sync export scope changed; repeat with current profile");
    }
    store.assert_profile_scope_unambiguous(&profile).await?;
    store.assert_bound_documents_in_workspace(&profile).await?;
    store.assert_bound_files_in_workspace(&profile).await?;
    scope = store.writer_scope(&profile).await?;
  }
  let organizer = OrganizerService::new(svc.doc.clone())
    .snapshot(workspace_id)
    .await
    .map_err(|error| anyhow::anyhow!("load Organizer snapshot: {error}"))?;
  let workspace_name = get_workspace_name(&svc.pool, workspace_id).await?;
  let rows = load_exportable_document_rows(&svc.pool, workspace_id).await?;
  let authorized_documents = rows
    .iter()
    .map(|(_, external_id, title, _)| AuthorizedMarkdownDocument {
      external_id: external_id.clone(),
      title: title.clone(),
    })
    .collect::<Vec<_>>();
  let document_ids_by_external_key = rows
    .iter()
    .map(|(doc_id, external_id, _, _)| (external_id.clone(), *doc_id))
    .collect();
  let organizer_projection = projection::project_organizer(&organizer, &document_ids_by_external_key);
  let existing_bindings = load_existing_document_bindings(&svc.pool, profile_id).await?;
  let mut occupied_paths = load_file_path_owners(&svc.pool, profile_id).await?;
  let previous = observed
    .get(manifest_path)
    .map(|bytes| serde_json::from_slice::<GitSyncManifest>(bytes))
    .transpose()?
    .map(|manifest| scope.owned_manifest(&manifest))
    .transpose()?;
  let owned_observed = observed
    .iter()
    .filter_map(|(path, bytes)| match scope.excludes(path) {
      Ok(false) => Some(Ok((path.clone(), bytes.clone()))),
      Ok(true) => None,
      Err(error) => Some(Err(error)),
    })
    .collect::<Result<BTreeMap<_, _>, _>>()?;
  myoxus_application::git_sync::overview::occupy_git_export_files(
    workspace_id,
    &document_ids_by_external_key.values().copied().collect(),
    &mut occupied_paths,
    &owned_observed,
    previous.as_ref(),
  )
  .map_err(anyhow::Error::msg)?;
  // Reserve the fence itself, not every child control file: the portable
  // overview planner rejects .myoxus entries as ordinary output owners.
  for fence in scope.exclusions() {
    occupied_paths.insert(
      fence.repo_path.as_str().to_string(),
      "delegated repository scope".into(),
    );
  }
  let bound_asset_paths = load_asset_paths(&svc.pool, profile_id).await?;

  let mut converted = Vec::with_capacity(rows.len());
  let mut exported_asset_keys = std::collections::BTreeSet::new();
  let mut failed = Vec::new();
  for (doc_id, external_id, database_title, updated_at) in rows {
    let placement = organizer_projection.documents.get(&doc_id).cloned().unwrap_or_default();
    let payload = match svc.doc.load_full_doc(workspace_id, doc_id).await {
      Ok(payload) => payload,
      Err(error) => {
        failed.push(ExportIssue {
          object_id: doc_id,
          reason_code: "CURRENT_DOCUMENT_LOAD_FAILED",
          detail: error.to_string(),
        });
        continue;
      }
    };
    match yjs::extract_portable_asset_references(&payload) {
      Ok(assets) => exported_asset_keys.extend(assets.into_iter().map(|asset| asset.source_key)),
      Err(error) => {
        failed.push(ExportIssue {
          object_id: doc_id,
          reason_code: "YJS_TO_MARKDOWN_FAILED",
          detail: error,
        });
        continue;
      }
    }
    let sync_id = existing_bindings
      .get(&doc_id)
      .map(|binding| binding.sync_id)
      .unwrap_or_else(|| Uuid::new_v5(&workspace_id, format!("git-sync-export:{doc_id}").as_bytes()));
    converted.push(ConvertedDocument {
      doc_id,
      external_id,
      sync_id,
      title: database_title,
      payload,
      organizer_entry_id: placement.organizer_entry_id,
      organizer_folder_ids: placement.folder_ids,
      folder_names: placement.folder_names,
      updated_at,
    });
  }

  let mut export_assets = BTreeMap::new();
  let mut asset_path_owners = std::collections::HashSet::new();
  if !exported_asset_keys.is_empty() {
    let limits = myoxus_workspace_import::WorkspaceImportLimits::default();
    if exported_asset_keys.len() > limits.max_assets {
      anyhow::bail!("Markdown export asset count limit exceeded");
    }
    let blobs = myoxus_application::ports::blob_service::BlobService::new(
      std::sync::Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(svc.pool.clone())),
      svc.blob_storage()?,
      svc.server_origin().to_string(),
    );
    let mut total = 0u64;
    let mut metadata = Vec::new();
    for key in exported_asset_keys {
      let Some(asset) = blobs.get_blob_metadata(workspace_id, &key).await? else {
        // Preserve the existing opaque source contract when no normal metadata exists.
        continue;
      };
      if asset.status != myoxus_application::ports::blob::BlobStatus::Completed || asset.deleted_at.is_some() {
        anyhow::bail!("missing or inaccessible Markdown export asset");
      }
      total = total
        .checked_add(asset.size)
        .context("Markdown export asset size overflow")?;
      if total > limits.max_asset_bytes || asset.size > limits.max_entry_bytes {
        anyhow::bail!("Markdown export asset byte limit exceeded");
      }
      metadata.push((key, asset));
    }
    for (key, asset) in metadata {
      let path = bound_asset_paths
        .get(&key)
        .cloned()
        .map(Ok)
        .unwrap_or_else(|| myoxus_application::git_sync::export::asset_repo_path(root_path, &key, &asset.mime))?;
      myoxus_domain::git_sync::RepoPath::new(path.clone()).map_err(anyhow::Error::msg)?;
      if scope.excludes(&path)? {
        anyhow::bail!("Markdown export asset enters a delegated repository scope");
      }
      if observed
        .get(&path)
        .is_some_and(|existing| !bound_asset_paths.contains_key(&key) && existing.len() as u64 != asset.size)
      {
        anyhow::bail!("Markdown export asset destination is occupied: {path}");
      }
      occupied_paths.insert(path.clone(), format!("asset:{key}"));
      if !asset_path_owners.insert(path.clone()) {
        anyhow::bail!("Markdown export asset path collision");
      }
      let body = blobs.get_blob(workspace_id, &key).await?.data;
      use sha2::Digest;
      if body.len() as u64 != asset.size
        || asset
          .checksum
          .as_ref()
          .is_some_and(|checksum| *checksum != format!("{:x}", sha2::Sha256::digest(&body)))
      {
        anyhow::bail!("Markdown export asset bytes changed");
      }
      if observed
        .get(&path)
        .is_some_and(|existing| !bound_asset_paths.contains_key(&key) && *existing != body)
      {
        anyhow::bail!("Markdown export asset destination is occupied: {path}");
      }
      export_assets.insert(key, (path, body));
    }
  }

  let path_inputs: Vec<PathPlanDocument> = converted
    .iter()
    .map(|document| PathPlanDocument {
      doc_id: document.doc_id,
      title: document.title.clone(),
      folder_names: document.folder_names.clone(),
      existing_repo_path: existing_bindings
        .get(&document.doc_id)
        .map(|binding| binding.repo_path.clone()),
    })
    .collect();
  let paths = paths_by_document(&plan_document_paths(root_path, &path_inputs, &occupied_paths)?);
  for path in paths.values() {
    if scope.excludes(path)? {
      anyhow::bail!("Git-Sync export document enters a delegated repository scope");
    }
  }
  let batch_documents = converted
    .iter()
    .map(|document| AuthorizedMarkdownBatchDocument {
      external_id: document.external_id.clone(),
      title: document.title.clone(),
      path: paths
        .get(&document.doc_id)
        .expect("path planner returns one path for every input")
        .clone(),
    })
    .collect::<Vec<_>>();

  // Serialize the export-only snapshots that contain allocated anchors, not
  // their live originals. Every member shares the same current target inventory.
  let prepared = MarkdownBatchReferenceInventory::new_with_authorized(
    &format!("{}/workspace/{workspace_id}", svc.server_origin().trim_end_matches('/')),
    authorized_documents,
    batch_documents,
  )?
  .prepare_export_snapshots(
    converted
      .iter_mut()
      .map(|document| (document.external_id.clone(), std::mem::take(&mut document.payload)))
      .collect(),
  )?;

  // Resolve all body projections and validate normal asset bytes before delivery.
  let mut projected = std::collections::HashMap::new();
  for document in &converted {
    let repo_path = &paths[&document.doc_id];
    let references = prepared.references.for_source(repo_path)?;
    let projection = project_document_in_batch_with_images(
      &prepared.snapshots[&document.external_id],
      &document.title,
      MarkdownProjectionPolicy::default(),
      &references,
      &|source| {
        match export_assets.get(source) {
          Some((path, _)) => references.resolve_export_asset_path(path),
          // A missing packaging entry is not a missing image: preserve the
          // existing data-URL and opaque-source contract without dropping content.
          None => Some(source.to_owned()),
        }
      },
    )?;
    projected.insert(document.doc_id, projection);
  }
  let mut files = export_assets
    .values()
    .map(|(path, body)| (path.clone(), body.to_vec()))
    .collect::<BTreeMap<_, _>>();
  let mut manifest_documents = Vec::new();
  let mut documents = Vec::new();
  for document in converted {
    let path = &paths[&document.doc_id];
    let materialized = &projected[&document.doc_id];
    files.insert(
      path.clone(),
      compose_markdown_file(
        &ExportFrontmatter {
          sync_id: document.sync_id,
          doc_id: document.doc_id,
          workspace_id,
          title: document.title.clone(),
        },
        &materialized.markdown,
      )
      .into_bytes(),
    );
    manifest_documents.push(GitSyncManifestDocument {
      doc_id: document.doc_id,
      organizer_entry_id: document.organizer_entry_id.clone(),
      organizer_folder_ids: document.organizer_folder_ids.clone(),
      repo_path: path.clone(),
      title: document.title.clone(),
      content_hash: materialized.content_hash.clone(),
    });
    documents.push(myoxus_application::git_sync::bootstrap::BootstrapDocument {
      doc_id: document.doc_id,
      title: document.title,
      markdown: materialized.markdown.clone(),
      content_hash: materialized.content_hash.clone(),
      updated_at: document.updated_at,
      folder_names: document.folder_names,
      organizer_folder_ids: document.organizer_folder_ids,
      organizer_entry_id: document.organizer_entry_id,
    });
  }
  let mut manifest = GitSyncManifest::new(
    workspace_id,
    organizer_projection.revision.clone(),
    organizer_projection.folders.clone(),
    manifest_documents,
  );
  let (source, overview) = svc.workspace_overviews().read_trusted_git_source(&organizer).await?;
  let mut snapshots = prepared.snapshots;
  for page in std::iter::once(&overview.root).chain(&overview.folders) {
    if let Some(intro) = &page.introduction {
      let key = intro.reference.resource_id();
      if !snapshots.contains_key(key) {
        snapshots.insert(key.into(), svc.doc.load_full_doc(workspace_id, intro.doc_id).await?);
      }
    }
  }
  let observed_paths = observed.keys().chain(files.keys()).cloned().collect::<BTreeSet<_>>();
  let overview_paths = myoxus_application::git_sync::overview::plan_git_overview_paths(
    workspace_id,
    root_path,
    &organizer_projection,
    &paths,
    &occupied_paths,
    &observed_paths,
    previous.as_ref(),
  )?;
  let bodies = documents
    .iter()
    .filter_map(|doc| {
      source
        .documents
        .iter()
        .find(|fact| fact.doc_id == doc.doc_id)
        .map(|fact| (fact.reference.resource_id(), doc.markdown.as_str()))
    })
    .collect::<Vec<_>>();
  let inventory = prepared.references.with_materialized_target_sources(bodies)?;
  files.extend(
    myoxus_application::git_sync::overview::render_git_overview_batch(
      &workspace_name,
      &overview,
      &overview_paths,
      &inventory,
      &snapshots,
      &|key| export_assets.get(key).map(|(path, _)| path.clone()),
      &mut manifest,
    )
    .map_err(anyhow::Error::msg)?,
  );
  manifest
    .validate_overviews(
      workspace_id,
      occupied_paths
        .iter()
        .filter(|(_, owner)| owner.as_str() != "existing output")
        .map(|(path, _)| path.as_str()),
    )
    .map_err(anyhow::Error::msg)?;
  files.insert(manifest_path.into(), manifest.to_json()?.into_bytes());
  for path in files
    .keys()
    .map(String::as_str)
    .chain(overview_paths.retired.iter().map(|path| path.as_str()))
  {
    if scope.excludes(path)? {
      anyhow::bail!("Git-Sync export output enters a delegated repository scope");
    }
  }
  Ok(PreparedGitExport {
    manifest,
    files,
    documents,
    retired: overview_paths
      .retired
      .into_iter()
      .map(|path| path.as_str().into())
      .collect(),
    failed,
  })
}

async fn resolve_workspace(pool: &PgPool, args: &ExportDocsArgs) -> anyhow::Result<Uuid> {
  if let Some(id) = args.workspace {
    return Ok(id);
  }
  if let Some(ref name) = args.workspace_name {
    let workspace_id = sqlx::query_scalar("SELECT id FROM workspaces WHERE name = $1 AND deleted_at IS NULL LIMIT 1")
      .bind(name)
      .fetch_optional(pool)
      .await?;
    return workspace_id.ok_or_else(|| anyhow::anyhow!("workspace not found by name: {name}"));
  }
  anyhow::bail!("specify --workspace <UUID> or --workspace-name <name>")
}

async fn get_workspace_name(pool: &PgPool, workspace_id: Uuid) -> anyhow::Result<String> {
  sqlx::query_scalar("SELECT name FROM workspaces WHERE id = $1 AND deleted_at IS NULL")
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow::anyhow!("workspace not found: {workspace_id}"))
}

async fn effective_profile_root(pool: &PgPool, workspace_id: Uuid) -> anyhow::Result<(Option<Uuid>, String, String)> {
  let profiles = sqlx::query(
    "SELECT id, root_path, manifest_path
        FROM git_sync_profiles
        WHERE workspace_id = $1
        ORDER BY created_at, id
        LIMIT 2",
  )
  .bind(workspace_id)
  .fetch_all(pool)
  .await?;
  match profiles.as_slice() {
    [] => Ok((None, "content/".to_string(), GIT_SYNC_MANIFEST_PATH.to_string())),
    [profile] => Ok((
      Some(profile.get("id")),
      profile.get("root_path"),
      profile.get("manifest_path"),
    )),
    _ => anyhow::bail!("workspace has multiple configured Git-Sync profiles; export scope is ambiguous"),
  }
}

async fn load_existing_document_bindings(
  pool: &PgPool,
  profile_id: Option<Uuid>,
) -> anyhow::Result<BTreeMap<Uuid, ExistingDocumentBinding>> {
  let Some(profile_id) = profile_id else {
    return Ok(BTreeMap::new());
  };
  let rows = sqlx::query(
    "SELECT doc_id, sync_id, repo_path
     FROM git_sync_bindings
     WHERE profile_id = $1 AND tombstone = false",
  )
  .bind(profile_id)
  .fetch_all(pool)
  .await?;
  Ok(
    rows
      .into_iter()
      .map(|row| {
        (
          row.get("doc_id"),
          ExistingDocumentBinding {
            sync_id: row.get("sync_id"),
            repo_path: row.get("repo_path"),
          },
        )
      })
      .collect(),
  )
}

async fn load_file_path_owners(pool: &PgPool, profile_id: Option<Uuid>) -> anyhow::Result<BTreeMap<String, String>> {
  let Some(profile_id) = profile_id else {
    return Ok(BTreeMap::new());
  };
  let rows = sqlx::query(
    "SELECT id, repo_path
     FROM git_sync_file_bindings
     WHERE profile_id = $1 AND tombstoned = false",
  )
  .bind(profile_id)
  .fetch_all(pool)
  .await?;
  Ok(
    rows
      .into_iter()
      .map(|row| {
        let id: Uuid = row.get("id");
        (row.get("repo_path"), format!("file:{id}"))
      })
      .collect(),
  )
}

async fn load_exportable_document_rows(
  pool: &PgPool,
  workspace_id: Uuid,
) -> anyhow::Result<Vec<(Uuid, String, String, chrono::DateTime<chrono::Utc>)>> {
  let rows = sqlx::query(
    "SELECT id, external_id, COALESCE(title, '') AS title,
       GREATEST(updated_at, COALESCE((SELECT updated_at FROM doc_snapshots WHERE doc_id = docs.id), updated_at),
       COALESCE((SELECT MAX(server_timestamp) FROM doc_updates WHERE doc_id = docs.id), updated_at)) AS effective_updated_at
     FROM docs
     WHERE workspace_id = $1
       AND deleted_at IS NULL
       AND is_workspace_root = false
       AND blocked = false
       AND external_id NOT LIKE 'userdata$%'
       AND (external_id IS NULL OR external_id NOT LIKE 'db$%')
     ORDER BY id",
  )
  .bind(workspace_id)
  .fetch_all(pool)
  .await?;
  Ok(
    rows
      .into_iter()
      .map(|row| {
        (
          row.get("id"),
          row.get("external_id"),
          row.get("title"),
          row.get("effective_updated_at"),
        )
      })
      .collect(),
  )
}

async fn load_asset_paths(pool: &PgPool, profile_id: Option<Uuid>) -> anyhow::Result<HashMap<String, String>> {
  let Some(profile_id) = profile_id else {
    return Ok(HashMap::new());
  };
  let rows = sqlx::query("SELECT blob_key, repo_path FROM git_sync_file_bindings WHERE profile_id=$1 AND tombstoned=false ORDER BY repo_path")
    .bind(profile_id).fetch_all(pool).await?;
  let mut paths = HashMap::new();
  for row in rows {
    paths.entry(row.get("blob_key")).or_insert_with(|| row.get("repo_path"));
  }
  Ok(paths)
}
