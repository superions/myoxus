//! Per-request access checks and document-key validation for the WS layer.
//!
//! - `await_authenticated`: look up the authenticated user for a given socket.
//! - `ensure_space_joined`: auto-join a socket to a space if the client races
//!   ahead of `space:join` (permission check + room assignment + Redis mirror).
//! - `parse_document_key`: validate client-visible workspace-local keys.
//! - `assert_accessible`: check `WorkspaceAction::Sync` for workspaces and
//!   owner-matching for userspaces, with optional doc-level blocked-flag check.
//!
//! Extracted from `mod.rs` in P107-G.

use std::sync::Arc;

use myoxus_application::{
  auth::AuthError,
  doc::DocSpaceKind,
  permission::{AccessController, WorkspaceResource},
};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use serde_json::json;
use socketioxide::extract::{AckSender, SocketRef};
use tracing::{info, warn};
use uuid::Uuid;

use crate::document_access::authorize_workspace_document;
use crate::state::ApiState;

use super::error::emit_sync_error;
use super::room::{get_protocol_rooms, get_room};
use super::state::{
  SOCKET_CLIENT_VERSIONS, SOCKET_USER_MAP, WORKSPACE_SESSIONS, has_space_membership, make_space_key,
  remember_space_membership,
};
use super::types::SpaceType;

/// Document existence is part of the Socket.IO authorization decision.
///
/// Do not collapse these policies into a single optional `DocAction`: an
/// unknown key has no document ACL yet. Loads must remain side-effect free,
/// while the first push is the operation that materializes a document after a
/// workspace-level create check. Resolution still includes blocked and deleted
/// rows, so neither can be treated as an unknown key and recreated.
#[derive(Clone, Copy)]
pub(super) enum DocumentAccess {
  /// The operation is valid only for a document that already resolves.
  Existing(DocAction),
  /// Existing documents require Read; an unknown key reaches the handler so
  /// it can return the protocol's side-effect-free DOC_NOT_FOUND response.
  ReadOrNotFound,
  /// Existing documents require Update; an unknown key requires the
  /// workspace-level capability that authorizes first materialization.
  UpdateOrCreate,
}

/// Look up the authenticated user for a socket.
/// With the auth middleware in place, the user is always in SOCKET_USER_MAP
/// by the time any event handler runs. Returns `None` only if the socket
/// was disconnected between the event dispatch and this lookup.
pub(super) async fn await_authenticated(socket_id: &str) -> Option<Uuid> {
  SOCKET_USER_MAP.get(socket_id).map(|v| *v)
}

/// Auto-join the space if the socket hasn't explicitly joined yet but the user
/// has access.  Returns `Ok(())` when the socket is (now) a space member, or
/// `Err(message)` when access is denied.  This eliminates the race condition
/// where doc operations arrive before `space:join`.
pub(super) async fn ensure_space_joined(
  state: &Arc<ApiState>,
  socket: &SocketRef,
  user_id: Uuid,
  space_type: SpaceType,
  space_id: &str,
) -> Result<(), String> {
  let space_key = make_space_key(space_type, space_id);
  let socket_id = socket.id.to_string();
  if has_space_membership(&socket_id, &space_key) {
    return Ok(());
  }
  // Not yet joined — check DB permissions
  assert_accessible(state, user_id, space_type, space_id, None, None).await?;
  // User has access — auto-join.
  // SC-H-04: Use the client version from the socket's previous space:join if
  // available, instead of hardcoding a protocol version.
  let client_version = SOCKET_CLIENT_VERSIONS
    .get(&socket_id)
    .map(|v| v.value().clone())
    .unwrap_or_else(|| "0.26.0".to_string());
  let (target_room, other_room) = get_protocol_rooms(space_type, space_id, &client_version);
  socket.leave(other_room);
  socket.join(target_room);
  socket.join(get_room(space_type, space_id, "sync"));
  remember_space_membership(&socket_id, space_key);
  if space_type == SpaceType::Workspace
    && let Ok(ws_id) = Uuid::parse_str(space_id)
  {
    WORKSPACE_SESSIONS.entry(ws_id).or_default().insert(socket_id.clone());
    // SC-M-01: Mirror auto-join to Redis.
    if let Some(adapter) = state.redis_ws_adapter() {
      if let Err(error) = adapter
        .join_workspace(ws_id, &socket_id, user_id, state.config.websocket.ping_interval_seconds)
        .await
      {
        warn!(%ws_id, %error, "workspace membership registration unavailable; analytics will retry");
      }
    }
  }
  info!(%user_id, %space_id, "auto-joined space on doc operation");
  Ok(())
}

pub(super) fn parse_document_key(doc_id: &str) -> Result<DocumentKey, String> {
  DocumentKey::parse(doc_id)
}

/// Verify that `user_id` has access to the given space (and optionally a specific doc).
///
/// For workspaces: checks `WorkspaceAction::Sync` and then applies the explicit
/// event policy through the shared document guard.
/// For userspaces: only the owning user may access their own userspace.
pub(super) async fn assert_accessible(
  state: &ApiState,
  user_id: Uuid,
  space_type: SpaceType,
  space_id: &str,
  doc_id: Option<&str>,
  document_access: Option<DocumentAccess>,
) -> Result<(), String> {
  match space_type {
    SpaceType::Workspace => {
      let ws_uuid = Uuid::parse_str(space_id).map_err(|_| "invalid workspace id")?;
      let pc = state.permission_service();
      pc.assert(
        &WorkspaceResource {
          user_id,
          workspace_id: ws_uuid,
        },
        WorkspaceAction::Sync,
      )
      .await
      .map_err(|e| e.to_string())?;

      if let (Some(did), Some(document_access)) = (doc_id, document_access) {
        let document_key = parse_document_key(did)?;
        let action = match document_access {
          DocumentAccess::Existing(action) => action,
          DocumentAccess::ReadOrNotFound => DocAction::Read,
          DocumentAccess::UpdateOrCreate => DocAction::Update,
        };
        let authorization =
          authorize_workspace_document(state, user_id, ws_uuid, DocSpaceKind::Workspace, &document_key, action).await;
        match (authorization, document_access) {
          (Ok(_), _) => {}
          (Err(AuthError::NotFound(_)), DocumentAccess::ReadOrNotFound) => {
            // Unknown keys contain no payload to authorize. Let the load
            // handler return its stable DOC_NOT_FOUND contract so the sync
            // peer can distinguish an empty remote from an ACL denial.
          }
          (Err(AuthError::NotFound(_)), DocumentAccess::UpdateOrCreate) => {
            // The first acknowledged Yjs push materializes a workspace doc.
            // Until that row exists there is no document ACL to evaluate, so
            // creation uses the workspace capability. Later pushes use Update.
            // `authorize_workspace_document` distinguishes a genuinely unknown
            // key from blocked/deleted rows; broadening this branch would allow
            // a write to resurrect an existing lifecycle record.
            pc.assert(
              &WorkspaceResource {
                user_id,
                workspace_id: ws_uuid,
              },
              WorkspaceAction::CreateDoc,
            )
            .await
            .map_err(|e| e.to_string())?;
          }
          (Err(error), _) => return Err(error.to_string()),
        }
      }
    }
    SpaceType::Userspace => {
      let owner_id = Uuid::parse_str(space_id).map_err(|_| "invalid user id")?;
      if owner_id != user_id {
        return Err("access denied to userspace".into());
      }
    }
  }
  Ok(())
}

/// Consolidated access-check preamble for emitWithAck-style doc handlers.
///
/// Runs the three-step guard chain (`await_authenticated` →
/// `ensure_space_joined` → `assert_accessible`) and emits the standard
/// UNAUTHORIZED / ACCESS_DENIED ack-error + `sync-error` on failure. Callers
/// consume the returned `AckSender` in the success path (it is passed through
/// unchanged so the handler can still respond).
///
/// `log_event` is the event name used in the `"<event> access denied"` warn
/// log; keep it as a `&'static str` literal at the call site so the log line
/// stays bit-identical to the pre-P109 output.
///
/// Extracted from `mod.rs` in P109-B.
#[expect(
  clippy::too_many_arguments,
  reason = "the websocket authorization helper keeps acknowledgement and audit context explicit"
)]
pub(super) async fn check_space_access_with_ack(
  state: &Arc<ApiState>,
  socket: &SocketRef,
  ack: AckSender,
  space_type: SpaceType,
  space_id: &str,
  doc_id: Option<&str>,
  document_access: DocumentAccess,
  log_event: &'static str,
) -> Result<(Uuid, AckSender), ()> {
  let socket_id = socket.id.to_string();
  let user_id = match await_authenticated(&socket_id).await {
    Some(id) => id,
    None => {
      ack
        .send(&json!({ "error": { "name": "UNAUTHORIZED", "message": "not authenticated" } }))
        .ok();
      return Err(());
    }
  };
  if let Err(e) = ensure_space_joined(state, socket, user_id, space_type, space_id).await {
    emit_sync_error(socket, "SpaceAccessDenied", &e, Some(space_id));
    ack
      .send(&json!({ "error": { "name": "ACCESS_DENIED", "message": e } }))
      .ok();
    return Err(());
  }
  if let Err(e) = assert_accessible(state, user_id, space_type, space_id, doc_id, Some(document_access)).await {
    match doc_id {
      Some(did) => warn!(%user_id, space_id = %space_id, doc_id = %did, reason = %e, "{} access denied", log_event),
      None => warn!(%user_id, space_id = %space_id, reason = %e, "{} access denied", log_event),
    }
    emit_sync_error(socket, "SpaceAccessDenied", &e, Some(space_id));
    ack
      .send(&json!({ "error": { "name": "ACCESS_DENIED", "message": e } }))
      .ok();
    return Err(());
  }
  Ok((user_id, ack))
}

/// Same as [`check_space_access_with_ack`] but for fire-and-forget handlers
/// (no `AckSender`). On auth failure returns silently; on space-join /
/// assert-accessible failure emits `sync-error` before returning. Used by
/// `space:delete-doc`.
///
/// Extracted from `mod.rs` in P109-B.
pub(super) async fn check_space_access(
  state: &Arc<ApiState>,
  socket: &SocketRef,
  space_type: SpaceType,
  space_id: &str,
  doc_id: Option<&str>,
  document_access: DocumentAccess,
  log_event: &'static str,
) -> Result<Uuid, ()> {
  let socket_id = socket.id.to_string();
  let user_id = match await_authenticated(&socket_id).await {
    Some(id) => id,
    None => return Err(()),
  };
  if let Err(e) = ensure_space_joined(state, socket, user_id, space_type, space_id).await {
    emit_sync_error(socket, "SpaceAccessDenied", &e, Some(space_id));
    return Err(());
  }
  if let Err(e) = assert_accessible(state, user_id, space_type, space_id, doc_id, Some(document_access)).await {
    match doc_id {
      Some(did) => warn!(%user_id, space_id = %space_id, doc_id = %did, reason = %e, "{} access denied", log_event),
      None => warn!(%user_id, space_id = %space_id, reason = %e, "{} access denied", log_event),
    }
    emit_sync_error(socket, "SpaceAccessDenied", &e, Some(space_id));
    return Err(());
  }
  Ok(user_id)
}
