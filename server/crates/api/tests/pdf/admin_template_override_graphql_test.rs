// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! AdminRoot contract coverage for per-workspace template overrides.
//!
//! The adminfrontend must not call the workspace-facing mutation for operator
//! actions: admins may change a workspace override without being a member of the
//! target workspace. This test pins the AdminRoot path and verifies that the
//! mutation changes the real repository state only for authenticated admins.

use crate::helpers;
use serde_json::{Value, json};
use uuid::Uuid;

fn assert_no_graphql_errors(response: &Value, label: &str) {
  assert!(
    response.get("errors").is_none(),
    "{label} returned GraphQL errors: {response}"
  );
}

fn assert_graphql_rejected(response: &Value, label: &str) {
  assert!(
    response["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
    "{label} must reject unauthorized access: {response}"
  );
}

async fn insert_builtin_template_policy(pool: &sqlx::PgPool, admin_id: Uuid, workspace_id: Uuid) -> Uuid {
  let template_id = Uuid::new_v4();
  let slug = format!("admin-override-{}", template_id.simple());
  sqlx::query(
    r#"INSERT INTO template_catalog_entries (
         id, slug, title, description, category, tags, status, created_by,
         source, builder_version, min_client_version, created_at, updated_at
       ) VALUES ($1, $2, 'Admin Override Test', '', 'test', '{}', 'active', $3,
         'builtin', 1, 0, now(), now())"#,
  )
  .bind(template_id)
  .bind(slug)
  .bind(admin_id)
  .execute(pool)
  .await
  .expect("insert template_catalog_entries");

  sqlx::query(
    r#"INSERT INTO workspace_template_policies (
         workspace_id, template_id, selection_mode, provisioning_mode,
         is_enabled, created_at, updated_at
       ) VALUES ($1, $2, 'published', 'managed_until_local_edit', TRUE, now(), now())"#,
  )
  .bind(workspace_id)
  .bind(template_id)
  .execute(pool)
  .await
  .expect("insert workspace_template_policies");

  template_id
}

async fn cleanup_template_override_fixture(pool: &sqlx::PgPool, template_id: Uuid, workspace_id: Uuid) {
  sqlx::query("DELETE FROM template_registry_audit_events WHERE template_id = $1 OR workspace_id = $2")
    .bind(template_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_template_policies WHERE template_id = $1 OR workspace_id = $2")
    .bind(template_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(template_id)
    .execute(pool)
    .await
    .ok();
}

async fn run_admin_workspace_template_override_updates_real_policy_and_requires_admin() {
  let (app, pool, auth_store) = helpers::setup_app_with_template_registry_service().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "template-override-non-admin").await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let template_id = insert_builtin_template_policy(&pool, admin_id, workspace_id).await;

  let mutation = r#"
      mutation SetOverride($workspaceId: String!, $templateId: String!) {
        admin {
          setWorkspaceTemplateOverride(
            input: {
              workspaceId: $workspaceId
              templateId: $templateId
              isEnabled: false
              provisioningMode: ManualUpdate
            }
          )
        }
      }
    "#;
  let variables = json!({
    "workspaceId": workspace_id.to_string(),
    "templateId": template_id.to_string(),
  });

  let admin = helpers::gql(
    &app,
    admin_session,
    json!({ "query": mutation, "variables": variables.clone() }),
  )
  .await;
  assert_no_graphql_errors(&admin, "admin template override");
  assert_eq!(admin["data"]["admin"]["setWorkspaceTemplateOverride"], true);

  let (is_enabled, provisioning_mode): (bool, String) = sqlx::query_as(
    "SELECT is_enabled, provisioning_mode FROM workspace_template_policies WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(template_id)
  .fetch_one(&pool)
  .await
  .expect("workspace_template_policies row must exist");
  assert!(!is_enabled, "AdminRoot mutation must update is_enabled");
  assert_eq!(provisioning_mode, "manual_update");

  let non_admin = helpers::gql(
    &app,
    user_session,
    json!({ "query": mutation, "variables": variables.clone() }),
  )
  .await;
  assert_graphql_rejected(&non_admin, "non-admin template override");

  let anonymous = helpers::gql_anon(&app, json!({ "query": mutation, "variables": variables })).await;
  assert_graphql_rejected(&anonymous, "anonymous template override");

  cleanup_template_override_fixture(&pool, template_id, workspace_id).await;
  helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
}

#[test]
fn admin_workspace_template_override_updates_real_policy_and_requires_admin() {
  std::thread::Builder::new()
    .name("admin-template-override".to_string())
    .stack_size(16 * 1024 * 1024)
    .spawn(|| {
      let _guard = helpers::TEMPLATE_REGISTRY_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .expect("template registry lock");
      tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run_admin_workspace_template_override_updates_real_policy_and_requires_admin());
    })
    .expect("spawn large-stack template override test thread")
    .join()
    .expect("large-stack template override test thread panicked");
}
