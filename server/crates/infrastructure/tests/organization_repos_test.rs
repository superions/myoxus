// SPDX-License-Identifier: AGPL-3.0-or-later
//! Repository invariants for the Organization domain SQLx implementations.
//!
//! Paket: ORG-D-INFRA (vorgezogen aus Paket D weil Infrastructure-
//! Repositories Voraussetzung fuer GraphQL-Resolver sind).
//!
//! Jeder Test bedient sich frischer UUIDs (Cleanup am Ende), uebernimmt
//! aber die Default-Organisation und das Default-Preset aus den
//! Migrationen. Tests sind atomar und idempotent.

use chrono::Utc;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::{
  OrganizationProjectRequest, OrganizationUnit, OrganizationUnitMember, OrganizationUnitMemberSource,
  OrganizationUnitRole, OrganizationUnitStatus, OrganizationUnitWorkspaceRelationship, ProjectRequestScope,
  ProjectRequestStatus,
};
use myoxus_domain::repositories::{
  OrganizationPolicyRepository, OrganizationProjectRequestRepository, OrganizationRepository,
  OrganizationUnitMemberRepository, OrganizationUnitRepository, OrganizationUnitTypeRepository,
  OrganizationUnitWorkspaceRepository, RepositoryError,
};
use myoxus_infrastructure::organization::{
  PgOrganizationPolicyRepository, PgOrganizationProjectRequestRepository, PgOrganizationRepository,
  PgOrganizationUnitMemberRepository, PgOrganizationUnitRepository, PgOrganizationUnitTypeRepository,
  PgOrganizationUnitWorkspaceRepository,
};

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .expect("TEST_DATABASE_URL must be set for organization_repos_test");
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

async fn default_org_id(pool: &PgPool) -> Uuid {
  sqlx::query_scalar::<_, Uuid>("SELECT id FROM organization WHERE key = 'myoxus'")
    .fetch_one(pool)
    .await
    .expect("default organisation must be seeded")
}

async fn pick_root_unit_type(pool: &PgPool, org_id: Uuid) -> Uuid {
  sqlx::query_scalar::<_, Uuid>(
    "SELECT id FROM organization_unit_type
     WHERE organization_id = $1 AND is_preset = true AND can_be_root_level = true
     ORDER BY key
     LIMIT 1",
  )
  .bind(org_id)
  .fetch_one(pool)
  .await
  .expect("preset type")
}

async fn seed_user(pool: &PgPool) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(id)
    .bind(format!("org-repo-test-{id}@example.test"))
    .bind("ORG Repo Test User")
    .execute(pool)
    .await
    .expect("seed user");
  id
}

async fn seed_workspace(pool: &PgPool, owner: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(id)
    .bind(owner)
    .bind("ORG Repo Test Workspace")
    .execute(pool)
    .await
    .expect("seed workspace");
  id
}

// ─────────────────────────────────────────────────────────────────────────────
// Organization repo
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_org_d_infra_repo_get_default_organization() {
  let pool = setup_pool().await;
  let repo = PgOrganizationRepository::new(pool.clone());
  let org = repo.get_by_key("myoxus").await.expect("get_by_key");
  assert!(org.is_some(), "default organization must be present");
  let org = org.unwrap();
  assert_eq!(org.key, "myoxus");
  assert_eq!(org.name, "Myoxus Organisation");
  assert_eq!(org.slug, "myoxus");

  let by_id = repo.get_by_id(org.id).await.expect("get_by_id");
  assert!(by_id.is_some());
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit type repo
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_org_d_infra_repo_list_active_types_only() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let repo = PgOrganizationUnitTypeRepository::new(pool.clone());
  let active = repo.list(org_id, false).await.expect("list active");
  let all = repo.list(org_id, true).await.expect("list all");
  assert!(active.len() >= 50, "should include presets");
  assert!(all.len() >= active.len());
  assert!(active.iter().all(|t| t.is_active));
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit repo — cycle detection
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_org_d_infra_repo_unit_repo_blocks_parent_cycle() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let units = PgOrganizationUnitRepository::new(pool.clone());

  let parent_id = Uuid::new_v4();
  let child_id = Uuid::new_v4();
  let now = Utc::now();
  let parent = OrganizationUnit {
    id: parent_id,
    organization_id: org_id,
    parent_unit_id: None,
    unit_type_id: type_id,
    name: "Parent".to_owned(),
    slug: format!("cycle-parent-{parent_id}"),
    description: None,
    status: OrganizationUnitStatus::Active,
    max_members: 25,
    metadata: json!({}),
    created_by: None,
    child_unit_count: 0,
    member_count: 0,
    workspace_count: 0,
    created_at: now,
    updated_at: now,
  };
  let child = OrganizationUnit {
    id: child_id,
    parent_unit_id: Some(parent_id),
    slug: format!("cycle-child-{child_id}"),
    ..parent.clone()
  };
  units.upsert(&parent).await.expect("upsert parent");
  units.upsert(&child).await.expect("upsert child");

  // Attempt to make `parent` a child of `child` → cycle.
  let err = units.set_parent(parent_id, Some(child_id)).await.unwrap_err();
  assert!(
    matches!(err, RepositoryError::Conflict(_)),
    "cycle must be reported as Conflict, got {err:?}"
  );

  // Cleanup (children first because of FK).
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(child_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(parent_id)
    .execute(&pool)
    .await
    .ok();
}

// ─────────────────────────────────────────────────────────────────────────────
// Member repo — round-trip
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_org_d_infra_repo_member_roundtrip() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let units = PgOrganizationUnitRepository::new(pool.clone());
  let members = PgOrganizationUnitMemberRepository::new(pool.clone());

  let user_id = seed_user(&pool).await;
  let unit_id = Uuid::new_v4();
  let now = Utc::now();
  units
    .upsert(&OrganizationUnit {
      id: unit_id,
      organization_id: org_id,
      parent_unit_id: None,
      unit_type_id: type_id,
      name: "Member RT".to_owned(),
      slug: format!("mem-rt-{unit_id}"),
      description: None,
      status: OrganizationUnitStatus::Active,
      max_members: 25,
      metadata: json!({}),
      created_by: None,
      child_unit_count: 0,
      member_count: 0,
      workspace_count: 0,
      created_at: now,
      updated_at: now,
    })
    .await
    .expect("upsert unit");

  // Insert as `member`, then upgrade to `manager`, then remove.
  members
    .upsert(&OrganizationUnitMember {
      unit_id,
      user_id,
      role: OrganizationUnitRole::Member,
      source: OrganizationUnitMemberSource::Manual,
      metadata: json!({}),
      created_at: now,
      updated_at: now,
    })
    .await
    .expect("upsert as member");
  let row = members.get(unit_id, user_id).await.unwrap().unwrap();
  assert_eq!(row.role, OrganizationUnitRole::Member);

  members
    .upsert(&OrganizationUnitMember {
      role: OrganizationUnitRole::Manager,
      ..row
    })
    .await
    .expect("upsert as manager");
  let row = members.get(unit_id, user_id).await.unwrap().unwrap();
  assert_eq!(row.role, OrganizationUnitRole::Manager);

  members.remove(unit_id, user_id).await.expect("remove");
  assert!(members.get(unit_id, user_id).await.unwrap().is_none());

  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

#[tokio::test]
async fn inv_org_member_limit_serializes_the_final_slot_and_allows_role_updates() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let units = PgOrganizationUnitRepository::new(pool.clone());
  let members = PgOrganizationUnitMemberRepository::new(pool.clone());
  let unit_id = Uuid::new_v4();
  let now = Utc::now();
  let unit = OrganizationUnit {
    id: unit_id,
    organization_id: org_id,
    parent_unit_id: None,
    unit_type_id: type_id,
    name: "Concurrent member limit".to_owned(),
    slug: format!("member-limit-{unit_id}"),
    description: None,
    status: OrganizationUnitStatus::Active,
    max_members: 1,
    metadata: json!({}),
    created_by: None,
    child_unit_count: 0,
    member_count: 0,
    workspace_count: 0,
    created_at: now,
    updated_at: now,
  };
  units.upsert(&unit).await.expect("create limited unit");

  let first_user = seed_user(&pool).await;
  let second_user = seed_user(&pool).await;
  let candidate = |user_id| OrganizationUnitMember {
    unit_id,
    user_id,
    role: OrganizationUnitRole::Member,
    source: OrganizationUnitMemberSource::Manual,
    metadata: json!({}),
    created_at: now,
    updated_at: now,
  };

  let first_repo = members.clone();
  let second_repo = members.clone();
  let first_candidate = candidate(first_user);
  let second_candidate = candidate(second_user);
  let (first, second) = tokio::join!(
    first_repo.upsert(&first_candidate),
    second_repo.upsert(&second_candidate)
  );
  assert_eq!(
    usize::from(first.is_ok()) + usize::from(second.is_ok()),
    1,
    "exactly one concurrent insert may claim the final OU slot"
  );
  let rejected = if first.is_err() { first } else { second };
  assert!(
    matches!(
      rejected,
      Err(RepositoryError::Conflict("organization_unit member limit reached"))
    ),
    "the losing insert must report the typed OU limit"
  );

  let admitted_user = members.list_members(unit_id, None).await.expect("list admitted member")[0].user_id;
  let promoted_member = OrganizationUnitMember {
    role: OrganizationUnitRole::Manager,
    ..candidate(admitted_user)
  };
  members
    .upsert(&promoted_member)
    .await
    .expect("an existing member role may change while the unit is full");

  sqlx::query("DELETE FROM organization_unit_member WHERE unit_id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .expect("member cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .expect("unit cleanup");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(vec![first_user, second_user])
    .execute(&pool)
    .await
    .expect("user cleanup");
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit-Workspace repo — Owner-Constraint via Repository
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_org_d_infra_repo_workspace_owner_singleton() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let units = PgOrganizationUnitRepository::new(pool.clone());
  let links = PgOrganizationUnitWorkspaceRepository::new(pool.clone());

  let user_id = seed_user(&pool).await;
  let ws_id = seed_workspace(&pool, user_id).await;
  let unit_a = Uuid::new_v4();
  let unit_b = Uuid::new_v4();
  let now = Utc::now();
  for id in [unit_a, unit_b] {
    units
      .upsert(&OrganizationUnit {
        id,
        organization_id: org_id,
        parent_unit_id: None,
        unit_type_id: type_id,
        name: format!("OW {id}"),
        slug: format!("ow-{id}"),
        description: None,
        status: OrganizationUnitStatus::Active,
        max_members: 25,
        metadata: json!({}),
        created_by: None,
        child_unit_count: 0,
        member_count: 0,
        workspace_count: 0,
        created_at: now,
        updated_at: now,
      })
      .await
      .expect("upsert unit");
  }

  links
    .set_relationship(unit_a, ws_id, OrganizationUnitWorkspaceRelationship::Owner)
    .await
    .expect("first owner relationship must synchronize the workspace projection");
  links
    .set_relationship(unit_b, ws_id, OrganizationUnitWorkspaceRelationship::Managed)
    .await
    .expect("managed allowed");
  links
    .set_relationship(unit_b, ws_id, OrganizationUnitWorkspaceRelationship::Linked)
    .await
    .expect("managed relationship can be changed to linked");
  let unit_b_links = links.list_for_unit(unit_b).await.expect("list changed link");
  assert_eq!(
    unit_b_links.len(),
    1,
    "relationship change must collapse the pair to one row"
  );
  assert_eq!(
    unit_b_links[0].relationship,
    OrganizationUnitWorkspaceRelationship::Linked
  );

  links
    .set_relationship(unit_b, ws_id, OrganizationUnitWorkspaceRelationship::Owner)
    .await
    .expect("setting owner must transfer ownership atomically");
  links
    .set_relationship(unit_b, ws_id, OrganizationUnitWorkspaceRelationship::Owner)
    .await
    .expect("reapplying the same owner relationship must be idempotent");
  let workspace_links = links
    .list_for_workspace(ws_id)
    .await
    .expect("list transferred workspace links");
  assert_eq!(
    workspace_links
      .iter()
      .filter(|link| link.relationship == OrganizationUnitWorkspaceRelationship::Owner)
      .count(),
    1,
    "workspace must retain exactly one owner relationship"
  );
  assert!(
    workspace_links
      .iter()
      .any(|link| { link.unit_id == unit_a && link.relationship == OrganizationUnitWorkspaceRelationship::Managed }),
    "previous owner OU must be demoted to managed"
  );
  let unit_b_link = workspace_links
    .iter()
    .find(|link| link.unit_id == unit_b)
    .expect("new owner link");
  assert_eq!(unit_b_link.relationship, OrganizationUnitWorkspaceRelationship::Owner);

  let owner_projection: (Option<String>, Option<Uuid>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
    r#"SELECT owner_principal_type::text,
              owner_principal_id,
              management_unit_id,
              created_by_user_id
       FROM workspaces
       WHERE id = $1"#,
  )
  .bind(ws_id)
  .fetch_one(&pool)
  .await
  .expect("owner projection after OU transfer");
  assert_eq!(owner_projection.0.as_deref(), Some("ou"));
  assert_eq!(owner_projection.1, Some(unit_b));
  assert_eq!(owner_projection.2, Some(unit_b));
  assert_eq!(owner_projection.3, Some(user_id));

  links
    .set_relationship(unit_a, ws_id, OrganizationUnitWorkspaceRelationship::Owner)
    .await
    .expect("owner transfer must also work in the opposite direction");
  let workspace_links = links.list_for_workspace(ws_id).await.expect("list second transfer");
  assert!(
    workspace_links
      .iter()
      .any(|link| { link.unit_id == unit_b && link.relationship == OrganizationUnitWorkspaceRelationship::Managed }),
    "previous owner OU must be demoted"
  );
  assert!(
    workspace_links
      .iter()
      .any(|link| { link.unit_id == unit_a && link.relationship == OrganizationUnitWorkspaceRelationship::Owner }),
    "target OU must become the sole owner"
  );

  let unassign_error = links
    .unassign(unit_a, ws_id, OrganizationUnitWorkspaceRelationship::Owner)
    .await
    .expect_err("an OU-owned shared workspace must never fall back to its former user owner");
  assert!(matches!(
    unassign_error,
    RepositoryError::Conflict("shared workspace owner must be transferred to another organization unit")
  ));
  let retained_projection: (Option<String>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
    "SELECT owner_principal_type::text, owner_principal_id, management_unit_id FROM workspaces WHERE id = $1",
  )
  .bind(ws_id)
  .fetch_one(&pool)
  .await
  .expect("owner projection after rejected OU owner removal");
  assert_eq!(retained_projection.0.as_deref(), Some("ou"));
  assert_eq!(retained_projection.1, Some(unit_a));
  assert_eq!(retained_projection.2, Some(unit_a));
  assert_eq!(
    links
      .list_for_workspace(ws_id)
      .await
      .expect("links after owner removal")
      .iter()
      .filter(|link| link.relationship == OrganizationUnitWorkspaceRelationship::Owner)
      .count(),
    1,
    "rejected owner removal must preserve the sole OU owner row"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("workspace cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id IN ($1, $2)")
    .bind(unit_a)
    .bind(unit_b)
    .execute(&pool)
    .await
    .expect("unit cleanup");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("user cleanup");
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy repo — default seeded + upsert path
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_org_d_infra_repo_policy_default_then_update() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let repo = PgOrganizationPolicyRepository::new(pool.clone());
  let initial = repo.get(org_id).await.expect("default policy");
  // Upsert with same shape (idempotent) — must not throw.
  let updated = repo.upsert(&initial).await.expect("idempotent upsert");
  assert_eq!(initial.organization_id, updated.organization_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Project request repo — pending → approved transition
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_org_d_infra_repo_project_request_decide() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let user_id = seed_user(&pool).await;
  let repo = PgOrganizationProjectRequestRepository::new(pool.clone());

  let id = Uuid::new_v4();
  let now = Utc::now();
  let request = OrganizationProjectRequest {
    id,
    organization_id: org_id,
    requested_by: user_id,
    requested_scope: ProjectRequestScope::OrganizationRoot,
    parent_unit_id: None,
    proposed_name: "Test Project".to_owned(),
    proposed_type_id: None,
    proposed_members: vec![],
    proposed_workspace: false,
    status: ProjectRequestStatus::Pending,
    decided_by: None,
    decided_at: None,
    metadata: json!({}),
    created_at: now,
    updated_at: now,
  };
  repo.create(&request).await.expect("create");

  // Decide once → ok.
  repo
    .decide(id, ProjectRequestStatus::Approved, user_id)
    .await
    .expect("approve");

  // Decide again on a non-pending row → Conflict.
  let err = repo
    .decide(id, ProjectRequestStatus::Rejected, user_id)
    .await
    .unwrap_err();
  assert!(
    matches!(err, RepositoryError::Conflict(_)),
    "second decide must conflict (status not pending)"
  );

  let fetched = repo.get(id).await.unwrap().unwrap();
  assert_eq!(fetched.status, ProjectRequestStatus::Approved);
  assert_eq!(fetched.decided_by, Some(user_id));
  assert!(fetched.decided_at.is_some());

  // Cleanup.
  sqlx::query("DELETE FROM organization_project_request WHERE id = $1")
    .bind(id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}
