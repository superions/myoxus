// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::helpers;
use futures_util::FutureExt;
use serde_json::json;

#[test]
fn workbench_preferences_are_typed_atomic_and_resettable() {
  helpers::block_on_large_stack("workbench_preferences_are_typed_atomic_and_resettable", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (user_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let (other_user_id, other_session_id) =
      helpers::seed_user(&pool, &auth_store, "dashboard-preference-isolation").await;
    let outcome = std::panic::AssertUnwindSafe(async {
    let workspace_id = "11111111-1111-4111-8111-111111111111";
    let other_workspace_id = "22222222-2222-4222-8222-222222222222";
    let layout = format!(
      r#"[{{workspaceId:"{workspace_id}",viewFamily:DocumentPage,orderedToolIds:[Outline,Tags,DocumentInfo],visibleToolIds:[Outline,Tags],collapsedToolIds:[Tags]}}]"#
    );
    let dashboard_layout = format!(
      r#"[{{workspaceId:"{workspace_id}",orderedDashletIds:[Today,NewDocuments,Reminders,RecentlyEdited,Activity],dashletSizes:[{{dashletId:Today,size:Wide}},{{dashletId:NewDocuments,size:Compact}}]}}]"#
    );

    // Two clients patch unrelated aggregate fields concurrently. The row lock
    // must preserve both writes rather than accepting a stale JSON snapshot.
    let locale = helpers::gql(
      &app,
      session_id,
      json!({"query": "mutation { updatePreferences(input:{locale:\"de\"}) { values { locale } } }"}),
    );
    let tools = helpers::gql(
      &app,
      session_id,
      json!({"query": format!("mutation {{ updatePreferences(input:{{workbenchToolLayouts:{layout}}}) {{ values {{ workbenchToolLayouts {{ workspaceId viewFamily orderedToolIds visibleToolIds collapsedToolIds }} }} }} }}")}),
    );
    let dashboard = helpers::gql(
      &app,
      session_id,
      json!({"query": format!("mutation {{ updatePreferences(input:{{workspaceDashboardLayouts:{dashboard_layout}}}) {{ values {{ workspaceDashboardLayouts {{ workspaceId orderedDashletIds dashletSizes {{ dashletId size }} }} }} }} }}")}),
    );
    let (locale_response, tools_response, dashboard_response) = tokio::join!(locale, tools, dashboard);
    assert!(
      locale_response.get("errors").is_none(),
      "locale patch failed: {locale_response}"
    );
    assert!(
      tools_response.get("errors").is_none(),
      "layout patch failed: {tools_response}"
    );
    assert!(
      dashboard_response.get("errors").is_none(),
      "dashboard patch failed: {dashboard_response}"
    );

    let query = helpers::gql(
      &app,
      session_id,
      json!({"query": "query { currentUser { preferences { values { locale workbenchToolLayouts { workspaceId viewFamily orderedToolIds visibleToolIds collapsedToolIds } workspaceDashboardLayouts { workspaceId orderedDashletIds dashletSizes { dashletId size } } } effectiveValues { workbenchToolLayouts { workspaceId viewFamily } workspaceDashboardLayouts { workspaceId orderedDashletIds } } } } }"}),
    )
    .await;
    let preferences = &query["data"]["currentUser"]["preferences"];
    assert_eq!(preferences["values"]["locale"], "de");
    assert_eq!(
      preferences["values"]["workbenchToolLayouts"][0]["workspaceId"],
      workspace_id
    );
    assert_eq!(
      preferences["values"]["workbenchToolLayouts"][0]["viewFamily"],
      "DocumentPage"
    );
    assert_eq!(
      preferences["values"]["workbenchToolLayouts"][0]["orderedToolIds"],
      json!(["Outline", "Tags", "DocumentInfo"])
    );
    assert_eq!(
      preferences["values"]["workbenchToolLayouts"][0]["visibleToolIds"],
      json!(["Outline", "Tags"])
    );
    assert_eq!(
      preferences["values"]["workbenchToolLayouts"][0]["collapsedToolIds"],
      json!(["Tags"])
    );
    assert_eq!(
      preferences["effectiveValues"]["workbenchToolLayouts"][0]["workspaceId"],
      workspace_id
    );
    assert_eq!(
      preferences["values"]["workspaceDashboardLayouts"][0]["workspaceId"],
      workspace_id
    );
    assert_eq!(
      preferences["values"]["workspaceDashboardLayouts"][0]["orderedDashletIds"],
      json!(["Today", "NewDocuments", "Reminders", "RecentlyEdited", "Activity"])
    );
    assert_eq!(
      preferences["effectiveValues"]["workspaceDashboardLayouts"][0]["workspaceId"],
      workspace_id
    );

    let invalid_tools = helpers::gql(
      &app,
      session_id,
      json!({"query": format!("mutation {{ updatePreferences(input:{{workbenchToolLayouts:[{{workspaceId:\"{workspace_id}\",viewFamily:DocumentPage,orderedToolIds:[Outline],visibleToolIds:[Calendar],collapsedToolIds:[]}}]}}) {{ values {{ locale }} }} }}")}),
    )
    .await;
    assert!(
      invalid_tools.get("errors").is_some(),
      "invalid subset was accepted: {invalid_tools}"
    );
    for view_family in ["DocumentEdgeless", "Journal", "Database", "Graph"] {
      let invalid_tags = helpers::gql(
        &app,
        session_id,
        json!({"query": format!("mutation {{ updatePreferences(input:{{workbenchToolLayouts:[{{workspaceId:\"{workspace_id}\",viewFamily:{view_family},orderedToolIds:[Tags],visibleToolIds:[],collapsedToolIds:[]}}]}}) {{ values {{ locale }} }} }}")}),
      )
      .await;
      assert!(
        invalid_tags.get("errors").is_some(),
        "Tags was accepted for {view_family}: {invalid_tags}"
      );
    }
    for unsupported in ["Reminders", "Tasks"] {
    let invalid_dashboard = helpers::gql(
      &app,
      session_id,
      json!({"query": format!("mutation {{ updatePreferences(input:{{workspaceDashboardLayouts:[{{workspaceId:\"{workspace_id}\",orderedDashletIds:[{unsupported}],dashletSizes:[{{dashletId:{unsupported},size:Compact}}]}}]}}) {{ values {{ locale }} }} }}")}),
    )
    .await;
    assert!(
      invalid_dashboard.get("errors").is_some(),
      "invalid compact dashboard size was accepted: {invalid_dashboard}"
    );

    }

    let unchanged = helpers::gql(
      &app,
      session_id,
      json!({"query": "query { currentUser { preferences { values { locale workbenchToolLayouts { workspaceId } workspaceDashboardLayouts { workspaceId orderedDashletIds } } } } }"}),
    )
    .await;
    assert_eq!(
      unchanged["data"]["currentUser"]["preferences"]["values"]["locale"],
      "de"
    );
    assert_eq!(
      unchanged["data"]["currentUser"]["preferences"]["values"]["workbenchToolLayouts"][0]["workspaceId"],
      workspace_id
    );
    assert_eq!(
      unchanged["data"]["currentUser"]["preferences"]["values"]["workspaceDashboardLayouts"][0]["workspaceId"],
      workspace_id
    );

    let updated_dashboard = helpers::gql(
      &app,
      session_id,
      json!({"query": format!("mutation {{ updatePreferences(input:{{workspaceDashboardLayouts:[{{workspaceId:\"{workspace_id}\",orderedDashletIds:[Activity,Today,Tasks,NewDocuments,Reminders,RecentlyEdited],dashletSizes:[{{dashletId:Today,size:Wide}},{{dashletId:Tasks,size:Wide}},{{dashletId:Activity,size:Wide}}]}},{{workspaceId:\"{other_workspace_id}\",orderedDashletIds:[Today],dashletSizes:[{{dashletId:Today,size:Wide}}]}}]}}) {{ values {{ workspaceDashboardLayouts {{ workspaceId orderedDashletIds dashletSizes {{ dashletId size }} }} }} }} }}")}),
    )
    .await;
    assert!(
      updated_dashboard.get("errors").is_none(),
      "dashboard update failed: {updated_dashboard}"
    );
    assert_eq!(
      updated_dashboard["data"]["updatePreferences"]["values"]["workspaceDashboardLayouts"][0]["orderedDashletIds"][0],
      "Activity"
    );
    assert_eq!(
      updated_dashboard["data"]["updatePreferences"]["values"]["workspaceDashboardLayouts"][0]["orderedDashletIds"][2],
      "Tasks"
    );
    assert_eq!(
      updated_dashboard["data"]["updatePreferences"]["values"]["workspaceDashboardLayouts"][1]["workspaceId"],
      other_workspace_id
    );

    let persisted_dashboard = helpers::gql(&app, session_id, json!({"query":
      "query { currentUser { preferences { values { workspaceDashboardLayouts { workspaceId orderedDashletIds dashletSizes { dashletId size } } } } } }"
    })).await;
    assert!(persisted_dashboard.get("errors").is_none(), "dashboard readback: {persisted_dashboard}");
    let expected_layouts = &updated_dashboard["data"]["updatePreferences"]["values"]["workspaceDashboardLayouts"];
    assert_eq!(&persisted_dashboard["data"]["currentUser"]["preferences"]["values"]["workspaceDashboardLayouts"], expected_layouts);
    let task_size = expected_layouts[0]["dashletSizes"].as_array().expect("size overrides").iter()
      .find(|item| item["dashletId"] == "Tasks").expect("persisted Task size");
    assert_eq!(task_size["size"], "Wide");

    let isolated = helpers::gql(
      &app,
      other_session_id,
      json!({"query": "query { currentUser { preferences { values { workspaceDashboardLayouts { workspaceId } } } } }"}),
    )
    .await;
    assert!(
      isolated["data"]["currentUser"]["preferences"]["values"]["workspaceDashboardLayouts"].is_null(),
      "dashboard layouts leaked across users: {isolated}"
    );

    let reset = helpers::gql(
      &app,
      session_id,
      json!({"query": "mutation { updatePreferences(input:{workbenchToolLayouts:null,workspaceDashboardLayouts:null}) { values { workbenchToolLayouts { workspaceId } workspaceDashboardLayouts { workspaceId } } effectiveValues { workbenchToolLayouts { workspaceId } workspaceDashboardLayouts { workspaceId } } } }"}),
    )
    .await;
    assert!(reset.get("errors").is_none(), "reset failed: {reset}");
    assert!(reset["data"]["updatePreferences"]["values"]["workbenchToolLayouts"].is_null());
    assert!(reset["data"]["updatePreferences"]["effectiveValues"]["workbenchToolLayouts"].is_null());
    assert!(reset["data"]["updatePreferences"]["values"]["workspaceDashboardLayouts"].is_null());
    assert!(reset["data"]["updatePreferences"]["effectiveValues"]["workspaceDashboardLayouts"].is_null());

    sqlx::query("DELETE FROM user_preferences WHERE user_id = $1")
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("cleanup user preference aggregate");
    }).catch_unwind().await;
    helpers::cleanup_users(&pool, &[user_id, other_user_id]).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}

#[tokio::test]
async fn creator_notification_preferences_preserve_tri_state_and_account_isolation() {
  use futures_util::FutureExt;
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user, session) = helpers::seed_user(&pool, &auth_store, "creator-preference").await;
  let (other, other_session) = helpers::seed_user(&pool, &auth_store, "creator-preference-other").await;
  let query = "query{currentUser{preferences{values{notifyCreatedDocuments} effectiveValues{notifyCreatedDocuments}}}}";
  let outcome = std::panic::AssertUnwindSafe(async {
    let initial = helpers::gql(&app, session, json!({"query":query})).await;
    assert!(initial.get("errors").is_none(), "{initial}");
    assert!(initial["data"]["currentUser"]["preferences"]["values"]["notifyCreatedDocuments"].is_null());
    assert_eq!(initial["data"]["currentUser"]["preferences"]["effectiveValues"]["notifyCreatedDocuments"], true);
    for input in ["notifyCreatedDocuments:false", "receiveMentionEmail:false", "notifyCreatedDocuments:true", "notifyCreatedDocuments:null"] {
      let response = helpers::gql(&app, session, json!({"query":format!("mutation{{updatePreferences(input:{{{input}}}){{values{{notifyCreatedDocuments}} effectiveValues{{notifyCreatedDocuments}}}}}}") })).await;
      assert!(response.get("errors").is_none(), "{response}");
      let expected = !input.ends_with("false");
      let other_values = helpers::gql(&app, other_session, json!({"query":query})).await;
      assert_eq!(other_values["data"]["currentUser"]["preferences"]["effectiveValues"]["notifyCreatedDocuments"], true);
      assert_eq!(response["data"]["updatePreferences"]["effectiveValues"]["notifyCreatedDocuments"], expected);
      let persisted = helpers::gql(&app, session, json!({"query":query})).await;
      assert_eq!(persisted["data"]["currentUser"]["preferences"]["effectiveValues"]["notifyCreatedDocuments"], expected);
      if input.ends_with("null") { assert!(persisted["data"]["currentUser"]["preferences"]["values"]["notifyCreatedDocuments"].is_null()); }
    }
    let isolated = helpers::gql(&app, other_session, json!({"query":query})).await;
    assert_eq!(isolated["data"]["currentUser"]["preferences"]["effectiveValues"]["notifyCreatedDocuments"], true);
    let stored: serde_json::Value = sqlx::query_scalar("SELECT values FROM user_preferences WHERE user_id=$1").bind(user).fetch_one(&pool).await.unwrap();
    assert!(stored.get("notifyCreatedDocuments").is_none());
    assert_eq!(stored["receiveMentionEmail"], false);
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[user, other]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=ANY($1)")
    .bind(&[user, other] as &[uuid::Uuid])
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(remaining, 0);
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[test]
fn assistance_preferences_are_confirmed_personal_and_authorized_per_scope() {
  helpers::block_on_large_stack("assistance-preferences", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_template_registry_and_search_service().await;
    let (user, session) = helpers::seed_user(&pool, &auth_store, "assistance-owner").await;
    let (other, other_session) = helpers::seed_user(&pool, &auth_store, "assistance-other").await;
    let workspace = helpers::create_workspace(&pool, user).await;
    let second_workspace = helpers::create_workspace(&pool, user).await;
    helpers::add_workspace_member(&pool, workspace, other).await;
    let outcome = std::panic::AssertUnwindSafe(async {
      let query = "query($workspace:ID,$project:ID){currentUser{preferences{values{assistanceMode locale workspaceAssistanceOverrides{workspaceId mode} projectAssistanceOverrides{workspaceId projectId mode}} effectiveValues{assistanceMode} assistance(workspaceId:$workspace,projectId:$project){mode source userDefaultExplicit interactiveMode}}}}";
      let initial = helpers::gql(&app, session, json!({"query":query})).await;
      assert!(initial.get("errors").is_none(), "{initial}");
      let policy = &initial["data"]["currentUser"]["preferences"]["assistance"];
      assert_eq!(policy, &json!({"mode":"Manual","source":"UserDefault","userDefaultExplicit":false,"interactiveMode":"Guided"}));
      assert!(initial["data"]["currentUser"]["preferences"]["values"]["assistanceMode"].is_null());

      let mut databases = Vec::new();
      for (template, title) in [
        ("myoxus.project.simple_project", "Assistance first Project"),
        ("myoxus.project.simple_project", "Assistance second Project"),
        ("myoxus.database.blank", "Assistance Generic"),
      ] {
        let created = helpers::gql(&app, session, json!({
          "query":"mutation($input:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$input){database{id}}}",
          "variables":{"input":{"workspaceId":workspace,"templateId":template,"title":title,"includeSampleRows":false}}
        })).await;
        assert!(created.get("errors").is_none(), "{created}");
        databases.push(created["data"]["createDatabaseFromTemplate"]["database"]["id"].as_str().unwrap().to_string());
      }
      let default: uuid::Uuid = sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      let mutation = "mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{assistanceMode locale workspaceAssistanceOverrides{workspaceId mode} projectAssistanceOverrides{workspaceId projectId mode}} assistance{mode source userDefaultExplicit interactiveMode}}}";
      let global = helpers::gql(&app, session, json!({"query":mutation,"variables":{"input":{"assistanceMode":"Automatic","locale":"de"}}})).await;
      assert!(global.get("errors").is_none(), "{global}");
      assert_eq!(global["data"]["updatePreferences"]["assistance"]["mode"], "Automatic");

      // Independent devices change distinct keys inside the same locked JSON row.
      let first = helpers::gql(&app, session, json!({"query":mutation,"variables":{"input":{"workspaceAssistanceOverrides":[{"workspaceId":workspace,"mode":"Guided"}]}}}));
      let second = helpers::gql(&app, session, json!({"query":mutation,"variables":{"input":{"workspaceAssistanceOverrides":[{"workspaceId":second_workspace,"mode":"Manual"}]}}}));
      let project = helpers::gql(&app, session, json!({"query":mutation,"variables":{"input":{"projectAssistanceOverrides":[{"workspaceId":workspace,"projectId":databases[0],"mode":"Manual"}]}}}));
      let (first, second, project) = tokio::join!(first, second, project);
      for response in [first, second, project] { assert!(response.get("errors").is_none(), "{response}"); }
      let stored = helpers::gql(&app, session, json!({"query":query,"variables":{"workspace":workspace,"project":databases[0]}})).await;
      assert!(stored.get("errors").is_none(), "{stored}");
      let values = &stored["data"]["currentUser"]["preferences"]["values"];
      assert_eq!(values["workspaceAssistanceOverrides"].as_array().unwrap().len(), 2);
      assert_eq!(values["locale"], "de");
      assert_eq!(stored["data"]["currentUser"]["preferences"]["assistance"]["source"], "Project");
      assert_eq!(stored["data"]["currentUser"]["preferences"]["assistance"]["mode"], "Manual");
      let inherited = helpers::gql(&app, session, json!({"query":query,"variables":{"workspace":workspace,"project":databases[1]}})).await;
      assert_eq!(inherited["data"]["currentUser"]["preferences"]["assistance"]["mode"], "Guided");
      let system = helpers::gql(&app, session, json!({"query":query,"variables":{"workspace":workspace,"project":default}})).await;
      assert!(system.get("errors").is_none(), "{system}");
      assert_eq!(system["data"]["currentUser"]["preferences"]["assistance"]["source"], "Workspace");
      let isolated = helpers::gql(&app, other_session, json!({"query":query,"variables":{"workspace":workspace}})).await;
      assert!(isolated.get("errors").is_none(), "{isolated}");
      assert_eq!(isolated["data"]["currentUser"]["preferences"]["assistance"]["mode"], "Manual");
      assert_eq!(isolated["data"]["currentUser"]["preferences"]["values"]["workspaceAssistanceOverrides"], json!([]));

      // Every rejected save must leave the confirmed aggregate byte-for-byte intact.
      let before: serde_json::Value = sqlx::query_scalar("SELECT values FROM user_preferences WHERE user_id=$1")
        .bind(user).fetch_one(&pool).await.unwrap();
      for patch in [
        json!({"projectAssistanceOverrides":[{"workspaceId":workspace,"projectId":default,"mode":"Automatic"}]}),
        json!({"projectAssistanceOverrides":[{"workspaceId":workspace,"projectId":databases[2],"mode":"Automatic"}]}),
        json!({"projectAssistanceOverrides":[{"workspaceId":second_workspace,"projectId":databases[0],"mode":"Automatic"}]}),
        json!({"workspaceAssistanceOverrides":[{"workspaceId":workspace}]}),
        json!({"workspaceAssistanceOverrides":[{"workspaceId":workspace,"mode":"Manual"},{"workspaceId":workspace,"mode":"Automatic"}]}),
      ] {
        let failed = helpers::gql(&app, session, json!({"query":mutation,"variables":{"input":patch}})).await;
        assert!(failed.get("errors").is_some(), "invalid assistance patch admitted: {failed}");
        let after: serde_json::Value = sqlx::query_scalar("SELECT values FROM user_preferences WHERE user_id=$1")
          .bind(user).fetch_one(&pool).await.unwrap();
        assert_eq!(after, before);
      }
      let foreign = helpers::gql(&app, other_session, json!({"query":query,"variables":{"workspace":second_workspace}})).await;
      assert!(foreign.get("errors").is_some(), "foreign contextual preferences admitted: {foreign}");
      let no_workspace = helpers::gql(&app, session, json!({"query":query,"variables":{"project":databases[0]}})).await;
      assert!(no_workspace.get("errors").is_some(), "Project without Workspace admitted: {no_workspace}");
      let denied = helpers::gql(&app, other_session, json!({"query":mutation,"variables":{"input":{"assistanceMode":"Automatic","workspaceAssistanceOverrides":[{"workspaceId":second_workspace,"mode":"Automatic"}]}}})).await;
      assert!(denied.get("errors").is_some(), "foreign scoped write admitted: {denied}");
      let other_after = helpers::gql(&app, other_session, json!({"query":query})).await;
      assert_eq!(other_after["data"]["currentUser"]["preferences"]["assistance"]["mode"], "Manual");

      let reset_project = helpers::gql(&app, session, json!({"query":mutation,"variables":{"input":{"projectAssistanceOverrides":[{"workspaceId":workspace,"projectId":databases[0],"mode":null}]}}})).await;
      assert!(reset_project.get("errors").is_none(), "{reset_project}");
      let reset = helpers::gql(&app, session, json!({"query":mutation,"variables":{"input":{"assistanceMode":null,"workspaceAssistanceOverrides":[{"workspaceId":workspace,"mode":null}]}}})).await;
      assert!(reset.get("errors").is_none(), "{reset}");
      let reset = helpers::gql(&app, session, json!({"query":query,"variables":{"workspace":workspace,"project":databases[0]}})).await;
      assert_eq!(reset["data"]["currentUser"]["preferences"]["assistance"]["mode"], "Manual");
      assert_eq!(reset["data"]["currentUser"]["preferences"]["assistance"]["interactiveMode"], "Guided");
      assert_eq!(reset["data"]["currentUser"]["preferences"]["values"]["workspaceAssistanceOverrides"].as_array().unwrap().len(), 1);
      assert_eq!(reset["data"]["currentUser"]["preferences"]["values"]["locale"], "de");

      // Losing membership makes even an existing personal override ineligible.
      sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace).bind(other).execute(&pool).await.unwrap();
      let revoked = helpers::gql(&app, other_session, json!({"query":query,"variables":{"workspace":workspace}})).await;
      assert!(revoked.get("errors").is_some(), "revoked membership reused: {revoked}");
    }).catch_unwind().await;
    helpers::cleanup_workspaces(&pool, &[workspace, second_workspace]).await;
    helpers::cleanup_users(&pool, &[user, other]).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}
