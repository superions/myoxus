// SPDX-License-Identifier: AGPL-3.0-or-later
//! Semantic roundtrip, validation and rollback tests for the Organization
//! import/export GraphQL surface (Paket H, exposed via `ORG-D-06..D-08`).
//!
//! Covered:
//!   - `ORG-H-T01` JSON export → import roundtrip is idempotent
//!   - `ORG-H-T02` CSV export → import roundtrip is idempotent
//!   - `ORG-H-T03` Parent cycle is reported in dry-run
//!   - `ORG-H-T04` Apply writes an audit row
//!   - `ORG-D-T05` Dry-run does NOT persist anything
//!   - strict nested JSON/typed CSV rejection
//!   - rollback after late workspace failure, including derived state
//!   - apply-time hierarchy revalidation after a clean preview

use crate::helpers;

use serde_json::json;

/// `ORG-D-T05` / `ORG-H-T03 (negative)` — dry-run with a parent cycle
/// surfaces the cycle as a structured error and does NOT persist the
/// snapshot.
#[tokio::test]
async fn inv_org_h_t03_dry_run_reports_parent_cycle() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  // Build a snapshot with a 2-cycle: a → b → a.
  let snapshot = json!({
    "schemaVersion": 1,
    "organization": {"key": "myoxus", "name": "Myoxus", "slug": "myoxus", "metadata": {}},
    "unitTypes": [{
      "key": "team", "label": "Team",
      "isStructural": false, "canHaveChildren": true, "canBeRootLevel": true,
      "canBeManagerCreated": false, "canHaveCrossUnitMembers": false,
      "canOwnWorkspaces": true, "canManageWorkspaces": true
    }],
    "units": [
      {"slug": "alpha", "parentSlug": "beta", "typeKey": "team", "name": "Alpha", "status": "active"},
      {"slug": "beta",  "parentSlug": "alpha", "typeKey": "team", "name": "Beta",  "status": "active"}
    ],
    "members": [],
    "workspaceLinks": [],
    "policies": {
      "managerRootProjectCreation": "disabled",
      "managerUnitProjectCreation": "disabled",
      "managerCanCreateWorkspaces": false,
      "managerCanManageOuMembers": false,
      "importExportEnabled": true
    }
  });

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($j: String!) { admin { organizationImportDryRun(input: {json: $j}) { errors { source row field message } summary { unitsInserted } } } }",
      "variables": {"j": snapshot.to_string()}
    }),
  )
  .await;
  let errors = resp["data"]["admin"]["organizationImportDryRun"]["errors"]
    .as_array()
    .unwrap_or_else(|| panic!("dry-run must return errors array, got: {resp}"));
  assert!(!errors.is_empty(), "expected at least one error, got: {resp}");
  let cycle_seen = errors.iter().any(|e| {
    e["message"]
      .as_str()
      .map(|m| m.contains("parent cycle") || m.contains("32 hops"))
      .unwrap_or(false)
  });
  assert!(cycle_seen, "expected parent cycle error, got: {resp}");

  // Sanity: no row with slug 'alpha' was persisted.
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit WHERE slug = 'alpha'")
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(count, 0, "dry-run must not persist anything");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn inv_org_import_rejects_invalid_typed_member_limits() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let invalid_json = json!({
    "schemaVersion": 1,
    "organization": {"key": "myoxus", "name": "Myoxus", "slug": "myoxus", "metadata": {}},
    "unitTypes": [{
      "key": "team", "label": "Team",
      "isStructural": false, "canHaveChildren": true, "canBeRootLevel": true,
      "canBeManagerCreated": false, "canHaveCrossUnitMembers": false,
      "canOwnWorkspaces": true, "canManageWorkspaces": true
    }],
    "units": [{
      "slug": "invalid-limit", "typeKey": "team", "name": "Invalid limit",
      "status": "active", "maxMembers": 0
    }],
    "members": [],
    "workspaceLinks": [],
    "policies": {
      "managerRootProjectCreation": "disabled",
      "managerUnitProjectCreation": "disabled",
      "managerCanCreateWorkspaces": false,
      "managerCanManageOuMembers": false,
      "importExportEnabled": true
    }
  });
  let json_response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($j: String!) { admin { organizationImportDryRun(input: {json: $j}) { errors { field message } } } }",
      "variables": {"j": invalid_json.to_string()}
    }),
  )
  .await;
  assert!(
    json_response["data"]["admin"]["organizationImportDryRun"]["errors"]
      .as_array()
      .is_some_and(|errors| errors.iter().any(|error| {
        error["field"] == "maxMembers"
          && error["message"]
            .as_str()
            .is_some_and(|message| message.contains("at least 1"))
      })),
    "JSON dry-run must reject maxMembers below one: {json_response}"
  );

  let invalid_csv_response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($files: [OrganizationCsvFileInput!]) { admin { organizationImportDryRun(input: {files: $files}) { errors { field message } } } }",
      "variables": {
        "files": [
          {"name": "organization.csv", "content": "key,name,slug\nmyoxus,Myoxus,myoxus\n"},
          {"name": "ou_types.csv", "content": "key,label,is_structural,can_have_children,can_be_root_level,can_be_manager_created,can_have_cross_unit_members,can_own_workspaces,can_manage_workspaces,is_staff_unit,requires_admin_approval\nteam,Team,false,true,true,false,false,true,true,false,false\n"},
          {"name": "ous.csv", "content": "key,parent_key,type_key,name,slug,status,max_members\ninvalid-limit,,team,Invalid limit,invalid-limit,active,not-a-number\n"},
          {"name": "ou_members.csv", "content": "ou_key,user_email,role,source\n"},
          {"name": "ou_workspaces.csv", "content": "ou_key,workspace_id,relationship\n"}
        ]
      }
    }),
  )
  .await;
  assert!(
    invalid_csv_response["data"]["admin"]["organizationImportDryRun"]["errors"]
      .as_array()
      .is_some_and(|errors| errors.iter().any(|error| {
        error["field"] == "max_members"
          && error["message"]
            .as_str()
            .is_some_and(|message| message.contains("invalid integer"))
      })),
    "CSV import must identify and reject the malformed typed value instead of applying the default: {invalid_csv_response}"
  );

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit WHERE slug = 'invalid-limit'")
    .fetch_one(&pool)
    .await
    .expect("count rejected import rows");
  assert_eq!(count, 0, "invalid dry-runs must not persist an organization unit");

  let unknown_nested = json!({
    "schemaVersion": 1,
    "organization": {
      "key": "myoxus", "name": "Myoxus", "slug": "myoxus", "metadata": {},
      "unexpectedNested": true
    },
    "policies": {
      "managerRootProjectCreation": "disabled",
      "managerUnitProjectCreation": "disabled",
      "managerCanCreateWorkspaces": false,
      "managerCanManageOuMembers": false,
      "importExportEnabled": true
    }
  })
  .to_string();
  let duplicate_nested = r#"{
    "schemaVersion": 1,
    "organization": {
      "key": "myoxus", "key": "duplicate", "name": "Myoxus", "slug": "myoxus", "metadata": {}
    },
    "policies": {
      "managerRootProjectCreation": "disabled",
      "managerUnitProjectCreation": "disabled",
      "managerCanCreateWorkspaces": false,
      "managerCanManageOuMembers": false,
      "importExportEnabled": true
    }
  }"#;
  for (snapshot, expected) in [
    (unknown_nested.as_str(), "unknown field `unexpectedNested`"),
    (duplicate_nested, "duplicate field `key`"),
  ] {
    let response = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($j: String!) { admin { organizationImportDryRun(input: {json: $j}) { errors { source message } } } }",
        "variables": {"j": snapshot}
      }),
    )
    .await;
    let errors = response["data"]["admin"]["organizationImportDryRun"]["errors"]
      .as_array()
      .unwrap_or_else(|| panic!("strict JSON rejection must be structured: {response}"));
    assert!(
      errors
        .iter()
        .any(|error| error["source"] == "snapshot" && error["message"].as_str().is_some_and(|m| m.contains(expected))),
      "strict nested JSON error must remain actionable: {response}"
    );
  }

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// `ORG-H-T01` — JSON export → apply roundtrip yields the same snapshot.
/// Verifies the round-trip invariant on the default seeded organisation.
#[tokio::test]
async fn inv_org_h_t01_json_roundtrip_is_idempotent() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
  let (member_id, _) = helpers::seed_user(&pool, &auth, "org_json_member").await;
  let organization_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let parent_id = helpers::create_organization_unit(&pool, organization_id, unit_type_id, None, "JSON parent").await;
  let child_id =
    helpers::create_organization_unit(&pool, organization_id, unit_type_id, Some(parent_id), "JSON child").await;
  sqlx::query(
    "UPDATE organization_unit
        SET max_members = 37,
            description = 'roundtrip description',
            metadata = '{\"fixture\":\"json\",\"nested\":{\"value\":1}}'::jsonb
      WHERE id = $1",
  )
  .bind(child_id)
  .execute(&pool)
  .await
  .expect("stage JSON roundtrip unit fields");
  sqlx::query(
    "INSERT INTO organization_unit_member
       (unit_id, user_id, role, source, metadata, created_at, updated_at)
     VALUES ($1, $2, 'member', 'manual', '{\"fixture\":\"json-member\"}'::jsonb, now(), now())",
  )
  .bind(child_id)
  .bind(member_id)
  .execute(&pool)
  .await
  .expect("stage JSON roundtrip membership");
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  sqlx::query(
    "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
     VALUES ($1, $2, 'managed')",
  )
  .bind(parent_id)
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("stage JSON roundtrip workspace link");

  let export = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { organizationExport { schemaVersion json } } }"}),
  )
  .await;
  let json_str = export["data"]["admin"]["organizationExport"]["json"]
    .as_str()
    .unwrap_or_else(|| panic!("export must contain json, got: {export}"))
    .to_string();
  assert_eq!(
    export["data"]["admin"]["organizationExport"]["schemaVersion"], 1,
    "schemaVersion must be 1, got: {export}"
  );
  let snapshot: serde_json::Value = serde_json::from_str(&json_str).expect("organization export must be valid JSON");
  let exported_unit = snapshot["units"]
    .as_array()
    .and_then(|units| units.iter().find(|unit| unit["name"] == "JSON child"))
    .unwrap_or_else(|| panic!("export must contain the synthetic OU: {snapshot}"));
  assert_eq!(
    exported_unit["maxMembers"], 37,
    "JSON export must serialize the typed member limit"
  );
  assert_eq!(exported_unit["metadata"]["nested"]["value"], 1);
  assert!(
    snapshot["members"].as_array().is_some_and(|members| members
      .iter()
      .any(|member| member["metadata"]["fixture"] == "json-member")),
    "full JSON export must carry membership metadata: {snapshot}"
  );
  assert!(
    snapshot["workspaceLinks"].as_array().is_some_and(|links| links
      .iter()
      .any(|link| { link["workspaceId"] == workspace_id.to_string() && link["relationship"] == "managed" })),
    "full JSON export must carry workspace relationships: {snapshot}"
  );

  // Snapshot of the units count BEFORE apply for invariant assertion.
  let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit")
    .fetch_one(&pool)
    .await
    .unwrap();

  let apply = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($j: String!) { admin { organizationImportApply(input: {json: $j}) { errors { message } summary { organizationUpdated } } } }",
      "variables": {"j": json_str.clone()}
    }),
  )
  .await;
  let errors = apply["data"]["admin"]["organizationImportApply"]["errors"]
    .as_array()
    .unwrap();
  assert!(errors.is_empty(), "roundtrip must produce no errors, got: {apply}");
  assert_eq!(
    apply["data"]["admin"]["organizationImportApply"]["summary"]["organizationUpdated"], true,
    "summary should report organizationUpdated=true, got: {apply}"
  );

  let repeated = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($j: String!) { admin { organizationImportApply(input: {json: $j}) { errors { message } } } }",
      "variables": {"j": json_str}
    }),
  )
  .await;
  assert!(
    repeated["data"]["admin"]["organizationImportApply"]["errors"]
      .as_array()
      .is_some_and(Vec::is_empty),
    "repeated JSON import must remain successful: {repeated}"
  );

  // INV: the row count after apply must equal the row count before
  //     (idempotency — pure update path, no inserts).
  let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit")
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(before, after, "import must be idempotent on already-present units");
  let max_members: i32 = sqlx::query_scalar("SELECT max_members FROM organization_unit WHERE id = $1")
    .bind(child_id)
    .fetch_one(&pool)
    .await
    .expect("load JSON roundtrip member limit");
  assert_eq!(max_members, 37);

  let stable_ids: Vec<uuid::Uuid> =
    sqlx::query_scalar("SELECT id FROM organization_unit WHERE id = ANY($1) ORDER BY id")
      .bind(&[parent_id, child_id])
      .fetch_all(&pool)
      .await
      .expect("load stable imported unit IDs");
  let mut expected_ids = vec![parent_id, child_id];
  expected_ids.sort_unstable();
  assert_eq!(stable_ids, expected_ids, "re-import must preserve stable OU IDs");

  let after_export = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { organizationExport { json } } }"}),
  )
  .await;
  let after_snapshot: serde_json::Value = serde_json::from_str(
    after_export["data"]["admin"]["organizationExport"]["json"]
      .as_str()
      .expect("second export JSON"),
  )
  .expect("second export must remain valid JSON");
  assert_eq!(snapshot, after_snapshot, "full JSON semantics must roundtrip exactly");

  helpers::cleanup_organization_units(&pool, &[child_id, parent_id]).await;
  helpers::cleanup_users(&pool, &[member_id, admin_id]).await;
}

/// `ORG-H-T02` — CSV export → import roundtrip is idempotent.
///
/// Exports the snapshot, picks the five CSV files out of the response,
/// pipes them back into `organizationImportApply` with the `files`
/// shape, and asserts no errors + idempotency on the unit count.
#[tokio::test]
async fn inv_org_h_t02_csv_roundtrip_is_idempotent() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
  let (member_id, _) = helpers::seed_user(&pool, &auth, "org_csv_member").await;
  let organization_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, organization_id, unit_type_id, None, "CSV max members").await;
  sqlx::query(
    "UPDATE organization_unit
        SET max_members = 43,
            description = 'CSV-preserved description',
            metadata = '{\"fixture\":\"csv-unit\"}'::jsonb
      WHERE id = $1",
  )
  .bind(unit_id)
  .execute(&pool)
  .await
  .expect("stage CSV roundtrip unit fields");
  sqlx::query(
    "INSERT INTO organization_unit_member
       (unit_id, user_id, role, source, metadata, created_at, updated_at)
     VALUES ($1, $2, 'member', 'manual', '{\"fixture\":\"csv-member\"}'::jsonb, now(), now())",
  )
  .bind(unit_id)
  .bind(member_id)
  .execute(&pool)
  .await
  .expect("stage CSV roundtrip membership");

  let preserved_before: serde_json::Value = sqlx::query_scalar(
    r#"SELECT jsonb_build_object(
         'organizationMetadata', o.metadata,
         'typeDescription', t.description,
         'typeIcon', t.icon,
         'typeColor', t.color,
         'typePreset', t.is_preset,
         'typeActive', t.is_active,
         'typeMetadata', t.metadata,
         'unitDescription', u.description,
         'unitMetadata', u.metadata,
         'memberMetadata', m.metadata,
         'policyRoot', p.manager_root_project_creation,
         'policyUnit', p.manager_unit_project_creation,
         'policyCreate', p.manager_can_create_workspaces,
         'policyMembers', p.manager_can_manage_ou_members,
         'policyImportExport', p.import_export_enabled,
         'policyMetadata', p.metadata)
       FROM organization o
       JOIN organization_unit_type t ON t.id = $2
       JOIN organization_unit u ON u.id = $3
       JOIN organization_unit_member m ON m.unit_id = u.id AND m.user_id = $4
       JOIN organization_policy p ON p.organization_id = o.id
      WHERE o.id = $1"#,
  )
  .bind(organization_id)
  .bind(unit_type_id)
  .bind(unit_id)
  .bind(member_id)
  .fetch_one(&pool)
  .await
  .expect("snapshot CSV-absent authoritative fields");

  let export = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { organizationExport { files { name content } } } }"}),
  )
  .await;

  let files = export["data"]["admin"]["organizationExport"]["files"]
    .as_array()
    .unwrap_or_else(|| panic!("export must contain files array, got: {export}"));
  assert!(
    files.len() == 5,
    "expected 5 csv files (organization/ou_types/ous/ou_members/ou_workspaces), got {}",
    files.len()
  );
  let units_csv = files
    .iter()
    .find(|file| file["name"] == "ous.csv")
    .and_then(|file| file["content"].as_str())
    .unwrap_or_else(|| panic!("CSV export must contain ous.csv: {export}"));
  assert!(
    units_csv
      .lines()
      .next()
      .is_some_and(|header| header.contains("max_members")),
    "ous.csv must expose the typed max_members column: {units_csv}"
  );
  assert!(
    units_csv.lines().any(|row| row.trim_end().ends_with(",43")),
    "ous.csv must serialize the non-default member limit: {units_csv}"
  );

  let files_input: Vec<serde_json::Value> = files
    .iter()
    .map(|f| {
      let content = f["content"].as_str().unwrap();
      let content = if f["name"] == "ous.csv" {
        let updated = content.replace(",43", ",61");
        assert_ne!(updated, content, "CSV fixture must contain the represented value");
        updated
      } else {
        content.to_string()
      };
      json!({
        "name": f["name"].as_str().unwrap(),
        "content": content,
      })
    })
    .collect();

  let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit")
    .fetch_one(&pool)
    .await
    .unwrap();

  let apply = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($f: [OrganizationCsvFileInput!]) { admin { organizationImportApply(input: {files: $f}) { errors { source row field message } summary { organizationUpdated } } } }",
      "variables": { "f": files_input.clone() }
    }),
  )
  .await;

  let errors = apply["data"]["admin"]["organizationImportApply"]["errors"]
    .as_array()
    .unwrap_or_else(|| panic!("apply response must include errors array: {apply}"));
  assert!(errors.is_empty(), "csv roundtrip must produce no errors, got: {apply}");

  let repeated = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($f: [OrganizationCsvFileInput!]) { admin { organizationImportApply(input: {files: $f}) { errors { message } } } }",
      "variables": { "f": files_input }
    }),
  )
  .await;
  assert!(
    repeated["data"]["admin"]["organizationImportApply"]["errors"]
      .as_array()
      .is_some_and(Vec::is_empty),
    "repeated CSV import must remain successful: {repeated}"
  );

  let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit")
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    before, after,
    "csv roundtrip must be idempotent — unit count must not change"
  );
  let max_members: i32 = sqlx::query_scalar("SELECT max_members FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .fetch_one(&pool)
    .await
    .expect("load CSV roundtrip member limit");
  assert_eq!(max_members, 61, "represented CSV columns must be applied");

  let preserved_after: serde_json::Value = sqlx::query_scalar(
    r#"SELECT jsonb_build_object(
         'organizationMetadata', o.metadata,
         'typeDescription', t.description,
         'typeIcon', t.icon,
         'typeColor', t.color,
         'typePreset', t.is_preset,
         'typeActive', t.is_active,
         'typeMetadata', t.metadata,
         'unitDescription', u.description,
         'unitMetadata', u.metadata,
         'memberMetadata', m.metadata,
         'policyRoot', p.manager_root_project_creation,
         'policyUnit', p.manager_unit_project_creation,
         'policyCreate', p.manager_can_create_workspaces,
         'policyMembers', p.manager_can_manage_ou_members,
         'policyImportExport', p.import_export_enabled,
         'policyMetadata', p.metadata)
       FROM organization o
       JOIN organization_unit_type t ON t.id = $2
       JOIN organization_unit u ON u.id = $3
       JOIN organization_unit_member m ON m.unit_id = u.id AND m.user_id = $4
       JOIN organization_policy p ON p.organization_id = o.id
      WHERE o.id = $1"#,
  )
  .bind(organization_id)
  .bind(unit_type_id)
  .bind(unit_id)
  .bind(member_id)
  .fetch_one(&pool)
  .await
  .expect("reload CSV-absent authoritative fields");
  assert_eq!(
    preserved_before, preserved_after,
    "CSV apply must preserve every field absent from its five-file projection"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[member_id, admin_id]).await;
}

/// `ORG-H-T04` — applying a snapshot writes an audit row with category
/// `organization` and action `organization.import.apply`.
#[tokio::test]
async fn inv_org_h_t04_apply_writes_audit_row() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let export = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { organizationExport { json } } }"}),
  )
  .await;
  let json_str = export["data"]["admin"]["organizationExport"]["json"]
    .as_str()
    .unwrap()
    .to_string();

  let apply = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($j: String!) { admin { organizationImportApply(input: {json: $j}) { errors { message } } } }",
      "variables": {"j": json_str}
    }),
  )
  .await;
  let errors = apply["data"]["admin"]["organizationImportApply"]["errors"]
    .as_array()
    .unwrap();
  assert!(errors.is_empty(), "apply must succeed, got: {apply}");

  tokio::time::sleep(std::time::Duration::from_millis(80)).await;
  let audit_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM admin_audit_log
      WHERE event_key = 'organization.import.apply' AND actor_user_id = $1",
  )
  .bind(admin_id)
  .fetch_one(&pool)
  .await
  .expect("count successful organization import audits");
  assert_eq!(audit_count, 1, "one committed import must emit one success audit");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// A late workspace failure must roll back earlier aggregate writes, derived
/// manager capability and owner projection, and must not emit a success audit.
#[tokio::test]
async fn inv_org_import_late_failure_rolls_back_every_owner() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
  let (member_id, _) = helpers::seed_user(&pool, &auth, "org_rollback_manager").await;
  let member_email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
    .bind(member_id)
    .fetch_one(&pool)
    .await
    .expect("load rollback member email");
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let missing_workspace_id = uuid::Uuid::new_v4();
  let owner_before: (String, Option<uuid::Uuid>, Option<uuid::Uuid>) = sqlx::query_as(
    "SELECT owner_principal_type::text, owner_principal_id, owner_user_id
       FROM workspaces WHERE id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("load original workspace owner");

  let export = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { organizationExport { json } } }"}),
  )
  .await;
  let mut snapshot: serde_json::Value = serde_json::from_str(
    export["data"]["admin"]["organizationExport"]["json"]
      .as_str()
      .expect("organization export JSON"),
  )
  .expect("parse organization export JSON");
  let organization_name = snapshot["organization"]["name"]
    .as_str()
    .expect("organization name")
    .to_string();
  snapshot["organization"]["name"] = json!(format!("{organization_name} rollback candidate"));
  let unit_slug = format!("rollback-{}", &member_id.to_string()[..8]);
  snapshot["units"].as_array_mut().expect("units array").push(json!({
    "slug": unit_slug,
    "parentSlug": null,
    "typeKey": "team",
    "name": "Rollback unit",
    "description": "must roll back",
    "status": "active",
    "maxMembers": 17,
    "metadata": {"fixture": "rollback"}
  }));
  snapshot["members"].as_array_mut().expect("members array").push(json!({
    "ouSlug": unit_slug,
    "userEmail": member_email,
    "role": "manager",
    "source": "manual",
    "metadata": {"fixture": "rollback"}
  }));
  let links = snapshot["workspaceLinks"]
    .as_array_mut()
    .expect("workspace links array");
  links.push(json!({
    "ouSlug": unit_slug,
    "workspaceId": workspace_id,
    "relationship": "owner",
    "metadata": {}
  }));
  links.push(json!({
    "ouSlug": unit_slug,
    "workspaceId": missing_workspace_id,
    "relationship": "managed",
    "metadata": {}
  }));
  let snapshot_json = snapshot.to_string();

  let preview = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($j: String!) { admin { organizationImportDryRun(input: {json: $j}) { errors { message } } } }",
      "variables": {"j": snapshot_json.clone()}
    }),
  )
  .await;
  assert!(
    preview["data"]["admin"]["organizationImportDryRun"]["errors"]
      .as_array()
      .is_some_and(Vec::is_empty),
    "the injected reference failure must occur in the transactional apply, not parsing: {preview}"
  );

  let audit_before: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM admin_audit_log
      WHERE event_key = 'organization.import.apply' AND actor_user_id = $1",
  )
  .bind(admin_id)
  .fetch_one(&pool)
  .await
  .expect("count import audits before rollback");
  let apply = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($j: String!) { admin { organizationImportApply(input: {json: $j}) { errors { source message } } } }",
      "variables": {"j": snapshot_json}
    }),
  )
  .await;
  assert!(
    apply["data"]["admin"]["organizationImportApply"]["errors"]
      .as_array()
      .is_some_and(|errors| errors.iter().any(|error| error["source"] == "workspaceLinks")),
    "the missing late workspace reference must reject apply: {apply}"
  );

  let persisted_name: String = sqlx::query_scalar("SELECT name FROM organization WHERE key = 'myoxus'")
    .fetch_one(&pool)
    .await
    .expect("reload organization after rollback");
  assert_eq!(persisted_name, organization_name, "organization update must roll back");
  let unit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit WHERE slug = $1")
    .bind(&unit_slug)
    .fetch_one(&pool)
    .await
    .expect("count rolled-back unit");
  assert_eq!(unit_count, 0, "new unit and its membership must roll back");
  let capability_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM user_features
      WHERE user_id = $1 AND feature_name = 'manager' AND activated = true",
  )
  .bind(member_id)
  .fetch_one(&pool)
  .await
  .expect("count rolled-back manager capability");
  assert_eq!(capability_count, 0, "derived manager capability must roll back");
  let owner_after: (String, Option<uuid::Uuid>, Option<uuid::Uuid>) = sqlx::query_as(
    "SELECT owner_principal_type::text, owner_principal_id, owner_user_id
       FROM workspaces WHERE id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("reload workspace owner after rollback");
  assert_eq!(owner_after, owner_before, "workspace owner projection must roll back");

  tokio::time::sleep(std::time::Duration::from_millis(80)).await;
  let audit_after: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM admin_audit_log
      WHERE event_key = 'organization.import.apply' AND actor_user_id = $1",
  )
  .bind(admin_id)
  .fetch_one(&pool)
  .await
  .expect("count import audits after rollback");
  assert_eq!(
    audit_after, audit_before,
    "rolled-back import must not emit a success audit"
  );

  helpers::cleanup_users(&pool, &[member_id, admin_id]).await;
}

/// A preview is advisory: a hierarchy change before apply must be detected
/// again, and the candidate parent update must not persist.
#[tokio::test]
async fn inv_org_import_revalidates_hierarchy_after_preview() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
  let organization_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let first_id = helpers::create_organization_unit(&pool, organization_id, unit_type_id, None, "Preview first").await;
  let second_id = helpers::create_organization_unit(&pool, organization_id, unit_type_id, None, "Preview second").await;
  let first_slug: String = sqlx::query_scalar("SELECT slug FROM organization_unit WHERE id = $1")
    .bind(first_id)
    .fetch_one(&pool)
    .await
    .expect("load first preview slug");
  let second_slug: String = sqlx::query_scalar("SELECT slug FROM organization_unit WHERE id = $1")
    .bind(second_id)
    .fetch_one(&pool)
    .await
    .expect("load second preview slug");
  let files = json!([
    {"name": "organization.csv", "content": "key,name,slug\nmyoxus,Myoxus,myoxus\n"},
    {"name": "ous.csv", "content": format!(
      "key,parent_key,type_key,name,slug,status,max_members\n{first_slug},{second_slug},team,Preview first,{first_slug},active,25\n"
    )}
  ]);

  let preview = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($f: [OrganizationCsvFileInput!]) { admin { organizationImportDryRun(input: {files: $f}) { errors { message } } } }",
      "variables": {"f": files.clone()}
    }),
  )
  .await;
  assert!(
    preview["data"]["admin"]["organizationImportDryRun"]["errors"]
      .as_array()
      .is_some_and(Vec::is_empty),
    "initial hierarchy preview must be clean: {preview}"
  );

  sqlx::query("UPDATE organization_unit SET parent_unit_id = $1 WHERE id = $2")
    .bind(first_id)
    .bind(second_id)
    .execute(&pool)
    .await
    .expect("change hierarchy after preview");
  let apply = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($f: [OrganizationCsvFileInput!]) { admin { organizationImportApply(input: {files: $f}) { errors { field message } } } }",
      "variables": {"f": files}
    }),
  )
  .await;
  assert!(
    apply["data"]["admin"]["organizationImportApply"]["errors"]
      .as_array()
      .is_some_and(|errors| errors.iter().any(|error| {
        error["field"] == "parentSlug"
          && error["message"]
            .as_str()
            .is_some_and(|message| message.contains("parent cycle"))
      })),
    "apply must revalidate hierarchy changed after preview: {apply}"
  );
  let first_parent: Option<uuid::Uuid> =
    sqlx::query_scalar("SELECT parent_unit_id FROM organization_unit WHERE id = $1")
      .bind(first_id)
      .fetch_one(&pool)
      .await
      .expect("reload first parent after rejected apply");
  assert_eq!(first_parent, None, "rejected apply must not change the candidate unit");

  helpers::cleanup_organization_units(&pool, &[second_id, first_id]).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
