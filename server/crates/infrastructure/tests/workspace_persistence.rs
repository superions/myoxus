//! Integration tests for workspace persistence (create, update, soft-delete).
use std::sync::Arc;

use myoxus_application::auth::{AuthError, AuthStore};
use myoxus_application::workspace::{UpdateWorkspace, WorkspaceName, WorkspaceService, WorkspaceStore};
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use uuid::Uuid;

async fn setup_db() -> sqlx::PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .expect("TEST_DATABASE_URL (or DATABASE_URL) must be set for persistence tests");
  sqlx::PgPool::connect(&database_url)
    .await
    .expect("Failed to connect to database")
}

async fn create_user(store: &SqlxAuthStore, prefix: &str) -> myoxus_application::auth::AuthUser {
  store
    .fulfill_user(
      &format!("{prefix}-{}@example.com", Uuid::new_v4().simple()),
      Some(prefix),
      None,
    )
    .await
    .expect("create workspace-name fixture user")
}

#[tokio::test]
async fn direct_owner_transfer_rejects_ou_owned_workspace_atomically() {
  let pool = setup_db().await;
  let auth = SqlxAuthStore::from_pool(pool.clone());
  let creator = create_user(&auth, "ou-transfer-creator").await;
  let candidate = create_user(&auth, "ou-transfer-candidate").await;
  let store = SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let workspace = store
    .create_workspace(creator.id, WorkspaceName::parse("OU-owned transfer guard").unwrap())
    .await
    .expect("create transfer fixture workspace");
  let unit_id = Uuid::new_v4();

  sqlx::query(
    r#"INSERT INTO organization_unit
         (id, organization_id, unit_type_id, name, slug, status, created_by)
       SELECT $1, organization_id, id, $2, $3, 'active', $4
         FROM organization_unit_type
        WHERE key = 'team' AND can_own_workspaces = TRUE
        LIMIT 1"#,
  )
  .bind(unit_id)
  .bind("OU transfer guard")
  .bind(format!("ou-transfer-guard-{unit_id}"))
  .bind(creator.id)
  .execute(&pool)
  .await
  .expect("create owning OU");
  sqlx::query(
    r#"UPDATE workspaces
          SET owner_user_id = NULL,
              owner_principal_type = 'ou',
              owner_principal_id = $1,
              management_unit_id = $1
        WHERE id = $2"#,
  )
  .bind(unit_id)
  .bind(workspace.id)
  .execute(&pool)
  .await
  .expect("project OU ownership");

  let error = store
    .transfer_ownership(workspace.id, creator.id, candidate.id)
    .await
    .expect_err("OU-owned workspace must reject direct user owner transfer");
  assert!(matches!(
    error,
    AuthError::InvalidInput(ref message) if message == "workspace ownership changed"
  ));

  let owner: (String, Uuid, Option<Uuid>) = sqlx::query_as(
    "SELECT owner_principal_type::text, owner_principal_id, owner_user_id
       FROM workspaces
      WHERE id = $1",
  )
  .bind(workspace.id)
  .fetch_one(&pool)
  .await
  .expect("load ownership after rejected transfer");
  assert_eq!(owner, ("ou".to_string(), unit_id, None));
}

#[tokio::test]
async fn workspace_names_are_principal_local_atomic_and_legacy_safe() {
  let pool = setup_db().await;
  let auth = SqlxAuthStore::from_pool(pool.clone());
  let owner = create_user(&auth, "reservation-owner").await;
  let other = create_user(&auth, "reservation-other").await;
  let store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  ));
  let service = Arc::new(WorkspaceService::new(store.clone()));

  // Two old clients omit the name concurrently. The service must reserve the
  // smallest available default for each without relying on a pre-read.
  let (first, second) = tokio::join!(
    service.create_workspace(owner.id, None, None),
    service.create_workspace(owner.id, None, None)
  );
  let first = first.expect("first automatic workspace");
  let second = second.expect("second automatic workspace");
  let mut names = [first.name.clone(), second.name.clone()];
  names.sort();
  assert_eq!(names, ["New Workspace", "New Workspace (2)"]);

  // Unicode-equivalent explicit names conflict and return the deterministic
  // next suggestion. A different owner principal may use the same name.
  let unicode = WorkspaceStore::create_workspace(store.as_ref(), owner.id, WorkspaceName::parse("Café  Plan").unwrap())
    .await
    .expect("canonical Unicode workspace");
  let conflict = WorkspaceStore::create_workspace(
    store.as_ref(),
    owner.id,
    WorkspaceName::parse("Cafe\u{301}  Plan").unwrap(),
  )
  .await
  .unwrap_err();
  assert!(matches!(
    conflict,
    AuthError::WorkspaceNameConflict { ref suggestion } if suggestion == "Café Plan (2)"
  ));
  WorkspaceStore::create_workspace(
    store.as_ref(),
    other.id,
    WorkspaceName::parse("Cafe\u{301} Plan").unwrap(),
  )
  .await
  .expect("same name in another principal");

  // Legacy duplicate rows deliberately remain NULL, but their computed name
  // still occupies the reservation. This fixture recreates that migration
  // outcome without weakening the new unique index.
  let legacy_a = WorkspaceStore::create_workspace(store.as_ref(), owner.id, WorkspaceName::parse("Legacy A").unwrap())
    .await
    .unwrap();
  let legacy_b = WorkspaceStore::create_workspace(store.as_ref(), owner.id, WorkspaceName::parse("Legacy B").unwrap())
    .await
    .unwrap();
  sqlx::query("UPDATE workspaces SET name = 'Legacy duplicate', name_normalized = NULL WHERE id = ANY($1)")
    .bind([legacy_a.id, legacy_b.id])
    .execute(&pool)
    .await
    .expect("create legacy duplicate group");
  let legacy_conflict = WorkspaceStore::create_workspace(
    store.as_ref(),
    owner.id,
    WorkspaceName::parse(" legacy   duplicate ").unwrap(),
  )
  .await
  .unwrap_err();
  assert!(matches!(
    legacy_conflict,
    AuthError::WorkspaceNameConflict { ref suggestion } if suggestion == "legacy duplicate (2)"
  ));

  // Soft deletion releases a canonical reservation.
  WorkspaceStore::delete_workspace(store.as_ref(), unicode.id)
    .await
    .expect("soft-delete canonical workspace");
  WorkspaceStore::create_workspace(store.as_ref(), owner.id, WorkspaceName::parse("Café Plan").unwrap())
    .await
    .expect("reuse name after deletion");
}

#[tokio::test]
async fn nonactive_workspace_memberships_are_invisible_to_product_ports() {
  let pool = setup_db().await;
  let auth = SqlxAuthStore::from_pool(pool.clone());
  let owner = create_user(&auth, "lifecycle-owner").await;
  let store = SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let operation_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO workspaces (
      id, owner_user_id, owner_principal_type, owner_principal_id,
      created_by_user_id, name, name_normalized, lifecycle_state,
      lifecycle_owner_kind, lifecycle_owner_id
    ) VALUES ($1, $2, 'user', $2, $2, 'Hidden extraction',
              'hidden extraction', 'extracting', 'workspace_content', $3)
    "#,
  )
  .bind(workspace_id)
  .bind(owner.id)
  .bind(operation_id)
  .execute(&pool)
  .await
  .expect("insert extracting workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships
       (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Owner', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(owner.id)
  .execute(&pool)
  .await
  .expect("insert extracting membership");

  assert!(store.get_workspace(workspace_id).await.unwrap().is_none());
  assert!(
    store
      .list_user_workspaces(owner.id)
      .await
      .unwrap()
      .iter()
      .all(|workspace| workspace.id != workspace_id)
  );
  assert!(store.get_member(workspace_id, owner.id).await.unwrap().is_none());
  assert_eq!(
    AuthStore::get_workspace_role(&auth, owner.id, workspace_id)
      .await
      .unwrap(),
    None
  );
  assert!(
    store
      .get_internal_workspace(
        workspace_id,
        myoxus_application::workspace::WorkspaceLifecycleState::Extracting,
        myoxus_application::workspace::WorkspaceLifecycleOwnerKind::WorkspaceContent,
        operation_id,
      )
      .await
      .unwrap()
      .is_some()
  );
}

#[tokio::test]
async fn test_workspace_persistence_lifecycle() {
  let pool = setup_db().await;
  let auth_store = SqlxAuthStore::from_pool(pool.clone());
  let workspace_store = SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );

  // 1. Create Owner
  let email = format!("owner-{}@example.com", Uuid::new_v4().simple());
  let owner = auth_store
    .fulfill_user(&email, Some("Owner"), None)
    .await
    .expect("Failed to create owner");

  // 2. Create Workspace
  let ws = workspace_store
    .create_workspace(owner.id, myoxus_application::workspace::WorkspaceName::default_name())
    .await
    .expect("Failed to create workspace");
  assert_eq!(ws.owner_user_id, Some(owner.id));
  assert_eq!(ws.name, "New Workspace");

  // 3. Update Workspace
  let updated = workspace_store
    .update_workspace(
      ws.id,
      UpdateWorkspace {
        name: Some(
          myoxus_application::workspace::WorkspaceName::parse("Persisted Workspace").expect("valid workspace name"),
        ),
        description: Some("First line\n<script>literal</script> 😀".to_string()),
        public: Some(true),
        ..Default::default()
      },
    )
    .await
    .expect("Failed to update workspace");
  assert_eq!(updated.name, "Persisted Workspace");
  assert_eq!(updated.description, "First line\n<script>literal</script> 😀");
  assert!(updated.public);

  let reloaded = workspace_store
    .get_workspace(ws.id)
    .await
    .expect("Failed to reload workspace")
    .expect("Workspace missing after update");
  assert_eq!(reloaded.description, updated.description);

  let cleared = workspace_store
    .update_workspace(
      ws.id,
      UpdateWorkspace {
        description: Some(String::new()),
        ..Default::default()
      },
    )
    .await
    .expect("Failed to clear workspace description");
  assert!(cleared.description.is_empty());

  // 4. List members
  let members = workspace_store
    .list_workspace_members(ws.id, 0, 10, None)
    .await
    .expect("Failed to list members");
  assert_eq!(members.len(), 1);
  assert_eq!(members[0].user.id, owner.id);
  assert_eq!(members[0].role, myoxus_domain::entities::WorkspaceRole::Owner);
  assert_eq!(members[0].status, myoxus_domain::entities::MembershipStatus::Accepted);
  assert!(!members[0].invite_id.is_nil()); // Should be a real UUID from 0006 migration

  // 5. Member count
  let count = workspace_store
    .count_workspace_members(ws.id)
    .await
    .expect("Failed to count members");
  assert_eq!(count, 1);

  // 6. Get owner
  let fetched_owner = workspace_store
    .get_workspace_owner(ws.id)
    .await
    .expect("Failed to get owner");
  assert!(fetched_owner.is_some());
  assert_eq!(fetched_owner.unwrap().id, owner.id);

  // 7. Delete Workspace
  workspace_store
    .delete_workspace(ws.id)
    .await
    .expect("Failed to delete workspace");
  let ws_after = workspace_store
    .get_workspace(ws.id)
    .await
    .expect("Failed to get workspace after delete");
  assert!(ws_after.is_none());
}
