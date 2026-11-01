// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for the comment GraphQL resolvers (create, list, delete).
//!
//! P83-J-04: migrated from InMemoryCommentStore + InMemoryAuthStore to
//! SqlxCommentRepository + SqlxAuthStore so DB-state assertions are possible.
use crate::helpers;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_infrastructure::auth::SqlxAuthStore;
use sqlx::PgPool;

// ---------------------------------------------------------------------------
// DB-backed test setup (P83-J-04: unblocks DB-state assertions)
// ---------------------------------------------------------------------------

async fn setup_test_app() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  helpers::setup_comment_app(false).await
}

async fn graphql(app: &axum::Router, session_id: Uuid, payload: Value) -> Value {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(serde_json::to_vec(&payload).expect("payload serialization")))
        .expect("request builder"),
    )
    .await
    .expect("graphql request should succeed");
  let bytes = response
    .into_body()
    .collect()
    .await
    .expect("response body collection")
    .to_bytes();
  serde_json::from_slice(&bytes).expect("response should be valid JSON")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// INV-COMMENT-01: Create/reply/resolve/reopen/edit/markRead full lifecycle.
/// P83-J-04: after createComment, verify `comments` table has ≥1 row.
#[tokio::test]
async fn graphql_comment_threads_replies_resolve_and_edit_history_flow() {
  let (app, pool, auth_store) = setup_test_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "comment-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_uuid = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let doc_id = doc_uuid.to_string();

  let create_root = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation CreateRoot($workspaceId: String!, $docId: String!) { createComment(workspaceId: $workspaceId, docId: $docId, body: {text: \"root\"}) { id resolved } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(create_root.get("errors").is_none(), "unexpected errors: {create_root}");
  let root_id = create_root["data"]["createComment"]["id"]
    .as_str()
    .expect("createComment id must be a string")
    .to_string();

  // INV-COMMENT-01a: comment must be persisted in comments table (P83-J-04)
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comments WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("comments count query");
  assert!(count >= 1, "comment must be persisted in comments: count={count}");

  let create_reply = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation CreateReply($workspaceId: String!, $docId: String!, $parent: String!) { createComment(workspaceId: $workspaceId, docId: $docId, parentCommentId: $parent, body: {text: \"reply\"}) { id parentCommentId } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id, "parent": root_id}
    }),
  )
  .await;
  assert!(
    create_reply.get("errors").is_none(),
    "unexpected errors: {create_reply}"
  );

  let create_reply_v2 = graphql(
    &app,
    session_id,
    json!({
      "query":"mutation CreateReply($input: ReplyCreateInput!){ createReply(input:$input){ id commentId } }",
      "variables":{"input":{"commentId": root_id, "content":{"text":"reply-v2"}}}
    }),
  )
  .await;
  assert!(
    create_reply_v2.get("errors").is_none(),
    "unexpected errors: {create_reply_v2}"
  );
  assert!(create_reply_v2["data"]["createReply"]["id"].is_string());

  let list_comments_v2 = graphql(
    &app,
    session_id,
    json!({
      "query":"query ListComments($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ comments(docId:$docId, pagination:{first:10}){ totalCount edges { node { id content replies { id commentId } } } } } }",
      "variables":{"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(
    list_comments_v2.get("errors").is_none(),
    "unexpected errors: {list_comments_v2}"
  );
  assert!(
    list_comments_v2["data"]["workspace"]["comments"]["totalCount"]
      .as_i64()
      .unwrap_or(0)
      >= 1
  );

  let update = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation Update($id: String!) { updateComment(commentId: $id, body: {text: \"root edited\"}) }",
      "variables": {"id": root_id}
    }),
  )
  .await;
  assert!(update.get("errors").is_none(), "unexpected errors: {update}");
  assert_eq!(update["data"]["updateComment"], true);

  let resolve = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation Resolve($id: String!) { resolveComment(commentId: $id) }",
      "variables": {"id": root_id}
    }),
  )
  .await;
  assert!(resolve.get("errors").is_none(), "unexpected errors: {resolve}");
  assert_eq!(resolve["data"]["resolveComment"], true);

  let reopen = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation Reopen($id: String!) { reopenComment(commentId: $id) { id resolved } }",
      "variables": {"id": root_id}
    }),
  )
  .await;
  assert!(reopen.get("errors").is_none(), "unexpected errors: {reopen}");
  assert_eq!(reopen["data"]["reopenComment"]["resolved"], false);

  let threads = graphql(
    &app,
    session_id,
    json!({
      "query": "query Threads($workspaceId: String!, $docId: String!) { commentThreads(workspaceId: $workspaceId, docId: $docId) { id unread } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(threads.get("errors").is_none(), "unexpected errors: {threads}");
  assert_eq!(
    threads["data"]["commentThreads"]
      .as_array()
      .expect("commentThreads array")
      .len(),
    1
  );
  assert_eq!(
    threads["data"]["commentThreads"][0]["unread"],
    serde_json::Value::Bool(true)
  );

  let mark_read = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation MarkRead($workspaceId: String!, $docId: String!, $id: String!) { markCommentThreadRead(workspaceId: $workspaceId, docId: $docId, commentId: $id) }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id, "id": root_id}
    }),
  )
  .await;
  assert!(mark_read.get("errors").is_none(), "unexpected errors: {mark_read}");
  assert_eq!(mark_read["data"]["markCommentThreadRead"], true);

  let threads_after_read = graphql(
    &app,
    session_id,
    json!({
      "query": "query Threads($workspaceId: String!, $docId: String!) { commentThreads(workspaceId: $workspaceId, docId: $docId, filter: Open) { id unread } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(
    threads_after_read.get("errors").is_none(),
    "unexpected errors: {threads_after_read}"
  );
  assert_eq!(
    threads_after_read["data"]["commentThreads"][0]["unread"],
    serde_json::Value::Bool(false)
  );

  let replies = graphql(
    &app,
    session_id,
    json!({
      "query": "query Replies($workspaceId: String!, $docId: String!, $parent: String!) { commentReplies(workspaceId: $workspaceId, docId: $docId, parentCommentId: $parent) { id parentCommentId } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id, "parent": root_id}
    }),
  )
  .await;
  assert!(replies.get("errors").is_none(), "unexpected errors: {replies}");
  assert!(
    !replies["data"]["commentReplies"]
      .as_array()
      .expect("commentReplies array")
      .is_empty()
  );

  let edits = graphql(
    &app,
    session_id,
    json!({
      "query": "query Edits($workspaceId: String!, $docId: String!, $id: String!) { commentEditHistory(workspaceId: $workspaceId, docId: $docId, commentId: $id) { id editedAt } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id, "id": root_id}
    }),
  )
  .await;
  assert!(edits.get("errors").is_none(), "unexpected errors: {edits}");
  assert_eq!(
    edits["data"]["commentEditHistory"]
      .as_array()
      .expect("commentEditHistory array")
      .len(),
    1
  );

  let comment_changes_v2 = graphql(
    &app,
    session_id,
    json!({
      "query":"query ListCommentChanges($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ commentChanges(docId:$docId, pagination:{first:10}){ totalCount edges { cursor node { id action } } } } }",
      "variables":{"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(
    comment_changes_v2.get("errors").is_none(),
    "unexpected errors: {comment_changes_v2}"
  );

  let mine_filter = graphql(
    &app,
    session_id,
    json!({
      "query": "query Mine($workspaceId: String!, $docId: String!) { commentThreads(workspaceId: $workspaceId, docId: $docId, filter: Mine) { id } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(mine_filter.get("errors").is_none(), "unexpected errors: {mine_filter}");
  assert_eq!(
    mine_filter["data"]["commentThreads"]
      .as_array()
      .expect("mine-filtered array")
      .len(),
    1
  );

  let mark_all = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation MarkAll($workspaceId: String!, $docId: String!) { markAllCommentThreadsRead(workspaceId: $workspaceId, docId: $docId) }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(mark_all.get("errors").is_none(), "unexpected errors: {mark_all}");
  assert_eq!(mark_all["data"]["markAllCommentThreadsRead"], 1);

  // Cleanup
  sqlx::query("DELETE FROM comments WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup comments");
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

/// INV-COMMENT-02: Non-workspace-member cannot create a comment (ACL enforcement).
#[tokio::test]
async fn graphql_comment_acl_rejects_outsider_create() {
  let (app, pool, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = helpers::seed_user(&pool, &auth_store, "comment-owner2").await;
  let (outsider_id, outsider_session_id) = helpers::seed_user(&pool, &auth_store, "comment-outsider").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_uuid = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let doc_id = doc_uuid.to_string();

  let owner_create = graphql(
    &app,
    owner_session_id,
    json!({
      "query": "mutation Create($workspaceId: String!, $docId: String!) { createComment(workspaceId: $workspaceId, docId: $docId, body: {text: \"ok\"}) { id } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(
    owner_create.get("errors").is_none(),
    "unexpected errors: {owner_create}"
  );

  let outsider_create = graphql(
    &app,
    outsider_session_id,
    json!({
      "query": "mutation Create($workspaceId: String!, $docId: String!) { createComment(workspaceId: $workspaceId, docId: $docId, body: {text: \"forbidden\"}) { id } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id}
    }),
  )
  .await;
  assert!(
    outsider_create.get("errors").is_some(),
    "expected ACL error: {outsider_create}"
  );
  assert_eq!(outsider_create["errors"][0]["extensions"]["name"], "ACTION_FORBIDDEN");

  // Cleanup
  sqlx::query("DELETE FROM comments WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup comments");
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id, outsider_id]).await;
}

/// INV-DOC-ID-PARSE-01 (behavioural): every comment resolver that accepts a
/// `docId` argument must pass through the workspace-scoped document-key resolver
/// helper, not `Uuid::parse_str` — the frontend sends nanoid-style IDs and the
/// old strict parse returned `INVALID_INPUT` which blanked the journal page.
///
/// Concrete: calling `listComments` / `commentChanges` / `commentThreads` /
/// `commentReplies` / `commentEditHistory` with a 21-char nanoid must succeed
/// (empty results are fine — the error "invalid doc id" must not appear).
///
/// Regression: 2026-04-24 — the journal-page blank-page bug. See
/// `learnings/LRN-20260424-doc-id-parse-regression.md`.
#[tokio::test]
async fn inv_doc_id_parse_comment_resolvers_accept_nanoid() {
  let (app, pool, auth_store) = setup_test_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "nanoid-doc-id").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  // A real-world nanoid docId as emitted by the web client.
  let nanoid_doc_id = "5XyeobElxob0CuAMGsAKz";

  let queries: [(&str, &str); 5] = [
    (
      "listComments",
      "query Q($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ comments(docId:$docId, pagination:{first:10}){ totalCount } } }",
    ),
    (
      "commentChanges",
      "query Q($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ commentChanges(docId:$docId, pagination:{first:10}){ totalCount } } }",
    ),
    (
      "commentThreads",
      "query Q($workspaceId:String!, $docId:String!){ commentThreads(workspaceId:$workspaceId, docId:$docId){ id } }",
    ),
    (
      "commentReplies",
      "query Q($workspaceId:String!, $docId:String!){ commentReplies(workspaceId:$workspaceId, docId:$docId, parentCommentId:\"00000000-0000-0000-0000-000000000000\"){ id } }",
    ),
    (
      "commentEditHistory",
      "query Q($workspaceId:String!, $docId:String!){ commentEditHistory(workspaceId:$workspaceId, docId:$docId, commentId:\"00000000-0000-0000-0000-000000000000\"){ id } }",
    ),
  ];

  for (label, q) in &queries {
    let resp = graphql(
      &app,
      session_id,
      json!({
        "query": q,
        "variables": {"workspaceId": workspace_id.to_string(), "docId": nanoid_doc_id}
      }),
    )
    .await;
    // The resolver may or may not return data (empty comments are fine).
    // What MUST NOT happen: an "invalid doc id" INVALID_INPUT error from the
    // raw Uuid::parse_str code path.
    if let Some(errors) = resp.get("errors").and_then(|e| e.as_array()) {
      for err in errors {
        let msg = err["message"].as_str().unwrap_or("");
        let name = err["extensions"]["name"].as_str().unwrap_or("");
        assert!(
          !msg.contains("invalid doc id") && name != "INVALID_INPUT",
          "[{label}] nanoid docId was rejected with INVALID_INPUT — raw Uuid::parse_str regression: {resp}"
        );
      }
    }
  }

  // Mutation path: createComment must also accept nanoid docId without
  // INVALID_INPUT (the workspace.comments list in the editor triggers the
  // mutation when the user submits their first inline comment).
  let create = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation M($workspaceId:String!, $docId:String!){ createComment(workspaceId:$workspaceId, docId:$docId, body:{text:\"hi\"}){ id } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": nanoid_doc_id}
    }),
  )
  .await;
  if let Some(errors) = create.get("errors").and_then(|e| e.as_array()) {
    for err in errors {
      let msg = err["message"].as_str().unwrap_or("");
      let name = err["extensions"]["name"].as_str().unwrap_or("");
      assert!(
        !msg.contains("invalid doc id") && name != "INVALID_INPUT",
        "[createComment] nanoid docId was rejected with INVALID_INPUT: {create}"
      );
    }
  }

  // Cleanup — createComment above may have persisted a row resolved through
  // the workspace-local external document key.
  sqlx::query("DELETE FROM comments WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup comments");
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

/// A failure after comment insertion must roll back both the comment and every
/// recipient intent. The trigger is restricted to this fixture's actor.
#[tokio::test]
async fn comment_intent_failure_rolls_back_comment_and_outbox() {
  use futures_util::FutureExt;
  let (app, pool, auth_store) = setup_test_app().await;
  let (actor, session) = helpers::seed_user(&pool, &auth_store, "atomic-comment").await;
  let (recipient, _) = helpers::seed_user(&pool, &auth_store, "atomic-mention").await;
  let workspace = helpers::create_workspace(&pool, actor).await;
  let doc = helpers::create_doc(&pool, workspace, actor).await;
  let suffix = Uuid::new_v4().simple().to_string();
  let function = format!("dnot_fail_{suffix}");
  let trigger = format!("dnot_trigger_{suffix}");
  sqlx::query(&format!("CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'authorId'='{actor}' THEN RAISE EXCEPTION 'owned comment intent failure'; END IF; RETURN NEW; END $$"))
    .execute(&pool).await.expect("owned failure function");
  sqlx::query(&format!(
    "CREATE TRIGGER {trigger} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION {function}()"
  ))
  .execute(&pool)
  .await
  .expect("owned failure trigger");
  let outcome = std::panic::AssertUnwindSafe(async {
    let response = graphql(&app, session, json!({
      "query":"mutation($ws:String!,$doc:String!,$body:JSON!){createComment(workspaceId:$ws,docId:$doc,body:$body){id}}",
      "variables":{"ws":workspace,"doc":doc,"body":{"snapshot":{"blocks":{"props":{"text":{"delta":[{"insert":"mention","attributes":{"mention":{"member":recipient}}}]}},"children":[]}}}}
    })).await;
    assert!(response.get("errors").is_some(),"failed intent must fail creation: {response}");
    let comments:i64=sqlx::query_scalar("SELECT count(*) FROM comments WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&pool).await.unwrap();
    let intents:i64=sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE payload->>'workspaceId'=$1")
      .bind(workspace.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!((comments,intents),(0,0));
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER {trigger} ON outbox_events"))
    .execute(&pool)
    .await
    .expect("trigger cleanup");
  sqlx::query(&format!("DROP FUNCTION {function}()"))
    .execute(&pool)
    .await
    .expect("function cleanup");
  helpers::cleanup_users(&pool, &[actor, recipient]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
