// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authoritative MCP tool discovery registry.
//!
//! Handlers remain in `tools.rs` and its domain modules; every discovery and
//! policy attribute lives here. The registry is the only source used for
//! listing, scope visibility, optional-service visibility, observability and
//! audit classification.

use std::sync::LazyLock;

use base64::Engine;
use rmcp::model::{ListToolsResult, Tool, ToolAnnotations};
use serde_json::{Map, Value, json};

use crate::auth::McpAuthContext;
use crate::protocol::McpToolError;
/// Input schemas and public descriptions consumed during the registry's
/// one-time build. Callers must use [`tools`] or [`list_tools`] so policy and
/// service visibility cannot be bypassed.
fn user_tool_definitions() -> Vec<Value> {
  json!([
      {"name": "user_list", "description": "Lists public account details in deterministic bounded offset pages. Requires an active global administrator.", "inputSchema": {"type": "object", "required": [], "additionalProperties": false, "properties": {"offset": {"type": "integer", "minimum": 0, "maximum": (i64::MAX - 100), "default": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}, "keyword": {"type": ["string", "null"], "maxLength": 255}}}},
      {"name": "user_get", "description": "Returns public account details by one UUID or exact normalized email. Requires an active global administrator.", "inputSchema": {"type": "object", "required": ["id_or_email"], "additionalProperties": false, "properties": {"id_or_email": {"type": "string", "minLength": 1, "maxLength": 255}}}},
      {"name": "user_create", "description": "Creates a passwordless account and canonical personal workspace. Partial failure is fail-closed; do not retry with a new key or automatically repair.", "inputSchema": {"type": "object", "required": ["email", "idempotency_key"], "additionalProperties": false, "properties": {"email": {"type": "string", "maxLength": 255}, "name": {"type": ["string", "null"], "maxLength": 255}, "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 160}}}},
      {"name": "user_update", "description": "Patches email/name through the shared owner; omitted or null fields retain their values.", "inputSchema": {"type": "object", "required": ["user_id", "idempotency_key"], "additionalProperties": false, "properties": {"user_id": {"type": "string", "format": "uuid"}, "email": {"type": ["string", "null"], "maxLength": 255}, "name": {"type": ["string", "null"], "maxLength": 255}, "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 160}}}},
      {"name": "user_suspend", "description": "Atomically suspends the account and revokes sessions and MCP keys. Self-suspension returns its commit and invalidates the caller key.", "inputSchema": {"type": "object", "required": ["user_id", "idempotency_key"], "additionalProperties": false, "properties": {"user_id": {"type": "string", "format": "uuid"}, "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 160}}}},
      {"name": "user_enable", "description": "Enables fresh authentication without restoring revoked sessions or keys.", "inputSchema": {"type": "object", "required": ["user_id", "idempotency_key"], "additionalProperties": false, "properties": {"user_id": {"type": "string", "format": "uuid"}, "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 160}}}},
      {"name":"user_delete","description":"Permanently deletes the explicit operational account, its credentials and sole-owner workspaces/content; its UUID/display name remain only for historical attribution. Shared workspaces and author/creator references remain with surviving members under the existing ownerless principal. Requires confirmed_user_id equal to user_id, a current active global administrator and a replay key. Self-deletion returns the committed result without recreating its key or receipt; later bearer requests are denied.","inputSchema":{"type":"object","additionalProperties":false,"required":["user_id","confirmed_user_id","idempotency_key"],"properties":{"user_id":{"type":"string","format":"uuid"},"confirmed_user_id":{"type":"string","format":"uuid"},"idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}},
      {"name":"user_set_admin","description":"Sets the existing Admin flag through the shared auth transaction and snapshot refresh, retaining sessions and keys. Requires a current active global administrator and a replay key; self-demotion completes but denies later privileged calls and replays.","inputSchema":{"type":"object","additionalProperties":false,"required":["user_id","is_admin","idempotency_key"],"properties":{"user_id":{"type":"string","format":"uuid"},"is_admin":{"type":"boolean"},"idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}},
      {"name": "user_reset_link", "description": "Returns an authorized one-time reset link and its persisted expiry. Replay returns that same secret result without refreshing expired or consumed links.", "inputSchema": {"type": "object", "required": ["user_id", "idempotency_key"], "additionalProperties": false, "properties": {"user_id": {"type": "string", "format": "uuid"}, "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 160}}}}
  ]).as_array().expect("user definitions").clone()
}

fn organization_read_definitions() -> Vec<Value> {
  ["organization_get", "organization_unit_type_list", "organization_unit_member_list", "user_organization_memberships"].into_iter().map(|name| {
    let mut properties=Map::new();
    let mut required=Vec::new();
    if name!="organization_get" {
      properties.insert("offset".into(),json!({"type":"integer","minimum":0,"maximum":(i64::MAX-101),"default":0}));
      properties.insert("limit".into(),json!({"type":"integer","minimum":1,"maximum":100,"default":20}));
      properties.insert("include_inactive".into(),json!({"type":"boolean","default":false}));
    }
    if name=="organization_unit_member_list" {
      required.push("unit_id");properties.insert("unit_id".into(),json!({"type":"string","format":"uuid"}));
      properties.insert("role".into(),json!({"type":["string","null"],"enum":["reader","member","manager",null]}));
    }
    if name=="user_organization_memberships" {required.push("user_id");properties.insert("user_id".into(),json!({"type":"string","format":"uuid"}));}
    json!({"name":name,"description":"Discovers persisted organization data through the shared read owner. Requires a current active global administrator; pages default to 20 and allow at most 100 items, with explicit inactive diagnostics.","inputSchema":{"type":"object","additionalProperties":false,"required":required,"properties":properties}})
  }).collect()
}

fn organization_membership_definitions() -> Vec<Value> {
  ["organization_unit_member_add", "organization_unit_member_set_role", "organization_unit_member_remove"].into_iter().map(|name| {
    let mut properties = Map::from_iter([
      ("unit_id".into(), json!({"type":"string","format":"uuid"})),
      ("user_id".into(), json!({"type":"string","format":"uuid"})),
      ("idempotency_key".into(), json!({"type":"string","minLength":1,"maxLength":160})),
    ]);
    if name != "organization_unit_member_remove" { properties.insert("role".into(), json!({"type":"string","enum":["reader","member","manager"]})); }
    let required = properties.keys().cloned().collect::<Vec<_>>();
    json!({"name":name,"description":"Changes one manual OU membership through the shared transactional owner. Add requires absence; set-role/remove require an existing membership. Derived Manager capability and cache effects follow the commit. Requires a current active global administrator and replay key; creates no user or workspace membership.","inputSchema":{"type":"object","additionalProperties":false,"required":required,"properties":properties}})
  }).collect()
}

fn comment_create_definition() -> Value {
  json!({"name":"comment_create","description":"Creates a canonical comment or reply through the shared Comment/Blob owners. Requires current CommentsCreate and a durable replay key. Parent and attachment IDs must belong to the external document. The complete input respects the configured document byte limit. Attachments and anchor persistence follow the atomic comment/notification commit; partial failures retain uncertain admission and must not be retried with a new key. Identical authorized replay returns the original result without recreating effects. An anchor without doc_text retains the existing no-anchor behavior.","inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","external_id","body","idempotency_key"],"properties":{
    "workspace_id":{"type":"string","format":"uuid"},"external_id":{"type":"string","minLength":1,"maxLength":512},
    "body":{"type":["object","array","string","number","boolean","null"],"description":"Canonical comment JSON; no Markdown conversion. The complete input is bounded by the configured document export byte limit."},
    "parent_comment_id":{"type":["string","null"],"format":"uuid"},
    "attachment_keys":{"type":["array","null"],"maxItems":100,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":1024}},
    "selection_anchor":{"type":["object","null"],"additionalProperties":false,"required":["quote"],"properties":{"quote":{"type":"string","minLength":1,"maxLength":8192},"start":{"type":["integer","null"],"minimum":0,"maximum":i32::MAX},"end":{"type":["integer","null"],"minimum":0,"maximum":i32::MAX},"prefix":{"type":["string","null"],"maxLength":8192},"suffix":{"type":["string","null"],"maxLength":8192}}},
    "doc_text":{"type":["string","null"],"maxLength":(8*1024*1024)},
    "idempotency_key":{"type":"string","minLength":1,"maxLength":160}
  }}})
}

fn comment_create_output_schema() -> Value {
  json!({"type":"object","additionalProperties":false,"required":["workspaceId","externalId","commentId","parentCommentId","created","attachmentKeys","selectionAnchor"],"properties":{
    "workspaceId":{"type":"string","format":"uuid"},"externalId":{"type":"string","minLength":1,"maxLength":512},"commentId":{"type":"string","format":"uuid"},"parentCommentId":{"type":["string","null"],"format":"uuid"},"created":{"type":"boolean","const":true},
    "attachmentKeys":{"type":"array","maxItems":100,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":1024}},
    "selectionAnchor":{"type":["object","null"],"additionalProperties":false,"required":["quote","start","end","strategy"],"properties":{"quote":{"type":"string","maxLength":8192},"start":{"type":"integer","minimum":0},"end":{"type":"integer","minimum":0},"strategy":{"type":"string","enum":["direct_range","nearby_quote_search","global_quote_search","context_boundary_search"]}}}
  }})
}

fn comment_lifecycle_definitions() -> Vec<Value> {
  ["comment_update", "comment_set_resolved", "comment_delete", "comment_thread_mark_read", "comment_threads_mark_all_read"].into_iter().map(|name| {
    let mut properties = Map::from_iter([
      ("workspace_id".into(), json!({"type":"string","format":"uuid"})),
      ("external_id".into(), json!({"type":"string","minLength":1,"maxLength":512})),
      ("idempotency_key".into(), json!({"type":"string","minLength":1,"maxLength":160})),
    ]);
    if name != "comment_threads_mark_all_read" { properties.insert("comment_id".into(), json!({"type":"string","format":"uuid"})); }
    if name == "comment_update" { properties.insert("body".into(), json!({"type":["object","array","string","number","boolean","null"],"description":"Canonical comment JSON, bounded by the configured document byte limit."})); }
    if name == "comment_set_resolved" { properties.insert("resolved".into(), json!({"type":"boolean"})); }
    let required = properties.keys().cloned().collect::<Vec<_>>();
    json!({"name":name,"description":"Delegates to the shared Comment lifecycle/read-state owner after current document binding and authorization, before durable replay. Update/delete/resolve preserve the original-author CommentsCreate fallback. Delete is soft deletion; resolved=false reopens. Read-state writes require current CommentsRead and affect only the key owner: a single ID must be a live top-level thread, and bulk marking covers every live thread in this document without a page limit. Requires write:docs and a durable replay key; uncertain outcomes require operator readback, never a new key.","inputSchema":{"type":"object","additionalProperties":false,"required":required,"properties":properties}})
  }).collect()
}

fn comment_lifecycle_output_schema(name: &str) -> Value {
  let mut properties = Map::from_iter([
    ("workspaceId".into(), json!({"type":"string","format":"uuid"})),
    (
      "externalId".into(),
      json!({"type":"string","minLength":1,"maxLength":512}),
    ),
  ]);
  if name != "comment_threads_mark_all_read" {
    properties.insert("commentId".into(), json!({"type":"string","format":"uuid"}));
  }
  let flag = match name {
    "comment_update" => "updated",
    "comment_set_resolved" => "resolved",
    "comment_delete" => "deleted",
    _ => "markedRead",
  };
  if name == "comment_threads_mark_all_read" {
    properties.insert(
      "affectedThreads".into(),
      json!({"type":"integer","minimum":0,"maximum":i64::MAX}),
    );
  } else {
    properties.insert(flag.into(), json!({"type":"boolean"}));
  }
  if name == "comment_thread_mark_read" || name == "comment_threads_mark_all_read" {
    properties.insert("userId".into(), json!({"type":"string","format":"uuid"}));
  }
  let required = properties.keys().cloned().collect::<Vec<_>>();
  json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
}

fn comment_tool_definitions() -> Vec<Value> {
  ["comment_thread_list", "comment_reply_list", "comment_history_list"].into_iter().map(|name| {
    let mut properties = Map::from_iter([
      ("workspace_id".into(), json!({"type":"string","format":"uuid"})),
      ("external_id".into(), json!({"type":"string","minLength":1,"maxLength":512})),
      ("offset".into(), json!({"type":"integer","minimum":0,"maximum":(i64::MAX-200),"default":0})),
      ("limit".into(), json!({"type":"integer","minimum":1,"maximum":200,"default":50})),
    ]);
    let mut required=vec!["workspace_id","external_id"];
    match name {
      "comment_thread_list" => {properties.insert("filter".into(),json!({"type":"string","enum":["all","open","resolved","mine"],"default":"all"}));},
      _ => {let key=if name=="comment_reply_list" {"parent_comment_id"}else{"comment_id"};required.push(key);properties.insert(key.into(),json!({"type":"string","format":"uuid"}));}
    }
    json!({"name":name,"description":"Reads canonical persisted comments through current CommentsRead authority. IDs are bound to the workspace-local external document key. Filters precede bounded offset pagination; a full page may advertise an empty final page. Output is bounded by the document export byte limit; use a smaller limit if exceeded. Historical attribution includes UUID/display name only.","inputSchema":{"type":"object","additionalProperties":false,"required":required,"properties":properties}})
  }).collect()
}

fn comment_output_schema(name: &str) -> Value {
  let author = json!({"type":"object","additionalProperties":false,"required":["id","name"],"properties":{"id":{"type":"string","format":"uuid"},"name":{"type":["string","null"]}}});
  let body = json!({"type":["object","array","string","number","boolean","null"],"description":"Canonical persisted comment JSON without format conversion."});
  let mut properties = Map::from_iter([
    ("workspaceId".into(), json!({"type":"string","format":"uuid"})),
    (
      "externalId".into(),
      json!({"type":"string","minLength":1,"maxLength":512}),
    ),
    (
      "offset".into(),
      json!({"type":"integer","minimum":0,"maximum":(i64::MAX-200)}),
    ),
    ("limit".into(), json!({"type":"integer","minimum":1,"maximum":200})),
    ("next_offset".into(), json!({"type":["integer","null"],"minimum":0})),
  ]);
  let list;
  let item;
  if name == "comment_history_list" {
    list = "history";
    properties.insert("commentId".into(), json!({"type":"string","format":"uuid"}));
    item = json!({"type":"object","additionalProperties":false,"required":["id","body","editor","editedAt"],"properties":{"id":{"type":"integer"},"body":body,"editor":author,"editedAt":{"type":"string","format":"date-time"}}});
  } else {
    let mut fields = Map::from_iter([
      ("id".into(), json!({"type":"string","format":"uuid"})),
      (
        "parentCommentId".into(),
        json!({"type":["string","null"],"format":"uuid"}),
      ),
      ("author".into(), author),
      ("body".into(), body),
      ("resolved".into(), json!({"type":"boolean"})),
      ("createdAt".into(), json!({"type":"string","format":"date-time"})),
      ("updatedAt".into(), json!({"type":"string","format":"date-time"})),
    ]);
    if name == "comment_thread_list" {
      list = "threads";
      properties.insert(
        "filter".into(),
        json!({"type":"string","enum":["all","open","resolved","mine"]}),
      );
      fields.insert("readAt".into(), json!({"type":["string","null"],"format":"date-time"}));
      fields.insert("unread".into(), json!({"type":"boolean"}));
    } else {
      list = "replies";
      properties.insert("parentCommentId".into(), json!({"type":"string","format":"uuid"}));
    }
    let required = fields.keys().cloned().collect::<Vec<_>>();
    item = json!({"type":"object","additionalProperties":false,"required":required,"properties":fields});
  }
  properties.insert(list.into(), json!({"type":"array","maxItems":200,"items":item}));
  let required = properties.keys().cloned().collect::<Vec<_>>();
  json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
}

fn raw_tool_definitions() -> Value {
  let mut definitions = json!({
    "tools": [
      {
        "name": "organization_unit_list",
        "description": "Lists organization units for the default organization. Active units are returned unless an explicit diagnostic status filter is supplied.",
        "inputSchema": {
          "type": "object", "additionalProperties": false,
          "properties": { "status": { "type": "string", "enum": ["active", "disabled", "archived", "all"], "default": "active" } }
        }
      },
      {
        "name": "organization_unit_get",
        "description": "Returns one organization unit by ID.",
        "inputSchema": {
          "type": "object", "required": ["unit_id"], "additionalProperties": false,
          "properties": { "unit_id": { "type": "string", "format": "uuid" } }
        }
      },
      {
        "name": "organization_unit_delete_preview",
        "description": "Returns the revision-bound permanent-deletion preview and all structured blockers for one organization unit.",
        "inputSchema": {
          "type": "object", "required": ["unit_id"], "additionalProperties": false,
          "properties": { "unit_id": { "type": "string", "format": "uuid" } }
        }
      },
      {
        "name": "organization_unit_create",
        "description": "Creates an organization unit through the guarded lifecycle service.",
        "inputSchema": {
          "type": "object", "required": ["unit_type_id", "name", "slug", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "unit_id": { "type": "string", "format": "uuid" },
            "parent_unit_id": { "type": ["string", "null"], "format": "uuid" },
            "unit_type_id": { "type": "string", "format": "uuid" },
            "name": { "type": "string", "minLength": 1, "maxLength": 512 },
            "slug": { "type": "string", "minLength": 1, "maxLength": 256 },
            "description": { "type": ["string", "null"], "maxLength": 4096 },
            "status": { "type": "string", "enum": ["active", "disabled", "archived"], "default": "active" },
            "metadata": { "type": "object" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "organization_unit_update",
        "description": "Updates organization-unit fields atomically through the guarded lifecycle service.",
        "inputSchema": {
          "type": "object", "required": ["unit_id", "idempotency_key"], "additionalProperties": false,
          "anyOf": [
            { "required": ["name"] }, { "required": ["slug"] }, { "required": ["description"] },
            { "required": ["unit_type_id"] }, { "required": ["parent_unit_id"] },
            { "required": ["status"] }, { "required": ["metadata"] }
          ],
          "properties": {
            "unit_id": { "type": "string", "format": "uuid" },
            "parent_unit_id": { "type": ["string", "null"], "format": "uuid" },
            "unit_type_id": { "type": "string", "format": "uuid" },
            "name": { "type": "string", "minLength": 1, "maxLength": 512 },
            "slug": { "type": "string", "minLength": 1, "maxLength": 256 },
            "description": { "type": ["string", "null"], "maxLength": 4096 },
            "status": { "type": "string", "enum": ["active", "disabled", "archived"] },
            "metadata": { "type": "object" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "organization_unit_move",
        "description": "Moves an organization unit under an active parent or to an allowed root position.",
        "inputSchema": {
          "type": "object", "required": ["unit_id", "parent_unit_id", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "unit_id": { "type": "string", "format": "uuid" },
            "parent_unit_id": { "type": ["string", "null"], "format": "uuid" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "organization_unit_set_status",
        "description": "Transitions an organization unit through the guarded active, disabled and archived lifecycle.",
        "inputSchema": {
          "type": "object", "required": ["unit_id", "status", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "unit_id": { "type": "string", "format": "uuid" },
            "status": { "type": "string", "enum": ["active", "disabled", "archived"] },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "organization_unit_delete_permanent",
        "description": "Permanently deletes an inactive, unreferenced organization unit after exact name and preview-revision confirmation.",
        "inputSchema": {
          "type": "object", "required": ["unit_id", "confirmed_name", "preview_revision", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "unit_id": { "type": "string", "format": "uuid" },
            "confirmed_name": { "type": "string", "minLength": 1 },
            "preview_revision": { "type": "string", "format": "date-time" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "calendar_events_list",
        "description": "Lists calendar events that overlap a bounded workspace time window. Windows may span at most 93 days and result sets above 500 events must be narrowed.",
        "inputSchema": {
          "type": "object", "required": ["workspace_id", "from", "to"], "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "from": { "type": "string", "format": "date-time", "description": "Inclusive RFC 3339 timestamp with offset." },
            "to": { "type": "string", "format": "date-time", "description": "Exclusive RFC 3339 timestamp with offset." }
          }
        }
      },
      {
        "name": "calendar_conflicts_check",
        "description": "Returns native and external events that overlap a proposed bounded time window, optionally excluding one event.",
        "inputSchema": {
          "type": "object", "required": ["workspace_id", "from", "to"], "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "from": { "type": "string", "format": "date-time" },
            "to": { "type": "string", "format": "date-time" },
            "exclude_event_id": { "type": ["string", "null"], "format": "uuid" }
          }
        }
      },
      {
        "name": "calendar_event_create",
        "description": "Creates a workspace-native calendar event through NativeEventService. Timestamps must be RFC 3339 values with an explicit offset.",
        "inputSchema": {
          "type": "object", "required": ["workspace_id", "starts_at", "ends_at", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "title": { "type": ["string", "null"], "maxLength": 1024 },
            "description_delta": { "type": ["object", "array", "null"] },
            "starts_at": { "type": "string", "format": "date-time" },
            "ends_at": { "type": "string", "format": "date-time" },
            "all_day": { "type": "boolean", "default": false },
            "all_members": { "type": "boolean", "default": false },
            "tag_id": { "type": ["string", "null"], "format": "uuid" },
            "source_external_id": { "type": ["string", "null"] },
            "reminders": {
              "type": "array", "maxItems": 20,
              "items": {
                "type": "object", "required": ["minutes_before"], "additionalProperties": false,
                "properties": {
                  "minutes_before": { "type": "integer", "minimum": 0 },
                  "channel": { "type": "string", "enum": ["in_app", "email", "push"], "default": "in_app" }
                }
              }
            },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "calendar_event_update",
        "description": "Updates a native event or one recurring occurrence through NativeEventService. External events are read-only.",
        "inputSchema": {
          "type": "object", "required": ["workspace_id", "event_id", "idempotency_key"], "additionalProperties": false,
          "anyOf": [
            { "required": ["title"] }, { "required": ["description_delta"] },
            { "required": ["starts_at"] }, { "required": ["ends_at"] },
            { "required": ["all_day"] }, { "required": ["all_members"] },
            { "required": ["tag_id"] }, { "required": ["source_external_id"] },
            { "required": ["reminders"] }
          ],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "event_id": { "type": "string", "format": "uuid" },
            "scope": { "type": "string", "enum": ["all", "this"], "default": "all" },
            "instance_start": { "type": ["string", "null"], "format": "date-time" },
            "title": { "type": ["string", "null"], "maxLength": 1024 },
            "description_delta": { "type": ["object", "array", "null"] },
            "starts_at": { "type": "string", "format": "date-time" },
            "ends_at": { "type": "string", "format": "date-time" },
            "all_day": { "type": "boolean" },
            "all_members": { "type": "boolean" },
            "tag_id": { "type": ["string", "null"], "format": "uuid" },
            "source_external_id": { "type": ["string", "null"] },
            "reminders": {
              "type": ["array", "null"], "maxItems": 20,
              "items": {
                "type": "object", "required": ["minutes_before"], "additionalProperties": false,
                "properties": {
                  "minutes_before": { "type": "integer", "minimum": 0 },
                  "channel": { "type": "string", "enum": ["in_app", "email", "push"], "default": "in_app" }
                }
              }
            },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "calendar_event_delete",
        "description": "Deletes a native event series or excludes one recurring occurrence through NativeEventService. External events are read-only.",
        "inputSchema": {
          "type": "object", "required": ["workspace_id", "event_id", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "event_id": { "type": "string", "format": "uuid" },
            "scope": { "type": "string", "enum": ["all", "this"], "default": "all" },
            "instance_start": { "type": ["string", "null"], "format": "date-time" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "list_workspaces",
        "description": "Returns all workspaces the authenticated user is a member of.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
          }
        }
      },
      {
        "name": "list_pages",
        "description": "Lists pages in a workspace. Supports cursor-based pagination — pass the `next_cursor` from a previous response to fetch the next page.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "cursor":       { "type": "string", "description": "Opaque pagination cursor from a previous response" },
            "limit":        { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
          }
        }
      },
      {
        "name": "read_doc",
        "description": "Reads canonical Yjs as structured content by default or an explicit export. Start with an outline/selected section and doc_metadata_get; inspect completeness and follow structured cursors. Markdown can opt into runtime OKF frontmatter. Use the observed content revision for doc_patch; never replace a whole document from partial output.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id":  { "type": "string" },
            "representation": { "type": "string", "enum": ["structured", "html", "markdown", "plain_text", "raw_yjs"], "default": "structured" },
            "include_okf_frontmatter": { "type": "boolean", "default": false, "description": "Markdown only: generate OKF metadata from current native facts and retained imports; no metadata or analytics writes. Content and metadata revisions are independent." },
            "format":       { "type": "string", "enum": ["markdown", "plain_text", "raw_yjs"], "description": "Deprecated compatibility alias. Do not combine with representation." },
            "cursor":       { "type": "string", "description": "Opaque nextCursor returned by a previous structured page." },
            "block_id": { "type": "string", "minLength": 1, "description": "Native content block and descendants; mutually exclusive with heading_block_id and outline. Structured only." },
            "heading_block_id": { "type": "string", "minLength": 1, "description": "Section from this heading through the next heading of equal or higher level. Structured only." },
            "outline": { "const": true, "description": "Headings only, in document order. Structured only." },
            "neighbor_context": { "type": "integer", "minimum": 0, "maximum": 10, "description": "Optional preceding/following content blocks for block or section selections." },
            "limit":        { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
          },
          "allOf": [
            { "if": { "required": ["include_okf_frontmatter"] }, "then": { "required": ["representation"], "properties": { "representation": { "const": "markdown" } } } },
            { "not": { "required": ["block_id", "heading_block_id"] } },
            { "not": { "required": ["block_id", "outline"] } },
            { "not": { "required": ["heading_block_id", "outline"] } },
            { "if": { "anyOf": [{ "required": ["block_id"] }, { "required": ["heading_block_id"] }, { "required": ["outline"] }] },
              "then": { "not": { "required": ["format"] }, "properties": { "representation": { "const": "structured" } } } },
            { "if": { "required": ["neighbor_context"] }, "then": { "oneOf": [{ "required": ["block_id"] }, { "required": ["heading_block_id"] }] } }
          ]
        }
      },
      {
        "name": "search_docs",
        "description": "Full-text search across a workspace's indexed documents, with current available native type, tags and modification facts. Description is separate from query snippets; indexed summaries carry their index timestamp. updated_at is the index timestamp, never verification. total_count counts returned results; follow next_cursor until exhausted.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "query"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "query":        { "type": "string", "minLength": 1, "maxLength": 500 },
            "limit":        { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
            "language":     { "type": "string", "description": "BCP-47 language tag" },
            "cursor":       { "type": "string", "description": "Opaque next_cursor from the same query, language, workspace and user." }
          }
        }
      },
      {
        "name": "create_page",
        "description": "Creates a native page atomically with optional typed content. Select a workspace and search_docs before creating. Use an idempotency key and strict_loss=true for conversion; an opening summary and explicit citation footnotes supply projected description/sources. Frontmatter is generated on reads, not a body prefix. Requires write:docs and current workspace CreateDoc.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "title"],
          "allOf": [{ "not": { "required": ["fragment", "content_markdown"] } }],
          "properties": {
            "workspace_id":       { "type": "string", "format": "uuid" },
            "title":              { "type": "string", "minLength": 1, "maxLength": 1024 },
            "fragment":           { "$ref": "#/$defs/documentFragment" },
            "content_markdown":   { "type": "string", "maxLength": 1048576 }
          },
          "$defs": {
            "documentFragment": {
              "type": "object",
              "required": ["blocks"],
              "properties": { "blocks": { "type": "array", "items": { "type": "object" } } }
            }
          }
        }
      },
      {
        "name": "update_doc",
        "description": "Destructively replaces all document blocks through the canonical semantic mutation service. Requires `write:docs`, document Update permission, an idempotency key and explicit replace-all confirmation. A recovery history point is created atomically before the write.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id", "idempotency_key", "confirm_replace_all"],
          "oneOf": [{ "required": ["fragment"] }, { "required": ["content_markdown"] }],
          "properties": {
            "workspace_id":     { "type": "string", "format": "uuid" },
            "external_id":      { "type": "string" },
            "fragment":         { "$ref": "#/$defs/documentFragment" },
            "content_markdown": { "type": "string", "maxLength": 1048576, "description": "Deprecated input boundary normalized into DocumentFragment before mutation." },
            "confirm_replace_all": { "const": true, "description": "Required destructive-operation confirmation." },
            "expected_revision": { "type": "integer", "minimum": 0, "description": "Optional current document revision from read_doc; stale writes fail with a conflict." },
            "idempotency_key":  { "type": "string", "minLength": 1, "maxLength": 160 }
          },
          "$defs": {
            "documentFragment": {
              "type": "object",
              "required": ["blocks"],
              "properties": {
                "blocks": { "type": "array", "items": { "type": "object", "required": ["type"] } }
              }
            }
          }
        }
      },
      document_patch_tool_definition(),
      {
        "name": "delete_page",
        "description": "Soft-deletes a page. Requires `write:docs` scope and document Trash permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id":  { "type": "string" }
          }
        }
      },
      {
        "name": "restore_page",
        "description": "Restores a soft-deleted page through the atomic page lifecycle. Requires `write:docs` scope and document Restore permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id":  { "type": "string" }
          }
        }
      },
      {
        "name": "page_projection_scan",
        "description": "Scans one bounded page of SQL, root-only, or leaf-only projection presence without decoding page content. Requires read:docs scope and workspace membership.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "cursor": { "type": "string", "minLength": 1 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
          }
        }
      },
      {
        "name": "page_projection_inspect",
        "description": "Inspects exactly one workspace-local external document key and decodes at most its one selected leaf. Requires read:docs scope and workspace membership.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_doc_id"],
          "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_doc_id": { "type": "string", "minLength": 1 }
          }
        }
      },
      {
        "name": "page_projection_repair",
        "description": "Previews or atomically repairs exactly one fingerprinted external document projection. Defaults to dry_run and never scans or repairs a batch.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_doc_id", "fingerprint", "idempotency_key"],
          "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_doc_id": { "type": "string", "minLength": 1 },
            "fingerprint": { "type": "string", "minLength": 1 },
            "mode": { "type": "string", "enum": ["dry_run", "apply"], "default": "dry_run" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "folder_tree",
        "description": "Returns the ordered workspace folder tree and permission-filtered folder entries in one compact call. Document entries use workspace-local external IDs.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "max_depth": { "type": "integer", "minimum": 1, "maximum": 32, "default": 32 }
          }
        }
      },
      {
        "name": "folder_list",
        "description": "Lists workspace folders, optionally below one parent folder. Requires `read:docs` scope and workspace membership.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "parent_id": { "type": ["string", "null"], "description": "Optional parent folder id. Use null for root folders." }
          }
        }
      },
      {
        "name": "folder_create",
        "description": "Creates a workspace folder at the root or below one parent folder. Requires `write:docs` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "name"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "name": { "type": "string", "minLength": 1, "maxLength": 256 },
            "parent_id": { "type": ["string", "null"], "description": "Parent folder id, or null/omitted to create at root." },
            "index": { "type": "string", "description": "Validated fractional ordering key. Omit to append with a server-generated key." }
          }
        }
      },
      {
        "name": "folder_update",
        "description": "Renames and/or moves a workspace folder. Requires `write:docs` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "folder_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "folder_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 256 },
            "parent_id": { "type": ["string", "null"], "description": "New parent folder id. Null moves to root." },
            "index": { "type": "string", "description": "New lexicographic ordering key." }
          }
        }
      },
      {
        "name": "folder_delete",
        "description": "Deletes a workspace folder and all nested folder entries without deleting their linked resources. Requires `write:docs` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "folder_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "folder_id": { "type": "string", "minLength": 1 }
          }
        }
      },
      {
        "name": "folder_entry_list",
        "description": "Lists document, database, collection, tag and workspace entries in folders. Requires `read:docs` scope and workspace membership.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "parent_id": { "type": "string", "description": "Optional containing folder id." },
            "target_type": { "type": "string", "enum": ["doc", "database", "collection", "tag", "workspace"], "description": "Optional entry target type filter." }
          }
        }
      },
      {
        "name": "folder_entry_create",
        "description": "Creates a document, database, collection, tag or workspace entry inside a folder. Requires `write:docs` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "parent_id", "target_type", "target_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "parent_id": { "type": "string", "minLength": 1 },
            "target_type": { "type": "string", "enum": ["doc", "database", "collection", "tag", "workspace"] },
            "target_id": { "type": "string", "minLength": 1 },
            "target_workspace_id": { "type": "string", "format": "uuid", "description": "Required for workspace links and cross-workspace targets; omitted for local legacy-compatible links." },
            "index": { "type": "string", "description": "Validated fractional ordering key. Omit to append with a server-generated key." }
          }
        }
      },
      {
        "name": "folder_entry_update",
        "description": "Moves or retargets a folder entry. Requires `write:docs` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "entry_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "entry_id": { "type": "string", "minLength": 1 },
            "parent_id": { "type": "string", "minLength": 1 },
            "target_type": { "type": "string", "enum": ["doc", "database", "collection", "tag", "workspace"] },
            "target_id": { "type": "string", "minLength": 1 },
            "target_workspace_id": { "type": ["string", "null"], "format": "uuid", "description": "Explicit target workspace, or null to restore local legacy-compatible semantics." },
            "index": { "type": "string", "description": "New lexicographic ordering key." }
          }
        }
      },
      {
        "name": "folder_entry_delete",
        "description": "Deletes a folder entry without deleting its linked resource. Requires `write:docs` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "entry_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "entry_id": { "type": "string", "minLength": 1 }
          }
        }
      },
      {
        "name": "blob_list",
        "description": "Lists workspace blob metadata without returning blob bytes. Requires `read:docs` scope and workspace BlobsList permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
            "offset": { "type": "integer", "minimum": 0, "default": 0 },
            "include_deleted": { "type": "boolean", "default": false }
          }
        }
      },
      {
        "name": "blob_get_metadata",
        "description": "Returns metadata for one workspace blob. Requires `read:docs` scope and workspace BlobsRead permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "key"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "key": { "type": "string", "minLength": 1 }
          }
        }
      },
      {
        "name": "blob_read",
        "description": "Reads a small completed workspace blob as base64. Requires `read:docs` scope and workspace BlobsRead permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "key"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "key": { "type": "string", "minLength": 1 },
            "max_bytes": { "type": "integer", "minimum": 1, "maximum": 5242880, "default": 1048576 }
          }
        }
      },
      {
        "name": "blob_upload",
        "description": "Uploads one small workspace blob from base64 data through the existing blob service and MIME policy. Requires `write:docs` scope and workspace BlobsWrite permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "key", "mime", "dataBase64"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "key": { "type": "string", "minLength": 1 },
            "mime": { "type": "string", "minLength": 1 },
            "dataBase64": { "type": "string", "minLength": 1 }
          }
        }
      },
      {
        "name": "document_asset_upload_prepare",
        "description": "Prepares a direct signed upload for one content-addressed document asset without transporting bytes through MCP. Matching retries retain the same asset reference and receive a fresh URL until upload completes.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "filename", "mime", "byte_size", "sha256"],
          "additionalProperties": false,
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "filename": { "type": "string", "minLength": 1, "maxLength": 255 },
            "mime": { "type": "string", "minLength": 1 },
            "byte_size": { "type": "integer", "minimum": 1 },
            "sha256": { "type": "string", "pattern": "^[A-Fa-f0-9]{64}$" }
          }
        }
      },
      {
        "name": "blob_delete",
        "description": "Deletes a workspace blob by key. Defaults to soft-delete; `permanently` performs the same hard-delete path as the existing blob service. Requires `write:docs` scope and workspace BlobsWrite permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "key"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "key": { "type": "string", "minLength": 1 },
            "permanently": { "type": "boolean", "default": false }
          }
        }
      },
      {
        "name": "template_list_for_workspace",
        "description": "Read-only builtin provisioning diagnostic for a workspace, including whether each builtin instance is missing or stale. It does not list user document templates.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "locale": { "type": "string", "default": "en", "description": "BCP-47 locale key for hash computation" }
          }
        }
      },
      {
        "name": "template_request_reconcile",
        "description": "Read-only builtin reconcile diagnostic. Reports missing or stale builtin instances but never marks, enqueues or rebuilds anything.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "locale": { "type": "string", "default": "en" }
          }
        }
      },
      {
        "name": "pdf_template_list",
        "description": "Lists the PDF-Export templates available to a workspace (only those explicitly assigned via admin GraphQL). Read-only; requires workspace membership and `read:workspaces` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" }
          }
        }
      },
      {
        "name": "database_list",
        "description": "Lists server-backed Databases in a workspace. Requires `read:databases` scope and workspace read permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
            "offset": { "type": "integer", "minimum": 0, "default": 0 }
          }
        }
      },
      {
        "name": "database_query",
        "description": "Reads one Database with fields, views and a bounded page of ACL-redacted rows. An optional saved view supplies server-owned filters and sorting; search and opaque cursor pagination use the same DatabaseRowsQuery contract. Requires `read:databases` scope.",
        "inputSchema": {
          "type": "object", "additionalProperties": false,
          "required": ["database_id"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "view_id": { "type": "string", "format": "uuid" },
            "search": { "type": "string" },
            "cursor": { "type": "string", "description": "Opaque nextCursor returned by a previous database_query call." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
            "offset": { "type": "integer", "minimum": 0, "default": 0, "description": "Compatibility pagination used only when cursor is absent." }
          }
        }
      },
      {
        "name": "database_csv_export",
        "description": "Exports a Database as CSV through the server-owned CSV contract. Requires `read:databases` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["database_id"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "view_id": { "type": "string", "format": "uuid" }
          }
        }
      },
      {
        "name": "database_json_export",
        "description": "Exports a Database as a Myoxus JSON snapshot. Requires `read:databases` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["database_id"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" }
          }
        }
      },
      {
        "name": "database_json_import_preview",
        "description": "Previews a Myoxus JSON snapshot import without writing data. Returns field / view / row / template counts plus diagnostics. Requires `read:databases` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "anyOf": [
            { "required": ["content_base64"] },
            { "required": ["content_text"] }
          ],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "content_base64": {
              "type": "string",
              "description": "Snapshot bytes encoded as base64. Required when `content_text` is not provided."
            },
            "content_text": {
              "type": "string",
              "description": "Snapshot payload as UTF-8 text. Required when `content_base64` is not provided."
            },
            "mode": { "type": "string", "enum": ["create", "replace", "merge"], "default": "create" },
            "conflict_strategy": { "type": "string", "enum": ["abort", "rename", "overwrite"], "default": "abort" },
            "target_database_id": { "type": "string", "format": "uuid" },
            "target_workspace_id": { "type": "string", "format": "uuid" },
            "dry_run": { "type": "boolean", "default": false }
          }
        }
      },
      {
        "name": "database_json_import",
        "description": "Imports a Myoxus JSON snapshot. Honours mode, conflict strategy, dry-run and confirm_destructive. Requires `write:databases` scope and workspace CreateDoc permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "anyOf": [
            { "required": ["content_base64"] },
            { "required": ["content_text"] }
          ],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "content_base64": { "type": "string" },
            "content_text": { "type": "string" },
            "mode": { "type": "string", "enum": ["create", "replace", "merge"], "default": "create" },
            "conflict_strategy": { "type": "string", "enum": ["abort", "rename", "overwrite"], "default": "abort" },
            "target_database_id": { "type": "string", "format": "uuid" },
            "target_workspace_id": { "type": "string", "format": "uuid" },
            "dry_run": { "type": "boolean", "default": false },
            "confirm_destructive": { "type": "boolean", "default": false }
          }
        }
      },
      {
        "name": "database_notion_export",
        "description": "Exports a Database as Notion-oriented HTML pages through the server-owned Notion adapter. Requires `read:databases` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["database_id"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" }
          }
        }
      },
      {
        "name": "database_notion_import_preview",
        "description": "Previews a Notion HTML / ZIP archive import without writing data. Merges Notion diagnostics with the JSON preview surface. Requires `read:databases` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "anyOf": [
            { "required": ["content_base64"] },
            { "required": ["content_text"] }
          ],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "content_base64": { "type": "string" },
            "content_text": { "type": "string" }
          }
        }
      },
      {
        "name": "database_notion_import",
        "description": "Imports a Notion HTML / ZIP archive. Materialises assets and rolls back blob uploads on failure. Requires `write:databases` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "anyOf": [
            { "required": ["content_base64"] },
            { "required": ["content_text"] }
          ],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "content_base64": { "type": "string" },
            "content_text": { "type": "string" },
            "mode": { "type": "string", "enum": ["create", "replace", "merge"], "default": "create" },
            "conflict_strategy": { "type": "string", "enum": ["abort", "rename", "overwrite"], "default": "abort" },
            "target_database_id": { "type": "string", "format": "uuid" },
            "dry_run": { "type": "boolean", "default": false },
            "confirm_destructive": { "type": "boolean", "default": false }
          }
        }
      },
      {
        "name": "database_row_create",
        "description": "Creates a Database row through the server-owned row service. Requires `write:databases` scope, workspace CreateDoc permission and `idempotency_key`.",
        "inputSchema": {
          "type": "object",
          "required": ["database_id", "idempotency_key"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "title": { "type": ["string", "null"], "maxLength": 1024 },
            "initial_cells": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["field_id", "value"],
                "properties": {
                  "field_id": { "type": "string", "format": "uuid" },
                  "value": { "type": "object", "description": "DatabaseCellValueData JSON: { kind, value }." }
                }
              }
            },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "database_cell_update",
        "description": "Updates one Database cell. Requires `write:databases` scope, row update permission and `idempotency_key`.",
        "inputSchema": {
          "type": "object",
          "required": ["database_id", "row_id", "field_id", "value", "idempotency_key"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "row_id": { "type": "string", "format": "uuid" },
            "field_id": { "type": "string", "format": "uuid" },
            "value": { "type": "object", "description": "DatabaseCellValueData JSON: { kind, value }." },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "database_row_get",
        "description": "Reads one live Database row through the authoritative row projection and current workspace ACL. Requires `read:databases` scope.",
        "inputSchema": {
          "type": "object", "required": ["database_id", "row_id"], "additionalProperties": false,
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "row_id": { "type": "string", "format": "uuid" }
          }
        }
      },
      {
        "name": "database_row_update",
        "description": "Atomically applies up to 200 field/value patches to one live Database row. The server validates the current row and field state and exposes no revision or force-write bypass. Requires `write:databases` scope and `idempotency_key`.",
        "inputSchema": {
          "type": "object", "required": ["database_id", "row_id", "patches", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "row_id": { "type": "string", "format": "uuid" },
            "patches": {
              "type": "array", "minItems": 1, "maxItems": 200,
              "items": {
                "type": "object", "required": ["field_id", "value"], "additionalProperties": false,
                "properties": {
                  "field_id": { "type": "string", "format": "uuid" },
                  "value": { "type": "object", "description": "DatabaseCellValueData JSON: { kind, value }." }
                }
              }
            },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "database_row_delete",
        "description": "Soft-deletes one Database row through the locked server transaction. It never permanently deletes row data. Requires `write:databases` scope and `idempotency_key`.",
        "inputSchema": {
          "type": "object", "required": ["database_id", "row_id", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "row_id": { "type": "string", "format": "uuid" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "database_row_restore",
        "description": "Restores one soft-deleted Database row through the locked server transaction. Requires `write:databases` scope and `idempotency_key`.",
        "inputSchema": {
          "type": "object", "required": ["database_id", "row_id", "idempotency_key"], "additionalProperties": false,
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "row_id": { "type": "string", "format": "uuid" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "database_row_from_template",
        "description": "Creates a Database row from a row-template binding. Requires `write:databases` scope and `idempotency_key`.",
        "inputSchema": {
          "type": "object",
          "required": ["database_id", "row_template_id", "idempotency_key"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" },
            "row_template_id": { "type": "string", "format": "uuid" },
            "title": { "type": ["string", "null"], "maxLength": 1024 },
            "body_inputs": { "type": "object", "maxProperties": 100, "additionalProperties": { "type": "string", "maxLength": 8192 }, "description": "Literal input.<name> values for the Row document body; separate from Cells and title." },
            "source_revision": { "type": "string", "description": "Optional captured native source revision." },
            "override_cell_values": {
              "type": "object",
              "additionalProperties": { "type": "object", "description": "DatabaseCellValueData JSON: { kind, value }." }
            },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "document_graph_read",
        "description": "Reads the ACL-redacted server Document Graph for a workspace or focused document. Requires `read:document_graph` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id": { "type": "string" },
            "direction": { "type": "string", "enum": ["incoming", "outgoing", "both"], "default": "both" },
            "include_occurrences": { "type": "boolean", "default": false },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
            "offset": { "type": "integer", "minimum": 0, "default": 0 }
          }
        }
      },
      {
        "name": "template_suggestions",
        "description": "Runs the contextual Template Suggestions dry-run service. Requires `read:templates` scope and workspace read permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "surface"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "surface": { "type": "string" },
            "locale": { "type": "string", "default": "en" },
            "client_version": { "type": "integer", "minimum": 0, "default": 1 },
            "first": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 },
            "document_type_id": { "type": "string", "format": "uuid" },
            "status_id": { "type": "string", "format": "uuid" },
            "classification_id": { "type": "string", "format": "uuid" },
            "mode": { "type": "string" },
            "collection_id": { "type": "string", "format": "uuid" },
            "current_external_id": { "type": "string" }
          }
        }
      },
      {
        "name": "database_row_templates_list",
        "description": "Lists row-template bindings for one Database. Requires `read:templates` scope and database read permission.",
        "inputSchema": {
          "type": "object",
          "required": ["database_id"],
          "properties": {
            "database_id": { "type": "string", "format": "uuid" }
          }
        }
      },
      {
        "name": "automation_run_retry",
        "description": "Retries one failed or dead-lettered Workspace Automation run. Requires `write:automations` scope, current native run-control authority and `idempotency_key`.",
        "inputSchema": {
          "type": "object",
          "required": ["run_id", "idempotency_key"],
          "properties": {
            "run_id": { "type": "string", "format": "uuid" },
            "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
          }
        }
      },
      {
        "name": "automation_run_stop",
        "description": "Stops uncommitted effects of a native workflow run, retaining completed work. Requires write:automations, current native run-control authority and idempotency_key.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["run_id", "idempotency_key"],
          "properties": {
            "run_id": {"type": "string", "format": "uuid"},
            "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 160}
          }
        }
      },
      {
        "name": "doc_version_list",
        "description": "Lists named versions for a document. Read-only; requires workspace membership and `read:docs` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id": { "type": "string" }
          }
        }
      },
      {
        "name": "doc_version_create",
        "description": "Captures the current document state as a named version. Requires `write:docs` scope and document Update permission.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id", "label"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id": { "type": "string" },
            "label":       { "type": "string", "minLength": 1, "maxLength": 160 },
            "description": { "type": "string", "maxLength": 2048 }
          }
        }
      },
      {
        "name": "doc_metadata_get",
        "description": "Returns canonical document metadata for a document. Read-only; requires workspace membership and `read:docs` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id": { "type": "string" }
          }
        }
      },
      {
        "name": "doc_metadata_validate",
        "description": "Validates canonical document metadata for a document. Read-only; requires workspace membership and `read:docs` scope.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id": { "type": "string" }
          }
        }
      },
      {
        "name": "doc_metadata_transition",
        "description": "Transitions native workflow status through server-side rules discovered by doc_metadata_get. The persisted status definition mapping affects runtime OKF status; a transition alone is not source verification. Use an idempotency key. Requires write:docs and current document Properties.Update.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id", "to"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id": { "type": "string" },
            "to": { "type": "string", "description": "Target status key or UUID in the active status schema." },
            "create_version": { "type": "boolean", "default": false }
          }
        }
      },
      {
        "name": "doc_metadata_update",
        "description": "Updates native type/deadlines and other editable fields through the GraphQL metadata patch owner. Discover fields/revision with doc_metadata_get, then pass expectedMetadataRevision and an idempotency key. Explicit type and the earlier review/validity deadline affect runtime OKF frontmatter; this does not edit YAML or arbitrary import extensions. Requires write:docs and current document Properties.Update.",
        "inputSchema": {
          "type": "object",
          "required": ["workspace_id", "external_id", "patch"],
          "properties": {
            "workspace_id": { "type": "string", "format": "uuid" },
            "external_id": { "type": "string" },
            "patch": {
              "type": "object",
              "properties": {
                "expectedMetadataRevision": { "type": "integer" },
                "documentTypeId": { "type": ["string", "null"], "format": "uuid" },
                "classificationId": { "type": ["string", "null"], "format": "uuid" },
                "retentionPolicyId": { "type": ["string", "null"], "format": "uuid" },
                "languageId": { "type": ["string", "null"], "format": "uuid" },
                "responsibleUserId": { "type": ["string", "null"], "format": "uuid" },
                "documentNumber": { "type": ["string", "null"] },
                "reviewDueAt": { "type": ["string", "null"], "format": "date-time" },
                "validFrom": { "type": ["string", "null"], "format": "date-time" },
                "validUntil": { "type": ["string", "null"], "format": "date-time" },
                "journalDate": { "type": ["string", "null"], "format": "date" },
                "audienceIds": { "type": "array", "items": { "type": "string", "format": "uuid" } },
                "templateState": { "type": ["string", "null"] },
                "templateId": { "type": ["string", "null"], "format": "uuid" },
                "templateRevisionId": { "type": ["string", "null"], "format": "uuid" },
                "templateInstanceId": { "type": ["string", "null"], "format": "uuid" },
                "primaryMode": { "type": ["string", "null"] },
                "pageWidth": { "type": ["string", "null"] },
                "edgelessColorTheme": { "type": ["string", "null"] },
                "integrationType": { "type": ["string", "null"] }
              }
            }
          }
        }
      }
    ]
  });
  let tools = definitions["tools"]
    .as_array_mut()
    .expect("raw MCP registry tools must be an array");
  tools.splice(0..0, user_tool_definitions());
  tools.splice(0..0, organization_read_definitions());
  tools.splice(0..0, organization_membership_definitions());
  let workspace_at = tools
    .iter()
    .position(|tool| tool["name"] == "list_workspaces")
    .expect("list_workspaces registry anchor")
    + 1;
  tools.splice(workspace_at..workspace_at, workspace_tool_definitions());
  let version_read_at = tools
    .iter()
    .position(|tool| tool["name"] == "doc_version_list")
    .expect("doc_version_list registry anchor")
    + 1;
  tools.insert(version_read_at, document_version_read_tool_definition());
  tools.insert(version_read_at + 1, document_version_restore_tool_definition());
  tools.push(comment_create_definition());
  tools.extend(automation::definitions());
  tools.extend(database::assistant_definitions());
  tools.extend(database::schema_definitions());
  tools.extend(database::field_definitions());
  tools.extend(database::view_definitions());
  tools.extend(comment_lifecycle_definitions());
  tools.extend(comment_tool_definitions());
  tools.extend(pdf_export_tool_definitions());
  let publication_at = tools
    .iter()
    .position(|tool| tool["name"] == "read_doc")
    .expect("read_doc registry anchor")
    + 1;
  tools.splice(publication_at..publication_at, document_publication_tool_definitions());
  let insert_at = tools
    .iter()
    .position(|tool| tool["name"] == "folder_tree")
    .expect("folder_tree registry anchor")
    + 1;
  tools.splice(insert_at..insert_at, folder_workflow_tool_definitions());
  let tag_at = tools
    .iter()
    .position(|tool| tool["name"] == "folder_entry_place")
    .expect("folder_entry_place registry anchor")
    + 1;
  tools.splice(tag_at..tag_at, workspace_tag_read_tool_definitions());
  let tag_write_at = tools
    .iter()
    .position(|tool| tool["name"] == "document_tags_get")
    .expect("document_tags_get registry anchor")
    + 1;
  tools.splice(tag_write_at..tag_write_at, workspace_tag_write_tool_definitions());
  let document_template_at = tools
    .iter()
    .position(|tool| tool["name"] == "template_request_reconcile")
    .expect("template_request_reconcile registry anchor")
    + 1;
  tools.splice(
    document_template_at..document_template_at,
    document_template_tool_definitions(),
  );
  let import_at = tools
    .iter()
    .position(|tool| tool["name"] == "create_page")
    .expect("create_page registry anchor")
    + 1;
  tools.insert(import_at, document_import_tool_definition());
  let image_at = tools
    .iter()
    .position(|tool| tool["name"] == "document_import")
    .expect("document_import registry anchor")
    + 1;
  tools.insert(image_at, document_image_insert_tool_definition());
  let reference_at = tools
    .iter()
    .position(|tool| tool["name"] == "document_import")
    .expect("document_import registry anchor")
    + 1;
  tools.insert(reference_at, document_reference_insert_tool_definition());
  definitions
}

fn workspace_tool_definitions() -> [Value; 15] {
  [
    json!({
      "name":"workspace_owner_transfer","description":"Transfers a non-personal Workspace through its canonical atomic owner. Explicit member mode uses current TransferOwner and the GraphQL current-owner transaction; principal mode requires a fresh global administrator and accepts an active user or owning OU. Current authority precedes durable replay; management and OU roles remain separate.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","mode","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"mode":{"type":"string","enum":["member","principal"]},
        "user_id":{"type":"string","format":"uuid"},"owner_unit_id":{"type":"string","format":"uuid"},
        "idempotency_key":{"type":"string","minLength":1,"maxLength":160}},
        "oneOf":[{"required":["user_id"],"properties":{"mode":{"const":"member"}},"not":{"required":["owner_unit_id"]}},
          {"required":["user_id"],"properties":{"mode":{"const":"principal"}},"not":{"required":["owner_unit_id"]}},
          {"required":["owner_unit_id"],"properties":{"mode":{"const":"principal"}},"not":{"required":["user_id"]}}]}
    }),
    json!({
      "name":"workspace_management_unit_set","description":"Sets or explicitly clears (unit_id: null) operational Workspace management through the existing scalar/relationship transaction. Requires a fresh global administrator before execution/replay. Preserves the owner principal and OU/workspace role separation.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","unit_id","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"unit_id":{"type":["string","null"],"format":"uuid"},
        "idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_member_invite","description":"Invites an exact active user as Pending/Collaborator through the canonical owner and outbox. Requires current UsersManage; recipient acceptance remains separate. Durable replay does not enqueue another invitation.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","user_id","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"user_id":{"type":"string","format":"uuid"},
        "idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_invite_link_get","description":"Reads active invitation state and expiry through the canonical owner using current UsersManage. Returns no token, token-derived ID or join URL. Revoked/expired links are inactive.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id"],"properties":{"workspace_id":{"type":"string","format":"uuid"}}}
    }),
    json!({
      "name":"workspace_invite_link_create","description":"Creates an invitation link using current UsersManage and the same server-owned duration/URL projection as GraphQL. Creation may return the secret join URL; retain it privately. Authorized durable replay never rotates the link or duplicates its outbox intent, including after expiry/revocation.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","expire_time","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"expire_time":{"type":"string","enum":["OneDay","ThreeDays","OneWeek","OneMonth"]},
        "idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_invite_link_revoke","description":"Revokes the Workspace's current invitation links through the canonical owner using current UsersManage. Durable replay remains authorized against the active Workspace and never recreates a link.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_member_list", "description":"Lists accepted Workspace members using current UsersRead authority. Bounded offset pagination reports next_offset; OU-manager effective authority applies.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"offset":{"type":"integer","minimum":0,"maximum":2147483647,"default":0},
        "limit":{"type":"integer","minimum":1,"maximum":200,"default":50},"query":{"type":"string","maxLength":200}}}
    }),
    json!({
      "name":"workspace_member_add", "description":"Adds an exact active user as an accepted member through the existing direct-add owner. Requires a fresh global administrator; Owner transfer remains separate.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","user_id","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"user_id":{"type":"string","format":"uuid"},
        "role":{"type":"string","enum":["Admin","Manager","Collaborator","Commenter","Reader"],"default":"Collaborator"},
        "idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_member_set_role", "description":"Changes an existing active member's role using current effective permissions. Admin changes require AdministratorsManage; Owner changes require the separate transfer owner. Retains last-active-admin and membership effects.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","user_id","role","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"user_id":{"type":"string","format":"uuid"},
        "role":{"type":"string","enum":["Admin","Manager","Collaborator","Commenter","Reader","External"]},
        "idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_member_remove", "description":"Removes an existing active member with current target-role authority. Self-revoke and Owner removal are refused; OU last-active-admin is protected. Missing or removed targets cannot authorize a replay.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","user_id","idempotency_key"],"properties":{
        "workspace_id":{"type":"string","format":"uuid"},"user_id":{"type":"string","format":"uuid"},
        "idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_delete", "description":"Soft-deletes a Workspace using current Delete authority. Requires explicit confirmation and a durable key. Content and history are retained; trash removes ordinary access, including Delete replay authority.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","confirm","idempotency_key"],
        "properties":{"workspace_id":{"type":"string","format":"uuid"},"confirm":{"type":"boolean","const":true},"idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name":"workspace_restore", "description":"Restores the same trashed Workspace idempotently through lifecycle recovery. Requires a fresh global administrator and revalidates original ownership, membership and name invariants. Does not permanently purge content.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","idempotency_key"],
        "properties":{"workspace_id":{"type":"string","format":"uuid"},"idempotency_key":{"type":"string","minLength":1,"maxLength":160}}}
    }),
    json!({
      "name": "workspace_create",
      "description": "Creates an initialized Workspace owned by the key owner, or an active organization unit when a current global administrator supplies owner_unit_id. Provisioning failures require inspection; uncertain outcomes must not be repeated with a new key.",
      "inputSchema": {
        "type": "object", "required": ["idempotency_key"], "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 120 },
          "owner_unit_id": { "type": "string", "format": "uuid" },
          "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
        }
      }
    }),
    json!({
      "name": "workspace_get",
      "description": "Returns the authorized workspace overview, retained publication selection count and effective public URL.",
      "inputSchema": {
        "type": "object", "required": ["workspace_id"], "additionalProperties": false,
        "properties": { "workspace_id": { "type": "string", "format": "uuid" } }
      }
    }),
    json!({
      "name": "workspace_update",
      "description": "Updates user-editable workspace overview and publication settings. Requires write:workspaces plus read:workspaces for authoritative metadata readback; workspace ACLs still apply.",
      "inputSchema": {
        "type": "object", "required": ["workspace_id", "idempotency_key"], "additionalProperties": false,
        "anyOf": [
          { "required": ["name"] }, { "required": ["description"] },
          { "required": ["public"] }, { "required": ["enable_sharing"] }
        ],
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "name": { "type": "string", "minLength": 1, "maxLength": 120 },
          "description": { "type": "string", "maxLength": 2000 },
          "public": { "type": "boolean" },
          "enable_sharing": { "type": "boolean" },
          "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
        }
      }
    }),
  ]
}

fn document_publication_tool_definitions() -> [Value; 2] {
  [
    json!({
      "name": "doc_publication_get",
      "description": "Returns the stored and effective publication status for one readable document addressed by its external ID.",
      "inputSchema": {
        "type": "object", "required": ["workspace_id", "external_id"], "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "external_id": { "type": "string", "minLength": 1 }
        }
      }
    }),
    json!({
      "name": "doc_publication_set",
      "description": "Publishes or revokes one document. Requires write:docs plus read:docs for authoritative readback; document ACLs still apply. Publishing never enables workspace or server delivery switches.",
      "inputSchema": {
        "type": "object", "required": ["workspace_id", "external_id", "public", "idempotency_key"],
        "additionalProperties": false,
        "allOf": [{
          "if": { "properties": { "public": { "const": false } }, "required": ["public"] },
          "then": { "not": { "required": ["mode"] } }
        }],
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "external_id": { "type": "string", "minLength": 1 },
          "public": { "type": "boolean" },
          "mode": { "type": "string", "enum": ["Page", "Edgeless"], "default": "Page" },
          "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
        }
      }
    }),
  ]
}

fn document_template_tool_definitions() -> [Value; 6] {
  [
    json!({
      "name": "document_template_list",
      "description": "Lists readable user-visible document templates from canonical workspace documents. Bodies remain available only through read_doc.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "offset": { "type": "integer", "minimum": 0, "default": 0 },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
        }
      }
    }),
    json!({
      "name": "document_template_get",
      "description": "Gets readable metadata and required variable names for one user-visible document template without returning its body.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "external_id"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "external_id": { "type": "string", "minLength": 1 }
        }
      }
    }),
    json!({
      "name": "document_template_create",
      "description": "Creates one canonical document template from structured content or Markdown and places it in one existing workspace folder.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "title", "idempotency_key"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["fragment"], "not": { "required": ["content_markdown"] } },
          { "required": ["content_markdown"], "not": { "required": ["fragment"] } }
        ],
        "allOf": [{
          "oneOf": [
            { "required": ["folder_id"], "not": { "required": ["folder_path"] } },
            { "required": ["folder_path"], "not": { "required": ["folder_id"] } }
          ]
        }],
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "title": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "fragment": { "$ref": "#/$defs/documentFragment" },
          "content_markdown": { "type": "string", "maxLength": 1048576 },
          "folder_id": { "type": "string", "minLength": 1 },
          "folder_path": {
            "type": "array", "minItems": 1,
            "items": { "type": "string", "minLength": 1, "maxLength": 256 }
          },
          "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
        }
      }
    }),
    json!({
      "name": "document_template_instantiate",
      "description": "Creates one ordinary document from a readable same-workspace template by cloning native editor content into an existing folder. Omitted supported automatic values use authorized server facts and the applying account's regional preferences; explicit legacy values remain caller-authored.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "template_external_id", "idempotency_key"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["folder_id"], "not": { "required": ["folder_path"] } },
          { "required": ["folder_path"], "not": { "required": ["folder_id"] } }
        ],
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "template_external_id": { "type": "string", "minLength": 1 },
          "context_parent_external_id": { "type": "string", "minLength": 1, "description": "Optional same-workspace readable parent used only for template substitution; creates no parent relationship." },
          "title": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "variables": {
            "type": "object",
            "maxProperties": 100,
            "propertyNames": { "minLength": 1, "maxLength": 128 },
            "additionalProperties": {
              "oneOf": [
                { "type": "string", "maxLength": 8192 },
                {
                  "type": "array", "maxItems": 500,
                  "items": { "type": "string", "maxLength": 8192 }
                },
                {
                  "type": "array", "minItems": 1, "maxItems": 500,
                  "items": {
                    "type": "object", "maxProperties": 100,
                    "propertyNames": { "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z][A-Za-z0-9_-]*(\\.[A-Za-z][A-Za-z0-9_-]*)*$" },
                    "additionalProperties": { "type": "string", "maxLength": 8192 }
                  }
                }
              ]
            }
          },
          "folder_id": { "type": "string", "minLength": 1 },
          "folder_path": {
            "type": "array", "minItems": 1,
            "items": { "type": "string", "minLength": 1, "maxLength": 256 }
          },
          "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
        }
      }
    }),
    document_template_state_tool_definition(
      "document_template_mark",
      "Marks one existing document as a user-visible document template through its canonical metadata property.",
    ),
    document_template_state_tool_definition(
      "document_template_unmark",
      "Removes user-visible document-template status from one existing document through its canonical metadata property.",
    ),
  ]
}

fn document_template_state_tool_definition(name: &str, description: &str) -> Value {
  json!({
    "name": name,
    "description": description,
    "inputSchema": {
      "type": "object",
      "required": ["workspace_id", "external_id", "idempotency_key"],
      "additionalProperties": false,
      "properties": {
        "workspace_id": { "type": "string", "format": "uuid" },
        "external_id": { "type": "string", "minLength": 1 },
        "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
      }
    }
  })
}

fn document_image_insert_tool_definition() -> Value {
  json!({
    "name": "document_image_insert",
    "description": "Inserts one completed same-workspace document asset as an editor-native image block after an optional block or at the document end.",
    "inputSchema": {
      "type": "object",
      "required": ["workspace_id", "external_id", "asset_ref", "idempotency_key"],
      "additionalProperties": false,
      "properties": {
        "workspace_id": { "type": "string", "format": "uuid" },
        "external_id": { "type": "string", "minLength": 1 },
        "asset_ref": { "type": "string", "pattern": "^assets/[a-f0-9]{64}$" },
        "expected_revision": { "type": "integer", "minimum": 0, "description": "Optional content revision from read_doc; checked atomically before insertion." },
        "after_block_id": { "type": "string", "minLength": 1 },
        "caption": { "type": "string", "maxLength": 4096 },
        "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
      }
    }
  })
}

fn document_reference_insert_tool_definition() -> Value {
  json!({
    "name": "document_reference_insert",
    "description": "Inserts one editor-native linked-page reference paragraph into an existing document after an optional block or at the document end.",
    "inputSchema": {
      "type": "object",
      "required": ["workspace_id", "external_id", "target_external_id", "label", "idempotency_key"],
      "additionalProperties": false,
      "properties": {
        "workspace_id": { "type": "string", "format": "uuid" },
        "external_id": { "type": "string", "minLength": 1 },
        "target_external_id": { "type": "string", "minLength": 1 },
        "expected_revision": { "type": "integer", "minimum": 0, "description": "Optional content revision from read_doc; checked atomically before insertion." },
        "label": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "after_block_id": { "type": "string", "minLength": 1 },
        "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
      }
    }
  })
}

fn document_import_tool_definition() -> Value {
  json!({
    "name": "document_import",
    "description": "Creates one document from a structured fragment or Markdown and places it in one existing workspace folder. Structured image blocks require completed references from document_asset_upload_prepare; Markdown image URLs retain their existing external/lossy semantics.",
    "inputSchema": {
      "type": "object",
      "required": ["workspace_id", "title", "idempotency_key"],
      "additionalProperties": false,
      "properties": {
        "workspace_id": { "type": "string", "format": "uuid" },
        "title": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "fragment": { "$ref": "#/$defs/documentFragment" },
        "content_markdown": { "type": "string", "maxLength": 1048576 },
        "folder_id": { "type": "string", "minLength": 1 },
        "folder_path": {
          "type": "array", "minItems": 1,
          "items": { "type": "string", "minLength": 1, "maxLength": 256 }
        },
        "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
      },
      "allOf": [
        {
          "oneOf": [
            { "required": ["fragment"], "not": { "required": ["content_markdown"] } },
            { "required": ["content_markdown"], "not": { "required": ["fragment"] } }
          ]
        },
        {
          "oneOf": [
            { "required": ["folder_id"], "not": { "required": ["folder_path"] } },
            { "required": ["folder_path"], "not": { "required": ["folder_id"] } }
          ]
        }
      ],
      "$defs": {
        "documentFragment": {
          "type": "object",
          "required": ["blocks"],
          "properties": { "blocks": { "type": "array", "items": { "type": "object" } } }
        }
      }
    }
  })
}

fn pdf_export_tool_definitions() -> Vec<Value> {
  vec![
    json!({
      "name":"pdf_export_create",
      "description":"Creates a PDF for an external workspace document through the existing export pipeline. Omit template_id to consume the assigned workspace default. The required idempotency_key owns one immutable history source and job: retry the same arguments/key after interruption; use pdf_export_get for current state. Delivery uses the normal authenticated download endpoint with the same user and read:docs scope, never a bearer link.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["workspace_id","external_id","idempotency_key"],
        "properties":{
          "workspace_id":{"type":"string","format":"uuid"}, "external_id":{"type":"string","minLength":1},
          "idempotency_key":{"type":"string","minLength":1,"maxLength":160},
          "template_id":{"type":["string","null"],"minLength":1}, "locale":{"type":["string","null"]},
          "paper_size":{"type":["string","null"],"enum":["A4","Letter","A3","A5","16:9",null]},
          "orientation":{"type":["string","null"],"enum":["portrait","landscape",null]},
          "image_quality":{"type":["string","null"],"enum":["low","med","high","lossless",null]},
          "compliance_profile":{"type":["string","null"],"enum":["standard","pdfa-1b","pdfa-2b","pdfa-3b","pdfua-1",null]},
          "cover_page":{"type":["boolean","null"]},
          "toc_behavior":{"type":["string","null"],"enum":["off","auto","force",null]},
          "footer_style":{"type":["string","null"]},"page_numbering":{"type":["string","null"]},
          "color_variant":{"type":["string","null"]},"confidentiality_label":{"type":["string","null"]},
          "document_version_id":{"type":["string","null"],"description":"latest or a named version UUID, using the canonical export version policy"},
          "typed_inputs":{}
        }}
    }),
    json!({
      "name":"pdf_export_get", "description":"Polls one PDF job with current workspace/document Read permission. Returns the actual pinned source, renderer findings and an authenticated download URL when usable. artifactExpiresAt describes artifact retention, not a signed-link lifetime. Inspect the downloaded PDF; these findings do not promise universal content readiness.",
      "inputSchema":{"type":"object","additionalProperties":false,"required":["job_id"],"properties":{"job_id":{"type":"string","format":"uuid"}}}
    }),
  ]
}

fn pdf_export_output_schema() -> Value {
  json!({"type":"object","additionalProperties":false,
  "required":["jobId","workspaceId","externalId","templateId","status","execution","createdAt","startedAt","finishedAt","artifactExpiresAt","pageCount","errorClass","source","delivery","diagnostics"],
  "properties":{
    "jobId":{"type":"string","format":"uuid"},"workspaceId":{"type":"string","format":"uuid"},
    "externalId":{"type":"string"},"templateId":{"type":"string"},"status":{"type":"string"},"execution":{"type":"string"},
    "createdAt":{"type":"string"},"startedAt":{"type":["string","null"]},"finishedAt":{"type":["string","null"]},
    "artifactExpiresAt":{"type":["string","null"]},"pageCount":{"type":["integer","null"]},"errorClass":{"type":["string","null"]},
    "source":{"type":"object","additionalProperties":false,"required":["documentVersionId","versionLabel","historyId","revision"],"properties":{
      "documentVersionId":{"type":["string","null"]},"versionLabel":{"type":["string","null"]},"historyId":{"type":["integer","null"]},
      "revision":{"type":["object","null"],"additionalProperties":false,"required":["kind","value"],"properties":{"kind":{"const":"yjs_sha256"},"value":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}
    }},
    "delivery":{"type":"object","additionalProperties":false,"required":["available","url","authentication","apiKeyScope"],"properties":{
      "available":{"type":"boolean"},"url":{"type":["string","null"]},"authentication":{"const":"session_or_api_key"},"apiKeyScope":{"const":"read:docs"}
    }},
    "diagnostics":{"type":"object","additionalProperties":false,"required":["unmappedFontFamilies","findings","coverage"],"properties":{
      "unmappedFontFamilies":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":256}},
      "findings":{"type":"array","maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["code","count"],"properties":{
        "code":{"enum":["missing_asset","unsupported_block","missing_canvas_snapshot"]},"count":{"type":"integer","minimum":0}}}},
      "coverage":{"enum":["pending","pipeline_reported","unavailable"]}
    }}
  }})
}

fn folder_workflow_tool_definitions() -> Vec<Value> {
  vec![
    json!({
      "name": "folder_path_ensure",
      "description": "Resolves an exact workspace folder path and creates only its missing suffix. Duplicate sibling names fail with candidate folder IDs.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "path", "idempotency_key"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "path": {
            "type": "array", "minItems": 1,
            "items": { "type": "string", "minLength": 1, "maxLength": 256 }
          },
          "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
        }
      }
    }),
    json!({
      "name": "folder_entry_place",
      "description": "Places one existing document in a workspace folder by ID or exact path, creating, retaining or moving its unique folder entry.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "external_id", "idempotency_key"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "folder_id": { "type": "string", "minLength": 1 },
          "folder_path": {
            "type": "array", "minItems": 1,
            "items": { "type": "string", "minLength": 1, "maxLength": 256 }
          },
          "external_id": { "type": "string", "minLength": 1 },
          "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
        },
        "oneOf": [
          { "required": ["folder_id"], "not": { "required": ["folder_path"] } },
          { "required": ["folder_path"], "not": { "required": ["folder_id"] } }
        ]
      }
    }),
  ]
}

fn workspace_tag_read_tool_definitions() -> Vec<Value> {
  vec![
    json!({
      "name": "workspace_tag_list",
      "description": "Lists workspace Labels (API name: Tags) from the canonical SQL catalog in stable server order. Follow nextOffset for every page; active Tags are returned unless include_archived is true. Use returned canonical UUIDs for document_tags_set, never names or legacy Yjs IDs. Read document_tags_get before editing an assignment so its existing order and archived references can be retained. Create a missing Label explicitly with workspace_tag_create; set never creates Tags.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "include_archived": { "type": "boolean", "default": false },
          "offset": { "type": "integer", "minimum": 0, "default": 0 },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
        }
      }
    }),
    json!({
      "name": "workspace_tag_get",
      "description": "Returns one workspace Tag by its canonical Tag ID.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "tag_id"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "tag_id": { "type": "string", "format": "uuid" }
        }
      }
    }),
    json!({
      "name": "document_tags_get",
      "description": "Reads the complete ordered canonical Labels (Tags) assigned to a document. external_id is the workspace-local external document key, not an internal document UUID. The returned tags contain canonical Tag UUIDs and include retained archived Tags; [] confirms no assignment. Read this before editing, use workspace_tag_list or workspace_tag_create for additional active IDs, then send the entire desired ordered list to document_tags_set. Missing or forbidden documents fail rather than returning an empty assignment.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "external_id"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "external_id": { "type": "string", "minLength": 1, "description": "External document key within workspace_id; never an internal document UUID." }
        }
      }
    }),
  ]
}

fn workspace_tag_write_tool_definitions() -> Vec<Value> {
  let idempotency_key = json!({ "type": "string", "minLength": 1, "maxLength": 160, "description": "Retry identical arguments with the same key to replay the saved result without another write; changed arguments require a new key." });
  let color_role = workspace_tag_color_role_output_schema();
  vec![
    json!({
      "name": "workspace_tag_create",
      "description": "Creates one workspace Label (API name: Tag) in the canonical SQL catalog and returns its canonical UUID. List existing Labels with workspace_tag_list first; names are not assignment IDs and creation does not assign a document. Supply a supported color_role and optional description; the server allocates the slug. Use the returned id in document_tags_set. idempotency_key is required: retry identical arguments with the same key to replay the original result without creating another Tag; changed arguments require a new key.",
      "inputSchema": {
        "type": "object", "required": ["workspace_id", "name", "color_role", "idempotency_key"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "name": { "type": "string", "minLength": 1 },
          "color_role": color_role.clone(),
          "description": { "type": ["string", "null"] },
          "idempotency_key": idempotency_key.clone()
        }
      }
    }),
    json!({
      "name": "workspace_tag_rename",
      "description": "Renames one workspace Tag while the server preserves collision-safe slug allocation.",
      "inputSchema": tag_field_write_schema("name", json!({ "type": "string", "minLength": 1 }))
    }),
    json!({
      "name": "workspace_tag_recolor",
      "description": "Changes one workspace Tag to an approved theme color role.",
      "inputSchema": tag_field_write_schema("color_role", color_role)
    }),
    json!({
      "name": "workspace_tag_description_update",
      "description": "Updates or clears one workspace Tag description. Pass null or blank text to clear it.",
      "inputSchema": tag_field_write_schema("description", json!({ "type": ["string", "null"] }))
    }),
    json!({
      "name": "workspace_tag_archive",
      "description": "Archives one workspace Tag without removing historical assignments.",
      "inputSchema": tag_lifecycle_write_schema()
    }),
    json!({
      "name": "workspace_tag_restore",
      "description": "Restores one archived workspace Tag when its server-owned slug is available.",
      "inputSchema": tag_lifecycle_write_schema()
    }),
    json!({
      "name": "workspace_tag_delete_permanently",
      "description": "Permanently deletes one archived workspace Tag and all persisted references after explicit confirmation.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "tag_id", "confirm_permanent_delete", "idempotency_key"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "tag_id": { "type": "string", "format": "uuid" },
          "confirm_permanent_delete": { "const": true },
          "idempotency_key": idempotency_key.clone()
        }
      }
    }),
    json!({
      "name": "document_tags_set",
      "description": "Replaces a document's entire ordered Label (Tag) assignment with canonical UUIDs from this workspace. external_id is the workspace-local external document key, not an internal document UUID. Read document_tags_get and list/create Tags first, then send every desired ID in order: omitted IDs are removed and [] clears all assignments. Names, duplicate IDs and foreign IDs are rejected; no Tags are created implicitly. Already assigned archived Tags may be retained or removed, but not newly added. idempotency_key is required: identical arguments with the same key replay the original result without reapplying it; use a new key for a changed request and get to read current state.",
      "inputSchema": {
        "type": "object",
        "required": ["workspace_id", "external_id", "tag_ids", "idempotency_key"],
        "additionalProperties": false,
        "properties": {
          "workspace_id": { "type": "string", "format": "uuid" },
          "external_id": { "type": "string", "minLength": 1, "description": "External document key within workspace_id; never an internal document UUID." },
          "tag_ids": {
            "type": "array", "uniqueItems": true,
            "description": "Complete ordered canonical workspace Tag UUIDs. Omitted IDs are removed; [] clears the assignment.",
            "items": { "type": "string", "format": "uuid" }
          },
          "idempotency_key": idempotency_key.clone()
        }
      }
    }),
  ]
}

fn tag_field_write_schema(field: &str, field_schema: Value) -> Value {
  let mut properties = serde_json::Map::from_iter([
    (
      "workspace_id".to_string(),
      json!({ "type": "string", "format": "uuid" }),
    ),
    ("tag_id".to_string(), json!({ "type": "string", "format": "uuid" })),
    (
      "idempotency_key".to_string(),
      json!({ "type": "string", "minLength": 1, "maxLength": 160 }),
    ),
  ]);
  properties.insert(field.to_string(), field_schema);
  json!({
    "type": "object",
    "required": ["workspace_id", "tag_id", field, "idempotency_key"],
    "additionalProperties": false,
    "properties": properties
  })
}

fn tag_lifecycle_write_schema() -> Value {
  json!({
    "type": "object", "required": ["workspace_id", "tag_id", "idempotency_key"],
    "additionalProperties": false,
    "properties": {
      "workspace_id": { "type": "string", "format": "uuid" },
      "tag_id": { "type": "string", "format": "uuid" },
      "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
    }
  })
}

const TOOL_PAGE_SIZE: usize = 25;
const CURSOR_PREFIX: &str = "myoxus:mcp-tools:v1:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolService {
  Comments,
  Search,
  Database,
  AssistantPackages,
  Calendar,
  Organization,
  OrganizationReads,
  OrganizationMemberships,
  Users,
  WorkspacePublication,
  WorkspaceSettings,
  DocumentPublication,
  WorkspaceTags,
  DocumentGraph,
  TemplateRegistry,
  DocumentTemplates,
  TemplateSuggestions,
  WorkspaceAutomation,
  PdfTemplates,
  PdfExport,
  DocumentPersistence,
  Idempotency,
  Blob,
  BlobUpload,
}

/// Snapshot of optional services wired into the running MCP adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct ToolAvailability {
  pub comments: bool,
  pub search: bool,
  pub database: bool,
  pub assistant_packages: bool,
  pub calendar: bool,
  pub organization: bool,
  pub organization_reads: bool,
  pub organization_memberships: bool,
  pub users: bool,
  pub workspace_publication: bool,
  pub workspace_settings: bool,
  pub document_publication: bool,
  pub workspace_tags: bool,
  pub document_graph: bool,
  pub template_registry: bool,
  pub document_templates: bool,
  pub template_suggestions: bool,
  pub workspace_automation: bool,
  pub pdf_templates: bool,
  pub pdf_export: bool,
  pub document_persistence: bool,
  pub idempotency: bool,
  pub blob: bool,
  pub blob_upload: bool,
}

impl ToolAvailability {
  fn has(self, service: ToolService) -> bool {
    match service {
      ToolService::Comments => self.comments,
      ToolService::Search => self.search,
      ToolService::Database => self.database,
      ToolService::AssistantPackages => self.assistant_packages,
      ToolService::Calendar => self.calendar,
      ToolService::Organization => self.organization,
      ToolService::OrganizationReads => self.organization_reads,
      ToolService::OrganizationMemberships => self.organization_memberships,
      ToolService::Users => self.users,
      ToolService::WorkspacePublication => self.workspace_publication,
      ToolService::WorkspaceSettings => self.workspace_settings,
      ToolService::DocumentPublication => self.document_publication,
      ToolService::WorkspaceTags => self.workspace_tags,
      ToolService::DocumentGraph => self.document_graph,
      ToolService::TemplateRegistry => self.template_registry,
      ToolService::DocumentTemplates => self.document_templates,
      ToolService::TemplateSuggestions => self.template_suggestions,
      ToolService::WorkspaceAutomation => self.workspace_automation,
      ToolService::PdfTemplates => self.pdf_templates,
      ToolService::PdfExport => self.pdf_export,
      ToolService::DocumentPersistence => self.document_persistence,
      ToolService::Idempotency => self.idempotency,
      ToolService::Blob => self.blob,
      ToolService::BlobUpload => self.blob_upload,
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolAccess {
  Read,
  Write,
}

impl ToolAccess {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Read => "read",
      Self::Write => "write",
    }
  }
}

/// One complete registry entry. Internal authorization/audit fields are not
/// serialized by `tools/list`; the public projection is deliberately narrow.
#[derive(Clone, Debug)]
pub struct ToolDescriptor {
  pub name: String,
  pub title: String,
  pub description: String,
  pub input_schema: Value,
  pub output_schema: Value,
  pub required_scope: &'static str,
  pub required_services: &'static [ToolService],
  pub target_type: &'static str,
  pub audit_event: Option<&'static str>,
  pub access: ToolAccess,
  pub annotations: ToolAnnotations,
  pub(crate) handler: crate::tools::ToolHandler,
}

impl ToolDescriptor {
  pub fn services_available(&self, availability: ToolAvailability) -> bool {
    self
      .required_services
      .iter()
      .copied()
      .all(|service| availability.has(service))
  }

  pub fn visible_to(&self, auth: &McpAuthContext, availability: ToolAvailability) -> bool {
    auth.has_scope(self.required_scope) && self.services_available(availability)
  }

  /// Project the existing catalog without exposing authorization/audit policy.
  pub fn public_tool(&self) -> Tool {
    let mut tool = Tool::new(
      self.name.clone(),
      self.description.clone(),
      self
        .input_schema
        .as_object()
        .expect("registered input schema is an object")
        .clone(),
    );
    tool.title = Some(self.title.clone());
    tool.output_schema = Some(
      self
        .output_schema
        .as_object()
        .expect("registered output schema is an object")
        .clone()
        .into(),
    );
    tool.annotations = Some(self.annotations.clone());
    tool
  }
}

struct ToolPolicy {
  scope: &'static str,
  services: &'static [ToolService],
  target: &'static str,
  audit_event: Option<&'static str>,
  access: ToolAccess,
  destructive: bool,
  idempotent: bool,
}

const COMMENTS_WRITE: &[ToolService] = &[ToolService::Comments, ToolService::Blob, ToolService::Idempotency];
const COMMENTS_LIFECYCLE: &[ToolService] = &[ToolService::Comments, ToolService::Idempotency];
const COMMENTS_READ: &[ToolService] = &[ToolService::Comments, ToolService::Users];
const SEARCH: &[ToolService] = &[ToolService::Search];
const DATABASE: &[ToolService] = &[ToolService::Database];
const CALENDAR: &[ToolService] = &[ToolService::Calendar];
const CALENDAR_WRITE: &[ToolService] = &[ToolService::Calendar, ToolService::Idempotency];
const USERS: &[ToolService] = &[ToolService::Users];
const USERS_WRITE: &[ToolService] = &[ToolService::Users, ToolService::Idempotency];
const ORGANIZATION: &[ToolService] = &[ToolService::Organization];
const ORGANIZATION_WRITE: &[ToolService] = &[ToolService::Organization, ToolService::Idempotency];
const WORKSPACE_PUBLICATION: &[ToolService] = &[ToolService::WorkspacePublication];
const WORKSPACE_SETTINGS_WRITE: &[ToolService] = &[
  ToolService::WorkspacePublication,
  ToolService::WorkspaceSettings,
  ToolService::Idempotency,
];
const DOCUMENT_PUBLICATION_READ: &[ToolService] = &[ToolService::WorkspacePublication];
const DOCUMENT_PUBLICATION_WRITE: &[ToolService] = &[
  ToolService::WorkspacePublication,
  ToolService::DocumentPublication,
  ToolService::Idempotency,
];
const WORKSPACE_TAGS: &[ToolService] = &[ToolService::WorkspaceTags];
const WORKSPACE_TAG_WRITE: &[ToolService] = &[ToolService::WorkspaceTags, ToolService::Idempotency];
const DATABASE_WRITE: &[ToolService] = &[ToolService::Database, ToolService::Idempotency];
const DATABASE_TEMPLATE_READ: &[ToolService] = &[ToolService::Database, ToolService::TemplateRegistry];
const DATABASE_TEMPLATE_WRITE: &[ToolService] = &[
  ToolService::Database,
  ToolService::TemplateRegistry,
  ToolService::Idempotency,
];
const DOCUMENT_GRAPH: &[ToolService] = &[ToolService::DocumentGraph];
const TEMPLATE_REGISTRY: &[ToolService] = &[ToolService::TemplateRegistry];
const DOCUMENT_TEMPLATES: &[ToolService] = &[ToolService::DocumentTemplates];
const DOCUMENT_TEMPLATE_WRITES: &[ToolService] = &[ToolService::DocumentTemplates, ToolService::Idempotency];
const TEMPLATE_SUGGESTIONS: &[ToolService] = &[ToolService::TemplateSuggestions];
const AUTOMATION_WRITE: &[ToolService] = &[ToolService::WorkspaceAutomation, ToolService::Idempotency];
const PDF_TEMPLATES: &[ToolService] = &[ToolService::PdfTemplates];
const DOCUMENT_PERSISTENCE: &[ToolService] = &[ToolService::DocumentPersistence];
const IDEMPOTENCY: &[ToolService] = &[ToolService::Idempotency];
const BLOB: &[ToolService] = &[ToolService::Blob];
const BLOB_UPLOAD: &[ToolService] = &[ToolService::Blob, ToolService::BlobUpload];
const BLOB_IDEMPOTENCY: &[ToolService] = &[ToolService::Blob, ToolService::Idempotency];

/// Shipped write tools keep keyless compatibility. Supplying a key activates
/// durable replay protection without making idempotency-store wiring a tools/list
/// availability requirement.
const OPTIONAL_IDEMPOTENCY_TOOLS: &[&str] = &[
  "create_page",
  "delete_page",
  "restore_page",
  "folder_create",
  "folder_update",
  "folder_delete",
  "folder_entry_create",
  "folder_entry_update",
  "folder_entry_delete",
  "blob_upload",
  "blob_delete",
  "doc_version_create",
  "doc_metadata_transition",
  "doc_metadata_update",
  "database_json_import",
  "database_notion_import",
];
#[cfg(test)]
const NATURALLY_IDEMPOTENT_WRITE_TOOLS: &[&str] = &["document_asset_upload_prepare", "database_assistant_stop"];

fn policy(name: &str) -> Option<ToolPolicy> {
  let read = |scope, services, target| ToolPolicy {
    scope,
    services,
    target,
    audit_event: None,
    access: ToolAccess::Read,
    destructive: false,
    idempotent: true,
  };
  let write = |scope, services, target, audit_event, destructive, idempotent| ToolPolicy {
    scope,
    services,
    target,
    audit_event,
    access: ToolAccess::Write,
    destructive,
    idempotent,
  };

  Some(match name {
    "user_list" | "user_get" => read("read:users", USERS, "user"),
    "user_delete" => write("write:users", USERS_WRITE, "user", Some("mcp.user.delete"), true, true),
    "user_set_admin" => write(
      "write:users",
      USERS_WRITE,
      "user",
      Some("mcp.user.admin_role_set"),
      true,
      true,
    ),
    "user_create" => write("write:users", USERS_WRITE, "user", Some("mcp.user.create"), false, true),
    "user_update" => write("write:users", USERS_WRITE, "user", Some("mcp.user.update"), false, true),
    "user_suspend" => write("write:users", USERS_WRITE, "user", Some("mcp.user.suspend"), true, true),
    "user_enable" => write("write:users", USERS_WRITE, "user", Some("mcp.user.enable"), false, true),
    "user_reset_link" => write(
      "write:users",
      USERS_WRITE,
      "user",
      Some("mcp.user.reset_link"),
      false,
      true,
    ),
    "calendar_events_list" | "calendar_conflicts_check" => read("read:calendar", CALENDAR, "calendar_event"),
    "calendar_event_create" => write(
      "write:calendar",
      CALENDAR_WRITE,
      "calendar_event",
      Some("mcp.calendar_event.create"),
      false,
      true,
    ),
    "calendar_event_update" => write(
      "write:calendar",
      CALENDAR_WRITE,
      "calendar_event",
      Some("mcp.calendar_event.update"),
      true,
      true,
    ),
    "calendar_event_delete" => write(
      "write:calendar",
      CALENDAR_WRITE,
      "calendar_event",
      Some("mcp.calendar_event.delete"),
      true,
      true,
    ),
    "organization_get"
    | "organization_unit_type_list"
    | "organization_unit_member_list"
    | "user_organization_memberships" => read("read:organization", &[ToolService::OrganizationReads], "organization"),
    "organization_unit_list" | "organization_unit_get" | "organization_unit_delete_preview" => {
      read("read:organization", ORGANIZATION, "organization_unit")
    }
    "organization_unit_member_add" => write(
      "write:organization",
      &[ToolService::OrganizationMemberships, ToolService::Idempotency],
      "organization_unit_member",
      Some("mcp.organization_unit.member.add"),
      false,
      true,
    ),
    "organization_unit_member_set_role" => write(
      "write:organization",
      &[ToolService::OrganizationMemberships, ToolService::Idempotency],
      "organization_unit_member",
      Some("mcp.organization_unit.member.set_role"),
      true,
      true,
    ),
    "organization_unit_member_remove" => write(
      "write:organization",
      &[ToolService::OrganizationMemberships, ToolService::Idempotency],
      "organization_unit_member",
      Some("mcp.organization_unit.member.remove"),
      true,
      true,
    ),
    "organization_unit_create" => write(
      "write:organization",
      ORGANIZATION_WRITE,
      "organization_unit",
      Some("mcp.organization_unit.create"),
      false,
      true,
    ),
    "organization_unit_update" => write(
      "write:organization",
      ORGANIZATION_WRITE,
      "organization_unit",
      Some("mcp.organization_unit.update"),
      true,
      true,
    ),
    "organization_unit_move" => write(
      "write:organization",
      ORGANIZATION_WRITE,
      "organization_unit",
      Some("mcp.organization_unit.move"),
      true,
      true,
    ),
    "organization_unit_set_status" => write(
      "write:organization",
      ORGANIZATION_WRITE,
      "organization_unit",
      Some("mcp.organization_unit.status.update"),
      true,
      true,
    ),
    "organization_unit_delete_permanent" => write(
      "write:organization",
      ORGANIZATION_WRITE,
      "organization_unit",
      Some("mcp.organization_unit.delete"),
      true,
      true,
    ),
    "comment_create" => write(
      "write:docs",
      COMMENTS_WRITE,
      "comment",
      Some("mcp.comment.create"),
      false,
      true,
    ),
    "comment_update" => write(
      "write:docs",
      COMMENTS_LIFECYCLE,
      "comment",
      Some("mcp.comment.update"),
      false,
      true,
    ),
    "comment_set_resolved" => write(
      "write:docs",
      COMMENTS_LIFECYCLE,
      "comment",
      Some("mcp.comment.resolve"),
      false,
      true,
    ),
    "comment_delete" => write(
      "write:docs",
      COMMENTS_LIFECYCLE,
      "comment",
      Some("mcp.comment.delete"),
      true,
      true,
    ),
    "comment_thread_mark_read" => write(
      "write:docs",
      COMMENTS_LIFECYCLE,
      "comment",
      Some("mcp.comment.read"),
      false,
      true,
    ),
    "comment_threads_mark_all_read" => write(
      "write:docs",
      COMMENTS_LIFECYCLE,
      "document",
      Some("mcp.comment.read_all"),
      false,
      true,
    ),
    "comment_thread_list" | "comment_reply_list" | "comment_history_list" => {
      read("read:docs", COMMENTS_READ, "comment")
    }
    "list_workspaces" => read("read:workspaces", &[], "workspace"),
    "workspace_owner_transfer" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.owner.transfer"),
      true,
      true,
    ),
    "workspace_management_unit_set" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.management_unit.set"),
      false,
      true,
    ),
    "workspace_member_invite" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.member.invite"),
      false,
      true,
    ),
    "workspace_invite_link_get" => read("read:workspaces", &[], "workspace"),
    "workspace_invite_link_create" => write(
      "write:workspaces",
      IDEMPOTENCY,
      "workspace",
      Some("mcp.workspace.invite_link.create"),
      false,
      true,
    ),
    "workspace_invite_link_revoke" => write(
      "write:workspaces",
      IDEMPOTENCY,
      "workspace",
      Some("mcp.workspace.invite_link.revoke"),
      true,
      true,
    ),
    "workspace_member_list" => read("read:workspaces", &[], "workspace"),
    "workspace_member_add" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.member.add"),
      false,
      true,
    ),
    "workspace_member_set_role" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.member.role"),
      true,
      true,
    ),
    "workspace_member_remove" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.member.remove"),
      true,
      true,
    ),
    "workspace_delete" => write(
      "write:workspaces",
      IDEMPOTENCY,
      "workspace",
      Some("mcp.workspace.delete"),
      true,
      true,
    ),
    "workspace_restore" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.restore"),
      false,
      true,
    ),
    "workspace_create" => write(
      "write:workspaces",
      USERS_WRITE,
      "workspace",
      Some("mcp.workspace.create"),
      false,
      true,
    ),
    "workspace_get" => read("read:workspaces", WORKSPACE_PUBLICATION, "workspace"),
    "workspace_update" => write(
      "write:workspaces",
      WORKSPACE_SETTINGS_WRITE,
      "workspace",
      Some("mcp.workspace.update"),
      true,
      true,
    ),
    "doc_publication_get" => read("read:docs", DOCUMENT_PUBLICATION_READ, "document"),
    "doc_publication_set" => write(
      "write:docs",
      DOCUMENT_PUBLICATION_WRITE,
      "document",
      Some("mcp.doc.publication.update"),
      true,
      true,
    ),
    "list_pages" | "read_doc" => read("read:docs", &[], "document"),
    "search_docs" => read("read:docs", SEARCH, "document"),
    "create_page" => write("write:docs", &[], "document", Some("mcp.doc.create"), false, false),
    "document_import" => write(
      "write:docs",
      IDEMPOTENCY,
      "document",
      Some("mcp.doc.import"),
      false,
      true,
    ),
    "document_image_insert" => write(
      "write:docs",
      BLOB_IDEMPOTENCY,
      "document",
      Some("mcp.doc.image.insert"),
      false,
      true,
    ),
    "document_reference_insert" => write(
      "write:docs",
      IDEMPOTENCY,
      "document",
      Some("mcp.doc.reference.insert"),
      false,
      true,
    ),
    "update_doc" => write(
      "write:docs",
      IDEMPOTENCY,
      "document",
      Some("mcp.doc.update"),
      true,
      true,
    ),
    "doc_patch" => write("write:docs", IDEMPOTENCY, "document", Some("mcp.doc.patch"), true, true),
    "delete_page" => write("write:docs", &[], "document", Some("mcp.doc.trash"), true, false),
    "restore_page" => write("write:docs", &[], "document", Some("mcp.doc.restore"), false, false),
    "page_projection_scan" | "page_projection_inspect" => read("read:docs", &[], "workspace"),
    "page_projection_repair" => write(
      "write:docs",
      IDEMPOTENCY,
      "document",
      Some("mcp.doc.projection.repair"),
      true,
      true,
    ),
    "folder_tree" | "folder_list" => read("read:docs", &[], "folder"),
    "folder_path_ensure" => write(
      "write:docs",
      IDEMPOTENCY,
      "folder",
      Some("mcp.folder.path.ensure"),
      false,
      true,
    ),
    "folder_entry_place" => write(
      "write:docs",
      IDEMPOTENCY,
      "folder_entry",
      Some("mcp.folder_entry.place"),
      true,
      true,
    ),
    "folder_create" => write("write:docs", &[], "folder", Some("mcp.folder.create"), false, false),
    "folder_update" => write("write:docs", &[], "folder", Some("mcp.folder.update"), true, false),
    "folder_delete" => write("write:docs", &[], "folder", Some("mcp.folder.delete"), true, false),
    "folder_entry_list" => read("read:docs", &[], "folder_entry"),
    "folder_entry_create" => write(
      "write:docs",
      &[],
      "folder_entry",
      Some("mcp.folder_entry.create"),
      false,
      false,
    ),
    "folder_entry_update" => write(
      "write:docs",
      &[],
      "folder_entry",
      Some("mcp.folder_entry.update"),
      true,
      false,
    ),
    "folder_entry_delete" => write(
      "write:docs",
      &[],
      "folder_entry",
      Some("mcp.folder_entry.delete"),
      true,
      false,
    ),
    "workspace_tag_list" | "workspace_tag_get" => read("read:docs", WORKSPACE_TAGS, "workspace_tag"),
    "document_tags_get" => read("read:docs", WORKSPACE_TAGS, "document_tag"),
    "workspace_tag_create" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "workspace_tag",
      Some("mcp.workspace_tag.create"),
      false,
      true,
    ),
    "workspace_tag_rename" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "workspace_tag",
      Some("mcp.workspace_tag.rename"),
      true,
      true,
    ),
    "workspace_tag_recolor" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "workspace_tag",
      Some("mcp.workspace_tag.recolor"),
      true,
      true,
    ),
    "workspace_tag_description_update" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "workspace_tag",
      Some("mcp.workspace_tag.description.update"),
      true,
      true,
    ),
    "workspace_tag_archive" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "workspace_tag",
      Some("mcp.workspace_tag.archive"),
      true,
      true,
    ),
    "workspace_tag_restore" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "workspace_tag",
      Some("mcp.workspace_tag.restore"),
      true,
      true,
    ),
    "workspace_tag_delete_permanently" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "workspace_tag",
      Some("mcp.workspace_tag.delete_permanently"),
      true,
      true,
    ),
    "document_tags_set" => write(
      "write:docs",
      WORKSPACE_TAG_WRITE,
      "document_tag",
      Some("mcp.document_tags.set"),
      true,
      true,
    ),
    "blob_list" | "blob_get_metadata" | "blob_read" => read("read:docs", BLOB, "blob"),
    "blob_upload" => write("write:docs", BLOB_UPLOAD, "blob", Some("mcp.blob.upload"), false, false),
    "document_asset_upload_prepare" => write(
      "write:docs",
      BLOB_UPLOAD,
      "blob",
      Some("mcp.document_asset.upload.prepare"),
      false,
      true,
    ),
    "blob_delete" => write("write:docs", BLOB, "blob", Some("mcp.blob.delete"), true, false),
    "template_list_for_workspace" | "template_request_reconcile" => {
      read("read:workspaces", TEMPLATE_REGISTRY, "workspace")
    }
    // `read:docs` is the delegated API-key capability, not an ACL shortcut.
    // The Application owner additionally requires Workspace Read for catalog
    // discovery and Document Read for every item, so External members cannot
    // discover templates they were not explicitly granted.
    "document_template_list" | "document_template_get" => read("read:docs", DOCUMENT_TEMPLATES, "document_template"),
    // `write:docs` delegates the API key to request a document-property or
    // creation mutation; it does not grant workspace membership. The
    // Application owner separately requires Workspace CreateDoc for create,
    // source Document Read plus referenced-asset BlobsRead for instantiate,
    // and Document PropertiesUpdate for mark/unmark. Those are the narrow
    // product permissions for the resources each operation actually changes
    // or discloses; the MCP scope never substitutes for them.
    "document_template_create" | "document_template_instantiate" => write(
      "write:docs",
      DOCUMENT_TEMPLATE_WRITES,
      "document_template",
      Some("mcp.document_template.write"),
      false,
      true,
    ),
    "document_template_mark" | "document_template_unmark" => write(
      "write:docs",
      DOCUMENT_TEMPLATE_WRITES,
      "document_template",
      Some("mcp.document_template.write"),
      true,
      true,
    ),
    "pdf_template_list" => read("read:workspaces", PDF_TEMPLATES, "workspace"),
    "pdf_export_get" => read("read:docs", &[ToolService::PdfExport], "pdf_export_job"),
    "pdf_export_create" => write(
      "read:docs",
      &[ToolService::PdfExport, ToolService::Idempotency],
      "pdf_export_job",
      None,
      false,
      true,
    ),
    "database_assistants_list" | "database_assistant_prepare" | "database_assistant_status" => read(
      "read:databases",
      &[ToolService::Database, ToolService::AssistantPackages],
      "database",
    ),
    "database_assistant_stop" => write(
      "write:databases",
      &[ToolService::Database, ToolService::AssistantPackages],
      "database",
      Some("mcp.database.assistant.stop"),
      false,
      true,
    ),
    "database_view_get"
    | "database_get"
    | "database_list"
    | "database_query"
    | "database_row_get"
    | "database_csv_export"
    | "database_json_export"
    | "database_json_import_preview"
    | "database_notion_export"
    | "database_notion_import_preview" => read("read:databases", DATABASE, "database"),
    "database_json_import" | "database_notion_import" => write(
      "write:databases",
      DATABASE,
      "database",
      Some("mcp.database.import"),
      true,
      false,
    ),
    "database_create" | "database_update" | "database_trash" | "database_restore" | "database_delete_permanently" => {
      write(
        "write:databases",
        DATABASE_WRITE,
        "database",
        Some(match name {
          "database_create" => "mcp.database.create",
          "database_update" => "mcp.database.update",
          "database_trash" => "mcp.database.trash",
          "database_restore" => "mcp.database.restore",
          _ => "mcp.database.delete_permanently",
        }),
        matches!(name, "database_trash" | "database_delete_permanently"),
        true,
      )
    }
    "database_view_create" | "database_view_update" | "database_view_delete" | "database_view_reorder" => write(
      "write:databases",
      DATABASE_WRITE,
      "database",
      Some(match name {
        "database_view_create" => "mcp.database.view.create",
        "database_view_update" => "mcp.database.view.update",
        "database_view_delete" => "mcp.database.view.delete",
        _ => "mcp.database.view.reorder",
      }),
      name == "database_view_delete",
      true,
    ),
    "database_field_create" | "database_field_update" | "database_field_delete" | "database_field_reorder" => write(
      "write:databases",
      DATABASE_WRITE,
      "database",
      Some(match name {
        "database_field_create" => "mcp.database.field.create",
        "database_field_update" => "mcp.database.field.update",
        "database_field_delete" => "mcp.database.field.delete",
        _ => "mcp.database.field.reorder",
      }),
      name == "database_field_delete",
      true,
    ),
    "database_row_create" => write(
      "write:databases",
      DATABASE_WRITE,
      "database",
      Some("mcp.database.row.create"),
      false,
      true,
    ),
    "database_cell_update" => write(
      "write:databases",
      DATABASE_WRITE,
      "database",
      Some("mcp.database.cell.update"),
      true,
      true,
    ),
    "database_row_update" => write(
      "write:databases",
      DATABASE_WRITE,
      "database_row",
      Some("mcp.database.row.update"),
      true,
      true,
    ),
    "database_row_delete" => write(
      "write:databases",
      DATABASE_WRITE,
      "database_row",
      Some("mcp.database.row.delete"),
      true,
      true,
    ),
    "database_row_restore" => write(
      "write:databases",
      DATABASE_WRITE,
      "database_row",
      Some("mcp.database.row.restore"),
      false,
      true,
    ),
    "database_row_from_template" => write(
      "write:databases",
      DATABASE_TEMPLATE_WRITE,
      "database",
      Some("mcp.database.row.from_template"),
      false,
      true,
    ),
    "document_graph_read" => read("read:document_graph", DOCUMENT_GRAPH, "document_graph"),
    "template_suggestions" => read("read:templates", TEMPLATE_SUGGESTIONS, "template"),
    "database_row_templates_list" => read("read:templates", DATABASE_TEMPLATE_READ, "database"),
    "automation_list" | "automation_run_list" | "automation_run_get" | "automation_dead_letter_list" => read(
      "read:automations",
      &[ToolService::WorkspaceAutomation],
      "workspace_automation_run",
    ),
    "automation_run_retry" => write(
      "write:automations",
      AUTOMATION_WRITE,
      "workspace_automation_run",
      Some("mcp.workspace_automation.run.retry"),
      false,
      true,
    ),
    "automation_run_stop" => write(
      "write:automations",
      AUTOMATION_WRITE,
      "workspace_automation_run",
      Some("mcp.workspace_automation.run.stop"),
      false,
      true,
    ),
    "doc_version_list" => read("read:docs", DOCUMENT_PERSISTENCE, "document_version"),
    "doc_version_read" => read("read:docs", DOCUMENT_PERSISTENCE, "document_version"),
    // The canonical history transaction records the API-key actor atomically.
    "doc_version_restore" => write(
      "write:docs",
      &[ToolService::DocumentPersistence, ToolService::Idempotency],
      "document_version",
      None,
      true,
      true,
    ),
    "doc_version_create" => write(
      "write:docs",
      DOCUMENT_PERSISTENCE,
      "document_version",
      Some("mcp.doc_version.create"),
      false,
      false,
    ),
    "doc_metadata_get" | "doc_metadata_validate" => read("read:docs", DOCUMENT_PERSISTENCE, "document_metadata"),
    "doc_metadata_transition" | "doc_metadata_update" => write(
      "write:docs",
      DOCUMENT_PERSISTENCE,
      "document_metadata",
      Some("mcp.doc.metadata.update"),
      true,
      false,
    ),
    _ => return None,
  })
}

fn title(name: &str) -> String {
  name
    .split('_')
    .map(|word| {
      if let Some(acronym) = match word {
        "csv" => Some("CSV"),
        "doc" => Some("Document"),
        "id" => Some("ID"),
        "json" => Some("JSON"),
        "pdf" => Some("PDF"),
        _ => None,
      } {
        return acronym.to_string();
      }
      let mut chars = word.chars();
      match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
      }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

fn document_palette_schema() -> Value {
  json!({"type":"string", "enum":["red","orange","yellow","green","teal","blue","purple","grey"]})
}
fn document_label_tone_schema() -> Value {
  json!({"type":"string", "enum":["neutral","info","positive","warning","danger","accent"]})
}
fn document_attribute_change_schema(value: Value) -> Value {
  json!({"oneOf":[
    {"type":"object", "required":["action","value"], "additionalProperties":false,
     "properties":{"action":{"const":"set"}, "value":value}},
    {"type":"object", "required":["action"], "additionalProperties":false,
     "properties":{"action":{"const":"remove"}}}
  ]})
}

fn document_text_formatting_schema() -> Value {
  json!({
    "type": "object", "minProperties": 1, "additionalProperties": false,
    "properties": {
      "bold": {"type": "boolean"}, "italic": {"type": "boolean"},
      "underline": {"type":"boolean"},
      "color":document_attribute_change_schema(document_palette_schema()),
      "background":document_attribute_change_schema(document_palette_schema()),
      "labelTone":document_attribute_change_schema(document_label_tone_schema()),
      "strike": {"type": "boolean"}, "code": {"type": "boolean"},
      "link": {"oneOf": [
        {"type": "object", "required": ["action", "href"], "additionalProperties": false,
          "properties": {"action": {"const": "set"}, "href": {"type": "string", "minLength": 1, "maxLength": 4096}}},
        {"type": "object", "required": ["action"], "additionalProperties": false,
          "properties": {"action": {"const": "remove"}}}
      ]}
    }
  })
}

fn document_citation_reference_schema() -> Value {
  json!({"oneOf":[
    {"type":"object","required":["type","docId"],"additionalProperties":false,"properties":{
      "type":{"const":"doc"},"docId":{"type":"string","minLength":1},"workspaceId":{"type":"string","format":"uuid"},"title":{"type":"string"},"description":{"type":"string"}
    }},
    {"type":"object","required":["type","blobId"],"additionalProperties":false,"properties":{
      "type":{"const":"attachment"},"blobId":{"type":"string","minLength":1},"workspaceId":{"type":"string","format":"uuid"},"fileName":{"type":"string"},"fileType":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"}
    }},
    {"type":"object","required":["type","url"],"additionalProperties":false,"properties":{
      "type":{"const":"url"},"url":{"type":"string","minLength":1},"favicon":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"}
    }}
  ]})
}

fn document_inline_reference_schema() -> Value {
  json!({"type":"object","required":["pageId"],"additionalProperties":false,"properties":{
    "pageId":{"type":"string","minLength":1,"maxLength":4096,"description":"Public external document key in this workspace; resolved and checked for current target Read permission on each call/replay."},
    "title":{"type":"string","minLength":1,"maxLength":1024,"description":"Optional authored label; omission uses the normal document title presentation."}
  }})
}

fn document_text_spans_schema() -> Value {
  let citation_reference = document_citation_reference_schema();
  let footnote = json!({"oneOf":[
    {"type":"object","required":["label","reference"],"additionalProperties":false,"properties":{"label":{"type":"string","minLength":1},"reference":citation_reference.clone()}},
    {"type":"object","required":["label","definitionId"],"additionalProperties":false,"properties":{"label":{"type":"string","minLength":1},"definitionId":{"type":"string","minLength":1}}}
  ]});
  let mention = json!({"type":"object","required":["member"],"additionalProperties":false,"properties":{"member":{"type":"string","format":"uuid","description":"Active accepted workspace member UUID from workspace_member_list; checked with current UsersRead authority on every call/replay. Inserts without notification; mention_user remains a separate action."}}});
  let spans = json!({
    "type": "array",
    "items": {
      "type": "object",
      "required": ["text"],
      "additionalProperties": false,
      "allOf":[{"if":{"required":["mention"]},"then":{"properties":{"text":{"const":" "},"link":{"type":"null"}},"not":{"anyOf":[{"required":["reference"]},{"required":["footnote"]},{"required":["annotationId"]}]}}},{"if":{"required":["reference"]},"then":{"properties":{"text":{"const":" "},"link":{"type":"null"}},"not":{"required":["footnote"]}}},{"if":{"required":["annotationId"]},"then":{"properties":{"text":{"type":"string","minLength":1},"annotationId":{"type":"string"},"bold":{"const":false},"italic":{"const":false},"strike":{"const":false},"code":{"const":false},"underline":{"const":false},"link":{"type":"null"}},"additionalProperties":false}},{"if":{"required":["latex"]},"then":{"properties":{"text":{"const":" "},"link":{"type":"null"},"bold":{"const":false},"italic":{"const":false},"strike":{"const":false},"code":{"const":false},"underline":{"const":false}},"not":{"anyOf":[{"required":["reference"]},{"required":["footnote"]},{"required":["annotationId"]},{"required":["mention"]}]}}}],
      "properties": {
        "text": { "type": "string" },
        "bold": { "type": "boolean", "default": false },
        "underline": {"type":"boolean"}, "color":document_palette_schema(),
        "background":document_palette_schema(), "labelTone":document_label_tone_schema(),
        "italic": { "type": "boolean", "default": false },
        "strike": { "type": "boolean", "default": false },
        "code": { "type": "boolean", "default": false },
        "link": { "type": ["string", "null"] }, "mention":mention, "footnote":footnote, "reference":document_inline_reference_schema(), "annotationId":{"type":"string","minLength":1,"maxLength":4096,"description":"Insertion-local annotation grouping key. The full literal text body receives a fresh native identity on insertion; read native annotationId for subsequent edit_annotation calls."}, "latex":{"type":"string","description":"Inline formula source (LaTeX). The span text must be a single space and no other marks or semantic atoms may be set."}
      }
    }
  });
  spans
}

fn table_presentation_schema() -> Value {
  let change = document_attribute_change_schema;
  json!({"type":"object","minProperties":1,"additionalProperties":false,"properties":{
    "appearance":change(json!({"enum":["grid","ruled","plain"]})),
    "density":change(json!({"enum":["normal","compact"]})),
    "textAlign":change(json!({"enum":["left","center","right"]}))
  }})
}
fn table_coordinate_properties_schema(row: bool) -> Value {
  let change = document_attribute_change_schema;
  let mut schema = json!({"type":"object","minProperties":1,"additionalProperties":false,"properties":{
    "backgroundColor":change(document_palette_schema())
  }});
  if !row {
    schema["properties"]["textAlign"] = change(json!({"enum":["left","center","right"]}));
    schema["properties"]["width"] = change(
      json!({"type":"number","minimum":60,"description":"Finite native resize width in pixels; the editor clamps to 60 and has no resize maximum. Removal restores the absent automatic width."}),
    );
  }
  schema
}

fn document_block_properties_schema() -> Value {
  let change = document_attribute_change_schema;
  let palette = document_palette_schema();
  let mut background = palette.clone();
  background["enum"]
    .as_array_mut()
    .expect("palette enum")
    .push(json!("default"));
  let mut properties = serde_json::Map::from_iter([
    (
      "headerRows".into(),
      json!({"type":"integer","minimum":0,"description":"Native tables only: count of leading header rows, bounded by current rows and excluding repeat prototypes. Zero removes designation; omission preserves it."}),
    ),
    ("headingLevel".into(), json!({"type":"integer","minimum":1,"maximum":6})),
    ("listKind".into(), json!({"enum":["bulleted","numbered","todo"]})),
    ("checked".into(), json!({"type":"boolean"})),
    ("language".into(), json!({"type":"string","maxLength":128})),
  ]);
  for name in ["alt", "title", "url"] {
    properties.insert(name.into(), json!({"type":"string","maxLength":4096}));
  }
  for name in ["collapsed", "foldable", "defaultOpen", "wrap", "preview", "lineNumber"] {
    properties.insert(name.into(), change(json!({"type":"boolean"})));
  }
  properties.insert("table".into(), table_presentation_schema());
  properties.insert("textAlign".into(), change(json!({"enum":["left","center","right"]})));
  properties.insert("presentation".into(), change(json!({"const":"eyebrow","description":"Plain text paragraphs only; heading and quote renderers do not use this presentation."})));
  properties.insert(
    "order".into(),
    change(json!({"type":"integer","minimum":-9007199254740991_i64,"maximum":9007199254740991_i64})),
  );
  properties.insert(
    "calloutType".into(),
    change(json!({"type":"string","minLength":1,"maxLength":128,"allOf":[{"pattern":"^[a-zA-Z]"},{"not":{"pattern":"[^a-zA-Z0-9_-]"}}]})),
  );
  properties.insert("backgroundColorName".into(), change(background));
  properties.insert("appearance".into(), change(json!({"enum":["soft","accent","outline"]})));
  properties.insert("caption".into(), change(json!({"type":"string","maxLength":4096})));
  properties.insert(
    "label".into(),
    json!({"type":"string","minLength":1,"maxLength":512,"description":"Local footnote definition only: new label. Must pass the Markdown footnote-label grammar and not collide with an existing definition, footnoteIdentifier or marker (normalized comparison). Omission preserves the current label."}),
  );
  properties.insert(
    "placement".into(),
    change(json!({"enum":["footnote","endnote"],"description":"Local footnote definition only. Remove reverts to the legacy absent footnote default without rewriting stored data."})),
  );
  properties.insert(
    "latex".into(),
    json!({"type":"string","maxLength":1048576,"description":"Block formula (myoxus:latex) only: new source. Omission preserves the source; an explicit empty string clears it without deleting or converting the block."}),
  );
  properties.insert("icon".into(),change(json!({"oneOf":[
    {"type":"object","required":["type","unicode"],"additionalProperties":false,"properties":{"type":{"const":"emoji"},"unicode":{"type":"string","minLength":1,"maxLength":64,"not":{"pattern":"[\\u0000-\\u001f\\u007f-\\u009f]"}}}},
    {"type":"object","required":["type","name","color"],"additionalProperties":false,"properties":{"type":{"const":"myoxus-icon"},"name":{"type":"string","minLength":1,"maxLength":128,"description":"Canonical editor glyph name without the Icon suffix."},"color":palette}}
  ]})));
  json!({"type":"object","minProperties":1,"additionalProperties":false,"properties":properties})
}

/// Typed citation source reference: doc, url or attachment. The required target
/// field is selected by type; optional metadata fields are strings. A supplied
/// `workspaceId` selects the target workspace; omission uses the document
/// workspace.
fn citation_reference_schema() -> Value {
  document_citation_reference_schema()
}

fn fragment_properties_schema(kind: &str) -> Value {
  let mut schema = document_block_properties_schema();
  let allowed: &[&str] = match kind {
    "paragraph" => &["textAlign", "presentation"],
    "quote" => &["textAlign"],
    "heading" => &["textAlign", "collapsed"],
    "list_item" => &["textAlign", "collapsed", "order"],
    "callout" => &[
      "calloutType",
      "icon",
      "backgroundColorName",
      "appearance",
      "foldable",
      "defaultOpen",
    ],
    "code" => &["wrap", "caption", "preview", "lineNumber"],
    _ => &[],
  };
  schema["properties"]
    .as_object_mut()
    .expect("property schema")
    .retain(|k, _| allowed.contains(&k.as_str()));
  schema
}

fn document_fragment_schema(min_items: usize, allow_images: bool, allow_references: bool) -> Value {
  let citation_reference = document_citation_reference_schema();
  let mut spans = document_text_spans_schema();
  if !allow_references {
    // Composed document_import deliberately retains its narrower lifecycle contract.
    spans["items"]["properties"]
      .as_object_mut()
      .expect("span properties")
      .remove("reference");
  }
  let text_block = |kind: &str| {
    json!({
      "type": "object",
      "required": ["kind", "spans"],
      "additionalProperties": false,
      "properties": { "kind": { "const": kind }, "spans": spans.clone() }
    })
  };
  let mut schema = json!({
    "type": "object",
    "required": ["schemaVersion", "blocks"],
    "additionalProperties": false,
    "properties": {
      "schemaVersion": { "const": "myoxus.document-fragment.v1" },
      "blocks": {
        "type": "array",
        "minItems": min_items,
        "items": { "$ref": "#/$defs/documentFragment/$defs/documentBlock" }
      }
    },
    "$defs": {
      "documentBlock": {
        "oneOf": [
          text_block("paragraph"),
          {
            "type": "object", "required": ["kind", "level", "spans"], "additionalProperties": false,
            "properties": {
              "kind": { "const": "heading" }, "level": { "type": "integer", "minimum": 1, "maximum": 6 },
              "spans": spans.clone()
            }
          },
          {
            "type": "object", "required": ["kind", "listKind", "spans"], "additionalProperties": false,
            "properties": {
              "kind": { "const": "list_item" },
              "listKind": { "type": "string", "enum": ["bulleted", "numbered", "todo"] },
              "spans": spans.clone(), "checked": { "type": "boolean", "default": false },
              "children": { "type": "array", "items": { "$ref": "#/$defs/documentFragment/$defs/documentBlock" } }
            }
          },
          text_block("quote"),
          {"type":"object","required":["kind","spans"],"additionalProperties":false,"properties":{
            "kind":{"const":"callout"},"spans":spans.clone(),"calloutType":{"type":"string"},"title":{"type":"string"},"foldable":{"type":"boolean"},"defaultOpen":{"type":"boolean"},"children":{"type":"array","items":{"$ref":"#/$defs/documentFragment/$defs/documentBlock"}}
          }},
          {"type":"object","required":["kind","definitionId","label","children"],"additionalProperties":false,"properties":{
            "kind":{"const":"footnote_definition"},"definitionId":{"type":"string","minLength":1,"description":"Fragment-local identity, rebound to a new native block ID on insertion."},"label":{"type":"string","minLength":1},"placement":{"enum":["footnote","endnote"]},"children":{"type":"array","items":{"$ref":"#/$defs/documentFragment/$defs/documentBlock"}}
          }},
          {"type":"object","required":["kind","label","reference"],"additionalProperties":false,"properties":{
            "kind":{"const":"citation_definition"},"label":{"type":"string","minLength":1},"reference":citation_reference.clone()
          }},
          {
            "type": "object", "required": ["kind", "text"], "additionalProperties": false,
            "properties": { "kind": { "const": "code" }, "language": { "type": "string" }, "text": { "type": "string" } }
          },
          {
            "type": "object", "required": ["kind", "latex"], "additionalProperties": false,
            "properties": { "kind": { "const": "latex" }, "latex": { "type": "string", "description": "Block formula source (LaTeX); written to the editor's native myoxus:latex block." } }
          },
          {
            "type": "object", "required": ["kind", "source"], "additionalProperties": false,
            "properties": {
              "kind": { "const": "mermaid" }, "source": { "type": "string", "minLength": 1 },
              "title": { "type": "string" }, "caption": { "type": "string" }
            }
          },
          { "type": "object", "required": ["kind"], "additionalProperties": false, "properties": { "kind": { "const": "divider" } } },
          {
            "type": "object", "required": ["kind", "source"], "additionalProperties": false,
            "properties": { "kind": { "const": "image" }, "source": { "type": "string", "minLength": 1 }, "alt": { "type": "string" } }
          },
          {
            "type": "object", "required": ["kind", "url"], "additionalProperties": false,
            "properties": { "kind": { "const": "bookmark" }, "url": { "type": "string", "minLength": 1 }, "title": { "type": "string" } }
          },
          {
            "type": "object", "required": ["kind", "rows"], "additionalProperties": false,
            "properties": {
              "kind": { "const": "table" },
              "properties": table_presentation_schema(),
              "headerRows": { "type": "integer", "minimum": 0, "description": "Number of leading header rows, bounded by the row count. Zero means no header; omission preserves the absent native property." },
              "rows": {
                "type": "array", "items": {
                  "type": "array", "items": { "type": "array", "items": spans["items"].clone() }
                }
              }
            }
          }
        ]
      }
    }
  });
  if let Some(variants) = schema
    .pointer_mut("/$defs/documentBlock/oneOf")
    .and_then(Value::as_array_mut)
  {
    for variant in variants {
      if let Some(kind) = variant
        .pointer("/properties/kind/const")
        .and_then(Value::as_str)
        .map(str::to_string)
      {
        if ["paragraph", "heading", "quote", "list_item", "callout", "code"].contains(&kind.as_str()) {
          variant["properties"]["properties"] = fragment_properties_schema(&kind);
        }
      }
    }
  }
  schema["$defs"]["documentBlock"]["oneOf"].as_array_mut().expect("block variants").push(json!({"type":"object","required":["kind","text"],"additionalProperties":false,"properties":{"kind":{"const":"annotation"},"text":{"type":"string"}}}));
  if !allow_images {
    schema["$defs"]["documentBlock"]["oneOf"]
      .as_array_mut()
      .expect("document block variants")
      .retain(|variant| variant["properties"]["kind"]["const"] != "image");
  }
  schema
}

fn mutation_readback_schema() -> Value {
  json!({"oneOf": [
    {"type":"object", "additionalProperties":false, "required":["status"],
     "properties":{"status":{"const":"complete"}}},
    {"type":"object", "additionalProperties":false, "required":["status","reason"],
     "properties":{"status":{"const":"unavailable"}, "reason":{"enum":[
       "read_access_denied", "asset_access_denied", "projection_failed", "output_limit",
       "affected_block_unavailable", "legacy_commit_unavailable"
     ]}}}
  ]})
}

fn workspace_member_output_schema(status: &str) -> Value {
  json!({"type":"object","additionalProperties":false,"required":["userId","name","email","disabled","role","status","inviteId"],
    "properties":{"userId":{"type":"string","format":"uuid"},"name":{"type":"string"},"email":{"type":"string"},
      "disabled":{"type":"boolean"},"role":{"type":"string","enum":["Owner","Admin","Manager","Collaborator","Commenter","Reader","External"]},
      "status":{"type":"string","const":status},"inviteId":{"type":"string","format":"uuid"}}})
}

fn user_output_schema(detail: bool) -> Value {
  let mut schema = json!({
    "type": "object", "additionalProperties": false,
    "required": ["id", "email", "name", "avatar_url", "is_admin", "disabled", "has_password", "email_verified_at"],
    "properties": {
      "id": {"type": "string", "format": "uuid"}, "email": {"type": "string"},
      "name": {"type": ["string", "null"]}, "avatar_url": {"type": ["string", "null"]},
      "is_admin": {"type": "boolean"}, "disabled": {"type": "boolean"}, "has_password": {"type": "boolean"},
      "email_verified_at": {"type": ["string", "null"], "format": "date-time"}
    }
  });
  if detail {
    schema["required"]
      .as_array_mut()
      .expect("required fields")
      .extend(["avatar_key", "status", "registered", "created_at", "updated_at"].map(|name| json!(name)));
    schema["properties"]["avatar_key"] = json!({"type": ["string", "null"]});
    schema["properties"]["status"] = json!({"type": "string", "enum": ["Active", "Disabled"]});
    schema["properties"]["registered"] = json!({"type": "boolean"});
    schema["properties"]["created_at"] = json!({"type": "string", "format": "date-time"});
    schema["properties"]["updated_at"] = json!({"type": "string", "format": "date-time"});
  }
  schema
}

fn organization_read_output_schema(name: &str) -> Value {
  let mut properties = Map::new();
  let mut field = |name: &str, schema: Value| {
    properties.insert(name.to_string(), schema);
  };
  let text = json!({"type":"string"});
  let nullable = json!({"type":["string","null"]});
  let id = json!({"type":"string","format":"uuid"});
  let time = json!({"type":"string","format":"date-time"});
  match name {
    "organization_get" => {
      field("id", id);
      for key in ["key", "name", "slug"] {
        field(key, text.clone());
      }
    }
    "organization_unit_type_list" => {
      for key in ["id", "organization_id"] {
        field(key, id.clone());
      }
      for key in ["key", "label"] {
        field(key, text.clone());
      }
      for key in ["description", "icon", "color"] {
        field(key, nullable.clone());
      }
      for key in [
        "is_preset",
        "is_active",
        "is_structural",
        "can_have_children",
        "can_be_root_level",
        "can_be_manager_created",
        "can_have_cross_unit_members",
        "can_own_workspaces",
        "can_manage_workspaces",
        "is_staff_unit",
        "requires_admin_approval",
      ] {
        field(key, json!({"type":"boolean"}));
      }
      field("metadata", json!({}));
      for key in ["created_at", "updated_at"] {
        field(key, time.clone());
      }
    }
    "organization_unit_member_list" => {
      for key in ["unit_id", "user_id"] {
        field(key, id.clone());
      }
      for key in ["role", "source"] {
        field(key, text.clone());
      }
      for key in ["email", "name", "avatar_url"] {
        field(key, nullable.clone());
      }
      field("metadata", json!({}));
      for key in ["created_at", "updated_at"] {
        field(key, time.clone());
      }
    }
    _ => {
      field("unit_id", id);
      for key in ["unit_name", "unit_slug", "unit_status", "role", "source"] {
        field(key, text.clone());
      }
      field("metadata", json!({}));
      field("joined_at", time);
    }
  }
  let required = properties.keys().cloned().collect::<Vec<_>>();
  let item = json!({"type":"object","additionalProperties":false,"required":required,"properties":properties});
  if name == "organization_get" {
    return item;
  }
  json!({"type":"object","additionalProperties":false,"required":["items","offset","limit","next_offset"],"properties":{"items":{"type":"array","maxItems":100,"items":item},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100},"next_offset":{"type":["integer","null"],"minimum":0}}})
}

mod automation;
mod calendar;
mod core;
mod database;
mod organization;

fn document_output_schema(name: &str) -> Option<Value> {
  match name {
    "automation_list" | "automation_run_list" | "automation_run_get" | "automation_dead_letter_list" => {
      automation::output_schema(name)
    }
    "comment_create" => Some(comment_create_output_schema()),
    "comment_update"
    | "comment_set_resolved"
    | "comment_delete"
    | "comment_thread_mark_read"
    | "comment_threads_mark_all_read" => Some(comment_lifecycle_output_schema(name)),
    "comment_thread_list" | "comment_reply_list" | "comment_history_list" => Some(comment_output_schema(name)),
    "list_workspaces"
    | "list_pages"
    | "folder_tree"
    | "folder_list"
    | "folder_create"
    | "folder_update"
    | "folder_delete"
    | "folder_entry_list"
    | "folder_entry_create"
    | "folder_entry_update"
    | "folder_entry_delete"
    | "folder_path_ensure"
    | "folder_entry_place"
    | "blob_list"
    | "blob_get_metadata"
    | "blob_read"
    | "blob_upload"
    | "blob_delete"
    | "template_list_for_workspace"
    | "template_request_reconcile"
    | "template_suggestions"
    | "pdf_template_list"
    | "document_graph_read"
    | "automation_run_retry"
    | "automation_run_stop"
    | "doc_version_list"
    | "doc_version_create"
    | "doc_metadata_get"
    | "doc_metadata_validate"
    | "doc_metadata_transition"
    | "doc_metadata_update" => core::output_schema(name),
    "organization_unit_list"
    | "organization_unit_get"
    | "organization_unit_delete_preview"
    | "organization_unit_create"
    | "organization_unit_update"
    | "organization_unit_move"
    | "organization_unit_set_status"
    | "organization_unit_delete_permanent" => organization::output_schema(name),
    "calendar_events_list"
    | "calendar_conflicts_check"
    | "calendar_event_create"
    | "calendar_event_update"
    | "calendar_event_delete" => calendar::output_schema(name),
    "database_assistants_list"
    | "database_assistant_prepare"
    | "database_assistant_status"
    | "database_assistant_stop"
    | "database_view_get"
    | "database_view_create"
    | "database_view_update"
    | "database_view_delete"
    | "database_view_reorder"
    | "database_field_create"
    | "database_field_update"
    | "database_field_delete"
    | "database_field_reorder"
    | "database_get"
    | "database_create"
    | "database_update"
    | "database_trash"
    | "database_restore"
    | "database_delete_permanently" => database::output_schema(name),
    "database_list"
    | "database_query"
    | "database_csv_export"
    | "database_json_export"
    | "database_json_import_preview"
    | "database_json_import"
    | "database_notion_export"
    | "database_notion_import_preview"
    | "database_notion_import"
    | "database_row_create"
    | "database_cell_update"
    | "database_row_get"
    | "database_row_update"
    | "database_row_delete"
    | "database_row_restore"
    | "database_row_from_template"
    | "database_row_templates_list" => database::output_schema(name),
    "user_delete" => Some(
      json!({"type":"object","additionalProperties":false,"required":["user_id","deleted"],"properties":{"user_id":{"type":"string","format":"uuid"},"deleted":{"type":"boolean","const":true}}}),
    ),
    "user_set_admin" => Some(
      json!({"type":"object","additionalProperties":false,"required":["user_id","previous_is_admin","is_admin"],"properties":{"user_id":{"type":"string","format":"uuid"},"previous_is_admin":{"type":"boolean"},"is_admin":{"type":"boolean"}}}),
    ),
    "organization_unit_member_add" | "organization_unit_member_set_role" | "organization_unit_member_remove" => Some(
      json!({"type":"object","additionalProperties":false,"required":["unit_id","user_id","previous_role","role","manager_capability_changed","manager_capability"],"properties":{"unit_id":{"type":"string","format":"uuid"},"user_id":{"type":"string","format":"uuid"},"previous_role":{"type":["string","null"],"enum":["reader","member","manager",null]},"role":{"type":["string","null"],"enum":["reader","member","manager",null]},"manager_capability_changed":{"type":"boolean"},"manager_capability":{"type":["boolean","null"]}}}),
    ),
    "organization_get"
    | "organization_unit_type_list"
    | "organization_unit_member_list"
    | "user_organization_memberships" => Some(organization_read_output_schema(name)),
    "user_get" | "user_create" => Some(user_output_schema(true)),
    "user_update" | "user_suspend" | "user_enable" => Some(user_output_schema(false)),
    "user_list" => Some(json!({
      "type": "object", "additionalProperties": false,
      "required": ["users", "offset", "limit", "total", "next_offset"],
      "properties": {
        "users": {"type": "array", "maxItems": 100, "items": user_output_schema(true)},
        "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        "total": {"type": "integer", "minimum": 0}, "next_offset": {"type": ["integer", "null"], "minimum": 0}
      }
    })),
    "user_reset_link" => Some(json!({
      "type": "object", "additionalProperties": false,
      "required": ["user_id", "reset_link", "expires_at"],
      "properties": {"user_id": {"type": "string", "format": "uuid"}, "reset_link": {"type": "string", "format": "uri"},
        "expires_at": {"type": "string", "format": "date-time"}}
    })),
    "search_docs" => Some(json!({
      "type": "object", "required": ["results", "total_count", "next_cursor", "exhausted"], "additionalProperties": false,
      "properties": {
        "results": {"type": "array", "maxItems": 50, "items": {
          "type": "object", "required": ["externalId", "title", "snippet", "updated_at"], "additionalProperties": false,
          "properties": {
            "externalId": {"type": "string"}, "title": {"type": "string"}, "snippet": {"type": "string"},
            "updated_at": {"type": "string", "format": "date-time", "description": "Index timestamp; not source verification or current native modification time."},
            "okf_type": {"type": "string"}, "description": {"type": "string"},
            "description_source": {"type": "string", "enum": ["imported_declaration", "indexed_content"]},
            "description_index_updated_at": {"type": "string", "format": "date-time"},
            "document_updated_at": {"type": "string", "format": "date-time"},
            "metadata_updated_at": {"type": "string", "format": "date-time"},
            "tags": {"type": "array", "items": {"type": "object", "additionalProperties": false,
              "required": ["id", "label"], "properties": {"id": {"type": "string", "format": "uuid"}, "label": {"type": "string"}}}},
            "enrichment_diagnostics": {"type": "array", "maxItems": 4, "items": {"type": "string"}}
          }
        }},
        "total_count": {"type": "integer", "minimum": 0, "maximum": 50, "description": "Returned result count, not a global match count."},
        "next_cursor": {"type": ["string", "null"]}, "exhausted": {"type": "boolean"}
      }
    })),
    "workspace_owner_transfer" => Some(json!({"type":"object","additionalProperties":false,
      "required":["workspaceId","mode","ownerPrincipalType","ownerPrincipalId","transferred"],"properties":{
        "workspaceId":{"type":"string","format":"uuid"},"mode":{"type":"string","enum":["member","principal"]},
        "ownerPrincipalType":{"type":"string","enum":["user","ou"]},"ownerPrincipalId":{"type":"string","format":"uuid"},
        "transferred":{"type":"boolean","const":true}}})),
    "workspace_management_unit_set" => Some(json!({"type":"object","additionalProperties":false,
      "required":["workspaceId","managementUnitId","updated"],"properties":{
        "workspaceId":{"type":"string","format":"uuid"},"managementUnitId":{"type":["string","null"],"format":"uuid"},
        "updated":{"type":"boolean","const":true}}})),
    "workspace_member_invite" => Some(workspace_member_output_schema("Pending")),
    "workspace_invite_link_get" => Some(
      json!({"type":"object","additionalProperties":false,"required":["workspaceId","active","expiresAt"],
      "properties":{"workspaceId":{"type":"string","format":"uuid"},"active":{"type":"boolean"},"expiresAt":{"type":["string","null"],"format":"date-time"}}}),
    ),
    "workspace_invite_link_create" => Some(
      json!({"type":"object","additionalProperties":false,"required":["workspaceId","link","expiresAt"],
      "properties":{"workspaceId":{"type":"string","format":"uuid"},"link":{"type":"string","format":"uri"},"expiresAt":{"type":["string","null"],"format":"date-time"}}}),
    ),
    "workspace_invite_link_revoke" => Some(
      json!({"type":"object","additionalProperties":false,"required":["workspaceId","revoked"],
      "properties":{"workspaceId":{"type":"string","format":"uuid"},"revoked":{"type":"boolean","const":true}}}),
    ),
    "workspace_member_add" => Some(workspace_member_output_schema("Accepted")),
    "workspace_member_list" => Some(json!({"type":"object","additionalProperties":false,
      "required":["members","offset","limit","next_offset"],"properties":{
      "members":{"type":"array","maxItems":200,"items":workspace_member_output_schema("Accepted")},
      "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200},
      "next_offset":{"type":["integer","null"],"minimum":0}}})),
    "workspace_member_set_role" | "workspace_member_remove" => {
      let field = if name == "workspace_member_remove" {
        "removed"
      } else {
        "updated"
      };
      Some(
        json!({"type":"object","additionalProperties":false,"required":["workspaceId","userId",field],
        "properties":{"workspaceId":{"type":"string","format":"uuid"},"userId":{"type":"string","format":"uuid"},
          (field):{"type":"boolean","const":true}}}),
      )
    }
    "workspace_delete" => Some(
      json!({"type":"object","additionalProperties":false,"required":["id","deleted"],
      "properties":{"id":{"type":"string","format":"uuid"},"deleted":{"type":"boolean","const":true}}}),
    ),
    "workspace_restore" => Some(
      json!({"type":"object","additionalProperties":false,"required":["id","restored"],
      "properties":{"id":{"type":"string","format":"uuid"},"restored":{"type":"boolean","const":true}}}),
    ),
    "workspace_create" => Some(json!({
      "type": "object", "additionalProperties": false, "required": ["id", "classification", "initialized"],
      "properties": {
        "id": {"type": "string", "format": "uuid"},
        "classification": {"type": "string", "enum": ["personal", "user_owned", "shared"]},
        "initialized": {"type": "boolean", "const": true}
      }
    })),
    "workspace_get" | "workspace_update" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "name", "description", "public", "enable_sharing",
        "publicly_accessible", "public_document_selection_count", "public_url"
      ],
      "properties": {
        "id": { "type": "string", "format": "uuid" },
        "name": { "type": "string" },
        "description": { "type": "string" },
        "public": { "type": "boolean" },
        "enable_sharing": { "type": "boolean" },
        "publicly_accessible": { "type": "boolean" },
        "public_document_selection_count": { "type": "integer", "minimum": 0 },
        "public_url": { "type": ["string", "null"], "format": "uri" }
      }
    })),
    "doc_publication_get" | "doc_publication_set" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["workspaceId", "externalId", "public", "mode", "publiclyAccessible", "publicUrl"],
      "properties": {
        "workspaceId": { "type": "string", "format": "uuid" },
        "externalId": { "type": "string" },
        "public": { "type": "boolean" },
        "mode": { "type": ["string", "null"], "enum": ["Page", "Edgeless", null] },
        "publiclyAccessible": { "type": "boolean" },
        "publicUrl": { "type": ["string", "null"], "format": "uri" }
      }
    })),
    "workspace_tag_list" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["items", "offset", "limit", "nextOffset"],
      "properties": {
        "items": { "type": "array", "items": workspace_tag_compact_output_schema() },
        "offset": { "type": "integer", "minimum": 0 },
        "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
        "nextOffset": { "type": ["integer", "null"], "minimum": 0 }
      }
    })),
    "workspace_tag_get"
    | "workspace_tag_create"
    | "workspace_tag_rename"
    | "workspace_tag_recolor"
    | "workspace_tag_description_update"
    | "workspace_tag_archive"
    | "workspace_tag_restore" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "name", "colorRole", "archived", "description"],
      "properties": {
        "id": { "type": "string", "format": "uuid" },
        "name": { "type": "string" },
        "colorRole": workspace_tag_color_role_output_schema(),
        "archived": { "type": "boolean" },
        "description": { "type": ["string", "null"] }
      }
    })),
    "workspace_tag_delete_permanently" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["tagId", "deleted"],
      "properties": {
        "tagId": { "type": "string", "format": "uuid" },
        "deleted": { "const": true }
      }
    })),
    "document_tags_get" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["externalId", "tags"],
      "properties": {
        "externalId": { "type": "string" },
        "tags": { "type": "array", "items": workspace_tag_compact_output_schema() }
      }
    })),
    "document_tags_set" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["externalId", "tags"],
      "properties": {
        "externalId": { "type": "string" },
        "tags": { "type": "array", "items": workspace_tag_compact_output_schema() }
      }
    })),
    "document_template_list" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["offset", "limit", "nextOffset", "templates"],
      "properties": {
        "offset": { "type": "integer" },
        "limit": { "type": "integer" },
        "nextOffset": { "type": ["integer", "null"], "minimum": 0 },
        "templates": { "type": "array", "items": document_template_summary_output_schema() }
      }
    })),
    "document_template_get" => Some(document_template_summary_output_schema()),
    "document_template_create" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": [
        "externalId", "title", "isTemplate", "documentRevision", "rootRevision",
        "folderId", "folderPath", "entryId", "inputMode"
      ],
      "properties": {
        "externalId": { "type": "string" },
        "title": { "type": "string" },
        "isTemplate": { "type": "boolean", "const": true },
        "documentRevision": { "type": "integer" },
        "rootRevision": { "type": "integer" },
        "folderId": { "type": "string" },
        "folderPath": { "type": "array", "items": { "type": "string" } },
        "entryId": { "type": "string" },
        "inputMode": { "type": "string", "enum": ["fragment", "markdown"] }
      }
    })),
    "document_template_instantiate" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": [
        "externalId", "documentRevision", "rootRevision", "folderId", "folderPath", "entryId"
      ],
      "properties": {
        "externalId": { "type": "string" },
        "documentRevision": { "type": "integer" },
        "rootRevision": { "type": "integer" },
        "folderId": { "type": "string" },
        "folderPath": { "type": "array", "items": { "type": "string" } },
        "entryId": { "type": "string" }
      }
    })),
    "document_template_mark" | "document_template_unmark" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["externalId", "isTemplate"],
      "properties": {
        "externalId": { "type": "string" },
        "isTemplate": { "type": "boolean" }
      }
    })),
    "read_doc" => Some(document_read_output_schema()),
    "doc_version_read" => Some(document_version_read_output_schema()),
    "pdf_export_create" | "pdf_export_get" => Some(pdf_export_output_schema()),
    "doc_version_restore" => Some(json!({
      "type": "object", "additionalProperties": false,
      "required": ["workspaceId","externalId","sourceVersionId","versionId","docHistoryId","label","versionNo","sequence","revision","recoveryHistoryId","restoredAt"],
      "properties": {
        "workspaceId":{"type":"string","format":"uuid"},"externalId":{"type":"string"},
        "sourceVersionId":{"type":"string","format":"uuid"},"versionId":{"type":"string","format":"uuid"},
        "docHistoryId":{"type":"integer","minimum":1},"recoveryHistoryId":{"type":"integer","minimum":1},
        "label":{"type":"string","minLength":1},"versionNo":{"type":["integer","null"],"minimum":1},
        "sequence":{"type":"integer","minimum":0},"revision":{"type":"integer","minimum":0},
        "restoredAt":{"type":"string","format":"date-time"}
      }
    })),
    "create_page" => Some(json!({
      "type": "object",
      "required": ["externalId", "title", "created_at", "leaf_sequence", "root_sequence"],
      "properties": {
        "externalId": { "type": "string" }, "title": { "type": "string" },
        "created_at": { "type": "string", "format": "date-time" },
        "leaf_sequence": { "type": "integer" }, "root_sequence": { "type": "integer" }
      }
    })),
    "document_import" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": [
        "externalId", "title", "documentRevision", "rootRevision",
        "folderId", "folderPath", "entryId", "blockCount", "inputMode"
      ],
      "properties": {
        "externalId": { "type": "string" },
        "title": { "type": "string" },
        "documentRevision": { "type": "integer" },
        "rootRevision": { "type": "integer" },
        "folderId": { "type": "string" },
        "folderPath": { "type": "array", "items": { "type": "string" } },
        "entryId": { "type": "string" },
        "blockCount": { "type": "integer", "minimum": 0 },
        "inputMode": { "type": "string", "enum": ["fragment", "markdown"] },
        "markdownDiagnosticCount": { "type": "integer", "minimum": 0 }
      }
    })),
    "document_image_insert" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["externalId", "assetRef", "insertedBlockId", "revision"],
      "properties": {
        "externalId": { "type": "string" },
        "assetRef": { "type": "string" },
        "insertedBlockId": { "type": "string" },
        "revision": { "type": "integer" }
      }
    })),
    "document_asset_upload_prepare" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["workspaceId", "assetRef", "uploadUrl", "alreadyUploaded"],
      "properties": {
        "workspaceId": { "type": "string", "format": "uuid" },
        "assetRef": { "type": "string" },
        "uploadUrl": { "type": ["string", "null"] },
        "alreadyUploaded": { "type": "boolean" }
      }
    })),
    "document_reference_insert" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["sourceExternalId", "targetExternalId", "insertedBlockId", "revision"],
      "properties": {
        "sourceExternalId": { "type": "string" },
        "targetExternalId": { "type": "string" },
        "insertedBlockId": { "type": "string" },
        "revision": { "type": "integer" }
      }
    })),
    "update_doc" => Some(json!({
      "type": "object",
      "$defs": document_read_output_schema()["$defs"].clone(),
      "required": ["externalId", "operation", "sequence", "revision", "affectedBlockIds", "updatedBlocks", "readback", "insertedBlockIds", "removedBlockIds", "recoveryHistoryId"],
      "properties": {
        "externalId": { "type": "string" }, "operation": { "const": "replace_all" },
        "sequence": { "type": "integer" }, "revision": { "type": "integer" },
        "affectedBlockIds": { "type": "array", "items": { "type": "string" } },
        "updatedBlocks": { "type": "array", "items": { "$ref": "#/$defs/block" } },
        "readback": mutation_readback_schema(),
        "insertedBlockIds": { "type": "array", "items": { "type": "string" } },
        "removedBlockIds": { "type": "array", "items": { "type": "string" } },
        "recoveryHistoryId": { "type": ["integer", "null"] }
      }
    })),
    "doc_patch" => Some(json!({
      "type": "object",
      "$defs": document_read_output_schema()["$defs"].clone(),
      "oneOf": [
        {
          "type": "object",
          "required": ["externalId", "operation", "sequence", "revision", "affectedBlockIds", "updatedBlocks", "readback", "insertedBlockIds", "removedBlockIds"],
          "properties": {
            "externalId": { "type": "string" }, "operation": { "type": "string", "not": { "const": "update_title" } },
            "sequence": { "type": "integer" }, "revision": { "type": "integer" },
            "affectedBlockIds": { "type": "array", "items": { "type": "string" } },
            "updatedBlocks": { "type": "array", "items": { "$ref": "#/$defs/block" } },
            "readback": mutation_readback_schema(),
            "insertedBlockIds": { "type": "array", "items": { "type": "string" } },
            "removedBlockIds": { "type": "array", "items": { "type": "string" } }
          }
        },
        {
          "type": "object",
          "required": ["externalId", "operation", "revision", "affectedBlockIds", "leafSequence", "rootSequence", "updatedAt"],
          "properties": {
            "externalId": { "type": "string" }, "operation": { "const": "update_title" },
            "revision": { "type": "integer" }, "affectedBlockIds": { "type": "array", "items": { "type": "string" } },
            "leafSequence": { "type": "integer" }, "rootSequence": { "type": "integer" },
            "updatedAt": { "type": "string", "format": "date-time" }
          }
        }
      ]
    })),
    "delete_page" => Some(json!({
      "type": "object", "required": ["externalId", "deleted_at", "root_sequence"],
      "properties": {
        "externalId": { "type": "string" },
        "deleted_at": { "type": "string", "format": "date-time" }, "root_sequence": { "type": "integer" }
      }
    })),
    "restore_page" => Some(json!({
      "type": "object", "required": ["externalId", "restored_at", "root_sequence"],
      "properties": {
        "externalId": { "type": "string" },
        "restored_at": { "type": "string", "format": "date-time" }, "root_sequence": { "type": "integer" }
      }
    })),
    "page_projection_scan" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["workspaceId", "items", "nextCursor", "observedRootSequence", "completeness", "healthy"],
      "properties": {
        "workspaceId": { "type": "string", "format": "uuid" },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["sourceId", "externalDocId", "internalSourceId", "sqlPresent", "rootPresent", "leafPresent", "rootEntryCount", "identityConflict", "findings"],
            "properties": {
              "sourceId": { "type": "string" },
              "externalDocId": { "type": ["string", "null"] },
              "internalSourceId": { "type": ["string", "null"], "format": "uuid" },
              "sqlPresent": { "type": "boolean" },
              "rootPresent": { "type": "boolean" },
              "leafPresent": { "type": "boolean" },
              "rootEntryCount": { "type": "integer" },
              "identityConflict": { "type": "boolean" },
              "findings": { "$ref": "#/$defs/findings" }
            }
          }
        },
        "nextCursor": { "type": ["string", "null"] },
        "observedRootSequence": { "type": "integer" },
        "completeness": { "type": "string", "enum": ["complete", "incomplete"] },
        "healthy": { "type": "boolean" }
      },
      "$defs": {
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["externalDocId", "internalSourceId", "driftClass", "repairable", "reason"],
            "properties": {
              "externalDocId": { "type": ["string", "null"] },
              "internalSourceId": { "type": ["string", "null"], "format": "uuid" },
              "driftClass": { "type": "string", "enum": ["missing_root_entry", "missing_sql_metadata", "missing_leaf", "title_mismatch", "trash_mismatch", "orphan"] },
              "repairable": { "type": "boolean" },
              "reason": { "type": "string" }
            }
          }
        }
      }
    })),
    "page_projection_inspect" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["workspaceId", "externalDocId", "sqlPresent", "rootPresent", "leafPresent", "normalizedTitle", "isTrashed", "findings", "fingerprint"],
      "properties": {
        "workspaceId": { "type": "string", "format": "uuid" },
        "externalDocId": { "type": "string" },
        "sqlPresent": { "type": "boolean" },
        "rootPresent": { "type": "boolean" },
        "leafPresent": { "type": "boolean" },
        "normalizedTitle": { "type": ["string", "null"] },
        "isTrashed": { "type": ["boolean", "null"] },
        "findings": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["externalDocId", "internalSourceId", "driftClass", "repairable", "reason"],
            "properties": {
              "externalDocId": { "type": ["string", "null"] },
              "internalSourceId": { "type": ["string", "null"], "format": "uuid" },
              "driftClass": { "type": "string", "enum": ["missing_root_entry", "missing_sql_metadata", "missing_leaf", "title_mismatch", "trash_mismatch", "orphan"] },
              "repairable": { "type": "boolean" }, "reason": { "type": "string" }
            }
          }
        },
        "fingerprint": { "type": "string" }
      }
    })),
    "page_projection_repair" => Some(json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["externalDocId", "fingerprint", "mode", "changed", "findings", "commit"],
      "properties": {
        "externalDocId": { "type": "string" },
        "fingerprint": { "type": "string" },
        "mode": { "type": "string", "enum": ["dry_run", "apply"] },
        "changed": { "type": "boolean" },
        "findings": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["externalDocId", "internalSourceId", "driftClass", "repairable", "reason"],
            "properties": {
              "externalDocId": { "type": ["string", "null"] },
              "internalSourceId": { "type": ["string", "null"], "format": "uuid" },
              "driftClass": { "type": "string", "enum": ["missing_root_entry", "missing_sql_metadata", "missing_leaf", "title_mismatch", "trash_mismatch", "orphan"] },
              "repairable": { "type": "boolean" }, "reason": { "type": "string" }
            }
          }
        },
        "commit": {
          "oneOf": [
            { "type": "null" },
            {
              "type": "object", "additionalProperties": false,
              "required": ["changed", "leafSequence"],
              "properties": {
                "changed": { "type": "boolean" },
                "leafSequence": { "type": ["integer", "null"] }
              }
            }
          ]
        }
      }
    })),
    _ => None,
  }
}

fn workspace_tag_compact_output_schema() -> Value {
  json!({
    "type": "object",
    "additionalProperties": false,
    "required": ["id", "name", "colorRole", "archived"],
    "properties": {
      "id": { "type": "string", "format": "uuid" },
      "name": { "type": "string" },
      "colorRole": workspace_tag_color_role_output_schema(),
      "archived": { "type": "boolean" }
    }
  })
}

fn document_template_summary_output_schema() -> Value {
  json!({
    "type": "object",
    "additionalProperties": false,
    "required": ["externalId", "title", "isTemplate", "requiredVariables"],
    "properties": {
      "externalId": { "type": "string" },
      "title": { "type": "string" },
      "isTemplate": { "type": "boolean", "const": true },
      "requiredVariables": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
    }
  })
}

fn workspace_tag_color_role_output_schema() -> Value {
  json!({
    "type": "string",
    "enum": [
      "tag.red", "tag.magenta", "tag.orange", "tag.yellow", "tag.green",
      "tag.teal", "tag.blue", "tag.purple", "tag.grey"
    ]
  })
}

// Keep this native command schema outside the catalog's large macro expansion.
fn document_patch_tool_definition() -> Value {
  json!({
    "name": "doc_patch",
    "description": "Patches native content/title without a document export/import roundtrip. Read the target/section first and pass expected_revision plus an idempotency key; use strict_loss=true for deprecated Markdown input. Native citations, local footnotes and callouts remain native, and unrelated imported properties are retained. On conflict reread; after a lost response retry identical arguments with the same key. Each call commits independently. Requires write:docs and current document Update.",
    "inputSchema": {
      "type": "object",
      "required": ["workspace_id", "external_id", "operation", "idempotency_key"],
      "properties": {
        "workspace_id": { "type": "string", "format": "uuid" },
        "external_id": { "type": "string" },
        "operation": {
          "type": "string",
          "enum": DOCUMENT_PATCH_OPERATIONS
        },
        "title": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "expected_revision": { "type": "integer", "minimum": 0, "description": "Optional current document revision from read_doc; stale writes fail with a conflict." },
        "fragment": { "$ref": "#/$defs/documentFragment" },
        "content_markdown": {
          "type": "string",
          "maxLength": 1048576,
          "description": "Deprecated input boundary normalized into DocumentFragment before mutation."
        },
        "block_id": {
          "type": "string",
          "minLength": 1,
          "description": "Stable target block ID for insert_after_block and replace_block."
        },
        "after_block_id": { "type": "string", "minLength": 1 },
        "parent_block_id": { "type": "string", "minLength": 1 },
        "source_block_id": {"type":"string", "minLength":1},
        "position": {"type":"integer", "minimum":0, "maximum":u32::MAX},
        "block_kind": {"enum":["paragraph","quote","heading1","heading2","heading3","heading4","heading5","heading6","bulleted","numbered","todo"], "description":"Same-flavour conversion retains ID; paragraph/list conversion returns a fresh inserted ID and retires the old ID."},
        "start": { "type": "integer", "minimum": 0, "maximum": u32::MAX },
        "end": { "type": "integer", "minimum": 0, "maximum": u32::MAX },
        "replacement": { "type": "string", "maxLength": 1048576 },
        "replacement_spans": document_text_spans_schema(),
        "annotation_id": {"type":"string","minLength":1,"maxLength":4096,"description":"Existing native inline annotation identity on the selected block/cell. Supply start from the first run of its contiguous body (with the usual range_unit); edit_annotation replaces the full literal body, preserving identity. Empty replacement removes it."},
        "text_field": {"enum":["text","title"],"description":"Target text field."},
        "range_unit": { "type": "string", "enum": ["utf8_bytes", "utf16_code_units", "unicode_scalars"], "description": "Text positions use UTF-8 bytes when omitted. Explicit UTF-16 code units or Unicode scalars are converted to native offsets; encoding boundaries are required, not grapheme boundaries." },
        "expected_text": { "type": "string", "maxLength": 1048576, "description": "Optional exact original selected text, or the complete contiguous literal body for edit_annotation. Compared under the content lock before editing; no Unicode normalization is applied." },
        "formatting": { "$ref": "#/$defs/documentTextFormatting" },
        "after_row_id": { "type": "string", "minLength": 1 },
        "after_column_id": { "type": "string", "minLength": 1 },
        "row_id": { "type": "string", "minLength": 1 },
        "column_id": { "type": "string", "minLength": 1 },
        "properties": {"anyOf":[{"$ref":"#/$defs/documentBlockProperties"},table_coordinate_properties_schema(false)]},
        "heading": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512,
          "description": "Heading text or markdown heading marker used by heading operations."
        },
        "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 160 }
      },
      "$defs": {
        "documentFragment": {
          "type": "object",
          "required": ["blocks"],
          "properties": {
            "blocks": { "type": "array", "minItems": 1, "items": { "type": "object", "required": ["type"] } }
          }
        },
        "documentTextFormatting": document_text_formatting_schema(),
        "documentBlockProperties": document_block_properties_schema()
      }
    }
  })
}

// Keep the operation slice outside the large schema macro so its expansion
// depth stays bounded. patch_operation_fields validates every published name.
const DOCUMENT_PATCH_OPERATIONS: &[&str] = &[
  "append_blocks",
  "prepend_blocks",
  "insert_after_block",
  "replace_block",
  "replace_heading_section",
  "append_to_heading",
  "append",
  "prepend",
  "update_title",
  "delete_block",
  "move_block",
  "convert_block",
  "duplicate_block",
  "split_block",
  "join_blocks",
  "edit_text",
  "edit_annotation",
  "format_text",
  "edit_table_cell",
  "insert_table_row",
  "delete_table_row",
  "move_table_row",
  "duplicate_table_row",
  "clear_table_row",
  "insert_table_column",
  "delete_table_column",
  "move_table_column",
  "duplicate_table_column",
  "clear_table_column",
  "update_table_row_properties",
  "update_table_column_properties",
  "update_block_properties",
  "update_citation",
];

/// Required fields, optional destinations and fragment admission. The wire
/// schema and execution share this table so non-fragment edits stay callable.
pub(crate) fn patch_operation_fields(
  operation: &str,
) -> Option<(&'static [&'static str], &'static [&'static str], bool)> {
  Some(match operation {
    "append" | "append_blocks" | "prepend" | "prepend_blocks" => (&[], &[], true),
    "insert_after_block" | "replace_block" => (&["block_id"], &[], true),
    "replace_heading_section" | "append_to_heading" => (&["heading"], &[], true),
    "delete_block" => (&["block_id"], &[], false),
    "move_block" => (&["block_id"], &["after_block_id", "parent_block_id"], false),
    "edit_annotation" => (
      &["block_id", "annotation_id", "start", "replacement"],
      &["range_unit", "expected_text", "row_id", "column_id"],
      false,
    ),
    "edit_text" => (
      &["block_id", "start", "end"],
      &[
        "replacement",
        "replacement_spans",
        "text_field",
        "range_unit",
        "expected_text",
      ],
      false,
    ),
    "insert_table_row" => (&["block_id"], &["after_row_id"], false),
    "delete_table_row" => (&["block_id", "row_id"], &[], false),
    "move_table_row" => (&["block_id", "row_id"], &["after_row_id"], false),
    "duplicate_table_row" => (&["block_id", "row_id"], &[], false),
    "clear_table_row" => (&["block_id", "row_id"], &[], false),
    "insert_table_column" => (&["block_id"], &["after_column_id"], false),
    "delete_table_column" => (&["block_id", "column_id"], &[], false),
    "move_table_column" => (&["block_id", "column_id"], &["after_column_id"], false),
    "duplicate_table_column" => (&["block_id", "column_id"], &[], false),
    "clear_table_column" => (&["block_id", "column_id"], &[], false),
    "edit_table_cell" => (
      &["block_id", "row_id", "column_id", "start", "end"],
      &["replacement", "replacement_spans", "range_unit", "expected_text"],
      false,
    ),
    "format_text" => (
      &["block_id", "start", "end", "formatting"],
      &["row_id", "column_id", "range_unit", "expected_text"],
      false,
    ),
    "duplicate_block" => (&["block_id"], &[], false),
    "split_block" => (&["block_id", "position"], &["range_unit"], false),
    "join_blocks" => (&["block_id", "source_block_id"], &[], false),
    "convert_block" => (&["block_id", "block_kind"], &[], false),
    "update_block_properties" => (&["block_id", "properties"], &[], false),
    "update_citation" => (&["label"], &["new_label", "reference"], false),
    "update_table_row_properties" => (&["block_id", "row_id", "properties"], &[], false),
    "update_table_column_properties" => (&["block_id", "column_id", "properties"], &[], false),
    "update_title" => (&["title"], &[], false),
    _ => return None,
  })
}

fn bind_patch_operation_schema(schema: &mut Value) {
  let operations = schema["properties"]["operation"]["enum"]
    .as_array()
    .expect("patch operations");
  let fields = [
    "title",
    "fragment",
    "content_markdown",
    "block_id",
    "after_block_id",
    "parent_block_id",
    "block_kind",
    "position",
    "source_block_id",
    "after_row_id",
    "after_column_id",
    "start",
    "end",
    "replacement",
    "replacement_spans",
    "annotation_id",
    "text_field",
    "formatting",
    "row_id",
    "column_id",
    "range_unit",
    "expected_text",
    "properties",
    "heading",
    "strict_loss",
    "label",
    "new_label",
    "reference",
  ];
  let variants: Vec<_> = operations
    .iter()
    .map(|operation| {
      let (required, optional, fragment) =
        patch_operation_fields(operation.as_str().expect("operation name")).expect("operation contract");
      let forbidden: Vec<_> = fields
        .iter()
        .filter(|key| {
          !required.contains(key)
            && !optional.contains(key)
            && !(fragment && ["fragment", "content_markdown", "strict_loss"].contains(key))
        })
        .map(|key| json!({"required": [key]}))
        .collect();
      let mut variant =
        json!({"properties": {"operation": {"const": operation}}, "required": required, "not": {"anyOf": forbidden}});
      if matches!(operation.as_str(), Some("edit_text" | "edit_table_cell")) {
        variant["oneOf"] = json!([{"required":["replacement"]},{"required":["replacement_spans"]}]);
      }
      if operation == "edit_text" {
        variant["allOf"] = json!([{"if":{"properties":{"text_field":{"const":"title"}},"required":["text_field"]},"then":{"required":["replacement"],"properties":{"replacement":{"not":{"pattern":"[\\r\\n]"}}},"not":{"required":["replacement_spans"]}}}]);
      }
      if operation == "update_block_properties" { variant["properties"]["properties"] = document_block_properties_schema(); }
      if operation == "update_citation" {
        // At least one of new_label/reference is required; both may be supplied
        // for a simultaneous rename and source change.
        variant["anyOf"] = json!([{"required":["new_label"]},{"required":["reference"]}]);
      }
      if operation == "update_table_row_properties" { variant["properties"]["properties"] = table_coordinate_properties_schema(true); }
      if operation == "update_table_column_properties" { variant["properties"]["properties"] = table_coordinate_properties_schema(false); }
      if matches!(operation.as_str(), Some("format_text" | "edit_annotation")) {
        variant["oneOf"] = json!([
          {"not":{"anyOf":[{"required":["row_id"]},{"required":["column_id"]}]}},
          {"required":["row_id","column_id"]}
        ]);
      }
      if fragment {
        variant["oneOf"] = json!([{"required": ["fragment"]}, {"required": ["content_markdown"]}]);
      }
      variant
    })
    .collect();
  // The citation fields are admitted at the top level so `additionalProperties:
  // false` does not reject valid `update_citation` calls; every other operation
  // forbids them through its variant's `not` clause.
  schema["properties"]["label"] = json!({"type":"string","minLength":1,"maxLength":512,"description":"Existing citation source label (normalized comparison)."});
  schema["properties"]["new_label"] = json!({"type":"string","minLength":1,"maxLength":512,"description":"Replacement source label; omit to keep the current label."});
  schema["properties"]["reference"] = citation_reference_schema();
  schema["oneOf"] = json!(variants);
  schema["additionalProperties"] = json!(false);
}

fn document_version_restore_tool_definition() -> Value {
  json!({
    "name": "doc_version_restore",
    "description": "Restores one exact named content snapshot through the atomic history owner. Read the current revision first; confirm_restore=true, expected_revision and an idempotency key are required. Preserves pre-restore recovery and current native workflow/type/deadline fields; recovery does not claim historical metadata or source verification. Current write:docs and document Update also gate identical committed replay.",
    "inputSchema": {
      "type":"object","additionalProperties":false,
      "required":["workspace_id","external_id","version_id","confirm_restore","expected_revision","idempotency_key"],
      "properties": {
        "workspace_id":{"type":"string","format":"uuid"},"external_id":{"type":"string","minLength":1},
        "version_id":{"type":"string","format":"uuid"},"confirm_restore":{"const":true},
        "expected_revision":{"type":"integer","minimum":0},"idempotency_key":{"type":"string","minLength":1,"maxLength":160}
      }
    }
  })
}

fn document_version_read_tool_definition() -> Value {
  json!({
    "name": "doc_version_read",
    "description": "Reads one immutable named content version with bounded structured pagination. Current workspace membership, document Read and read:docs apply on every page. No nearest-time/live fallback; current native metadata is not historical metadata captured with this content.",
    "inputSchema": {
      "type": "object", "required": ["workspace_id", "external_id", "version_id"], "additionalProperties": false,
      "properties": {
        "workspace_id": {"type": "string", "format": "uuid"},
        "external_id": {"type": "string", "minLength": 1},
        "version_id": {"type": "string", "format": "uuid"},
        "cursor": {"type": "string", "description": "Opaque nextCursor from this exact version and reader."},
        "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}
      }
    }
  })
}

fn document_version_read_output_schema() -> Value {
  let read = document_read_output_schema();
  let mut schema = read["oneOf"][0].clone();
  schema["$defs"] = read["$defs"].clone();
  let required = schema["required"].as_array_mut().expect("structured fields");
  required.retain(|field| field != "revision");
  required.extend([json!("versionId"), json!("docHistoryId")]);
  let properties = schema["properties"].as_object_mut().expect("structured properties");
  properties.remove("revision");
  properties.remove("selection");
  properties.insert("versionId".into(), json!({"type": "string", "format": "uuid"}));
  properties.insert("docHistoryId".into(), json!({"type": "integer", "minimum": 1}));
  properties.get_mut("projection").expect("projection schema")["properties"]["source"] =
    json!({"const": "named_version_snapshot"});
  schema
}

fn native_text_output_schema() -> Value {
  let mut span_properties = serde_json::Map::new();
  for name in ["bold", "italic", "strike", "code", "underline", "protected"] {
    span_properties.insert(name.into(), json!({"type":"boolean"}));
  }
  for name in ["color", "background", "labelTone", "link", "text"] {
    span_properties.insert(name.into(), json!({"type":["string","null"]}));
  }
  for name in ["start", "end"] {
    span_properties.insert(name.into(), json!({"type":"integer","minimum":0,"maximum":u32::MAX}));
  }
  span_properties.insert("mention".into(), json!({"type":"object","required":["member"],"additionalProperties":false,"properties":{"member":{"type":"string","minLength":1}}}));
  span_properties.insert("annotationId".into(), json!({"type":"string","minLength":1}));
  span_properties.insert("reference".into(), json!({"type":"object","required":["pageId"],"additionalProperties":false,"properties":{"pageId":{"type":"string"},"title":{"type":"string"}}}));
  span_properties.insert("latex".into(), json!({"type":"string"}));
  span_properties.insert(
    "footnote".into(),
    json!({"type":"object","required":["label"],"additionalProperties":false,"properties":{
      "label":{"type":"string"},
      "definitionId":{"type":"string"},
      "reference":{"type":"object"}
    }}),
  );
  let mut native_properties = serde_json::Map::new();
  for name in [
    "type",
    "textAlign",
    "presentation",
    "backgroundColorName",
    "appearance",
    "language",
    "caption",
    "latex",
  ] {
    native_properties.insert(name.into(), json!({"type":["string","null"]}));
  }
  for name in [
    "collapsed",
    "checked",
    "foldable",
    "defaultOpen",
    "wrap",
    "preview",
    "lineNumber",
  ] {
    native_properties.insert(name.into(), json!({"type":["boolean","null"]}));
  }
  native_properties.insert("headerRows".into(), json!({"type":"integer","minimum":0}));
  native_properties.insert("density".into(), json!({"type":"string"}));
  for name in ["rows", "columns"] {
    native_properties.insert(name.into(), json!({"type":"object","additionalProperties":{"type":"object","additionalProperties":false,"properties":{
      "rowId":{"type":"string"},"columnId":{"type":"string"},"order":{"type":"string"},"backgroundColor":{"type":"string"},"textAlign":{"type":"string"},"width":{"type":"number"},
      "repeat":{"type":"object","additionalProperties":false,"properties":{"source":{"type":"string"},"alias":{"type":"string"}}}
    }}}));
  }
  native_properties.insert("order".into(), json!({"type":["number","null"]}));
  native_properties.insert("label".into(), json!({"type":["string","null"]}));
  native_properties.insert("placement".into(), json!({"type":["string","null"]}));
  native_properties.insert("citation".into(), json!({"type":"object","required":["label"],"additionalProperties":false,"properties":{"label":{"type":"string"},"reference":{"type":"object"}}}));
  native_properties.insert("icon".into(),json!({"type":"object","additionalProperties":false,"properties":{"type":{"type":"string"},"unicode":{"type":"string"},"name":{"type":"string"},"color":{"type":"string"}}}));
  json!({"type":"object", "additionalProperties":false, "required":["kind","fields"], "properties":{
    "kind":{"type":"string", "enum":["myoxus:paragraph","myoxus:list","myoxus:callout","myoxus:code","myoxus:table","myoxus:latex","myoxus:mermaid","myoxus:annotation","myoxus:page","myoxus:note","myoxus:footnote-definition","myoxus:bookmark","myoxus:embed-linked-doc","myoxus:attachment"]},
    "properties":{"type":"object", "additionalProperties":false,"properties":native_properties},
    "fields":{"type":"array", "items":{"type":"object", "additionalProperties":false, "required":["field","rangeUnit","length","spans"],"properties":{
      "field":{"enum":["text","title","source"]}, "rowId":{"type":"string"}, "columnId":{"type":"string"},
      "rangeUnit":{"const":"utf8_bytes"}, "length":{"type":"integer","minimum":0,"maximum":u32::MAX},
      "spans":{"type":"array","items":{"type":"object", "additionalProperties":false,
        "required":["start","end","text","bold","italic","strike","code","underline","link","color","background","labelTone","protected"],
        "properties":span_properties}}
    }}}
  }})
}

fn document_read_output_schema() -> Value {
  let inline_text = json!({
    "type": "object",
    "required": ["text", "bold", "italic", "strike", "code", "link"],
    "additionalProperties": false,
    "properties": {
      "text": { "type": "string" },
      "bold": { "type": "boolean" },
      "italic": { "type": "boolean" },
      "strike": { "type": "boolean" },
      "code": { "type": "boolean" },
      "link": { "type": ["string", "null"] },
      "local_footnote": {
        "type": "object", "required": ["definition_id", "label", "reference_id", "resolved", "placement", "number"], "additionalProperties": false,
        "properties": {
          "definition_id": { "type": "string" }, "label": { "type": "string" }, "reference_id": { "type": "string" },
          "resolved": { "type": "boolean" }, "placement": { "enum": ["footnote", "endnote", null] },
          "number": { "type": ["integer", "null"], "minimum": 1 }
        }
      }
    }
  });
  let block_id = json!({ "type": "string", "minLength": 1 });
  let text_block = |kind: &str| {
    json!({
      "type": "object",
      "required": ["kind", "blockId", "text"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": kind },
        "blockId": block_id.clone(),
        "text": { "type": "array", "items": inline_text.clone() }
      }
    })
  };
  let mut block = json!({
    "oneOf": [
      text_block("paragraph"),
      {
        "type": "object", "required": ["kind", "blockId", "level", "text"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "heading" }, "blockId": block_id.clone(),
          "level": { "type": "integer", "minimum": 1, "maximum": 6 },
          "text": { "type": "array", "items": inline_text.clone() }
        }
      },
      {
        "type": "object", "required": ["kind", "blockId", "list"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "list" }, "blockId": block_id.clone(),
          "list": {
            "type": "object", "required": ["kind", "items"], "additionalProperties": false,
            "properties": {
              "kind": { "type": "string", "enum": ["bulleted", "numbered", "todo"] },
              "items": { "type": "array", "items": {
                "type": "object", "required": ["blockId", "text", "todoChecked", "children"], "additionalProperties": false,
                "properties": {
                  "blockId": block_id.clone(),
                  "text": { "type": "array", "items": inline_text.clone() },
                  "todoChecked": { "type": ["boolean", "null"] },
                  "children": { "type": "array", "items": { "$ref": "#/$defs/block" } }
                }
              }}
            }
          }
        }
      },
      text_block("quote"),
      {
        "type": "object", "required": ["kind", "blockId", "text", "appearance", "children"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "callout" }, "blockId": block_id.clone(),
          "text": { "type": "array", "items": inline_text.clone() },
          "appearance": { "enum": ["soft", "accent", "outline"] },
          "title": { "type": "string" },
          "children": { "type": "array", "items": { "$ref": "#/$defs/block" } }
        }
      },
      {
        "type": "object", "required": ["kind", "blockId", "label", "placement", "number", "referenceOrder", "children", "backlinks"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "footnote_definition" }, "blockId": block_id.clone(), "label": { "type": "string" },
          "placement": { "enum": ["footnote", "endnote", null] }, "number": { "type": ["integer", "null"], "minimum": 1 },
          "referenceOrder": { "type": ["integer", "null"], "minimum": 0 },
          "children": { "type": "array", "items": { "$ref": "#/$defs/block" } },
          "backlinks": { "type": "array", "items": { "type": "string" } }
        }
      },
      {
        "type": "object", "required": ["kind", "blockId", "language", "text"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "code" }, "blockId": block_id.clone(),
          "language": { "type": ["string", "null"] }, "text": { "type": "string" }
        }
      },
      {
        "type": "object", "required": ["kind", "blockId", "source", "title", "caption"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "mermaid" }, "blockId": block_id.clone(), "source": { "type": "string" },
          "title": { "type": "string" }, "caption": { "type": "string" }
        }
      },
      {
        "type": "object", "required": ["kind", "blockId"], "additionalProperties": false,
        "properties": { "kind": { "const": "divider" }, "blockId": block_id.clone() }
      },
      {
        "type": "object", "required": ["kind", "blockId", "asset"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "image" }, "blockId": block_id.clone(), "asset": { "$ref": "#/$defs/assetRef" }
        }
      },
      {
        "type": "object", "required": ["kind", "blockId", "url", "title"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "bookmark_card" }, "blockId": block_id.clone(),
          "url": { "type": "string" }, "title": { "type": "string" }
        }
      },
      {
        "type": "object", "required": ["kind", "blockId", "rows"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "table" }, "blockId": block_id.clone(),
          "headerRows": { "type": "integer", "minimum": 0 },
          "appearance": { "enum": ["grid", "ruled", "plain"] },
          "density": { "enum": ["normal", "compact"] },
          "rows": { "type": "array", "items": { "type": "array", "items": {
            "type": "array", "items": inline_text.clone()
          }}}
        }
      },
      {
        "type": "object", "required": ["kind", "blockId"], "additionalProperties": false,
        "properties": { "kind": { "const": "table_placeholder" }, "blockId": block_id.clone() }
      },
      {
        "type": "object", "required": ["kind", "blockId", "flavour"], "additionalProperties": false,
        "properties": {
          "kind": { "const": "unsupported_block" }, "blockId": block_id, "flavour": { "type": "string" }
        }
      }
    ]
  });
  for variant in block["oneOf"].as_array_mut().expect("block variants") {
    variant["properties"]
      .as_object_mut()
      .expect("block properties")
      .insert("native".into(), json!({"$ref":"#/$defs/nativeText"}));
  }
  block["oneOf"][2]["properties"]["list"]["properties"]["items"]["items"]["properties"]
    .as_object_mut()
    .expect("list item properties")
    .insert("native".into(), json!({"$ref":"#/$defs/nativeText"}));
  json!({
    "type": "object",
    "oneOf": [
      {
        "type": "object",
        "required": ["schemaVersion", "revision", "document", "projection", "page"],
        "additionalProperties": false,
        "properties": {
          "schemaVersion": { "const": "myoxus.document-projection.v1" },
          "revision": { "type": "integer", "minimum": 0 },
          "document": {
            "type": "object",
            "required": ["workspaceId", "externalId", "title", "metadataBadges", "blocks", "assets"],
            "additionalProperties": false,
            "properties": {
              "workspaceId": { "type": "string", "format": "uuid" },
              "externalId": { "type": "string" },
              "title": { "type": "string" },
              "metadataBadges": { "type": "array", "items": { "$ref": "#/$defs/documentBadge" } },
              "blocks": { "type": "array", "items": { "$ref": "#/$defs/block" } },
              "tableIdentities": { "type": "object", "additionalProperties": {
                "type": "object", "required": ["rowIds", "columnIds"], "additionalProperties": false,
                "properties": {
                  "rowIds": {"type": "array", "minItems": 0, "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
                  "columnIds": {"type": "array", "minItems": 0, "uniqueItems": true, "items": {"type": "string", "minLength": 1}}
                }
              }},
              "assets": { "type": "array", "items": { "$ref": "#/$defs/documentAsset" } }
            }
          },
          "selection": {
            "type": "object", "required": ["selector", "complete", "totalBlocks", "identities"], "additionalProperties": false,
            "properties": {
              "selector": { "oneOf": [
                { "type": "object", "required": ["kind", "blockId"], "additionalProperties": false, "properties": { "kind": { "enum": ["block", "section"] }, "blockId": { "type": "string", "minLength": 1 } } },
                { "type": "object", "required": ["kind"], "additionalProperties": false, "properties": { "kind": { "const": "outline" } } }
              ] },
              "complete": { "type": "boolean" }, "totalBlocks": { "type": "integer", "minimum": 0 },
              "identities": { "type": "array", "maxItems": 200, "items": {
                "type": "object", "required": ["blockId", "parentIds", "parentCount", "parentsComplete", "childIds", "childCount", "childrenComplete", "context"], "additionalProperties": false,
                "properties": {
                  "blockId": { "type": "string" },
                  "parentIds": { "type": "array", "maxItems": 200, "items": { "type": "string" } },
                  "parentCount": { "type": "integer", "minimum": 0 }, "parentsComplete": { "type": "boolean" },
                  "childIds": { "type": "array", "maxItems": 200, "items": { "type": "string" } },
                  "childCount": { "type": "integer", "minimum": 0 }, "childrenComplete": { "type": "boolean" },
                  "context": { "type": "boolean" }
                }
              } }
            }
          },
          "projection": {
            "type": "object", "required": ["source", "complete", "diagnostics"], "additionalProperties": false,
            "properties": {
              "source": { "const": "yjs" }, "complete": { "type": "boolean" },
              "diagnostics": { "type": "array", "items": { "$ref": "#/$defs/diagnostic" } }
            }
          },
          "page": {
            "type": "object", "required": ["nextCursor"], "additionalProperties": false,
            "properties": { "nextCursor": { "type": ["string", "null"] } }
          }
        }
      },
      {
        "type": "object",
        "required": ["schemaVersion", "revision", "format", "mediaType", "data", "lossy", "complete", "diagnostics"],
        "additionalProperties": false,
        "properties": {
          "schemaVersion": { "const": "myoxus.document-projection.v1" },
          "format": { "type": "string", "enum": ["html", "markdown", "plain_text", "raw_yjs"] },
          "revision": { "type": "integer", "minimum": 0 },
          "mediaType": { "type": "string" },
          "okf": { "type": "object", "required": ["frontmatter", "retained_frontmatter", "retrieval_reference", "metadata_revision", "metadata_projection_version", "tags", "diagnostics"], "additionalProperties": false,
            "properties": {
              "frontmatter": { "type": "object" }, "retained_frontmatter": { "type": "object" },
              "retrieval_reference": { "type": "string" }, "metadata_revision": { "type": "integer" },
              "metadata_projection_version": { "type": "string" },
              "tags": { "type": "array", "items": { "type": "object", "required": ["id", "label"], "additionalProperties": false, "properties": { "id": { "type": "string", "format": "uuid" }, "label": { "type": "string" } } } },
              "diagnostics": { "type": "array", "maxItems": 32, "items": { "type": "string" } }
            }
          },
          "rendererVersion": { "type": ["string", "null"] },
          "data": { "type": "string" }, "lossy": { "type": "boolean" }, "complete": { "type": "boolean" },
          "diagnostics": { "type": "array", "items": { "$ref": "#/$defs/diagnostic" } },
          "assets": { "type": "array", "items": { "$ref": "#/$defs/privateAsset" } }
        }
      }
    ],
    "$defs": {
      "block": block,
      "nativeText": native_text_output_schema(),
      "assetRef": {
        "type": "object", "required": ["source", "alt", "publicUrl"], "additionalProperties": false,
        "properties": {
          "source": { "type": "string" }, "alt": { "type": "string" },
          "publicUrl": { "type": ["string", "null"] }
        }
      },
      "documentAsset": {
        "type": "object", "required": ["source", "alt", "blobRead"], "additionalProperties": false,
        "properties": {
          "source": { "type": "string" }, "alt": { "type": "string" },
          "blobRead": { "$ref": "#/$defs/blobRead" }
        }
      },
      "blobRead": {
        "type": "object", "required": ["tool", "arguments"], "additionalProperties": false,
        "properties": {
          "tool": { "const": "blob_read" },
          "arguments": {
            "type": "object", "required": ["workspace_id", "key"], "additionalProperties": false,
            "properties": {
              "workspace_id": { "type": "string", "format": "uuid" }, "key": { "type": "string" }
            }
          }
        }
      },
      "documentBadge": {
        "type": "object", "required": ["key", "label", "value"], "additionalProperties": false,
        "properties": { "key": { "type": "string" }, "label": { "type": "string" }, "value": { "type": "string" } }
      },
      "diagnostic": {
        "type": "object", "required": ["code", "message"], "additionalProperties": false,
        "properties": {
          "code": { "type": "string" }, "message": { "type": "string" }, "blockId": { "type": "string" }
        }
      },
      "privateAsset": {
        "oneOf": [
          {
            "type": "object", "required": ["kind", "path", "mediaType", "size", "blobRead"], "additionalProperties": false,
            "properties": {
              "kind": { "const": "blob" }, "path": { "type": "string" }, "mediaType": { "type": "string" },
              "size": { "type": "integer", "minimum": 0 },
              "blobRead": { "$ref": "#/$defs/blobRead" }
            }
          },
          {
            "type": "object", "required": ["kind", "url"], "additionalProperties": false,
            "properties": { "kind": { "const": "external" }, "url": { "type": "string" } }
          }
        ]
      }
    }
  })
}

fn build_registry() -> Vec<ToolDescriptor> {
  let mut handlers = crate::tools::handler_bindings();
  let mut raw = raw_tool_definitions();
  let tools = raw
    .get_mut("tools")
    .and_then(Value::as_array_mut)
    .expect("MCP raw tool definitions must contain a tools array");
  let registry = tools
    .drain(..)
    .map(|tool| {
      let mut object = tool
        .as_object()
        .cloned()
        .expect("MCP raw tool definition must be an object");
      let name = object
        .remove("name")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .expect("MCP tool definition requires a name");
      let policy = policy(&name).unwrap_or_else(|| panic!("MCP tool {name} has no registry policy"));
      let handler = handlers.remove(name.as_str()).unwrap_or_else(|| panic!("MCP tool {name} has no handler binding"));
      let optional_idempotency = OPTIONAL_IDEMPOTENCY_TOOLS.contains(&name.as_str());
      let mut input_schema = object
        .remove("inputSchema")
        .expect("MCP tool definition requires an inputSchema");
      if matches!(name.as_str(), "create_page" | "document_import" | "update_doc" | "doc_patch") {
        input_schema["properties"]["strict_loss"] = json!({
          "type": "boolean", "default": false,
          "description": "Reject any Markdown/parser or native-fragment normalization finding before writing. Default acceptance reports bounded warnings. Applies only to fragment/content_markdown operations."
        });
      }
      if name == "doc_patch" {
        bind_patch_operation_schema(&mut input_schema);
      }
      if optional_idempotency {
        input_schema["properties"]["idempotency_key"] = json!({
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "description": "Optional durable retry key. Reuse only with the semantically identical payload."
        });
      }
      if matches!(
        name.as_str(),
        "create_page" | "document_import" | "document_template_create" | "update_doc" | "doc_patch"
      ) {
        let min_items = usize::from(name == "doc_patch");
        input_schema["$defs"]["documentFragment"] = document_fragment_schema(min_items, true, name != "document_import");
      }
      let mut output_schema = document_output_schema(&name)
        .unwrap_or_else(|| panic!("Missing output contract for registered tool {name}"));
      if matches!(name.as_str(), "create_page" | "document_import" | "update_doc" | "doc_patch") {
        output_schema["properties"]["normalizationDiagnostics"] = json!({
          "type": "array", "maxItems": 100,
          "items": { "type": "object", "additionalProperties": false,
            "required": ["code", "sourcePath", "sourceKind"],
            "properties": { "code": {"type": "string"}, "sourcePath": {"type": "string"}, "sourceKind": {"type": "string"} }
          }
        });
        output_schema["properties"]["normalizationDiagnosticCount"] = json!({"type": "integer", "minimum": 0});
        output_schema["properties"]["normalizationDiagnosticsTruncated"] = json!({"type": "boolean"});
      }
      ToolDescriptor {
        handler,
        title: title(&name),
        name,
        description: {
          let description = object
            .remove("description")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .expect("MCP tool definition requires a description");
          if optional_idempotency {
            format!("{description} Accepts optional `idempotency_key` for durable replay protection.")
          } else {
            description
          }
        },
        input_schema,
        output_schema,
        required_scope: policy.scope,
        required_services: policy.services,
        target_type: policy.target,
        audit_event: policy.audit_event,
        access: policy.access,
        // All hints are explicit policy, never inferred from the tool name.
        annotations: ToolAnnotations::new()
          .read_only(policy.access == ToolAccess::Read)
          .destructive(policy.destructive)
          .idempotent(policy.idempotent)
          .open_world(false),
      }
    })
    .collect();
  assert!(
    handlers.is_empty(),
    "MCP handler bindings must have registry descriptors"
  );
  registry
}

static TOOL_REGISTRY: LazyLock<Vec<ToolDescriptor>> = LazyLock::new(build_registry);

pub fn tools() -> &'static [ToolDescriptor] {
  &TOOL_REGISTRY
}

pub fn find_tool(name: &str) -> Option<&'static ToolDescriptor> {
  tools().iter().find(|tool| tool.name == name)
}

/// Produce one scope- and service-filtered page for `tools/list`.
pub fn list_tools(
  params: &Value,
  auth: &McpAuthContext,
  availability: ToolAvailability,
) -> Result<ListToolsResult, McpToolError> {
  if !params.is_object() {
    return Err(McpToolError::protocol(
      -32602,
      "tools/list parameters must be an object",
    ));
  }
  let start = match params.get("cursor") {
    Some(Value::String(cursor)) => decode_cursor(cursor)?,
    Some(Value::Null) | None => 0,
    Some(_) => return Err(McpToolError::protocol(-32602, "tools/list cursor must be a string")),
  };
  let visible = tools()
    .iter()
    .filter(|tool| tool.visible_to(auth, availability))
    .collect::<Vec<_>>();
  if start > visible.len() {
    return Err(McpToolError::protocol(
      -32602,
      "tools/list cursor is outside the result set",
    ));
  }
  let end = (start + TOOL_PAGE_SIZE).min(visible.len());
  let mut result = ListToolsResult::with_all_items(
    visible[start..end]
      .iter()
      .map(|tool| {
        crate::tools::tool_router()
          .get(&tool.name)
          .expect("registered catalog tool has an SDK route")
          .clone()
      })
      .collect(),
  );
  if end < visible.len() {
    result.next_cursor = Some(encode_cursor(end));
  }
  Ok(result)
}

fn encode_cursor(offset: usize) -> String {
  base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{CURSOR_PREFIX}{offset}"))
}

fn decode_cursor(cursor: &str) -> Result<usize, McpToolError> {
  let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
    .decode(cursor)
    .ok()
    .and_then(|bytes| String::from_utf8(bytes).ok())
    .and_then(|value| value.strip_prefix(CURSOR_PREFIX).map(ToOwned::to_owned))
    .and_then(|offset| offset.parse::<usize>().ok())
    .ok_or_else(|| McpToolError::protocol(-32602, "Invalid tools/list cursor"))?;
  Ok(decoded)
}

#[cfg(test)]
mod tests {
  use std::collections::BTreeSet;

  use super::*;
  use uuid::Uuid;

  fn auth(scopes: &[&str]) -> McpAuthContext {
    McpAuthContext {
      user_id: Uuid::new_v4(),
      scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
      key_id: Uuid::new_v4(),
    }
  }

  #[test]
  fn registry_has_one_complete_entry_for_every_existing_tool() {
    let names = tools().iter().map(|tool| tool.name.as_str()).collect::<BTreeSet<_>>();
    assert_eq!(names.len(), tools().len());
    fn precise(schema: &Value) -> bool {
      if let Some(variants) = schema["oneOf"].as_array() {
        return !variants.is_empty() && variants.iter().all(precise);
      }
      schema["type"] == "object"
        && schema["properties"]
          .as_object()
          .is_some_and(|properties| !properties.is_empty())
        && schema["required"].as_array().is_some_and(|fields| !fields.is_empty())
    }
    for tool in tools() {
      assert!(
        precise(&tool.output_schema),
        "{} has a generic output fallback",
        tool.name
      );
      assert!(!tool.title.is_empty(), "{} lacks title", tool.name);
      assert!(!tool.description.is_empty(), "{} lacks description", tool.name);
      assert_eq!(tool.input_schema["type"], "object", "{} input schema", tool.name);
      assert_eq!(tool.output_schema["type"], "object", "{} output schema", tool.name);
      assert!(!tool.required_scope.is_empty(), "{} lacks scope", tool.name);
      assert!(!tool.target_type.is_empty(), "{} lacks target", tool.name);
    }
  }

  #[test]
  fn document_template_discovery_separates_builtin_diagnostics_from_document_reads() {
    let builtin_list = find_tool("template_list_for_workspace").expect("builtin list diagnostic");
    let builtin_reconcile = find_tool("template_request_reconcile").expect("builtin reconcile diagnostic");
    let builtin_copy = format!("{} {}", builtin_list.description, builtin_reconcile.description).to_ascii_lowercase();
    for truth in ["read-only", "builtin", "diagnostic"] {
      assert!(builtin_copy.contains(truth), "builtin discovery must say {truth}");
    }
    assert!(
      builtin_reconcile
        .description
        .contains("never marks, enqueues or rebuilds")
    );
    assert!(
      builtin_list
        .description
        .contains("does not list user document templates")
    );

    for name in ["document_template_list", "document_template_get"] {
      let tool = find_tool(name).expect("document template read tool");
      assert_eq!(tool.required_scope, "read:docs");
      assert_eq!(tool.access, ToolAccess::Read);
      assert!(tool.required_services.contains(&ToolService::DocumentTemplates));
      assert_eq!(tool.annotations.read_only_hint, Some(true));
      assert_eq!(tool.annotations.destructive_hint, Some(false));
      assert_eq!(tool.output_schema["additionalProperties"], false);
      let serialized = tool.output_schema.to_string();
      for forbidden in ["body", "docId", "internalId", "templateState"] {
        assert!(!serialized.contains(forbidden), "{name} leaks {forbidden}");
      }
    }
    let list = find_tool("document_template_list").unwrap();
    assert_eq!(list.input_schema["properties"]["limit"]["default"], 50);
    assert_eq!(list.input_schema["properties"]["limit"]["maximum"], 200);
    let get = find_tool("document_template_get").unwrap();
    assert!(get.input_schema["properties"].get("external_id").is_some());
    assert!(get.input_schema["properties"].get("doc_id").is_none());
    for name in [
      "document_template_create",
      "document_template_instantiate",
      "document_template_mark",
      "document_template_unmark",
    ] {
      let tool = find_tool(name).expect("document template write tool");
      assert_eq!(tool.required_scope, "write:docs");
      assert_eq!(tool.access, ToolAccess::Write);
      assert!(tool.required_services.contains(&ToolService::DocumentTemplates));
      assert!(tool.required_services.contains(&ToolService::Idempotency));
      assert_eq!(tool.annotations.idempotent_hint, Some(true));
      assert!(!tool.output_schema.to_string().contains("templateState"));
    }
  }

  #[test]
  fn folder_discovery_is_product_facing_and_keeps_its_wire_contract() {
    let cases = [
      (
        "folder_tree",
        "read:docs",
        ToolAccess::Read,
        false,
        true,
        &["max_depth", "workspace_id"][..],
        &["workspace_id"][..],
      ),
      (
        "folder_list",
        "read:docs",
        ToolAccess::Read,
        false,
        true,
        &["parent_id", "workspace_id"][..],
        &["workspace_id"][..],
      ),
      (
        "folder_create",
        "write:docs",
        ToolAccess::Write,
        false,
        false,
        &["idempotency_key", "index", "name", "parent_id", "workspace_id"][..],
        &["name", "workspace_id"][..],
      ),
      (
        "folder_update",
        "write:docs",
        ToolAccess::Write,
        true,
        false,
        &[
          "folder_id",
          "idempotency_key",
          "index",
          "name",
          "parent_id",
          "workspace_id",
        ][..],
        &["folder_id", "workspace_id"][..],
      ),
      (
        "folder_delete",
        "write:docs",
        ToolAccess::Write,
        true,
        false,
        &["folder_id", "idempotency_key", "workspace_id"][..],
        &["folder_id", "workspace_id"][..],
      ),
      (
        "folder_entry_list",
        "read:docs",
        ToolAccess::Read,
        false,
        true,
        &["parent_id", "target_type", "workspace_id"][..],
        &["workspace_id"][..],
      ),
      (
        "folder_entry_create",
        "write:docs",
        ToolAccess::Write,
        false,
        false,
        &[
          "idempotency_key",
          "index",
          "parent_id",
          "target_id",
          "target_type",
          "target_workspace_id",
          "workspace_id",
        ][..],
        &["parent_id", "target_id", "target_type", "workspace_id"][..],
      ),
      (
        "folder_entry_update",
        "write:docs",
        ToolAccess::Write,
        true,
        false,
        &[
          "entry_id",
          "idempotency_key",
          "index",
          "parent_id",
          "target_id",
          "target_type",
          "target_workspace_id",
          "workspace_id",
        ][..],
        &["entry_id", "workspace_id"][..],
      ),
      (
        "folder_entry_delete",
        "write:docs",
        ToolAccess::Write,
        true,
        false,
        &["entry_id", "idempotency_key", "workspace_id"][..],
        &["entry_id", "workspace_id"][..],
      ),
      (
        "document_import",
        "write:docs",
        ToolAccess::Write,
        false,
        true,
        &[
          "content_markdown",
          "folder_id",
          "folder_path",
          "fragment",
          "idempotency_key",
          "strict_loss",
          "title",
          "workspace_id",
        ][..],
        &["idempotency_key", "title", "workspace_id"][..],
      ),
      (
        "folder_path_ensure",
        "write:docs",
        ToolAccess::Write,
        false,
        true,
        &["idempotency_key", "path", "workspace_id"][..],
        &["idempotency_key", "path", "workspace_id"][..],
      ),
      (
        "folder_entry_place",
        "write:docs",
        ToolAccess::Write,
        true,
        true,
        &[
          "external_id",
          "folder_id",
          "folder_path",
          "idempotency_key",
          "workspace_id",
        ][..],
        &["external_id", "idempotency_key", "workspace_id"][..],
      ),
    ];

    for (name, scope, access, destructive, idempotent, properties, required) in cases {
      let tool = find_tool(name).expect("folder tool remains registered");
      let public_copy = format!("{} {}", tool.title, tool.description).to_ascii_lowercase();
      assert!(!public_copy.contains("organizer"), "{name} exposes the internal owner");
      assert!(
        !public_copy.contains("system doc"),
        "{name} exposes the persistence detail"
      );
      assert_eq!(tool.required_scope, scope, "{name} scope changed");
      assert_eq!(tool.access, access, "{name} access changed");
      assert_eq!(
        tool.annotations.read_only_hint,
        Some(access == ToolAccess::Read),
        "{name}"
      );
      assert_eq!(tool.annotations.destructive_hint, Some(destructive), "{name}");
      assert_eq!(tool.annotations.idempotent_hint, Some(idempotent), "{name}");
      assert_eq!(tool.annotations.open_world_hint, Some(false), "{name}");

      let actual_properties = tool.input_schema["properties"]
        .as_object()
        .expect("folder tool properties")
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
      assert_eq!(
        actual_properties,
        properties.iter().copied().collect(),
        "{name} properties"
      );
      let actual_required = tool.input_schema["required"]
        .as_array()
        .expect("folder tool required fields")
        .iter()
        .map(|field| field.as_str().expect("required field name"))
        .collect::<BTreeSet<_>>();
      assert_eq!(
        actual_required,
        required.iter().copied().collect(),
        "{name} required fields"
      );
    }
  }

  #[test]
  fn registry_and_sdk_routes_have_identical_names() {
    let registry = tools().iter().map(|tool| tool.name.as_str()).collect::<BTreeSet<_>>();
    let registered = crate::tools::tool_router().list_all();
    let dispatch = registered
      .iter()
      .map(|tool| tool.name.as_ref())
      .collect::<BTreeSet<_>>();
    assert_eq!(registry, dispatch);
    assert_eq!(dispatch.len(), registered.len());
  }

  #[test]
  fn document_tools_expose_only_explicit_external_keys_without_parent_selectors() {
    let core = [
      "read_doc",
      "update_doc",
      "doc_patch",
      "delete_page",
      "restore_page",
      "doc_version_list",
      "doc_version_create",
      "doc_metadata_get",
      "doc_metadata_validate",
      "doc_metadata_transition",
      "doc_metadata_update",
    ];
    for name in core {
      let tool = find_tool(name).expect("document tool");
      let properties = &tool.input_schema["properties"];
      assert!(properties.get("external_id").is_some(), "{name} lacks external_id");
      assert!(
        properties["external_id"].get("format").is_none(),
        "{name} treats the external key as UUID"
      );
      for retired in ["doc_id", "doc_ids", "current_doc_id", "source_doc_id"] {
        assert!(properties.get(retired).is_none(), "{name} retains {retired}");
      }
      let output = serde_json::to_string(&tool.output_schema).unwrap();
      assert!(!output.contains("\"docId\""), "{name} output schema leaks docId");
      assert!(!output.contains("\"doc_id\""), "{name} output schema leaks doc_id");
    }

    for name in ["list_pages", "create_page"] {
      let properties = &find_tool(name).expect("page tool").input_schema["properties"];
      assert!(
        properties.get("parent_id").is_none(),
        "{name} retains document parent_id"
      );
      assert!(
        properties.get("parent_external_id").is_none(),
        "{name} invents a document parent_external_id"
      );
    }

    let graph = &find_tool("document_graph_read").unwrap().input_schema["properties"];
    assert!(graph.get("external_id").is_some());
    assert!(graph.get("doc_id").is_none());
    let template = &find_tool("template_suggestions").unwrap().input_schema["properties"];
    assert!(template.get("current_external_id").is_some());
    assert!(template.get("current_doc_id").is_none());
    for name in ["calendar_event_create", "calendar_event_update"] {
      let properties = &find_tool(name).unwrap().input_schema["properties"];
      assert!(properties.get("source_external_id").is_some());
      assert!(properties.get("source_doc_id").is_none());
      assert!(properties["source_external_id"].get("format").is_none());
    }

    for source in [
      include_str!("tools.rs"),
      include_str!("tools/document.rs"),
      include_str!("tools/calendar.rs"),
    ] {
      for field in [
        "external_id",
        "external_ids",
        "current_external_id",
        "source_external_id",
      ] {
        assert!(
          !source.contains(&format!("parse_uuid(params, \"{field}\")")),
          "explicit external field {field} is parsed as UUID"
        );
      }
    }

    let lifecycle = include_str!("../../application/src/doc/lifecycle.rs");
    let traits = include_str!("../../application/src/doc/traits.rs");
    let create_command = traits
      .split("Create {")
      .nth(1)
      .and_then(|tail| tail.split("Rename {").next())
      .expect("PageLifecycleCommand::Create source");
    let persistence = include_str!("../../infrastructure/src/doc/mod.rs");
    assert!(!lifecycle.contains("create_with_parent"));
    assert!(!lifecycle.contains("create_page_lifecycle_with_parent"));
    assert!(!create_command.contains("parent_id"));
    assert!(!persistence.contains("jsonb_build_object('parentId'"));
  }

  #[test]
  fn projection_recovery_tools_are_bounded_external_key_scoped_and_guarded() {
    let scan = find_tool("page_projection_scan").expect("scan tool");
    assert_eq!(scan.required_scope, "read:docs");
    assert_eq!(scan.annotations.read_only_hint, Some(true));
    assert_eq!(scan.annotations.destructive_hint, Some(false));
    assert!(scan.audit_event.is_none());
    assert_eq!(scan.input_schema["properties"]["limit"]["maximum"], 200);
    assert_eq!(
      scan.output_schema["properties"]["items"]["items"]["properties"]["externalDocId"]["type"],
      json!(["string", "null"]),
    );

    let inspect = find_tool("page_projection_inspect").expect("inspect tool");
    assert_eq!(inspect.required_scope, "read:docs");
    assert_eq!(inspect.annotations.read_only_hint, Some(true));
    assert!(
      inspect.input_schema["properties"]["external_doc_id"]
        .get("format")
        .is_none()
    );
    assert_eq!(inspect.output_schema["properties"]["externalDocId"]["type"], "string",);

    let repair = find_tool("page_projection_repair").expect("repair tool");
    assert_eq!(repair.required_scope, "write:docs");
    assert_eq!(repair.annotations.destructive_hint, Some(true));
    assert_eq!(repair.annotations.idempotent_hint, Some(true));
    assert_eq!(repair.input_schema["required"].as_array().map(Vec::len), Some(4));
    assert!(
      repair.input_schema["properties"]["external_doc_id"]
        .get("format")
        .is_none()
    );
    assert!(repair.input_schema["properties"].get("doc_ids").is_none());
    assert_eq!(repair.input_schema["properties"]["mode"]["default"], "dry_run");
    assert!(repair.required_services.contains(&ToolService::Idempotency));
    assert!(find_tool("page_lifecycle_audit").is_none());
    assert!(find_tool("page_lifecycle_repair").is_none());
  }

  #[test]
  fn every_write_tool_declares_exactly_one_compatible_idempotency_contract() {
    let required = [
      "comment_create",
      "comment_update",
      "comment_set_resolved",
      "comment_delete",
      "comment_thread_mark_read",
      "comment_threads_mark_all_read",
      "user_create",
      "user_update",
      "user_suspend",
      "user_enable",
      "user_reset_link",
      "user_set_admin",
      "user_delete",
      "pdf_export_create",
      "doc_version_restore",
      "update_doc",
      "doc_patch",
      "page_projection_repair",
      "document_import",
      "document_image_insert",
      "document_reference_insert",
      "document_template_create",
      "document_template_instantiate",
      "document_template_mark",
      "document_template_unmark",
      "folder_path_ensure",
      "folder_entry_place",
      "database_create",
      "database_update",
      "database_trash",
      "database_restore",
      "database_delete_permanently",
      "database_view_create",
      "database_view_update",
      "database_view_delete",
      "database_view_reorder",
      "database_field_create",
      "database_field_update",
      "database_field_delete",
      "database_field_reorder",
      "database_row_create",
      "database_cell_update",
      "database_row_update",
      "database_row_delete",
      "database_row_restore",
      "database_row_from_template",
      "automation_run_retry",
      "automation_run_stop",
      "calendar_event_create",
      "calendar_event_update",
      "calendar_event_delete",
      "organization_unit_member_add",
      "organization_unit_member_set_role",
      "organization_unit_member_remove",
      "organization_unit_create",
      "organization_unit_update",
      "organization_unit_move",
      "organization_unit_set_status",
      "organization_unit_delete_permanent",
      "workspace_tag_create",
      "workspace_tag_rename",
      "workspace_tag_recolor",
      "workspace_tag_description_update",
      "workspace_tag_archive",
      "workspace_tag_restore",
      "workspace_tag_delete_permanently",
      "document_tags_set",
      "workspace_create",
      "workspace_owner_transfer",
      "workspace_management_unit_set",
      "workspace_member_invite",
      "workspace_invite_link_create",
      "workspace_invite_link_revoke",
      "workspace_member_add",
      "workspace_member_set_role",
      "workspace_member_remove",
      "workspace_delete",
      "workspace_restore",
      "workspace_update",
      "doc_publication_set",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let optional = OPTIONAL_IDEMPOTENCY_TOOLS.iter().copied().collect::<BTreeSet<_>>();
    let natural = NATURALLY_IDEMPOTENT_WRITE_TOOLS
      .iter()
      .copied()
      .collect::<BTreeSet<_>>();
    let writes = tools()
      .iter()
      .filter(|tool| tool.access == ToolAccess::Write)
      .map(|tool| tool.name.as_str())
      .collect::<BTreeSet<_>>();
    assert_eq!(
      writes,
      optional
        .union(&required)
        .copied()
        .chain(natural.iter().copied())
        .collect()
    );

    for name in optional {
      let tool = find_tool(name).expect("optional idempotency tool");
      assert!(
        tool.input_schema["properties"].get("idempotency_key").is_some(),
        "{name}"
      );
      assert!(
        !tool.input_schema["required"]
          .as_array()
          .is_some_and(|required| required.iter().any(|field| field == "idempotency_key")),
        "{name} must keep keyless compatibility"
      );
      assert_eq!(
        tool.annotations.idempotent_hint,
        Some(false),
        "{name} is not statically idempotent"
      );
      assert!(!tool.required_services.contains(&ToolService::Idempotency), "{name}");
    }
    for name in required {
      let tool = find_tool(name).expect("required idempotency tool");
      assert!(
        tool.input_schema["required"]
          .as_array()
          .is_some_and(|required| required.iter().any(|field| field == "idempotency_key")),
        "{name} must require the key"
      );
      assert_eq!(tool.annotations.idempotent_hint, Some(true), "{name}");
      assert!(tool.required_services.contains(&ToolService::Idempotency), "{name}");
    }
    for name in natural {
      let tool = find_tool(name).expect("naturally idempotent write tool");
      assert!(
        tool.input_schema["properties"].get("idempotency_key").is_none(),
        "{name}"
      );
      assert_eq!(tool.annotations.idempotent_hint, Some(true), "{name}");
      assert!(!tool.required_services.contains(&ToolService::Idempotency), "{name}");
    }
  }

  #[test]
  fn import_schemas_require_one_real_content_transport_field() {
    for name in [
      "database_json_import_preview",
      "database_json_import",
      "database_notion_import_preview",
      "database_notion_import",
    ] {
      let schema = &find_tool(name).expect("registered import tool").input_schema;
      assert!(!schema["required"].as_array().unwrap().contains(&json!("content")));
      let alternatives = schema["anyOf"].as_array().expect("content transport alternatives");
      assert_eq!(alternatives.len(), 2);
      assert!(
        alternatives
          .iter()
          .any(|entry| entry["required"] == json!(["content_base64"]))
      );
      assert!(
        alternatives
          .iter()
          .any(|entry| entry["required"] == json!(["content_text"]))
      );
    }
  }

  #[test]
  fn document_mutation_schemas_describe_the_actual_semantic_fragment_contract() {
    for name in ["create_page", "document_import", "update_doc", "doc_patch"] {
      let tool = find_tool(name).expect("document mutation tool");
      assert_eq!(tool.input_schema["properties"]["strict_loss"]["type"], "boolean");
      assert_eq!(tool.input_schema["properties"]["strict_loss"]["default"], false);
      assert_eq!(
        tool.output_schema["properties"]["normalizationDiagnostics"]["maxItems"],
        100
      );
      assert_eq!(
        tool.output_schema["properties"]["normalizationDiagnosticCount"]["minimum"],
        0
      );
      let fragment = &tool.input_schema["$defs"]["documentFragment"];
      assert_eq!(
        fragment["properties"]["schemaVersion"]["const"],
        "myoxus.document-fragment.v1"
      );
      assert!(
        fragment["required"]
          .as_array()
          .unwrap()
          .contains(&json!("schemaVersion"))
      );
      let variants = fragment["$defs"]["documentBlock"]["oneOf"]
        .as_array()
        .expect("typed document block variants");
      for kind in ["callout", "footnote_definition", "citation_definition", "annotation"] {
        assert!(
          variants
            .iter()
            .any(|variant| variant["properties"]["kind"]["const"] == kind)
        );
      }
      let paragraph = variants
        .iter()
        .find(|variant| variant["properties"]["kind"]["const"] == "paragraph")
        .unwrap();
      assert_eq!(
        paragraph["properties"]["spans"]["items"]["properties"]["footnote"]["oneOf"]
          .as_array()
          .map(Vec::len),
        Some(2)
      );
      assert!(
        variants
          .iter()
          .any(|variant| variant["properties"]["kind"]["const"] == "table")
      );
      assert_eq!(
        variants
          .iter()
          .any(|variant| variant["properties"]["kind"]["const"] == "image"),
        true
      );
      assert_ne!(
        tool.output_schema,
        json!({"type": "object", "description": "Structured JSON payload returned by the tool."})
      );
    }
    let import = find_tool("document_import").expect("document import tool");
    assert_eq!(import.input_schema["additionalProperties"], false);
    assert_eq!(import.input_schema["allOf"].as_array().map(Vec::len), Some(2));
    assert!(
      import.input_schema["required"]
        .as_array()
        .is_some_and(|required| required.contains(&json!("idempotency_key")))
    );
    assert_eq!(import.output_schema["additionalProperties"], false);
    assert_eq!(
      import.output_schema["properties"]["markdownDiagnosticCount"],
      json!({"type":"integer","minimum":0})
    );
    let title_patch = find_tool("doc_patch").expect("title patch tool");
    assert!(
      title_patch.input_schema["properties"]["operation"]["enum"]
        .as_array()
        .is_some_and(|operations| operations.contains(&json!("update_title")))
    );
    assert!(
      title_patch.input_schema["oneOf"]
        .as_array()
        .is_some_and(|variants| { variants.iter().any(|variant| variant["required"] == json!(["title"])) })
    );
    for operation in [
      "delete_block",
      "move_block",
      "edit_text",
      "format_text",
      "edit_table_cell",
      "update_block_properties",
      "update_citation",
    ] {
      assert!(
        title_patch.input_schema["properties"]["operation"]["enum"]
          .as_array()
          .is_some_and(|operations| operations.contains(&json!(operation)))
      );
    }
    assert_eq!(
      title_patch.input_schema["properties"]["expected_revision"]["minimum"],
      0
    );
    for name in ["create_page", "delete_page", "restore_page"] {
      assert_ne!(
        find_tool(name).expect("lifecycle tool").output_schema,
        json!({"type": "object", "description": "Structured JSON payload returned by the tool."})
      );
    }
  }

  #[test]
  fn read_doc_schema_describes_structured_and_export_envelopes_exactly() {
    let schema = &find_tool("read_doc").expect("read_doc tool").output_schema;
    let envelopes = schema["oneOf"].as_array().expect("read_doc envelope variants");
    assert_eq!(envelopes.len(), 2);
    assert_eq!(
      envelopes[0]["properties"]["schemaVersion"]["const"],
      "myoxus.document-projection.v1"
    );
    assert!(
      envelopes[0]["properties"]["document"]["required"]
        .as_array()
        .unwrap()
        .contains(&json!("blocks"))
    );
    assert_projected_native_blocks_match_schema(schema);
    // A native table may retain either empty axis; individual IDs stay nonempty and unique.
    let axes =
      &envelopes[0]["properties"]["document"]["properties"]["tableIdentities"]["additionalProperties"]["properties"];
    for name in ["rowIds", "columnIds"] {
      let ids = &axes[name];
      assert!(projection_schema_accepts(schema, ids, &json!(["coordinate-id"])));
      assert!(projection_schema_accepts(schema, ids, &json!([])));
      assert!(!projection_schema_accepts(schema, ids, &json!([""])));
      assert!(!projection_schema_accepts(schema, ids, &json!(["same-id", "same-id"])));
    }
    let integer = json!({"type":"integer","minimum":0});
    for value in [json!(0), json!(1), json!(1.0)] {
      assert!(projection_schema_accepts(&integer, &integer, &value));
    }
    for value in [json!(-1), json!(-1.0), json!(1.5), json!("1")] {
      assert!(!projection_schema_accepts(&integer, &integer, &value));
    }

    assert_eq!(
      schema["$defs"]["documentAsset"]["properties"]["blobRead"]["$ref"],
      "#/$defs/blobRead"
    );
    assert_eq!(schema["$defs"]["blobRead"]["properties"]["tool"]["const"], "blob_read");
    assert_eq!(
      envelopes[1]["properties"]["format"]["enum"],
      json!(["html", "markdown", "plain_text", "raw_yjs"])
    );
  }

  use crate::output_schema_test_support::projection_schema_accepts;

  fn assert_projected_native_blocks_match_schema(schema: &Value) {
    use myoxus_application::doc::{
      DocLoadService, DocumentContentProjectionService, DocumentProjectionRequest, DocumentRepresentation,
      PanicDocStore,
    };
    use std::sync::Arc;
    use yrs::updates::decoder::Decode;
    use yrs::{Array, Map, ReadTxn, Transact};
    let doc = yrs::Doc::new();
    let payload = myoxus_application::markdown::prepare_markdown_import(
      "Schema fixture",
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../build/fixtures/seed-documents/complex/03-operations-runbook-fixture.md"
      )),
    )
    .unwrap()
    .yjs_binary;
    doc
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&payload).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    {
      let mut txn = doc.transact_mut();
      let note = blocks
        .iter(&txn)
        .find_map(|(_, block)| {
          let yrs::Out::YMap(block) = block else {
            return None;
          };
          (block
            .get(&txn, "sys:flavour")
            .is_some_and(|value| value.to_string(&txn) == "myoxus:note"))
          .then_some(block)
        })
        .expect("native note");
      let Some(yrs::Out::YArray(children)) = note.get(&txn, "sys:children") else {
        panic!("note children");
      };
      let ids: Vec<_> = children.iter(&txn).map(|value| value.to_string(&txn)).collect();
      let callout = blocks.insert(&mut txn, "callout", yrs::MapPrelim::default());
      callout.insert(&mut txn, "sys:id", "callout");
      callout.insert(&mut txn, "sys:flavour", "myoxus:callout");
      callout.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Callout"));
      callout.insert(&mut txn, "prop:appearance", "accent");
      let nested = callout.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      for id in &ids {
        nested.push_back(&mut txn, id.as_str());
      }
      children.remove_range(&mut txn, 0, ids.len() as u32);
      children.push_back(&mut txn, "callout");
    }
    let payload = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let service = DocumentContentProjectionService::new(
      Arc::new(DocLoadService::new(Arc::new(PanicDocStore))),
      Arc::<[u8]>::from(b"schema-fixture".as_slice()),
    )
    .with_html_catalog(Some(html_catalog_fixture()));
    for representation in [
      DocumentRepresentation::Structured,
      DocumentRepresentation::Html,
      DocumentRepresentation::Markdown,
      DocumentRepresentation::PlainText,
      DocumentRepresentation::RawYjs,
    ] {
      let projected = service
        .project_payload(
          DocumentProjectionRequest {
            workspace_id: Uuid::new_v4(),
            doc_id: Uuid::new_v4(),
            fallback_title: "Schema fixture".to_string(),
            metadata_badges: Vec::new(),
            representation,
            cursor: None,
            limit: Some(200),
            theme_css_url: "/api/branding/theme.css".to_string(),
            selector: None,
            neighbor_context: 0,
          },
          &payload,
          42,
        )
        .unwrap();
      let mut projected = serde_json::to_value(projected).unwrap();
      assert_eq!(projected["revision"], 42);
      if let Some(document) = projected.get_mut("document").and_then(Value::as_object_mut) {
        document.remove("docId");
        document.insert("externalId".to_string(), json!("external-fixture"));
        assert_eq!(document["blocks"][0]["kind"], "callout");
        assert!(!document["blocks"][0]["children"].as_array().unwrap().is_empty());
      }
      assert!(
        projection_schema_accepts(schema, schema, &projected),
        "real projection violates advertised schema: {projected}"
      );
      if representation == DocumentRepresentation::Structured {
        let mut invalid = projected.clone();
        invalid["document"]["blocks"][0]["children"][0]["blockId"] = json!(42);
        assert!(
          !projection_schema_accepts(schema, schema, &invalid),
          "nested schema must actually be enforced"
        );
      }
    }
  }

  fn html_catalog_fixture() -> std::sync::Arc<myoxus_public_render::HtmlRenderer> {
    static CAPTURED: std::sync::OnceLock<std::sync::Arc<myoxus_public_render::HtmlRenderer>> =
      std::sync::OnceLock::new();
    CAPTURED
      .get_or_init(|| {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
        let files = myoxus_public_render::HTML_CATALOG_FILES
          .iter()
          .map(|name| (name.to_string(), std::fs::read(root.join(name)).unwrap()))
          .collect();
        std::sync::Arc::new(myoxus_public_render::HtmlRenderer::from_files(files).unwrap())
      })
      .clone()
  }
  #[test]
  fn selected_read_output_schema_accepts_real_identity_and_completeness_envelopes() {
    use myoxus_application::doc::{DocumentProjectionRequest, DocumentRepresentation, DocumentSelector};
    let schema = &find_tool("read_doc").unwrap().output_schema;
    let service = myoxus_application::doc::DocumentContentProjectionService::new(
      std::sync::Arc::new(myoxus_application::doc::DocLoadService::new(std::sync::Arc::new(
        myoxus_application::doc::PanicDocStore,
      ))),
      std::sync::Arc::<[u8]>::from(b"selected-schema-fixture".as_slice()),
    );
    let payload = myoxus_application::markdown::markdown_to_yjs(
      "Selectors",
      "## Heading\n\nBody[^note]\n\n[^note]: Definition\n\n> [!note] Native title\n> Native body",
    )
    .unwrap();
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let request = |selector| DocumentProjectionRequest {
      workspace_id,
      doc_id,
      fallback_title: "Selectors".into(),
      metadata_badges: Vec::new(),
      representation: DocumentRepresentation::Structured,
      cursor: None,
      limit: Some(1),
      theme_css_url: "/api/branding/theme.css".into(),
      selector,
      neighbor_context: 0,
    };
    let mut whole_request = request(None);
    whole_request.limit = Some(200);
    let mut first = serde_json::to_value(service.project_payload(whole_request, &payload, 42).unwrap()).unwrap();
    first["document"].as_object_mut().unwrap().remove("docId");
    first["document"]["externalId"] = json!("selectors");
    assert!(
      projection_schema_accepts(schema, schema, &first),
      "native footnote/callout schema: {first}"
    );
    let definition = first["document"]["blocks"]
      .as_array()
      .unwrap()
      .iter()
      .find(|block| block["kind"] == "footnote_definition")
      .expect("native footnote definition")["blockId"]
      .as_str()
      .unwrap()
      .to_string();
    let id = first["document"]["blocks"][0]["blockId"].as_str().unwrap().to_string();
    for selector in [
      DocumentSelector::Outline,
      DocumentSelector::Section(id.clone()),
      DocumentSelector::Block(id.clone()),
      DocumentSelector::Block(definition),
    ] {
      let projected = service.project_payload(request(Some(selector)), &payload, 42).unwrap();
      let mut value = serde_json::to_value(projected).unwrap();
      value["document"].as_object_mut().unwrap().remove("docId");
      value["document"]["externalId"] = json!("selectors");
      assert!(projection_schema_accepts(schema, schema, &value), "{value}");
      value["selection"]["identities"][0]["context"] = json!("false");
      assert!(!projection_schema_accepts(schema, schema, &value));
    }
  }

  #[test]
  fn list_filters_scope_and_optional_services_then_paginates_without_loss() {
    let full_auth = auth(&[
      "read:workspaces",
      "write:workspaces",
      "read:docs",
      "write:docs",
      "read:databases",
      "write:databases",
      "read:document_graph",
      "read:templates",
      "read:automations",
      "write:automations",
      "read:calendar",
      "write:calendar",
      "read:organization",
      "write:organization",
      "read:users",
      "write:users",
    ]);
    let availability = ToolAvailability {
      search: true,
      database: true,
      assistant_packages: true,
      calendar: true,
      organization: true,
      organization_reads: true,
      organization_memberships: true,
      users: true,
      comments: true,
      workspace_publication: true,
      workspace_settings: true,
      document_publication: true,
      workspace_tags: true,
      document_graph: true,
      template_registry: true,
      document_templates: true,
      template_suggestions: true,
      workspace_automation: true,
      pdf_templates: true,
      pdf_export: true,
      document_persistence: true,
      idempotency: true,
      blob: true,
      blob_upload: true,
    };
    let mut cursor = None;
    let mut names = BTreeSet::new();
    loop {
      let params = cursor
        .as_ref()
        .map_or_else(|| json!({}), |cursor| json!({"cursor": cursor}));
      let page = list_tools(&params, &full_auth, availability).unwrap();
      let page_tools = &page.tools;
      assert!(page_tools.len() <= TOOL_PAGE_SIZE);
      names.extend(page_tools.iter().map(|tool| tool.name.to_string()));
      cursor = page.next_cursor;
      if cursor.is_none() {
        break;
      }
    }
    assert_eq!(names.len(), tools().len());

    let restricted = list_tools(&json!({}), &auth(&["read:docs"]), ToolAvailability::default()).unwrap();
    let restricted_names = restricted
      .tools
      .iter()
      .map(|tool| tool.name.as_ref())
      .collect::<BTreeSet<_>>();
    assert!(restricted_names.contains("read_doc"));
    assert!(!restricted_names.contains("search_docs"));
    assert!(!restricted_names.contains("create_page"));
  }

  #[test]
  fn workspace_tag_reads_are_discovered_only_when_the_application_owner_is_wired() {
    let auth = auth(&["read:docs"]);
    let discovered_names = |availability| {
      let mut cursor = None;
      let mut names = BTreeSet::new();
      loop {
        let params = cursor
          .as_ref()
          .map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor }));
        let page = list_tools(&params, &auth, availability).expect("list MCP tools");
        names.extend(page.tools.iter().map(|tool| tool.name.to_string()));
        cursor = page.next_cursor;
        if cursor.is_none() {
          break;
        }
      }
      names
    };

    let disabled = discovered_names(ToolAvailability::default());
    for name in ["workspace_tag_list", "workspace_tag_get", "document_tags_get"] {
      assert!(
        !disabled.contains(name),
        "{name} must fail closed without WorkspaceTagService"
      );
    }

    let enabled = discovered_names(ToolAvailability {
      workspace_tags: true,
      ..ToolAvailability::default()
    });
    for name in ["workspace_tag_list", "workspace_tag_get", "document_tags_get"] {
      assert!(
        enabled.contains(name),
        "{name} must be discoverable when its owner is wired"
      );
    }
  }

  #[test]
  fn workspace_tag_writes_are_scope_service_and_idempotency_guarded_without_slug_input() {
    let write_names = [
      "workspace_tag_create",
      "workspace_tag_rename",
      "workspace_tag_recolor",
      "workspace_tag_description_update",
      "workspace_tag_archive",
      "workspace_tag_restore",
    ];
    for name in write_names {
      let tool = find_tool(name).expect("workspace Tag lifecycle tool");
      assert_eq!(tool.required_scope, "write:docs");
      assert!(tool.required_services.contains(&ToolService::WorkspaceTags));
      assert!(tool.required_services.contains(&ToolService::Idempotency));
      assert_eq!(tool.annotations.idempotent_hint, Some(true));
      assert_eq!(tool.annotations.read_only_hint, Some(false));
      assert!(
        tool.input_schema["required"]
          .as_array()
          .is_some_and(|required| required.contains(&json!("idempotency_key")))
      );
      assert!(tool.input_schema["properties"].get("slug").is_none());
      assert_eq!(tool.output_schema["additionalProperties"], false);
      assert!(tool.output_schema["properties"].get("slug").is_none());
      assert!(tool.output_schema["properties"].get("description").is_some());
    }

    let permanent_delete = find_tool("workspace_tag_delete_permanently").expect("permanent Tag deletion tool");
    assert_eq!(permanent_delete.required_scope, "write:docs");
    assert!(permanent_delete.required_services.contains(&ToolService::WorkspaceTags));
    assert!(permanent_delete.required_services.contains(&ToolService::Idempotency));
    assert_eq!(permanent_delete.annotations.idempotent_hint, Some(true));
    assert_eq!(permanent_delete.annotations.destructive_hint, Some(true));
    assert_eq!(
      permanent_delete.input_schema["properties"]["confirm_permanent_delete"]["const"],
      true
    );
    assert_eq!(permanent_delete.output_schema["required"], json!(["tagId", "deleted"]));
    assert_eq!(permanent_delete.output_schema["properties"]["deleted"]["const"], true);

    let auth = auth(&["write:docs"]);
    let enabled = ToolAvailability {
      workspace_tags: true,
      idempotency: true,
      ..ToolAvailability::default()
    };
    for name in write_names {
      let tool = find_tool(name).unwrap();
      assert!(!tool.visible_to(&auth, ToolAvailability::default()));
      assert!(tool.visible_to(&auth, enabled));
    }
    assert!(!permanent_delete.visible_to(&auth, ToolAvailability::default()));
    assert!(permanent_delete.visible_to(&auth, enabled));

    let assignment = find_tool("document_tags_set").expect("document Tag replacement tool");
    assert_eq!(assignment.required_scope, "write:docs");
    assert!(assignment.required_services.contains(&ToolService::WorkspaceTags));
    assert!(assignment.required_services.contains(&ToolService::Idempotency));
    assert_eq!(assignment.annotations.idempotent_hint, Some(true));
    assert!(assignment.input_schema["properties"].get("external_id").is_some());
    assert_eq!(assignment.input_schema["properties"]["tag_ids"]["uniqueItems"], true);
    for forbidden in ["name", "tag_name", "slug"] {
      assert!(assignment.input_schema["properties"].get(forbidden).is_none());
    }
    assert!(assignment.visible_to(&auth, enabled));
    assert_eq!(assignment.output_schema["additionalProperties"], false);
    assert_eq!(assignment.annotations.destructive_hint, Some(true));
    assert_eq!(assignment.annotations.read_only_hint, Some(false));
    for semantic in [
      "Label",
      "canonical UUIDs",
      "workspace-local",
      "entire ordered",
      "omitted IDs",
      "[] clears",
      "archived",
      "idempotency_key",
      "without reapplying",
    ] {
      assert!(
        assignment.description.contains(semantic),
        "served assignment announcement must explain {semantic}"
      );
    }
    for name in ["workspace_tag_list", "workspace_tag_create", "document_tags_get"] {
      let tool = find_tool(name).unwrap();
      assert!(tool.description.contains("Label"));
      assert!(tool.description.contains("document_tags_set"));
      assert!(tool.description.contains("UUID"));
    }
    assert_eq!(
      find_tool("workspace_tag_create").unwrap().annotations.destructive_hint,
      Some(false)
    );
  }
}
