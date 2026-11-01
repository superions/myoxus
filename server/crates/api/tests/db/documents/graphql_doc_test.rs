//! Doc role and workspace compat GraphQL tests.
//!
//! Covers: grantDocUserRoles, updateDocDefaultRole, publishDoc, recoverDoc,
//! revokePublicDoc, revokeDocUserRoles, and workspace quota/doc compat fields.

use crate::helpers;

use axum::{body::Body, http::Request};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;
use yrs::{GetString as _, ReadTxn as _, Text as _, Transact as _, updates::decoder::Decode as _};

#[tokio::test]
async fn history_metadata_survives_failed_lineage_and_denies_foreign_ids() {
  use futures_util::FutureExt;
  use myoxus_application::doc::DocService;
  use myoxus_infrastructure::doc::SqlxDocStore;
  use std::{panic::AssertUnwindSafe, sync::Arc};
  let (app, pool, auth) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth, "history-metadata").await;
  let (outsider, denied_session) = helpers::seed_user(&pool, &auth, "history-metadata-denied").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let other_workspace = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, workspace, owner).await;
  let other_doc = helpers::create_doc(&pool, workspace, owner).await;
  let foreign_doc = helpers::create_doc(&pool, other_workspace, owner).await;
  let operation = Uuid::new_v4();
  let result = AssertUnwindSafe(async {
    let timestamp = Utc::now() - chrono::Duration::days(3);
    let body = yjs::markdown_to_yjs("Retained history", "Exact body remains immutable").unwrap();
    let history: i64 = sqlx::query_scalar(
      "INSERT INTO doc_histories(doc_id,workspace_id,snapshot,created_at,origin,actor_id,reference_workspace_id)
       VALUES($1,$2,$3,$4,'manual',$5,$2) RETURNING id"
    ).bind(doc).bind(workspace).bind(&body).bind(timestamp).bind(owner).fetch_one(&pool).await.unwrap();
    let newer: i64 = sqlx::query_scalar("INSERT INTO doc_histories(doc_id,workspace_id,snapshot,origin) VALUES($1,$2,$3,'automatic') RETURNING id")
      .bind(doc).bind(workspace).bind(&body).fetch_one(&pool).await.unwrap();
    let docs = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    assert_eq!(docs.history_entry(history).await.unwrap().unwrap().snapshot, body);
    // A malformed committed lineage makes byte projection fail. Metadata must
    // remain navigable without loading that manifest or decoding the body.
    let hash = "e".repeat(64);
    sqlx::query("INSERT INTO workspace_content_operations(id,idempotency_id,actor_id,kind,source_workspace_id,target_workspace_id,status,manifest_hash) VALUES($1,$2,$3,'move',$4,$5,'succeeded',$6)")
      .bind(operation).bind(Uuid::new_v4()).bind(owner).bind(workspace).bind(other_workspace).bind(&hash).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_content_move_revision_manifests(operation_id,manifest,manifest_hash) VALUES($1,$2,$3)")
      .bind(operation).bind(json!({"history_reference_lineage":[{"history_id":history}]})).bind(&hash).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_content_move_publications(operation_id,source_workspace_id,target_workspace_id,manifest_hash,resource_count,diagnostic_instance_id) VALUES($1,$2,$3,$4,1,'hist02-lineage-fixture')")
      .bind(operation).bind(workspace).bind(other_workspace).bind(&hash).execute(&pool).await.unwrap();
    let query = "query($w:String!,$d:String!,$s:ID!) { workspace(id:$w) { histories(guid:$d,take:10) { snapshotId timestamp origin editor { name } } history(guid:$d,snapshotId:$s) { snapshotId timestamp origin editor { name } } } }";
    let variables = json!({"w":workspace.to_string(),"d":doc.to_string(),"s":history.to_string()});
    let response = helpers::gql(&app,session,json!({"query":query,"variables":variables})).await;
    assert!(response.get("errors").is_none(), "metadata projection failed: {response}");
    let exact = &response["data"]["workspace"]["history"];
    assert_eq!(exact,&response["data"]["workspace"]["histories"][1]);
    assert_eq!(exact["snapshotId"],history.to_string());
    assert_eq!(exact["origin"],"manual");
    assert_eq!(exact["editor"]["name"],"history-metadata");
    assert_eq!(chrono::DateTime::parse_from_rfc3339(exact["timestamp"].as_str().unwrap()).unwrap().timestamp_micros(),timestamp.timestamp_micros());
    let outside_page = helpers::gql(&app,session,json!({"query":query.replace("take:10","take:1"),"variables":variables})).await;
    assert!(outside_page.get("errors").is_none(), "out-of-page metadata failed: {outside_page}");
    assert_eq!(outside_page["data"]["workspace"]["histories"][0]["snapshotId"],newer.to_string());
    assert_eq!(&outside_page["data"]["workspace"]["history"],exact);
    assert!(docs.history_entry(history).await.is_err(), "exact bytes must expose the lineage failure");
    let comparison = helpers::gql(&app, session, json!({
      "query":"query($w:String!,$d:String!,$s:ID!) { workspace(id:$w) { historyDiff(guid:$d,snapshotId:$s) { snapshotId currentRevision } } }",
      "variables":variables
    })).await;
    assert!(comparison.get("errors").is_some(), "comparison cannot hide invalid lineage: {comparison}");
    let preview = app.clone().oneshot(Request::builder()
      .uri(format!("/api/workspaces/{workspace}/docs/{doc}/histories/by-id/{history}"))
      .header("Cookie",format!("affine_session={session}"))
      .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(preview.status(),axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    for (w,d) in [(workspace,other_doc),(other_workspace,foreign_doc)] {
      let foreign = helpers::gql(&app,session,json!({"query":query,"variables":{"w":w.to_string(),"d":d.to_string(),"s":history.to_string()}})).await;
      assert!(foreign.get("errors").is_none(), "foreign history lookup failed: {foreign}");
      assert!(foreign["data"]["workspace"]["history"].is_null());
      assert_eq!(foreign["data"]["workspace"]["histories"],json!([]));
    }
    let denied = helpers::gql(&app,denied_session,json!({"query":query,"variables":variables})).await;
    assert!(denied.get("errors").is_some());
    assert!(denied["data"]["workspace"].is_null());
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'External','Accepted',now())")
      .bind(workspace).bind(outsider).execute(&pool).await.unwrap();
    sqlx::query("UPDATE docs SET default_role='None' WHERE id=$1")
      .bind(doc).execute(&pool).await.unwrap();
    let accessible_workspace = helpers::gql(&app,denied_session,json!({"query":"query($w:String!){workspace(id:$w){id}}","variables":{"w":workspace.to_string()}})).await;
    assert!(accessible_workspace.get("errors").is_none(), "workspace read must succeed: {accessible_workspace}");
    let denied_document = helpers::gql(&app,denied_session,json!({"query":query,"variables":variables})).await;
    assert!(denied_document.get("errors").is_some(), "document read must remain denied: {denied_document}");
    assert!(denied_document["data"]["workspace"]["history"].is_null());
    let invalid = helpers::gql(&app,session,json!({"query":query,"variables":{"w":workspace.to_string(),"d":doc.to_string(),"s":"not-a-snapshot"}})).await;
    assert!(invalid.get("errors").is_some());
    assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT snapshot FROM doc_histories WHERE id=$1")
      .bind(history).fetch_one(&pool).await.unwrap(),body);
  }).catch_unwind().await;
  sqlx::query("DELETE FROM workspace_content_operations WHERE id=$1")
    .bind(operation)
    .execute(&pool)
    .await
    .expect("remove exact malformed lineage fixture");
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind([workspace, other_workspace])
    .execute(&pool)
    .await
    .expect("remove metadata fixture workspaces");
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind([owner, outsider])
    .execute(&pool)
    .await
    .expect("remove metadata fixture users");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn history_metadata_reads_do_not_mix_concurrent_move_owners() {
  use futures_util::FutureExt;
  use myoxus_application::{auth::AuthError, doc::DocService};
  use myoxus_infrastructure::doc::SqlxDocStore;
  use std::{panic::AssertUnwindSafe, sync::Arc};
  let (_, pool, auth) = helpers::setup_app().await;
  let (owner, _) = helpers::seed_user(&pool, &auth, "history-owner-race").await;
  let source = helpers::create_workspace(&pool, owner).await;
  let target = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, source, owner).await;
  let result = AssertUnwindSafe(async {
    let history: i64 =
      sqlx::query_scalar("INSERT INTO doc_histories(doc_id,workspace_id,snapshot) VALUES($1,$2,$3) RETURNING id")
        .bind(doc)
        .bind(source)
        .bind(vec![0_u8, 0])
        .fetch_one(&pool)
        .await
        .unwrap();
    let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    // Move publication changes these owners atomically. Exercise the read port
    // against that transaction boundary while it alternates both directions.
    let writer = async {
      for n in 0..40 {
        let workspace = if n % 2 == 0 { target } else { source };
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("UPDATE docs SET workspace_id=$1 WHERE id=$2")
          .bind(workspace)
          .bind(doc)
          .execute(&mut *tx)
          .await
          .unwrap();
        sqlx::query("UPDATE doc_histories SET workspace_id=$1 WHERE doc_id=$2")
          .bind(workspace)
          .bind(doc)
          .execute(&mut *tx)
          .await
          .unwrap();
        tokio::task::yield_now().await;
        tx.commit().await.unwrap();
      }
    };
    let reader = async {
      for _ in 0..80 {
        for workspace in [source, target] {
          match service.history_page(workspace, doc, None, None, 10, false).await {
            Ok(entries) => {
              assert_eq!(entries.len(), 1, "an owned read cannot observe half a Move");
              assert_eq!(entries[0].id, history);
              assert_eq!(entries[0].workspace_id, workspace);
            }
            Err(AuthError::NotFound(_)) => {}
            other => panic!("unexpected history ownership read: {other:?}"),
          }
          match service.history_metadata(workspace, doc, history).await {
            Ok(Some(entry)) => assert_eq!(entry.workspace_id, workspace),
            Err(AuthError::NotFound(_)) => {}
            other => panic!("exact metadata cannot become missing during an owned read: {other:?}"),
          }
        }
      }
    };
    tokio::join!(writer, reader);
    assert!(matches!(
      service.history_page(target, doc, None, None, 10, false).await,
      Err(AuthError::NotFound(_))
    ));
    assert_eq!(
      service
        .history_metadata(source, doc, history)
        .await
        .unwrap()
        .unwrap()
        .id,
      history
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind([source, target])
    .execute(&pool)
    .await
    .expect("remove concurrent ownership fixtures");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("remove concurrent ownership actor");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn history_cursor_preserves_equal_timestamps_and_exact_string_ids() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "history-cursor").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  let timestamp = Utc::now();
  let mut ids = Vec::new();
  for _ in 0..12 {
    let id: i64 = sqlx::query_scalar(
      "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(vec![0_u8, 0])
    .bind(timestamp)
    .fetch_one(&pool)
    .await
    .unwrap();
    ids.push(id.to_string());
  }
  ids.reverse();
  let query = "query($w: String!, $d: String!, $cursor: String) { workspace(id:$w) { histories(guid:$d,take:5,cursor:$cursor) { id snapshotId cursor timestamp } } }";
  let mut cursor = None::<String>;
  let mut received = Vec::new();
  for expected_count in [5, 5, 2] {
    let response = helpers::gql(
      &app,
      session_id,
      json!({"query":query,"variables":{"w":workspace_id.to_string(),"d":doc_id.to_string(),"cursor":cursor}}),
    )
    .await;
    assert!(response.get("errors").is_none(), "history request failed: {response}");
    let page = response["data"]["workspace"]["histories"].as_array().unwrap();
    assert_eq!(page.len(), expected_count);
    for entry in page {
      assert_eq!(
        entry["id"],
        doc_id.to_string(),
        "legacy id remains the document selector"
      );
      received.push(entry["snapshotId"].as_str().expect("lossless snapshot ID").to_string());
    }
    cursor = Some(page.last().unwrap()["cursor"].as_str().unwrap().to_string());
  }
  assert_eq!(received, ids, "equal timestamps must neither omit nor repeat snapshots");
  let invalid = helpers::gql(
    &app,
    session_id,
    json!({"query":query,"variables":{"w":workspace_id.to_string(),"d":doc_id.to_string(),"cursor":"invalid"}}),
  )
  .await;
  assert!(
    invalid.get("errors").is_some(),
    "malformed cursor must not restart pagination"
  );
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn named_history_filter_applies_before_cursor_pagination() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "history-named-filter").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  let mut ids = Vec::new();
  for age_minutes in 0_i64..12 {
    let id: i64 = sqlx::query_scalar(
      "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at)
       VALUES ($1, $2, $3, NOW() - ($4 * INTERVAL '1 minute')) RETURNING id",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(vec![0_u8, 0])
    .bind(age_minutes)
    .fetch_one(&pool)
    .await
    .expect("history fixture");
    ids.push(id);
  }
  for (label, history_id) in [("older named", ids[10]), ("oldest named", ids[11])] {
    sqlx::query(
      "INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by)
       VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(history_id)
    .bind(label)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("named reference fixture");
  }

  let query = "query($w: String!, $d: String!, $cursor: String, $named: Boolean) { workspace(id:$w) { histories(guid:$d,take:1,cursor:$cursor,namedOnly:$named) { snapshotId cursor } } }";
  let first = helpers::gql(
    &app,
    session_id,
    json!({"query":query,"variables":{"w":workspace_id.to_string(),"d":doc_id.to_string(),"named":true}}),
  )
  .await;
  assert!(first.get("errors").is_none(), "named page one failed: {first}");
  let first_row = &first["data"]["workspace"]["histories"][0];
  assert_eq!(first_row["snapshotId"], ids[10].to_string());
  let second = helpers::gql(
    &app,
    session_id,
    json!({"query":query,"variables":{"w":workspace_id.to_string(),"d":doc_id.to_string(),"named":true,"cursor":first_row["cursor"]}}),
  )
  .await;
  assert!(second.get("errors").is_none(), "named page two failed: {second}");
  assert_eq!(
    second["data"]["workspace"]["histories"][0]["snapshotId"],
    ids[11].to_string()
  );

  let unfiltered = helpers::gql(
    &app,
    session_id,
    json!({"query":query,"variables":{"w":workspace_id.to_string(),"d":doc_id.to_string(),"named":false}}),
  )
  .await;
  assert_eq!(
    unfiltered["data"]["workspace"]["histories"][0]["snapshotId"],
    ids[0].to_string()
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn history_provenance_returns_explicit_source_and_never_guesses_legacy_actor() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "history-provenance").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  let legacy_id: i64 = sqlx::query_scalar(
    "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '1 minute') RETURNING id",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(vec![0_u8, 0])
  .fetch_one(&pool)
  .await
  .expect("insert legacy history");
  let sourced_id: i64 = sqlx::query_scalar(
    "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, origin, actor_id) VALUES ($1, $2, $3, 'manual', $4) RETURNING id",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(vec![0_u8, 0])
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("insert sourced history");
  let query = "query($w: String!, $d: String!) { workspace(id:$w) { histories(guid:$d,take:10) { snapshotId origin editor { name } timestamp } } }";
  let response = helpers::gql(
    &app,
    session_id,
    json!({"query":query,"variables":{"w":workspace_id.to_string(),"d":doc_id.to_string()}}),
  )
  .await;
  assert!(response.get("errors").is_none(), "history request failed: {response}");
  let entries = response["data"]["workspace"]["histories"]
    .as_array()
    .expect("history array");
  let sourced = entries
    .iter()
    .find(|entry| entry["snapshotId"] == sourced_id.to_string())
    .expect("sourced history");
  assert_eq!(sourced["origin"], "manual");
  assert_eq!(sourced["editor"]["name"], "history-provenance");
  let legacy = entries
    .iter()
    .find(|entry| entry["snapshotId"] == legacy_id.to_string())
    .expect("legacy history");
  assert!(legacy["origin"].is_null(), "legacy origin must stay unknown");
  assert!(legacy["editor"].is_null(), "legacy actor must not be inferred");

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: doc role mutations (grant, publish, recover, revoke) persist correct state to DB
async fn inv_doc_role_publish_and_recover_mutations_persist_db_state() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6doc").await;

  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("make publish mutation workspace eligible");
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  let snapshot = yrs::Doc::new();
  snapshot
    .get_or_insert_text("content")
    .insert(&mut snapshot.transact_mut(), 0, "Historical content");
  let snapshot = snapshot
    .transact()
    .encode_state_as_update_v1(&yrs::StateVector::default());
  sqlx::query("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3)")
    .bind(doc_id)
    .bind(workspace_id)
    .bind(snapshot)
    .execute(&pool)
    .await
    .expect("insert history");

  let other_user = helpers::create_user(&pool, "p6other", false).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: GrantDocUserRolesInput!) { grantDocUserRoles(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "userIds": [other_user.to_string()],
        "role": "Manager"
      }}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "grant failed: {resp}");
  assert_eq!(resp["data"]["grantDocUserRoles"], true);

  let role_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2")
      .bind(doc_id)
      .bind(other_user)
      .fetch_one(&pool)
      .await
      .expect("doc_user_permissions query after grantDocUserRoles");
  assert!(
    role_count > 0,
    "doc_user_permissions must contain the granted role after grantDocUserRoles"
  );

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: UpdateDocDefaultRoleInput!) { updateDocDefaultRole(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "role": "Editor"
      }}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "updateDocDefaultRole failed: {resp}");
  assert_eq!(resp["data"]["updateDocDefaultRole"], true);

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ publishDoc(workspaceId:\"{workspace_id}\", docId:\"{doc_id}\") {{ id public mode }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "publishDoc failed: {resp}");
  assert_eq!(resp["data"]["publishDoc"]["public"], true);

  let public_mode_after_publish: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("docs query after publishDoc");
  assert!(
    public_mode_after_publish.is_some(),
    "docs.public_mode must be non-null (published) after publishDoc mutation"
  );

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ recoverDoc(workspaceId:\"{workspace_id}\", guid:\"{doc_id}\", timestamp:\"{}\") }}", Utc::now().to_rfc3339())}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "recoverDoc failed: {resp}");
  let updates: Vec<Vec<u8>> = sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id=$1 ORDER BY sequence")
    .bind(doc_id)
    .fetch_all(&pool)
    .await
    .expect("read restored updates");
  let restored = yrs::Doc::new();
  for update in updates {
    restored
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&update).unwrap())
      .unwrap();
  }
  assert_eq!(
    restored.get_or_insert_text("content").get_string(&restored.transact()),
    "Historical content"
  );
  let public_mode_after_restore: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read publication after restore");
  assert_eq!(public_mode_after_restore, public_mode_after_publish);

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ revokePublicDoc(workspaceId:\"{workspace_id}\", docId:\"{doc_id}\") {{ id public }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "revokePublicDoc failed: {resp}");
  assert_eq!(resp["data"]["revokePublicDoc"]["public"], false);

  let public_mode_after_revoke: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("docs query after revokePublicDoc");
  assert!(
    public_mode_after_revoke.is_none(),
    "docs.public_mode must be null (revoked) after revokePublicDoc mutation"
  );

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: RevokeDocUserRoleInput!) { revokeDocUserRoles(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "userIds": [other_user.to_string()]
      }}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "revokeDocUserRoles failed: {resp}");
  assert_eq!(resp["data"]["revokeDocUserRoles"], true);

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup recoverDoc audit evidence");
  // Cleanup
  helpers::cleanup_users(&pool, &[user_id, other_user]).await;
}

#[tokio::test]
async fn publish_doc_roundtrips_external_ids_to_public_docs_projection() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6pubkey").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("make external-key publish workspace eligible");
  let external_id = format!("graphql-public-client-doc-{workspace_id}");
  let doc_id = Uuid::new_v4();

  sqlx::query(
    r#"
      INSERT INTO docs (id, workspace_id, title, external_id, default_role, is_workspace_root, created_by, updated_by)
      VALUES ($1, $2, 'Original Public Key', $3, 'viewer', FALSE, $4, $4)
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(&external_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert original-id public doc fixture");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation Publish($workspaceId: String!, $docId: String!, $mode: PublicDocMode) { publishDoc(workspaceId: $workspaceId, docId: $docId, mode: $mode) { id public mode } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": external_id,
        "mode": "Edgeless"
      }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "publishDoc original id failed: {resp}");
  assert_eq!(resp["data"]["publishDoc"]["id"], external_id);
  assert_eq!(resp["data"]["publishDoc"]["public"], true);
  assert_eq!(resp["data"]["publishDoc"]["mode"], "Edgeless");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query PublicDocs($workspaceId: String!) { workspace(id: $workspaceId) { publicDocs { id public mode } } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "publicDocs original id query failed: {resp}"
  );
  let docs = resp["data"]["workspace"]["publicDocs"]
    .as_array()
    .expect("publicDocs array");
  let doc = docs
    .iter()
    .find(|doc| doc["id"] == external_id)
    .expect("published original-id doc in publicDocs");
  assert_eq!(doc["public"], true);
  assert_eq!(
    doc["mode"], "Edgeless",
    "publicDocs must preserve the DB Edgeless mode case-insensitively"
  );

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation Revoke($workspaceId: String!, $docId: String!) { revokePublicDoc(workspaceId: $workspaceId, docId: $docId) { id public } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": external_id
      }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "revokePublicDoc original id failed: {resp}"
  );
  assert_eq!(resp["data"]["revokePublicDoc"]["id"], external_id);
  assert_eq!(resp["data"]["revokePublicDoc"]["public"], false);

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn permission_and_public_routes_use_only_workspace_external_document_keys() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "p02a-owner").await;
  let granted_user_id = helpers::create_user(&pool, "p02a-granted", false).await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let other_workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // Preserve the shipped UUID-default case before exercising distinct IDs.
  let uuid_default_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let uuid_default = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: UpdateDocDefaultRoleInput!) { updateDocDefaultRole(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "docId": uuid_default_doc_id.to_string(),
        "role": "Editor"
      }}
    }),
  )
  .await;
  assert!(
    uuid_default.get("errors").is_none(),
    "UUID-default role update failed: {uuid_default}"
  );

  let nano_external_id = "p02a-NanoRouteKey7mK2xQ";
  let nano_internal_id = Uuid::new_v4();
  let collision_decoy_internal_id = Uuid::new_v4();
  let collision_target_internal_id = Uuid::new_v4();
  let collision_external_id = collision_decoy_internal_id.to_string();
  for (id, external_id, title, public_mode) in [
    (nano_internal_id, nano_external_id, "P02A Nano Preview", Some("page")),
    (
      collision_decoy_internal_id,
      "p02a-collision-decoy",
      "P02A Collision Decoy",
      None,
    ),
    (
      collision_target_internal_id,
      collision_external_id.as_str(),
      "P02A Collision Target",
      Some("page"),
    ),
  ] {
    sqlx::query(
      "INSERT INTO docs
         (id, workspace_id, title, external_id, default_role, is_workspace_root, created_by, updated_by, public_mode)
       VALUES ($1, $2, $3, $4, 'viewer', false, $5, $5, $6)",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(title)
    .bind(external_id)
    .bind(owner_id)
    .bind(public_mode)
    .execute(&pool)
    .await
    .expect("insert P02A document fixture");
  }
  sqlx::query("UPDATE workspaces SET enable_sharing = true, enable_url_preview = true WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("enable isolated preview fixture");
  sqlx::query("UPDATE docs SET public_mode = 'page' WHERE id = $1")
    .bind(uuid_default_doc_id)
    .execute(&pool)
    .await
    .expect("publish UUID-default preview fixture");

  let nano_default = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: UpdateDocDefaultRoleInput!) { updateDocDefaultRole(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "externalDocId": nano_external_id,
        "role": "Editor"
      }}
    }),
  )
  .await;
  assert!(
    nano_default.get("errors").is_none(),
    "NanoID role update failed: {nano_default}"
  );

  let grant = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: GrantDocUserRolesInput!) { grantDocUserRoles(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "externalDocId": nano_external_id,
        "userIds": [granted_user_id.to_string()],
        "role": "Reader"
      }}
    }),
  )
  .await;
  assert!(grant.get("errors").is_none(), "external-key grant failed: {grant}");

  let uuid_grant = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: GrantDocUserRolesInput!) { grantDocUserRoles(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "docId": uuid_default_doc_id.to_string(),
        "userIds": [granted_user_id.to_string()],
        "role": "Reader"
      }}
    }),
  )
  .await;
  assert!(
    uuid_grant.get("errors").is_none(),
    "UUID-default grant failed: {uuid_grant}"
  );

  let listing = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($workspaceId: String!, $nanoId: String!, $uuidId: String!) { workspace(id: $workspaceId) { nano: doc(docId: $nanoId) { id grantedUsersList { totalCount edges { node { user { id } } } } } uuid: doc(docId: $uuidId) { id grantedUsersList { totalCount } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "nanoId": nano_external_id,
        "uuidId": uuid_default_doc_id.to_string()
      }
    }),
  )
  .await;
  assert!(
    listing.get("errors").is_none(),
    "external-key granted-user listing failed: {listing}"
  );
  assert_eq!(listing["data"]["workspace"]["nano"]["id"], nano_external_id);
  assert_eq!(
    listing["data"]["workspace"]["nano"]["grantedUsersList"]["totalCount"],
    1
  );
  assert_eq!(
    listing["data"]["workspace"]["nano"]["grantedUsersList"]["edges"][0]["node"]["user"]["id"],
    granted_user_id.to_string()
  );
  assert_eq!(
    listing["data"]["workspace"]["uuid"]["id"],
    uuid_default_doc_id.to_string()
  );
  assert_eq!(
    listing["data"]["workspace"]["uuid"]["grantedUsersList"]["totalCount"],
    1
  );

  let uuid_default_external_id = uuid_default_doc_id.to_string();
  for (field_name, route_key, expected_doc_id) in [
    ("externalDocId", nano_external_id, nano_internal_id),
    ("docId", uuid_default_external_id.as_str(), uuid_default_doc_id),
  ] {
    let updated = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($input: UpdateDocUserRoleInput!) { updateDocUserRole(input: $input) }",
        "variables": {"input": {
          "workspaceId": workspace_id.to_string(),
          (field_name): route_key,
          "userId": granted_user_id.to_string(),
          "role": "Manager"
        }}
      }),
    )
    .await;
    assert!(
      updated.get("errors").is_none(),
      "{field_name} user-role update failed: {updated}"
    );
    let stored_role: String =
      sqlx::query_scalar("SELECT role FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2")
        .bind(expected_doc_id)
        .bind(granted_user_id)
        .fetch_one(&pool)
        .await
        .expect("read role stored under the internal document UUID");
    assert_eq!(stored_role, "Manager");
  }

  let permission_count_before_conflict: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2")
      .bind(nano_internal_id)
      .bind(granted_user_id)
      .fetch_one(&pool)
      .await
      .expect("read permission count before conflicting input");
  let conflicting_names = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: GrantDocUserRolesInput!) { grantDocUserRoles(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "externalDocId": nano_external_id,
        "docId": null,
        "userIds": [granted_user_id.to_string()],
        "role": "Reader"
      }}
    }),
  )
  .await;
  assert!(
    conflicting_names.get("errors").is_some(),
    "both external-key names must be rejected even when the alias is null: {conflicting_names}"
  );
  let permission_count_after_conflict: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2")
      .bind(nano_internal_id)
      .bind(granted_user_id)
      .fetch_one(&pool)
      .await
      .expect("read permission count after conflicting input");
  assert_eq!(
    permission_count_after_conflict, permission_count_before_conflict,
    "conflicting transport names must fail before a permission write"
  );

  let collision_update = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($input: UpdateDocDefaultRoleInput!) { updateDocDefaultRole(input: $input) }",
      "variables": {"input": {
        "workspaceId": workspace_id.to_string(),
        "externalDocId": collision_external_id,
        "role": "Editor"
      }}
    }),
  )
  .await;
  assert!(
    collision_update.get("errors").is_none(),
    "UUID-shaped external key must win over internal UUID syntax: {collision_update}"
  );
  let roles = sqlx::query_as::<_, (String, String)>(
    "SELECT id::text, default_role::text FROM docs WHERE id = ANY($1) ORDER BY id",
  )
  .bind(vec![collision_decoy_internal_id, collision_target_internal_id])
  .fetch_all(&pool)
  .await
  .expect("read collision roles");
  assert_eq!(
    roles
      .iter()
      .find(|(id, _)| id == &collision_target_internal_id.to_string())
      .map(|(_, role)| role.as_str()),
    Some("editor")
  );
  assert_eq!(
    roles
      .iter()
      .find(|(id, _)| id == &collision_decoy_internal_id.to_string())
      .map(|(_, role)| role.as_str()),
    Some("viewer")
  );

  for (request_workspace, rejected_key) in [
    (workspace_id, nano_internal_id.to_string()),
    (other_workspace_id, nano_external_id.to_string()),
  ] {
    let rejected = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($input: UpdateDocDefaultRoleInput!) { updateDocDefaultRole(input: $input) }",
        "variables": {"input": {
          "workspaceId": request_workspace.to_string(),
          "externalDocId": rejected_key,
          "role": "Editor"
        }}
      }),
    )
    .await;
    assert!(
      rejected.get("errors").is_some(),
      "internal/cross-workspace key unexpectedly resolved: {rejected}"
    );
    assert!(
      rejected["data"].is_null(),
      "denial must not disclose document data: {rejected}"
    );
  }

  for (field_name, route_key, expected_doc_id) in [
    ("externalDocId", nano_external_id, nano_internal_id),
    ("docId", uuid_default_external_id.as_str(), uuid_default_doc_id),
  ] {
    let revoked = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($input: RevokeDocUserRoleInput!) { revokeDocUserRoles(input: $input) }",
        "variables": {"input": {
          "workspaceId": workspace_id.to_string(),
          (field_name): route_key,
          "userIds": [granted_user_id.to_string()]
        }}
      }),
    )
    .await;
    assert!(revoked.get("errors").is_none(), "{field_name} revoke failed: {revoked}");
    let stored_count: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2")
        .bind(expected_doc_id)
        .bind(granted_user_id)
        .fetch_one(&pool)
        .await
        .expect("read permission count after revoke");
    assert_eq!(stored_count, 0);
  }

  for (route_key, expected_status, expected_title) in [
    (uuid_default_doc_id.to_string(), 200, None),
    (nano_external_id.to_string(), 200, Some("P02A Nano Preview")),
    (nano_internal_id.to_string(), 404, None),
    (collision_external_id, 200, Some("P02A Collision Target")),
  ] {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!("/workspace/{workspace_id}/{route_key}"))
          .body(Body::empty())
          .expect("renderer request"),
      )
      .await
      .expect("renderer response");
    assert_eq!(response.status().as_u16(), expected_status);
    let body = response.into_body().collect().await.expect("renderer body").to_bytes();
    if let Some(title) = expected_title {
      assert!(
        String::from_utf8_lossy(&body).contains(title),
        "renderer selected the wrong document"
      );
    }
  }

  helpers::cleanup_workspaces(&pool, &[workspace_id, other_workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id, granted_user_id]).await;
}

#[tokio::test]
async fn publish_doc_missing_server_doc_returns_structured_doc_not_found() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6pubmissing").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let missing_doc_id = format!("missing-public-doc-{workspace_id}");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation Publish($workspaceId: String!, $docId: String!, $mode: PublicDocMode) { publishDoc(workspaceId: $workspaceId, docId: $docId, mode: $mode) { id public mode } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": missing_doc_id.clone(),
        "mode": "Page"
      }
    }),
  )
  .await;

  let error = resp["errors"]
    .as_array()
    .and_then(|errors| errors.first())
    .unwrap_or_else(|| panic!("publishDoc must fail with structured NOT_FOUND: {resp}"));
  assert_eq!(error["extensions"]["name"], "NOT_FOUND");
  assert_eq!(error["extensions"]["type"], "RESOURCE_NOT_FOUND");
  assert_eq!(error["extensions"]["data"]["message"], "document");
  assert!(
    resp["data"].is_null(),
    "GraphQL response must not contain publishDoc data for a missing server doc: {resp}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: workspace doc query returns quota compat fields (usedSize, blockSize) without error
async fn inv_workspace_doc_and_quota_compat_fields_are_available() {
  let (app, pool, auth_store) = helpers::setup_app_with_search_repository().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6quota").await;

  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  sqlx::query(
    r#"
      INSERT INTO search_content (workspace_id, doc_id, title, plain_text, search_vector, updated_at)
      VALUES ($1, $2, $3, $4, to_tsvector('simple', $3 || ' ' || $4), $5)
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind("Summary contract")
  .bind("First line with    extra whitespace.\nSecond line proves normalization.")
  .bind(Utc::now())
  .execute(&pool)
  .await
  .expect("insert search document");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($id: String!, $docId: String!) { workspace(id: $id, docId: $docId) { quota { usedStorageQuota memberCount overcapacityMemberCount humanReadable { memberCount overcapacityMemberCount } } doc(docId: $docId) { id defaultRole mode public title summary } } }",
      "variables": {"id": workspace_id.to_string(), "docId": doc_id.to_string()}
    }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "workspace compat query failed: {resp}");
  let quota = &resp["data"]["workspace"]["quota"];
  assert!(quota["usedStorageQuota"].is_i64(), "missing usedStorageQuota: {resp}");
  assert!(quota["memberCount"].is_i64(), "missing memberCount: {resp}");
  assert!(
    quota["overcapacityMemberCount"].is_i64(),
    "missing overcapacityMemberCount: {resp}"
  );
  assert!(
    quota["humanReadable"]["memberCount"].is_string(),
    "missing humanReadable.memberCount: {resp}"
  );
  assert!(
    quota["humanReadable"]["overcapacityMemberCount"].is_string(),
    "missing humanReadable.overcapacityMemberCount: {resp}"
  );
  let member_count = quota["memberCount"].as_i64().unwrap_or_default();
  assert!(
    member_count >= 1,
    "global seat usage should be at least one active user: {resp}"
  );
  assert_eq!(
    quota["humanReadable"]["memberCount"].as_str(),
    Some(member_count.to_string().as_str()),
    "human-readable seat usage must mirror numeric memberCount: {resp}"
  );
  assert_eq!(
    quota["overcapacityMemberCount"].as_i64(),
    Some(0),
    "owner-only workspace should not be overcapacity: {resp}"
  );
  assert_eq!(
    resp["data"]["workspace"]["doc"]["id"].as_str(),
    Some(doc_id.to_string().as_str())
  );
  assert_eq!(
    resp["data"]["workspace"]["doc"]["summary"].as_str(),
    Some("First line with extra whitespace. Second line proves normalization."),
    "workspace.doc.summary should come from search_content.plain_text: {resp}"
  );

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}
