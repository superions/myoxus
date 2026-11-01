//! Integration tests for the SQLx Copilot repository (sessions, messages, context).
use chrono::{Duration, Utc};
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use myoxus_domain::entities::{
  CopilotMessage, CopilotMessageRole, CopilotSession, CopilotToolCall, CopilotToolCallStatus,
};
use myoxus_domain::repositories::{CopilotRepository, PageRequest};
use myoxus_infrastructure::copilot::SqlxCopilotRepository;

async fn setup_pool() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable for copilot repository tests");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

async fn seed_user(pool: &PgPool) -> Uuid {
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("copilot-user-{user_id}@example.test"))
    .bind("Copilot User")
    .execute(pool)
    .await
    .expect("seed user");
  user_id
}

#[tokio::test]
async fn copilot_repository_persists_message_revisions_and_hides_internal_extension_keys() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;
  let repo = SqlxCopilotRepository::new(pool.clone());
  let now = Utc::now();

  let session = CopilotSession {
    id: Uuid::new_v4(),
    user_id,
    workspace_id: None,
    doc_id: None,
    title: Some("Revision Session".to_string()),
    model: Some("test-model".to_string()),
    pinned: false,
    archived_at: None,
    deleted_at: None,
    metadata: json!({}),
    created_at: now,
    updated_at: now,
  };
  CopilotRepository::create_copilot_session(&repo, &session)
    .await
    .expect("create session");

  let message_id = Uuid::new_v4();
  let tool_call = CopilotToolCall {
    id: Uuid::new_v4(),
    message_id,
    tool_name: "searchDocs".to_string(),
    args: json!({"q":"legacy"}),
    status: CopilotToolCallStatus::Queued,
    result: None,
    error: None,
    started_at: None,
    finished_at: None,
    created_at: now,
    updated_at: now,
  };
  let message = CopilotMessage {
    id: message_id,
    session_id: session.id,
    role: CopilotMessageRole::User,
    content: json!({"text":"before edit"}),
    token_usage: Some(json!({"sequence":1})),
    tool_calls: vec![tool_call],
    attachment_refs: Vec::new(),
    edited_at: None,
    created_at: now,
  };
  CopilotRepository::append_copilot_message(&repo, &message)
    .await
    .expect("append message");

  let mut updated = message.clone();
  CopilotRepository::append_copilot_message_revision(&repo, message_id, &updated)
    .await
    .expect("append revision");

  updated.content = json!({"text":"after edit"});
  updated.edited_at = Some(now + Duration::seconds(1));
  CopilotRepository::update_copilot_message(&repo, &updated)
    .await
    .expect("update message");

  let revisions =
    CopilotRepository::list_copilot_message_revisions(&repo, message_id, PageRequest { limit: 10, offset: 0 })
      .await
      .expect("list revisions");
  assert_eq!(revisions.len(), 1);
  assert_eq!(revisions[0].content["text"], "before edit");
  assert_eq!(revisions[0].tool_calls.len(), 1);
  assert!(revisions[0].content.get("__toolCalls").is_none());

  let fetched = CopilotRepository::get_copilot_message(&repo, message_id)
    .await
    .expect("get message")
    .expect("message exists");
  assert_eq!(fetched.content["text"], "after edit");
  assert_eq!(fetched.tool_calls.len(), 1);
  assert!(fetched.content.get("__toolCalls").is_none());

  let revision_rows = sqlx::query("SELECT COUNT(*) AS count FROM copilot_message_revisions WHERE message_id = $1")
    .bind(message_id)
    .fetch_one(&pool)
    .await
    .expect("count revisions");
  assert_eq!(revision_rows.get::<i64, _>("count"), 1);
}

#[tokio::test]
async fn copilot_repository_delete_session_soft_deletes_session_and_removes_messages() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;
  let repo = SqlxCopilotRepository::new(pool.clone());
  let now = Utc::now();

  let session = CopilotSession {
    id: Uuid::new_v4(),
    user_id,
    workspace_id: None,
    doc_id: None,
    title: Some("Cleanup Session".to_string()),
    model: Some("test-model".to_string()),
    pinned: true,
    archived_at: None,
    deleted_at: None,
    metadata: json!({"x":1}),
    created_at: now,
    updated_at: now,
  };
  CopilotRepository::create_copilot_session(&repo, &session)
    .await
    .expect("create session");

  let message = CopilotMessage {
    id: Uuid::new_v4(),
    session_id: session.id,
    role: CopilotMessageRole::User,
    content: json!({"text":"to-delete"}),
    token_usage: None,
    tool_calls: Vec::new(),
    attachment_refs: Vec::new(),
    edited_at: None,
    created_at: now,
  };
  CopilotRepository::append_copilot_message(&repo, &message)
    .await
    .expect("append message");

  CopilotRepository::delete_copilot_session(&repo, session.id, now + Duration::seconds(2))
    .await
    .expect("delete session");

  let stored = CopilotRepository::get_copilot_session(&repo, session.id)
    .await
    .expect("get session")
    .expect("session row still exists");
  assert!(stored.deleted_at.is_some());
  assert!(!stored.pinned);

  let listed = CopilotRepository::list_copilot_sessions(
    &repo,
    user_id,
    &myoxus_domain::entities::CopilotSessionFilter {
      include_archived: true,
      ..Default::default()
    },
    PageRequest { limit: 20, offset: 0 },
  )
  .await
  .expect("list sessions");
  assert!(listed.sessions.iter().all(|s| s.id != session.id));

  let messages = CopilotRepository::list_copilot_messages(&repo, session.id, PageRequest { limit: 20, offset: 0 })
    .await
    .expect("list messages");
  assert!(messages.is_empty());
}
