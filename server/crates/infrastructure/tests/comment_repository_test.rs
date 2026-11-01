//! Integration tests for the SQLx comment repository (create, list, delete).
use chrono::{Duration, Utc};
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use myoxus_application::comment::CommentStore as ApplicationCommentStore;
use myoxus_domain::entities::Comment;
use myoxus_domain::repositories::{CommentRepository, PageRequest, RepositoryError};
use myoxus_infrastructure::comment::SqlxCommentRepository;

async fn setup_pool() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable for comment repository tests");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

async fn seed_workspace_doc_user(pool: &PgPool) -> (Uuid, Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("comment-user-{user_id}@example.test"))
    .bind("Comment User")
    .execute(pool)
    .await
    .expect("seed user");

  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace_id)
    .bind(user_id)
    .bind("Comment Workspace")
    .execute(pool)
    .await
    .expect("seed workspace");

  sqlx::query(
        "INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by) VALUES ($1, $2, $3, false, $4, $4)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind("Comment Doc")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("seed doc");

  (user_id, workspace_id, doc_id)
}

#[tokio::test]
async fn comment_repository_supports_root_reply_update_resolve_and_list() {
  let pool = setup_pool().await;
  let (author_id, workspace_id, doc_id) = seed_workspace_doc_user(&pool).await;
  let repo = SqlxCommentRepository::new(pool);
  let now = Utc::now();

  let root = CommentRepository::create_comment(
    &repo,
    &Comment {
      id: Uuid::new_v4(),
      workspace_id,
      doc_id,
      parent_comment_id: None,
      author_id,
      body: json!({"text":"root"}),
      resolved: false,
      created_at: now,
      updated_at: now,
      deleted_at: None,
    },
  )
  .await
  .expect("root comment should be created");

  let reply = CommentRepository::create_comment(
    &repo,
    &Comment {
      id: Uuid::new_v4(),
      workspace_id,
      doc_id,
      parent_comment_id: Some(root.id),
      author_id,
      body: json!({"text":"reply"}),
      resolved: false,
      created_at: now + Duration::seconds(1),
      updated_at: now + Duration::seconds(1),
      deleted_at: None,
    },
  )
  .await
  .expect("reply should be created");
  assert_eq!(reply.parent_comment_id, Some(root.id));

  let edited = CommentRepository::update_comment_body(
    &repo,
    reply.id,
    json!({"text":"reply edited"}),
    now + Duration::seconds(2),
  )
  .await
  .expect("reply should be editable");
  assert_eq!(edited.body["text"], "reply edited");

  let resolved = CommentRepository::resolve_comment(&repo, root.id, true, now + Duration::seconds(3))
    .await
    .expect("root should be resolvable");
  assert!(resolved.resolved);

  let comments = CommentRepository::list_comments_for_doc(&repo, doc_id, PageRequest { limit: 10, offset: 0 })
    .await
    .expect("comment list should succeed");
  assert_eq!(comments.len(), 2);
  assert_eq!(comments[0].id, root.id);
  assert_eq!(comments[1].id, reply.id);
}

#[tokio::test]
async fn comment_repository_rejects_cross_doc_parent_and_hides_soft_deleted_comments() {
  let pool = setup_pool().await;
  let (author_id, workspace_id, doc_id) = seed_workspace_doc_user(&pool).await;
  let (_other_author, other_workspace_id, other_doc_id) = seed_workspace_doc_user(&pool).await;
  let repo = SqlxCommentRepository::new(pool);
  let now = Utc::now();

  let foreign_parent = CommentRepository::create_comment(
    &repo,
    &Comment {
      id: Uuid::new_v4(),
      workspace_id: other_workspace_id,
      doc_id: other_doc_id,
      parent_comment_id: None,
      author_id,
      body: json!({"text":"foreign root"}),
      resolved: false,
      created_at: now,
      updated_at: now,
      deleted_at: None,
    },
  )
  .await
  .expect("foreign root should be created");

  let invalid_reply = CommentRepository::create_comment(
    &repo,
    &Comment {
      id: Uuid::new_v4(),
      workspace_id,
      doc_id,
      parent_comment_id: Some(foreign_parent.id),
      author_id,
      body: json!({"text":"invalid reply"}),
      resolved: false,
      created_at: now,
      updated_at: now,
      deleted_at: None,
    },
  )
  .await;
  assert!(
    matches!(invalid_reply, Err(RepositoryError::Validation(_))),
    "cross-doc reply must be rejected with validation error"
  );

  let live_comment = CommentRepository::create_comment(
    &repo,
    &Comment {
      id: Uuid::new_v4(),
      workspace_id,
      doc_id,
      parent_comment_id: None,
      author_id,
      body: json!({"text":"to be deleted"}),
      resolved: false,
      created_at: now,
      updated_at: now,
      deleted_at: None,
    },
  )
  .await
  .expect("live comment should be created");

  CommentRepository::soft_delete_comment(&repo, live_comment.id, now + Duration::seconds(10))
    .await
    .expect("soft delete should succeed");
  CommentRepository::soft_delete_comment(&repo, live_comment.id, now + Duration::seconds(15))
    .await
    .expect("soft delete should be idempotent");

  let comments = CommentRepository::list_comments_for_doc(&repo, doc_id, PageRequest { limit: 10, offset: 0 })
    .await
    .expect("comment list should succeed");
  assert!(
    comments.iter().all(|c| c.id != live_comment.id),
    "soft deleted comments must be hidden from active list"
  );
}

#[tokio::test]
async fn comment_application_store_persists_audit_fields_for_update_resolve_delete() {
  let pool = setup_pool().await;
  let (author_id, workspace_id, doc_id) = seed_workspace_doc_user(&pool).await;
  let (editor_id, _, _) = seed_workspace_doc_user(&pool).await;
  let (resolver_id, _, _) = seed_workspace_doc_user(&pool).await;
  let (deleter_id, _, _) = seed_workspace_doc_user(&pool).await;
  let repo = SqlxCommentRepository::new(pool.clone());
  let now = Utc::now();

  let created = ApplicationCommentStore::create_comment(
    &repo,
    myoxus_application::comment::NewComment {
      workspace_id,
      doc_id,
      parent_comment_id: None,
      author_id,
      body: json!({"text":"audit"}),
      now,
      notification_intents: Vec::new(),
    },
  )
  .await
  .expect("create via application store");

  let _updated = ApplicationCommentStore::update_comment_body(
    &repo,
    created.id,
    json!({"text":"audit edited"}),
    editor_id,
    now + Duration::seconds(1),
  )
  .await
  .expect("update via application store");

  let _resolved =
    ApplicationCommentStore::set_comment_resolved(&repo, created.id, true, resolver_id, now + Duration::seconds(2))
      .await
      .expect("resolve via application store");

  let deleted = ApplicationCommentStore::soft_delete_comment(&repo, created.id, deleter_id, now + Duration::seconds(3))
    .await
    .expect("delete via application store");
  assert!(deleted);

  let row = sqlx::query("SELECT last_edited_by, resolved_by, resolved_at, deleted_by FROM comments WHERE id = $1")
    .bind(created.id)
    .fetch_one(&pool)
    .await
    .expect("query audit fields");

  let last_edited_by: Option<Uuid> = row.get("last_edited_by");
  let resolved_by: Option<Uuid> = row.get("resolved_by");
  let resolved_at: Option<chrono::DateTime<Utc>> = row.get("resolved_at");
  let deleted_by: Option<Uuid> = row.get("deleted_by");

  assert_eq!(last_edited_by, Some(editor_id));
  assert_eq!(resolved_by, Some(resolver_id));
  assert!(resolved_at.is_some());
  assert_eq!(deleted_by, Some(deleter_id));

  let history_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comment_edit_history WHERE comment_id = $1")
    .bind(created.id)
    .fetch_one(&pool)
    .await
    .expect("history count query");
  assert_eq!(history_count, 1);
}

#[tokio::test]
async fn comment_application_store_persists_selection_anchor() {
  let pool = setup_pool().await;
  let (author_id, workspace_id, doc_id) = seed_workspace_doc_user(&pool).await;
  let repo = SqlxCommentRepository::new(pool.clone());
  let now = Utc::now();

  let created = ApplicationCommentStore::create_comment(
    &repo,
    myoxus_application::comment::NewComment {
      workspace_id,
      doc_id,
      parent_comment_id: None,
      author_id,
      body: json!({"text":"anchor comment"}),
      now,
      notification_intents: Vec::new(),
    },
  )
  .await
  .expect("create via application store");

  ApplicationCommentStore::upsert_comment_anchor(
    &repo,
    created.id,
    json!({
        "quote": "selected quote",
        "start": 11,
        "end": 25,
        "strategy": "nearby_quote_search"
    }),
    author_id,
    now + Duration::seconds(1),
  )
  .await
  .expect("anchor upsert should succeed");

  let anchor = ApplicationCommentStore::get_comment_anchor(&repo, created.id)
    .await
    .expect("anchor read should succeed")
    .expect("anchor should exist");
  assert_eq!(anchor["quote"], "selected quote");
  assert_eq!(anchor["start"], 11);
  assert_eq!(anchor["end"], 25);
}
