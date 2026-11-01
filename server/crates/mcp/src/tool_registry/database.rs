// SPDX-License-Identifier: AGPL-3.0-or-later
//! Database output contracts mirror the existing serde DTOs and tool wrappers.
//!
//! Keep UUID-keyed maps dynamic and `serde_json::Value` slots JSON-shaped.
//! Schema changes must be checked against actual tool results, not sample-based
//! inference. Only reachable definitions travel with each discovery entry.

use serde_json::{Map, Value};
use std::{collections::BTreeSet, sync::OnceLock};

fn contracts() -> &'static Value {
  static CONTRACTS: OnceLock<Value> = OnceLock::new();
  CONTRACTS.get_or_init(|| {
    serde_json::from_str(include_str!("database-contracts.json")).expect("valid Database output contracts")
  })
}

pub(super) fn output_schema(name: &str) -> Option<Value> {
  if matches!(name, "database_assistant_status" | "database_assistant_stop") {
    return Some(with_definitions(assistant_setup_output_schema(), &contracts()["$defs"]));
  }
  if matches!(name, "database_assistants_list" | "database_assistant_prepare") {
    return Some(assistant_output_schema(name));
  }
  let contracts = contracts();
  Some(with_definitions(
    match name {
      "database_create" => serde_json::json!({
        "type":"object","additionalProperties":false,"required":["database"],
        "properties":{"database":{"$ref":"#/$defs/DatabaseRecord"},"initialViewId":{"type":"string","format":"uuid"}}
      }),
      "database_get" | "database_update" | "database_trash" | "database_restore" => {
        serde_json::json!({
          "type":"object","additionalProperties":false,"required":["database"],
          "properties":{"database":{"$ref":"#/$defs/DatabaseRecord"}}
        })
      }
      "database_view_get" => serde_json::json!({"type":"object","additionalProperties":false,
        "required":["databaseId","view","effectiveSort","effectiveFilterTree","searchText","effectiveFieldWidths","canEditShared"],
        "properties":{"databaseId":{"type":"string","format":"uuid"},"view":{"$ref":"#/$defs/DatabaseView"},
          "effectiveSort":{"type":"array","items":{"$ref":"#/$defs/DatabaseSortRule"}},
          "effectiveFilterTree":{"anyOf":[{"type":"null"},{"$ref":"#/$defs/DatabaseFilterGroup"}]},
          "searchText":{"type":"string"},"effectiveFieldWidths":{"type":"object","propertyNames":{"format":"uuid"},"additionalProperties":{"type":"integer"}},"canEditShared":{"type":"boolean"}}}),
      "database_view_create" | "database_view_update" => {
        serde_json::json!({"type":"object","additionalProperties":false,"required":["databaseId","view"],"properties":{"databaseId":{"type":"string","format":"uuid"},"view":{"$ref":"#/$defs/DatabaseView"}}})
      }
      "database_view_delete" => {
        serde_json::json!({"type":"object","additionalProperties":false,"required":["databaseId","viewId","deleted"],"properties":{"databaseId":{"type":"string","format":"uuid"},"viewId":{"type":"string","format":"uuid"},"deleted":{"type":"boolean","const":true}}})
      }
      "database_view_reorder" => {
        serde_json::json!({"type":"object","additionalProperties":false,"required":["databaseId","views"],"properties":{"databaseId":{"type":"string","format":"uuid"},"views":{"type":"array","maxItems":200,"items":{"$ref":"#/$defs/DatabaseView"}}}})
      }
      "database_field_create" | "database_field_update" => {
        serde_json::json!({"type":"object","additionalProperties":false,"required":["databaseId","field"],"properties":{"databaseId":{"type":"string","format":"uuid"},"field":{"$ref":"#/$defs/DatabaseField"}}})
      }
      "database_field_delete" => {
        serde_json::json!({"type":"object","additionalProperties":false,"required":["databaseId","fieldId","deleted"],"properties":{"databaseId":{"type":"string","format":"uuid"},"fieldId":{"type":"string","format":"uuid"},"deleted":{"type":"boolean","const":true}}})
      }
      "database_field_reorder" => {
        serde_json::json!({"type":"object","additionalProperties":false,"required":["databaseId","fields"],"properties":{"databaseId":{"type":"string","format":"uuid"},"fields":{"type":"array","maxItems":200,"items":{"$ref":"#/$defs/DatabaseField"}}}})
      }
      "database_delete_permanently" => serde_json::json!({
        "type":"object","additionalProperties":false,"required":["databaseId","workspaceId","createdBy","deleted"],
        "properties":{"databaseId":{"type":"string","format":"uuid"},"workspaceId":{"type":"string","format":"uuid"},
          "createdBy":{"type":["string","null"],"format":"uuid"},"deleted":{"type":"boolean","const":true}}
      }),
      _ => contracts["tools"].get(name)?.clone(),
    },
    &contracts["$defs"],
  ))
}

/// Attach reachable local DTO definitions. Other projections reuse the already
/// described Database cell variants instead of maintaining a second definition.
pub(super) fn with_definitions(mut schema: Value, local_definitions: &Value) -> Value {
  let mut pending = BTreeSet::new();
  collect_references(&schema, &mut pending);
  let mut definitions = Map::new();
  while let Some(name) = pending.pop_first() {
    if definitions.contains_key(&name) {
      continue;
    }
    let definition = local_definitions
      .get(&name)
      .or_else(|| contracts()["$defs"].get(&name))
      .expect("declared Database DTO reference")
      .clone();
    collect_references(&definition, &mut pending);
    definitions.insert(name, definition);
  }
  if !definitions.is_empty() {
    schema["$defs"] = Value::Object(definitions);
  }
  schema
}

fn collect_references(value: &Value, names: &mut BTreeSet<String>) {
  match value {
    Value::Object(object) => {
      if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        names.insert(
          reference
            .strip_prefix("#/$defs/")
            .expect("local DTO reference")
            .to_owned(),
        );
      }
      for value in object.values() {
        collect_references(value, names);
      }
    }
    Value::Array(values) => {
      for value in values {
        collect_references(value, names);
      }
    }
    _ => {}
  }
}

/// Additive schema/lifecycle adapters keep the existing canonical DTO definition.
pub(super) fn schema_definitions() -> Vec<Value> {
  use serde_json::json;
  ["database_get", "database_create", "database_update", "database_trash", "database_restore", "database_delete_permanently"].into_iter().map(|name| {
    let mut properties = serde_json::Map::new();
    let mut required = vec![json!("database_id")];
    if name == "database_create" {
      required = vec![json!("workspace_id"), json!("title")];
      properties.insert("workspace_id".into(), json!({"type":"string","format":"uuid"}));
      properties.insert("title".into(), json!({"type":"string","minLength":1,"maxLength":512}));
      properties.insert("description".into(), json!({"type":["string","null"],"maxLength":65536}));
      properties.insert("assistant_confirmation".into(),assistant_confirmation_schema());
      properties.insert("initial_view_kind".into(), json!({"type":"string","enum":["table","kanban","list","gallery","calendar","timeline","gantt","progress"],"description":"Generic creation accepts table/kanban. A confirmed package accepts only its reviewed native View kind."}));
    } else {
      properties.insert("database_id".into(), json!({"type":"string","format":"uuid"}));
      if name == "database_update" {
        properties.insert("title".into(), json!({"type":"string","minLength":1,"maxLength":512}));
        properties.insert("description".into(), json!({"type":["string","null"],"maxLength":65536}));
      }
      if name != "database_get" {
        required.push(json!("expected_edit_revision"));
        properties.insert("expected_edit_revision".into(), json!({"type":"integer","minimum":1,"maximum":i64::MAX}));
      }
      if name == "database_delete_permanently" {
        required.extend([json!("workspace_id"),json!("confirm")]);
        properties.insert("workspace_id".into(), json!({"type":"string","format":"uuid"}));
        properties.insert("confirm".into(), json!({"type":"boolean","const":true}));
      }
    }
    if name != "database_get" {
      required.push(json!("idempotency_key"));
      properties.insert("idempotency_key".into(), json!({"type":"string","minLength":1,"maxLength":160}));
    }
    json!({"name":name,"description": match name {
      "database_get" => "Reads the complete current Database schema with fields, saved views and edit revisions. Rows remain separately paginated.",
      "database_create" => "Creates a native Generic Database with a title and Table/Kanban, or applies a reviewed admitted Project package with its selected native View.",
      "database_update" => "Updates Database title/description at the captured revision. Omission preserves description; null clears it.",
      "database_trash" => "Moves a Database to trash at the captured revision, retaining its identity, rows, views and attachments.",
      "database_restore" => "Restores a trashed Database through the existing current creator/manager policy at the captured revision.",
      _ => "Permanently deletes an already-trashed disposable Database. Requires workspace binding, explicit confirmation and its captured revision."
    },"inputSchema":{"type":"object","additionalProperties":false,"required":required,"properties":properties}})
  }).collect()
}

pub(super) fn field_definitions() -> Vec<Value> {
  use serde_json::json;
  ["database_field_create", "database_field_update", "database_field_delete", "database_field_reorder"].into_iter().map(|name| {
    let mut properties = serde_json::Map::from_iter([
      ("database_id".into(), json!({"type":"string","format":"uuid"})),
      ("idempotency_key".into(), json!({"type":"string","minLength":1,"maxLength":160})),
    ]);
    let mut required = vec!["database_id", "idempotency_key"];
    if name == "database_field_reorder" {
      required.extend(["field_ids", "expected_edit_revisions"]);
      properties.insert("field_ids".into(), json!({"type":"array","minItems":1,"maxItems":200,"uniqueItems":true,"items":{"type":"string","format":"uuid"}}));
      properties.insert("expected_edit_revisions".into(), json!({"type":"object","minProperties":1,"maxProperties":200,"propertyNames":{"format":"uuid"},"additionalProperties":{"type":"integer","minimum":1,"maximum":i64::MAX}}));
    } else {
      if name != "database_field_create" {
        required.extend(["field_id", "expected_edit_revision"]);
        properties.insert("field_id".into(), json!({"type":"string","format":"uuid"}));
        properties.insert("expected_edit_revision".into(), json!({"type":"integer","minimum":1,"maximum":i64::MAX}));
      } else {
        required.extend(["name", "field_type"]);
        properties.insert("field_type".into(), json!({"$ref":"#/$defs/DatabaseFieldType"}));
      }
      if name != "database_field_delete" {
        properties.insert("name".into(), json!({"type":"string","minLength":1,"maxLength":512}));
        properties.insert("required".into(), json!({"type":"boolean"}));
        properties.insert("config".into(), json!({"$ref":"#/$defs/DatabaseFieldConfig"}));
      }
    }
    let mut input = with_definitions(json!({"type":"object","additionalProperties":false,"required":required,"properties":properties}), &contracts()["$defs"]);
    // Input option bounds are MCP admission limits; output keeps the canonical
    // DTO contract so existing larger schemas are never silently truncated.
    if let Some(variants) = input.get_mut("$defs").and_then(|defs|defs.get_mut("DatabaseFieldConfig")).and_then(|config|config.get_mut("oneOf")).and_then(Value::as_array_mut) {
      for variant in variants {
        if let Some(options) = variant.get_mut("properties").and_then(|properties| properties.get_mut("options")) {
          options["maxItems"] = json!(200);
        }
      }
    }
    json!({"name":name,"description":"Changes fields through the canonical Database schema owner and current creator/manager policy. Config uses the complete canonical kind-tagged shape (65536-byte ceiling; at most 200 options), never field-type replacement. Update/delete require the captured field revision; reorder includes every field and revision. Unknown composed outcomes remain fenced.","inputSchema": input})
  }).collect()
}

/// Saved-view input definitions reuse the canonical typed configs and icons.
pub(super) fn view_definitions() -> Vec<Value> {
  use serde_json::json;
  ["database_view_get","database_view_create","database_view_update","database_view_delete","database_view_reorder"].into_iter().map(|name| {
    let mut properties = Map::from_iter([("database_id".into(),json!({"type":"string","format":"uuid"}))]);
    let mut required = vec!["database_id"];
    if name != "database_view_get" {
      required.push("idempotency_key");
      properties.insert("idempotency_key".into(),json!({"type":"string","minLength":1,"maxLength":160}));
    }
    if name == "database_view_reorder" {
      required.extend(["view_ids","expected_edit_revisions"]);
      properties.insert("view_ids".into(),json!({"type":"array","minItems":1,"maxItems":200,"uniqueItems":true,"items":{"type":"string","format":"uuid"}}));
      properties.insert("expected_edit_revisions".into(),json!({"type":"object","minProperties":1,"maxProperties":200,"propertyNames":{"format":"uuid"},"additionalProperties":{"type":"integer","minimum":1,"maximum":i64::MAX}}));
    } else {
      if name != "database_view_create" {
        required.push("view_id");
        properties.insert("view_id".into(),json!({"type":"string","format":"uuid"}));
        if name != "database_view_get" {
          required.push("expected_edit_revision");
          properties.insert("expected_edit_revision".into(),json!({"type":"integer","minimum":1,"maximum":i64::MAX}));
        }
      }
      if matches!(name,"database_view_create" | "database_view_update") {
        properties.insert("name".into(),json!({"type":"string","minLength":1,"maxLength":512}));
        properties.insert("view_kind".into(),json!({"$ref":"#/$defs/DatabaseViewKind"}));
        properties.insert("config".into(),json!({"$ref":"#/$defs/DatabaseViewConfig","description":"Complete canonical config from database_get; maximum serialized size 65536 bytes."}));
        properties.insert("icon".into(),json!({"anyOf":[{"type":"null"},{"$ref":"#/$defs/DatabaseViewIcon"}]}));
        if name == "database_view_create" {required.extend(["name","view_kind","config"]);}
      }
      if name == "database_view_delete" {properties.insert("replacement_view_id".into(),json!({"type":"string","format":"uuid"}));}
    }
    json!({"name":name,"description":match name {
      "database_view_get"=>"Reads the canonical saved view and the current actor's effective sort/filter/search/width projection. Never overwrites shared config or personal state.",
      "database_view_create"=>"Creates a saved view with canonical kind/config/icon through the existing schema owner.",
      "database_view_update"=>"Updates shared view name/kind/config/icon at the captured revision. Omitted icon is preserved; null clears it. Personal overrides remain unchanged.",
      "database_view_delete"=>"Deletes a disposable saved view at its captured revision, preserving rows. Required profile roles use the current compatible replacement rule.",
      _=>"Reorders every saved view exactly once with each captured revision; stale state is never forced."
    },"inputSchema":with_definitions(json!({"type":"object","additionalProperties":false,"required":required,"properties":properties}),&contracts()["$defs"])})
  }).collect()
}

fn assistant_identity_schema() -> Value {
  serde_json::json!({"type":"object","additionalProperties":false,"required":["id","version","digest"],"properties":{"id":{"type":"string","minLength":1,"maxLength":128},"version":{"type":"string","maxLength":64},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}}})
}
fn assistant_answers_schema() -> Value {
  // These are native tagged answer values, not an executable presentation blob.
  // The admitted input declaration validates every value before preparation.
  serde_json::json!({"type":"object","maxProperties":128,"additionalProperties":{"type":"object","additionalProperties":false,"required":["kind","value"],"properties":{"kind":{"type":"string","enum":["text","boolean","choice","choices","date","dateTime","members","databaseDestination","rowTemplate","row","rowSelection","folder"]},"value":{}}}})
}
fn assistant_confirmation_schema() -> Value {
  serde_json::json!({"type":"object","additionalProperties":false,"required":["request_id","identity","answers","plan_digest","locale"],"properties":{"request_id":{"type":"string","format":"uuid"},"admission_confirmation":{"type":["string","null"],"pattern":"^[a-f0-9]{64}$"},"identity":assistant_identity_schema(),"answers":assistant_answers_schema(),"plan_digest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"locale":{"type":"string"},"client_version":{"type":["integer","null"],"minimum":1,"maximum":4294967295u64}}})
}
pub(super) fn assistant_definitions() -> Vec<Value> {
  use serde_json::json;
  ["database_assistants_list","database_assistant_prepare","database_assistant_status","database_assistant_stop"].into_iter().map(|name|{
 let mut props=serde_json::Map::new();props.insert("workspace_id".into(),json!({"type":"string","format":"uuid"}));
 let mut required=vec![json!("workspace_id")];
 if name=="database_assistant_prepare" {required.extend([json!("identity"),json!("answers")]);props.insert("identity".into(),assistant_identity_schema());props.insert("answers".into(),assistant_answers_schema());props.insert("locale".into(),json!({"type":["string","null"]}));props.insert("client_version".into(),json!({"type":["integer","null"],"minimum":1,"maximum":4294967295u64}));}
 if matches!(name,"database_assistant_status"|"database_assistant_stop") {required.push(json!("request_id"));props.insert("request_id".into(),json!({"type":"string","format":"uuid"}));}
 let description=match name {
   "database_assistants_list"=>"Lists current admitted Project packages and typed inputs. Does not create content.",
   "database_assistant_prepare"=>"Prepares the canonical native Project plan without writes; confirm its identity, answers and digest through database_create.",
   "database_assistant_status"=>"Reads the current actor's accepted Project request and fixed results without resuming writes or preparing a replacement.",
   _=>"Stops the current actor's accepted Project setup through its native request. Preserves existing or edited contents; a completed result remains complete.",
 };
 json!({"name":name,"description":description,"inputSchema":{"type":"object","additionalProperties":false,"required":required,"properties":props}})
 }).collect()
}

fn assistant_setup_output_schema() -> Value {
  use serde_json::json;
  let prepared = assistant_output_schema("database_assistant_prepare")["properties"]["plan"].clone();
  let uuid = json!({"type":"string","format":"uuid"});
  let setup = json!({"type":"object","additionalProperties":false,
  "required":["requestId","status","reservedDatabaseId","acceptedPlan","currentReview","database","reasonCode","documents","folderId","placementComplete"],
  "properties":{
    "requestId":uuid,"reservedDatabaseId":uuid,
    "status":{"type":"string","enum":["ready","pending","stopRequested","stopped","reReviewRequired","unavailable"]},
    "acceptedPlan":prepared,"currentReview":{"anyOf":[{"type":"null"},prepared]},
    "database":{"anyOf":[{"type":"null"},{"$ref":"#/$defs/DatabaseRecord"}]},
    "reasonCode":{"type":["string","null"]},
    "folderId":{"type":["string","null"]},"placementComplete":{"type":"boolean"},
    "documents":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["componentId","reservedDocumentId","externalId","created","placed"],"properties":{"componentId":{"type":"string"},"reservedDocumentId":uuid,"externalId":{"type":["string","null"]},"created":{"type":"boolean"},"placed":{"type":"boolean"}}}}
  }});
  json!({"type":"object","additionalProperties":false,"required":["setup"],"properties":{"setup":{"anyOf":[{"type":"null"},setup]}}})
}
fn assistant_output_schema(name: &str) -> Value {
  use serde_json::json;
  if name == "database_assistants_list" {
    let copy = json!({"type":"object","additionalProperties":false,"required":["en","de","fr","es"],"properties":{"en":{"type":"string"},"de":{"type":"string"},"fr":{"type":"string"},"es":{"type":"string"}}});
    // Input defaults/choices retain their native tagged JSON representation.
    let answer = assistant_answers_schema()["additionalProperties"].clone();
    let input = json!({"type":"object","additionalProperties":false,"required":["id","target","label","description","valueType","required","default","choices","visibleWhen"],"properties":{"id":{"type":"string"},"target":{"type":"string"},"label":copy,"description":{"anyOf":[{"type":"null"},copy]},"valueType":{"type":"string"},"required":{"type":"boolean"},"default":{"anyOf":[{"type":"null"},answer]},"choices":{"type":"array","maxItems":256,"items":{"type":"object","additionalProperties":false,"required":["id","label","value"],"properties":{"id":{"type":"string"},"label":copy,"value":answer}}},"visibleWhen":{"type":["object","null"],"additionalProperties":false,"required":["kind","input"],"properties":{"kind":{"type":"string","enum":["present","equals"]},"input":{"type":"string"},"value":answer}}}});
    return json!({"type":"object","additionalProperties":false,"required":["packages"],"properties":{"packages":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["identity","name","description","inputs"],"properties":{"identity":assistant_identity_schema(),"name":copy,"description":copy,"inputs":{"type":"array","maxItems":128,"items":input}}}}}});
  }
  let uuid = json!({"type":"string","format":"uuid"});
  let mut fields = serde_json::Map::new();
  for key in ["workspaceId", "actorId"] {
    fields.insert(key.into(), uuid.clone());
  }
  fields.insert("package".into(), assistant_identity_schema());
  fields.insert("answers".into(), assistant_answers_schema());
  for key in [
    "componentId",
    "templateId",
    "templateVersion",
    "templateDigest",
    "title",
    "priority",
    "complexity",
    "structure",
    "defaultCurrency",
    "initialViewKey",
    "initialViewKind",
  ] {
    fields.insert(key.into(), json!({"type":"string"}));
  }
  fields.insert("description".into(), json!({"type":["string","null"]}));
  let folder = json!({"oneOf":[
    {"type":"object","additionalProperties":false,"required":["kind","id"],"properties":{"kind":{"const":"existing"},"id":{"type":"string","minLength":1}}},
    {"type":"object","additionalProperties":false,"required":["kind","name","parent"],"properties":{"kind":{"const":"new"},"name":{"type":"string","minLength":1,"maxLength":8192},"parent":{"type":["string","null"]}}}
  ]});
  fields.insert("folder".into(), json!({"anyOf":[{"type":"null"},folder]}));
  fields.insert(
    "clientVersion".into(),
    json!({"type":["integer","null"],"minimum":1,"maximum":4294967295u64}),
  );
  let pin = json!({"type":"object","additionalProperties":false,"required":["id","version","sha256"],"properties":{"id":{"type":"string"},"version":{"type":"string"},"sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"}}});
  let document_source = json!({"type":"object","additionalProperties":false,"required":["componentId","templateId","version","digest","bundle"],"properties":{"componentId":{"type":"string"},"templateId":{"type":"string"},"version":{"type":"string"},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"bundle":pin}});
  fields.insert("documents".into(), json!({"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["source","sourceRevisionId","sourceContentDigest","sourceRevisionDigest","locale","title","variables","folder"],"properties":{"source":document_source,"sourceRevisionId":uuid,"sourceContentDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"sourceRevisionDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"locale":{"type":"string"},"title":{"type":"string"},"variables":{"type":"object","maxProperties":6,"additionalProperties":{"type":"string","maxLength":8192},"propertyNames":{"enum":["project.title","project.goal","project.scope","project.start_date","project.end_date","project.people"]}},"folder":folder}}}));
  fields.insert("includeSampleRows".into(), json!({"type":"boolean"}));
  fields.insert("locale".into(), json!({"type":"string","enum":["en","de","fr","es"]}));
  fields.insert("executionAvailable".into(), json!({"type":"boolean"}));
  let copy = json!({"type":"object","additionalProperties":false,"required":["en","de","fr","es"],"properties":{"en":{"type":"string"},"de":{"type":"string"},"fr":{"type":"string"},"es":{"type":"string"}}});
  let date = json!({"anyOf":[{"type":"null"},{"type":"object","additionalProperties":false,"required":["start","end"],"properties":{"start":{"type":"string","format":"date"},"end":{"type":["string","null"],"format":"date"}}}]});
  fields.insert("setup".into(),json!({"type":"object","additionalProperties":false,"required":["goal","scope","startDate","endDate","people","scaffold"],"properties":{
    "goal":{"type":["string","null"],"maxLength":65536},"scope":{"type":["string","null"],"maxLength":65536},
    "startDate":date,"endDate":date,
    "people":{"type":"array","maxItems":128,"uniqueItems":true,"items":uuid},
    "scaffold":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["id","kind","title"],"properties":{"id":{"type":"string","minLength":1,"maxLength":128},"kind":{"type":"string","enum":["phase","milestone"]},"title":copy}}}
  }}));
  let count = json!({"type":"integer","minimum":0});
  fields.insert("counts".into(),json!({"type":"object","additionalProperties":false,"required":["phases","milestones","sampleRows","explicitTasks"],"properties":{"phases":count,"milestones":count,"sampleRows":count,"explicitTasks":count}}));
  let required = fields.keys().cloned().collect::<Vec<_>>();
  json!({"type":"object","additionalProperties":false,"required":["plan","planDigest"],"properties":{"planDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"plan":{"type":"object","additionalProperties":false,"required":required,"properties":fields}}})
}
