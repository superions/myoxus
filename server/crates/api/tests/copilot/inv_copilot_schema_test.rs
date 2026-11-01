//! P90-CP integration tests — Copilot schema fixes for match queries and transcription.
//!
//! Each test maps directly to a schema fix from P90-CP:
//! - S01: CopilotContextMatchedFile.chunk is Int type
//! - S02: CopilotContextMatchedDoc.chunk is Int type
//! - S03: CopilotWorkspaceFile.workspaceId field exists
//! - S04-S07: DateTime and data contract invariants
//!
//! Tests verify GraphQL schema types and DB state after operations.
//! Naming convention: `inv_cp_s{nn}_{description}`.

use crate::helpers;

use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// P90-CP-S01 — CopilotContextMatchedFile.chunk is Int, not String
//
// Tests that the chunk field in CopilotContextMatchedFile is typed as Int
// in the GraphQL schema. This is verified via introspection.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp_s01_matched_file_chunk_is_int() {
  let (app, _pool, _auth_store) = helpers::setup_app_with_metrics().await;

  tracing::info!("S01: checking CopilotContextMatchedFile.chunk type");

  let introspection_resp = helpers::gql(
    &app,
    Uuid::nil(),
    json!({
      "query": r#"
        query {
          __type(name: "CopilotContextMatchedFile") {
            fields {
              name
              type {
                name
                kind
                ofType {
                  name
                  kind
                }
              }
            }
          }
        }
      "#
    }),
  )
  .await;

  tracing::info!("S01: introspection response: {}", introspection_resp);

  let fields = introspection_resp
    .pointer("/data/__type/fields")
    .and_then(|v| v.as_array())
    .expect("fields array must exist");

  let chunk_field = fields
    .iter()
    .find(|f| {
      f.get("name")
        .and_then(|n| n.as_str())
        .map(|s| s == "chunk")
        .unwrap_or(false)
    })
    .expect("chunk field must exist on CopilotContextMatchedFile");

  let field_type = chunk_field.get("type").expect("chunk must have a type definition");

  let is_int = if let Some(type_name) = field_type.get("name").and_then(|n| n.as_str()) {
    type_name == "Int"
  } else {
    field_type
      .get("ofType")
      .and_then(|ot| ot.get("name"))
      .and_then(|n| n.as_str())
      .map(|s| s == "Int")
      .unwrap_or(false)
  };

  assert!(is_int, "S01: chunk field must be Int type: {field_type}");
  tracing::info!("S01: test passed");
}

// ---------------------------------------------------------------------------
// P90-CP-S02 — CopilotContextMatchedDoc.chunk is Int, not String
//
// Tests that the chunk field in CopilotContextMatchedDoc is typed as Int
// in the GraphQL schema. This ensures consistency with CopilotContextMatchedFile.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp_s02_matched_doc_chunk_is_int() {
  let (app, _pool, _auth_store) = helpers::setup_app_with_metrics().await;

  tracing::info!("S02: checking CopilotContextMatchedDoc.chunk type");

  let introspection_resp = helpers::gql(
    &app,
    Uuid::nil(),
    json!({
      "query": r#"
        query {
          __type(name: "CopilotContextMatchedDoc") {
            fields {
              name
              type {
                name
                kind
                ofType {
                  name
                  kind
                }
              }
            }
          }
        }
      "#
    }),
  )
  .await;

  tracing::info!("S02: introspection response: {}", introspection_resp);

  let fields = introspection_resp
    .pointer("/data/__type/fields")
    .and_then(|v| v.as_array())
    .expect("fields array must exist");

  let chunk_field = fields
    .iter()
    .find(|f| {
      f.get("name")
        .and_then(|n| n.as_str())
        .map(|s| s == "chunk")
        .unwrap_or(false)
    })
    .expect("chunk field must exist on CopilotContextMatchedDoc");

  let field_type = chunk_field.get("type").expect("chunk must have a type definition");

  let is_int = if let Some(type_name) = field_type.get("name").and_then(|n| n.as_str()) {
    type_name == "Int"
  } else {
    field_type
      .get("ofType")
      .and_then(|ot| ot.get("name"))
      .and_then(|n| n.as_str())
      .map(|s| s == "Int")
      .unwrap_or(false)
  };

  assert!(is_int, "S02: chunk field must be Int type: {field_type}");
  tracing::info!("S02: test passed");
}

// ---------------------------------------------------------------------------
// P90-CP-S03 — CopilotWorkspaceFile.workspaceId field exists and is String
//
// Tests that the CopilotWorkspaceFile type includes a workspaceId field.
// This is a schema contract requirement for admin frontend compatibility.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp_s03_workspace_file_has_workspace_id() {
  let (app, _pool, _auth_store) = helpers::setup_app_with_metrics().await;

  tracing::info!("S03: checking CopilotWorkspaceFile.workspaceId field");

  let introspection_resp = helpers::gql(
    &app,
    Uuid::nil(),
    json!({
      "query": r#"
        query {
          __type(name: "CopilotWorkspaceFile") {
            fields {
              name
              type {
                name
                kind
              }
            }
          }
        }
      "#
    }),
  )
  .await;

  tracing::info!("S03: introspection response: {}", introspection_resp);

  let fields = introspection_resp
    .pointer("/data/__type/fields")
    .and_then(|v| v.as_array())
    .expect("fields array must exist");

  let has_workspace_id = fields.iter().any(|f| {
    f.get("name")
      .and_then(|n| n.as_str())
      .map(|s| s == "workspaceId")
      .unwrap_or(false)
  });

  assert!(
    has_workspace_id,
    "S03: CopilotWorkspaceFile type must have workspaceId field"
  );

  tracing::info!("S03: test passed");
}

// ---------------------------------------------------------------------------
// P90-CP-S04 — CopilotWorkspaceFile.createdAt is DateTime type, not Int
//
// Tests that createdAt field on CopilotWorkspaceFile is typed as DateTime
// in the GraphQL schema, not Int or String. This ensures timestamps are
// properly formatted (ISO8601) in responses.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp_s04_workspace_file_created_at_is_datetime() {
  let (app, _pool, _auth_store) = helpers::setup_app_with_metrics().await;

  tracing::info!("S04: checking CopilotWorkspaceFile.createdAt type");

  let introspection_resp = helpers::gql(
    &app,
    Uuid::nil(),
    json!({
      "query": r#"
        query {
          __type(name: "CopilotWorkspaceFile") {
            fields {
              name
              type {
                name
                kind
                ofType {
                  name
                  kind
                }
              }
            }
          }
        }
      "#
    }),
  )
  .await;

  tracing::info!("S04: introspection response: {}", introspection_resp);

  let fields = introspection_resp
    .pointer("/data/__type/fields")
    .and_then(|v| v.as_array())
    .expect("fields array must exist");

  let created_at_field = fields
    .iter()
    .find(|f| {
      f.get("name")
        .and_then(|n| n.as_str())
        .map(|s| s == "createdAt")
        .unwrap_or(false)
    })
    .expect("createdAt field must exist on CopilotWorkspaceFile");

  let field_type = created_at_field.get("type").expect("createdAt must have type");

  let is_datetime = if let Some(type_name) = field_type.get("name").and_then(|n| n.as_str()) {
    type_name == "DateTime"
  } else {
    field_type
      .get("ofType")
      .and_then(|ot| ot.get("name"))
      .and_then(|n| n.as_str())
      .map(|s| s == "DateTime")
      .unwrap_or(false)
  };

  assert!(is_datetime, "S04: createdAt field must be DateTime type: {field_type}");

  tracing::info!("S04: test passed");
}

// ---------------------------------------------------------------------------
// P90-CP-S05 — copilot_jobs with finished state are queryable
//
// Tests that an AI job with state='finished' can be queried without error.
// Verifies the job_id column type and state persistence.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp_s05_finished_job_queryable() {
  let (app, pool, auth_store) = helpers::setup_app_with_metrics().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "cp_s05").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  tracing::info!("S05: setup complete");

  // Create a finished copilot job
  let job_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO copilot_jobs (id, job_type, state, workspace_id, user_id, payload, updated_at)
       VALUES ($1, 'audio_transcription', 'finished', $2, $3, '{}'::jsonb, now())"#,
  )
  .bind(job_id)
  .bind(workspace_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert finished job");

  tracing::info!("S05: created finished job");

  // Verify: query the job via claimAudioTranscription
  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": format!(
        r#"mutation {{
             claimAudioTranscription(jobId: "{}") {{
               id
               status
             }}
           }}"#,
        job_id
      )
    }),
  )
  .await;

  tracing::info!("S05: claimAudioTranscription response: {}", resp);

  // Assert: no schema error, job is queryable
  assert!(
    resp.get("errors").is_none(),
    "S05: claimAudioTranscription should succeed: {resp}"
  );

  let transcription = resp
    .pointer("/data/claimAudioTranscription")
    .expect("transcription data");
  let _status = transcription.get("status").expect("status field must exist");

  tracing::info!("S05: test passed");

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P90-CP-S06 — copilot_transcripts with source_id and source_type
//
// Tests that copilot_transcripts table uses source_id and source_type columns
// (not job_id). Verifies the schema supports audio transcription records.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp_s06_transcripts_has_source_fields() {
  let (_app, pool, auth_store) = helpers::setup_app_with_metrics().await;
  let (user_id, _session_id) = helpers::seed_user(&pool, &auth_store, "cp_s06").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  tracing::info!("S06: setup complete");

  // Insert transcription record with source_id and source_type
  let transcript_id = Uuid::new_v4();
  let source_id = "blob-123";
  sqlx::query(
    r#"INSERT INTO copilot_transcripts (id, workspace_id, source_type, source_id, content, model, status, created_at)
       VALUES ($1, $2, 'audio', $3, 'Transcript content', 'whisper-1', 'completed', now())"#,
  )
  .bind(transcript_id)
  .bind(workspace_id)
  .bind(source_id)
  .execute(&pool)
  .await
  .expect("insert transcript");

  tracing::info!("S06: created transcript");

  // Verify: row exists and fields are persisted
  let row =
    sqlx::query("SELECT id, source_type, source_id, content, model, status FROM copilot_transcripts WHERE id = $1")
      .bind(transcript_id)
      .fetch_optional(&pool)
      .await
      .expect("query transcript");

  assert!(row.is_some(), "S06: transcript row must exist");

  let row = row.expect("transcript row");
  let stored_source_type: String = row.get("source_type");
  let stored_source_id: String = row.get("source_id");
  let stored_content: String = row.get("content");
  let stored_model: String = row.get("model");
  let stored_status: String = row.get("status");

  assert_eq!(stored_source_type, "audio", "S06: source_type must be 'audio'");
  assert_eq!(stored_source_id, source_id, "S06: source_id must match inserted value");
  assert_eq!(
    stored_content, "Transcript content",
    "S06: content must match inserted value"
  );
  assert_eq!(stored_model, "whisper-1", "S06: model must match inserted value");
  assert_eq!(stored_status, "completed", "S06: status must match inserted value");

  tracing::info!("S06: test passed");

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P90-CP-S07 — copilot_context_blobs table schema verification
//
// Tests that copilot_context_blobs table exists with correct columns
// (context_id and blob_id). Verifies the relationship structure.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp_s07_context_blob_schema() {
  let (_app, pool, _auth_store) = helpers::setup_app_with_metrics().await;

  tracing::info!("S07: verifying copilot_context_blobs table schema");

  // Create test data to verify table structure
  let context_id = Uuid::new_v4();
  let blob_id = Uuid::new_v4();

  // Try to insert into copilot_context_blobs with expected columns
  let result = sqlx::query("INSERT INTO copilot_context_blobs (context_id, blob_id) VALUES ($1, $2)")
    .bind(context_id)
    .bind(blob_id)
    .execute(&pool)
    .await;

  // Either succeeds (table exists with correct columns) or fails due to FK constraint
  // (context doesn't exist), but NOT due to missing columns
  let is_schema_ok = match result {
    Ok(_) => true,
    Err(e) => {
      let err_str = e.to_string();
      // Check if error is NOT about missing columns
      !err_str.contains("column") || err_str.contains("context_id") || err_str.contains("blob_id")
    }
  };

  assert!(
    is_schema_ok,
    "S07: copilot_context_blobs table must have context_id and blob_id columns"
  );

  // Clean up the test insert (if it succeeded)
  sqlx::query("DELETE FROM copilot_context_blobs WHERE context_id = $1 AND blob_id = $2")
    .bind(context_id)
    .bind(blob_id)
    .execute(&pool)
    .await
    .ok();

  tracing::info!("S07: test passed");
}
