// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant test for the system-seed bootstrap of bundled PDF templates
//! (`P-PDF-TPL-06-07`).
//!
//! `inv_reg03_seed_templates_are_present_after_migration` exercises the
//! full bootstrap path:
//!
//! 1. Wipe any pre-existing system templates so the test is repeatable.
//! 2. Run `seed_system_pdf_templates` once. Assert it returns the full
//!    set was inserted.
//! 3. Repair a workspace created before the seed and assert that repeated
//!    repair is a no-op.
//! 4. Create a workspace after the seed and assert that the migration trigger
//!    assigns the bundled default immediately.
//! 5. Assert every system template is loadable through
//!    `PgPdfTemplateRegistry::load` with byte-exact bundle file content.
//! 6. Run `seed_system_pdf_templates` a second time. Assert it returns
//!    `0` — proving the seed is idempotent.
//! 7. Corrupt one stored system-file hash, reconcile again, and assert that
//!    only that bundle is atomically replaced without changing its UUID.
//! 8. Cleanup: remove the inserted rows so the test leaves no residue.

use futures_util::FutureExt;
use sqlx::postgres::PgConnectOptions;
use std::str::FromStr;
use std::sync::Arc;

use opendal::Operator;
use opendal::services::Memory;
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::repositories::PdfTemplateRepository;
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfTemplateRegistry, PgPdfTemplateRepository, SYSTEM_TEMPLATE_SLUGS,
  ensure_default_pdf_template_assignments, seed_system_pdf_templates as seed_system_pdf_templates_from_root,
  system_template_id,
};
use myoxus_pdf_export::template_v2::PdfTemplateRegistry;

/// Required-on-disk files for every system template bundle. Matches the
/// common subset of each manifest's assets. Kept in this test as a
/// hard-coded invariant: if a future change drops one of these files the
/// test must be updated explicitly so the omission is reviewed, not
/// silently accepted.
const REQUIRED_BUNDLE_FILES: &[&str] = &["main.typ", "preamble.typ", "theme.typ", "i18n/en.json", "i18n/de.json"];

async fn setup_pool() -> PgPool {
  let database_url =
    std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL must be set for pdf_template_seeding tests");
  let options = PgConnectOptions::from_str(&database_url).expect("test database URL");
  assert_eq!(options.get_database(), Some("myoxus_test"));
  assert_eq!(options.get_port(), 5434, "seeding tests require the isolated stack");
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

/// Remove any pre-existing system template rows so the test starts from a
/// clean slate. Templates left over from production seeds are content-
/// addressed and will be re-uploaded by the seed call under test, so the
/// wipe + re-seed is byte-stable.
async fn wipe_system_templates(pool: &PgPool) {
  sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE template_id = ANY($1)")
    .bind(
      SYSTEM_TEMPLATE_SLUGS
        .iter()
        .map(|slug| system_template_id(slug))
        .collect::<Vec<_>>(),
    )
    .execute(pool)
    .await
    .expect("pre-test assignment wipe must succeed");
  for slug in SYSTEM_TEMPLATE_SLUGS {
    sqlx::query("DELETE FROM pdf_templates WHERE slug = $1")
      .bind(slug)
      .execute(pool)
      .await
      .expect("pre-test wipe of system template must succeed");
  }
}

#[tokio::test]
async fn inv_reg03_seed_templates_are_present_after_migration() {
  let pool = setup_pool().await;

  // This serial isolated-stack test owns the system inventory for its duration.
  // Start without templates so the first seed must insert every bundle.
  wipe_system_templates(&pool).await;

  let owner_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'PDF seed owner') RETURNING id")
    .bind(format!("pdf-seed-owner-{}@example.com", Uuid::new_v4().simple()))
    .fetch_one(&pool)
    .await
    .expect("create PDF seed owner");
  // Always clean up the test-owned rows before propagating an assertion panic.
  let result = std::panic::AssertUnwindSafe(async {
  let existing_workspace_id: Uuid = sqlx::query_scalar(
    "INSERT INTO workspaces (owner_user_id, created_by_user_id, name) VALUES ($1, $1, 'PDF pre-seed workspace') RETURNING id",
  )
  .bind(owner_id)
  .fetch_one(&pool)
  .await
  .expect("create pre-seed workspace");

  let blob_store = Arc::new(PdfBlobStore::new(Operator::new(Memory::default()).expect("memory op")));
  let tpl_repo: Arc<dyn PdfTemplateRepository> = Arc::new(PgPdfTemplateRepository::new(pool.clone()));

  // ── Step 2: first seed pass must insert every system template ────────────
  let inserted = seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone())
    .await
    .expect("first seed pass must succeed");
  assert_eq!(
    inserted,
    SYSTEM_TEMPLATE_SLUGS.len(),
    "INV-REG-03: first seed pass must insert every system template"
  );

  // ── Steps 3–4: existing rows are repaired; future rows use the trigger ──
  // Other serial suites may leave workspace fixtures in the isolated stack.
  // Repair those first, then remove only our assignment to measure one repair.
  ensure_default_pdf_template_assignments(&pool).await.expect("repair existing test inventory");
  sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(existing_workspace_id).execute(&pool).await.expect("prepare owned repair case");
  assert_eq!(
    ensure_default_pdf_template_assignments(&pool)
      .await
      .expect("repair existing workspace assignment"),
    1,
  );
  assert_eq!(
    ensure_default_pdf_template_assignments(&pool)
      .await
      .expect("repeat workspace assignment repair"),
    0,
  );

  let existing_assignment: (Uuid, bool) =
    sqlx::query_as("SELECT template_id, is_default FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
      .bind(existing_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("repaired default assignment must exist");
  assert_eq!(existing_assignment.0, system_template_id("default"));
  assert!(
    existing_assignment.1,
    "the first assignment must become the workspace default"
  );

  let new_workspace_id: Uuid = sqlx::query_scalar(
    "INSERT INTO workspaces (owner_user_id, created_by_user_id, name) VALUES ($1, $1, 'PDF post-seed workspace') RETURNING id",
  )
  .bind(owner_id)
  .fetch_one(&pool)
  .await
  .expect("create post-seed workspace");
  let triggered_assignment: (Uuid, bool) =
    sqlx::query_as("SELECT template_id, is_default FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
      .bind(new_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("triggered default assignment must exist");
  assert_eq!(triggered_assignment.0, system_template_id("default"));
  assert!(
    triggered_assignment.1,
    "the trigger assignment must become the workspace default"
  );

  let documentation_id = system_template_id("myoxus-doc");
  assert_eq!(documentation_id, uuid::uuid!("9359aaf5-be1f-5817-92e4-12b4cb79b354"));
  let mut tx = pool.begin().await.expect("assignment transaction");
  sqlx::query("UPDATE pdf_workspace_template_assignments SET is_default = false WHERE workspace_id = $1")
    .bind(new_workspace_id).execute(&mut *tx).await.expect("clear initial default");
  sqlx::query("INSERT INTO pdf_workspace_template_assignments (workspace_id, template_id, is_default, assigned_by) VALUES ($1, $2, true, $3)")
    .bind(new_workspace_id).bind(documentation_id).bind(owner_id).execute(&mut *tx).await.expect("assign documentation default");
  tx.commit().await.expect("commit documentation assignment");

  // ── Step 5: every system template must be loadable via the registry ──────
  let registry = PgPdfTemplateRegistry::new(pool.clone(), tpl_repo.clone(), blob_store.clone());
  for slug in SYSTEM_TEMPLATE_SLUGS {
    let id = system_template_id(slug);
    let loaded = registry
      .load(id)
      .await
      .unwrap_or_else(|err| panic!("INV-REG-03: system template `{slug}` ({id}) must load via registry: {err}"));

    assert_eq!(loaded.slug, *slug, "INV-REG-03: loaded slug must match");
    assert_eq!(loaded.manifest.id, *slug, "INV-REG-03: manifest.id must round-trip");

    assert_eq!(loaded.files.len(), loaded.manifest.assets.len(), "exact file inventory for {slug}");
    let template_source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../../templates/pdf")
      .join(slug);
    let shared_source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf");
    for path in &loaded.manifest.assets {
      let source = if path.starts_with("vendor/") && slug.starts_with("presentation-") {
        shared_source.join(path)
      } else {
        template_source.join(path)
      };
      assert_eq!(loaded.files.get(path), Some(&std::fs::read(source).expect("embedded source file")), "byte-exact registry file {slug}/{path}");
    }

    for required in REQUIRED_BUNDLE_FILES {
      let bytes = loaded
        .files
        .get(*required)
        .unwrap_or_else(|| panic!("INV-REG-03: system template `{slug}` is missing required bundle file `{required}`"));
      assert!(
        !bytes.is_empty(),
        "INV-REG-03: bundle file `{required}` for `{slug}` must not be empty"
      );
    }
  }

  // ── Step 6: second seed pass must be a no-op (idempotency) ───────────────
  let inserted_again = seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone())
    .await
    .expect("second seed pass must succeed");
  assert_eq!(
    inserted_again, 0,
    "INV-REG-03: second seed pass must insert nothing (seed is idempotent)"
  );

  // ── Step 7: changed bundled content replaces only the system bundle ─────
  let default_id = system_template_id("default");
  sqlx::query(
    "UPDATE pdf_template_files SET content_hash = 'stale' WHERE template_id = $1 AND file_path = 'preamble.typ'",
  )
  .bind(default_id)
  .execute(&pool)
  .await
  .expect("simulate stale bundled default template");

  let reconciled = seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone())
    .await
    .expect("changed system bundle must reconcile");
  assert_eq!(
    reconciled, 1,
    "INV-REG-03: only the stale system bundle must be replaced"
  );

  let default_after = tpl_repo
    .get_by_slug("default")
    .await
    .expect("load reconciled default template")
    .expect("reconciled default template must exist");
  assert_eq!(
    default_after.id, default_id,
    "workspace assignments require a stable template UUID"
  );
  assert_eq!(default_after.version, "1.7.0");
  let files_after = tpl_repo
    .list_files(default_id)
    .await
    .expect("list reconciled default files");
  assert_eq!(files_after.len(), REQUIRED_BUNDLE_FILES.len());
  assert!(files_after.iter().all(|file| file.content_hash != "stale"));
  assert!(
    files_after.iter().all(|file| file.blob_key.contains("/revisions/")),
    "replacement files must use revision keys until the DB swap commits"
  );

  assert_eq!(
    seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone())
      .await
      .expect("reconciled bundle must become idempotent"),
    0,
  );

  sqlx::query("UPDATE pdf_templates SET version = '9.0.0' WHERE id = $1")
    .bind(default_id)
    .execute(&pool)
    .await
    .expect("simulate a newer system bundle during rolling deployment");
  assert_eq!(
    seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone())
      .await
      .expect("older server bundle must not replace a newer stored revision"),
    0,
  );
  assert_eq!(
    tpl_repo
      .get_by_slug("default")
      .await
      .expect("read downgrade-protected default")
      .expect("default template must remain present")
      .version,
    "9.0.0",
  );


  let doc_before = registry.load(documentation_id).await.expect("documentation before revision");
  sqlx::query("UPDATE pdf_templates SET version = '0.9.0' WHERE id = $1").bind(documentation_id).execute(&pool).await.expect("older documentation revision");
  sqlx::query("UPDATE pdf_template_files SET content_hash = 'stale' WHERE template_id = $1 AND file_path = 'vendor/ilm.typ'")
    .bind(documentation_id).execute(&pool).await.expect("simulate stale documentation module");
  assert_eq!(seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone()).await.expect("reconcile documentation"), 1);
  let doc_after = registry.load(documentation_id).await.expect("documentation after revision");
  assert_eq!(doc_after.id, doc_before.id);
  assert_eq!(doc_after.version, doc_before.version);
  assert_eq!(doc_after.files, doc_before.files);
  let assignment: (Uuid, bool) = sqlx::query_as("SELECT template_id, is_default FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND template_id = $2")
    .bind(new_workspace_id).bind(documentation_id).fetch_one(&pool).await.expect("retained documentation default");
  assert_eq!(assignment, (documentation_id, true));
  let unrelated_default: Uuid = sqlx::query_scalar("SELECT template_id FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND is_default")
    .bind(existing_workspace_id).fetch_one(&pool).await.expect("unrelated default");
  assert_eq!(unrelated_default, default_id);
  assert_eq!(seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone()).await.expect("documentation restart"), 0);

  // A valid earlier revision and invalid final candidate must activate nothing.
  let external = tempfile::tempdir().unwrap();
  fn copy_tree(source: &std::path::Path, target: &std::path::Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
      let entry = entry.unwrap();
      if entry.file_type().unwrap().is_dir() { copy_tree(&entry.path(), &target.join(entry.file_name())); }
      else { std::fs::copy(entry.path(), target.join(entry.file_name())).unwrap(); }
    }
  }
  copy_tree(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf"), external.path());
  let first_path = external.path().join("report/main.typ");
  let mut changed = std::fs::read(&first_path).unwrap();
  changed.extend_from_slice(b"\n// external revision under the existing version\n");
  std::fs::write(first_path, changed).unwrap();
  std::fs::write(external.path().join("presentation-navigator/preamble.typ"), "#let =\n").unwrap();
  let before = tpl_repo.list(false).await.unwrap();
  let report_before = registry.load(system_template_id("report")).await.unwrap().files;
  let error = seed_system_pdf_templates_from_root(tpl_repo.clone(), blob_store.clone(), external.path(),
    16 * 1024 * 1024, std::time::Duration::from_secs(120)).await.expect_err("late invalid compilation must abort the catalog before activation");
  assert!(error.to_string().contains("does not compile"));
  for row in before {
    let current = tpl_repo.get_by_id(row.id).await.unwrap().unwrap();
    assert_eq!(current.manifest, row.manifest);
    assert_eq!(current.version, row.version);
  }
  assert_eq!(registry.load(system_template_id("report")).await.unwrap().files, report_before);

  // Same-version metadata and file edits both invalidate an observed replacement.
  let audit_before: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='pdf_template.replace_bundle'")
    .bind(documentation_id.to_string()).fetch_one(&pool).await.unwrap();
  let observed = tpl_repo.get_by_id(documentation_id).await.unwrap().unwrap();
  let observed_files = tpl_repo.list_files(documentation_id).await.unwrap();
  let mut edited_manifest = observed.manifest.clone();
  edited_manifest["description"] = "Concurrent administrator edit".into();
  tpl_repo.update_manifest(documentation_id, &edited_manifest).await.unwrap();
  assert!(matches!(tpl_repo.replace_bundle(&observed, &observed_files, &observed, &observed_files, Some(myoxus_domain::audit::AuditActor::user(owner_id, None))).await,
    Err(myoxus_domain::repositories::RepositoryError::Conflict(_))));
  assert_eq!(tpl_repo.get_by_id(documentation_id).await.unwrap().unwrap().manifest, edited_manifest);
  tpl_repo.update_manifest(documentation_id, &observed.manifest).await.unwrap();
  sqlx::query("UPDATE pdf_template_files SET content_hash = 'competing-hash' WHERE template_id = $1 AND file_path = 'main.typ'")
    .bind(documentation_id).execute(&pool).await.unwrap();
  assert!(matches!(tpl_repo.replace_bundle(&observed, &observed_files, &observed, &observed_files, Some(myoxus_domain::audit::AuditActor::user(owner_id, None))).await,
    Err(myoxus_domain::repositories::RepositoryError::Conflict(_))));
  assert_eq!(tpl_repo.list_files(documentation_id).await.unwrap().into_iter().find(|f| f.file_path == "main.typ").unwrap().content_hash, "competing-hash");
  assert_eq!(seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone()).await.unwrap(), 1);

  let audit_after: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='pdf_template.replace_bundle'")
    .bind(documentation_id.to_string()).fetch_one(&pool).await.unwrap();
  assert_eq!(audit_after, audit_before, "rejected revisions cannot emit a successful replacement audit");
  assert_eq!(registry.load(documentation_id).await.unwrap().files, doc_before.files, "conflicting writers retain the active byte inventory");

  // A failed file insertion must roll back metadata and the complete old file set.
  let row_before = tpl_repo.get_by_id(documentation_id).await.unwrap().unwrap();
  let files_before = tpl_repo.list_files(documentation_id).await.unwrap();
  let mut replacement = row_before.clone();
  replacement.version = "1.2.0".into();
  replacement.name = "Must roll back".into();
  let mut duplicate_files = files_before.clone();
  duplicate_files.push(files_before[0].clone());
  tpl_repo.replace_bundle(&replacement, &duplicate_files, &row_before, &tpl_repo.list_files(row_before.id).await.expect("observed files"), None).await.expect_err("duplicate file must abort the atomic swap");
  let row_after = tpl_repo.get_by_id(documentation_id).await.unwrap().unwrap();
  assert_eq!(row_after.name, row_before.name);
  assert_eq!(row_after.version, row_before.version);
  assert_eq!(row_after.manifest, row_before.manifest);
  assert_eq!(registry.load(documentation_id).await.unwrap().files, doc_before.files);

  sqlx::query("UPDATE pdf_templates SET version = '9.0.0' WHERE id = $1")
    .bind(documentation_id).execute(&pool).await.expect("newer documentation revision");
  assert_eq!(seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone()).await.expect("documentation downgrade refusal"), 0);
  assert_eq!(tpl_repo.get_by_id(documentation_id).await.unwrap().unwrap().version, "9.0.0");
  assert_eq!(registry.load(documentation_id).await.unwrap().files, doc_before.files);

  // A distinct administrator identity owning the slug must never be overwritten.
  sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE template_id = $1").bind(documentation_id).execute(&pool).await.unwrap();
  sqlx::query("DELETE FROM pdf_templates WHERE id = $1").bind(documentation_id).execute(&pool).await.unwrap();
  let admin_id = Uuid::new_v4();
  let mut admin_row = row_before;
  admin_row.id = admin_id;
  admin_row.created_by = Some(owner_id);
  admin_row.name = "Administrator documentation".into();
  let admin_files: Vec<_> = files_before.into_iter().map(|mut file| { file.template_id = admin_id; file }).collect();
  tpl_repo.create(&admin_row, &admin_files, None).await.expect("administrator slug collision");
  assert_eq!(seed_system_pdf_templates(tpl_repo.clone(), blob_store.clone()).await.expect("preserve administrator ownership"), 0);
  let preserved = tpl_repo.get_by_slug("myoxus-doc").await.unwrap().unwrap();
  assert_eq!(preserved.id, admin_id);
  assert_eq!(preserved.created_by, Some(owner_id));
  assert_eq!(preserved.name, "Administrator documentation");
  assert_eq!(registry.load(admin_id).await.unwrap().files, doc_before.files);
  myoxus_infrastructure::pdf_export::verify_active_pdf_template_engines(&pool).await.expect("protected Admin-owned reserved slug must also pass readiness");
  // Different roots racing for initial creation and same-version replacement
  // must preserve the winning bytes and reject the incompatible loser.
  wipe_system_templates(&pool).await;
  let mut roots = Vec::new();
  for label in ["first", "second"] {
    let root = tempfile::tempdir().unwrap();
    copy_tree(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf"), root.path());
    let path = root.path().join("default/main.typ");
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.extend_from_slice(format!("\n// {label} initial root\n").as_bytes());
    std::fs::write(path, bytes).unwrap();
    roots.push(root);
  }
  for replacement_race in [false, true] {
    if replacement_race {
      for (index, root) in roots.iter().enumerate() {
        let path = root.path().join("default/main.typ");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(format!("\n// replacement root {index}\n").as_bytes());
        std::fs::write(path, bytes).unwrap();
      }
    }
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let a: Arc<dyn PdfTemplateRepository> = Arc::new(ObservedSeedRepository::new(tpl_repo.clone(), barrier.clone(), replacement_race));
    let b: Arc<dyn PdfTemplateRepository> = Arc::new(ObservedSeedRepository::new(tpl_repo.clone(), barrier, replacement_race));
    let (a, b) = tokio::join!(
      seed_system_pdf_templates_from_root(a, blob_store.clone(), roots[0].path(), 16 * 1024 * 1024, std::time::Duration::from_secs(120)),
      seed_system_pdf_templates_from_root(b, blob_store.clone(), roots[1].path(), 16 * 1024 * 1024, std::time::Duration::from_secs(120)),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1, "exactly one incompatible root may activate: {a:?}, {b:?}");
    let (winner, loser) = if a.is_ok() { (0, b) } else { (1, a) };
    assert!(matches!(loser, Err(myoxus_domain::repositories::RepositoryError::Conflict(_))));
    assert_eq!(registry.load(default_id).await.unwrap().files["main.typ"], std::fs::read(roots[winner].path().join("default/main.typ")).unwrap());
    assert!(tpl_repo.list_files(default_id).await.unwrap().iter().all(|file| file.blob_key.contains("/revisions/")));
    assert_eq!(seed_system_pdf_templates_from_root(tpl_repo.clone(), blob_store.clone(), roots[winner].path(), 16 * 1024 * 1024, std::time::Duration::from_secs(120)).await.unwrap(), 0);
  }
  }).catch_unwind().await;

  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("cleanup owned workspaces");
  wipe_system_templates(&pool).await;
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("cleanup owner");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

async fn seed_system_pdf_templates(
  repository: Arc<dyn myoxus_domain::repositories::PdfTemplateRepository>,
  blob_store: Arc<PdfBlobStore>,
) -> Result<usize, myoxus_domain::repositories::RepositoryError> {
  seed_system_pdf_templates_from_root(
    repository,
    blob_store,
    &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf"),
    16 * 1024 * 1024,
    std::time::Duration::from_secs(120),
  )
  .await
}

/// Test-only observation barrier makes both writers capture the same initial
/// state. Subsequent conflict readback is never blocked by the barrier.
struct ObservedSeedRepository {
  inner: Arc<dyn PdfTemplateRepository>,
  barrier: Arc<tokio::sync::Barrier>,
  replacement: bool,
  observed: std::sync::atomic::AtomicBool,
}
impl ObservedSeedRepository {
  fn new(inner: Arc<dyn PdfTemplateRepository>, barrier: Arc<tokio::sync::Barrier>, replacement: bool) -> Self {
    Self {
      inner,
      barrier,
      replacement,
      observed: std::sync::atomic::AtomicBool::new(false),
    }
  }
  async fn synchronize_once(&self) {
    if !self.observed.swap(true, std::sync::atomic::Ordering::SeqCst) {
      self.barrier.wait().await;
    }
  }
}
#[async_trait::async_trait]
impl PdfTemplateRepository for ObservedSeedRepository {
  async fn list(
    &self,
    deleted: bool,
  ) -> myoxus_domain::repositories::RepoResult<Vec<myoxus_domain::entities::PdfTemplate>> {
    self.inner.list(deleted).await
  }
  async fn get_by_id(
    &self,
    id: Uuid,
  ) -> myoxus_domain::repositories::RepoResult<Option<myoxus_domain::entities::PdfTemplate>> {
    self.inner.get_by_id(id).await
  }
  async fn get_by_slug(
    &self,
    slug: &str,
  ) -> myoxus_domain::repositories::RepoResult<Option<myoxus_domain::entities::PdfTemplate>> {
    let result = self.inner.get_by_slug(slug).await;
    if slug == "default" && !self.replacement {
      self.synchronize_once().await;
    }
    result
  }
  async fn list_files(
    &self,
    id: Uuid,
  ) -> myoxus_domain::repositories::RepoResult<Vec<myoxus_domain::entities::PdfTemplateFile>> {
    let result = self.inner.list_files(id).await;
    if id == system_template_id("default") && self.replacement {
      self.synchronize_once().await;
    }
    result
  }
  async fn create(
    &self,
    row: &myoxus_domain::entities::PdfTemplate,
    files: &[myoxus_domain::entities::PdfTemplateFile],
    audit_actor: Option<myoxus_domain::audit::AuditActor>,
  ) -> myoxus_domain::repositories::RepoResult<()> {
    self.inner.create(row, files, audit_actor).await
  }
  async fn replace_bundle(
    &self,
    row: &myoxus_domain::entities::PdfTemplate,
    files: &[myoxus_domain::entities::PdfTemplateFile],
    expected: &myoxus_domain::entities::PdfTemplate,
    expected_files: &[myoxus_domain::entities::PdfTemplateFile],
    audit_actor: Option<myoxus_domain::audit::AuditActor>,
  ) -> myoxus_domain::repositories::RepoResult<()> {
    self
      .inner
      .replace_bundle(row, files, expected, expected_files, audit_actor)
      .await
  }
  async fn update_manifest(
    &self,
    id: Uuid,
    manifest: &serde_json::Value,
  ) -> myoxus_domain::repositories::RepoResult<()> {
    self.inner.update_manifest(id, manifest).await
  }
  async fn update_metadata(
    &self,
    id: Uuid,
    name: Option<&str>,
    description: Option<&str>,
    audit_actor: Option<myoxus_domain::audit::AuditActor>,
  ) -> myoxus_domain::repositories::RepoResult<myoxus_domain::entities::PdfTemplate> {
    self.inner.update_metadata(id, name, description, audit_actor).await
  }
  async fn soft_delete(
    &self,
    id: Uuid,
    audit_actor: Option<myoxus_domain::audit::AuditActor>,
  ) -> myoxus_domain::repositories::RepoResult<bool> {
    self.inner.soft_delete(id, audit_actor).await
  }
}
