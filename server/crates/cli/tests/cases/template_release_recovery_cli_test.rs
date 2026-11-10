// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit system-source recovery must never select ordinary documents by title.

use std::{path::Path, str::FromStr, sync::Arc};

use myoxus_application::{doc::DocService, template_registry::TemplateRegistryService};
use myoxus_infrastructure::{doc::SqlxDocStore, storage::StorageAdapter, template_registry::SqlxTemplateRegistryStore};
use serde_json::Value;
use sqlx::{
  ConnectOptions, PgPool,
  postgres::{PgConnectOptions, PgPoolOptions},
};
use uuid::Uuid;

use crate::support;

fn recover(url: &str, storage: &Path, workspace: Uuid, apply: bool) -> Value {
  let output = recovery_output(url, storage, workspace, apply, true);
  assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
  serde_json::from_slice(&output.stdout).expect("native recovery output")
}

fn recovery_output(url: &str, storage: &Path, workspace: Uuid, apply: bool, confirm: bool) -> std::process::Output {
  let mut command = recovery_command(url, storage, apply);
  command.args([
    "--workspace-id",
    &workspace.to_string(),
    "--orphan-source",
    "business-daily=old-orphan",
    "--unknown-source",
    "hybrid-day-sprint=withdrawn-source",
    "--retire-slug",
    "hybrid-day-sprint",
  ]);
  if confirm {
    command.arg("--confirm-unmodified-system-documents");
  }
  command.output().expect("run native release recovery")
}

fn recovery_command(url: &str, storage: &Path, apply: bool) -> support::CliCommand {
  let url = if apply {
    url.to_owned()
  } else {
    PgConnectOptions::from_str(url)
      .unwrap()
      .options([("default_transaction_read_only", "on")])
      .to_url_lossy()
      .to_string()
  };
  let mut command = support::cli_command();
  command
    .env("MYOXUS__DATABASE__URL", url)
    .env("MYOXUS__STORAGE__ROOT", storage)
    .env("MYOXUS__REDIS__ROLES__SOCKET__URL", "redis://localhost:6380")
    .env(
      "MYOXUS__REDIS__ROLES__SOCKET__NAMESPACE",
      format!("recovery-{}", Uuid::new_v4()),
    )
    .args(["--json", "templates", "recover-release"]);
  if apply {
    command.arg("--apply");
  } else {
    // A source-only preflight does not validate unrelated candidate runtime
    // settings, including values an older installation could still contain.
    command.env("MYOXUS__DOC__DECODER_CONCURRENCY", "unrelated-candidate-runtime-value");
  }
  command
}

#[tokio::test]
async fn explicit_release_recovery_replaces_sources_preserves_work_and_is_idempotent() {
  // Use a disposable database on the isolated test service: mandatory release
  // slugs must not collide with other CLI fixtures in the shared test database.
  let options = PgConnectOptions::from_str(&support::database_url()).unwrap();
  let admin = PgPoolOptions::new()
    .max_connections(2)
    .connect_with(options.clone())
    .await
    .unwrap();
  let name = format!("myoxus_test_recovery_{}", Uuid::new_v4().simple());
  sqlx::query(&format!("CREATE DATABASE {name}"))
    .execute(&admin)
    .await
    .unwrap();
  let options = options.database(&name);
  let url = options.to_url_lossy().to_string();
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect_with(options)
    .await
    .unwrap();
  let storage = tempfile::tempdir().unwrap();
  let result = tokio::task::spawn_blocking({
    let pool = pool.clone();
    let root = storage.path().to_owned();
    move || {
      tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(journey(&pool, &url, &root))
    }
  })
  .await;
  pool.close().await;
  sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
    .execute(&admin)
    .await
    .expect("remove owned recovery database");
  admin.close().await;
  if let Err(error) = result {
    std::panic::resume_unwind(error.into_panic());
  }
}

async fn journey(pool: &PgPool, url: &str, storage: &Path) {
  use sha2::{Digest, Sha384};
  // Canonical deployed fixture, like migration_baseline.rs: not a second runner.
  // The production migration owner subsequently applies the normal forward chain.
  let baseline = include_str!("../../../infrastructure/migrations/1000_myoxus_schema_baseline.sql");
  sqlx::raw_sql(baseline).execute(pool).await.unwrap();
  sqlx::raw_sql("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)")
    .execute(pool).await.unwrap();
  sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(1000,'myoxus schema baseline',true,$1,0)")
    .bind(Sha384::digest(baseline.as_bytes()).to_vec()).execute(pool).await.unwrap();
  let user = Uuid::new_v4();
  let workspace = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,email,name,email_verified_at) VALUES($1,$2,'Recovery fixture',now())")
    .bind(user)
    .bind(format!("recovery-{user}@test.local"))
    .execute(pool)
    .await
    .unwrap();
  sqlx::query("INSERT INTO workspaces(id,owner_user_id,name) VALUES($1,$2,'Recovery fixture')")
    .bind(workspace)
    .bind(user)
    .execute(pool)
    .await
    .unwrap();
  for (id, key, root) in [
    (workspace, workspace.to_string(), true),
    (Uuid::new_v4(), "old-orphan".into(), false),
    (Uuid::new_v4(), "withdrawn-source".into(), false),
    (Uuid::new_v4(), "working-document".into(), false),
  ] {
    sqlx::query("INSERT INTO docs(id,external_id,workspace_id,title,is_workspace_root,created_by,updated_by) VALUES($1,$2,$3,'Tagesplan',$4,$5,$5)")
      .bind(id).bind(&key).bind(workspace).bind(root).bind(user).execute(pool).await.unwrap();
  }
  sqlx::query("INSERT INTO document_template_state(doc_id,state) SELECT id,'seeded' FROM docs WHERE workspace_id=$1 AND external_id IN ('old-orphan','withdrawn-source')")
    .bind(workspace).execute(pool).await.unwrap();
  // Historical aliases deliberately prevent complete candidate Services from
  // loading. Preflight must not normalize them or require a new API startup.
  sqlx::query("INSERT INTO app_configs(id,value) VALUES('i18n.defaultLocale','\"de\"') ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .execute(pool).await.unwrap();
  let pending = recovery_output(url, storage, workspace, false, true);
  assert!(
    pending.status.success(),
    "empty native owners can be planned before migrations: {}",
    String::from_utf8_lossy(&pending.stderr)
  );
  let pending: Value = serde_json::from_slice(&pending.stdout).expect("pre-migration recovery plan");
  assert!(
    pending
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["scope"] == "migration" && row["target_version"] == "1000")
  );
  let schema: (i64, bool, Value) = sqlx::query_as("SELECT (SELECT max(version) FROM _sqlx_migrations),EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='template_revisions' AND column_name='release_managed_publication'),(SELECT value FROM app_configs WHERE id='i18n.defaultLocale')")
    .fetch_one(pool).await.unwrap();
  assert_eq!(
    schema,
    (1000, false, serde_json::json!("de")),
    "preflight must not migrate or normalize config"
  );
  sqlx::query("UPDATE _sqlx_migrations SET checksum=decode('00','hex') WHERE version=1000")
    .execute(pool)
    .await
    .unwrap();
  let altered = recovery_output(url, storage, workspace, false, true);
  assert!(!altered.status.success());
  assert!(String::from_utf8_lossy(&altered.stderr).contains("unsupported migration ledger"));
  sqlx::query("UPDATE _sqlx_migrations SET checksum=$1 WHERE version=1000")
    .bind(Sha384::digest(baseline.as_bytes()).to_vec())
    .execute(pool)
    .await
    .unwrap();
  // Remove the deliberately invalid config fixture before the real forward
  // runner enforces the candidate schema/config invariants.
  sqlx::query("DELETE FROM app_configs WHERE id='i18n.defaultLocale'")
    .execute(pool)
    .await
    .unwrap();
  myoxus_infrastructure::migrations::run(pool).await.unwrap();
  let registry = TemplateRegistryService::new(Arc::new(SqlxTemplateRegistryStore::new(pool.clone())))
    .with_materialization(
      DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))),
      Arc::new(StorageAdapter::new_fs(storage.to_str().unwrap()).unwrap()),
    );
  let templates = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/documents");
  let mut ids = Vec::new();
  for slug in ["business-daily", "hybrid-day-sprint"] {
    let bytes = std::fs::read(templates.join(slug).join("1.0.0.zip")).unwrap();
    let (entry, revision) = registry
      .stage_shipped_catalog_bundle(&bytes, "history.zip")
      .await
      .unwrap();
    registry
      .commit_shipped_catalog_selection(&[myoxus_application::template_registry::ShippedTemplateSelection {
        template_id: entry.id,
        current_revision_id: Some(revision.id),
        history_revision_ids: vec![],
        new_workspace_default: false,
      }])
      .await
      .unwrap();
    ids.push(entry.id);
    sqlx::query("INSERT INTO template_default_policies(template_id,apply_to_new_workspaces) VALUES($1,true) ON CONFLICT(template_id) DO UPDATE SET apply_to_new_workspaces=true,release_managed=false")
      .bind(entry.id).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_template_policies(workspace_id,template_id) VALUES($1,$2)")
      .bind(workspace)
      .bind(entry.id)
      .execute(pool)
      .await
      .unwrap();
    let doc: Option<Uuid> = if slug == "hybrid-day-sprint" {
      Some(
        sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id='withdrawn-source'")
          .bind(workspace)
          .fetch_one(pool)
          .await
          .unwrap(),
      )
    } else {
      None
    };
    sqlx::query("INSERT INTO workspace_template_instances(workspace_id,template_id,revision_id,state,workspace_doc_id,workspace_doc_key) VALUES($1,$2,$3,'detached',$4,$5)")
      .bind(workspace).bind(entry.id).bind(revision.id).bind(doc).bind(doc.map(|_|"withdrawn-source")).execute(pool).await.unwrap();
  }
  let captured = support::feature_sources();
  let expected_version = captured
    .bundles
    .iter()
    .find_map(|bundle| {
      let export = bundle
        .manifest
        .exports
        .iter()
        .find(|export| export.id == "document.business-daily")?;
      bundle
        .manifest
        .components
        .iter()
        .find(|component| component.id == export.source.component)?
        .native_identity
        .as_ref()
        .map(|identity| identity.version.clone())
    })
    .expect("current daily source");
  let expected_blocks = captured
    .bundles
    .iter()
    .flat_map(|bundle| {
      bundle.manifest.exports.iter().filter(|export| {
        export
          .document
          .as_ref()
          .is_some_and(|policy| policy.new_workspace_default)
          && bundle.manifest.components.iter().any(|component| {
            component.id == export.source.component
              && component
                .native_identity
                .as_ref()
                .is_some_and(|identity| identity.id.starts_with("block-"))
          })
      })
    })
    .count() as i64;
  myoxus_application::feature_bundle::register_feature_document_sources(
    &registry,
    &captured.bundles,
    &captured.resolved.active,
  )
  .await
  .unwrap();
  // Exercise withdrawal through the CLI, not just a ready-instance count. The
  // second body is edited without a drift scan so retirement must attest it.
  sqlx::query("UPDATE template_revisions SET state='published',release_managed_publication=false WHERE template_id=$1 AND version='1.0.0'")
    .bind(ids[1]).execute(pool).await.unwrap();
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let mut withdrawal_sources = Vec::new();
  for (edited, legacy) in [(false, true), (true, false), (false, false)] {
    let id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO workspaces(id,owner_user_id,name,initial_content_policy) VALUES($1,$2,'Withdrawal fixture','empty')",
    )
    .bind(id)
    .bind(user)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO docs(id,external_id,workspace_id,is_workspace_root,created_by,updated_by) VALUES($1,$2,$1,true,$3,$3)")
      .bind(id).bind(id.to_string()).bind(user).execute(pool).await.unwrap();
    registry
      .assign_template_to_workspace(
        id,
        ids[1],
        myoxus_domain::template_registry::SelectionMode::Published,
        None,
        myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
      )
      .await
      .unwrap();
    let instances = registry.reconcile_workspace_templates(id).await.unwrap();
    let source = instances
      .iter()
      .find(|instance| instance.template_id == ids[1])
      .unwrap();
    let doc = source.workspace_doc_id.unwrap();
    if legacy {
      sqlx::query("UPDATE workspace_template_instances SET revision_id=NULL WHERE id=$1")
        .bind(source.id)
        .execute(pool)
        .await
        .unwrap();
      let rejected = recovery_output(url, storage, workspace, false, true);
      assert!(!rejected.status.success(), "recovery must not adopt a NULL binding");
      assert!(String::from_utf8_lossy(&rejected.stderr).contains("unsupported unmigrated NULL-revision"));
      sqlx::query("UPDATE workspace_template_instances SET revision_id=$2 WHERE id=$1")
        .bind(source.id)
        .bind(source.revision_id)
        .execute(pool)
        .await
        .unwrap();
    }
    if !edited && !legacy {
      // A real native binding can retain the old positive marker after its
      // policy became managed; that does not make unchanged bytes custom.
      sqlx::query("UPDATE document_template_state SET state='seeded' WHERE doc_id=$1")
        .bind(doc)
        .execute(pool)
        .await
        .unwrap();
    }
    if edited {
      let before = documents.load_full_doc_consistent(id, doc).await.unwrap();
      let update = yjs::update_document_title(&before, "My retained source notes").unwrap();
      documents
        .push_update_raw(id, doc, update, myoxus_application::doc::DocSpaceKind::Workspace)
        .await
        .unwrap();
    }
    withdrawal_sources.push((
      id,
      doc,
      edited,
      documents.load_full_doc_consistent(id, doc).await.unwrap(),
    ));
  }
  sqlx::query("UPDATE template_catalog_entries SET source='builtin',builder_version=1 WHERE id=$1")
    .bind(ids[1])
    .execute(pool)
    .await
    .unwrap();
  // Unknown current publication requires explicit operator confirmation,
  // regardless of retained historical bytes or absent authorship.
  sqlx::query("UPDATE template_revisions SET state='deprecated' WHERE template_id=$1 AND state='published'")
    .bind(ids[0])
    .execute(pool)
    .await
    .unwrap();
  sqlx::query("UPDATE template_revisions SET state='published',release_managed_publication=false WHERE template_id=$1 AND version=$2")
    .bind(ids[0]).bind(&expected_version).execute(pool).await.unwrap();
  let before: Value =
    sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE workspace_id=$1 AND external_id='working-document'")
      .bind(workspace)
      .fetch_one(pool)
      .await
      .unwrap();
  let preview = recover(url, storage, workspace, false);
  assert!(
    preview
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["source"] == "business-daily" && row["operation"] == "replace")
  );
  let old: (String,bool) = sqlx::query_as("SELECT r.version,r.release_managed_publication FROM template_revisions r WHERE template_id=$1 AND state='published'")
    .bind(ids[0]).fetch_one(pool).await.unwrap();
  assert_eq!(
    old,
    (expected_version.clone(), false),
    "preview must preserve publication authority"
  );
  let unknown = recovery_output(url, storage, workspace, false, false);
  assert!(
    !unknown.status.success(),
    "unknown ownership is not successful upgrade readiness"
  );
  let unresolved: Value = serde_json::from_slice(&unknown.stdout).unwrap();
  assert!(
    unresolved
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["source"] == "business-daily" && row["operation"] == "unresolved-publication-ownership")
  );
  let imports_before: i64 = sqlx::query_scalar("SELECT count(*) FROM template_import_jobs")
    .fetch_one(pool)
    .await
    .unwrap();
  let missing_scope = recovery_output(url, storage, Uuid::new_v4(), true, true);
  assert!(!missing_scope.status.success());
  assert!(String::from_utf8_lossy(&missing_scope.stderr).contains("workspace does not exist"));
  let imports_after: i64 = sqlx::query_scalar("SELECT count(*) FROM template_import_jobs")
    .fetch_one(pool)
    .await
    .unwrap();
  assert_eq!(
    imports_after, imports_before,
    "an invalid Workspace must fail before global release staging"
  );
  // A confirmed key is not permission to delete a later collaborative edit.
  // Inject a genuine native body when the replacement becomes durable, after
  // recovery has inspected the old orphan and before it attempts retirement.
  let edited_orphan_body = myoxus_application::template_registry::bundle::parse_bundle(
    &std::fs::read(templates.join("business-daily/1.0.0.zip")).unwrap(),
  )
  .unwrap()
  .content_bytes;
  let edited_orphan_hex: String = edited_orphan_body.iter().map(|byte| format!("{byte:02x}")).collect();
  sqlx::raw_sql(&format!(
    r#"
    CREATE FUNCTION recovery_edit_after_materialization() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.workspace_id='{workspace}'::uuid AND NEW.template_id='{}'::uuid AND NEW.workspace_doc_id IS NOT NULL THEN
        INSERT INTO doc_updates(workspace_id,doc_id,payload,sequence)
          SELECT d.workspace_id,d.id,decode('{edited_orphan_hex}','hex'),1 FROM docs d
          WHERE d.workspace_id='{workspace}'::uuid AND d.external_id='old-orphan'
            AND NOT EXISTS(SELECT 1 FROM doc_updates u WHERE u.workspace_id=d.workspace_id AND u.doc_id=d.id);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER recovery_edit_after_materialization AFTER INSERT OR UPDATE ON workspace_template_instances
      FOR EACH ROW EXECUTE FUNCTION recovery_edit_after_materialization();
  "#,
    ids[0]
  ))
  .execute(pool)
  .await
  .unwrap();
  let interrupted = recovery_output(url, storage, workspace, true, true);
  sqlx::raw_sql("DROP TRIGGER recovery_edit_after_materialization ON workspace_template_instances; DROP FUNCTION recovery_edit_after_materialization()")
    .execute(pool).await.unwrap();
  assert!(
    !interrupted.status.success(),
    "a changed source must stop recovery without deleting the edit"
  );
  assert!(String::from_utf8_lossy(&interrupted.stderr).contains("source deletion did not complete"));
  let orphan: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id='old-orphan'")
    .bind(workspace)
    .fetch_one(pool)
    .await
    .unwrap();
  assert!(
    yjs::native_documents_have_same_content(
      &documents.load_full_doc_consistent(workspace, orphan).await.unwrap(),
      &edited_orphan_body
    )
    .unwrap(),
    "the native content written after inspection must survive the failed retirement"
  );
  let interrupted_key: String = sqlx::query_scalar(
    "SELECT workspace_doc_key FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2",
  )
  .bind(workspace)
  .bind(ids[0])
  .fetch_one(pool)
  .await
  .unwrap();
  // This second explicit confirmation acknowledges the now-observed body; it
  // must resume without rematerializing the replacement made by the first run.
  recover(url, storage, workspace, true);
  let removed: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM docs WHERE workspace_id=$1 AND external_id IN ('old-orphan','withdrawn-source')",
  )
  .bind(workspace)
  .fetch_one(pool)
  .await
  .unwrap();
  assert_eq!(removed, 0, "both orphan and withdrawn native sources must disappear");
  let current: (String,bool,String,String) = sqlx::query_as("SELECT r.version,r.release_managed_publication,i.state,i.workspace_doc_key FROM workspace_template_instances i JOIN template_revisions r ON r.id=i.revision_id WHERE i.workspace_id=$1 AND i.template_id=$2")
    .bind(workspace).bind(ids[0]).fetch_one(pool).await.unwrap();
  assert_eq!(
    (&current.0, current.1, &current.2),
    (&expected_version, true, &"ok".into())
  );
  assert_eq!(
    current.3, interrupted_key,
    "resuming retirement retains the durable replacement identity"
  );
  let blocks: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_template_instances i JOIN template_catalog_entries c ON c.id=i.template_id WHERE i.workspace_id=$1 AND c.category='building-blocks' AND i.state='ok' AND i.workspace_doc_key IS NOT NULL")
    .bind(workspace).fetch_one(pool).await.unwrap();
  assert_eq!(
    blocks, expected_blocks,
    "existing workspace receives the declared building-block defaults"
  );
  recover(url, storage, workspace, true);
  let repeated: String = sqlx::query_scalar(
    "SELECT workspace_doc_key FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2",
  )
  .bind(workspace)
  .bind(ids[0])
  .fetch_one(pool)
  .await
  .unwrap();
  assert_eq!(
    repeated, current.3,
    "a repeated recovery must retain the current source identity"
  );
  // Empty suppresses implicit defaults, not an explicitly installed source.
  let empty = Uuid::new_v4();
  let explicit = Uuid::new_v4();
  for id in [empty, explicit] {
    sqlx::query("INSERT INTO workspaces(id,owner_user_id,name,initial_content_policy) VALUES($1,$2,'Empty recovery fixture','empty')")
      .bind(id).bind(user).execute(pool).await.unwrap();
  }
  sqlx::query(
    "INSERT INTO docs(id,external_id,workspace_id,is_workspace_root,created_by,updated_by) VALUES($1,$2,$1,true,$3,$3)",
  )
  .bind(explicit)
  .bind(explicit.to_string())
  .bind(user)
  .execute(pool)
  .await
  .unwrap();
  registry
    .assign_template_to_workspace(
      explicit,
      ids[0],
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .unwrap();
  use myoxus_application::template_registry::TemplateRegistryStore as _;
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let first_page = store.release_workspace_ids(None, 1).await.unwrap();
  assert_eq!(first_page.len(), 1);
  let second_page = store.release_workspace_ids(Some(first_page[0]), 1).await.unwrap();
  assert_eq!(second_page.len(), 1);
  assert!(first_page[0] < second_page[0]);
  // A positively release-owned source may disappear entirely from the candidate
  // archive, not just become a retained component without an export.
  let mut omitted = myoxus_application::template_registry::bundle::parse_bundle(
    &std::fs::read(templates.join("business-daily/1.0.0.zip")).unwrap(),
  )
  .unwrap();
  omitted.manifest.template_id = "qa-completely-omitted".into();
  let bytes = myoxus_application::template_registry::bundle::create_export_bundle(
    &omitted.manifest,
    &omitted.content_bytes,
    None,
    &omitted.localized_contents,
  )
  .unwrap();
  let (omitted_entry, omitted_revision) = registry
    .stage_shipped_catalog_bundle(&bytes, "omitted.zip")
    .await
    .unwrap();
  sqlx::query(
    "UPDATE template_revisions SET state='published',published_at=now(),release_managed_publication=true WHERE id=$1",
  )
  .bind(omitted_revision.id)
  .execute(pool)
  .await
  .unwrap();
  registry
    .assign_template_to_workspace(
      workspace,
      omitted_entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .unwrap();
  let omitted_document = registry
    .reconcile_workspace_templates(workspace)
    .await
    .unwrap()
    .into_iter()
    .find(|instance| instance.template_id == omitted_entry.id)
    .unwrap()
    .workspace_doc_id
    .unwrap();
  let all = |apply| {
    let mut command = recovery_command(url, storage, apply);
    command.arg("--all-workspaces");
    let output = command.output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice::<Value>(&output.stdout).expect("one streamed JSON array")
  };
  let preview_all = all(false);
  assert!(
    preview_all
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["workspace"] == workspace.to_string()
        && row["source"] == "qa-completely-omitted"
        && row["operation"] == "retire-with-native-attestation"),
    "preflight must expose a source completely absent from the candidate archive"
  );
  assert!(
    preview_all
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["workspace"] == explicit.to_string() && row["operation"] == "install")
  );
  let edited_workspace = withdrawal_sources.iter().find(|(_, _, edited, _)| *edited).unwrap().0;
  assert!(
    preview_all
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["workspace"] == edited_workspace.to_string()
        && row["source"] == "hybrid-day-sprint"
        && row["operation"] == "preserve-edited-source"),
    "read-only preflight must distinguish preservation from destructive withdrawal"
  );
  all(true);
  assert!(
    !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1)")
      .bind(omitted_document)
      .fetch_one(pool)
      .await
      .unwrap()
  );
  for (workspace, doc, edited, content) in &withdrawal_sources {
    let policy_count: i64 =
      sqlx::query_scalar("SELECT count(*) FROM workspace_template_policies WHERE workspace_id=$1 AND template_id=$2")
        .bind(workspace)
        .bind(ids[1])
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(
      policy_count, 0,
      "withdrawal removes the delivery assignment, including after preservation"
    );
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE workspace_id=$1 AND id=$2)")
      .bind(workspace)
      .bind(doc)
      .fetch_one(pool)
      .await
      .unwrap();
    assert_eq!(
      exists, *edited,
      "withdrawal deletes only the attested unchanged native source"
    );
    if *edited {
      assert_eq!(
        documents.load_full_doc_consistent(*workspace, *doc).await.unwrap(),
        *content
      );
      let attribution: (String, Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT state,template_id,instance_id FROM document_template_state WHERE doc_id=$1")
          .bind(doc)
          .fetch_one(pool)
          .await
          .unwrap();
      assert_eq!(
        attribution,
        ("seeded".into(), None, None),
        "edited content remains an independent custom source"
      );
    }
  }
  let explicit_key: String = sqlx::query_scalar("SELECT workspace_doc_key FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2 AND state='ok'")
    .bind(explicit).bind(ids[0]).fetch_one(pool).await.unwrap();
  let explicit_doc: Uuid = sqlx::query_scalar(
    "SELECT workspace_doc_id FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2",
  )
  .bind(explicit)
  .bind(ids[0])
  .fetch_one(pool)
  .await
  .unwrap();
  let actual = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc_consistent(explicit, explicit_doc)
    .await
    .unwrap();
  let expected = captured
    .bundles
    .iter()
    .find_map(|bundle| {
      let component = bundle.manifest.components.iter().find(|component| {
        component
          .native_identity
          .as_ref()
          .is_some_and(|identity| identity.id == "business-daily" && identity.version == expected_version)
      })?;
      Some(myoxus_application::template_registry::bundle::parse_bundle(&bundle.files[&component.path]).unwrap())
    })
    .unwrap();
  let actual_fields = yjs::document_field::content::inspect(&actual).unwrap();
  assert!(
    std::iter::once(expected.content_bytes.as_slice())
      .chain(expected.localized_contents.values().map(Vec::as_slice))
      .any(|body| {
        // Materialization copies field identities. Align only those identities
        // at their unchanged native positions before comparing the entire graph;
        // definitions, answers, attributes and row/cell content remain exact.
        let fields = yjs::document_field::content::inspect(body).unwrap();
        if fields.len() != actual_fields.len() {
          return false;
        }
        let mut identities = std::collections::HashMap::new();
        for field in fields {
          let Some(actual_field) = actual_fields.iter().find(|actual_field| {
            actual_field.block_id == field.block_id
              && actual_field.property == field.property
              && actual_field.start == field.start
              && actual_field.length == field.length
          }) else {
            return false;
          };
          identities.insert(
            field.run.descriptor.id().to_owned(),
            actual_field.run.descriptor.id().to_owned(),
          );
        }
        if identities.values().collect::<std::collections::HashSet<_>>().len() != identities.len() {
          return false;
        }
        let aligned = yjs::document_field::content::map(body, |run| {
          let id = identities
            .get(run.descriptor.id())
            .ok_or("missing copied field position")?;
          run.with_descriptor(run.descriptor.clone_occurrence(id.clone())?)
        })
        .unwrap();
        yjs::native_documents_have_same_content(&actual, &aligned.state).unwrap()
      }),
    "the explicit Empty source must contain the actual admitted native body"
  );
  all(true);
  let replay_key: String = sqlx::query_scalar("SELECT workspace_doc_key FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2 AND state='ok'")
    .bind(explicit).bind(ids[0]).fetch_one(pool).await.unwrap();
  assert_eq!(
    explicit_key, replay_key,
    "all-Workspace replay retains the explicit source identity"
  );
  let counts: (i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspace_template_instances WHERE workspace_id=$1),(SELECT count(*) FROM workspace_template_instances WHERE workspace_id=$2)")
    .bind(empty).bind(explicit).fetch_one(pool).await.unwrap();
  assert_eq!(
    counts,
    (0, 1),
    "Empty gets no defaults and only its one explicit source"
  );
  let opt_out_policy: Uuid =
    sqlx::query_scalar("SELECT id FROM workspace_template_policies WHERE workspace_id=$1 AND template_id=$2")
      .bind(workspace)
      .bind(ids[0])
      .fetch_one(pool)
      .await
      .unwrap();
  registry.retire_template_assignment(opt_out_policy).await.unwrap();
  let opt_out_preview = all(false);
  assert!(
    opt_out_preview
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["workspace"] == workspace.to_string()
        && row["source"] == "business-daily"
        && row["operation"] == "preserve-explicit-policy")
  );
  all(true);
  let opted_out: (String,Option<Uuid>,i64) = sqlx::query_as("SELECT state,workspace_doc_id,(SELECT count(*) FROM workspace_template_policies p WHERE p.workspace_id=i.workspace_id AND p.template_id=i.template_id) FROM workspace_template_instances i WHERE workspace_id=$1 AND template_id=$2")
    .bind(workspace).bind(ids[0]).fetch_one(pool).await.unwrap();
  assert_eq!(
    opted_out,
    ("retired".into(), None, 0),
    "recovery never reinstalls an explicit opt-out"
  );
  for extra in [
    vec!["--confirm-unmodified-system-documents"],
    vec!["--orphan-source", "business-daily=old-orphan"],
    vec!["--unknown-source", "business-daily=old-orphan"],
  ] {
    let mut command = recovery_command(url, storage, false);
    let output = command.arg("--all-workspaces").args(extra).output().unwrap();
    assert!(
      !output.status.success(),
      "all-Workspace scope must not accept a global source confirmation/override"
    );
  }
  let after: Value =
    sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE workspace_id=$1 AND external_id='working-document'")
      .bind(workspace)
      .fetch_one(pool)
      .await
      .unwrap();
  assert_eq!(
    after, before,
    "an ordinary document with the same title is never a source candidate"
  );
}
