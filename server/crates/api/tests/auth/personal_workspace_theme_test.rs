// SPDX-License-Identifier: AGPL-3.0-or-later
//! Theme-selection invariants for the canonical personal workspace.
//!
//! The permission boundary is the caller's one canonical personal workspace,
//! not account preferences and not workspace ownership. This test deliberately
//! gives the caller a second owned workspace to prevent role-based regressions.

use serde_json::json;

use crate::helpers;

#[test]
fn personal_workspace_theme_is_scoped_to_the_canonical_userspace() {
  helpers::block_on_large_stack("personal-workspace-theme", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "personal_theme_owner").await;
    let personal_workspace_id = helpers::create_workspace(&pool, owner_id).await;
    sqlx::query("UPDATE workspaces SET is_personal_workspace = TRUE WHERE id = $1")
      .bind(personal_workspace_id)
      .execute(&pool)
      .await
      .expect("mark canonical personal workspace");
    let additional_owned_workspace_id = helpers::create_workspace(&pool, owner_id).await;

    let initial = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": r#"
        query PersonalTheme($workspaceId: ID!) {
          personalWorkspaceThemeCatalog(workspaceId: $workspaceId) {
            slug
            name
          }
          personalWorkspaceThemeSelection(workspaceId: $workspaceId) {
            workspaceId
            themeSlug
            inheritsGlobal
          }
        }
      "#,
        "variables": { "workspaceId": personal_workspace_id.to_string() }
      }),
    )
    .await;
    assert!(
      initial.get("errors").is_none(),
      "canonical personal workspace theme query failed: {initial}"
    );
    assert!(
      initial["data"]["personalWorkspaceThemeCatalog"]
        .as_array()
        .is_some_and(|themes| themes.iter().any(|theme| theme["slug"] == "hamburg")),
      "the server-owned theme catalog must be available to the personal workspace"
    );
    assert_eq!(
      initial["data"]["personalWorkspaceThemeSelection"]["workspaceId"],
      personal_workspace_id.to_string()
    );
    assert_eq!(
      initial["data"]["personalWorkspaceThemeSelection"]["inheritsGlobal"],
      true
    );

    let selected = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": r#"
        mutation SelectPersonalTheme($input: SetPersonalWorkspaceThemeInput!) {
          setPersonalWorkspaceTheme(input: $input) {
            workspaceId
            themeSlug
            inheritsGlobal
          }
        }
      "#,
        "variables": {
          "input": {
            "workspaceId": personal_workspace_id.to_string(),
            "themeSlug": "hamburg"
          }
        }
      }),
    )
    .await;
    assert!(
      selected.get("errors").is_none(),
      "canonical personal workspace theme mutation failed: {selected}"
    );
    assert_eq!(selected["data"]["setPersonalWorkspaceTheme"]["themeSlug"], "hamburg");
    assert_eq!(selected["data"]["setPersonalWorkspaceTheme"]["inheritsGlobal"], false);
    sqlx::query("UPDATE theme_profiles SET theme_mode = 'dark' WHERE scope = 'workspace' AND workspace_id = $1")
      .bind(personal_workspace_id)
      .execute(&pool)
      .await
      .expect("set independent workspace profile mode");

    let reselected = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": r#"
        mutation ReselectPersonalTheme($input: SetPersonalWorkspaceThemeInput!) {
          setPersonalWorkspaceTheme(input: $input) { themeSlug }
        }
      "#,
        "variables": {
          "input": {
            "workspaceId": personal_workspace_id.to_string(),
            "themeSlug": "berlin"
          }
        }
      }),
    )
    .await;
    assert!(
      reselected.get("errors").is_none(),
      "catalog-theme reselection failed: {reselected}"
    );
    let preserved_mode: String =
      sqlx::query_scalar("SELECT theme_mode FROM theme_profiles WHERE scope = 'workspace' AND workspace_id = $1")
        .bind(personal_workspace_id)
        .fetch_one(&pool)
        .await
        .expect("load workspace profile mode after theme selection");
    assert_eq!(
      preserved_mode, "dark",
      "theme selection must not mutate the independent profile mode"
    );

    let rejected_owned = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": r#"
        mutation SelectThemeOutsideUserspace($input: SetPersonalWorkspaceThemeInput!) {
          setPersonalWorkspaceTheme(input: $input) { themeSlug }
        }
      "#,
        "variables": {
          "input": {
            "workspaceId": additional_owned_workspace_id.to_string(),
            "themeSlug": "berlin"
          }
        }
      }),
    )
    .await;
    assert!(
      rejected_owned.get("errors").is_some(),
      "a second owned workspace must not gain personal-workspace theme access: {rejected_owned}"
    );
    let leaked_profile: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM theme_profiles WHERE scope = 'workspace' AND workspace_id = $1")
        .bind(additional_owned_workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count rejected workspace theme profiles");
    assert_eq!(leaked_profile, 0, "a rejected mutation must not write a theme profile");

    let rejected_unknown = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": r#"
        mutation SelectUnknownTheme($input: SetPersonalWorkspaceThemeInput!) {
          setPersonalWorkspaceTheme(input: $input) { themeSlug }
        }
      "#,
        "variables": {
          "input": {
            "workspaceId": personal_workspace_id.to_string(),
            "themeSlug": "not-a-theme"
          }
        }
      }),
    )
    .await;
    assert!(
      rejected_unknown.get("errors").is_some(),
      "an unknown theme must be rejected: {rejected_unknown}"
    );
    let persisted_slug: String = sqlx::query_scalar(
      r#"
      SELECT t.slug
      FROM theme_profiles profile
      JOIN themes t ON t.id = profile.theme_id
      WHERE profile.scope = 'workspace' AND profile.workspace_id = $1
    "#,
    )
    .bind(personal_workspace_id)
    .fetch_one(&pool)
    .await
    .expect("load persisted personal workspace theme");
    assert_eq!(
      persisted_slug, "berlin",
      "a rejected mutation must preserve the prior selection"
    );

    let reset = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": r#"
        mutation ResetPersonalTheme($workspaceId: ID!) {
          resetPersonalWorkspaceTheme(workspaceId: $workspaceId) {
            workspaceId
            themeSlug
            inheritsGlobal
          }
        }
      "#,
        "variables": { "workspaceId": personal_workspace_id.to_string() }
      }),
    )
    .await;
    assert!(reset.get("errors").is_none(), "personal theme reset failed: {reset}");
    assert_eq!(reset["data"]["resetPersonalWorkspaceTheme"]["inheritsGlobal"], true);
    let remaining_profile: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM theme_profiles WHERE scope = 'workspace' AND workspace_id = $1")
        .bind(personal_workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count reset workspace theme profiles");
    assert_eq!(remaining_profile, 0, "reset must restore global inheritance");

    helpers::cleanup_users(&pool, &[owner_id]).await;
  });
}
