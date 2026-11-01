//! SQLx-backed comment repository and comment store implementations.
//!
//! [`SqlxCommentRepository`] implements the [`CommentRepository`] domain trait
//! for threaded document comments. It also implements the application-layer
//! `CommentStore` port used by comment-related services, providing CRUD
//! operations with pagination and soft-delete support.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::{error, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::comment::{
  CommentNotificationKind, CommentStore as ApplicationCommentStore, CommentThreadFilter, NewComment,
};
use myoxus_domain::entities::Comment;
use myoxus_domain::ids::{CommentId, DocId};
use myoxus_domain::repositories::{CommentRepository, PageRequest, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`CommentRepository`] and
/// [`ApplicationCommentStore`].
pub struct SqlxCommentRepository {
  /// Database connection pool.
  pool: PgPool,
}

struct NewCommentRow {
  id: Uuid,
  workspace_id: Uuid,
  doc_id: Uuid,
  parent_comment_id: Option<Uuid>,
  author_id: Uuid,
  body: serde_json::Value,
  now: DateTime<Utc>,
}

impl SqlxCommentRepository {
  /// Construct a `SqlxCommentRepository` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in comment repository");
    RepositoryError::Storage(err.to_string())
  }

  fn map_db_err_auth(err: sqlx::Error) -> AuthError {
    error!(error = %err, "database error in comment store");
    AuthError::Storage(err.to_string())
  }

  fn map_comment_row(row: sqlx::postgres::PgRow) -> Comment {
    Comment {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      parent_comment_id: row.get("parent_comment_id"),
      author_id: row.get("author_id"),
      body: row.get("body"),
      resolved: row.get("resolved"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      deleted_at: row.get("deleted_at"),
    }
  }

  async fn insert_comment_row<'a>(
    executor: impl sqlx::PgExecutor<'a>,
    row: NewCommentRow,
  ) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query(
            r#"
            INSERT INTO comments (id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at)
            SELECT $1, $2, $3, $4, $5, $6, false, $7, $7, NULL
            WHERE $4 IS NULL OR EXISTS (
                SELECT 1
                FROM comments parent
                WHERE parent.id = $4
                  AND parent.workspace_id = $2
                  AND parent.doc_id = $3
                  AND parent.deleted_at IS NULL
            )
            RETURNING id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            "#
        )
    .bind(row.id)
    .bind(row.workspace_id)
    .bind(row.doc_id)
    .bind(row.parent_comment_id)
    .bind(row.author_id)
    .bind(row.body)
    .bind(row.now)
        .fetch_optional(executor)
        .await
  }
}

#[async_trait]
impl CommentRepository for SqlxCommentRepository {
  /// Insert a new comment row (domain-layer variant).
  #[instrument(skip(self, comment))]
  async fn create_comment(&self, comment: &Comment) -> RepoResult<Comment> {
    let row = Self::insert_comment_row(
      &self.pool,
      NewCommentRow {
        id: comment.id,
        workspace_id: comment.workspace_id,
        doc_id: comment.doc_id,
        parent_comment_id: comment.parent_comment_id,
        author_id: comment.author_id,
        body: comment.body.clone(),
        now: comment.created_at,
      },
    )
    .await
    .map_err(Self::map_db_err)?;

    let Some(row) = row else {
      warn!(
          comment_id = %comment.id,
          doc_id = %comment.doc_id,
          workspace_id = %comment.workspace_id,
          parent_comment_id = ?comment.parent_comment_id,
          "comment create rejected due to invalid parent linkage"
      );
      return Err(RepositoryError::Validation(
        "invalid parent comment reference".to_string(),
      ));
    };
    Ok(Self::map_comment_row(row))
  }

  /// Update a comment's body text (domain-layer variant).
  #[instrument(skip(self, body))]
  async fn update_comment_body(
    &self,
    comment_id: CommentId,
    body: serde_json::Value,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<Comment> {
    let row = sqlx::query(
            r#"
            UPDATE comments
            SET body = $2, updated_at = $3
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            "#
        )
        .bind(comment_id)
        .bind(body)
        .bind(updated_at)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    row
      .map(Self::map_comment_row)
      .ok_or(RepositoryError::NotFound("comment"))
  }

  /// Set the resolved/unresolved state of a comment thread.
  #[instrument(skip(self))]
  async fn resolve_comment(
    &self,
    comment_id: CommentId,
    resolved: bool,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<Comment> {
    let row = sqlx::query(
            r#"
            UPDATE comments
            SET resolved = $2, updated_at = $3
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            "#
        )
        .bind(comment_id)
        .bind(resolved)
        .bind(updated_at)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    row
      .map(Self::map_comment_row)
      .ok_or(RepositoryError::NotFound("comment"))
  }

  /// Soft-delete a comment (domain-layer variant).
  #[instrument(skip(self))]
  async fn soft_delete_comment(&self, comment_id: CommentId, deleted_at: DateTime<Utc>) -> RepoResult<()> {
    let result = sqlx::query(
      r#"
            UPDATE comments
            SET deleted_at = COALESCE(deleted_at, $2), updated_at = GREATEST(updated_at, $2)
            WHERE id = $1
            "#,
    )
    .bind(comment_id)
    .bind(deleted_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("comment"));
    }
    Ok(())
  }

  /// List comments for a document with offset-based pagination.
  #[instrument(skip(self))]
  async fn list_comments_for_doc(&self, doc_id: DocId, page: PageRequest) -> RepoResult<Vec<Comment>> {
    let rows = sqlx::query(
            r#"
            SELECT id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            FROM comments
            WHERE doc_id = $1 AND deleted_at IS NULL
            ORDER BY created_at ASC
            LIMIT $2
            OFFSET $3
            "#
        )
        .bind(doc_id)
        .bind(page.limit)
        .bind(page.offset)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_comment_row).collect())
  }
}

#[async_trait]
impl ApplicationCommentStore for SqlxCommentRepository {
  /// The outbox and comment share a transaction; no notification can escape
  /// a failed insertion, and no committed comment can lose its intent.
  #[instrument(skip(self, input))]
  async fn create_comment(&self, input: NewComment) -> AuthResult<Comment> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err_auth)?;
    let row = Self::insert_comment_row(
      &mut *tx,
      NewCommentRow {
        id: Uuid::new_v4(),
        workspace_id: input.workspace_id,
        doc_id: input.doc_id,
        parent_comment_id: input.parent_comment_id,
        author_id: input.author_id,
        body: input.body,
        now: input.now,
      },
    )
    .await
    .map_err(Self::map_db_err_auth)?;
    let Some(row) = row else {
      return Err(AuthError::InvalidInput("invalid parent comment reference".into()));
    };
    let comment = Self::map_comment_row(row);
    for intent in input.notification_intents {
      let event_type = match intent.kind {
        CommentNotificationKind::Mention => "mention",
        CommentNotificationKind::Reply => "comment_reply",
      };
      sqlx::query(
        "INSERT INTO outbox_events
        (id, aggregate_type, aggregate_id, event_type, payload, created_at, processed_at)
        VALUES ($1, 'comment', $2, $3, $4, $5, NULL)",
      )
      .bind(Uuid::new_v4())
      .bind(comment.id.to_string())
      .bind(event_type)
      .bind(intent.payload(&comment))
      .bind(input.now)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err_auth)?;
    }
    tx.commit().await.map_err(Self::map_db_err_auth)?;
    Ok(comment)
  }

  /// Fetch a single comment by ID, returning `None` when not found.
  #[instrument(skip(self))]
  async fn get_comment(&self, comment_id: Uuid) -> AuthResult<Option<Comment>> {
    let row = sqlx::query(
            r#"
            SELECT id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            FROM comments
            WHERE id = $1
            "#
        )
        .bind(comment_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err_auth)?;
    Ok(row.map(Self::map_comment_row))
  }

  /// Update a comment's body and record the edit history (application-layer).
  #[instrument(skip(self, body))]
  async fn update_comment_body(
    &self,
    comment_id: Uuid,
    body: serde_json::Value,
    edited_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<Comment> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err_auth)?;
    let previous = sqlx::query(
      r#"
            SELECT body
            FROM comments
            WHERE id = $1 AND deleted_at IS NULL
            FOR UPDATE
            "#,
    )
    .bind(comment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err_auth)?;
    let Some(previous) = previous else {
      return Err(AuthError::InvalidInput("comment not found".to_string()));
    };
    let previous_body: serde_json::Value = previous.get("body");
    sqlx::query("INSERT INTO comment_edit_history (comment_id, body, edited_by, edited_at) VALUES ($1, $2, $3, $4)")
      .bind(comment_id)
      .bind(previous_body)
      .bind(edited_by)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err_auth)?;

    let row = sqlx::query(
            r#"
            UPDATE comments
            SET body = $2, updated_at = $3, last_edited_by = $4
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            "#
        )
        .bind(comment_id)
        .bind(body)
        .bind(now)
        .bind(edited_by)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err_auth)?;
    tx.commit().await.map_err(Self::map_db_err_auth)?;
    Ok(Self::map_comment_row(row))
  }

  /// Mark a comment thread as resolved or unresolved.
  #[instrument(skip(self))]
  async fn set_comment_resolved(
    &self,
    comment_id: Uuid,
    resolved: bool,
    acted_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<Comment> {
    let row = sqlx::query(
            r#"
            UPDATE comments
            SET resolved = $2,
                updated_at = $3,
                resolved_by = CASE WHEN $2 THEN $4 ELSE NULL END,
                resolved_at = CASE WHEN $2 THEN $3 ELSE NULL END
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            "#
        )
        .bind(comment_id)
        .bind(resolved)
        .bind(now)
        .bind(acted_by)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err_auth)?;
    row
      .map(Self::map_comment_row)
      .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))
  }

  /// Soft-delete a comment (application-layer variant).  Returns `true` when
  /// a row was updated.
  #[instrument(skip(self))]
  async fn soft_delete_comment(&self, comment_id: Uuid, deleted_by: Uuid, now: DateTime<Utc>) -> AuthResult<bool> {
    let result = sqlx::query(
      r#"
            UPDATE comments
            SET deleted_at = COALESCE(deleted_at, $2),
                deleted_by = COALESCE(deleted_by, $3),
                updated_at = GREATEST(updated_at, $2)
            WHERE id = $1
            "#,
    )
    .bind(comment_id)
    .bind(now)
    .bind(deleted_by)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(result.rows_affected() > 0)
  }

  /// Upsert the text-selection anchor associated with a comment.
  #[instrument(skip(self, anchor))]
  async fn upsert_comment_anchor(
    &self,
    comment_id: Uuid,
    anchor: serde_json::Value,
    edited_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<()> {
    let result = sqlx::query(
      r#"
            UPDATE comments
            SET selection_anchor = $2,
                last_edited_by = $3,
                updated_at = $4
            WHERE id = $1 AND deleted_at IS NULL
            "#,
    )
    .bind(comment_id)
    .bind(anchor)
    .bind(edited_by)
    .bind(now)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    if result.rows_affected() == 0 {
      return Err(AuthError::InvalidInput("comment not found".to_string()));
    }
    Ok(())
  }

  /// Fetch the selection anchor JSON for a comment.
  #[instrument(skip(self))]
  async fn get_comment_anchor(&self, comment_id: Uuid) -> AuthResult<Option<serde_json::Value>> {
    let row = sqlx::query("SELECT selection_anchor FROM comments WHERE id = $1")
      .bind(comment_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err_auth)?;
    Ok(row.and_then(|row| row.get::<Option<serde_json::Value>, _>("selection_anchor")))
  }

  /// List comments for a document with filtered, stable offset pagination.
  #[instrument(skip(self))]
  async fn list_comments(
    &self,
    doc_id: Uuid,
    parent_comment_id: Option<Uuid>,
    skip: i64,
    take: i64,
    thread_filter: Option<(CommentThreadFilter, Uuid)>,
  ) -> AuthResult<Vec<Comment>> {
    let (filter, actor) = thread_filter
      .map(|(filter, actor)| {
        (
          match filter {
            CommentThreadFilter::All => "all",
            CommentThreadFilter::Open => "open",
            CommentThreadFilter::Resolved => "resolved",
            CommentThreadFilter::Mine => "mine",
          },
          Some(actor),
        )
      })
      .unwrap_or(("all", None));
    // Filter the same deterministic result set that OFFSET/LIMIT paginate.
    let rows = sqlx::query(
            r#"
            SELECT id, workspace_id, doc_id, parent_comment_id, author_id, body, resolved, created_at, updated_at, deleted_at
            FROM comments
            WHERE doc_id = $1
              AND (($2::uuid IS NULL AND parent_comment_id IS NULL) OR parent_comment_id = $2)
              AND deleted_at IS NULL
              AND ($5 = 'all' OR ($5 = 'open' AND NOT resolved)
                   OR ($5 = 'resolved' AND resolved) OR ($5 = 'mine' AND author_id = $6))
            ORDER BY created_at ASC, id ASC
            LIMIT $3
            OFFSET $4
            "#
        )
        .bind(doc_id)
        .bind(parent_comment_id)
        .bind(take)
        .bind(skip)
        .bind(filter)
        .bind(actor)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err_auth)?;
    Ok(rows.into_iter().map(Self::map_comment_row).collect())
  }

  /// List the edit history for a comment, ordered oldest-first with stable ties.
  #[instrument(skip(self))]
  async fn list_comment_edit_history(
    &self,
    comment_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<myoxus_application::comment::CommentEditHistoryEntry>> {
    let rows = sqlx::query(
      r#"
            SELECT id, comment_id, body, edited_by, edited_at
            FROM comment_edit_history
            WHERE comment_id = $1
            ORDER BY edited_at ASC, id ASC
            LIMIT $2
            OFFSET $3
            "#,
    )
    .bind(comment_id)
    .bind(take)
    .bind(skip)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(
      rows
        .into_iter()
        .map(|row| myoxus_application::comment::CommentEditHistoryEntry {
          id: row.get("id"),
          comment_id: row.get("comment_id"),
          body: row.get("body"),
          edited_by: row.get("edited_by"),
          edited_at: row.get("edited_at"),
        })
        .collect(),
    )
  }

  /// Record that a user has read a comment thread up to a given timestamp.
  #[instrument(skip(self))]
  async fn mark_comment_thread_read(
    &self,
    user_id: Uuid,
    thread_comment_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO comment_thread_read_state (user_id, thread_comment_id, read_at, updated_at)
            VALUES ($1, $2, $3, $3)
            ON CONFLICT (user_id, thread_comment_id)
            DO UPDATE SET read_at = EXCLUDED.read_at, updated_at = EXCLUDED.updated_at
            "#,
    )
    .bind(user_id)
    .bind(thread_comment_id)
    .bind(read_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn mark_all_comment_threads_read(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<i64> {
    let result = sqlx::query(
      r#"INSERT INTO comment_thread_read_state (user_id, thread_comment_id, read_at, updated_at)
         SELECT $1, id, $4, $4 FROM comments
         WHERE workspace_id=$2 AND doc_id=$3 AND parent_comment_id IS NULL AND deleted_at IS NULL
         ON CONFLICT (user_id, thread_comment_id)
         DO UPDATE SET read_at=EXCLUDED.read_at, updated_at=EXCLUDED.updated_at"#,
    )
    .bind(user_id)
    .bind(workspace_id)
    .bind(doc_id)
    .bind(read_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    i64::try_from(result.rows_affected()).map_err(|_| AuthError::Storage("comment read count overflow".into()))
  }

  /// Fetch the last-read timestamp for a comment thread, returning `None`
  /// when the user has not read it.
  #[instrument(skip(self))]
  async fn get_comment_thread_read_at(
    &self,
    user_id: Uuid,
    thread_comment_id: Uuid,
  ) -> AuthResult<Option<DateTime<Utc>>> {
    let row =
      sqlx::query("SELECT read_at FROM comment_thread_read_state WHERE user_id = $1 AND thread_comment_id = $2")
        .bind(user_id)
        .bind(thread_comment_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err_auth)?;
    Ok(row.map(|row| row.get("read_at")))
  }

  /// Batch-fetch read-at timestamps for multiple threads in a single query.
  #[instrument(skip(self))]
  async fn get_comment_threads_read_at(
    &self,
    user_id: Uuid,
    thread_comment_ids: &[Uuid],
  ) -> AuthResult<std::collections::HashMap<Uuid, DateTime<Utc>>> {
    use std::collections::HashMap;
    if thread_comment_ids.is_empty() {
      return Ok(HashMap::new());
    }
    let rows = sqlx::query(
      "SELECT thread_comment_id, read_at FROM comment_thread_read_state WHERE user_id = $1 AND thread_comment_id = ANY($2)",
    )
    .bind(user_id)
    .bind(thread_comment_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;

    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
      let tid: Uuid = row.get("thread_comment_id");
      let read_at: DateTime<Utc> = row.get("read_at");
      map.insert(tid, read_at);
    }
    Ok(map)
  }
}
