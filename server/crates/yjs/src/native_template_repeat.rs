// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native repeat units within the existing template instantiation transaction.
//! No member lookup or persistence belongs here. The caller owns authorization
//! and supplies records; all mutations affect only the captured, local snapshot.

use super::*;
use yrs::{MapRef, TextRef, TransactionMut};

const SOURCE: &str = "workspace.members";
const INVALID: &str = "invalid native template repeat collection or binding";
type Handled = HashSet<(String, String)>;
type Chunks = Vec<(String, Attrs)>;
type RepeatTextUnit = (Vec<(String, Chunks)>, BTreeSet<String>);

struct Unit {
  block_id: String,
  block: MapRef,
  row: Option<String>,
  texts: Vec<(String, Chunks)>,
  fields: BTreeSet<String>,
}

/// Active flat table rows in the same order used for repeat/header boundaries.
pub(crate) fn ordered_native_table_rows(block: &MapRef, txn: &impl ReadTxn) -> Vec<(String, String)> {
  let mut rows = block
    .iter(txn)
    .filter_map(|(key, value)| {
      let id = key.strip_prefix("prop:rows.")?.strip_suffix(".order")?;
      let yrs::Out::Any(Any::String(order)) = value else {
        return None;
      };
      Some((order.to_string(), id.to_string()))
    })
    .collect::<Vec<_>>();
  rows.sort();
  rows
}

/// The editor stores counts as JS numbers, including integral Yjs Number values.
/// Keep the existing integer representation readable without treating 2.0 as absent.
pub(crate) fn native_table_header_rows(block: &MapRef, txn: &impl ReadTxn) -> Option<usize> {
  match block.get(txn, "prop:headerRows")? {
    yrs::Out::Any(Any::Number(value)) => value.as_f64().and_then(|value| {
      (value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= usize::MAX as f64)
        .then_some(value as usize)
    }),
    yrs::Out::Any(Any::BigInt(value)) => usize::try_from(value).ok(),
    _ => None,
  }
}

fn chunks<T: ReadTxn>(text: &TextRef, txn: &T) -> Result<Chunks, String> {
  text
    .diff(txn, YChange::identity)
    .into_iter()
    .map(|chunk| {
      let yrs::Out::Any(Any::String(value)) = chunk.insert else {
        return Err(INVALID.into());
      };
      Ok((
        value.to_string(),
        chunk.attributes.map(|attrs| *attrs).unwrap_or_default(),
      ))
    })
    .collect()
}

fn binding(value: serde_json::Value) -> Result<(), String> {
  if value.get("source").and_then(|v| v.as_str()) != Some(SOURCE)
    || value.get("alias").and_then(|v| v.as_str()) != Some("member")
  {
    return Err(INVALID.into());
  }
  Ok(())
}

fn fields(
  texts: &[(String, Chunks)],
  variables: &HashMap<String, NativeTemplateVariable>,
  unresolved: &mut BTreeSet<String>,
) -> Result<BTreeSet<String>, String> {
  let mut names = BTreeSet::new();
  for (_, text) in texts {
    rewrite_native_template_chunks(text, "myoxus:paragraph", &HashMap::new(), &mut names, true)?;
  }
  let fields = names
    .iter()
    .filter_map(|name| name.strip_prefix("member.").map(str::to_owned))
    .collect::<BTreeSet<_>>();
  if fields.is_empty() {
    return Err(INVALID.into());
  }
  unresolved.extend(
    names
      .into_iter()
      .filter(|name| !name.starts_with("member.") && !variables.contains_key(name)),
  );
  Ok(fields)
}

fn records(variables: &HashMap<String, NativeTemplateVariable>) -> Result<Option<&[HashMap<String, String>]>, String> {
  let Some(value) = variables.get(SOURCE) else {
    return Ok(None);
  };
  let NativeTemplateVariable::Records(records) = value else {
    return Err(INVALID.into());
  };
  if records.is_empty() || records.len() > 500 {
    return Err(INVALID.into());
  }
  for record in records {
    if record.len() > 100 {
      return Err(INVALID.into());
    }
    for (key, value) in record {
      if key.len() > 128
        || value.len() > 8 * 1024
        || !key.split('.').all(|part| {
          let mut chars = part.chars();
          chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        })
      {
        return Err(INVALID.into());
      }
    }
  }
  Ok(Some(records))
}

fn write(text: &TextRef, txn: &mut TransactionMut<'_>, chunks: Chunks) {
  let len = text.len(txn);
  if len > 0 {
    text.remove_range(txn, 0, len);
  }
  for (value, attrs) in chunks {
    if !value.is_empty() {
      let offset = text.len(txn);
      text.insert_with_attributes(txn, offset, &value, attrs);
    }
  }
}

/// Decode an authored repeat unit without instantiation or member lookup. The
/// copy command uses exactly the existing template validity rules.
fn repeat_text_unit(
  block: &MapRef,
  txn: &impl ReadTxn,
  flavour: &str,
  has_children: bool,
  variables: &HashMap<String, NativeTemplateVariable>,
  unresolved: &mut BTreeSet<String>,
) -> Result<Option<RepeatTextUnit>, String> {
  let Some(value) = block
    .get(txn, "prop:repeat")
    .filter(|v| !matches!(v, yrs::Out::Any(Any::Undefined)))
  else {
    return Ok(None);
  };
  binding(yjs_out_to_json(value, txn))?;
  if !matches!(flavour, "myoxus:paragraph" | "myoxus:list") || has_children {
    return Err(INVALID.into());
  }
  let Some(yrs::Out::YText(text)) = block.get(txn, "prop:text").or_else(|| block.get(txn, "text")) else {
    return Err(INVALID.into());
  };
  let texts = vec![("prop:text".into(), chunks(&text, txn)?)];
  let fields = fields(&texts, variables, unresolved)?;
  Ok(Some((texts, fields)))
}

pub(crate) fn validate_copied_repeat(
  block: &MapRef,
  txn: &impl ReadTxn,
  flavour: &str,
  has_children: bool,
) -> Result<(), String> {
  repeat_text_unit(block, txn, flavour, has_children, &HashMap::new(), &mut BTreeSet::new()).map(|_| ())
}

fn collect(
  doc: &Doc,
  blocks: &MapRef,
  variables: &HashMap<String, NativeTemplateVariable>,
  unresolved: &mut BTreeSet<String>,
) -> (
  Vec<Unit>,
  HashMap<String, Vec<yrs::ArrayRef>>,
  HashMap<String, (MapRef, Vec<String>)>,
  Vec<NativeTemplateDiagnostic>,
) {
  let mut diagnostics = Vec::new();
  let mut units = Vec::new();
  let mut parents = HashMap::<String, Vec<yrs::ArrayRef>>::new();
  let mut tables = HashMap::<String, (MapRef, Vec<String>)>::new();
  {
    let txn = doc.transact();
    for (block_id, value) in blocks.iter(&txn) {
      let yrs::Out::YMap(block) = value else {
        continue;
      };
      let checked = (|| -> Result<(), String> {
        let children = match block.get(&txn, "sys:children") {
          Some(yrs::Out::YArray(children)) => Some(children),
          _ => None,
        };
        if let Some(children) = &children {
          for value in children.iter(&txn) {
            if let yrs::Out::Any(Any::String(id)) = value {
              parents.entry(id.to_string()).or_default().push(children.clone());
            }
          }
        }
        let flavour = block_string(&block, &txn, "flavour")
          .map(|value| resolve_flavour(&value).to_owned())
          .unwrap_or_default();
        if let Some((texts, fields)) = repeat_text_unit(
          &block,
          &txn,
          &flavour,
          children.as_ref().is_some_and(|children| children.len(&txn) > 0),
          variables,
          unresolved,
        )? {
          units.push(Unit {
            block_id: block_id.to_string(),
            block: block.clone(),
            row: None,
            texts,
            fields,
          });
        }
        // Table metadata is flattened by the active native FlatSyncController.
        // Read its actual row/cell keys, never infer rows from rendered Markdown.
        let entries = block
          .iter(&txn)
          .map(|(key, value)| (key.to_string(), value))
          .collect::<HashMap<_, _>>();
        let repeat_rows = entries
          .keys()
          .filter_map(|key| {
            key
              .strip_prefix("prop:rows.")
              .and_then(|key| key.split_once(".repeat").map(|(id, _)| id.to_string()))
          })
          .collect::<BTreeSet<_>>();
        if !matches!(
          flavour.as_str(),
          "myoxus:paragraph" | "myoxus:list" | "myoxus:page" | "myoxus:table"
        ) {
          if let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") {
            // Unsupported text units cannot hide scoped expressions merely
            // because ordinary substitution intentionally leaves them alone.
            rewrite_native_template_chunks(
              &chunks(&text, &txn)?,
              &flavour,
              &HashMap::new(),
              &mut BTreeSet::new(),
              false,
            )?;
          }
        }
        if repeat_rows.is_empty() {
          return Ok(());
        }
        if flavour != "myoxus:table" || children.as_ref().is_some_and(|children| children.len(&txn) > 0) {
          return Err(INVALID.into());
        }
        let columns = entries
          .keys()
          .filter_map(|key| {
            key
              .strip_prefix("prop:columns.")?
              .strip_suffix(".columnId")
              .map(str::to_owned)
          })
          .collect::<BTreeSet<_>>();
        if columns.is_empty() {
          return Err(INVALID.into());
        }
        for column in &columns {
          if entries
            .get(&format!("prop:columns.{column}.columnId"))
            .is_none_or(|value| !matches!(value, yrs::Out::Any(Any::String(id)) if id.as_ref() == column))
          {
            return Err(INVALID.into());
          }
        }
        let rows = ordered_native_table_rows(&block, &txn);
        tables.insert(
          block_id.to_string(),
          (block.clone(), rows.iter().map(|(_, id)| id.clone()).collect()),
        );
        let header_rows = native_table_header_rows(&block, &txn).unwrap_or(0);
        for row in repeat_rows {
          let checked_row = (|| -> Result<(), String> {
            let prefix = format!("prop:rows.{row}.");
            let value = |key: &str| {
              entries
                .get(&format!("{prefix}{key}"))
                .cloned()
                .map(|value| yjs_out_to_json(value, &txn))
                .unwrap_or_default()
            };
            binding(serde_json::json!({ "source": value("repeat.source"), "alias": value("repeat.alias") }))?;
            if rows
              .iter()
              .position(|(_, id)| id == &row)
              .is_some_and(|index| index < header_rows)
              || value("rowId").as_str() != Some(row.as_str())
              || !rows.iter().any(|(order, id)| id == &row && !order.is_empty())
            {
              return Err(INVALID.into());
            }
            let mut texts = Vec::new();
            for column in &columns {
              let key = format!("prop:cells.{row}:{column}.text");
              let Some(yrs::Out::YText(text)) = entries.get(&key) else {
                return Err(INVALID.into());
              };
              texts.push((key, chunks(text, &txn)?));
            }
            let fields = fields(&texts, variables, unresolved)?;
            units.push(Unit {
              block_id: block_id.to_string(),
              block: block.clone(),
              row: Some(row.clone()),
              texts,
              fields,
            });
            Ok(())
          })();
          if checked_row.is_err() {
            diagnostics.push(NativeTemplateDiagnostic {
              block_id: block_id.to_string(),
              kind: "cell".into(),
              row_id: Some(row),
              column_id: columns.first().cloned(),
              start: 0,
              length: 0,
              reason: "repeat-invalid".into(),
              name: None,
            });
          }
        }
        Ok(())
      })();
      if checked.is_err() {
        diagnostics.push(NativeTemplateDiagnostic {
          block_id: block_id.to_string(),
          kind: "text".into(),
          row_id: None,
          column_id: None,
          start: 0,
          length: 0,
          reason: "repeat-invalid".into(),
          name: None,
        });
      }
    }
  }
  for unit in &units {
    if parents.get(&unit.block_id).is_none_or(|parents| parents.len() != 1) {
      diagnostics.push(NativeTemplateDiagnostic {
        block_id: unit.block_id.clone(),
        kind: if unit.row.is_some() { "cell" } else { "text" }.into(),
        row_id: unit.row.clone(),
        column_id: None,
        start: 0,
        length: 0,
        reason: "repeat-invalid".into(),
        name: None,
      });
    }
  }
  (units, parents, tables, diagnostics)
}

/// Shares the application's repeat preflight, without expanding any prototype.
pub(super) fn inspect(
  doc: &Doc,
  blocks: &MapRef,
  unresolved: &mut BTreeSet<String>,
) -> (Handled, Vec<NativeTemplateDiagnostic>) {
  let (units, _, _, diagnostics) = collect(doc, blocks, &HashMap::new(), unresolved);
  let mut handled = Handled::new();
  if !units.is_empty() {
    unresolved.insert(SOURCE.into());
  }
  for unit in units {
    for (key, _) in unit.texts {
      handled.insert((unit.block_id.clone(), key));
    }
  }
  (handled, diagnostics)
}

pub(super) fn expand(
  doc: &Doc,
  blocks: &MapRef,
  variables: &HashMap<String, NativeTemplateVariable>,
  unresolved: &mut BTreeSet<String>,
) -> Result<Handled, String> {
  let (units, parents, mut tables, diagnostics) = collect(doc, blocks, variables, unresolved);
  if !diagnostics.is_empty() {
    return Err(INVALID.into());
  }
  // Preflight every prototype before any expansion. Missing records mean
  // introspection; explicitly supplied empty/string arrays fail validation.
  let records = if units.is_empty() { None } else { records(variables)? };
  for unit in &units {
    if parents.get(&unit.block_id).is_none_or(|parents| parents.len() != 1) {
      return Err(INVALID.into());
    }
    if let Some(records) = records {
      for record in records {
        if unit
          .fields
          .iter()
          .any(|field| record.get(field).is_none_or(|value| value.trim().is_empty()))
        {
          return Err(INVALID.into());
        }
      }
    }
  }
  let mut handled = Handled::new();
  if records.is_none() {
    if !units.is_empty() {
      unresolved.insert(SOURCE.to_string());
    }
    for unit in units {
      for (key, _) in unit.texts {
        handled.insert((unit.block_id.clone(), key));
      }
    }
    return Ok(handled);
  }
  let mut txn = doc.transact_mut();
  for unit in units {
    let mut new_rows = Vec::new();
    for record in records.unwrap_or_default() {
      let mut field_ids = HashMap::new();
      // Do not clone the entire member collection once per member. Only
      // ordinary substitution values participate in this unit's scope.
      let mut scoped = variables
        .iter()
        .filter(|(_, value)| !matches!(value, NativeTemplateVariable::Records(_)))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<HashMap<_, _>>();
      scoped.extend(
        record
          .iter()
          .map(|(key, value)| (format!("member.{key}"), NativeTemplateVariable::String(value.clone()))),
      );
      let id = Uuid::new_v4().to_string();
      let target = if let Some(row) = &unit.row {
        let row_prefix = format!("prop:rows.{row}.");
        let cell_prefix = format!("prop:cells.{row}:");
        let entries = unit
          .block
          .iter(&txn)
          .filter(|(key, _)| {
            (key.starts_with(&row_prefix) && !key.starts_with(&format!("{row_prefix}repeat")))
              || key.starts_with(&cell_prefix)
          })
          .map(|(key, value)| (key.to_string(), value.as_prelim(&txn)))
          .collect::<Vec<_>>();
        for (key, value) in entries {
          let new_key = if let Some(suffix) = key.strip_prefix(&row_prefix) {
            format!("prop:rows.{id}.{suffix}")
          } else {
            format!("prop:cells.{id}:{}", key.strip_prefix(&cell_prefix).ok_or(INVALID)?)
          };
          unit.block.insert(&mut txn, new_key, value);
        }
        unit
          .block
          .insert(&mut txn, format!("prop:rows.{id}.rowId"), id.as_str());
        new_rows.push(id.clone());
        unit.block.clone()
      } else {
        let parent = &parents.get(&unit.block_id).ok_or(INVALID)?[0];
        let position = parent
          .iter(&txn)
          .position(|value| matches!(value, yrs::Out::Any(Any::String(value)) if value.as_ref() == unit.block_id))
          .ok_or(INVALID)? as u32;
        let prelim = unit.block.as_prelim(&txn);
        let target = blocks.insert(&mut txn, id.as_str(), prelim);
        target.insert(&mut txn, "sys:id", id.as_str());
        target.remove(&mut txn, "prop:repeat");
        parent.insert(&mut txn, position, id.as_str());
        target
      };
      for (key, chunks) in &unit.texts {
        let property = if let Some(row) = &unit.row {
          key.replacen(&format!("prop:cells.{row}:"), &format!("prop:cells.{id}:"), 1)
        } else {
          key.clone()
        };
        let Some(yrs::Out::YText(text)) = target
          .get(&txn, &property)
          .or_else(|| (property == "prop:text").then(|| target.get(&txn, "text")).flatten())
        else {
          return Err(INVALID.into());
        };
        // Global and scoped substitution happen together exactly once. Data
        // containing braces must never become another template expression.
        write(
          &text,
          &mut txn,
          crate::document_field::content::remap_chunks(
            &rewrite_native_template_chunks(chunks, "myoxus:paragraph", &scoped, unresolved, true)?,
            &mut field_ids,
          )
          .map_err(str::to_owned)?,
        );
        handled.insert((
          if unit.row.is_some() {
            unit.block_id.clone()
          } else {
            id.clone()
          },
          property,
        ));
      }
    }
    if let Some(row) = unit.row {
      let keys = unit
        .block
        .keys(&txn)
        .filter(|key| key.starts_with(&format!("prop:rows.{row}.")) || key.starts_with(&format!("prop:cells.{row}:")))
        .map(str::to_owned)
        .collect::<Vec<_>>();
      for key in keys {
        unit.block.remove(&mut txn, &key);
      }
      let (_, rows) = tables.get_mut(&unit.block_id).ok_or(INVALID)?;
      let index = rows.iter().position(|id| id == &row).ok_or(INVALID)?;
      rows.splice(index..=index, new_rows);
    } else {
      let parent = &parents.get(&unit.block_id).ok_or(INVALID)?[0];
      let position = parent
        .iter(&txn)
        .position(|value| matches!(value, yrs::Out::Any(Any::String(value)) if value.as_ref() == unit.block_id))
        .ok_or(INVALID)? as u32;
      parent.remove(&mut txn, position);
      blocks.remove(&mut txn, &unit.block_id);
    }
  }
  for (_, (table, rows)) in tables {
    // Preserve the complete relative order, including unbound rows. These
    // fractional keys also support native insertions after MCP decimal orders.
    for (index, row) in rows.into_iter().enumerate() {
      table.insert(&mut txn, format!("prop:rows.{row}.order"), format!("a0{index:010}1"));
    }
  }
  Ok(handled)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn source() -> Vec<PortableSnapshotBlock> {
    let repeat = json!({"source": SOURCE, "alias": "member"});
    let text =
      |value: &str| json!({"$virgultum:internal:text$": true, "delta": [{"insert":value,"attributes":{"bold":true}}]});
    serde_json::from_value(json!([
      {"id":"page", "flavour":"myoxus:page", "children":["note"], "props":{"title":"Meeting {{title}}"}},
      {"id":"note", "flavour":"myoxus:note", "children":["todo","bullet","table"]},
      {"id":"todo", "flavour":"myoxus:list", "props":{"type":"todo","checked":false,"repeat":repeat,"text":text("{{member.name}} · {{member.email}}")}},
      {"id":"bullet", "flavour":"myoxus:list", "props":{"type":"bulleted","repeat":repeat,"text":text("{{member.email}}")}},
      {"id":"table", "flavour":"myoxus:table", "props":{
        "columns":{"name":{"columnId":"name","order":"a0","width":240},"email":{"columnId":"email","order":"a1"}},
        "rows":{"header":{"rowId":"header","order":"a0"},"r":{"rowId":"r","order":"a1","repeat":repeat}},
        "cells":{"header:name":{"text":text("Name")},"header:email":{"text":text("Email")},"r:name":{"text":text("{{member.name}}"),"backgroundColor":"--myoxus-sem-status-error-paper"},"r:email":{"text":text("{{member.email}}")}}
      }}
    ])).expect("native portable repeat snapshot")
  }

  fn variables() -> HashMap<String, NativeTemplateVariable> {
    HashMap::from([
      ("title".into(), NativeTemplateVariable::String("Agenda".into())),
      (
        SOURCE.into(),
        NativeTemplateVariable::Records(vec![
          HashMap::from([
            ("name".into(), "Ada {{literal}}".into()),
            ("email".into(), "ada@example.test".into()),
          ]),
          HashMap::from([
            ("name".into(), "Bea".into()),
            ("email".into(), "bea@example.test".into()),
          ]),
        ]),
      ),
    ])
  }

  #[test]
  fn native_snapshot_import_repeat_expansion_preserves_order_pairing_marks_and_identities() {
    let mut source = source();
    source[2].props.insert("textProtection".into(), json!("source"));
    source[4].props["cells"]["r:name"]["textProtection"] = json!("source");
    let field = |id: &str| {
      json!({"insert":" ", "attributes":{"bold":true, "documentField":{
        "type":"input", "id":id, "definition":{"kind":"text", "label":"Independent answer", "required":false,
        "default":"Initial {{literal}}"}, "value":"Source preview answer"
      }}})
    };
    source[2].props["text"]["delta"]
      .as_array_mut()
      .unwrap()
      .push(field("todo-field"));
    source[4].props["cells"]["r:name"]["text"]["delta"]
      .as_array_mut()
      .unwrap()
      .push(field("cell-field"));
    let snapshot = snapshot_blocks_to_yjs(&source).expect("import same native snapshot as registry");
    let before = snapshot.clone();
    assert_eq!(
      instantiate_native_template(&snapshot, &HashMap::new())
        .expect("introspection")
        .unresolved_variables,
      vec!["title", SOURCE]
    );
    let result = instantiate_native_template(&snapshot, &variables()).expect("instantiate records");
    assert!(result.unresolved_variables.is_empty());
    assert_eq!(snapshot, before);
    let fields = crate::document_field::content::inspect(&result.snapshot).unwrap();
    assert_eq!(fields.len(), 4);
    assert_eq!(
      fields
        .iter()
        .map(|field| field.run.descriptor.id())
        .collect::<HashSet<_>>()
        .len(),
      4
    );
    for field in &fields {
      let crate::document_field::DocumentField::Input { id, value, .. } = &field.run.descriptor else {
        panic!("input")
      };
      assert!(!["todo-field", "cell-field"].contains(&id.as_str()));
      assert_eq!(
        value,
        &crate::document_field::InputValue::Scalar(Some("Initial {{literal}}".into()))
      );
    }
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&result.snapshot).expect("decode"))
      .expect("load target");
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    let map = |id: &str| match blocks.get(&txn, id) {
      Some(yrs::Out::YMap(map)) => map,
      _ => panic!("native block missing"),
    };
    let note = map("note");
    let Some(yrs::Out::YArray(children)) = note.get(&txn, "sys:children") else {
      panic!("native children")
    };
    let ids = children
      .iter(&txn)
      .map(|value| value.to_string(&txn))
      .collect::<Vec<_>>();
    assert_eq!(ids.len(), 5);
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 5);
    assert!(blocks.get(&txn, "todo").is_none());
    assert!(blocks.get(&txn, "bullet").is_none());
    let expected = [
      "Ada {{literal}} · ada@example.test",
      "Bea · bea@example.test",
      "ada@example.test",
      "bea@example.test",
    ];
    for (index, value) in expected.iter().enumerate() {
      let block = map(&ids[index]);
      assert!(block.get(&txn, "prop:repeat").is_none());
      assert_eq!(block.get(&txn, "sys:id").unwrap().to_string(&txn), ids[index]);
      assert_eq!(
        block.get(&txn, "prop:type").unwrap().to_string(&txn),
        if index < 2 { "todo" } else { "bulleted" }
      );
      if index < 2 {
        assert_eq!(
          block.get(&txn, "prop:textProtection"),
          Some(yrs::Out::Any(Any::from("fixed")))
        );
        assert!(matches!(
          block.get(&txn, "prop:checked"),
          Some(yrs::Out::Any(Any::Bool(false)))
        ));
      }
      let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
        panic!("native text")
      };
      assert_eq!(
        text.get_string(&txn),
        format!("{value}{}", if index < 2 { " " } else { "" })
      );
      assert!(text.diff(&txn, YChange::identity).iter().all(|chunk| {
        chunk
          .attributes
          .as_ref()
          .is_some_and(|attrs| attrs.get("bold") == Some(&Any::Bool(true)))
      }));
    }
    let table = map("table");
    let mut rows = table
      .iter(&txn)
      .filter_map(|(key, value)| {
        key
          .strip_prefix("prop:rows.")
          .and_then(|key| key.strip_suffix(".order"))
          .map(|row| (value.to_string(&txn), row.to_string()))
      })
      .collect::<Vec<_>>();
    rows.sort();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].1, "header");
    assert_eq!(
      table.get(&txn, "prop:columns.name.width").unwrap().to_string(&txn),
      "240"
    );
    assert!(
      !table
        .keys(&txn)
        .any(|key| key.contains(".repeat") || key.starts_with("prop:cells.r:") || key.starts_with("prop:rows.r."))
    );
    for (index, pair) in [
      ["Name", "Email"],
      ["Ada {{literal}}", "ada@example.test"],
      ["Bea", "bea@example.test"],
    ]
    .iter()
    .enumerate()
    {
      let row = &rows[index].1;
      assert_eq!(
        table.get(&txn, &format!("prop:cells.{row}:name.backgroundColor")),
        (index > 0).then(|| yrs::Out::Any(Any::from("--myoxus-sem-status-error-paper")))
      );
      assert_eq!(
        table.get(&txn, &format!("prop:cells.{row}:name.textProtection")),
        (index > 0).then(|| yrs::Out::Any(Any::from("fixed")))
      );
      assert_eq!(
        table
          .get(&txn, &format!("prop:rows.{row}.rowId"))
          .unwrap()
          .to_string(&txn),
        *row
      );
      for (column, value) in ["name", "email"].iter().zip(pair) {
        let Some(yrs::Out::YText(text)) = table.get(&txn, &format!("prop:cells.{row}:{column}.text")) else {
          panic!("native paired cell")
        };
        assert_eq!(
          text.get_string(&txn),
          format!("{value}{}", if index > 0 && *column == "name" { " " } else { "" })
        );
        assert_eq!(
          text.diff(&txn, YChange::identity)[0]
            .attributes
            .as_ref()
            .unwrap()
            .get("bold"),
          Some(&Any::Bool(true))
        );
      }
    }
  }

  #[test]
  fn repeat_preflight_rejects_invalid_scopes_structure_and_collections_without_changing_source() {
    for case in [
      "source",
      "alias",
      "unbound",
      "child",
      "unsupported",
      "orphan",
      "field",
      "cell",
      "empty",
      "legacy-empty",
      "missing",
      "limit",
      "field-limit",
      "value-limit",
      "key",
    ] {
      let mut blocks = source();
      let mut vars = variables();
      match case {
        "source" => blocks[2].props["repeat"]["source"] = json!("unknown"),
        "alias" => blocks[2].props["repeat"]["alias"] = json!("other"),
        "unbound" => {
          blocks[2].props.remove("repeat");
        }
        "child" => blocks[2].children.push("bullet".into()),
        "unsupported" => blocks[2].flavour = "myoxus:code".into(),
        "orphan" => blocks[1].children.retain(|id| id != "todo"),
        "field" => blocks[2].props["text"] = json!("{{member.unknown}}"),
        "cell" => {
          blocks[4].props["cells"].as_object_mut().unwrap().remove("r:name");
        }
        "legacy-empty" => {
          vars.insert(SOURCE.into(), NativeTemplateVariable::StringList(vec![]));
        }
        other => {
          let NativeTemplateVariable::Records(records) = vars.get_mut(SOURCE).unwrap() else {
            unreachable!()
          };
          match other {
            "empty" => records.clear(),
            "missing" => {
              records[0].remove("name");
            }
            "limit" => *records = vec![records[0].clone(); 501],
            "field-limit" => records[0].extend((0..101).map(|i| (format!("field{i}"), "x".into()))),
            "value-limit" => {
              records[0].insert("name".into(), "x".repeat(8193));
            }
            "key" => {
              records[0].insert("bad..key".into(), "x".into());
            }
            _ => unreachable!(),
          }
        }
      }
      let snapshot = snapshot_blocks_to_yjs(&blocks).expect("encode invalid repeat fixture");
      let before = snapshot.clone();
      assert!(instantiate_native_template(&snapshot, &vars).is_err(), "case {case}");
      assert_eq!(snapshot, before, "case {case}");
    }
  }
}
