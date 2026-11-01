// SPDX-License-Identifier: AGPL-3.0-or-later
//! Existing OU lifecycle projections. The flat inventory has no continuation
//! envelope; do not invent pagination fields or expose unprojected DTO members.

use serde_json::{Value, json};

pub(super) fn output_schema(name: &str) -> Option<Value> {
  let uuid = json!({"type":"string","format":"uuid"});
  let timestamp = json!({"type":"string","format":"date-time"});
  let status = json!({"type":"string","enum":["active","disabled","archived"]});
  let unit = json!({
    "type":"object","additionalProperties":false,
    "required":["id","organizationId","parentUnitId","unitTypeId","name","slug","description","status","maxMembers","metadata","childUnitCount","memberCount","workspaceCount","createdAt","updatedAt"],
    "properties":{
      "id":uuid,"organizationId":uuid,"parentUnitId":{"oneOf":[{"type":"null"},uuid]},
      "unitTypeId":uuid,"name":{"type":"string"},"slug":{"type":"string"},
      "description":{"type":["string","null"]},"status":status,"maxMembers":{"type":"integer"},
      "metadata":{"type":["object","array","string","number","boolean","null"],"description":"Existing serde_json::Value metadata, including retained JSON null."},
      "childUnitCount":{"type":"integer","minimum":0},"memberCount":{"type":"integer","minimum":0},
      "workspaceCount":{"type":"integer","minimum":0},"createdAt":timestamp,"updatedAt":timestamp
    }
  });
  match name {
    "organization_unit_get"
    | "organization_unit_create"
    | "organization_unit_update"
    | "organization_unit_move"
    | "organization_unit_set_status" => Some(unit),
    "organization_unit_list" => Some(json!({
      "type":"object","additionalProperties":false,"required":["units"],
      "properties":{"units":{"type":"array","items":unit}}
    })),
    "organization_unit_delete_preview" => Some(json!({
      "type":"object","additionalProperties":false,"required":["id","name","status","updatedAt","deletable","blockers"],
      "properties":{
        "id":uuid,"name":{"type":"string"},"status":status,"updatedAt":timestamp,
        "deletable":{"type":"boolean"},"blockers":{"type":"array","maxItems":7,"items":{
          "type":"object","additionalProperties":false,"required":["code","count"],
          "properties":{"code":{"type":"string","enum":["CHILD_UNITS","MEMBERS","WORKSPACE_LINKS","OWNER_PRINCIPAL_WORKSPACES","MANAGEMENT_UNIT_WORKSPACES","PROJECT_REQUESTS","OIDC_GROUP_MAPPINGS"]},"count":{"type":"integer","minimum":1}}
        }}
      }
    })),
    "organization_unit_delete_permanent" => Some(json!({
      "type":"object","additionalProperties":false,"required":["deleted","id","name"],
      "properties":{"deleted":{"type":"boolean","const":true},"id":uuid,"name":{"type":"string"}}
    })),
    _ => None,
  }
}
