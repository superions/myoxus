// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for the workspace GraphQL resolvers (create, invite, list members).
use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
// INV: createWorkspace → createInviteLink → acceptInvite sets member status to UnderReview
async fn inv_workspace_full_flow_invite_sets_under_review_status() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "ws-owner").await;

  // 1. Create Workspace
  let query = r#"{"query": "mutation { auth { createWorkspace { id name } } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(query))
        .expect("build create-workspace request"),
    )
    .await
    .expect("send create-workspace request");

  assert_eq!(response.status(), 200);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("read create-workspace body")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("parse create-workspace response json");
  let ws_id = json["data"]["auth"]["createWorkspace"]["id"]
    .as_str()
    .expect("createWorkspace id field")
    .to_string();
  let ws_uuid = Uuid::parse_str(&ws_id).expect("parse workspace uuid");

  // 2. Create Invite Link
  let query = format!(
    r#"{{"query": "mutation {{ auth {{ createWorkspaceInviteLink(workspaceId: \"{}\", expireTime: 3600000) {{ inviteId }} }} }}"}}"#,
    ws_id
  );
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(query))
        .expect("build create-invite-link request"),
    )
    .await
    .expect("send create-invite-link request");

  assert_eq!(response.status(), 200);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("read invite-link body")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("parse invite-link response json");
  let invite_id = json["data"]["auth"]["createWorkspaceInviteLink"]["inviteId"]
    .as_str()
    .expect("inviteId field")
    .to_string();

  // 3. Join via Link (with a new user)
  let (new_user_id, new_session_id) = helpers::seed_user(&pool, &auth_store, "ws-newmember").await;

  let query = format!(
    r#"{{"query": "mutation {{ auth {{ acceptWorkspaceInvite(workspaceId: \"{}\", inviteId: \"{}\") }} }}"}}"#,
    ws_id, invite_id
  );
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={new_session_id}"))
        .body(Body::from(query))
        .expect("build accept-invite request"),
    )
    .await
    .expect("send accept-invite request");

  assert_eq!(response.status(), 200);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("read accept-invite body")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("parse accept-invite response json");
  assert!(
    json["data"]["auth"]["acceptWorkspaceInvite"]
      .as_bool()
      .expect("acceptWorkspaceInvite bool")
  );

  // 4. Verify status is UnderReview via DB (INV-WS: link-join membership = UnderReview)
  let status: Option<String> =
    sqlx::query_scalar("SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(ws_uuid)
      .bind(new_user_id)
      .fetch_optional(&pool)
      .await
      .expect("workspace_memberships query");
  assert_eq!(
    status.as_deref(),
    Some("UnderReview"),
    "INV-WS: link-join must set membership status to UnderReview, got: {status:?}"
  );

  helpers::cleanup_users(&pool, &[user_id, new_user_id]).await;
}

#[tokio::test]
async fn workspace_description_persists_plain_text_and_enforces_limit_and_permission() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "description-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let maximum = format!("<script>literal</script>\r\n{}", "😀".repeat(1_975));
  assert_eq!(maximum.replace("\r\n", "\n").chars().count(), 2_000);
  let updated = helpers::gql(
    &app,
    owner_session,
    serde_json::json!({
      "query": "mutation UpdateDescription($input: UpdateWorkspaceInput!) { updateWorkspace(input: $input) { id description } }",
      "variables": {"input": {"id": workspace_id.to_string(), "description": maximum}}
    }),
  )
  .await;
  assert!(updated.get("errors").is_none(), "description update failed: {updated}");
  assert_eq!(
    updated["data"]["updateWorkspace"]["description"],
    serde_json::json!(format!("<script>literal</script>\n{}", "😀".repeat(1_975)))
  );

  let over_limit = "😀".repeat(2_001);
  let rejected = helpers::gql(
    &app,
    owner_session,
    serde_json::json!({
      "query": "mutation UpdateDescription($input: UpdateWorkspaceInput!) { updateWorkspace(input: $input) { description } }",
      "variables": {"input": {"id": workspace_id.to_string(), "description": over_limit}}
    }),
  )
  .await;
  assert!(
    rejected.get("errors").is_some(),
    "over-limit description was accepted: {rejected}"
  );

  let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "description-reader").await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("insert reader membership");
  let forbidden = helpers::gql(
    &app,
    reader_session,
    serde_json::json!({
      "query": "mutation UpdateDescription($input: UpdateWorkspaceInput!) { updateWorkspace(input: $input) { description } }",
      "variables": {"input": {"id": workspace_id.to_string(), "description": "reader write"}}
    }),
  )
  .await;
  assert!(
    forbidden.get("errors").is_some(),
    "reader changed workspace description: {forbidden}"
  );

  let cleared = helpers::gql(
    &app,
    owner_session,
    serde_json::json!({
      "query": "mutation UpdateDescription($input: UpdateWorkspaceInput!) { updateWorkspace(input: $input) { description } }",
      "variables": {"input": {"id": workspace_id.to_string(), "description": ""}}
    }),
  )
  .await;
  assert_eq!(cleared["data"]["updateWorkspace"]["description"], "");

  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
}

#[tokio::test]
async fn workspace_overviews_preserve_other_scopes_and_reject_stale_or_denied_settings_writes() {
  use futures_util::FutureExt;
  use myoxus_application::{
    auth::AuthError,
    doc::DocSpaceKind,
    organizer::{CreateOrganizerFolder, OrganizerDocumentPort, OrganizerService},
    workspace::UserWorkspaceSettingsInput,
  };
  use myoxus_domain::{
    document_key::DocumentKey,
    workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef},
    workspace_overview::{
      OverviewOrderBy, OverviewRegisterPresentation, OverviewSettingsScope, WorkspaceOverviewSettings,
      WorkspaceOverviewSettingsPatch,
    },
  };

  use yrs::{Doc, Map, Transact, Update, updates::decoder::Decode};

  let (app, pool, auth_store, state) = helpers::setup_app_with_state().await;
  let (owner, owner_session) = helpers::seed_user(&pool, &auth_store, "overview-owner").await;
  let (reader, reader_session) = helpers::seed_user(&pool, &auth_store, "overview-reader").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id,user_id,role,status) VALUES ($1,$2,'Reader','Accepted')",
    )
    .bind(workspace)
    .bind(reader)
    .execute(&pool)
    .await
    .unwrap();
    state
      .workspace()
      .seed_root_doc(workspace, owner, yjs::create_initial_workspace_doc("Overview fixture"))
      .await
      .unwrap();
    let organizer = OrganizerService::new(state.doc().clone());
    let folder_id = "non-uuid-overview-folder";
    organizer
      .create_folder(
        workspace,
        CreateOrganizerFolder {
          id: folder_id.into(),
          parent_id: None,
          name: "Existing folder".into(),
          index: None,
        },
      )
      .await
      .unwrap();
    let introduction_id = helpers::create_doc(&pool, workspace, owner).await;
    let external_key = "introduction with spaces";
    sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
      .bind(introduction_id)
      .bind(external_key)
      .execute(&pool)
      .await
      .unwrap();
    state.doc().push_external_update_raw(
      workspace,
      DocumentKey::parse(external_key).unwrap(),
      yjs::markdown_to_yjs("Native introduction", "Readable native Page body").unwrap(),
      DocSpaceKind::Workspace,
    ).await.unwrap();
    let introduction =
      WorkspaceContentResourceRef::new(workspace, WorkspaceContentResourceKind::Document, external_key).unwrap();
    let settings = state.workspace_settings_service();
    let initial = state.workspace().get_workspace(workspace).await.unwrap().unwrap();
    assert_eq!(initial.overview_revision, 0);
    assert_eq!(initial.overview_settings, WorkspaceOverviewSettings::default());
    let root = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(WorkspaceOverviewSettingsPatch {
            introduction: Some(Some(introduction.clone())),
            folder_ids: Some(Some(vec![folder_id.into()])),
            register_presentation: Some(Some(OverviewRegisterPresentation {
              display_properties: vec!["system:title".into(), "system:status".into()],
              order_by: OverviewOrderBy {
                property_type: "system".into(),
                key: "updatedAt".into(),
                desc: true,
              },
            })),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert_eq!(root.overview_revision, 1);

    // Legacy transports omit overview data and must preserve its confirmed basis.
    let legacy = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:UpdateWorkspaceInput!){updateWorkspace(input:$input){description enableSharing}}",
        "variables":{"input":{"id":workspace,"description":"Legacy description","enableSharing":true}}
      }),
    )
    .await;
    assert!(legacy.get("errors").is_none(), "legacy settings failed: {legacy}");
    let reloaded = state.workspace().get_workspace(workspace).await.unwrap().unwrap();
    assert_eq!(reloaded.overview_revision, root.overview_revision);
    assert_eq!(reloaded.overview_settings, root.overview_settings);

    let folder_patch = WorkspaceOverviewSettingsPatch {
      expected_revision: root.overview_revision,
      scope: OverviewSettingsScope::Folder(folder_id.into()),
      introduction: Some(Some(introduction.clone())),
      ..Default::default()
    };
    let denied = settings
      .update(
        reader,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(folder_patch.clone()),
          ..Default::default()
        },
      )
      .await
      .unwrap_err();
    assert!(matches!(denied, AuthError::ActionForbidden));
    let folder = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(folder_patch),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert_eq!(folder.overview_revision, 2);
    assert_eq!(folder.overview_settings.introduction, Some(introduction.clone()));
    assert_eq!(
      folder.overview_settings.folders[folder_id].introduction,
      Some(introduction.clone())
    );

    // Favorites create persisted userdata documents in an otherwise normal
    // workspace; they must never become browse rows or introduction sources.
    let preferences_key = format!("userdata${owner}${workspace}$favorite");
    state.doc().push_external_update_raw(
      workspace, DocumentKey::parse(&preferences_key).unwrap(),
      yjs::markdown_to_yjs("Private preference payload", "Internal favorites").unwrap(),
      DocSpaceKind::Workspace,
    ).await.unwrap();
    let invalid = settings.update(owner, workspace, UserWorkspaceSettingsInput {
      overview: Some(WorkspaceOverviewSettingsPatch {
        expected_revision: folder.overview_revision,
        introduction: Some(Some(WorkspaceContentResourceRef::new(workspace,WorkspaceContentResourceKind::Document,&preferences_key).unwrap())),
        ..Default::default()
      }), ..Default::default()
    }).await.unwrap_err();
    assert!(matches!(invalid,AuthError::InvalidInput(_)));

    // Exercise the actual authenticated adapter: an unpublished introduction is
    // readable internally, keeps its external key and grants no editing to a Reader.
    let read_query = "query($id:String!,$folder:String){workspace(id:$id){overview(folderId:$folder){folder{id name} children{id} introduction{resource{workspaceId kind id} canEdit} documents{resource{id} canEdit}}}}";
    let root_read = helpers::gql(&app, reader_session, json!({
      "query": read_query, "variables": {"id":workspace}
    })).await;
    assert!(root_read.get("errors").is_none(), "Reader overview failed: {root_read}");
    let projected = &root_read["data"]["workspace"]["overview"];
    assert!(projected["folder"].is_null());
    assert_eq!(projected["children"],json!([{"id":folder_id}]));
    assert_eq!(projected["introduction"]["resource"],json!({"workspaceId":workspace,"kind":"Document","id":external_key}));
    assert_eq!(projected["introduction"]["canEdit"],false);
    assert_eq!(projected["documents"],json!([{"resource":{"id":external_key},"canEdit":false}]));
    let owner_read = helpers::gql(&app, owner_session, json!({
      "query":read_query,"variables":{"id":workspace}
    })).await;
    assert_eq!(owner_read["data"]["workspace"]["overview"]["documents"],
      json!([{"resource":{"id":external_key},"canEdit":true}]),
      "workspace owners must not see persisted preference payloads as documents");
    let folder_read = helpers::gql(&app, reader_session, json!({
      "query":read_query,"variables":{"id":workspace,"folder":folder_id}
    })).await;
    assert!(folder_read.get("errors").is_none(), "Reader folder failed: {folder_read}");
    let projected = &folder_read["data"]["workspace"]["overview"];
    assert_eq!(projected["folder"],json!({"id":folder_id,"name":"Existing folder"}));
    assert_eq!(projected["introduction"]["resource"]["id"],external_key);
    assert_eq!(projected["documents"],json!([]));

    // Current assignments are joined after the versioned index has already
    // been read above; metadata/author/time use their existing native owners.
    let tags = state.workspace_tag_service().unwrap();
    let tag = tags.create_tag(owner, workspace, "Overview native label", "tag.blue", None).await.unwrap();
    tags.set_document_tags(owner, workspace, introduction_id, &[tag.id]).await.unwrap();
    let register_query = "query($id:String!,$folder:String,$offset:Int!){workspace(id:$id){overview(folderId:$folder,first:200,offset:$offset){documentCount limit offset hasMore documents{resource{id} createdAt createdByName tags{id workspaceId name colorRole archived} metadata{docId externalId createdBy canPublish tagIds}}}}}";
    let register = helpers::gql(&app, reader_session, json!({
      "query":register_query,"variables":{"id":workspace,"offset":-10}
    })).await;
    assert!(register.get("errors").is_none(), "native register failed: {register}");
    let register = &register["data"]["workspace"]["overview"];
    assert_eq!((register["documentCount"].as_i64(), register["limit"].as_i64(), register["offset"].as_i64()), (Some(1),Some(50),Some(0)));
    assert_eq!(register["hasMore"], false);
    let row = &register["documents"][0];
    assert_eq!(row["resource"]["id"],external_key);
    assert_eq!(row["metadata"]["docId"], introduction_id.to_string());
    assert_eq!(row["metadata"]["externalId"],external_key);
    assert_eq!(row["metadata"]["createdBy"],owner.to_string());
    assert_eq!(row["metadata"]["tagIds"], json!([tag.id]));
    assert_eq!(row["tags"], json!([{
      "id": tag.id, "workspaceId": workspace, "name": "Overview native label",
      "colorRole": "tag.blue", "archived": false,
    }]));
    assert_eq!(row["metadata"]["canPublish"],false);
    let author = state.auth().get_users_by_ids(&[owner]).await.unwrap().remove(&owner).unwrap();
    assert_eq!(row["createdByName"],author.name.unwrap_or(author.email));
    let live = state.doc().get_metadata(introduction_id).await.unwrap().unwrap();
    assert_eq!(chrono::DateTime::parse_from_rfc3339(row["createdAt"].as_str().unwrap()).unwrap().with_timezone(&chrono::Utc),live.created_at);
    for (folder, offset, count) in [(None,1,1),(Some(folder_id),0,0)] {
      let response = helpers::gql(&app, reader_session, json!({
        "query":register_query,"variables":{"id":workspace,"folder":folder,"offset":offset}
      })).await;
      assert!(response.get("errors").is_none(), "bounded register failed: {response}");
      let page = &response["data"]["workspace"]["overview"];
      assert_eq!(page["documentCount"],count);
      assert_eq!(page["documents"], if count == 0 { json!([]) } else { register["documents"].clone() },
        "an obsolete page offset returns the first page without changing direct membership; a folder introduction adds no members");
      assert_eq!(page["hasMore"],false);
    }

    let stale = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          description: Some("Must roll back".into()),
          overview: Some(WorkspaceOverviewSettingsPatch {
            expected_revision: root.overview_revision,
            introduction: Some(None),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap_err();
    assert!(matches!(
      stale,
      AuthError::WorkspaceOverviewRevisionConflict { current_revision: 2 }
    ));
    let after_stale = state.workspace().get_workspace(workspace).await.unwrap().unwrap();
    assert_eq!(after_stale.description, "Legacy description");
    assert_eq!(after_stale.overview_settings, folder.overview_settings);

    let cleared = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(WorkspaceOverviewSettingsPatch {
            expected_revision: folder.overview_revision,
            introduction: Some(None),
            folder_ids: Some(None),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert_eq!(cleared.overview_revision, 3);
    assert!(cleared.overview_settings.introduction.is_none());
    assert!(cleared.overview_settings.folder_ids.is_none());
    assert_eq!(cleared.overview_settings.folders, folder.overview_settings.folders);

    let foreign =
      WorkspaceContentResourceRef::new(Uuid::new_v4(), WorkspaceContentResourceKind::Document, external_key).unwrap();
    let rejected = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(WorkspaceOverviewSettingsPatch {
            expected_revision: cleared.overview_revision,
            introduction: Some(Some(foreign)),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap_err();
    assert!(matches!(rejected, AuthError::InvalidInput(_)));

    let metadata = state.document_metadata_service().unwrap();
    metadata
      .set_metadata(
        introduction_id,
        owner,
        myoxus_domain::entities::DocumentMetadataPatch {
          primary_mode: Some(Some("edgeless".into())),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    let unsupported = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(WorkspaceOverviewSettingsPatch {
            expected_revision: cleared.overview_revision,
            introduction: Some(Some(introduction.clone())),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap_err();
    assert!(matches!(unsupported, AuthError::InvalidInput(_)));
    metadata
      .set_metadata(
        introduction_id,
        owner,
        myoxus_domain::entities::DocumentMetadataPatch {
          primary_mode: Some(Some("page".into())),
          ..Default::default()
        },
      )
      .await
      .unwrap();

    state
      .doc()
      .push_external_update_raw(
        workspace,
        DocumentKey::parse(workspace.to_string()).unwrap(),
        yjs::create_initial_workspace_doc("Ordinary editor sync"),
        DocSpaceKind::Workspace,
      )
      .await
      .unwrap();
    let after_sync = state.workspace().get_workspace(workspace).await.unwrap().unwrap();
    assert_eq!(after_sync.overview_revision, cleared.overview_revision);
    assert_eq!(after_sync.overview_settings, cleared.overview_settings);
    organizer.delete_folder(workspace, folder_id).await.unwrap();
    let removed = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(WorkspaceOverviewSettingsPatch {
            expected_revision: cleared.overview_revision,
            scope: OverviewSettingsScope::Folder(folder_id.into()),
            introduction: Some(None),
            register_presentation: Some(None),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert_eq!(removed.overview_revision, 4);
    assert!(removed.overview_settings.folders.is_empty());

    // An Extract-retained structural root is an alias, including on settings
    // writes. Exercise the production transport and native Organizer document.
    let retained_root = "retained-overview-root";
    let api_folder = "nested-api-overview-folder";
    for (id, parent_id) in [(retained_root, None), (api_folder, Some(retained_root))] {
      organizer.create_folder(workspace, CreateOrganizerFolder {
        id: id.into(), parent_id: parent_id.map(Into::into), name: id.into(), index: None,
      }).await.unwrap();
    }
    let retained_update = {
      let doc = Doc::new();
      let full = state.doc().load_organizer_document(workspace).await.unwrap();
      doc.transact_mut().apply_update(Update::decode_v1(&full).unwrap()).unwrap();
      let root = doc.get_or_insert_map(retained_root);
      let mut txn = doc.transact_mut();
      root.insert(&mut txn, "type", "workspace-root");
      txn.encode_update_v1()
    };
    state.doc().persist_organizer_update(workspace, retained_update).await.unwrap();
    let fields = "overviewSettings{revision introduction{workspaceId kind id} folderIds folders{folderId introduction{workspaceId kind id}}}";
    let config_query = format!("query($id:String!){{workspace(id:$id){{{fields}}}}}");
    let mutation = format!("mutation($input:UpdateWorkspaceInput!){{updateWorkspace(input:$input){{description {fields}}}}}");
    let owner_config = helpers::gql(&app, owner_session, json!({
      "query":config_query,"variables":{"id":workspace}
    })).await;
    assert!(owner_config.get("errors").is_none(), "settings read failed: {owner_config}");
    assert_eq!(owner_config["data"]["workspace"]["overviewSettings"]["revision"], 4);
    let denied_config = helpers::gql(&app, reader_session, json!({
      "query":config_query,"variables":{"id":workspace}
    })).await;
    assert!(denied_config.get("errors").is_some(), "Reader received private settings: {denied_config}");
    let denied_write = helpers::gql(&app, reader_session, json!({
      "query":mutation,"variables":{"input":{"id":workspace,"overview":{"expectedRevision":4,"introduction":null}}}
    })).await;
    assert!(denied_write.get("errors").is_some(), "Reader changed settings: {denied_write}");
    assert_eq!(state.workspace().get_workspace(workspace).await.unwrap().unwrap().overview_revision, 4);

    let root_saved = helpers::gql(&app, owner_session, json!({
      "query":mutation,"variables":{"input":{"id":workspace,"overview":{
        "expectedRevision":4,"folderId":retained_root,"folderIds":[],
        "introduction":{"kind":"Document","id":external_key}
      }}}
    })).await;
    assert!(root_saved.get("errors").is_none(), "root alias save failed: {root_saved}");
    let root_basis = &root_saved["data"]["updateWorkspace"]["overviewSettings"];
    assert_eq!(root_basis["revision"],5);
    assert_eq!(root_basis["introduction"],json!({"workspaceId":workspace,"kind":"Document","id":external_key}));
    assert_eq!(root_basis["folderIds"],json!([]));
    assert_eq!(root_basis["folders"],json!([]));

    let folder_saved = helpers::gql(&app, owner_session, json!({
      "query":mutation,"variables":{"input":{"id":workspace,"overview":{
        "expectedRevision":root_basis["revision"],"folderId":api_folder,
        "introduction":{"kind":"Document","id":external_key}
      }}}
    })).await;
    assert!(folder_saved.get("errors").is_none(), "consecutive folder save failed: {folder_saved}");
    let folder_basis = &folder_saved["data"]["updateWorkspace"]["overviewSettings"];
    assert_eq!(folder_basis["revision"],6);
    assert_eq!(folder_basis["introduction"],root_basis["introduction"]);
    assert_eq!(folder_basis["folderIds"],root_basis["folderIds"]);
    assert_eq!(folder_basis["folders"],json!([{"folderId":api_folder,"introduction":{"workspaceId":workspace,"kind":"Document","id":external_key}}]));

    // Null restores all folders; omission preserves the root introduction and
    // every other scope. The exact returned revision is the next write basis.
    let all_folders = helpers::gql(&app, owner_session, json!({
      "query":mutation,"variables":{"input":{"id":workspace,"overview":{
        "expectedRevision":folder_basis["revision"],"folderIds":null
      }}}
    })).await;
    assert!(all_folders.get("errors").is_none(), "all-folders save failed: {all_folders}");
    let all_basis = &all_folders["data"]["updateWorkspace"]["overviewSettings"];
    assert_eq!(all_basis["revision"],7);
    assert!(all_basis["folderIds"].is_null());
    assert_eq!(all_basis["introduction"],root_basis["introduction"]);
    assert_eq!(all_basis["folders"],folder_basis["folders"]);
    let conflict = helpers::gql(&app, owner_session, json!({
      "query":mutation,"variables":{"input":{"id":workspace,"description":"Must roll back via GraphQL","overview":{
        "expectedRevision":folder_basis["revision"],"introduction":null
      }}}
    })).await;
    assert_eq!(conflict["errors"][0]["extensions"]["name"],"WORKSPACE_OVERVIEW_REVISION_CONFLICT", "wrong conflict: {conflict}");
    let after_conflict = state.workspace().get_workspace(workspace).await.unwrap().unwrap();
    assert_eq!(after_conflict.overview_revision,7);
    assert_eq!(after_conflict.description,"Legacy description");
    assert_eq!(after_conflict.overview_settings.introduction,Some(introduction.clone()));
    let clear_saved = helpers::gql(&app, owner_session, json!({
      "query":mutation,"variables":{"input":{"id":workspace,"overview":{
        "expectedRevision":all_basis["revision"],"introduction":null
      }}}
    })).await;
    assert!(clear_saved.get("errors").is_none(), "clear save failed: {clear_saved}");
    let clear_basis = &clear_saved["data"]["updateWorkspace"]["overviewSettings"];
    assert_eq!(clear_basis["revision"],8);
    assert!(clear_basis["introduction"].is_null());
    assert!(clear_basis["folderIds"].is_null());
    assert_eq!(clear_basis["folders"],folder_basis["folders"]);
    assert!(state.doc().get_metadata(introduction_id).await.unwrap().is_some());
  })
  .catch_unwind()
  .await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner, reader]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
