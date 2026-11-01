//! Invariant tests: admin operations MUST return ActionForbidden for non-admin users (P95-API-20).
//!
//! **Invariant INV-API-10**: Every admin resolver MUST reject unauthenticated requests.
//! **Invariant INV-API-11**: Every admin resolver MUST reject authenticated non-admin users.
//! **Invariant INV-API-12**: Admin resolvers MUST succeed for verified admin users.
//!
//! These tests prevent security regressions where an admin-only operation becomes
//! accessible to regular users.

use crate::helpers;

use serde_json::{Value, json};

fn has_action_forbidden(resp: &Value) -> bool {
  resp["errors"]
    .as_array()
    .map(|errs| {
      errs.iter().any(|e| {
        let msg = e["message"].as_str().unwrap_or("");
        let code = e["extensions"]["code"].as_str().unwrap_or("");
        let name = e["extensions"]["name"].as_str().unwrap_or("");
        let etype = e["extensions"]["type"].as_str().unwrap_or("");
        msg.contains("ActionForbidden")
          || code.contains("ACTION_FORBIDDEN")
          || code == "ActionForbidden"
          || name.contains("ACTION_FORBIDDEN")
          || etype.contains("ACTION_FORBIDDEN")
          || code == "FORBIDDEN"
      })
    })
    .unwrap_or(false)
}

fn has_any_error(resp: &Value) -> bool {
  resp["errors"].as_array().map(|e| !e.is_empty()).unwrap_or(false)
}

/// INV-API-10: Unauthenticated requests to admin queries return errors.
#[test]
fn inv_api10_admin_queries_reject_unauthenticated() {
  helpers::block_on_large_stack("inv-api10-admin-queries-anon", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

    // NOTE: `admin { serverInfo }` is intentionally NOT in this list — it is the
    // bootstrap query for the admin login page and must be reachable without
    // a session. See `inv_boot01_admin_serverinfo_public` below.
    let queries = [
      json!({ "query": "{ admin { adminWorkspaces(filter: { skip: 0, first: 5 }) { id } } }" }),
      json!({ "query": "{ admin { users(filter: { skip: 0, first: 5 }) { id } } }" }),
      json!({ "query": "{ admin { orphanedWorkspaces { id } } }" }),
    ];

    for q in &queries {
      let resp = helpers::gql_anon(&app, q.clone()).await;
      assert!(
        has_any_error(&resp),
        "INV-API-10 FAIL: Unauthenticated admin query returned no error. Query: {q:?}"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// INV-BOOT-01: `admin { serverInfo }` MUST be reachable without authentication.
///
/// The admin frontend's `RootRoutes` calls this query on every page load —
/// including the `/auth` login page — to determine whether the server is
/// initialised. If this query requires admin auth, the SWR Suspense throws
/// "authentication required" before the login form can render, leaving every
/// admin permanently locked out. The data returned is identical to the public
/// `serverConfig` query, so there is no confidentiality benefit to gating it.
#[test]
fn inv_boot01_admin_serverinfo_public() {
  helpers::block_on_large_stack("inv-boot01-admin-serverinfo-public", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

    let resp = helpers::gql_anon(
      &app,
      json!({ "query": "{ admin { serverInfo { version initialized } } }" }),
    )
    .await;

    assert!(
      !has_any_error(&resp),
      "INV-BOOT-01 FAIL: anonymous admin.serverInfo returned an error. resp: {resp:?}"
    );
    assert!(
      resp["data"]["admin"]["serverInfo"]["version"].is_string(),
      "INV-BOOT-01 FAIL: anonymous admin.serverInfo.version not present. resp: {resp:?}"
    );

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// INV-API-11: Authenticated non-admin users get ActionForbidden for admin queries.
#[test]
fn inv_api11_admin_queries_reject_non_admin() {
  helpers::block_on_large_stack("inv-api11-admin-queries-non-admin", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
    let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "unauth-q").await;

    // NOTE: `admin { serverInfo }` is intentionally NOT in this list — it is the
    // bootstrap query for the admin login page and is publicly accessible (data
    // is identical to public `serverConfig`). See `inv_boot01_admin_serverinfo_public`.
    let queries = [
      json!({ "query": "{ admin { adminWorkspaces(filter: { skip: 0, first: 5 }) { id } } }" }),
      json!({ "query": "{ admin { users(filter: { skip: 0, first: 5 }) { id } } }" }),
      json!({ "query": "{ admin { orphanedWorkspaces { id } } }" }),
      json!({ "query": "{ admin { adminConfigValues { modules { module } } } }" }),
      json!({ "query": "{ admin { adminDashboard { syncActiveUsers } } }" }),
      json!({ "query": "{ admin { organizationUnits { id } } }" }),
      json!({ "query": "{ admin { loggingConfig { modules { group level } } } }" }),
    ];

    for q in &queries {
      let resp = helpers::gql(&app, user_session, q.clone()).await;
      assert!(
        has_action_forbidden(&resp),
        "INV-API-11 FAIL: Non-admin should get ActionForbidden. Query: {q:?}, resp: {resp:?}"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
  });
}

/// INV-API-11: Authenticated non-admin users get ActionForbidden for admin mutations.
#[test]
fn inv_api11_admin_mutations_reject_non_admin() {
  helpers::block_on_large_stack("inv-api11-admin-mutations-non-admin", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
    let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "unauth-m").await;

    let mutations = [
      json!({ "query": "mutation { admin { triggerFullReindex } }" }),
      json!({ "query": "mutation { admin { resetLogLevels { group level } } }" }),
    ];

    for m in &mutations {
      let resp = helpers::gql(&app, user_session, m.clone()).await;
      assert!(
        has_action_forbidden(&resp),
        "INV-API-11 FAIL: Non-admin should get ActionForbidden. Mutation: {m:?}, resp: {resp:?}"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
  });
}

/// INV-API-10: Unauthenticated requests to admin mutations return errors.
#[test]
fn inv_api10_admin_mutations_reject_unauthenticated() {
  helpers::block_on_large_stack("inv-api10-admin-mutations-anon", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

    let mutations = [
      json!({ "query": "mutation { admin { triggerFullReindex } }" }),
      json!({ "query": "mutation { admin { resetLogLevels { group level } } }" }),
    ];

    for m in &mutations {
      let resp = helpers::gql_anon(&app, m.clone()).await;
      assert!(
        has_any_error(&resp),
        "INV-API-10 FAIL: Unauthenticated admin mutation returned no error. Mutation: {m:?}"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// INV-API-12: Admin resolvers succeed for admin users.
#[test]
fn inv_api12_admin_queries_succeed_for_admin() {
  helpers::block_on_large_stack("inv-api12-admin-queries-admin", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

    let queries = [
      json!({ "query": "{ admin { adminWorkspaces(filter: { skip: 0, first: 5 }) { id name } } }" }),
      json!({ "query": "{ admin { users(filter: { skip: 0, first: 5 }) { id email } } }" }),
      json!({ "query": "{ admin { serverInfo { version initialized } } }" }),
      json!({ "query": "{ admin { storageQuotaConfig { defaultWorkspaceQuotaMb } } }" }),
      json!({ "query": "{ admin { orphanedWorkspaces { id } } }" }),
    ];

    for q in &queries {
      let resp = helpers::gql(&app, admin_session, q.clone()).await;
      assert!(
        !has_any_error(&resp),
        "INV-API-12 FAIL: Admin query failed for admin user. Query: {q:?}, resp: {resp:?}"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}
