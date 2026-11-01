//! Invariant tests for P125-TPL — Template Registry Builtin Bridge.
//!
//! Each test verifies a specific DB-state invariant after an operation,
//! per the Invariant-First Testing protocol (LRN-20260312-109).
//!
//! Invariant codes: INV-TPL-01 … INV-TPL-21

use myoxus_application::template_registry::{TemplateRegistryService, TemplateRegistryStore as _};
use myoxus_application::worker::WorkQueuePort;
use myoxus_domain::template_registry::{
  InstanceState, ProvisioningMode, RevisionState, SelectionMode, TemplateDefaultPolicy, TemplateRevision,
  TemplateSource, TemplateStatus, compute_builtin_expected_hash,
};
use myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore;
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

// ── Test infrastructure ───────────────────────────────────────────────────────

async fn setup_store(pool: &PgPool) -> Arc<SqlxTemplateRegistryStore> {
  Arc::new(SqlxTemplateRegistryStore::new(pool.clone()))
}

async fn create_builtin_entry(
  store: &SqlxTemplateRegistryStore,
  slug: &str,
) -> myoxus_domain::template_registry::TemplateCatalogEntry {
  create_builtin_entry_with_status(store, slug, TemplateStatus::Active).await
}

async fn create_builtin_entry_with_status(
  store: &SqlxTemplateRegistryStore,
  slug: &str,
  status: TemplateStatus,
) -> myoxus_domain::template_registry::TemplateCatalogEntry {
  create_builtin_entry_with_category(store, slug, status, "test").await
}

async fn create_builtin_entry_with_category(
  store: &SqlxTemplateRegistryStore,
  slug: &str,
  status: TemplateStatus,
  category: &str,
) -> myoxus_domain::template_registry::TemplateCatalogEntry {
  use chrono::Utc;
  let entry = myoxus_domain::template_registry::TemplateCatalogEntry {
    id: Uuid::new_v4(),
    slug: slug.to_string(),
    title: format!("Test {slug}"),
    description: None,
    category: Some(category.to_string()),
    tags: vec![],
    status,
    source: TemplateSource::Builtin,
    builder_version: Some(1),
    min_client_version: 0,
    created_at: Utc::now(),
    updated_at: Utc::now(),
    archived_at: None,
  };
  store.create_catalog_entry(&entry).await.expect("create entry");
  entry
}

async fn create_bundle_entry(
  store: &SqlxTemplateRegistryStore,
  slug: &str,
) -> myoxus_domain::template_registry::TemplateCatalogEntry {
  use chrono::Utc;
  let entry = myoxus_domain::template_registry::TemplateCatalogEntry {
    id: Uuid::new_v4(),
    slug: slug.to_string(),
    title: format!("Test {slug}"),
    description: None,
    category: Some("test".to_string()),
    tags: vec![],
    status: TemplateStatus::Active,
    source: TemplateSource::Bundle,
    builder_version: None,
    min_client_version: 0,
    created_at: Utc::now(),
    updated_at: Utc::now(),
    archived_at: None,
  };
  store.create_catalog_entry(&entry).await.expect("create bundle entry");
  entry
}

async fn create_published_bundle_entry(
  store: &SqlxTemplateRegistryStore,
  slug: &str,
) -> myoxus_domain::template_registry::TemplateCatalogEntry {
  use chrono::Utc;
  let entry = create_bundle_entry(store, slug).await;
  let now = Utc::now();
  store
    .create_revision(&TemplateRevision {
      id: Uuid::new_v4(),
      template_id: entry.id,
      version: "1.0.0".to_string(),
      state: RevisionState::Published,
      bundle_blob_id: None,
      preview_blob_id: None,
      checksum: None,
      manifest: None,
      release_notes: None,
      created_by: None,
      created_at: now,
      published_at: Some(now),
      source_format: "snapshot".to_string(),
      normalizer_version: "test".to_string(),
      detected_format: "snapshot".to_string(),
      ignored_entries_count: 0,
      error_catalog_version: "test".to_string(),
      normalization_warnings: Vec::new(),
    })
    .await
    .expect("create published bundle revision");
  entry
}

async fn seed_policy(store: &SqlxTemplateRegistryStore, template_id: Uuid) {
  use chrono::Utc;
  use myoxus_domain::template_registry::{ProvisioningMode, SelectionMode};
  let policy = TemplateDefaultPolicy {
    template_id,
    apply_to_new_workspaces: true,
    selection_mode: SelectionMode::Published,
    provisioning_mode: ProvisioningMode::ManagedUntilLocalEdit,
    created_at: Utc::now(),
    updated_at: Utc::now(),
  };
  store
    .upsert_default_policy(&policy)
    .await
    .expect("upsert_default_policy");
}

async fn seed_policy_for_workspace(store: &SqlxTemplateRegistryStore, template_id: Uuid, workspace_id: Uuid) {
  seed_policy(store, template_id).await;
  store
    .apply_default_policies_to_new_workspace(workspace_id)
    .await
    .expect("apply_default_policies");
}

/// Create a minimal user + workspace row so workspace_id FK constraints don't fire.
/// Returns (user_id, workspace_id). Both are cleaned up by the sqlx::test harness.
async fn create_test_workspace(pool: &PgPool) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'test')")
    .bind(user_id)
    .bind(format!("test-{}@tpl-inv.local", user_id))
    .execute(pool)
    .await
    .expect("insert test user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'test')")
    .bind(workspace_id)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("insert test workspace");
  (user_id, workspace_id)
}

#[derive(Default)]
struct CapturingTemplateQueue {
  jobs: Mutex<Vec<serde_json::Value>>,
}

#[async_trait::async_trait]
impl WorkQueuePort for CapturingTemplateQueue {
  async fn add_job(
    &self,
    _queue: &str,
    _job_name: &str,
    data: serde_json::Value,
    _max_attempts: Option<u32>,
    _delay_ms: Option<i64>,
  ) -> myoxus_application::auth::AuthResult<String> {
    self.jobs.lock().expect("queue lock").push(data);
    Ok(Uuid::new_v4().to_string())
  }
}

async fn create_test_doc(pool: &PgPool, workspace_id: Uuid, user_id: Uuid) -> Uuid {
  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)\n       VALUES ($1, $2, $3, 'viewer', FALSE, $4, $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("doc-{doc_id}"))
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert doc");

  mark_test_doc_as_template(pool, doc_id, user_id).await;

  doc_id
}

async fn create_test_doc_with_original_id(pool: &PgPool, workspace_id: Uuid, user_id: Uuid, external_id: &str) -> Uuid {
  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, external_id, default_role, is_workspace_root, created_by, updated_by)\n       VALUES ($1, $2, $3, $4, 'viewer', FALSE, $5, $5)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("doc-{external_id}"))
  .bind(external_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert original doc");

  mark_test_doc_as_template(pool, doc_id, user_id).await;

  doc_id
}

async fn mark_test_doc_as_template(pool: &PgPool, doc_id: Uuid, user_id: Uuid) {
  sqlx::query(
    "INSERT INTO document_template_state (doc_id, state, source, updated_by)\n     VALUES ($1, 'managed', 'document', $2)",
  )
  .bind(doc_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("attribute template doc");
}

// ── INV-TPL-01 ───────────────────────────────────────────────────────────────

/// INV-TPL-01: A builtin catalog entry must have builder_version IS NOT NULL
/// and source = 'builtin'.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_01_builtin_entry_has_builder_version(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-01-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let fetched = store.get_catalog_entry(entry.id).await.unwrap().unwrap();
  assert_eq!(fetched.source, TemplateSource::Builtin);
  assert!(
    fetched.builder_version.is_some(),
    "builder_version must be set for builtin"
  );
  assert_eq!(fetched.builder_version.unwrap(), 1);
}

// ── INV-TPL-02 ───────────────────────────────────────────────────────────────

/// INV-TPL-02: A bundle catalog entry must have builder_version IS NULL
/// and source = 'bundle'.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_02_bundle_entry_has_no_builder_version(pool: PgPool) {
  use chrono::Utc;
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-02-{}", Uuid::new_v4());
  let entry = myoxus_domain::template_registry::TemplateCatalogEntry {
    id: Uuid::new_v4(),
    slug,
    title: "Bundle template".to_string(),
    description: None,
    category: None,
    tags: vec![],
    status: TemplateStatus::Active,
    source: TemplateSource::Bundle,
    builder_version: None,
    min_client_version: 0,
    created_at: Utc::now(),
    updated_at: Utc::now(),
    archived_at: None,
  };
  store.create_catalog_entry(&entry).await.expect("create entry");

  let fetched = store.get_catalog_entry(entry.id).await.unwrap().unwrap();
  assert_eq!(fetched.source, TemplateSource::Bundle);
  assert!(
    fetched.builder_version.is_none(),
    "bundle must not have builder_version"
  );
}

// ── INV-TPL-03 ───────────────────────────────────────────────────────────────

/// INV-TPL-03: compute_builtin_expected_hash is deterministic and
/// changes when any input changes.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_03_expected_hash_deterministic(_pool: PgPool) {
  let h1 = compute_builtin_expected_hash("business-daily", 1, "en");
  let h2 = compute_builtin_expected_hash("business-daily", 1, "en");
  assert_eq!(h1, h2, "hash must be deterministic");

  let h_v2 = compute_builtin_expected_hash("business-daily", 2, "en");
  assert_ne!(h1, h_v2, "different version → different hash");

  let h_de = compute_builtin_expected_hash("business-daily", 1, "de");
  assert_ne!(h1, h_de, "different locale → different hash");
}

// ── INV-TPL-04 ───────────────────────────────────────────────────────────────

/// INV-TPL-04: apply_default_policies_to_new_workspace inserts exactly
/// one workspace_template_policies row per active default policy.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_04_apply_default_policies_seeds_workspace(pool: PgPool) {
  let store = setup_store(&pool).await;

  let slug_a = format!("inv-tpl-04a-{}", Uuid::new_v4());
  let slug_b = format!("inv-tpl-04b-{}", Uuid::new_v4());
  let entry_a = create_builtin_entry(&store, &slug_a).await;
  let entry_b = create_builtin_entry(&store, &slug_b).await;
  seed_policy(&store, entry_a.id).await;
  seed_policy(&store, entry_b.id).await;

  // Count total active default policies before seeding (migration may pre-seed some)
  let total_active: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM template_default_policies WHERE apply_to_new_workspaces = TRUE")
      .fetch_one(&pool)
      .await
      .expect("count active default policies");

  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  let n = store
    .apply_default_policies_to_new_workspace(workspace_id)
    .await
    .expect("apply_default_policies");

  assert_eq!(
    n, total_active as usize,
    "should have seeded exactly one policy per active default policy"
  );

  let policies = store
    .list_policies_for_workspace(workspace_id)
    .await
    .expect("list_policies");
  assert_eq!(
    policies.len() as i64,
    total_active,
    "DB must have one workspace_template_policies row per active default policy"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id IN ($1, $2)")
    .bind(entry_a.id)
    .bind(entry_b.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id IN ($1, $2)")
    .bind(entry_a.id)
    .bind(entry_b.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-05 ───────────────────────────────────────────────────────────────

/// INV-TPL-05: apply_default_policies is idempotent — calling it twice
/// does not duplicate workspace_template_policies rows.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_05_apply_default_policies_idempotent(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-05-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  seed_policy(&store, entry.id).await;

  let total_active: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM template_default_policies WHERE apply_to_new_workspaces = TRUE")
      .fetch_one(&pool)
      .await
      .expect("count active default policies");

  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  let n1 = store
    .apply_default_policies_to_new_workspace(workspace_id)
    .await
    .expect("first apply");
  assert_eq!(
    n1, total_active as usize,
    "first apply should seed one row per active default policy"
  );

  let n2 = store
    .apply_default_policies_to_new_workspace(workspace_id)
    .await
    .expect("second apply");
  assert_eq!(n2, 0, "second apply should seed 0 (idempotent)");

  let policies = store
    .list_policies_for_workspace(workspace_id)
    .await
    .expect("list_policies");
  assert_eq!(
    policies.len() as i64,
    total_active,
    "no duplicate rows created despite 2 apply calls"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

/// INV-TS12-01: workspace seeding persists delivery before enqueue and keeps
/// queue interruptions recoverable without duplicating assignments.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_ts12_workspace_defaults_schedule_durable_delivery(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-ts12-default-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  seed_policy(&store, entry.id).await;

  let (_first_user, first_workspace) = create_test_workspace(&pool).await;
  let service = TemplateRegistryService::new(store.clone());
  service
    .seed_default_policies_for_workspace(first_workspace)
    .await
    .expect("durable seeding remains successful while queue is unavailable");
  let pending: (String, serde_json::Value) =
    sqlx::query_as("SELECT state, summary_json FROM template_reconcile_jobs WHERE workspace_id = $1")
      .bind(first_workspace)
      .fetch_one(&pool)
      .await
      .expect("pending durable delivery");
  assert_eq!(pending.0, "pending");
  assert_eq!(pending.1["error"], "queue_unavailable");
  let recoverable = store
    .list_recoverable_workspace_reconcile_jobs(200)
    .await
    .expect("list durable delivery recovery");
  assert_eq!(recoverable.len(), 1);
  assert_eq!(recoverable[0].workspace_id, Some(first_workspace));

  let (_second_user, second_workspace) = create_test_workspace(&pool).await;
  let queue = Arc::new(CapturingTemplateQueue::default());
  let queued_service = TemplateRegistryService::new(store.clone())
    .with_reconcile_queue(queue.clone())
    .expect("configure queue once");
  queued_service
    .seed_default_policies_for_workspace(second_workspace)
    .await
    .expect("seed and enqueue defaults");
  let queued: (String, serde_json::Value) =
    sqlx::query_as("SELECT state, summary_json FROM template_reconcile_jobs WHERE workspace_id = $1")
      .bind(second_workspace)
      .fetch_one(&pool)
      .await
      .expect("queued durable delivery");
  assert_eq!(queued.0, "pending");
  assert_eq!(queued.1["delivery"], "queued");
  let jobs = queue.jobs.lock().expect("queue lock");
  assert_eq!(jobs.len(), 1);
  assert_eq!(jobs[0]["workspaceId"], second_workspace.to_string());
  drop(jobs);

  let policies_before = store
    .list_policies_for_workspace(second_workspace)
    .await
    .expect("list seeded policies")
    .len();
  queued_service
    .seed_default_policies_for_workspace(second_workspace)
    .await
    .expect("idempotent retry");
  assert_eq!(
    store
      .list_policies_for_workspace(second_workspace)
      .await
      .expect("list retried policies")
      .len(),
    policies_before
  );
  assert_eq!(queue.jobs.lock().expect("queue lock").len(), 1);
}

/// INV-TS12-02: startup installs a missing shipped default exactly once and
/// never overwrites an operator's existing opt-out or update policy.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_ts12_shipped_defaults_preserve_operator_policy(pool: PgPool) {
  let store = setup_store(&pool).await;
  let service = TemplateRegistryService::new(store.clone());
  let fresh = create_published_bundle_entry(&store, &format!("inv-ts12-fresh-{}", Uuid::new_v4())).await;
  assert!(
    service
      .ensure_shipped_default_policy(&fresh.slug)
      .await
      .expect("install missing shipped default")
  );
  assert!(
    !service
      .ensure_shipped_default_policy(&fresh.slug)
      .await
      .expect("repeat shipped default installation")
  );
  let fresh_default = store
    .list_default_policies()
    .await
    .unwrap()
    .into_iter()
    .find(|policy| policy.template_id == fresh.id)
    .unwrap();
  assert_eq!(fresh_default.provisioning_mode, ProvisioningMode::ManagedUntilLocalEdit);

  let opted_out = create_published_bundle_entry(&store, &format!("inv-ts12-optout-{}", Uuid::new_v4())).await;
  let now = chrono::Utc::now();
  store
    .upsert_default_policy(&TemplateDefaultPolicy {
      template_id: opted_out.id,
      apply_to_new_workspaces: false,
      selection_mode: SelectionMode::Published,
      provisioning_mode: ProvisioningMode::ManualUpdate,
      created_at: now,
      updated_at: now,
    })
    .await
    .expect("seed operator opt-out");
  assert!(
    !service
      .ensure_shipped_default_policy(&opted_out.slug)
      .await
      .expect("preserve existing operator policy")
  );
  let preserved = store
    .list_default_policies()
    .await
    .expect("read default policies")
    .into_iter()
    .find(|policy| policy.template_id == opted_out.id)
    .expect("operator policy remains");
  assert!(!preserved.apply_to_new_workspaces);
  assert_eq!(preserved.provisioning_mode, ProvisioningMode::ManualUpdate);
}

// ── INV-TPL-05B ──────────────────────────────────────────────────────────────

/// INV-TPL-05B: default policy seeding materializes active builtin and published
/// bundle policies. Unpublished bundles and disabled entries may keep default-policy rows,
/// but they must not enroll newly created workspaces.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_ts09_default_policies_include_bundles_and_filter_disabled_entries(pool: PgPool) {
  let store = setup_store(&pool).await;
  let active_slug = format!("inv-tpl-05b-active-{}", Uuid::new_v4());
  let disabled_slug = format!("inv-tpl-05b-disabled-{}", Uuid::new_v4());
  let active_entry = create_builtin_entry(&store, &active_slug).await;
  let bundle_slug = format!("inv-tpl-05b-bundle-{}", Uuid::new_v4());
  let bundle_entry = create_published_bundle_entry(&store, &bundle_slug).await;
  let unpublished_slug = format!("inv-tpl-05b-unpublished-{}", Uuid::new_v4());
  let unpublished_entry = create_bundle_entry(&store, &unpublished_slug).await;
  let disabled_entry = create_builtin_entry_with_status(&store, &disabled_slug, TemplateStatus::Disabled).await;
  seed_policy(&store, active_entry.id).await;
  seed_policy(&store, bundle_entry.id).await;
  seed_policy(&store, unpublished_entry.id).await;
  seed_policy(&store, disabled_entry.id).await;

  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  store
    .apply_default_policies_to_new_workspace(workspace_id)
    .await
    .expect("apply_default_policies");

  let active_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE workspace_id = $1 AND template_id = $2")
      .bind(workspace_id)
      .bind(active_entry.id)
      .fetch_one(&pool)
      .await
      .expect("active count");
  let disabled_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE workspace_id = $1 AND template_id = $2")
      .bind(workspace_id)
      .bind(disabled_entry.id)
      .fetch_one(&pool)
      .await
      .expect("disabled count");
  let bundle_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE workspace_id = $1 AND template_id = $2")
      .bind(workspace_id)
      .bind(bundle_entry.id)
      .fetch_one(&pool)
      .await
      .expect("bundle count");

  let unpublished_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE workspace_id = $1 AND template_id = $2")
      .bind(workspace_id)
      .bind(unpublished_entry.id)
      .fetch_one(&pool)
      .await
      .expect("unpublished count");
  assert_eq!(
    unpublished_count, 0,
    "unpublished bundle default must not enroll a workspace"
  );

  assert_eq!(active_count, 1, "active builtin default policy should be seeded");
  assert_eq!(bundle_count, 1, "active bundle default policy should be seeded");
  assert_eq!(disabled_count, 0, "disabled builtin default policy must not be seeded");

  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clean up native default policy fixture");
  sqlx::query("DELETE FROM template_default_policies WHERE template_id IN ($1, $2, $3, $4)")
    .bind(active_entry.id)
    .bind(bundle_entry.id)
    .bind(disabled_entry.id)
    .bind(unpublished_entry.id)
    .execute(&pool)
    .await
    .expect("clean up native default policy fixture");
  sqlx::query("DELETE FROM template_catalog_entries WHERE id IN ($1, $2, $3, $4)")
    .bind(active_entry.id)
    .bind(bundle_entry.id)
    .bind(disabled_entry.id)
    .bind(unpublished_entry.id)
    .execute(&pool)
    .await
    .expect("clean up native default policy fixture");
}

// ── INV-TPL-06 ───────────────────────────────────────────────────────────────

/// INV-TPL-06: bump_builder_version increments the counter and returns the new value.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_06_bump_builder_version_increments(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-06-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  assert_eq!(entry.builder_version.unwrap(), 1);

  struct RecordingNotifications {
    pool: PgPool,
    attempts: Mutex<Vec<(Uuid, String, u32)>>,
    fail: std::sync::atomic::AtomicBool,
  }
  #[async_trait::async_trait]
  impl myoxus_application::template_registry::TemplateBuilderNotificationPort for RecordingNotifications {
    async fn notify(&self, workspace: Uuid, slug: &str, version: u32) -> myoxus_application::auth::AuthResult<()> {
      let committed: i32 = sqlx::query_scalar("SELECT builder_version FROM template_catalog_entries WHERE slug=$1")
        .bind(slug)
        .fetch_one(&self.pool)
        .await
        .expect("read committed version from notification port");
      assert_eq!(committed as u32, version, "notification must follow the commit");
      self
        .attempts
        .lock()
        .expect("attempts")
        .push((workspace, slug.to_owned(), version));
      if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
        Err(myoxus_application::auth::AuthError::Storage(
          "injected notification failure".into(),
        ))
      } else {
        Ok(())
      }
    }
  }
  let mut enabled = Vec::new();
  for is_enabled in [true, true, false] {
    let (_, workspace) = create_test_workspace(&pool).await;
    sqlx::query("INSERT INTO workspace_template_policies(workspace_id,template_id,selection_mode,provisioning_mode,is_enabled) VALUES($1,$2,'published','seed_once',$3)")
      .bind(workspace).bind(entry.id).bind(is_enabled).execute(&pool).await.expect("policy");
    if is_enabled {
      enabled.push(workspace);
    }
  }
  enabled.sort();
  let notifications = Arc::new(RecordingNotifications {
    pool: pool.clone(),
    attempts: Mutex::new(Vec::new()),
    fail: std::sync::atomic::AtomicBool::new(false),
  });
  let service = TemplateRegistryService::new(store.clone()).with_builder_notifications(notifications.clone());
  for (expected, fail) in [(2, false), (3, true)] {
    notifications.fail.store(fail, std::sync::atomic::Ordering::SeqCst);
    notifications.attempts.lock().expect("attempts").clear();
    let (version, mut affected) = service
      .bump_builder_version(&slug)
      .await
      .expect("committed bump remains successful");
    assert_eq!(
      version, expected,
      "one increment per call even if every notification fails"
    );
    affected.sort();
    assert_eq!(affected, enabled, "only enabled policies are targeted");
    let attempts = notifications.attempts.lock().expect("attempts");
    assert_eq!(
      attempts.len(),
      enabled.len(),
      "a failed attempt must not suppress remaining workspaces"
    );
    let mut notified_workspaces: Vec<_> = attempts.iter().map(|attempt| attempt.0).collect();
    notified_workspaces.sort();
    assert_eq!(notified_workspaces, enabled, "exactly one attempt for every target");
    for (workspace, notified_slug, notified_version) in attempts.iter() {
      assert!(enabled.contains(workspace));
      assert_eq!(notified_slug, &slug);
      assert_eq!(*notified_version, expected);
    }
    drop(attempts);
    let fetched = store
      .get_catalog_entry(entry.id)
      .await
      .expect("catalog")
      .expect("retained catalog");
    assert_eq!(fetched.builder_version, Some(expected));
  }
  // SQLx owns this isolated database and drops all fixture rows after the test.
}

// ── INV-TPL-07 ───────────────────────────────────────────────────────────────

/// INV-TPL-07: upsert_builtin_instance_applied stores applied_hash and locale_hash.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_07_upsert_builtin_instance_stores_hashes(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-07-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  let doc_id = create_test_doc(&pool, workspace_id, user_id).await;
  let doc_key = doc_id.to_string();
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&doc_key))
    .await
    .expect("upsert");

  let row = sqlx::query_as::<_, (Option<String>, Option<String>)>(
    "SELECT last_applied_hash, locale_hash FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_optional(&pool)
  .await
  .expect("query")
  .expect("row must exist");

  assert_eq!(
    row.0.as_deref(),
    Some(expected_hash.as_str()),
    "last_applied_hash must be stored"
  );
  assert_eq!(row.1.as_deref(), Some("en"), "locale_hash must be 'en'");

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-08 ───────────────────────────────────────────────────────────────

/// INV-TPL-08: retire_builtin_instance sets state = 'retired' and retired_at IS NOT NULL.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_08_retire_sets_retired_state(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-08-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let hash = compute_builtin_expected_hash(&slug, 1, "en");
  let doc_id = create_test_doc(&pool, workspace_id, user_id).await;
  let doc_key = doc_id.to_string();
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &hash, "en", Some(&doc_key))
    .await
    .expect("upsert");

  store
    .retire_builtin_instance(workspace_id, &slug)
    .await
    .expect("retire");

  let state_str: Option<String> =
    sqlx::query_scalar("SELECT state FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
      .bind(workspace_id)
      .bind(entry.id)
      .fetch_optional(&pool)
      .await
      .expect("query");

  assert_eq!(state_str.as_deref(), Some("retired"), "state must be 'retired'");

  let retired_at: Option<bool> = sqlx::query_scalar(
    "SELECT retired_at IS NOT NULL FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_optional(&pool)
  .await
  .expect("query");

  assert_eq!(retired_at, Some(true), "retired_at must be set");

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-09 ───────────────────────────────────────────────────────────────

/// INV-TPL-09: list_builtin_reconcile_entries returns the correct expected_hash
/// for a workspace with a builtin policy but no applied instance.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_09_reconcile_entries_include_expected_hash(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-09-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  // Apply default policy directly so workspace has a policy
  seed_policy(&store, entry.id).await;
  store
    .apply_default_policies_to_new_workspace(workspace_id)
    .await
    .expect("seed policies");

  let entries = store
    .list_builtin_reconcile_entries(workspace_id, "fr")
    .await
    .expect("list_reconcile_entries");

  let our = entries.iter().find(|e| e.slug == slug).expect("slug must appear");
  let expected = compute_builtin_expected_hash(&slug, 1, "fr");
  assert_eq!(
    our.expected_hash, expected,
    "expected_hash must be sha256(slug|version|locale)"
  );
  assert!(our.current_instance.is_none(), "no instance applied yet");

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-10 ───────────────────────────────────────────────────────────────

/// INV-TPL-10: upsert_builtin_instance_applied is idempotent — calling
/// it twice with the same hash does not create duplicate rows.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_10_upsert_builtin_instance_idempotent(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-10-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let hash = compute_builtin_expected_hash(&slug, 1, "en");
  let doc_id = create_test_doc(&pool, workspace_id, user_id).await;
  let doc_key = doc_id.to_string();
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &hash, "en", Some(&doc_key))
    .await
    .expect("first upsert");
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &hash, "en", Some(&doc_key))
    .await
    .expect("second upsert");

  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("count");

  assert_eq!(count, 1, "exactly 1 instance row despite 2 upserts");

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-15 ───────────────────────────────────────────────────────────────

/// INV-TPL-15: upsert_builtin_instance_applied stores the provided workspace_doc_id
/// and keeps the expected hash coherent with the supplied applied hash.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_15_builtin_instance_applied_stores_workspace_doc_id(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-15-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  let workspace_doc_id = create_test_doc(&pool, workspace_id, user_id).await;

  store
    .upsert_builtin_instance_applied(
      workspace_id,
      &slug,
      &expected_hash,
      "en",
      Some(workspace_doc_id.to_string().as_str()),
    )
    .await
    .expect("upsert");

  let row = sqlx::query_as::<_, (Option<uuid::Uuid>, Option<String>)>(
    "SELECT workspace_doc_id, expected_hash FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_optional(&pool)
  .await
  .expect("query")
  .expect("row must exist");

  assert_eq!(row.0, Some(workspace_doc_id), "workspace_doc_id must be persisted");
  assert_eq!(
    row.1.as_deref(),
    Some(expected_hash.as_str()),
    "expected_hash should match the applied hash sent to upsert"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-16 ───────────────────────────────────────────────────────────────

/// INV-TPL-16: reconcile rows expose workspace_doc_id from the current
/// instance row so the client can treat server state as authoritative.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_16_reconcile_entry_includes_workspace_doc_id(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-16-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;

  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  let workspace_doc_id = create_test_doc(&pool, workspace_id, user_id).await;
  store
    .upsert_builtin_instance_applied(
      workspace_id,
      &slug,
      &expected_hash,
      "en",
      Some(workspace_doc_id.to_string().as_str()),
    )
    .await
    .expect("upsert");

  let reconcile = store
    .list_builtin_reconcile_entries(workspace_id, "en")
    .await
    .expect("list_reconcile_entries");

  let reconcile_entry = reconcile.iter().find(|e| e.slug == slug).expect("slug must be present");
  let current_instance = reconcile_entry.current_instance.as_ref().expect("instance state");
  assert_eq!(
    current_instance.workspace_doc_id,
    Some(workspace_doc_id),
    "reconcile should expose workspace_doc_id from state"
  );
  assert_eq!(current_instance.state, InstanceState::Ok);
  assert!(current_instance.source_available);

  store
    .retire_builtin_instance(workspace_id, &slug)
    .await
    .expect("retire instance");
  let retired = store
    .list_builtin_reconcile_entries(workspace_id, "de")
    .await
    .expect("list retired reconcile entry");
  assert_eq!(
    retired
      .iter()
      .find(|candidate| candidate.slug == slug)
      .and_then(|candidate| candidate.current_instance.as_ref())
      .map(|instance| instance.state),
    Some(InstanceState::Retired),
    "server lifecycle state must remain visible independent of viewer locale"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_ts03_missing_builtin_source_is_repaired_once(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-ts03-repair-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let original = create_test_doc(&pool, workspace_id, user_id).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&original.to_string()))
    .await
    .expect("bind original source");
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(original)
    .execute(&pool)
    .await
    .expect("trash original source");

  let missing = store
    .list_builtin_reconcile_entries(workspace_id, "en")
    .await
    .expect("project missing source");
  let missing = missing
    .iter()
    .find(|candidate| candidate.slug == slug)
    .expect("reconcile entry");
  assert!(
    !missing
      .current_instance
      .as_ref()
      .expect("binding remains visible")
      .source_available,
    "a binding row must not masquerade as a live source"
  );

  let replacement_a = create_test_doc(&pool, workspace_id, user_id).await;
  let replacement_b = create_test_doc(&pool, workspace_id, user_id).await;
  let replacement_a_key = replacement_a.to_string();
  let replacement_b_key = replacement_b.to_string();
  let first =
    store.upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&replacement_a_key));
  let second =
    store.upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&replacement_b_key));
  let (first, second) = tokio::join!(first, second);
  assert_ne!(first.is_ok(), second.is_ok(), "one competing repair must win");

  let rows: Vec<(Uuid, String)> = sqlx::query_as(
    "SELECT workspace_doc_id, state FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_all(&pool)
  .await
  .expect("read canonical repaired binding");
  assert_eq!(rows.len(), 1);
  assert!(matches!(rows[0].0, id if id == replacement_a || id == replacement_b));
  assert_eq!(rows[0].1, "ok");
}

#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_ts03_central_retirement_evidence_blocks_blind_repair(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-ts03-retired-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let original = create_test_doc(&pool, workspace_id, user_id).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&original.to_string()))
    .await
    .expect("bind original source");
  store
    .retire_builtin_instance(workspace_id, &slug)
    .await
    .expect("retire binding");
  let instance_id: Uuid =
    sqlx::query_scalar("SELECT id FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
      .bind(workspace_id)
      .bind(entry.id)
      .fetch_one(&pool)
      .await
      .expect("read retired instance");
  sqlx::query(
    "INSERT INTO template_registry_audit_events
       (id, action, event_type, template_id, workspace_id, instance_id)
     VALUES ($1, 'deleted', 'template.assignment.retired', $2, $3, $4)",
  )
  .bind(Uuid::new_v4())
  .bind(entry.id)
  .bind(workspace_id)
  .bind(instance_id)
  .execute(&pool)
  .await
  .expect("record central retirement evidence");
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(original)
    .execute(&pool)
    .await
    .expect("remove retired source");
  let replacement = create_test_doc(&pool, workspace_id, user_id).await;

  let result = store
    .upsert_builtin_instance_applied(
      workspace_id,
      &slug,
      &expected_hash,
      "en",
      Some(&replacement.to_string()),
    )
    .await;
  assert!(
    result.is_err(),
    "ambiguous central retirement must require operator repair"
  );
}

// ── INV-TPL-17 ───────────────────────────────────────────────────────────────

/// INV-TPL-17: a client report cannot publish readiness before the document row
/// and native attribution exist.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_17_builtin_instance_applied_rejects_missing_document(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-17-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  let client_doc_id = "nQheoH8npsjQhquql4Pac";
  let result = store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(client_doc_id))
    .await;
  assert!(result.is_err(), "missing document must reject completion");
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("count instances");
  assert_eq!(count, 0, "rejected completion must not create an instance");

  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-18 ───────────────────────────────────────────────────────────────

/// INV-TPL-18: once a non-UUID client document has synced to `docs`, reporting
/// the same key resolves the FK while still returning the original client key.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_18_builtin_instance_applied_resolves_synced_external_id(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-18-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;

  let client_doc_id = format!("BuiltinDoc{}", Uuid::new_v4().simple());
  let resolved_doc_id = create_test_doc_with_original_id(&pool, workspace_id, user_id, &client_doc_id).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "de");

  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "de", Some(&client_doc_id))
    .await
    .expect("upsert");

  let row = sqlx::query_as::<_, (Option<uuid::Uuid>, Option<String>)>(
    "SELECT workspace_doc_id, workspace_doc_key
     FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_optional(&pool)
  .await
  .expect("query")
  .expect("row must exist");

  assert_eq!(
    row.0,
    Some(resolved_doc_id),
    "synced external_id must resolve to the docs FK"
  );
  assert_eq!(
    row.1.as_deref(),
    Some(client_doc_id.as_str()),
    "instance must keep the client-facing document key"
  );

  let reconcile = store
    .list_builtin_reconcile_entries(workspace_id, "de")
    .await
    .expect("list_reconcile_entries");
  let current_instance = reconcile
    .iter()
    .find(|entry| entry.slug == slug)
    .and_then(|entry| entry.current_instance.as_ref())
    .expect("current instance");
  assert_eq!(current_instance.workspace_doc_id, Some(resolved_doc_id));
  assert_eq!(
    current_instance.workspace_doc_key.as_deref(),
    Some(client_doc_id.as_str())
  );

  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

/// A UUID-shaped editor key is still an external key. It must resolve the
/// document carrying that exact key instead of being treated as an internal FK.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_22_builtin_instance_resolves_uuid_shaped_external_key(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-22-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;

  let external_key = Uuid::new_v4().to_string();
  let resolved_doc_id = create_test_doc_with_original_id(&pool, workspace_id, user_id, &external_key).await;
  assert_ne!(resolved_doc_id.to_string(), external_key);
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");

  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&external_key))
    .await
    .expect("UUID-shaped external key must resolve");

  let binding: (Option<Uuid>, Option<String>) = sqlx::query_as(
    "SELECT workspace_doc_id, workspace_doc_key FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("load binding");
  assert_eq!(binding.0, Some(resolved_doc_id));
  assert_eq!(binding.1.as_deref(), Some(external_key.as_str()));
}

/// A live document without native template classification cannot be reported
/// as a completed reusable source.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_23_builtin_instance_rejects_unattributed_document(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-23-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let doc_key = format!("Unattributed{}", Uuid::new_v4().simple());
  let doc_id = create_test_doc_with_original_id(&pool, workspace_id, user_id, &doc_key).await;
  sqlx::query("DELETE FROM document_template_state WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("remove attribution for negative fixture");

  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  let result = store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&doc_key))
    .await;
  assert!(result.is_err(), "unattributed source must reject completion");
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("count bindings");
  assert_eq!(count, 0);
}

/// Onboarding builders create ordinary seed content. A durable onboarding
/// document therefore completes its Registry binding without native template
/// attribution, while reusable source categories remain protected by
/// `inv_tpl_23_builtin_instance_rejects_unattributed_document`.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_23a_builtin_onboarding_accepts_ordinary_document(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-23a-{}", Uuid::new_v4());
  let entry = create_builtin_entry_with_category(&store, &slug, TemplateStatus::Active, "onboarding").await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let doc_key = format!("Onboarding{}", Uuid::new_v4().simple());
  let doc_id = create_test_doc_with_original_id(&pool, workspace_id, user_id, &doc_key).await;
  sqlx::query("DELETE FROM document_template_state WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("leave onboarding fixture as ordinary content");

  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&doc_key))
    .await
    .expect("ordinary onboarding document must complete its binding");

  let binding: (Option<Uuid>, Option<String>) = sqlx::query_as(
    "SELECT workspace_doc_id, workspace_doc_key FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("load onboarding binding");
  assert_eq!(binding.0, Some(doc_id));
  assert_eq!(binding.1.as_deref(), Some(doc_key.as_str()));

  let template_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count native template state");
  assert_eq!(template_rows, 0, "onboarding content must remain ordinary");
}

/// A source key from another workspace must never satisfy a report in the
/// requested workspace, even when the caller can access both workspaces.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_24_builtin_instance_rejects_cross_workspace_document(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-24-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  let foreign_workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'foreign')")
    .bind(foreign_workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert foreign workspace");
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let foreign_doc_key = format!("Foreign{}", Uuid::new_v4().simple());
  create_test_doc_with_original_id(&pool, foreign_workspace_id, user_id, &foreign_doc_key).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");

  let result = store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&foreign_doc_key))
    .await;
  assert!(result.is_err(), "cross-workspace source must reject completion");
}

/// The application boundary rejects an older or otherwise mismatched builder
/// hash before it can publish a ready binding.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_25_report_applied_rejects_stale_builder_hash(pool: PgPool) {
  let store = setup_store(&pool).await;
  let service = TemplateRegistryService::new(store.clone());
  let slug = format!("inv-tpl-25-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let doc_id = create_test_doc(&pool, workspace_id, user_id).await;

  let result = service
    .report_builder_applied(
      workspace_id,
      &slug,
      "hash-from-an-older-builder",
      "en",
      Some(&doc_id.to_string()),
    )
    .await;
  assert!(result.is_err(), "stale builder completion must be rejected");
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("count bindings");
  assert_eq!(count, 0);
}

// ── INV-TPL-19 ───────────────────────────────────────────────────────────────

/// INV-TPL-19: a rebuilt builtin may re-apply a previously retired instance,
/// but reapply must clear the retirement marker so reconcile sees the row again.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_19_reapply_clears_retired_marker_and_reconciles(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-19-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;
  let client_doc_id = format!("RetiredThenRebuilt{}", Uuid::new_v4().simple());
  let resolved_doc_id = create_test_doc_with_original_id(&pool, workspace_id, user_id, &client_doc_id).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");

  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&client_doc_id))
    .await
    .expect("first upsert");
  store
    .retire_builtin_instance(workspace_id, &slug)
    .await
    .expect("retire");
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some(&client_doc_id))
    .await
    .expect("reapply should reactivate existing row");

  let row = sqlx::query_as::<
    _,
    (
      String,
      Option<chrono::DateTime<chrono::Utc>>,
      Option<uuid::Uuid>,
      Option<String>,
    ),
  >(
    "SELECT state, retired_at, workspace_doc_id, workspace_doc_key
     FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_optional(&pool)
  .await
  .expect("query")
  .expect("row must exist");

  assert_eq!(row.0, "ok");
  assert!(row.1.is_none(), "reapply must clear retired_at");
  assert_eq!(row.2, Some(resolved_doc_id));
  assert_eq!(row.3.as_deref(), Some(client_doc_id.as_str()));

  let reconcile = store
    .list_builtin_reconcile_entries(workspace_id, "en")
    .await
    .expect("list_reconcile_entries");
  let current_instance = reconcile
    .iter()
    .find(|entry| entry.slug == slug)
    .and_then(|entry| entry.current_instance.as_ref())
    .expect("reactivated instance must be visible");
  assert_eq!(
    current_instance.workspace_doc_key.as_deref(),
    Some(client_doc_id.as_str())
  );

  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-20 ───────────────────────────────────────────────────────────────

/// INV-TPL-20: builder-applied reports are accepted only when the workspace has
/// an active enabled policy for the builtin slug.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_20_report_applied_requires_workspace_policy(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-20-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;

  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  let result = store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "en", Some("docWithoutPolicy"))
    .await;

  assert!(result.is_err(), "upsert without active workspace policy must fail");
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("count");
  assert_eq!(count, 0, "failed report must not write an instance row");

  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-11 ───────────────────────────────────────────────────────────────

/// INV-TPL-11: template_default_policies deletion cascades when the catalog
/// entry is deleted.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_11_default_policy_cascades_on_entry_delete(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-11-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  seed_policy(&store, entry.id).await;

  // Verify policy exists
  let policies = store.list_default_policies().await.expect("list");
  assert!(
    policies.iter().any(|p| p.template_id == entry.id),
    "policy must exist before cascade"
  );

  // Delete the catalog entry
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .expect("delete entry");

  // Policy must be gone too (ON DELETE CASCADE)
  let after = store.list_default_policies().await.expect("list after");
  assert!(
    !after.iter().any(|p| p.template_id == entry.id),
    "policy must be cascade-deleted when catalog entry is deleted"
  );
}

// ── INV-TPL-12 ───────────────────────────────────────────────────────────────

/// INV-TPL-12: Importing a bundle whose slug matches an existing builtin entry
/// must be rejected — no new DB row must be created.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_12_bundle_import_rejected_for_builtin_slug(pool: PgPool) {
  let slug = format!("inv-tpl-12-{}", Uuid::new_v4());
  let store = Arc::new(SqlxTemplateRegistryStore::new(pool.clone()));
  let service = TemplateRegistryService::new(
    store.clone() as Arc<dyn myoxus_application::template_registry::TemplateRegistryStore>
  );

  // Pre-register the slug as a builtin entry.
  create_builtin_entry(&store, &slug).await;

  // Need a real user for the import job FK
  let (user_id, _workspace_id) = create_test_workspace(&pool).await;

  let bundle = myoxus_application::template_registry::bundle::create_export_bundle(
    &myoxus_application::template_registry::bundle::Manifest {
      template_id: slug.clone(),
      version: "1.0.0".to_string(),
      title: "Test".to_string(),
      description: None,
      category: None,
      tags: vec![],
      locale: None,
      kind: None,
      min_server_version: None,
      checksum: None,
      localized_contents: std::collections::BTreeMap::new(),
      title_policy: None,
      purpose: None,
    },
    &yjs::markdown_to_yjs("Test", "Valid native template content").expect("native template fixture"),
    None,
    &std::collections::BTreeMap::new(),
  )
  .expect("build bundle");

  let result = service
    .import_from_bundle_with_filename_detailed(&bundle, "test.zip", user_id)
    .await;
  assert!(result.is_err(), "import must be rejected for builtin slug");
  let msg = result.unwrap_err().to_string();
  assert!(msg.contains("builtin"), "error must mention 'builtin': {msg}");

  // No new bundle entry created — only the original builtin entry exists for this slug.
  let fetched = store.get_catalog_entry_by_slug(&slug).await.expect("lookup");
  assert_eq!(
    fetched.as_ref().map(|e| e.source),
    Some(TemplateSource::Builtin),
    "slug must still be owned by the builtin entry"
  );
}

// ── INV-TPL-13 ───────────────────────────────────────────────────────────────

/// INV-TPL-13: An archived template catalog entry must NOT appear in the
/// workspace reconcile list even when a workspace policy exists for it.
///
/// Negative assertion: removing `c.status = 'active'` from the SQL filter
/// would allow archived slugs to appear and this test would fail.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_13_archived_template_excluded_from_reconcile_list(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-13-{}", Uuid::new_v4());

  // Create a builtin entry with status=Archived
  use chrono::Utc;
  let entry = myoxus_domain::template_registry::TemplateCatalogEntry {
    id: Uuid::new_v4(),
    slug: slug.clone(),
    title: format!("Archived {slug}"),
    description: None,
    category: Some("test".to_string()),
    tags: vec![],
    status: TemplateStatus::Archived,
    source: TemplateSource::Builtin,
    builder_version: Some(1),
    min_client_version: 0,
    created_at: Utc::now(),
    updated_at: Utc::now(),
    archived_at: Some(Utc::now()),
  };
  store.create_catalog_entry(&entry).await.expect("create archived entry");

  // Seed a default policy (enabled) and apply it to a workspace
  seed_policy(&store, entry.id).await;
  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  store
    .apply_default_policies_to_new_workspace(workspace_id)
    .await
    .expect("apply default policies");

  // The archived slug must NOT appear in the reconcile list
  let entries = store
    .list_builtin_reconcile_entries(workspace_id, "en")
    .await
    .expect("list_reconcile_entries");

  let found = entries.iter().any(|e| e.slug == slug);
  assert!(
    !found,
    "Archived template '{slug}' must be excluded from reconcile list (c.status='active' filter)"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-14 ───────────────────────────────────────────────────────────────

/// INV-TPL-14: A workspace policy with is_enabled=FALSE must NOT cause the
/// template to appear in the workspace reconcile list even when the catalog
/// entry is active.
///
/// Negative assertion: removing `p.is_enabled = TRUE` from the SQL filter
/// would allow disabled policies to show up and this test would fail.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_14_disabled_policy_excluded_from_reconcile_list(pool: PgPool) {
  use chrono::Utc;
  use myoxus_domain::template_registry::{ProvisioningMode, SelectionMode, WorkspaceTemplatePolicy};

  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-14-{}", Uuid::new_v4());

  // Create an active builtin entry
  let entry = create_builtin_entry(&store, &slug).await;

  // Insert a workspace policy directly with is_enabled = FALSE
  let (_user_id, workspace_id) = create_test_workspace(&pool).await;
  let policy = WorkspaceTemplatePolicy {
    id: Uuid::new_v4(),
    workspace_id,
    template_id: entry.id,
    selection_mode: SelectionMode::Published,
    selected_revision_id: None,
    provisioning_mode: ProvisioningMode::ManagedUntilLocalEdit,
    is_enabled: false, // explicitly disabled
    created_at: Utc::now(),
    updated_at: Utc::now(),
  };
  store.create_policy(&policy).await.expect("create disabled policy");

  // The active template with a disabled policy must NOT appear in the reconcile list
  let entries = store
    .list_builtin_reconcile_entries(workspace_id, "en")
    .await
    .expect("list_reconcile_entries");

  let found = entries.iter().any(|e| e.slug == slug);
  assert!(
    !found,
    "Template '{slug}' with is_enabled=FALSE must be excluded from reconcile list (p.is_enabled=TRUE filter)"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-TPL-21 ───────────────────────────────────────────────────────────────

/// INV-TPL-21: Builtin bridge rows intentionally have NULL `revision_id` and
/// must never poison the revision-backed instance APIs used by bundle
/// assignment, worker reconcile and Admin listing.
///
/// Negative assertion: if the generic instance queries read builtin rows again,
/// this test either panics on NULL `revision_id` or returns a row through the
/// wrong API surface.
#[sqlx::test(migrations = "../infrastructure/migrations")]
async fn inv_tpl_21_builtin_rows_are_hidden_from_revision_backed_instance_api(pool: PgPool) {
  let store = setup_store(&pool).await;
  let slug = format!("inv-tpl-21-{}", Uuid::new_v4());
  let entry = create_builtin_entry(&store, &slug).await;
  let (user_id, workspace_id) = create_test_workspace(&pool).await;
  seed_policy_for_workspace(&store, entry.id, workspace_id).await;

  let expected_hash = compute_builtin_expected_hash(&slug, 1, "de");
  let doc_key = format!("builtinDocKeyForInvTpl21-{}", Uuid::new_v4());
  create_test_doc_with_original_id(&pool, workspace_id, user_id, &doc_key).await;
  store
    .upsert_builtin_instance_applied(workspace_id, &slug, &expected_hash, "de", Some(&doc_key))
    .await
    .expect("upsert builtin instance");

  let raw_instance_id: Option<Uuid> = sqlx::query_scalar(
    "SELECT id FROM workspace_template_instances
     WHERE workspace_id = $1 AND template_id = $2 AND revision_id IS NULL",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_optional(&pool)
  .await
  .expect("raw instance id");
  let raw_instance_id = raw_instance_id.expect("fixture must create the canonical builtin NULL-revision row");

  let by_workspace = store
    .list_instances_for_workspace(workspace_id)
    .await
    .expect("builtin rows must not make list_instances_for_workspace fail");
  assert!(
    by_workspace.iter().all(|instance| instance.template_id != entry.id),
    "builtin rows must be exposed only through list_builtin_reconcile_entries"
  );

  let by_template = store
    .list_instances_for_template(entry.id)
    .await
    .expect("builtin rows must not make list_instances_for_template fail");
  assert!(
    by_template.is_empty(),
    "builtin template must not return revision-backed instances"
  );

  let direct = store
    .find_instance(workspace_id, entry.id)
    .await
    .expect("builtin rows must not make find_instance fail");
  assert!(
    direct.is_none(),
    "find_instance is revision-backed and must ignore builtin rows"
  );

  let by_id = store
    .get_instance(raw_instance_id)
    .await
    .expect("builtin rows must not make get_instance fail");
  assert!(
    by_id.is_none(),
    "get_instance is revision-backed and must ignore builtin rows"
  );

  let reconcile_entries = store
    .list_builtin_reconcile_entries(workspace_id, "de")
    .await
    .expect("builtin bridge remains the authoritative API");
  let current = reconcile_entries
    .iter()
    .find(|entry| entry.slug == slug)
    .and_then(|entry| entry.current_instance.as_ref())
    .expect("builtin current instance");
  assert_eq!(current.applied_hash.as_deref(), Some(expected_hash.as_str()));

  sqlx::query("DELETE FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id)
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_template_policies WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_default_policies WHERE template_id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .execute(&pool)
    .await
    .ok();
}
