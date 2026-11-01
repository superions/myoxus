// SPDX-License-Identifier: AGPL-3.0-or-later
//! Calendar discovery mirrors `tools::calendar::event_json`, not the larger
//! internal event DTO. External identities and nullable recurrence links keep
//! their existing wire representation.

use serde_json::{Value, json};

pub(super) fn output_schema(name: &str) -> Option<Value> {
  let uuid = json!({"type":"string","format":"uuid"});
  let timestamp = json!({"type":"string","format":"date-time"});
  let nullable_uuid = json!({"oneOf":[{"type":"null"},uuid]});
  let nullable_text = json!({"type":["string","null"]});
  let event = json!({
    "type":"object","additionalProperties":false,
    "required":["id","origin","workspaceId","startsAt","endsAt","title","description","location","allDay","allMembers","tagId","sourceExternalId","recurrenceParentId","updatedAt"],
    "properties":{
      "id":uuid,"origin":{"type":"string","enum":["native","external"]},
      "workspaceId":nullable_uuid,"startsAt":timestamp,"endsAt":timestamp,
      "title":nullable_text,"description":nullable_text,"location":nullable_text,
      "allDay":{"type":"boolean"},"allMembers":{"type":"boolean"},
      "tagId":nullable_uuid,"sourceExternalId":nullable_text,
      "recurrenceParentId":nullable_uuid,"updatedAt":timestamp
    }
  });
  match name {
    "calendar_event_create" | "calendar_event_update" => {
      let mut native = event;
      native["properties"]["origin"] = json!({"type":"string","const":"native"});
      native["properties"]["workspaceId"] = uuid.clone();
      Some(native)
    }
    "calendar_event_delete" => Some(json!({
      "type":"object","additionalProperties":false,"required":["deleted","id"],
      "properties":{"deleted":{"type":"boolean","const":true},"id":uuid}
    })),
    "calendar_events_list" | "calendar_conflicts_check" => {
      let (key, item) = if name == "calendar_events_list" {
        ("events", event)
      } else {
        (
          "conflicts",
          json!({
            "type":"object","additionalProperties":false,
            "required":["eventId","startsAt","endsAt","title"],
            "properties":{"eventId":uuid,"startsAt":timestamp,"endsAt":timestamp,"title":nullable_text}
          }),
        )
      };
      Some(json!({
        "type":"object","additionalProperties":false,
        "required":["workspaceId","from","to",key],
        "properties":{"workspaceId":uuid,"from":timestamp,"to":timestamp,(key):{"type":"array","maxItems":500,"items":item}}
      }))
    }
    _ => None,
  }
}
