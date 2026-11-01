// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transactional deletion blockers for organization units.
//!
//! Every reference family receives its own isolated target OU. This prevents
//! a broad fixture from passing while one blocker query is accidentally absent.

use myoxus_application::workspace::{WorkspaceName, WorkspaceStore};
use myoxus_domain::entities::OrganizationUnitDeletionBlockerCode;
use myoxus_domain::repositories::OrganizationUnitLifecycleRepository;
use myoxus_infrastructure::{organization::PgOrganizationUnitLifecycleRepository, workspace::SqlxWorkspaceStore};
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

async fn pool() -> PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .expect("TEST_DATABASE_URL must be set");
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect(&url)
    .await
    .expect("test DB");
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");
  pool
}

async fn root_ids(pool: &PgPool) -> (Uuid, Uuid) {
  sqlx::query_as(
    "SELECT organization_id, id FROM organization_unit_type
       WHERE is_active AND can_be_root_level AND can_own_workspaces ORDER BY key LIMIT 1",
  )
  .fetch_one(pool)
  .await
  .expect("active root OU type")
}

#[tokio::test]
async fn inv_organization_unit_owner_write_cannot_race_permanent_delete_into_an_orphan() {
  let pool = pool().await;
  let repo = PgOrganizationUnitLifecycleRepository::new(pool.clone(), json!({}));
  let workspace_store = SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let creator = user(&pool).await;
  let unit_id = unit(&pool, "disabled").await;
  let preview = repo.deletion_preview(unit_id).await.expect("deletion preview");
  assert!(preview.deletable);

  let (owner_write, deleted) = tokio::join!(
    workspace_store.create_shared_workspace(
      unit_id,
      creator,
      WorkspaceName::parse("Concurrent owner write").expect("valid workspace name"),
      yjs::create_initial_workspace_doc("Concurrent owner write"),
    ),
    repo.delete_permanently(unit_id, &preview.name, preview.updated_at),
  );

  assert!(
    owner_write.is_err(),
    "an inactive OU must never acquire a new owned workspace"
  );
  assert!(deleted.is_ok(), "the unreferenced inactive OU remains deletable");
  let orphan_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspaces WHERE owner_principal_type = 'ou' AND owner_principal_id = $1")
      .bind(unit_id)
      .fetch_one(&pool)
      .await
      .expect("owner-principal orphan check");
  assert_eq!(orphan_count, 0);

  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(creator)
    .execute(&pool)
    .await
    .expect("fixture user cleanup");
}

async fn user(pool: &PgPool) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'OU lifecycle fixture', 'active')")
    .bind(id)
    .bind(format!("ou-lifecycle-{id}@example.test"))
    .execute(pool)
    .await
    .expect("fixture user");
  id
}

async fn unit(pool: &PgPool, status: &str) -> Uuid {
  let (organization_id, type_id) = root_ids(pool).await;
  let id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO organization_unit (id, organization_id, unit_type_id, name, slug, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::organization_unit_status, '{}')",
  )
  .bind(id)
  .bind(organization_id)
  .bind(type_id)
  .bind(format!("Lifecycle {id}"))
  .bind(format!("lifecycle-{id}"))
  .bind(status)
  .execute(pool)
  .await
  .expect("fixture OU");
  id
}

async fn workspace(pool: &PgPool, owner: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(id)
    .bind(owner)
    .bind(format!("OU lifecycle {id}"))
    .execute(pool)
    .await
    .expect("fixture workspace");
  id
}

async fn assert_only_blocker(
  repo: &PgOrganizationUnitLifecycleRepository,
  unit_id: Uuid,
  expected: OrganizationUnitDeletionBlockerCode,
) {
  let preview = repo.deletion_preview(unit_id).await.expect("deletion preview");
  assert!(!preview.deletable);
  assert_eq!(
    preview.blockers.len(),
    1,
    "unexpected blocker set: {:?}",
    preview.blockers
  );
  assert_eq!(preview.blockers[0].code, expected);
  assert_eq!(preview.blockers[0].count, 1);
}

#[tokio::test]
async fn inv_organization_unit_delete_preview_reports_each_reference_family_independently() {
  let pool = pool().await;
  let repo = PgOrganizationUnitLifecycleRepository::new(pool.clone(), json!({}));
  let fixture_user = user(&pool).await;

  let parent = unit(&pool, "disabled").await;
  let child = unit(&pool, "disabled").await;
  sqlx::query("UPDATE organization_unit SET parent_unit_id = $1 WHERE id = $2")
    .bind(parent)
    .bind(child)
    .execute(&pool)
    .await
    .expect("child reference");
  assert_only_blocker(&repo, parent, OrganizationUnitDeletionBlockerCode::ChildUnits).await;
  sqlx::query("DELETE FROM organization_unit WHERE id IN ($1, $2)")
    .bind(child)
    .bind(parent)
    .execute(&pool)
    .await
    .expect("child cleanup");

  let member_unit = unit(&pool, "disabled").await;
  sqlx::query("INSERT INTO organization_unit_member (unit_id, user_id, role) VALUES ($1, $2, 'member')")
    .bind(member_unit)
    .bind(fixture_user)
    .execute(&pool)
    .await
    .expect("member reference");
  assert_only_blocker(&repo, member_unit, OrganizationUnitDeletionBlockerCode::Members).await;
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(member_unit)
    .execute(&pool)
    .await
    .expect("member cleanup");

  let linked_unit = unit(&pool, "disabled").await;
  let linked_workspace = workspace(&pool, fixture_user).await;
  sqlx::query(
    "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship) VALUES ($1, $2, 'linked')",
  )
  .bind(linked_unit)
  .bind(linked_workspace)
  .execute(&pool)
  .await
  .expect("workspace link");
  assert_only_blocker(&repo, linked_unit, OrganizationUnitDeletionBlockerCode::WorkspaceLinks).await;
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(linked_workspace)
    .execute(&pool)
    .await
    .expect("linked workspace cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(linked_unit)
    .execute(&pool)
    .await
    .expect("linked OU cleanup");

  let owner_unit = unit(&pool, "disabled").await;
  let owner_workspace = workspace(&pool, fixture_user).await;
  sqlx::query(
    "UPDATE workspaces SET owner_user_id = NULL, owner_principal_type = 'ou', owner_principal_id = $1,
                           management_unit_id = NULL, created_by_user_id = $2 WHERE id = $3",
  )
  .bind(owner_unit)
  .bind(fixture_user)
  .bind(owner_workspace)
  .execute(&pool)
  .await
  .expect("OU owner projection");
  assert_only_blocker(
    &repo,
    owner_unit,
    OrganizationUnitDeletionBlockerCode::OwnerPrincipalWorkspaces,
  )
  .await;
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(owner_workspace)
    .execute(&pool)
    .await
    .expect("owner workspace cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(owner_unit)
    .execute(&pool)
    .await
    .expect("owner OU cleanup");

  let management_unit = unit(&pool, "disabled").await;
  let managed_workspace = workspace(&pool, fixture_user).await;
  sqlx::query("UPDATE workspaces SET management_unit_id = $1 WHERE id = $2")
    .bind(management_unit)
    .bind(managed_workspace)
    .execute(&pool)
    .await
    .expect("management projection");
  assert_only_blocker(
    &repo,
    management_unit,
    OrganizationUnitDeletionBlockerCode::ManagementUnitWorkspaces,
  )
  .await;
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(managed_workspace)
    .execute(&pool)
    .await
    .expect("managed workspace cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(management_unit)
    .execute(&pool)
    .await
    .expect("management OU cleanup");

  let request_unit = unit(&pool, "disabled").await;
  let organization_id: Uuid = sqlx::query_scalar("SELECT organization_id FROM organization_unit WHERE id = $1")
    .bind(request_unit)
    .fetch_one(&pool)
    .await
    .expect("organization id");
  sqlx::query(
    "INSERT INTO organization_project_request
       (id, organization_id, requested_by, requested_scope, parent_unit_id, proposed_name, proposed_members)
     VALUES ($1, $2, $3, 'ou', $4, 'Lifecycle request', '{}')",
  )
  .bind(Uuid::new_v4())
  .bind(organization_id)
  .bind(fixture_user)
  .bind(request_unit)
  .execute(&pool)
  .await
  .expect("project request reference");
  assert_only_blocker(
    &repo,
    request_unit,
    OrganizationUnitDeletionBlockerCode::ProjectRequests,
  )
  .await;
  sqlx::query("DELETE FROM organization_project_request WHERE parent_unit_id = $1")
    .bind(request_unit)
    .execute(&pool)
    .await
    .expect("project request cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(request_unit)
    .execute(&pool)
    .await
    .expect("request OU cleanup");

  let oidc_unit = unit(&pool, "disabled").await;
  let provider_key = format!("oauth.providers.lifecycle-{}", Uuid::new_v4());
  sqlx::query("INSERT INTO app_configs (id, value) VALUES ($1, $2)")
    .bind(&provider_key)
    .bind(json!({
      "groupMapping": {
        "enabled": true,
        "mappings": [{ "group": "lifecycle", "targetUnitId": oidc_unit }]
      }
    }))
    .execute(&pool)
    .await
    .expect("OIDC mapping reference");
  assert_only_blocker(&repo, oidc_unit, OrganizationUnitDeletionBlockerCode::OidcGroupMappings).await;
  sqlx::query("DELETE FROM app_configs WHERE id = $1")
    .bind(&provider_key)
    .execute(&pool)
    .await
    .expect("OIDC config cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(oidc_unit)
    .execute(&pool)
    .await
    .expect("OIDC OU cleanup");

  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(fixture_user)
    .execute(&pool)
    .await
    .expect("fixture user cleanup");
}
