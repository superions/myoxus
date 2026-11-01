// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for the Organization GraphQL surface (Paket D).
//!
//! These tests cover:
//!   - `ORG-D-T01` Non-Admin sees no AdminRoot.organization fields
//!   - `ORG-D-T02` Manager sees own scoped queries (`myOrganizationUnits`)
//!   - `ORG-D-T03` Manager cannot manage foreign OUs
//!   - `ORG-D-T04` Admin can create + maintain OU hierarchy
//!
//! All tests follow the invariant-first pattern (LRN-20260312-109): the
//! assertion targets a documented invariant, not just a 200-OK response.

use crate::helpers;

use serde_json::json;
use yrs::{Array, Map, ReadTxn, Transact, Update, updates::decoder::Decode};

/// `ORG-D-T01` — A non-admin session may NOT call admin-scoped Organization
/// queries (`{ admin { organization { id } } }`). The resolver must surface
/// `ActionForbidden` (mapped to a non-empty `errors` array).
#[tokio::test]
async fn inv_org_d_t01_non_admin_blocked_from_admin_organization() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "non_admin").await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { organization { id key name } } }"}),
  )
  .await;

  assert!(
    resp
      .get("errors")
      .map(|e| e.is_array() && !e.as_array().unwrap().is_empty())
      .unwrap_or(false),
    "non-admin must receive an errors array, got: {resp}"
  );
  assert!(
    resp["data"]["admin"]["organization"].is_null(),
    "non-admin must not receive organization payload, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// `ORG-D-T02` — A user who is a member of an OU sees that OU via the
/// caller-scoped `myOrganizationUnits` query.
#[tokio::test]
async fn inv_org_d_t02_manager_sees_own_organization_units() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "ou_manager").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "T02 Test Unit").await;
  helpers::make_manager_of(&pool, user_id, unit_id).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ myOrganizationUnits { id name slug } }"}),
  )
  .await;

  let units = resp["data"]["myOrganizationUnits"]
    .as_array()
    .unwrap_or_else(|| panic!("myOrganizationUnits must be an array, got: {resp}"));
  let found = units.iter().any(|u| u["id"].as_str() == Some(&unit_id.to_string()));
  assert!(
    found,
    "manager should see their own OU in myOrganizationUnits, got: {resp}"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// `ORG-D-T03` — A user without manager-scope on an OU is denied when
/// creating a workspace under that OU. Verifies the policy gate
/// (`canCreateWorkspaceInOrganizationUnit` returning `false`) and the
/// mutation refusing with an error.
#[tokio::test]
async fn inv_org_d_t03_non_manager_cannot_create_workspace_in_foreign_ou() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "outsider").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "T03 Foreign Unit").await;
  // The user is intentionally NOT made a manager of this OU.

  let probe = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($u: ID!) { canCreateWorkspaceInOrganizationUnit(unitId: $u) }",
      "variables": {"u": unit_id.to_string()}
    }),
  )
  .await;
  assert_eq!(
    probe["data"]["canCreateWorkspaceInOrganizationUnit"], false,
    "policy gate must return false for non-manager, got: {probe}"
  );

  let create = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($u: ID!) { createWorkspaceInOrganizationUnit(input: {unitId: $u}) { id } }",
      "variables": {"u": unit_id.to_string()}
    }),
  )
  .await;
  assert!(
    create
      .get("errors")
      .map(|e| e.is_array() && !e.as_array().unwrap().is_empty())
      .unwrap_or(false),
    "non-manager mutation must error, got: {create}"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// `ORG-D-T04` — Admin may create OUs via `upsertOrganizationUnit` and the
/// row appears in `organizationUnits`. Verifies the admin write-path
/// invariant: state visible after mutation matches the documented shape.
#[tokio::test]
async fn inv_org_d_t04_admin_can_upsert_and_list_unit() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "organisation").await;

  let upsert = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($t: ID!) { admin { upsertOrganizationUnit(input: {unitTypeId: $t, name: \"T04 Hierarchy\", slug: \"t04-hierarchy\"}) { id name slug maxMembers } } }",
      "variables": {"t": unit_type_id.to_string()}
    }),
  )
  .await;
  let new_id = upsert["data"]["admin"]["upsertOrganizationUnit"]["id"]
    .as_str()
    .unwrap_or_else(|| panic!("admin mutation must return id, got: {upsert}"))
    .to_string();
  assert_eq!(
    upsert["data"]["admin"]["upsertOrganizationUnit"]["name"], "T04 Hierarchy",
    "admin upsert must echo name, got: {upsert}"
  );
  assert_eq!(
    upsert["data"]["admin"]["upsertOrganizationUnit"]["maxMembers"], 25,
    "create without maxMembers must use the typed default: {upsert}"
  );

  let update = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($id: ID!, $t: ID!, $limit: Int) { admin { upsertOrganizationUnit(input: {id: $id, unitTypeId: $t, name: \"T04 Hierarchy\", slug: \"t04-hierarchy\", maxMembers: $limit}) { id maxMembers } } }",
      "variables": {"id": new_id.clone(), "t": unit_type_id.to_string(), "limit": 31}
    }),
  )
  .await;
  assert_eq!(
    update["data"]["admin"]["upsertOrganizationUnit"]["maxMembers"], 31,
    "explicit maxMembers update must persist: {update}"
  );
  let preserve = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($id: ID!, $t: ID!) { admin { upsertOrganizationUnit(input: {id: $id, unitTypeId: $t, name: \"T04 Hierarchy renamed\", slug: \"t04-hierarchy\"}) { id name maxMembers } } }",
      "variables": {"id": new_id.clone(), "t": unit_type_id.to_string()}
    }),
  )
  .await;
  assert_eq!(
    preserve["data"]["admin"]["upsertOrganizationUnit"]["maxMembers"], 31,
    "update without maxMembers must preserve the stored value: {preserve}"
  );
  let rejected = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($id: ID!, $t: ID!) { admin { upsertOrganizationUnit(input: {id: $id, unitTypeId: $t, name: \"Invalid limit\", slug: \"t04-hierarchy\", maxMembers: 0}) { id } } }",
      "variables": {"id": new_id.clone(), "t": unit_type_id.to_string()}
    }),
  )
  .await;
  assert!(
    rejected.get("errors").is_some(),
    "maxMembers below one must be rejected before persistence: {rejected}"
  );
  let persisted_limit: i32 = sqlx::query_scalar("SELECT max_members FROM organization_unit WHERE id = $1")
    .bind(new_id.parse::<uuid::Uuid>().expect("unit id"))
    .fetch_one(&pool)
    .await
    .expect("load preserved max_members");
  assert_eq!(persisted_limit, 31);

  let list = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { organizationUnits { id name } } }"}),
  )
  .await;
  let units = list["data"]["admin"]["organizationUnits"]
    .as_array()
    .unwrap_or_else(|| panic!("organizationUnits must be array, got: {list}"));
  let exists = units.iter().any(|u| u["id"].as_str() == Some(&new_id));
  assert!(
    exists,
    "admin should see the freshly upserted OU in the list, got: {list}"
  );

  let parsed: uuid::Uuid = new_id.parse().expect("uuid");
  helpers::cleanup_organization_units(&pool, &[parsed]).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// Shared workspace creation atomically persists ownership and canonical root
/// state before returning; owner transfer preserves the single-OU invariant.
#[test]
fn inv_org_shared_workspace_owner_transfer_keeps_one_ou_owner() {
  helpers::block_on_large_stack("inv_org_shared_workspace_owner_transfer_keeps_one_ou_owner", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let first_unit = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "Shared owner first").await;
    let second_unit = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "Shared owner second").await;

    let created = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($unit: ID!, $name: String) { createWorkspaceInOrganizationUnit(input: {unitId: $unit, name: $name}) { id name workspaceType initialized } }",
      "variables": {
        "unit": first_unit.to_string(),
        "name": "  Shared Research  "
      }
    }),
  )
  .await;
    let workspace_id: uuid::Uuid = created["data"]["createWorkspaceInOrganizationUnit"]["id"]
      .as_str()
      .unwrap_or_else(|| panic!("shared create must return a workspace: {created}"))
      .parse()
      .expect("workspace uuid");
    assert_eq!(
      created["data"]["createWorkspaceInOrganizationUnit"]["workspaceType"], "Shared",
      "OU-created workspace must be classified as Shared: {created}"
    );
    assert_eq!(
      created["data"]["createWorkspaceInOrganizationUnit"]["name"], "Shared Research",
      "the persisted name must use the server-normalized input: {created}"
    );
    assert_eq!(
      created["data"]["createWorkspaceInOrganizationUnit"]["initialized"], true,
      "the mutation must not return before root content exists: {created}"
    );

    let projection = sqlx::query_as::<_, (Option<uuid::Uuid>, String, Option<uuid::Uuid>, bool)>(
      r#"SELECT owner_user_id, owner_principal_type::text, owner_principal_id, is_personal_workspace
         FROM workspaces WHERE id = $1"#,
    )
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("load ownership projection");
    assert_eq!(projection, (None, "ou".to_string(), Some(first_unit), false));
    let creator_role: String =
      sqlx::query_scalar("SELECT role::text FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
        .bind(workspace_id)
        .bind(admin_id)
        .fetch_one(&pool)
        .await
        .expect("creator membership");
    assert_eq!(
      creator_role, "Admin",
      "a person must administer, not own, a shared workspace"
    );

    let root_update: Vec<u8> =
      sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1 AND sequence = 1")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("load atomic shared root update");
    let root_doc = yrs::Doc::new();
    let meta = root_doc.get_or_insert_map("meta");
    root_doc
      .transact_mut()
      .apply_update(Update::decode_v1(&root_update).expect("shared root update must decode"))
      .expect("shared root update must apply");
    let root_txn = root_doc.transact();
    assert!(
      matches!(
        meta.get(&root_txn, "name"),
        Some(yrs::Out::Any(yrs::Any::String(name))) if name.as_ref() == "Shared Research"
      ),
      "root meta.name must match the final server-normalized workspace name"
    );
    assert!(
      matches!(meta.get(&root_txn, "pages"), Some(yrs::Out::YArray(ref pages)) if pages.len(&root_txn) == 0),
      "root meta.pages must be an initialized empty YArray"
    );
    drop(root_txn);

    let compatible = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($unit: ID!) { createWorkspaceInOrganizationUnit(input: {unitId: $unit}) { id name initialized } }",
        "variables": { "unit": first_unit.to_string() }
      }),
    )
    .await;
    let compatible_workspace_id: uuid::Uuid = compatible["data"]["createWorkspaceInOrganizationUnit"]["id"]
      .as_str()
      .unwrap_or_else(|| panic!("name-less compatible create must succeed: {compatible}"))
      .parse()
      .expect("compatible workspace uuid");
    assert_eq!(
      compatible["data"]["createWorkspaceInOrganizationUnit"]["name"], "New Workspace",
      "older clients without name must retain the server default: {compatible}"
    );
    assert_eq!(
      compatible["data"]["createWorkspaceInOrganizationUnit"]["initialized"], true,
      "compatible create must also be atomically initialized: {compatible}"
    );

    let rejected = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($unit: ID!) { createWorkspaceInOrganizationUnit(input: {unitId: $unit, name: \"   \"}) { id } }",
        "variables": { "unit": first_unit.to_string() }
      }),
    )
    .await;
    assert!(
      rejected["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
      "an explicitly blank name must fail server validation: {rejected}"
    );
    let first_unit_workspace_count: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM workspaces WHERE owner_principal_type = 'ou' AND owner_principal_id = $1",
    )
    .bind(first_unit)
    .fetch_one(&pool)
    .await
    .expect("count first-unit workspaces");
    assert_eq!(
      first_unit_workspace_count, 2,
      "blank-name rejection must not leave a partial workspace"
    );

    let transferred = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($unit: ID!, $workspace: ID!) { admin { assignOrganizationUnitWorkspace(input: {unitId: $unit, workspaceId: $workspace, relationship: Owner}) } }",
      "variables": { "unit": second_unit.to_string(), "workspace": workspace_id.to_string() }
    }),
  )
  .await;
    assert_eq!(
      transferred["data"]["admin"]["assignOrganizationUnitWorkspace"], true,
      "owner transfer must succeed: {transferred}"
    );

    let links = sqlx::query_as::<_, (uuid::Uuid, String)>(
      r#"SELECT unit_id, relationship::text
         FROM organization_unit_workspace
        WHERE workspace_id = $1
        ORDER BY unit_id"#,
    )
    .bind(workspace_id)
    .fetch_all(&pool)
    .await
    .expect("load workspace relationships");
    assert_eq!(
      links.iter().filter(|(_, relationship)| relationship == "owner").count(),
      1,
      "a shared workspace must have exactly one OU owner: {links:?}"
    );
    assert!(
      links.contains(&(first_unit, "managed".to_string())),
      "the previous OU owner must remain attached as managed: {links:?}"
    );
    assert!(
      links.contains(&(second_unit, "owner".to_string())),
      "the selected OU must become owner: {links:?}"
    );
    let projected_owner: Option<uuid::Uuid> =
      sqlx::query_scalar("SELECT owner_principal_id FROM workspaces WHERE id = $1")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("load projected owner");
    assert_eq!(projected_owner, Some(second_unit));

    helpers::cleanup_workspaces(&pool, &[workspace_id, compatible_workspace_id]).await;
    helpers::cleanup_organization_units(&pool, &[first_unit, second_unit]).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// Shared workspace permission projections consume the effective OU-manager
/// role while preserving the raw membership role.
#[test]
fn inv_org_shared_workspace_effective_capability_projection_preserves_raw_role() {
  helpers::block_on_large_stack(
    "inv_org_shared_workspace_effective_capability_projection_preserves_raw_role",
    || async {
      let (app, pool, auth) = helpers::setup_app().await;
      let (manager_id, manager_session) = helpers::seed_user(&pool, &auth, "shared_cap_manager").await;
      let (outsider_id, outsider_session) = helpers::seed_user(&pool, &auth, "shared_cap_outsider").await;
      let legacy_owner_id = helpers::create_user(&pool, "shared_cap_legacy_owner", false).await;

      let organization_id = helpers::default_organization_id(&pool).await;
      let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
      let unit_id =
        helpers::create_organization_unit(&pool, organization_id, unit_type_id, None, "Shared capability unit").await;
      helpers::make_manager_of(&pool, manager_id, unit_id).await;

      let shared_workspace_id = uuid::Uuid::new_v4();
      sqlx::query(
        r#"INSERT INTO workspaces (
             id, owner_user_id, name, public, owner_principal_type,
             owner_principal_id, management_unit_id, created_by_user_id
           )
           VALUES ($1, NULL, 'Shared capability workspace', FALSE, 'ou', $2, $2, $3)"#,
      )
      .bind(shared_workspace_id)
      .bind(unit_id)
      .bind(legacy_owner_id)
      .execute(&pool)
      .await
      .expect("insert shared workspace");
      sqlx::query(
        r#"INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
           VALUES ($1, $2, 'owner')"#,
      )
      .bind(unit_id)
      .bind(shared_workspace_id)
      .execute(&pool)
      .await
      .expect("link shared workspace owner");
      sqlx::query(
        r#"INSERT INTO docs (
             id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by
           )
           VALUES ($1, $2, $1, 'Shared capability root', TRUE, $3, $3)"#,
      )
      .bind(shared_workspace_id)
      .bind(shared_workspace_id.to_string())
      .bind(legacy_owner_id)
      .execute(&pool)
      .await
      .expect("insert shared workspace root");
      for (user_id, role) in [(outsider_id, "Reader"), (legacy_owner_id, "Owner")] {
        sqlx::query(
          r#"INSERT INTO workspace_memberships
               (workspace_id, user_id, role, status, joined_at)
             VALUES ($1, $2, $3, 'Accepted', now())"#,
        )
        .bind(shared_workspace_id)
        .bind(user_id)
        .bind(role)
        .execute(&pool)
        .await
        .expect("insert shared workspace membership");
      }

      let projection = helpers::gql(
        &app,
        manager_session,
        json!({
          "query": r#"query($workspace: ID!, $doc: String!) {
            workspaces { id }
            workspaceRolePermissions(id: $workspace) {
              role
              permissions {
                Workspace_Users_Manage
                Workspace_Settings_Update
                Workspace_Administrators_Manage
                Workspace_Delete
                Workspace_Organize_Update
                Workspace_Content_Transfer
              }
            }
            workspace(id: $workspace) {
              role
              permissions {
                Workspace_Users_Manage
                Workspace_Settings_Update
                Workspace_Administrators_Manage
                Workspace_Delete
                Workspace_Organize_Update
                Workspace_Content_Transfer
              }
              doc(docId: $doc) {
                permissions { Doc_Update Doc_TransferOwner }
              }
            }
          }"#,
          "variables": {
            "workspace": shared_workspace_id.to_string(),
            "doc": shared_workspace_id.to_string(),
          }
        }),
      )
      .await;
      assert!(
        projection["errors"].is_null(),
        "effective capability query failed: {projection}"
      );
      assert!(
        projection["data"]["workspaces"]
          .as_array()
          .is_some_and(|workspaces| workspaces
            .iter()
            .any(|workspace| { workspace["id"].as_str() == Some(&shared_workspace_id.to_string()) })),
        "OU-managed workspace must be discoverable without a direct membership: {projection}"
      );
      for access in [
        &projection["data"]["workspaceRolePermissions"],
        &projection["data"]["workspace"],
      ] {
        assert_eq!(
          access["role"], "External",
          "raw role must remain External: {projection}"
        );
        assert_eq!(access["permissions"]["Workspace_Users_Manage"], true);
        assert_eq!(access["permissions"]["Workspace_Settings_Update"], true);
        assert_eq!(access["permissions"]["Workspace_Administrators_Manage"], false);
        assert_eq!(access["permissions"]["Workspace_Delete"], false);
        assert_eq!(access["permissions"]["Workspace_Organize_Update"], true);
        assert_eq!(access["permissions"]["Workspace_Content_Transfer"], true);
      }
      assert_eq!(
        projection["data"]["workspace"]["doc"]["permissions"]["Doc_Update"],
        true
      );
      assert_eq!(
        projection["data"]["workspace"]["doc"]["permissions"]["Doc_TransferOwner"],
        false
      );

      let outsider_projection = helpers::gql(
        &app,
        outsider_session,
        json!({
          "query": r#"query($workspace: ID!) {
            workspaceRolePermissions(id: $workspace) {
              permissions {
                Workspace_Users_Manage
                Workspace_Settings_Update
                Workspace_Administrators_Manage
                Workspace_Delete
                Workspace_Organize_Update
                Workspace_Content_Transfer
              }
            }
          }"#,
          "variables": { "workspace": shared_workspace_id.to_string() }
        }),
      )
      .await;
      assert!(
        outsider_projection["errors"].is_null(),
        "reader projection failed: {outsider_projection}"
      );
      for capability in [
        "Workspace_Users_Manage",
        "Workspace_Settings_Update",
        "Workspace_Administrators_Manage",
        "Workspace_Delete",
        "Workspace_Organize_Update",
        "Workspace_Content_Transfer",
      ] {
        assert_eq!(
          outsider_projection["data"]["workspaceRolePermissions"]["permissions"][capability], false,
          "reader must not receive {capability}: {outsider_projection}"
        );
      }
      helpers::cleanup_workspaces(&pool, &[shared_workspace_id]).await;
      helpers::cleanup_organization_units(&pool, &[unit_id]).await;
      helpers::cleanup_users(&pool, &[manager_id, outsider_id, legacy_owner_id]).await;
    },
  );
}

/// `ORG-F-T07` — Admin OU lists expose aggregate counts per unit in the
/// list payload. This backs the admin organigram and must stay a single
/// list read, not a per-node follow-up field resolver.
#[test]
fn inv_org_f_t07_admin_organization_units_expose_counts() {
  helpers::block_on_large_stack("inv_org_f_t07_admin_organization_units_expose_counts", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
    let (member_id, _) = helpers::seed_user(&pool, &auth, "org_count_member").await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let root_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "F07 Root").await;
    let child_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, Some(root_id), "F07 Child").await;
    helpers::make_manager_of(&pool, member_id, root_id).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    sqlx::query(
      r#"INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
       VALUES ($1, $2, 'managed')"#,
    )
    .bind(root_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("link workspace");

    let resp = helpers::gql(
      &app,
      session_id,
      json!({"query": "{ admin { organizationUnits { id childUnitCount memberCount workspaceCount } } }"}),
    )
    .await;
    let units = resp["data"]["admin"]["organizationUnits"]
      .as_array()
      .unwrap_or_else(|| panic!("organizationUnits must be array, got: {resp}"));
    let root = units
      .iter()
      .find(|u| u["id"].as_str() == Some(&root_id.to_string()))
      .unwrap_or_else(|| panic!("root must be listed, got: {resp}"));
    let child = units
      .iter()
      .find(|u| u["id"].as_str() == Some(&child_id.to_string()))
      .unwrap_or_else(|| panic!("child must be listed, got: {resp}"));

    assert_eq!(root["childUnitCount"], 1, "root child count must be 1: {resp}");
    assert_eq!(root["memberCount"], 1, "root member count must be 1: {resp}");
    assert_eq!(root["workspaceCount"], 1, "root workspace count must be 1: {resp}");
    assert_eq!(child["childUnitCount"], 0, "child count must be 0: {resp}");
    assert_eq!(child["memberCount"], 0, "child member count must be 0: {resp}");
    assert_eq!(child["workspaceCount"], 0, "child workspace count must be 0: {resp}");

    helpers::cleanup_organization_units(&pool, &[child_id, root_id]).await;
    helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
    helpers::cleanup_users(&pool, &[admin_id, member_id]).await;
  });
}

/// `ORG-G-05` — manager-scoped member CRUD: a manager of OU `X` can add
/// a `member` (and remove them again), but NOT a `manager` (admin-only).
#[tokio::test]
async fn inv_org_g_05_manager_can_add_and_remove_member_but_not_promote() {
  let (app, pool, auth) = helpers::setup_app().await;
  // The manager
  let (manager_id, session_id) = helpers::seed_user(&pool, &auth, "g05_mgr").await;
  // The target user
  let target_id = helpers::create_user(&pool, "g05_target", false).await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "G05 OU").await;
  helpers::make_manager_of(&pool, manager_id, unit_id).await;

  // Open the manager_can_manage_ou_members policy gate (default = false).
  sqlx::query("UPDATE organization_policy SET manager_can_manage_ou_members = true WHERE organization_id = $1")
    .bind(org_id)
    .execute(&pool)
    .await
    .expect("relax policy");

  // Promotion to manager must be refused.
  let promote = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($u:ID!,$t:ID!) { addOrganizationUnitMemberAsManager(unitId:$u, userId:$t, role: Manager) { unitId } }",
      "variables": {"u": unit_id.to_string(), "t": target_id.to_string()}
    }),
  )
  .await;
  assert!(
    promote
      .get("errors")
      .and_then(|e| e.as_array())
      .map(|a| !a.is_empty())
      .unwrap_or(false),
    "manager must NOT be allowed to grant `manager` role, got: {promote}"
  );

  // Adding as `member` is allowed.
  let add = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($u:ID!,$t:ID!) { addOrganizationUnitMemberAsManager(unitId:$u, userId:$t, role: Member) { unitId userId role } }",
      "variables": {"u": unit_id.to_string(), "t": target_id.to_string()}
    }),
  )
  .await;
  assert_eq!(
    add["data"]["addOrganizationUnitMemberAsManager"]["role"], "Member",
    "add must succeed with role=member, got: {add}"
  );

  // Removal of the same member is allowed.
  let remove = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($u:ID!,$t:ID!) { removeOrganizationUnitMemberAsManager(unitId:$u, userId:$t) }",
      "variables": {"u": unit_id.to_string(), "t": target_id.to_string()}
    }),
  )
  .await;
  assert_eq!(
    remove["data"]["removeOrganizationUnitMemberAsManager"], true,
    "remove must succeed for non-manager target, got: {remove}"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[manager_id, target_id]).await;
}

/// Bonus invariant: `canCreateOrganizationProject(unitId: null)` returns
/// the three-state policy outcome from the default policy. The default
/// The canonical `manager_root_project_creation` policy is
/// `disabled`, so a freshly seeded user (no manager-feature) MUST see
/// `Denied`. Locks down the wiring of the policy gate end-to-end.
#[tokio::test]
async fn inv_org_d_t05_default_policy_root_project_creation_denied() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "policy_probe").await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ canCreateOrganizationProject(unitId: null) }"}),
  )
  .await;
  assert_eq!(
    resp["data"]["canCreateOrganizationProject"], "Denied",
    "default root policy should be DENIED for a non-manager, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
