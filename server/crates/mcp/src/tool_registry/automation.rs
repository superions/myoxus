// SPDX-License-Identifier: AGPL-3.0-or-later
//! Safe inventory/status projections, excluding trigger and action payloads.

use serde_json::{Value, json};

fn object(properties: Value) -> Value {
  let required = properties
    .as_object()
    .expect("schema properties")
    .keys()
    .cloned()
    .collect::<Vec<_>>();
  json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
}

pub(super) fn definitions() -> Vec<Value> {
  ["automation_list","automation_run_list","automation_run_get","automation_dead_letter_list"].into_iter().map(|name| {
    let mut properties=if name=="automation_run_get" {json!({"run_id":{"type":"string","format":"uuid"}})} else {
      json!({"workspace_id":{"type":"string","format":"uuid"},"limit":{"type":"integer","minimum":1,"maximum":200,"default":50},"offset":{"type":"integer","minimum":0,"maximum":i64::MAX-200,"default":0}})
    };
    if name=="automation_run_list" {
      properties["automation_id"]=json!({"type":"string","format":"uuid"});
      properties["include_dead_letter"]=json!({"type":"boolean","default":false});
    }
    json!({"name":name,"description":"Read Workspace Automation inventory or run status with read:automations and current Workspace Read permission. Lists return explicit continuation; trigger/action content and raw errors are excluded.","inputSchema":{"type":"object","additionalProperties":false,"required":[if name=="automation_run_get" {"run_id"} else {"workspace_id"}],"properties":properties}})
  }).collect()
}

pub(super) fn output_schema(name: &str) -> Option<Value> {
  let id = json!({"type":"string","format":"uuid"});
  let nullable_id = json!({"type":["string","null"],"format":"uuid"});
  let time = json!({"type":"string","format":"date-time"});
  let nullable_time = json!({"type":["string","null"],"format":"date-time"});
  let trigger =
    json!({"type":"string","enum":["row_created","row_updated","relation_changed","status_select_changed"]});
  let run = object(json!({"id":id,"automationId":nullable_id,"workspaceId":id,
    "origin":{"type":"string","enum":["rule","confirmed_request","document_review","task_handover","task_maintenance","workspace_setup"]},"requestId":nullable_id,"jobId":{"type":["string","null"]},"triggerType":{"oneOf":[trigger,{"type":"null"}]},
    "status":{"type":"string","enum":["queued","running","succeeded","failed","dead_letter","skipped"]},"attemptCount":{"type":"integer","minimum":0},
    "errorCode":{"type":["string","null"],"enum":[null,"MIX_AUTOMATION_NOT_FOUND","MIX_AUTOMATION_FORBIDDEN","MIX_AUTOMATION_TRIGGER_INVALID","MIX_AUTOMATION_ACTION_INVALID","MIX_AUTOMATION_RATE_LIMITED","MIX_AUTOMATION_IDEMPOTENCY_CONFLICT","MIX_AUTOMATION_WEBHOOK_FAILED","MIX_AUTOMATION_RUN_FAILED","MIX_AUTOMATION_RUN_NOT_RETRYABLE","MIX_AUTOMATION_INPUTS_UNAVAILABLE"]},
    "errorSummary":{"type":["string","null"],"maxLength":128},"deadLetter":{"type":"boolean"},"queuedAt":time,"startedAt":nullable_time,"finishedAt":nullable_time}));
  if name == "automation_run_get" {
    return Some(object(json!({"run":run})));
  }
  let (key, item) = if name == "automation_list" {
    (
      "automations",
      object(
        json!({"id":id,"workspaceId":id,"name":{"type":"string"},"status":{"type":"string","enum":["enabled","disabled"]},"triggerType":trigger,"databaseId":id,"fieldId":nullable_id,"actionTypes":{"type":"array","items":{"type":"string","enum":["create_row","update_cell","create_linked_document","notify_webhook"]}},"createdBy":nullable_id,"updatedBy":nullable_id,"createdAt":time,"updatedAt":time}),
      ),
    )
  } else {
    ("runs", run)
  };
  let mut properties = json!({"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200},"has_more":{"type":"boolean"},"next_offset":{"type":["integer","null"],"minimum":0}});
  properties[key] = json!({"type":"array","maxItems":200,"items":item});
  Some(object(properties))
}
