// SPDX-License-Identifier: AGPL-3.0-or-later
//! System-seed bootstrap for the bundled PDF export templates
//! (`P-PDF-TPL-06-03`).
//!
//! On every server startup we ensure that the table `pdf_templates`
//! carries a row for each of the bundled system templates shipped under
//! the configured `templates.root_dir/pdf`:
//!
//! | Slug      | Purpose                                                    |
//! |-----------|------------------------------------------------------------|
//! | `default` | Neutral baseline used when no other template is selected   |
//! | `report`  | Branded report with cover page, TOC, brand-and-page footer |
//! | `letter`  | DIN-5008 Form B correspondence template (German default)   |
//! | `myoxus-doc` | Long-form documentation based on pinned ilm              |
//! | `presentation-clean` | Simple-based presentation template                |
//! | `presentation-focus` | Metropolis-based presentation template             |
//! | `presentation-navigator` | Dewdrop-based presentation template            |
//!
//! Every manifest-declared bundle file is captured from the configured PDF root
//! at startup, validated, uploaded to the PDF blob store, and
//! cross-referenced via `pdf_template_files`.
//!
//! ## Idempotency
//!
//! 1. Rows carrying the deterministic system UUID and no `created_by` actor
//!    are reconciled against the captured manifest and complete file-hash set.
//!    A changed bundle is uploaded under revision keys, then swapped in one DB
//!    transaction while the template UUID and workspace assignments survive.
//! 2. A row with the same slug but a different UUID or an administrative actor
//!    is preserved. Bundled updates never overwrite administrator-owned data.
//! 3. Initial DB inserts and bundle replacements each wrap the template row
//!    and all file rows in one transaction, so a partial bundle cannot become
//!    active.
//!
//! Reconciliation failures are startup-blocking. The bundled templates are a
//! render-time dependency, so accepting traffic with a missing or incompatible
//! system bundle would defer a deterministic deployment error to users.
//!
//! ## Why `created_by` is `None`
//!
//! The original `pdf_templates.created_by NOT NULL REFERENCES users(id)`
//! constraint would make it impossible to seed templates before any admin
//! user existed. The canonical schema permits system seeds to carry `NULL`
//! while admin uploads still
//! carry a real user id (enforced at the application layer in the upload
//! mutation).

use std::collections::BTreeMap;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use myoxus_domain::entities::{PdfTemplate, PdfTemplateFile};
use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use myoxus_domain::repositories::{PdfTemplateRepository, RepositoryError};
use myoxus_pdf_export::template_v2::TYPST_ENGINE_VERSION;

use crate::pdf_export::PdfBlobStore;

/// Stable UUIDv5 namespace for system-seeded PDF templates.
///
/// Namespacing the IDs makes the seed deterministic across cold starts: the
/// `default` template always receives the same UUID even if its row has
/// never been inserted before. Useful for tests and for cross-instance
/// invariants (e.g. workspace assignment defaults).
const SYSTEM_TEMPLATE_NS: Uuid = uuid::uuid!("c8e1d720-9a6c-4f10-bfa3-2f9a4c1e5b00");

/// One fully captured filesystem bundle; exports continue using the DB/blob copy.
struct SystemTemplate {
  slug: &'static str,
  manifest: PdfTemplateManifest,
  files: std::collections::HashMap<String, Vec<u8>>,
}

/// Capture all seven required bundles before storage writes. Presentation vendor
/// paths resolve through the same shared vendor owner as the former embedded arrays.
fn capture_system_catalog(root: &std::path::Path, max_bytes: usize) -> Result<Vec<SystemTemplate>, RepositoryError> {
  use std::io::Read;
  let root = root
    .canonicalize()
    .map_err(|e| RepositoryError::Storage(format!("PDF template root: {e}")))?;
  let read = |path: &std::path::Path| -> Result<Vec<u8>, RepositoryError> {
    let canonical = path
      .canonicalize()
      .map_err(|e| RepositoryError::Storage(format!("PDF input {}: {e}", path.display())))?;
    if !canonical.starts_with(&root) {
      return Err(RepositoryError::Storage("PDF template path escapes its root".into()));
    }
    // Every authored input is a regular file. Symlinked descendants cannot
    // silently select another bundle or external material during capture.
    let relative = path
      .strip_prefix(&root)
      .map_err(|_| RepositoryError::Storage("PDF path escapes root".into()))?;
    let mut cursor = root.clone();
    for component in relative.components() {
      cursor.push(component);
      if std::fs::symlink_metadata(&cursor)
        .map_err(|e| RepositoryError::Storage(e.to_string()))?
        .file_type()
        .is_symlink()
      {
        return Err(RepositoryError::Storage("PDF template input contains a symlink".into()));
      }
    }
    let expected = std::fs::metadata(&canonical).map_err(|e| RepositoryError::Storage(e.to_string()))?;
    if !expected.is_file() {
      return Err(RepositoryError::Storage("PDF input must be a regular file".into()));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
      .open(&canonical)
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    let opened = file.metadata().map_err(|e| RepositoryError::Storage(e.to_string()))?;
    if !opened.is_file() {
      return Err(RepositoryError::Storage(
        "PDF input changed to a nonregular file".into(),
      ));
    }
    #[cfg(unix)]
    {
      use std::os::unix::fs::MetadataExt;
      // Recheck the opened identity so replacing a validated directory with a
      // symlink cannot make the read follow an unrelated external file.
      if opened.dev() != expected.dev() || opened.ino() != expected.ino() {
        return Err(RepositoryError::Storage("PDF input changed during capture".into()));
      }
    }
    let mut bytes = Vec::new();
    file
      .take(max_bytes as u64 + 1)
      .read_to_end(&mut bytes)
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    if bytes.is_empty() || bytes.len() > max_bytes {
      return Err(RepositoryError::Storage(
        "PDF input is empty or exceeds the template size limit".into(),
      ));
    }
    Ok(bytes)
  };
  let mut catalog = Vec::with_capacity(SYSTEM_TEMPLATE_SLUGS.len());
  for &slug in SYSTEM_TEMPLATE_SLUGS {
    let directory = root.join(slug);
    let manifest_bytes = read(&directory.join("manifest.json"))?;
    let manifest: PdfTemplateManifest = serde_json::from_slice(&manifest_bytes)
      .map_err(|e| RepositoryError::Storage(format!("PDF manifest {slug}: {e}")))?;
    manifest
      .validate_package_metadata()
      .and_then(|_| manifest.validate_locale())
      .and_then(|_| manifest.validate_engine_compatibility(TYPST_ENGINE_VERSION))
      .map_err(|e| RepositoryError::Storage(format!("PDF manifest {slug}: {e}")))?;
    if manifest.id != slug
      || !manifest.entry.ends_with(".typ")
      || manifest.assets.is_empty()
      || manifest.assets.len() > 256
      || !manifest.assets.contains(&manifest.entry)
    {
      return Err(RepositoryError::Storage(format!(
        "PDF manifest {slug} has an invalid identity or entry"
      )));
    }
    let language = &manifest.capabilities.language;
    let mut locales = std::collections::HashSet::new();
    if language.kind != "enum" || language.values.is_empty() || !language.values.contains(&language.default) {
      return Err(RepositoryError::Storage(format!(
        "PDF manifest {slug} has invalid locale capabilities"
      )));
    }
    for locale in &language.values {
      let mut parts = locale.split('-');
      let base = parts.next().unwrap_or_default();
      let mut locale_manifest = manifest.clone();
      locale_manifest.capabilities.language.default = base.to_ascii_lowercase();
      if !(2..=8).contains(&base.len())
        || !base.bytes().all(|c| c.is_ascii_alphabetic())
        || parts.any(|part| part.is_empty() || part.len() > 8 || !part.bytes().all(|c| c.is_ascii_alphanumeric()))
        || locale_manifest.validate_locale().is_err()
        || !locales.insert(locale.to_ascii_lowercase())
      {
        return Err(RepositoryError::Storage(format!(
          "PDF manifest {slug} has an invalid locale"
        )));
      }
    }
    let mut files = std::collections::HashMap::new();
    let mut total = manifest_bytes.len();
    for path in &manifest.assets {
      if path.is_empty()
        || path.len() > 256
        || path.split('/').any(|p| p.is_empty() || p == "." || p == "..")
        || path.chars().any(|c| !c.is_ascii_alphanumeric() && !"/._-".contains(c))
      {
        return Err(RepositoryError::Storage(format!("invalid PDF asset path in {slug}")));
      }
      if files.contains_key(path) {
        return Err(RepositoryError::Storage(format!("duplicate PDF asset in {slug}")));
      }
      let source = if slug.starts_with("presentation-") && path.starts_with("vendor/") {
        root.join(path)
      } else {
        directory.join(path)
      };
      let bytes = read(&source)?;
      total = total.saturating_add(bytes.len());
      if total > max_bytes {
        return Err(RepositoryError::Storage(format!(
          "PDF bundle {slug} exceeds the template size limit"
        )));
      }
      files.insert(path.clone(), bytes);
    }
    catalog.push(SystemTemplate { slug, manifest, files });
  }
  Ok(catalog)
}

/// Stable slugs of every system-seeded template, in deterministic order.
///
/// Exposed primarily for tests (e.g. `inv_reg03`) so they can iterate over
/// the same set the bootstrap installs. The order is the filesystem capture and seed order.
pub const SYSTEM_TEMPLATE_SLUGS: &[&str] = &[
  "default",
  "report",
  "letter",
  "myoxus-doc",
  "presentation-clean",
  "presentation-focus",
  "presentation-navigator",
];

/// Compute the stable UUID a system template will be inserted with. Useful
/// for tests that want to assert determinism across cold starts.
pub fn system_template_id(slug: &str) -> Uuid {
  Uuid::new_v5(&SYSTEM_TEMPLATE_NS, slug.as_bytes())
}

/// Idempotently assign the active bundled `default` template to every active
/// workspace that does not have it yet.
///
/// Existing workspace defaults are preserved: the inserted assignment is only
/// marked as default when the workspace has no other default assignment. The
/// actor is the workspace creator/owner, or the oldest accepted administrator
/// for repaired shared workspaces. Newly inserted workspaces are covered by the
/// canonical database trigger.
#[instrument(skip(pool), err)]
pub async fn ensure_default_pdf_template_assignments(pool: &PgPool) -> Result<u64, RepositoryError> {
  let result = sqlx::query(
    r#"
    INSERT INTO pdf_workspace_template_assignments (
      workspace_id,
      template_id,
      is_default,
      assigned_by,
      assigned_at
    )
    SELECT
      workspace.id,
      template.id,
      NOT EXISTS (
        SELECT 1
          FROM pdf_workspace_template_assignments existing_default
         WHERE existing_default.workspace_id = workspace.id
           AND existing_default.is_default = TRUE
      ),
      actor.user_id,
      now()
      FROM workspaces workspace
      JOIN pdf_templates template
        ON template.slug = 'default'
       AND template.deleted_at IS NULL
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          workspace.created_by_user_id,
          workspace.owner_user_id,
          (
            SELECT membership.user_id
              FROM workspace_memberships membership
             WHERE membership.workspace_id = workspace.id
               AND membership.status = 'Accepted'
             ORDER BY
               CASE membership.role
                 WHEN 'Owner' THEN 0
                 WHEN 'Admin' THEN 1
                 ELSE 2
               END,
               membership.joined_at,
               membership.user_id
             LIMIT 1
          )
        ) AS user_id
      ) actor
      WHERE workspace.lifecycle_state = 'active'
        AND workspace.deleted_at IS NULL
       AND actor.user_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM pdf_workspace_template_assignments existing
          WHERE existing.workspace_id = workspace.id
            AND existing.template_id = template.id
       )
    ON CONFLICT (workspace_id, template_id) DO NOTHING
    "#,
  )
  .execute(pool)
  .await
  .map_err(|error| RepositoryError::Storage(error.to_string()))?;

  let inserted = result.rows_affected();
  info!(inserted, "default PDF template workspace assignment repair complete");
  Ok(inserted)
}

/// Idempotently reconcile every bundled system template with the database and
/// blob store.
///
/// Returns the number of templates that were inserted or updated (`0` means
/// every stored system bundle already matches the captured catalog). Admin-authored
/// templates are never overwritten, even if they use a reserved system slug.
/// Any storage or database error aborts reconciliation. The operation is
/// idempotent, so a later startup can safely continue after the underlying
/// dependency is repaired.
#[instrument(skip(repo, blob_store), err)]
pub async fn seed_system_pdf_templates(
  repo: Arc<dyn PdfTemplateRepository>,
  blob_store: Arc<PdfBlobStore>,
  root: &std::path::Path,
  max_bytes: usize,
  watchdog: std::time::Duration,
) -> Result<usize, RepositoryError> {
  let catalog = capture_system_catalog(root, max_bytes)?;
  let mut candidates = Vec::new();
  for tpl in catalog {
    let existing = repo.get_by_slug(tpl.slug).await?;
    let observed = if let Some(row) = existing {
      if row.id != system_template_id(tpl.slug)
        || row.created_by.is_some()
        || system_version(&row.version)
          .zip(system_version(&tpl.manifest.version))
          .is_some_and(|(stored, incoming)| stored > incoming)
      {
        continue;
      }
      let files = repo.list_files(row.id).await?;
      let manifest = serde_json::to_value(&tpl.manifest).map_err(|e| RepositoryError::Storage(e.to_string()))?;
      if stored_bundle_matches(
        &row,
        &files,
        &tpl,
        &tpl.manifest.version,
        &tpl.manifest.name,
        &tpl.manifest.schema_version,
        &manifest,
      ) {
        continue;
      }
      Some((row, files))
    } else {
      None
    };
    candidates.push((tpl, observed));
  }
  // Validate every proposed activation before the first blob upload. A later
  // invalid bundle must not leave an earlier catalog entry newly activated.
  for (tpl, _) in &candidates {
    myoxus_pdf_export::template_v2::validate_template_compiles_with_timeout(&tpl.files, &tpl.manifest, watchdog)
      .await
      .map_err(|e| RepositoryError::Storage(format!("PDF system bundle {} does not compile: {e}", tpl.slug)))?;
  }
  let mut changed = 0usize;
  for (tpl, observed) in &candidates {
    if seed_one_template(repo.as_ref(), blob_store.as_ref(), tpl, observed.as_ref()).await? {
      changed += 1;
    } else {
      debug!(slug = tpl.slug, "system pdf template bundle already current");
    }
  }
  info!(
    changed,
    total = SYSTEM_TEMPLATE_SLUGS.len(),
    "system pdf template reconciliation complete"
  );
  Ok(changed)
}

/// Assert that every active template targets the renderer embedded in this
/// binary and that all seven required slugs are active, including protected Admin-owned rows.
///
/// This is intentionally metadata-only: bundle compilation belongs to upload,
/// migration and system reconciliation. Keeping startup bounded avoids an
/// operator-controlled number of expensive Typst compilations before
/// readiness.
#[instrument(skip(pool), err)]
pub async fn verify_active_pdf_template_engines(pool: &PgPool) -> Result<(), RepositoryError> {
  let rows = sqlx::query(
    r#"
    SELECT id, slug, manifest #>> '{engine,name}' AS engine_name,
           manifest #>> '{engine,version}' AS engine_version
      FROM pdf_templates
     WHERE deleted_at IS NULL
    "#,
  )
  .fetch_all(pool)
  .await
  .map_err(|error| RepositoryError::Storage(error.to_string()))?;

  let mut active_required_slugs = std::collections::HashSet::new();
  for row in rows {
    use sqlx::Row;
    let id: Uuid = row.get("id");
    let slug: String = row.get("slug");
    let engine_name: Option<String> = row.try_get("engine_name").ok();
    let engine_version: Option<String> = row.try_get("engine_version").ok();
    if SYSTEM_TEMPLATE_SLUGS.contains(&slug.as_str()) {
      active_required_slugs.insert(slug.clone());
    }
    if engine_name.as_deref() != Some("typst")
      || !engine_version
        .as_deref()
        .is_some_and(|version| engine_version_matches(version, TYPST_ENGINE_VERSION))
    {
      return Err(RepositoryError::Storage(format!(
        "active PDF template {slug} ({id}) targets {} {}, but this server requires typst {TYPST_ENGINE_VERSION}",
        engine_name.as_deref().unwrap_or("<missing>"),
        engine_version.as_deref().unwrap_or("<missing>")
      )));
    }
  }

  for slug in SYSTEM_TEMPLATE_SLUGS {
    if !active_required_slugs.contains(*slug) {
      return Err(RepositoryError::Storage(format!(
        "required system PDF template {slug} is missing or inactive"
      )));
    }
  }
  Ok(())
}

fn engine_version_matches(declared: &str, renderer: &str) -> bool {
  declared == renderer
    || renderer
      .rsplit_once('.')
      .is_some_and(|(line, _)| declared == format!("{line}.x"))
}

fn sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  format!("{:x}", hasher.finalize())
}

fn expected_bundle_hashes(tpl: &SystemTemplate) -> BTreeMap<&str, String> {
  tpl
    .files
    .iter()
    .map(|(path, bytes)| (path.as_str(), sha256_hex(bytes)))
    .collect()
}

fn system_version(version: &str) -> Option<(u64, u64, u64)> {
  let mut parts = version.split('.').map(str::parse::<u64>);
  let parsed = (parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?);
  parts.next().is_none().then_some(parsed)
}

async fn upload_bundle_files(
  blob_store: &PdfBlobStore,
  tpl: &SystemTemplate,
  template_id: Uuid,
) -> Result<Vec<PdfTemplateFile>, RepositoryError> {
  let mut records = Vec::with_capacity(tpl.files.len());
  for (path, bytes) in tpl.files.iter() {
    let expected_sha = sha256_hex(bytes);
    let (blob_key, blob_sha) = blob_store.put_template_revision_file(template_id, path, bytes).await?;
    if blob_sha != expected_sha {
      return Err(RepositoryError::Storage(format!(
        "sha256 mismatch for {}/{}: bootstrap computed {} but blob store reported {}",
        tpl.slug, path, expected_sha, blob_sha
      )));
    }
    debug!(
      slug = tpl.slug,
      template_id = %template_id,
      file_path = path,
      size = bytes.len(),
      sha256 = blob_sha,
      "uploaded system template bundle file"
    );
    records.push(PdfTemplateFile {
      template_id,
      file_path: path.to_owned(),
      blob_key,
      content_hash: expected_sha,
    });
  }
  Ok(records)
}

fn stored_bundle_matches(
  existing: &PdfTemplate,
  stored_files: &[PdfTemplateFile],
  tpl: &SystemTemplate,
  version: &str,
  name: &str,
  schema_version: &str,
  manifest: &serde_json::Value,
) -> bool {
  if existing.name != name
    || existing.version != version
    || existing.schema_version != schema_version
    || &existing.manifest != manifest
  {
    return false;
  }

  let expected = expected_bundle_hashes(tpl);
  stored_files.len() == expected.len()
    && stored_files.iter().all(|file| {
      expected
        .get(file.file_path.as_str())
        .is_some_and(|hash| hash == &file.content_hash)
    })
}

/// Reconcile a single template. Returns `Ok(true)` when a row was inserted or
/// a changed server-owned bundle was replaced, `Ok(false)` when no write was
/// required or a non-system row owns the slug.
async fn seed_one_template(
  repo: &dyn PdfTemplateRepository,
  blob_store: &PdfBlobStore,
  tpl: &SystemTemplate,
  observed: Option<&(PdfTemplate, Vec<PdfTemplateFile>)>,
) -> Result<bool, RepositoryError> {
  let parsed_manifest = &tpl.manifest;
  let name = parsed_manifest.name.clone();
  let version = parsed_manifest.version.clone();
  let schema_version = parsed_manifest.schema_version.clone();
  let manifest = serde_json::to_value(parsed_manifest)
    .map_err(|error| RepositoryError::Storage(format!("failed to canonicalize {} manifest: {error}", tpl.slug)))?;

  let template_id = system_template_id(tpl.slug);

  if let Some((existing, stored_files)) = observed {
    if existing.id != template_id || existing.created_by.is_some() {
      warn!(
        slug = tpl.slug,
        template_id = %existing.id,
        "reserved system template slug is owned by a non-system row; preserving it"
      );
      return Ok(false);
    }

    if system_version(&existing.version)
      .zip(system_version(&version))
      .is_some_and(|(stored, bundled)| stored > bundled)
    {
      warn!(
        slug = tpl.slug,
        stored_version = %existing.version,
        bundled_version = %version,
        "newer system template already stored; refusing startup downgrade"
      );
      return Ok(false);
    }

    if stored_bundle_matches(
      &existing,
      stored_files,
      tpl,
      &version,
      &name,
      &schema_version,
      &manifest,
    ) {
      return Ok(false);
    }

    // Revision keys keep the currently referenced bundle intact until the DB
    // swap commits. A failed swap leaves inactive blobs instead of corrupting
    // the currently referenced bundle.
    let file_records = upload_bundle_files(blob_store, tpl, template_id).await?;
    let replacement = PdfTemplate {
      id: existing.id,
      slug: existing.slug.clone(),
      name,
      version: version.clone(),
      schema_version,
      manifest,
      created_by: existing.created_by,
      created_at: existing.created_at,
      deleted_at: None,
    };
    match repo
      .replace_bundle(&replacement, &file_records, existing, stored_files, None)
      .await
    {
      Ok(()) => {}
      Err(RepositoryError::Conflict(_)) => return accept_competing_bundle(repo, tpl).await,
      Err(error) => return Err(error),
    }
    info!(
      slug = tpl.slug,
      template_id = %template_id,
      version = %version,
      files = file_records.len(),
      "system pdf template bundle updated"
    );
    return Ok(true);
  }

  // Initial writers also use content-addressed keys. A different filesystem
  // root racing for this UUID must not overwrite the winning bundle's bytes.
  let file_records = upload_bundle_files(blob_store, tpl, template_id).await?;

  let row = PdfTemplate {
    id: template_id,
    slug: tpl.slug.to_owned(),
    name,
    version,
    schema_version,
    manifest,
    created_by: None,
    created_at: chrono::Utc::now(),
    deleted_at: None,
  };

  match repo.create(&row, &file_records, None).await {
    Ok(()) => {
      info!(
        slug = tpl.slug,
        template_id = %template_id,
        files = file_records.len(),
        "system pdf template seeded"
      );
      Ok(true)
    }
    Err(RepositoryError::Conflict(_)) => accept_competing_bundle(repo, tpl).await,

    Err(err) => Err(err),
  }
}

/// A conflict is success only when the winner is identical or has protected
/// ownership/a newer revision. Uploaded revision blobs remain unreferenced;
/// deleting them here could delete a concurrent writer's referenced bytes.
async fn accept_competing_bundle(
  repo: &dyn PdfTemplateRepository,
  tpl: &SystemTemplate,
) -> Result<bool, RepositoryError> {
  let row = repo
    .get_by_slug(tpl.slug)
    .await?
    .ok_or(RepositoryError::Conflict("PDF seed winner is unavailable"))?;
  if row.id != system_template_id(tpl.slug)
    || row.created_by.is_some()
    || system_version(&row.version)
      .zip(system_version(&tpl.manifest.version))
      .is_some_and(|(stored, incoming)| stored > incoming)
  {
    return Ok(false);
  }
  let files = repo.list_files(row.id).await?;
  let manifest = serde_json::to_value(&tpl.manifest).map_err(|e| RepositoryError::Storage(e.to_string()))?;
  if stored_bundle_matches(
    &row,
    &files,
    tpl,
    &tpl.manifest.version,
    &tpl.manifest.name,
    &tpl.manifest.schema_version,
    &manifest,
  ) {
    Ok(false)
  } else {
    Err(RepositoryError::Conflict(
      "PDF system bundle changed during startup capture",
    ))
  }
}

#[cfg(test)]
mod filesystem_tests {
  use super::*;
  use std::path::Path;

  fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
      let entry = entry.unwrap();
      if entry.file_type().unwrap().is_dir() {
        copy_tree(&entry.path(), &target.join(entry.file_name()));
      } else {
        std::fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
      }
    }
  }

  fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    copy_tree(
      &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf"),
      temp.path(),
    );
    temp
  }

  #[test]
  fn rejects_invalid_late_manifests_and_bounded_inputs() {
    for fault in [
      "duplicate",
      "escape",
      "entry",
      "metadata",
      "locale",
      "locale-values",
      "locale-default",
      "engine",
      "missing",
    ] {
      let temp = fixture();
      let path = temp.path().join("presentation-navigator/manifest.json");
      let mut manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
      match fault {
        "duplicate" => {
          let first = manifest["assets"][0].clone();
          manifest["assets"].as_array_mut().unwrap().push(first);
        }
        "escape" => {
          manifest["assets"]
            .as_array_mut()
            .unwrap()
            .push("../default/main.typ".into());
        }
        "entry" => manifest["entry"] = "missing.typ".into(),
        "metadata" => manifest["version"] = "invalid".into(),
        "locale" => manifest["capabilities"]["language"]["default"] = "ja".into(),
        "locale-values" => manifest["capabilities"]["language"]["values"]
          .as_array_mut()
          .unwrap()
          .push("ja-JP".into()),
        "locale-default" => manifest["capabilities"]["language"]["default"] = "pt".into(),
        "engine" => manifest["engine"]["version"] = "0.0.0".into(),
        "missing" => {
          std::fs::remove_file(temp.path().join("presentation-navigator/main.typ")).unwrap();
        }
        _ => unreachable!(),
      }
      std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
      assert!(
        capture_system_catalog(temp.path(), 16 * 1024 * 1024).is_err(),
        "must reject {fault}"
      );
    }
    let temp = fixture();
    assert!(
      capture_system_catalog(temp.path(), 32).is_err(),
      "bounded manifest read"
    );
    let path = temp.path().join("default/main.typ");
    std::fs::write(&path, vec![b'x'; 16 * 1024 * 1024 + 1]).unwrap();
    assert!(
      capture_system_catalog(temp.path(), 16 * 1024 * 1024).is_err(),
      "bounded asset read"
    );
  }

  #[cfg(unix)]
  #[test]
  fn rejects_leaf_and_directory_symlinks_and_nonregular_inputs() {
    use std::os::unix::fs::symlink;
    for directory in [false, true] {
      let temp = fixture();
      let external = fixture();
      let relative = if directory { "default" } else { "default/main.typ" };
      let target = temp.path().join(relative);
      if directory {
        std::fs::remove_dir_all(&target).unwrap();
      } else {
        std::fs::remove_file(&target).unwrap();
      }
      symlink(external.path().join(relative), &target).unwrap();
      assert!(capture_system_catalog(temp.path(), 16 * 1024 * 1024).is_err());
    }
    let temp = fixture();
    let target = temp.path().join("default/main.typ");
    std::fs::remove_file(&target).unwrap();
    std::fs::create_dir(&target).unwrap();
    assert!(capture_system_catalog(temp.path(), 16 * 1024 * 1024).is_err());
  }
}
