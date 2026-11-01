// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable comment delivery from the GraphQL producer through the shared worker
//! consumer, SQL idempotency and current recipient authorization.

use crate::helpers;

use std::sync::Arc;

use futures_util::FutureExt;
use myoxus_api::comment_notification::{dispatch_comment_notification, enqueue_comment_notification};
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::AdminService;
use myoxus_application::auth::AuthService;
use myoxus_application::comment::{AuthStoreCommentAdapter, CommentService};
use myoxus_application::doc::DocService;
use myoxus_application::notification::NotificationService;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::comment::SqlxCommentRepository;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::notification::SqlxNotificationRepository;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_worker::{RedisQueue, TerminalRetentionPolicy};
use serde_json::json;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Test-specific state setup: uses real DB-backed notification + comment stores
// ---------------------------------------------------------------------------

pub(crate) async fn setup_app_with_real_notifications() -> (axum::Router, sqlx::PgPool, Arc<SqlxAuthStore>, ApiState) {
  setup_app_with_notification_pool(helpers::setup_pool().await).await
}

/// The caller migrates its pool through the authoritative runner. Global SQL
/// drains use SQLx-owned databases so controlled time cannot claim other fixtures.
pub(crate) async fn setup_app_with_notification_pool(
  pool: sqlx::PgPool,
) -> (axum::Router, sqlx::PgPool, Arc<SqlxAuthStore>, ApiState) {
  let config = AppConfig::load().expect("config must load");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));

  let auth_service = AuthService::new(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );

  // Real DB-backed notification store
  let notification_repo = Arc::new(SqlxNotificationRepository::new(pool.clone()));
  let notification_service = Arc::new(NotificationService::new(notification_repo));

  // Real DB-backed comment repository + ACL adapter wired to the auth store
  let comment_repo = Arc::new(SqlxCommentRepository::new(pool.clone()));
  let auth_adapter = Arc::new(AuthStoreCommentAdapter::new(auth_store.clone()));
  let comment_service = Arc::new(CommentService::new_with_mentions(
    comment_repo,
    auth_adapter.clone(),
    auth_adapter,
  ));

  let workspace_service = WorkspaceService::new(workspace_store.clone());
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);

  let state = ApiState::with_services_and_comment(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    comment_service,
    notification_service,
    blob_service,
    storage,
  )
  .with_metrics_pool(pool.clone());

  (build_router(state.clone()), pool, auth_store, state)
}

async fn create(
  app: &axum::Router,
  session: Uuid,
  workspace: Uuid,
  doc: &str,
  parent: Option<Uuid>,
  body: serde_json::Value,
) -> serde_json::Value {
  helpers::gql(app, session, json!({
    "query": "mutation($ws:String!,$doc:String!,$parent:String,$body:JSON!){createComment(workspaceId:$ws,docId:$doc,parentCommentId:$parent,body:$body){id}}",
    "variables": {"ws":workspace,"doc":doc,"parent":parent,"body":body}
  })).await
}

#[tokio::test]
async fn inv_comment_mention_triggers_notification_row() {
  let (app, pool, auth_store, state) = setup_app_with_real_notifications().await;
  let (author, author_session) = helpers::seed_user(&pool, &auth_store, "cmnt_author").await;
  let (recipient, recipient_session) = helpers::seed_user(&pool, &auth_store, "cmnt_recipient").await;
  let workspace = helpers::create_workspace(&pool, author).await;
  helpers::add_workspace_member(&pool, workspace, recipient).await;
  let doc = helpers::create_doc(&pool, workspace, author).await;
  let other_doc = helpers::create_doc(&pool, workspace, author).await;
  // A UUID-shaped external key must never be confused with an internal ID.
  let external = Uuid::new_v4().to_string();
  sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
    .bind(doc)
    .bind(&external)
    .execute(&pool)
    .await
    .expect("external key fixture");
  let redis_url = std::env::var("TEST_REDIS_URL").expect("isolated Redis URL");
  let prefix = format!("dnot-comment-{}", Uuid::new_v4());
  let queue = RedisQueue::new(&redis_url, prefix.clone()).expect("queue");
  let retention = TerminalRetentionPolicy {
    remove_on_complete: false,
    ..Default::default()
  };
  let outcome = std::panic::AssertUnwindSafe(async {
    let root = create(
      &app,
      recipient_session,
      workspace,
      &external,
      None,
      json!({"text":"parent"}),
    )
    .await;
    assert!(root.get("errors").is_none(), "{root}");
    let parent: Uuid = root["data"]["createComment"]["id"].as_str().unwrap().parse().unwrap();
    let reply = create(
      &app,
      author_session,
      workspace,
      &external,
      Some(parent),
      json!({
        "snapshot":{"blocks":{"props":{"type":"text","text":{"delta":[
          {"insert":"mention","attributes":{"mention":{"member":recipient}}},
          {"insert":"self","attributes":{"mention":{"member":author}}}
        ]}},"children":[]}}
      }),
    )
    .await;
    assert!(reply.get("errors").is_none(), "{reply}");
    let comment: Uuid = reply["data"]["createComment"]["id"].as_str().unwrap().parse().unwrap();
    let intents: Vec<serde_json::Value> = sqlx::query_scalar("SELECT payload FROM outbox_events WHERE aggregate_id=$1")
      .bind(comment.to_string())
      .fetch_all(&pool)
      .await
      .expect("intent");
    assert_eq!(
      intents.len(),
      1,
      "reply + member mention must be one union intent, without self"
    );
    assert_eq!(intents[0]["userId"], recipient.to_string());
    assert_eq!(intents[0]["notificationType"], "comment_mention");
    let data = &intents[0];
    let unavailable_queue = RedisQueue::new("redis://127.0.0.1:1", "owned-unavailable").unwrap();
    assert!(enqueue_comment_notification(&pool, &unavailable_queue, &state, data).await.is_err());
    let pending: bool = sqlx::query_scalar("SELECT processed_at IS NULL FROM outbox_events WHERE aggregate_id=$1")
      .bind(comment.to_string()).fetch_one(&pool).await.unwrap();
    assert!(pending, "enqueue failure keeps durable intent pending");
    enqueue_comment_notification(&pool, &queue, &state, data)
      .await
      .expect("handoff");
    enqueue_comment_notification(&pool, &queue, &state, data)
      .await
      .expect("repeated handoff");
    assert_eq!(queue.queue_stats("notification").await.unwrap().waiting, 1);
    let job = queue.dequeue("notification", 1).await.unwrap().expect("stable job");
    let delivered = dispatch_comment_notification(&state, &job.data)
      .await
      .unwrap()
      .expect("notification");
    let repeated = dispatch_comment_notification(&state, &job.data).await.unwrap().unwrap();
    assert_eq!(delivered.id, repeated.id);
    queue
      .ack(
        "notification",
        &job.id,
        Some(json!({"notificationId":delivered.id})),
        retention,
      )
      .await
      .unwrap();
    // SQL event-completion failure leaves the event pending after Redis finishes.
    enqueue_comment_notification(&pool, &queue, &state, data)
      .await
      .expect("persisted-outcome reconciliation");
    assert_eq!(queue.queue_stats("notification").await.unwrap().waiting, 0);
    let count: i64 =
      sqlx::query_scalar("SELECT count(*) FROM notifications WHERE user_id=$1 AND payload->>'commentId'=$2")
        .bind(recipient)
        .bind(comment.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let legacy_key = format!("mention:{recipient}:{doc}:{comment}:{author}");
    sqlx::query("INSERT INTO notifications(id,user_id,notification_type,notification_level,idempotency_key,payload,read_at,created_at,updated_at) VALUES($1,$2,'mention','default',$3,$4,now(),now(),now())")
      .bind(Uuid::new_v4()).bind(recipient).bind(legacy_key).bind(data)
      .execute(&pool).await.expect("known pending duplicate");
    let legacy = json!({"workspaceId":workspace,"commentId":comment,"docId":doc,
      "authorId":author,"mentionedUserId":recipient});
    let adopted = dispatch_comment_notification(&state,&legacy).await.unwrap().unwrap();
    assert_eq!(adopted.id,delivered.id,"adoption retains the canonical ID");
    assert!(adopted.read_at.is_some(),"reading an old duplicate preserves read state");
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM notifications WHERE user_id=$1 AND payload->>'commentId'=$2")
      .bind(recipient).bind(comment.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(count,1,"only this known pending duplicate is merged");
    let projected = helpers::gql(
      &app,
      recipient_session,
      json!({"query":"query{currentUser{notifications(pagination:{first:20},filter:{includeRead:true}){edges{node{type body}}}}}"}),
    )
    .await;
    assert!(projected.get("errors").is_none(), "{projected}");
    let node = &projected["data"]["currentUser"]["notifications"]["edges"][0]["node"];
    assert_eq!(node["type"], "CommentMention");
    assert_eq!(node["body"]["doc"]["id"], external);
    assert_eq!(node["body"]["commentId"], comment.to_string());
    assert!(node["body"]["createdByUser"]["name"].is_string());
    let invalid = create(
      &app,
      author_session,
      workspace,
      &other_doc.to_string(),
      Some(parent),
      json!({"text":"invalid"}),
    )
    .await;
    assert!(invalid.get("errors").is_some(), "cross-document parent must fail");
    let own = create(
      &app,
      recipient_session,
      workspace,
      &external,
      Some(parent),
      json!({"text":"own"}),
    )
    .await;
    assert!(own.get("errors").is_none(), "{own}");
    let own_id = own["data"]["createComment"]["id"].as_str().unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1")
      .bind(own_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(count, 0, "self reply has no intent");
    let plain = create(
      &app,
      author_session,
      workspace,
      &external,
      Some(parent),
      json!({"text":"reply"}),
    )
    .await;
    assert!(plain.get("errors").is_none(), "{plain}");
    let plain_id = plain["data"]["createComment"]["id"].as_str().unwrap();
    let data: serde_json::Value = sqlx::query_scalar("SELECT payload FROM outbox_events WHERE aggregate_id=$1")
      .bind(plain_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(data["notificationType"], "comment_reply");
    enqueue_comment_notification(&pool, &queue, &state, &data)
      .await
      .unwrap();
    // Revocation before dispatch suppresses, and after dispatch redacts the target.
    sqlx::query("UPDATE docs SET blocked=TRUE WHERE id=$1")
      .bind(doc)
      .execute(&pool)
      .await
      .unwrap();
    let job = queue.dequeue("notification", 1).await.unwrap().unwrap();
    assert!(
      dispatch_comment_notification(&state, &job.data)
        .await
        .unwrap()
        .is_none()
    );
    queue
      .ack("notification", &job.id, Some(json!({"suppressed":true})), retention)
      .await
      .unwrap();
    enqueue_comment_notification(&pool, &queue, &state, &data)
      .await
      .expect("completed suppression reconciles");
    assert_eq!(queue.queue_stats("notification").await.unwrap().waiting, 0);
    let unavailable = helpers::gql(
      &app,
      recipient_session,
      json!({"query":"query{currentUser{notifications(pagination:{first:20},filter:{includeRead:true}){edges{node{body}}}}}"}),
    )
    .await;
    assert!(unavailable.get("errors").is_none(), "{unavailable}");
    let body = &unavailable["data"]["currentUser"]["notifications"]["edges"][0]["node"]["body"];
    assert!(body["doc"].is_null());
    assert!(body["createdByUser"].is_null());
  })
  .catch_unwind()
  .await;
  let client = redis::Client::open(redis_url).unwrap();
  let mut connection = client.get_multiplexed_async_connection().await.unwrap();
  let keys: Vec<String> = redis::cmd("KEYS")
    .arg(format!("{prefix}:*"))
    .query_async(&mut connection)
    .await
    .unwrap();
  if !keys.is_empty() {
    let _: u64 = redis::cmd("UNLINK")
      .arg(keys)
      .query_async(&mut connection)
      .await
      .unwrap();
  }
  sqlx::query("DELETE FROM outbox_events WHERE payload->>'workspaceId'=$1")
    .bind(workspace.to_string())
    .execute(&pool)
    .await
    .expect("outbox cleanup");
  helpers::cleanup_users(&pool, &[author, recipient]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=ANY($1)")
    .bind(&[author, recipient] as &[Uuid])
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(remaining, 0, "fixture cleanup");
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
