//! SQLx-backed Copilot repository implementation.
//!
//! [`SqlxCopilotRepository`] implements the [`CopilotRepository`] domain trait
//! against PostgreSQL. It manages AI assistant sessions, messages (with role
//! and tool-call payloads stored as JSONB), context items, attachment
//! references, scheduled jobs, and workspace-level Copilot state.

pub mod embedding_store;
pub mod exa;
pub mod openai_provider;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::entities::{
  CopilotAttachmentRef, CopilotContext, CopilotContextItem, CopilotContextItemType, CopilotJob, CopilotJobState,
  CopilotMessage, CopilotMessageRole, CopilotSession, CopilotSessionFilter, CopilotSessionFork, CopilotSessionPage,
  CopilotToolCall, CopilotWorkspaceState,
};
use myoxus_domain::repositories::{CopilotRepository, PageRequest, RepoResult, RepositoryError};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

/// PostgreSQL-backed implementation of [`CopilotRepository`].
pub struct SqlxCopilotRepository {
  /// Database connection pool.
  pool: PgPool,
}

impl SqlxCopilotRepository {
  /// Construct a `SqlxCopilotRepository` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    if crate::auth::is_terminal_account_error(&err) {
      return RepositoryError::NotFound("user");
    }
    error!(error = %err, "copilot repository database error");
    RepositoryError::Storage(err.to_string())
  }

  fn role_to_db(role: &CopilotMessageRole) -> &'static str {
    match role {
      CopilotMessageRole::System => "system",
      CopilotMessageRole::User => "user",
      CopilotMessageRole::Assistant => "assistant",
      CopilotMessageRole::Tool => "tool",
    }
  }

  fn role_from_db(value: &str) -> CopilotMessageRole {
    match value.to_ascii_lowercase().as_str() {
      "system" => CopilotMessageRole::System,
      "assistant" => CopilotMessageRole::Assistant,
      "tool" => CopilotMessageRole::Tool,
      _ => CopilotMessageRole::User,
    }
  }

  fn context_item_type_to_db(value: &CopilotContextItemType) -> &'static str {
    match value {
      CopilotContextItemType::Doc => "doc",
      CopilotContextItemType::File => "file",
      CopilotContextItemType::Blob => "blob",
      CopilotContextItemType::Category => "category",
      CopilotContextItemType::Tag => "tag",
      CopilotContextItemType::Collection => "collection",
      CopilotContextItemType::Workspace => "workspace",
      CopilotContextItemType::Unknown => "unknown",
    }
  }

  fn context_item_type_from_db(value: &str) -> CopilotContextItemType {
    match value.to_ascii_lowercase().as_str() {
      "doc" => CopilotContextItemType::Doc,
      "file" => CopilotContextItemType::File,
      "blob" => CopilotContextItemType::Blob,
      "category" => CopilotContextItemType::Category,
      "tag" => CopilotContextItemType::Tag,
      "collection" => CopilotContextItemType::Collection,
      "workspace" => CopilotContextItemType::Workspace,
      _ => CopilotContextItemType::Unknown,
    }
  }

  fn job_state_to_db(state: &CopilotJobState) -> &'static str {
    match state {
      CopilotJobState::Pending => "pending",
      CopilotJobState::Claimed => "claimed",
      CopilotJobState::Running => "running",
      CopilotJobState::Finished => "finished",
      CopilotJobState::Failed => "failed",
    }
  }

  fn job_state_from_db(value: &str) -> CopilotJobState {
    match value.to_ascii_lowercase().as_str() {
      "claimed" => CopilotJobState::Claimed,
      "running" => CopilotJobState::Running,
      "finished" => CopilotJobState::Finished,
      "failed" => CopilotJobState::Failed,
      _ => CopilotJobState::Pending,
    }
  }

  fn serialize_tool_call(tool_call: &CopilotToolCall) -> Value {
    json!({
      "id": tool_call.id,
      "messageId": tool_call.message_id,
      "toolName": tool_call.tool_name,
      "args": tool_call.args,
      "status": format!("{:?}", tool_call.status).to_ascii_lowercase(),
      "result": tool_call.result,
      "error": tool_call.error,
      "startedAt": tool_call.started_at,
      "finishedAt": tool_call.finished_at,
      "createdAt": tool_call.created_at,
      "updatedAt": tool_call.updated_at,
    })
  }

  fn deserialize_tool_call(value: &Value) -> Option<CopilotToolCall> {
    let obj = value.as_object()?;
    let status = match obj
      .get("status")
      .and_then(|v| v.as_str())
      .unwrap_or("queued")
      .to_ascii_lowercase()
      .as_str()
    {
      "running" => myoxus_domain::entities::CopilotToolCallStatus::Running,
      "completed" => myoxus_domain::entities::CopilotToolCallStatus::Completed,
      "failed" => myoxus_domain::entities::CopilotToolCallStatus::Failed,
      _ => myoxus_domain::entities::CopilotToolCallStatus::Queued,
    };
    Some(CopilotToolCall {
      id: Uuid::parse_str(obj.get("id")?.as_str()?).ok()?,
      message_id: Uuid::parse_str(obj.get("messageId")?.as_str()?).ok()?,
      tool_name: obj.get("toolName")?.as_str()?.to_string(),
      args: obj.get("args").cloned().unwrap_or_else(|| json!({})),
      status,
      result: obj.get("result").cloned(),
      error: obj.get("error").and_then(|v| v.as_str()).map(|s| s.to_string()),
      started_at: obj
        .get("startedAt")
        .and_then(|v| v.as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc)),
      finished_at: obj
        .get("finishedAt")
        .and_then(|v| v.as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc)),
      created_at: obj
        .get("createdAt")
        .and_then(|v| v.as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now),
      updated_at: obj
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now),
    })
  }

  fn serialize_attachment_ref(attachment_ref: &CopilotAttachmentRef) -> Value {
    json!({
      "id": attachment_ref.id,
      "messageId": attachment_ref.message_id,
      "blobKey": attachment_ref.blob_key,
      "fileName": attachment_ref.file_name,
      "mimeType": attachment_ref.mime_type,
      "sizeBytes": attachment_ref.size_bytes,
      "metadata": attachment_ref.metadata,
      "createdAt": attachment_ref.created_at,
    })
  }

  fn deserialize_attachment_ref(value: &Value) -> Option<CopilotAttachmentRef> {
    let obj = value.as_object()?;
    Some(CopilotAttachmentRef {
      id: Uuid::parse_str(obj.get("id")?.as_str()?).ok()?,
      message_id: Uuid::parse_str(obj.get("messageId")?.as_str()?).ok()?,
      blob_key: obj.get("blobKey")?.as_str()?.to_string(),
      file_name: obj.get("fileName").and_then(|v| v.as_str()).map(|s| s.to_string()),
      mime_type: obj.get("mimeType").and_then(|v| v.as_str()).map(|s| s.to_string()),
      size_bytes: obj.get("sizeBytes").and_then(|v| v.as_i64()),
      metadata: obj.get("metadata").cloned().unwrap_or_else(|| json!({})),
      created_at: obj
        .get("createdAt")
        .and_then(|v| v.as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now),
    })
  }

  fn inject_message_extensions(
    content: Value,
    tool_calls: &[CopilotToolCall],
    attachment_refs: &[CopilotAttachmentRef],
  ) -> Value {
    let mut object = match content {
      Value::Object(map) => map,
      other => {
        let mut map = Map::new();
        map.insert("value".to_string(), other);
        map
      }
    };
    object.insert(
      "__toolCalls".to_string(),
      Value::Array(tool_calls.iter().map(Self::serialize_tool_call).collect()),
    );
    object.insert(
      "__attachmentRefs".to_string(),
      Value::Array(attachment_refs.iter().map(Self::serialize_attachment_ref).collect()),
    );
    Value::Object(object)
  }

  fn revision_content(message: &CopilotMessage) -> Value {
    // Preserve deployed raw-string history exactly when no extension envelope
    // is needed. Claiming a retry must not rewrite its prior revision's shape.
    if !message.content.is_object() && message.tool_calls.is_empty() && message.attachment_refs.is_empty() {
      message.content.clone()
    } else {
      Self::inject_message_extensions(message.content.clone(), &message.tool_calls, &message.attachment_refs)
    }
  }

  fn strip_message_extensions(content: Value) -> Value {
    let Value::Object(mut object) = content else {
      return content;
    };
    object.remove("__toolCalls");
    object.remove("__attachmentRefs");
    // Extension envelopes wrap deployed raw-string messages in `value`.
    if object.len() == 1 && object.get("value").is_some_and(Value::is_string) {
      return object.remove("value").expect("checked value");
    }
    Value::Object(object)
  }

  fn extract_message_extensions(content: &Value) -> (Vec<CopilotToolCall>, Vec<CopilotAttachmentRef>) {
    let Some(obj) = content.as_object() else {
      return (Vec::new(), Vec::new());
    };
    let tool_calls = obj
      .get("__toolCalls")
      .and_then(|v| v.as_array())
      .map(|arr| arr.iter().filter_map(Self::deserialize_tool_call).collect())
      .unwrap_or_default();
    let attachment_refs = obj
      .get("__attachmentRefs")
      .and_then(|v| v.as_array())
      .map(|arr| arr.iter().filter_map(Self::deserialize_attachment_ref).collect())
      .unwrap_or_default();
    (tool_calls, attachment_refs)
  }

  fn map_session(row: sqlx::postgres::PgRow) -> CopilotSession {
    CopilotSession {
      id: row.get("id"),
      user_id: row.get("user_id"),
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      title: row.get("title"),
      model: row.get("model"),
      pinned: row.get("pinned"),
      archived_at: row.get("archived_at"),
      deleted_at: row.get("deleted_at"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  fn map_message(row: sqlx::postgres::PgRow) -> CopilotMessage {
    let content: Value = row.get("content");
    let (tool_calls, attachment_refs) = Self::extract_message_extensions(&content);
    CopilotMessage {
      id: row.get("id"),
      session_id: row.get("session_id"),
      role: Self::role_from_db(&row.get::<String, _>("role")),
      content: Self::strip_message_extensions(content),
      token_usage: row.get("token_usage"),
      tool_calls,
      attachment_refs,
      edited_at: row.get("edited_at"),
      created_at: row.get("created_at"),
    }
  }

  async fn insert_session(connection: &mut sqlx::PgConnection, session: &CopilotSession) -> RepoResult<()> {
    sqlx::query("INSERT INTO copilot_sessions (id, user_id, workspace_id, doc_id, title, model, pinned, archived_at, deleted_at, metadata, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
      .bind(session.id).bind(session.user_id).bind(session.workspace_id).bind(session.doc_id)
      .bind(&session.title).bind(&session.model).bind(session.pinned).bind(session.archived_at)
      .bind(session.deleted_at).bind(&session.metadata).bind(session.created_at).bind(session.updated_at)
      .execute(connection).await.map_err(Self::map_db_err)?;
    Ok(())
  }

  async fn insert_message(connection: &mut sqlx::PgConnection, message: &CopilotMessage) -> RepoResult<()> {
    let content =
      Self::inject_message_extensions(message.content.clone(), &message.tool_calls, &message.attachment_refs);
    sqlx::query("INSERT INTO copilot_messages (id,session_id,role,content,token_usage,edited_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)")
      .bind(message.id).bind(message.session_id).bind(Self::role_to_db(&message.role)).bind(content)
      .bind(&message.token_usage).bind(message.edited_at).bind(message.created_at)
      .execute(connection).await.map_err(Self::map_db_err)?;
    Ok(())
  }
}

#[async_trait]
impl CopilotRepository for SqlxCopilotRepository {
  #[instrument(skip_all)]
  async fn claim_copilot_turn(
    &self,
    request: &myoxus_domain::copilot_turn::CopilotTurnRequest,
  ) -> RepoResult<myoxus_domain::copilot_turn::CopilotTurnClaim> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query("SELECT * FROM copilot_sessions WHERE id=$1 FOR UPDATE")
      .bind(request.session_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    let session = Self::map_session(row);
    let messages=sqlx::query("SELECT * FROM copilot_messages WHERE session_id=$1 ORDER BY created_at, CASE WHEN jsonb_typeof(token_usage->'sequence')='number' THEN token_usage->'sequence' END ASC NULLS LAST, id FOR UPDATE")
      .bind(session.id).fetch_all(&mut *tx).await.map_err(Self::map_db_err)?.into_iter().map(Self::map_message).collect::<Vec<_>>();
    let prepared = myoxus_domain::copilot_turn::prepare_turn_claim(&session, &messages, request)
      .map_err(RepositoryError::Conflict)?;
    if prepared.write {
      if let Some(revision) = &prepared.revision {
        let content = Self::revision_content(revision);
        sqlx::query("INSERT INTO copilot_message_revisions (message_id,session_id,role,content,token_usage,edited_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)")
          .bind(revision.id).bind(revision.session_id).bind(Self::role_to_db(&revision.role)).bind(content).bind(&revision.token_usage).bind(revision.edited_at).bind(revision.created_at)
          .execute(&mut *tx).await.map_err(Self::map_db_err)?;
      }
      let message = &prepared.claim.message;
      if messages.iter().any(|m| m.id == message.id) {
        sqlx::query("UPDATE copilot_messages SET content=$2,token_usage=$3,edited_at=$4 WHERE id=$1")
          .bind(message.id)
          .bind(&message.content)
          .bind(&message.token_usage)
          .bind(message.edited_at)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
      } else {
        Self::insert_message(&mut tx, message).await?;
      }
      sqlx::query("UPDATE copilot_sessions SET updated_at=$2 WHERE id=$1")
        .bind(session.id)
        .bind(request.now)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(prepared.claim)
  }

  #[instrument(skip_all)]
  async fn submit_copilot_message(&self, user_id: Uuid, message: &CopilotMessage) -> RepoResult<CopilotMessage> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let exists = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM copilot_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(message.session_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if exists.is_none() {
      return Err(RepositoryError::NotFound("copilot_session"));
    }
    if let Some(key) = message.token_usage.as_ref().and_then(|v| v["inputRequestId"].as_str()) {
      if let Some(row) = sqlx::query(
        "SELECT * FROM copilot_messages WHERE session_id=$1 AND role='user' AND token_usage->>'inputRequestId'=$2",
      )
      .bind(message.session_id)
      .bind(key)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      {
        let existing = Self::map_message(row);
        if !myoxus_domain::copilot_turn::same_submission(&existing, message) {
          return Err(RepositoryError::Conflict(
            "copilot request id reused for different input",
          ));
        }
        tx.commit().await.map_err(Self::map_db_err)?;
        return Ok(existing);
      }
    }
    let sequence: i64 = sqlx::query_scalar("SELECT count(*)+1 FROM copilot_messages WHERE session_id=$1")
      .bind(message.session_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let mut message = message.clone();
    if let Some(Value::Object(usage)) = message.token_usage.as_mut() {
      usage.insert("sequence".into(), json!(sequence));
    }
    Self::insert_message(&mut tx, &message).await?;
    sqlx::query("UPDATE copilot_sessions SET updated_at=$2 WHERE id=$1")
      .bind(message.session_id)
      .bind(message.created_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(message)
  }
  /// Insert a new copilot session row.
  #[instrument(skip(self, session))]
  async fn create_copilot_session(&self, session: &CopilotSession) -> RepoResult<CopilotSession> {
    let mut connection = self.pool.acquire().await.map_err(Self::map_db_err)?;
    Self::insert_session(&mut connection, session).await?;
    Ok(session.clone())
  }

  #[instrument(skip_all,fields(source_session_id=%fork.source.id,target_session_id=%fork.session.id))]
  async fn commit_copilot_session_fork(&self, fork: &CopilotSessionFork) -> RepoResult<CopilotSession> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // FOR UPDATE also blocks new message FK references until commit; row SHARE
    // locks below freeze existing messages against edits/deletes while copying.
    let source=sqlx::query("SELECT id,user_id,workspace_id,doc_id,title,model,pinned,archived_at,deleted_at,metadata,created_at,updated_at FROM copilot_sessions WHERE id=$1 FOR UPDATE")
      .bind(fork.source.id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
      .map(Self::map_session).ok_or(RepositoryError::NotFound("copilot_session"))?;
    let current=sqlx::query("SELECT id,session_id,role,content,token_usage,edited_at,created_at FROM copilot_messages WHERE session_id=$1 ORDER BY created_at ASC, CASE WHEN jsonb_typeof(token_usage->'sequence')='number' THEN token_usage->'sequence' END ASC NULLS LAST, id ASC FOR SHARE")
      .bind(source.id).fetch_all(&mut *tx).await.map_err(Self::map_db_err)?
      .into_iter().map(Self::map_message).collect::<Vec<_>>();
    if source != fork.source || current != fork.source_messages {
      return Err(RepositoryError::Conflict("copilot fork source changed"));
    }
    Self::insert_session(&mut tx, &fork.session).await?;
    for message in &fork.messages {
      Self::insert_message(&mut tx, message).await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(fork.session.clone())
  }

  /// Fetch a copilot session by ID, returning `None` when not found.
  #[instrument(skip(self))]
  async fn get_copilot_session(&self, session_id: Uuid) -> RepoResult<Option<CopilotSession>> {
    let row = sqlx::query(
      "SELECT id, user_id, workspace_id, doc_id, title, model, pinned, archived_at, deleted_at, metadata, created_at, updated_at FROM copilot_sessions WHERE id = $1",
    )
    .bind(session_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_session))
  }

  /// One MVCC snapshot keeps page/count/access targets coherent, including
  /// an empty page beyond the end. Only the page carries full session rows.
  #[instrument(skip(self))]
  async fn list_copilot_sessions(
    &self,
    user_id: Uuid,
    filter: &CopilotSessionFilter,
    page: PageRequest,
  ) -> RepoResult<CopilotSessionPage> {
    let rows = sqlx::query(
      r#"WITH matching AS MATERIALIZED (
        SELECT id,user_id,workspace_id,doc_id,title,model,pinned,archived_at,deleted_at,metadata,created_at,updated_at
        FROM copilot_sessions WHERE user_id=$1
          AND ($2::uuid IS NULL OR workspace_id=$2)
          AND deleted_at IS NULL AND ($3::bool OR archived_at IS NULL)
          AND ($4::uuid IS NULL OR doc_id=$4)
          AND ($5::uuid IS NULL OR id=$5)
          AND ($6::bool IS NULL OR pinned=$6)
          AND ($7::bool IS NULL OR COALESCE(jsonb_typeof(metadata->'action')='string' AND length(metadata->>'action')>0, false)=$7)
          AND ($8::bool IS NULL OR COALESCE(jsonb_typeof(metadata->'parentSessionId')='string' AND length(metadata->>'parentSessionId')>0, false)=$8)
      ), access AS (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('workspace_id',workspace_id,'doc_id',doc_id)), '[]') AS access_scopes
        FROM (SELECT DISTINCT workspace_id,doc_id FROM matching) targets
      ), paged AS (
        SELECT * FROM matching
        ORDER BY CASE WHEN $9 THEN updated_at END ASC, CASE WHEN NOT $9 THEN updated_at END DESC,
          CASE WHEN $9 THEN id END ASC, CASE WHEN NOT $9 THEN id END DESC
        LIMIT $10 OFFSET $11
      )
      SELECT paged.*, totals.total_count, access.access_scopes
      FROM (SELECT count(*) AS total_count FROM matching) totals CROSS JOIN access
      LEFT JOIN paged ON true
      ORDER BY CASE WHEN $9 THEN paged.updated_at END ASC, CASE WHEN NOT $9 THEN paged.updated_at END DESC,
        CASE WHEN $9 THEN paged.id END ASC, CASE WHEN NOT $9 THEN paged.id END DESC"#,
    )
    .bind(user_id)
    .bind(filter.workspace_id)
    .bind(filter.include_archived)
    .bind(filter.doc_id)
    .bind(filter.session_id)
    .bind(filter.pinned)
    .bind(filter.action)
    .bind(filter.fork)
    .bind(filter.ascending)
    .bind(page.limit.max(0))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let total_count = rows[0].get("total_count");
    let access_scopes = serde_json::from_value(rows[0].get("access_scopes"))
      .map_err(|_| RepositoryError::Storage("invalid copilot history access targets".into()))?;
    let sessions = rows
      .into_iter()
      .filter(|row| row.get::<Option<Uuid>, _>("id").is_some())
      .map(Self::map_session)
      .collect();
    Ok(CopilotSessionPage {
      sessions,
      total_count,
      access_scopes,
    })
  }

  /// Update mutable fields of an existing copilot session.
  #[instrument(skip(self, session))]
  async fn update_copilot_session(&self, session: &CopilotSession) -> RepoResult<CopilotSession> {
    let result =
      sqlx::query("UPDATE copilot_sessions SET doc_id = $2, title = $3, model = $4, pinned = $5, archived_at = $6, deleted_at = $7, metadata = $8, updated_at = $9 WHERE id = $1")
        .bind(session.id)
        .bind(session.doc_id)
        .bind(&session.title)
        .bind(&session.model)
        .bind(session.pinned)
        .bind(session.archived_at)
        .bind(session.deleted_at)
        .bind(&session.metadata)
        .bind(session.updated_at)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("copilot_session"));
    }
    Ok(session.clone())
  }

  /// Soft-archive a copilot session by setting `archived_at`.
  #[instrument(skip(self))]
  async fn archive_copilot_session(&self, session_id: Uuid, archived_at: DateTime<Utc>) -> RepoResult<()> {
    let result = sqlx::query("UPDATE copilot_sessions SET archived_at = $2, updated_at = $2 WHERE id = $1")
      .bind(session_id)
      .bind(archived_at)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("copilot_session"));
    }
    Ok(())
  }

  /// Soft-delete a copilot session by setting `deleted_at`.
  #[instrument(skip(self))]
  async fn delete_copilot_session(&self, session_id: Uuid, deleted_at: DateTime<Utc>) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let result =
      sqlx::query("UPDATE copilot_sessions SET deleted_at = $2, pinned = FALSE, updated_at = $2 WHERE id = $1")
        .bind(session_id)
        .bind(deleted_at)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("copilot_session"));
    }
    sqlx::query("DELETE FROM copilot_messages WHERE session_id = $1")
      .bind(session_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Append a new message to a copilot session.
  #[instrument(skip(self, message))]
  async fn append_copilot_message(&self, message: &CopilotMessage) -> RepoResult<CopilotMessage> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SELECT id FROM copilot_sessions WHERE id=$1 FOR UPDATE")
      .bind(message.session_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    Self::insert_message(&mut tx, message).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(message.clone())
  }

  /// Fetch a copilot message by ID.
  #[instrument(skip(self))]
  async fn get_copilot_message(&self, message_id: Uuid) -> RepoResult<Option<CopilotMessage>> {
    let row = sqlx::query(
      "SELECT id, session_id, role, content, token_usage, edited_at, created_at FROM copilot_messages WHERE id = $1",
    )
    .bind(message_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_message))
  }

  /// Update the content of an existing copilot message.
  #[instrument(skip(self, message))]
  async fn update_copilot_message(&self, message: &CopilotMessage) -> RepoResult<CopilotMessage> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query("SELECT * FROM copilot_messages WHERE id=$1 FOR UPDATE")
      .bind(message.id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(RepositoryError::NotFound("copilot_message"))?;
    let current = Self::map_message(row);
    let mut message = message.clone();
    myoxus_domain::copilot_turn::preserve_turn_metadata(&mut message, &current);
    let content =
      Self::inject_message_extensions(message.content.clone(), &message.tool_calls, &message.attachment_refs);
    let result = sqlx::query(
      "UPDATE copilot_messages SET role = $2, content = $3, token_usage = $4, edited_at = $5 WHERE id = $1",
    )
    .bind(message.id)
    .bind(Self::role_to_db(&message.role))
    .bind(content)
    .bind(&message.token_usage)
    .bind(message.edited_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("copilot_message"));
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(message)
  }

  #[instrument(skip_all)]
  async fn update_copilot_stream(&self, message: &CopilotMessage, stream_id: Uuid) -> RepoResult<bool> {
    let content =
      Self::inject_message_extensions(message.content.clone(), &message.tool_calls, &message.attachment_refs);
    let result = sqlx::query(
      "UPDATE copilot_messages SET content = $2, token_usage = $3 WHERE id = $1 AND token_usage->>'streamId' = $4 AND token_usage->>'streamStatus' = 'running' AND edited_at IS NOT DISTINCT FROM $5",
    )
    .bind(message.id).bind(content).bind(&message.token_usage).bind(stream_id.to_string()).bind(message.edited_at)
    .execute(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(result.rows_affected() == 1)
  }

  /// Append a revision snapshot to a message's edit history.
  #[instrument(skip(self, revision))]
  async fn append_copilot_message_revision(&self, message_id: Uuid, revision: &CopilotMessage) -> RepoResult<()> {
    let content = Self::revision_content(revision);
    sqlx::query(
      "INSERT INTO copilot_message_revisions (message_id, session_id, role, content, token_usage, edited_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(message_id)
    .bind(revision.session_id)
    .bind(Self::role_to_db(&revision.role))
    .bind(content)
    .bind(&revision.token_usage)
    .bind(revision.edited_at)
    .bind(revision.created_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// List all edit revisions for a message.
  #[instrument(skip(self))]
  async fn list_copilot_message_revisions(
    &self,
    message_id: Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotMessage>> {
    let rows = sqlx::query(
      "SELECT message_id AS id, session_id, role, content, token_usage, edited_at, created_at FROM copilot_message_revisions WHERE message_id = $1 ORDER BY revision_created_at ASC, id ASC LIMIT $2 OFFSET $3",
    )
    .bind(message_id)
    .bind(page.limit.max(0))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_message).collect())
  }

  /// List messages in a session with offset-based pagination.
  #[instrument(skip(self))]
  async fn list_copilot_messages(&self, session_id: Uuid, page: PageRequest) -> RepoResult<Vec<CopilotMessage>> {
    let rows = sqlx::query(
      "SELECT id, session_id, role, content, token_usage, edited_at, created_at FROM copilot_messages WHERE session_id = $1 ORDER BY created_at ASC, CASE WHEN jsonb_typeof(token_usage->'sequence')='number' THEN token_usage->'sequence' END ASC NULLS LAST, id ASC LIMIT $2 OFFSET $3",
    )
    .bind(session_id)
    .bind(page.limit.max(0))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_message).collect())
  }

  /// Persist a tool-call record associated with a message.
  #[instrument(skip(self, tool_call))]
  async fn append_copilot_tool_call(&self, tool_call: &CopilotToolCall) -> RepoResult<CopilotToolCall> {
    let mut message = self
      .get_copilot_message(tool_call.message_id)
      .await?
      .ok_or(RepositoryError::NotFound("copilot_message"))?;
    message.tool_calls.push(tool_call.clone());
    self.update_copilot_message(&message).await?;
    Ok(tool_call.clone())
  }

  /// Link a blob attachment to a copilot message.
  #[instrument(skip(self, attachment_ref))]
  async fn append_copilot_attachment_ref(
    &self,
    attachment_ref: &CopilotAttachmentRef,
  ) -> RepoResult<CopilotAttachmentRef> {
    let mut message = self
      .get_copilot_message(attachment_ref.message_id)
      .await?
      .ok_or(RepositoryError::NotFound("copilot_message"))?;
    message.attachment_refs.push(attachment_ref.clone());
    self.update_copilot_message(&message).await?;
    Ok(attachment_ref.clone())
  }

  #[instrument(skip_all)]
  async fn commit_copilot_generated_file(
    &self,
    expected_session: &CopilotSession,
    source: &CopilotMessage,
    file: &CopilotAttachmentRef,
  ) -> RepoResult<CopilotAttachmentRef> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let session = sqlx::query("SELECT * FROM copilot_sessions WHERE id=$1 FOR UPDATE")
      .bind(source.session_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_session)
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    let mut message = sqlx::query("SELECT * FROM copilot_messages WHERE id=$1 AND session_id=$2 FOR UPDATE")
      .bind(source.id)
      .bind(session.id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_message)
      .ok_or(RepositoryError::NotFound("copilot_message"))?;
    let committed = myoxus_application::copilot::files::append_generated_file(
      &session,
      expected_session,
      &mut message,
      source,
      file,
    )?;
    let content = Self::inject_message_extensions(message.content, &message.tool_calls, &message.attachment_refs);
    sqlx::query("UPDATE copilot_messages SET content=$2 WHERE id=$1")
      .bind(message.id)
      .bind(content)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(committed)
  }

  /// Insert a new copilot retrieval context.
  /// Metadata carries its durable session authority and must survive all reads.
  #[instrument(skip(self, context))]
  async fn create_copilot_context(&self, context: &CopilotContext) -> RepoResult<CopilotContext> {
    sqlx::query("INSERT INTO copilot_contexts (id, user_id, workspace_id, name, metadata) VALUES ($1, $2, $3, $4, $5)")
      .bind(context.id)
      .bind(context.user_id)
      .bind(context.workspace_id)
      .bind(&context.name)
      .bind(&context.metadata)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(context.clone())
  }

  #[instrument(skip(self))]
  async fn get_copilot_context(&self, context_id: Uuid) -> RepoResult<Option<CopilotContext>> {
    let row =
      sqlx::query("SELECT id, user_id, workspace_id, name, metadata, created_at FROM copilot_contexts WHERE id = $1")
        .bind(context_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(row.map(|row| CopilotContext {
      id: row.get("id"),
      user_id: row.get("user_id"),
      workspace_id: row.get("workspace_id"),
      name: row.get("name"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
    }))
  }

  #[instrument(skip(self))]
  async fn find_copilot_context(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    name: &str,
  ) -> RepoResult<Option<CopilotContext>> {
    let row = sqlx::query(
      "SELECT id, user_id, workspace_id, name, metadata, created_at FROM copilot_contexts WHERE user_id = $1 AND workspace_id = $2 AND name = $3 ORDER BY created_at ASC LIMIT 1",
    )
    .bind(user_id)
    .bind(workspace_id)
    .bind(name)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| CopilotContext {
      id: row.get("id"),
      user_id: row.get("user_id"),
      workspace_id: row.get("workspace_id"),
      name: row.get("name"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
    }))
  }

  /// List a person's contexts newest-first, optionally scoped to a workspace.
  #[instrument(skip(self))]
  async fn list_copilot_contexts(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotContext>> {
    let rows = sqlx::query(
      "SELECT id, user_id, workspace_id, name, metadata, created_at FROM copilot_contexts WHERE user_id = $1 AND ($2::uuid IS NULL OR workspace_id = $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4",
    )
    .bind(user_id)
    .bind(workspace_id)
    .bind(page.limit.max(0))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| CopilotContext {
          id: row.get("id"),
          user_id: row.get("user_id"),
          workspace_id: row.get("workspace_id"),
          name: row.get("name"),
          metadata: row.get("metadata"),
          created_at: row.get("created_at"),
        })
        .collect(),
    )
  }

  /// Append an item to a copilot retrieval context.
  #[instrument(skip(self, item))]
  async fn append_copilot_context_item(&self, item: &CopilotContextItem) -> RepoResult<CopilotContextItem> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("DELETE FROM copilot_context_items WHERE context_id = $1 AND item_type = $2 AND item_ref = $3")
      .bind(item.context_id)
      .bind(Self::context_item_type_to_db(&item.item_type))
      .bind(&item.item_ref)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query(
      "INSERT INTO copilot_context_items (id, context_id, item_type, item_ref, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(item.id)
    .bind(item.context_id)
    .bind(Self::context_item_type_to_db(&item.item_type))
    .bind(&item.item_ref)
    .bind(&item.metadata)
    .bind(item.created_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(item.clone())
  }

  async fn get_copilot_context_item(&self, item_id: Uuid) -> RepoResult<Option<CopilotContextItem>> {
    let row =
      sqlx::query("SELECT id,context_id,item_type,item_ref,metadata,created_at FROM copilot_context_items WHERE id=$1")
        .bind(item_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(row.map(|row| CopilotContextItem {
      id: row.get("id"),
      context_id: row.get("context_id"),
      item_type: Self::context_item_type_from_db(&row.get::<String, _>("item_type")),
      item_ref: row.get("item_ref"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
    }))
  }

  #[instrument(skip_all)]
  async fn compare_context_item_metadata(
    &self,
    item_id: Uuid,
    expected: &Value,
    replacement: &Value,
  ) -> RepoResult<bool> {
    let result = sqlx::query("UPDATE copilot_context_items SET metadata=$3 WHERE id=$1 AND metadata=$2")
      .bind(item_id)
      .bind(expected)
      .bind(replacement)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() == 1)
  }

  async fn due_context_ingestions(&self, now_ms: i64, limit: i64) -> RepoResult<Vec<CopilotContextItem>> {
    let rows=sqlx::query("SELECT id,context_id,item_type,item_ref,metadata,created_at FROM copilot_context_items WHERE item_type IN ('file','blob') AND metadata->>'ingestStatus' IN ('queued','running') AND COALESCE((metadata->>'leaseUntil')::bigint,0)<=$1 ORDER BY created_at LIMIT $2")
      .bind(now_ms).bind(limit.clamp(1,100)).fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| CopilotContextItem {
          id: row.get("id"),
          context_id: row.get("context_id"),
          item_type: Self::context_item_type_from_db(&row.get::<String, _>("item_type")),
          item_ref: row.get("item_ref"),
          metadata: row.get("metadata"),
          created_at: row.get("created_at"),
        })
        .collect(),
    )
  }

  /// List items belonging to a copilot context.
  #[instrument(skip(self))]
  async fn list_copilot_context_items(
    &self,
    context_id: Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotContextItem>> {
    let rows = sqlx::query(
      r#"SELECT item.id, item.context_id, item.item_type, item.item_ref,
                CASE WHEN item.item_type = 'file' THEN
                  jsonb_strip_nulls(jsonb_build_object(
                    'name', file.file_name,
                    'mimeType', file.mime_type,
                    'size', file.size,
                    'blobId', file.blob_id
                  )) || item.metadata
                ELSE item.metadata END AS metadata,
                item.created_at
         FROM copilot_context_items item
         LEFT JOIN copilot_contexts context ON context.id = item.context_id
         LEFT JOIN ai_workspace_files file
           ON item.item_type = 'file'
          AND file.workspace_id = context.workspace_id
          AND file.file_id = item.item_ref
         WHERE item.context_id = $1
         ORDER BY item.created_at ASC
         LIMIT $2 OFFSET $3"#,
    )
    .bind(context_id)
    .bind(page.limit.max(0))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| CopilotContextItem {
          id: row.get("id"),
          context_id: row.get("context_id"),
          item_type: Self::context_item_type_from_db(&row.get::<String, _>("item_type")),
          item_ref: row.get("item_ref"),
          metadata: row.get("metadata"),
          created_at: row.get("created_at"),
        })
        .collect(),
    )
  }

  /// Remove a specific item from a copilot context.
  #[instrument(skip(self))]
  async fn remove_copilot_context_item(
    &self,
    context_id: Uuid,
    item_type: CopilotContextItemType,
    item_ref: &str,
  ) -> RepoResult<bool> {
    let result =
      sqlx::query("DELETE FROM copilot_context_items WHERE context_id = $1 AND item_type = $2 AND item_ref = $3")
        .bind(context_id)
        .bind(Self::context_item_type_to_db(&item_type))
        .bind(item_ref)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() > 0)
  }

  /// Insert or update the copilot workspace state (embedding version cursor, etc.).
  #[instrument(skip(self, state))]
  async fn upsert_copilot_workspace_state(&self, state: &CopilotWorkspaceState) -> RepoResult<CopilotWorkspaceState> {
    let ignored_doc_ids = Value::Array(
      state
        .ignored_doc_ids
        .iter()
        .map(|id| Value::String(id.to_string()))
        .collect(),
    );
    sqlx::query(
      "INSERT INTO copilot_workspaces (workspace_id, last_embedding_at, ignored_doc_ids, metadata, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id) DO UPDATE SET last_embedding_at = EXCLUDED.last_embedding_at, ignored_doc_ids = EXCLUDED.ignored_doc_ids, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at",
    )
    .bind(state.workspace_id)
    .bind(state.last_embedding_at)
    .bind(ignored_doc_ids)
    .bind(&state.metadata)
    .bind(state.updated_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(state.clone())
  }

  /// Fetch the copilot workspace state, returning `None` when not yet
  /// initialised.
  #[instrument(skip(self))]
  async fn get_copilot_workspace_state(&self, workspace_id: Uuid) -> RepoResult<Option<CopilotWorkspaceState>> {
    let row = sqlx::query(
      "SELECT workspace_id, last_embedding_at, ignored_doc_ids, metadata, updated_at FROM copilot_workspaces WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| {
      let ignored_raw: Value = row.get("ignored_doc_ids");
      let mut metadata: Value = row.get("metadata");
      if !metadata.is_object() {
        metadata = json!({});
      }
      let mut created_at_by_doc = serde_json::Map::new();
      let ignored_doc_ids = ignored_raw
        .as_array()
        .map(|items| {
          items
            .iter()
            .filter_map(|value| {
              let (id, created_at) = match value {
                Value::String(id) => (id.as_str(), None),
                Value::Object(object) => (
                  object.get("docId").and_then(Value::as_str)?,
                  object.get("createdAt").cloned(),
                ),
                _ => return None,
              };
              let id = Uuid::parse_str(id).ok()?;
              if let Some(created_at) = created_at {
                created_at_by_doc.insert(id.to_string(), created_at);
              }
              Some(id)
            })
            .collect()
        })
        .unwrap_or_default();
      if !created_at_by_doc.is_empty() {
        metadata
          .as_object_mut()
          .expect("metadata was normalized")
          .entry("ignoredDocCreatedAt")
          .or_insert_with(|| Value::Object(created_at_by_doc));
      }
      CopilotWorkspaceState {
        workspace_id: row.get("workspace_id"),
        last_embedding_at: row.get("last_embedding_at"),
        ignored_doc_ids,
        metadata,
        updated_at: row.get("updated_at"),
      }
    }))
  }

  /// Insert a new background copilot job.
  #[instrument(skip(self, job))]
  async fn create_copilot_job(&self, job: &CopilotJob) -> RepoResult<CopilotJob> {
    sqlx::query(
      "INSERT INTO copilot_jobs (id, job_type, state, workspace_id, user_id, payload, error_message, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(job.id)
    .bind(&job.job_type)
    .bind(Self::job_state_to_db(&job.state))
    .bind(job.workspace_id)
    .bind(job.user_id)
    .bind(&job.payload)
    .bind(&job.error_message)
    .bind(job.created_at)
    .bind(job.updated_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(job.clone())
  }

  #[instrument(skip(self))]
  async fn get_copilot_job(&self, job_id: Uuid) -> RepoResult<Option<CopilotJob>> {
    let row = sqlx::query(
      "SELECT id, job_type, state, workspace_id, user_id, payload, error_message, created_at, updated_at FROM copilot_jobs WHERE id = $1",
    )
    .bind(job_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| CopilotJob {
      id: row.get("id"),
      job_type: row.get("job_type"),
      state: Self::job_state_from_db(&row.get::<String, _>("state")),
      workspace_id: row.get("workspace_id"),
      user_id: row.get("user_id"),
      payload: row.get("payload"),
      error_message: row.get("error_message"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }))
  }

  /// Replace only the trusted execution payload, retaining ownership and state.
  #[instrument(skip_all)]
  async fn update_copilot_job_payload(&self, job_id: Uuid, payload: serde_json::Value) -> RepoResult<CopilotJob> {
    let row = sqlx::query("UPDATE copilot_jobs SET payload = $2 WHERE id = $1 RETURNING *")
      .bind(job_id)
      .bind(payload)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(RepositoryError::NotFound("copilot_job"))?;
    Ok(CopilotJob {
      id: row.get("id"),
      job_type: row.get("job_type"),
      state: Self::job_state_from_db(&row.get::<String, _>("state")),
      workspace_id: row.get("workspace_id"),
      user_id: row.get("user_id"),
      payload: row.get("payload"),
      error_message: row.get("error_message"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  /// Update the execution state of a copilot job.
  #[instrument(skip(self))]
  async fn update_copilot_job_state(
    &self,
    job_id: Uuid,
    state: CopilotJobState,
    error_message: Option<String>,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<CopilotJob> {
    let result = sqlx::query("UPDATE copilot_jobs SET state = $2, error_message = $3, updated_at = $4 WHERE id = $1")
      .bind(job_id)
      .bind(Self::job_state_to_db(&state))
      .bind(&error_message)
      .bind(updated_at)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("copilot_job"));
    }
    let row = sqlx::query(
      "SELECT id, job_type, state, workspace_id, user_id, payload, error_message, created_at, updated_at FROM copilot_jobs WHERE id = $1",
    )
    .bind(job_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(CopilotJob {
      id: row.get("id"),
      job_type: row.get("job_type"),
      state: Self::job_state_from_db(&row.get::<String, _>("state")),
      workspace_id: row.get("workspace_id"),
      user_id: row.get("user_id"),
      payload: row.get("payload"),
      error_message: row.get("error_message"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  /// List copilot jobs filtered by workspace and optionally by state.
  #[instrument(skip(self))]
  async fn list_copilot_jobs(
    &self,
    workspace_id: Option<Uuid>,
    user_id: Option<Uuid>,
    state: Option<CopilotJobState>,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotJob>> {
    let state_filter = state.as_ref().map(Self::job_state_to_db);
    let rows = sqlx::query(
      "SELECT id, job_type, state, workspace_id, user_id, payload, error_message, created_at, updated_at FROM copilot_jobs WHERE ($1::uuid IS NULL OR workspace_id = $1) AND ($2::uuid IS NULL OR user_id = $2) AND ($3::text IS NULL OR state = $3) ORDER BY updated_at DESC LIMIT $4 OFFSET $5",
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(state_filter)
    .bind(page.limit.max(0))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| CopilotJob {
          id: row.get("id"),
          job_type: row.get("job_type"),
          state: Self::job_state_from_db(&row.get::<String, _>("state")),
          workspace_id: row.get("workspace_id"),
          user_id: row.get("user_id"),
          payload: row.get("payload"),
          error_message: row.get("error_message"),
          created_at: row.get("created_at"),
          updated_at: row.get("updated_at"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self))]
  async fn count_active_copilot_sessions(&self) -> RepoResult<i64> {
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM copilot_sessions WHERE deleted_at IS NULL")
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  async fn purge_deleted_copilot_sessions_before(&self, cutoff: DateTime<Utc>) -> RepoResult<u64> {
    Ok(
      sqlx::query("DELETE FROM copilot_sessions WHERE deleted_at IS NOT NULL AND deleted_at < $1")
        .bind(cutoff)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?
        .rows_affected(),
    )
  }

  async fn clear_copilot_session_document(&self, doc_id: Uuid) -> RepoResult<u64> {
    Ok(
      sqlx::query("UPDATE copilot_sessions SET doc_id = NULL WHERE doc_id = $1")
        .bind(doc_id)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?
        .rows_affected(),
    )
  }

  async fn purge_empty_copilot_sessions_before(&self, cutoff: DateTime<Utc>) -> RepoResult<u64> {
    Ok(
      sqlx::query(
        "DELETE FROM copilot_sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM copilot_messages) \
         AND created_at < $1",
      )
      .bind(cutoff)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .rows_affected(),
    )
  }

  async fn list_untitled_copilot_session_ids(&self, limit: i64) -> RepoResult<Vec<Uuid>> {
    sqlx::query_scalar(
      "SELECT s.id FROM copilot_sessions s WHERE (s.title IS NULL OR s.title = '') \
       AND s.deleted_at IS NULL AND EXISTS (SELECT 1 FROM copilot_messages m WHERE m.session_id = s.id) LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  async fn list_active_copilot_attachment_blob_keys(&self) -> RepoResult<Vec<String>> {
    Ok(
      sqlx::query_scalar::<_, Option<String>>(
        "SELECT DISTINCT jsonb_array_elements(cm.content -> '__attachmentRefs') ->> 'blobKey' \
         FROM copilot_messages cm JOIN copilot_sessions cs ON cs.id = cm.session_id \
         WHERE cm.content ? '__attachmentRefs' AND jsonb_array_length(cm.content -> '__attachmentRefs') > 0",
      )
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .into_iter()
      .flatten()
      .collect(),
    )
  }

  async fn list_orphaned_copilot_attachment_blob_keys(&self) -> RepoResult<Vec<String>> {
    Ok(
      sqlx::query_scalar::<_, Option<String>>(
        "SELECT DISTINCT jsonb_array_elements(cm.content -> '__attachmentRefs') ->> 'blobKey' \
         FROM copilot_messages cm WHERE cm.content ? '__attachmentRefs' \
         AND jsonb_array_length(cm.content -> '__attachmentRefs') > 0 \
         AND NOT EXISTS (SELECT 1 FROM copilot_sessions cs WHERE cs.id = cm.session_id)",
      )
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .into_iter()
      .flatten()
      .collect(),
    )
  }
}
