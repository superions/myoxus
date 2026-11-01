//! Indexer job payload parsing contract tests (P35-C-04).
//!
//! The `IndexerQueueHandler` in `server.rs` parses raw JSON job data into
//! `SearchIndexJobPayload` variants.  Since the handler lives in the binary
//! crate and is not importable, these tests verify the **parsing contract**
//! directly — the same UUID extraction and missing-field validation logic.
//!
//! Each test replicates the exact parsing pattern from the handler to ensure
//! that valid/invalid payloads produce the expected results.

use myoxus_worker::JobError;
use serde_json::json;
use uuid::Uuid;

/// Parse `indexer.deleteDoc` payload the same way the handler does.
fn parse_delete_doc(data: &serde_json::Value) -> Result<(Uuid, Uuid), JobError> {
  let workspace_id: Uuid = data["workspaceId"]
    .as_str()
    .ok_or_else(|| JobError::Permanent("indexer.deleteDoc missing workspaceId".to_string()))
    .and_then(|s| {
      s.parse()
        .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
    })?;
  let doc_id: Uuid = data["docId"]
    .as_str()
    .ok_or_else(|| JobError::Permanent("indexer.deleteDoc missing docId".to_string()))
    .and_then(|s| {
      s.parse()
        .map_err(|_| JobError::Permanent(format!("invalid docId: {s}")))
    })?;
  Ok((workspace_id, doc_id))
}

/// Parse `indexer.indexWorkspace` payload the same way the handler does.
fn parse_index_workspace(data: &serde_json::Value) -> Result<Uuid, JobError> {
  data["workspaceId"]
    .as_str()
    .ok_or_else(|| JobError::Permanent("indexer.indexWorkspace missing workspaceId".to_string()))
    .and_then(|s| {
      s.parse()
        .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
    })
}

/// Parse `indexer.deleteWorkspace` payload the same way the handler does.
fn parse_delete_workspace(data: &serde_json::Value) -> Result<Uuid, JobError> {
  data["workspaceId"]
    .as_str()
    .ok_or_else(|| JobError::Permanent("indexer.deleteWorkspace missing workspaceId".to_string()))
    .and_then(|s| {
      s.parse()
        .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
    })
}

// ---------------------------------------------------------------------------
// INV: indexer.deleteDoc with valid IDs produces correct payload
// ---------------------------------------------------------------------------

#[test]
fn inv_indexer_delete_doc_valid_payload() {
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();
  let data = json!({"workspaceId": ws.to_string(), "docId": doc.to_string()});

  let (parsed_ws, parsed_doc) = parse_delete_doc(&data).expect("valid payload must parse");
  assert_eq!(parsed_ws, ws);
  assert_eq!(parsed_doc, doc);
}

// ---------------------------------------------------------------------------
// INV: indexer.deleteDoc without docId returns Permanent error
// ---------------------------------------------------------------------------

#[test]
fn inv_indexer_delete_doc_missing_doc_id() {
  let ws = Uuid::new_v4();
  let data = json!({"workspaceId": ws.to_string()});

  let err = parse_delete_doc(&data).unwrap_err();
  assert!(
    matches!(err, JobError::Permanent(_)),
    "missing docId must be Permanent: {err}"
  );
  assert!(err.to_string().contains("missing docId"), "error message: {err}");
}

// ---------------------------------------------------------------------------
// INV: indexer.indexWorkspace with valid workspace_id succeeds
// ---------------------------------------------------------------------------

#[test]
fn inv_indexer_index_workspace_valid_payload() {
  let ws = Uuid::new_v4();
  let data = json!({"workspaceId": ws.to_string()});

  let parsed = parse_index_workspace(&data).expect("valid payload must parse");
  assert_eq!(parsed, ws);
}

// ---------------------------------------------------------------------------
// INV: indexer.deleteWorkspace with valid workspace_id succeeds
// ---------------------------------------------------------------------------

#[test]
fn inv_indexer_delete_workspace_valid_payload() {
  let ws = Uuid::new_v4();
  let data = json!({"workspaceId": ws.to_string()});

  let parsed = parse_delete_workspace(&data).expect("valid payload must parse");
  assert_eq!(parsed, ws);
}

// ---------------------------------------------------------------------------
// INV: indexer.deleteDoc missing workspaceId returns Permanent error
// ---------------------------------------------------------------------------

#[test]
fn inv_indexer_delete_doc_missing_workspace_id() {
  let doc = Uuid::new_v4();
  let data = json!({"docId": doc.to_string()});

  let err = parse_delete_doc(&data).unwrap_err();
  assert!(
    matches!(err, JobError::Permanent(_)),
    "missing workspaceId must be Permanent: {err}"
  );
  assert!(err.to_string().contains("missing workspaceId"), "error message: {err}");
}

// ---------------------------------------------------------------------------
// INV: indexer.deleteDoc with invalid UUID returns Permanent error
// ---------------------------------------------------------------------------

#[test]
fn inv_indexer_delete_doc_invalid_uuid() {
  let data = json!({"workspaceId": "not-a-uuid", "docId": Uuid::new_v4().to_string()});

  let err = parse_delete_doc(&data).unwrap_err();
  assert!(
    matches!(err, JobError::Permanent(_)),
    "invalid UUID must be Permanent: {err}"
  );
  assert!(err.to_string().contains("invalid workspaceId"), "error message: {err}");
}
