// SPDX-License-Identifier: AGPL-3.0-or-later
//! Incremental native flat-table edits. Builders and import defaults stay separate.

use super::*;
use yrs::types::AsPrelim;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTableAxis {
  Row,
  Column,
}

impl DocumentTableAxis {
  fn collection(self) -> &'static str {
    match self {
      Self::Row => "rows",
      Self::Column => "columns",
    }
  }
  fn identity(self) -> &'static str {
    match self {
      Self::Row => "rowId",
      Self::Column => "columnId",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum DocumentTableAxisChange {
  Insert { after_id: Option<String> },
  Delete { id: String },
  Move { id: String, after_id: Option<String> },
  Duplicate { id: String },
  Clear { id: String },
}

impl DocumentTableAxisChange {
  pub(super) const fn name(&self, axis: DocumentTableAxis) -> &'static str {
    match (axis, self) {
      (DocumentTableAxis::Row, Self::Insert { .. }) => "insert_table_row",
      (DocumentTableAxis::Row, Self::Delete { .. }) => "delete_table_row",
      (DocumentTableAxis::Row, Self::Move { .. }) => "move_table_row",
      (DocumentTableAxis::Row, Self::Duplicate { .. }) => "duplicate_table_row",
      (DocumentTableAxis::Row, Self::Clear { .. }) => "clear_table_row",
      (DocumentTableAxis::Column, Self::Insert { .. }) => "insert_table_column",
      (DocumentTableAxis::Column, Self::Delete { .. }) => "delete_table_column",
      (DocumentTableAxis::Column, Self::Move { .. }) => "move_table_column",
      (DocumentTableAxis::Column, Self::Duplicate { .. }) => "duplicate_table_column",
      (DocumentTableAxis::Column, Self::Clear { .. }) => "clear_table_column",
    }
  }
}

#[derive(Clone)]
struct Coordinate {
  id: String,
  order: String,
}

fn invalid() -> DocumentMutationError {
  DocumentMutationError::InvalidBlockProperties
}

fn flat_table(blocks: &yrs::MapRef, txn: &impl ReadTxn, id: &str) -> Result<yrs::MapRef, DocumentMutationError> {
  let block = structure::native_block(blocks, txn, id)?;
  if structure::flavour(&block, txn) != "myoxus:table"
    || !matches!(block.get(txn, "sys:children").or_else(|| block.get(txn, "children")), Some(yrs::Out::YArray(children)) if children.len(txn) == 0)
  {
    return Err(invalid());
  }
  Ok(block)
}

fn coordinate_id(id: &str) -> bool {
  !id.is_empty() && !id.contains(['.', ':'])
}

fn coordinates(
  block: &yrs::MapRef,
  txn: &impl ReadTxn,
  axis: DocumentTableAxis,
) -> Result<Vec<Coordinate>, DocumentMutationError> {
  let prefix = format!("prop:{}.", axis.collection());
  let mut ids = HashSet::new();
  for (key, _) in block.iter(txn) {
    if let Some(rest) = key.strip_prefix(&prefix) {
      let (id, _) = rest.split_once('.').ok_or_else(invalid)?;
      if !coordinate_id(id) {
        return Err(invalid());
      }
      ids.insert(id.to_string());
    }
  }
  let mut values = ids.into_iter().map(|id| {
    if !matches!(block.get(txn, &format!("{prefix}{id}.{}", axis.identity())), Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == id) {
      return Err(invalid());
    }
    let Some(yrs::Out::Any(Any::String(order))) = block.get(txn, &format!("{prefix}{id}.order")) else { return Err(invalid()); };
    if !decimal(&order) && !crate::order_key::is_valid_order_key(&order) { return Err(invalid()); }
    Ok(Coordinate { id, order: order.to_string() })
  }).collect::<Result<Vec<_>, _>>()?;
  values.sort_by(|a, b| (&a.order, &a.id).cmp(&(&b.order, &b.id)));
  Ok(values)
}

fn decimal(order: &str) -> bool {
  order.len() == 8 && order.bytes().all(|byte| byte.is_ascii_digit())
}

fn cell_coordinate(key: &str) -> Option<(&str, &str)> {
  let coordinate = key.strip_prefix("prop:cells.")?.split_once('.')?.0;
  let (row, column) = coordinate.split_once(':')?;
  (coordinate_id(row) && coordinate_id(column)).then_some((row, column))
}

fn validate_cells(
  block: &yrs::MapRef,
  txn: &impl ReadTxn,
  rows: &[Coordinate],
  columns: &[Coordinate],
) -> Result<(), DocumentMutationError> {
  let row_ids: HashSet<_> = rows.iter().map(|c| c.id.as_str()).collect();
  let column_ids: HashSet<_> = columns.iter().map(|c| c.id.as_str()).collect();
  for (key, _) in block.iter(txn).filter(|(key, _)| key.starts_with("prop:cells.")) {
    let (row, column) = cell_coordinate(key).ok_or_else(invalid)?;
    if !row_ids.contains(row) || !column_ids.contains(column) {
      return Err(invalid());
    }
  }
  for row in rows {
    for column in columns {
      if !matches!(
        block.get(txn, &format!("prop:cells.{}:{}.text", row.id, column.id)),
        Some(yrs::Out::YText(_))
      ) {
        return Err(invalid());
      }
    }
  }
  Ok(())
}

fn header_rows(block: &yrs::MapRef, txn: &impl ReadTxn, rows: usize) -> Result<Option<usize>, DocumentMutationError> {
  match block.get(txn, "prop:headerRows") {
    None | Some(yrs::Out::Any(Any::Undefined)) => Ok(None),
    Some(_) => crate::native_template_repeat::native_table_header_rows(block, txn)
      .filter(|count| *count <= rows)
      .map(Some)
      .ok_or_else(invalid),
  }
}

fn next_order(
  block: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  axis: DocumentTableAxis,
  entries: &mut [Coordinate],
  at: usize,
) -> Result<String, DocumentMutationError> {
  // Match the editor's first structural edit of deployed ordinal imports. Only
  // the edited axis changes; existing IDs, cells and header positions survive.
  if entries.iter().any(|entry| decimal(&entry.order)) {
    for (index, entry) in entries.iter_mut().enumerate() {
      entry.order = format!("a0{index:08}1");
      block.insert(
        txn,
        format!("prop:{}.{}.order", axis.collection(), entry.id),
        entry.order.as_str(),
      );
    }
  }
  let lower = at.checked_sub(1).map(|index| entries[index].order.as_str());
  let upper = entries.get(at).map(|entry| entry.order.as_str());
  let inside = |key: &str| lower.is_none_or(|lower| lower < key) && upper.is_none_or(|upper| key < upper);
  // Native imports carry bare keys; Organizer also carries wrapped keys. Feed
  // full bounds to the unchanged base helper, without guessing a suffix in an
  // imported key. A prefix window must shrink before appending a collision tail.
  let mut base = crate::order_key::generate_base_key_between(lower, upper).map_err(|_| invalid())?;
  while upper.is_some_and(|upper| upper.starts_with(&base)) {
    // If the next base is still a prefix, it is a strictly shorter prefix.
    base = crate::order_key::generate_base_key_between(lower, Some(&base)).map_err(|_| invalid())?;
  }
  // Obtain the exact existing 0 + 32-character collision tail from its owner.
  // Do not port its RNG, alphabet, grammar or error behavior into table edits.
  let neutral = crate::order_key::generate_base_key_between(None, None).map_err(|_| invalid())?;
  let wrapped = crate::order_key::generate_order_key_between(None, None).map_err(|_| invalid())?;
  let suffix = wrapped.strip_prefix(&neutral).ok_or_else(invalid)?;
  let key = format!("{base}{suffix}");
  if inside(&key) { Ok(key) } else { Err(invalid()) }
}

fn cell_key(axis: DocumentTableAxis, id: &str, other: &str) -> String {
  match axis {
    DocumentTableAxis::Row => format!("prop:cells.{id}:{other}.text"),
    DocumentTableAxis::Column => format!("prop:cells.{other}:{id}.text"),
  }
}

pub(super) fn edit_axis(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  block_id: &str,
  axis: DocumentTableAxis,
  change: &DocumentTableAxisChange,
) -> Result<(), DocumentMutationError> {
  let block = flat_table(blocks, txn, block_id)?;
  let rows = coordinates(&block, txn, DocumentTableAxis::Row)?;
  let columns = coordinates(&block, txn, DocumentTableAxis::Column)?;
  validate_cells(&block, txn, &rows, &columns)?;
  let headers = header_rows(&block, txn, rows.len())?;
  let (mut entries, others) = match axis {
    DocumentTableAxis::Row => (rows, columns),
    DocumentTableAxis::Column => (columns, rows),
  };
  let index_of = |id: &str| {
    entries
      .iter()
      .position(|entry| entry.id == id)
      .ok_or(DocumentMutationError::TargetNotFound)
  };
  let source = match change {
    DocumentTableAxisChange::Insert { .. } => None,
    DocumentTableAxisChange::Delete { id }
    | DocumentTableAxisChange::Move { id, .. }
    | DocumentTableAxisChange::Duplicate { id }
    | DocumentTableAxisChange::Clear { id } => Some(index_of(id)?),
  };
  let at = match change {
    DocumentTableAxisChange::Insert { after_id } | DocumentTableAxisChange::Move { after_id, .. } => after_id
      .as_deref()
      .map(index_of)
      .transpose()?
      .map_or(0, |index| index + 1),
    DocumentTableAxisChange::Duplicate { .. } => source.unwrap() + 1,
    _ => 0,
  };
  if let DocumentTableAxisChange::Move {
    id,
    after_id: Some(after),
  } = change
  {
    if id == after {
      return Err(invalid());
    }
  }
  match change {
    DocumentTableAxisChange::Delete { id } => {
      let prefix = format!("prop:{}.{id}.", axis.collection());
      let keys = block
        .keys(txn)
        .filter(|key| {
          key.starts_with(&prefix)
            || cell_coordinate(key).is_some_and(|(row, column)| match axis {
              DocumentTableAxis::Row => row == id,
              DocumentTableAxis::Column => column == id,
            })
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
      for key in keys {
        block.remove(txn, &key);
      }
      if axis == DocumentTableAxis::Row && headers.is_some_and(|count| source.unwrap() < count) {
        block.insert(txn, "prop:headerRows", (headers.unwrap() - 1) as f64);
      }
    }
    DocumentTableAxisChange::Clear { id } => {
      for other in &others {
        let Some(yrs::Out::YText(text)) = block.get(txn, &cell_key(axis, id, &other.id)) else {
          return Err(invalid());
        };
        text.remove_range(txn, 0, text.len(txn));
      }
    }
    DocumentTableAxisChange::Move { id, .. } => {
      // The bounds use the pre-move sorted axis, as in TableDataManager.getOrder.
      let order = next_order(&block, txn, axis, &mut entries, at)?;
      block.insert(txn, format!("prop:{}.{id}.order", axis.collection()), order);
    }
    DocumentTableAxisChange::Insert { .. } | DocumentTableAxisChange::Duplicate { .. } => {
      let order = next_order(&block, txn, axis, &mut entries, at)?;
      let new_id = Uuid::new_v4().to_string();
      let prefix = format!("prop:{}.{new_id}.", axis.collection());
      if matches!(change, DocumentTableAxisChange::Duplicate { .. }) {
        let old_id = &entries[source.unwrap()].id;
        let old_prefix = format!("prop:{}.{old_id}.", axis.collection());
        let values = block
          .iter(txn)
          .filter_map(|(key, value)| {
            key
              .strip_prefix(&old_prefix)
              .map(|field| (field.to_string(), value.as_prelim(txn)))
          })
          .collect::<Vec<_>>();
        for (field, value) in values {
          block.insert(txn, format!("{prefix}{field}"), value);
        }
      }
      block.insert(txn, format!("{prefix}{}", axis.identity()), new_id.as_str());
      block.insert(txn, format!("{prefix}order"), order);
      let mut annotations = HashMap::new();
      for other in &others {
        let key = cell_key(axis, &new_id, &other.id);
        if matches!(change, DocumentTableAxisChange::Duplicate { .. }) {
          let old_key = cell_key(axis, &entries[source.unwrap()].id, &other.id);
          let Some(yrs::Out::YText(text)) = block.get(txn, &old_key) else {
            return Err(invalid());
          };
          if text.diff(txn, |_| ()).iter().any(|chunk| {
            chunk
              .attributes
              .as_ref()
              .is_some_and(|attrs| attrs.keys().any(|key| key.starts_with("comment-")))
          }) {
            return Err(invalid());
          }
          let prelim = text.as_prelim(txn);
          let copied = block.insert(txn, key.as_str(), prelim);
          crate::annotation::remap_copied_text(&copied, txn, &mut annotations);
          let old_fill_key = format!("{}.backgroundColor", old_key.trim_end_matches(".text"));
          if let Some(fill) = block.get(txn, &old_fill_key) {
            let fill = fill.as_prelim(txn);
            block.insert(txn, format!("{}.backgroundColor", key.trim_end_matches(".text")), fill);
          }
        } else {
          block.insert(txn, key, yrs::TextPrelim::new(""));
        }
      }
      if axis == DocumentTableAxis::Row && headers.is_some_and(|count| at < count) {
        block.insert(txn, "prop:headerRows", (headers.unwrap() + 1) as f64);
      }
    }
  }
  // Repeat validity is checked by the existing native template preflight after
  // releasing this local write transaction, before producing a persisted delta.
  Ok(())
}

/// Expose only the native coordinate contract in private edit metadata. No
/// renderer, public export or ordinary table builder consumes this projection.
pub(crate) fn read_axis_properties(
  block: &yrs::MapRef,
  txn: &impl ReadTxn,
) -> std::collections::BTreeMap<String, serde_json::Value> {
  let mut output = std::collections::BTreeMap::new();
  for axis in [DocumentTableAxis::Row, DocumentTableAxis::Column] {
    if coordinates(block, txn, axis).is_err() {
      continue;
    }
    let prefix = format!("prop:{}.", axis.collection());
    let mut coordinates = serde_json::Map::<String, serde_json::Value>::new();
    for (key, value) in block.iter(txn) {
      let Some((id, field)) = key.strip_prefix(&prefix).and_then(|rest| rest.split_once('.')) else {
        continue;
      };
      if !coordinate_id(id) {
        continue;
      }
      let value = crate::yjs_out_to_json(value, txn);
      let accepted = match field {
        "rowId" | "columnId" | "order" | "backgroundColor" | "textAlign" | "repeat.source" | "repeat.alias" => {
          value.is_string()
        }
        "width" => value.is_number(),
        _ => false,
      };
      if !accepted {
        continue;
      }
      let fields = coordinates
        .entry(id.to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .unwrap();
      if let Some(field) = field.strip_prefix("repeat.") {
        fields
          .entry("repeat")
          .or_insert_with(|| serde_json::json!({}))
          .as_object_mut()
          .unwrap()
          .insert(field.to_string(), value);
      } else {
        fields.insert(field.to_string(), value);
      }
    }
    output.insert(axis.collection().to_string(), serde_json::Value::Object(coordinates));
  }
  for name in ["headerRows", "appearance", "density", "textAlign"] {
    if let Some(value) = block.get(txn, &format!("prop:{name}")) {
      let value = crate::yjs_out_to_json(value, txn);
      if name == "headerRows"
        && value
          .as_f64()
          .is_some_and(|count| count.is_finite() && count >= 0.0 && count.fract() == 0.0)
        || name != "headerRows" && value.is_string()
      {
        output.insert(name.into(), value);
      }
    }
  }
  output
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTableAppearance {
  Grid,
  Ruled,
  Plain,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTableDensity {
  Normal,
  Compact,
}

/// Native table presentation has its own contract; callout appearance values
/// and omitted table-builder defaults keep their existing representation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTableProperties {
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub appearance: Option<DocumentAttributeChange<DocumentTableAppearance>>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub density: Option<DocumentAttributeChange<DocumentTableDensity>>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub text_align: Option<DocumentAttributeChange<DocumentTextAlignment>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTableCoordinateProperties {
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub background_color: Option<DocumentAttributeChange<DocumentPaletteColor>>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub text_align: Option<DocumentAttributeChange<DocumentTextAlignment>>,
  // JSON Number retains finite fractional resize values and the existing Eq
  // payload contract. Strings, NaN and infinities cannot enter this typed field.
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub width: Option<DocumentAttributeChange<serde_json::Number>>,
}

pub(crate) fn validate_presentation(properties: &DocumentTableProperties) -> Result<(), DocumentMutationError> {
  if properties.appearance.is_none() && properties.density.is_none() && properties.text_align.is_none() {
    return Err(invalid());
  }
  Ok(())
}
pub(crate) fn update_presentation(
  block: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  properties: &DocumentTableProperties,
) -> Result<(), DocumentMutationError> {
  validate_presentation(properties)?;
  crate::document_properties::write(block, txn, "appearance", &properties.appearance)?;
  crate::document_properties::write(block, txn, "density", &properties.density)?;
  crate::document_properties::write(block, txn, "textAlign", &properties.text_align)
}
pub(crate) fn validate_coordinate_properties(
  axis: DocumentTableAxis,
  properties: &DocumentTableCoordinateProperties,
) -> Result<(), DocumentMutationError> {
  if properties.background_color.is_none() && properties.text_align.is_none() && properties.width.is_none()
    || axis == DocumentTableAxis::Row && (properties.text_align.is_some() || properties.width.is_some())
  {
    return Err(invalid());
  }
  if let Some(DocumentAttributeChange::Set { value }) = &properties.width {
    // Table selection-controller.widthAdjust clamps only to ColumnMinWidth=60;
    // ColumnMaxWidth is the automatic-width fallback, not a resize maximum.
    if !value.as_f64().is_some_and(|width| width.is_finite() && width >= 60.0) {
      return Err(invalid());
    }
  }
  Ok(())
}
pub(super) fn update_coordinate(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  block_id: &str,
  axis: DocumentTableAxis,
  id: &str,
  properties: &DocumentTableCoordinateProperties,
) -> Result<(), DocumentMutationError> {
  validate_coordinate_properties(axis, properties)?;
  let block = flat_table(blocks, txn, block_id)?;
  if !coordinates(&block, txn, axis)?
    .iter()
    .any(|coordinate| coordinate.id == id)
  {
    return Err(DocumentMutationError::TargetNotFound);
  }
  let prefix = format!("{}.{id}", axis.collection());
  let background = properties.background_color.as_ref().map(|change| match change {
    DocumentAttributeChange::Set { value } => DocumentAttributeChange::Set {
      value: value.native_value(false),
    },
    DocumentAttributeChange::Remove {} => DocumentAttributeChange::Remove {},
  });
  crate::document_properties::write(&block, txn, &format!("{prefix}.backgroundColor"), &background)?;
  crate::document_properties::write(&block, txn, &format!("{prefix}.textAlign"), &properties.text_align)?;
  crate::document_properties::write(&block, txn, &format!("{prefix}.width"), &properties.width)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn load(state: &[u8]) -> (yrs::Doc, yrs::MapRef, String) {
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let id = blocks
      .iter(&doc.transact())
      .find_map(|(id, value)| {
        matches!(value,yrs::Out::YMap(ref block) if structure::flavour(block,&doc.transact())=="myoxus:table")
          .then(|| id.to_string())
      })
      .unwrap();
    (doc, blocks, id)
  }
  fn fixture() -> Vec<u8> {
    let source=crate::markdown_to_yjs("Table", "Protected **neighbor**\n\n| **é😀** | Right |\n| :--- | ---: |\n| Body | Value |\n| Last | Tail |\n\nProtected tail").unwrap();
    let (doc, blocks, id) = load(&source);
    let mut txn = doc.transact_mut();
    let block = structure::native_block(&blocks, &txn, &id).unwrap();
    block.insert(&mut txn, "prop:headerRows", 2.0);
    block.insert(&mut txn, "prop:appearance", "ruled");
    block.insert(&mut txn, "prop:density", "compact");
    let cols = coordinates(&block, &txn, DocumentTableAxis::Column).unwrap();
    block.insert(&mut txn, format!("prop:columns.{}.width", cols[0].id), 237);
    block.insert(&mut txn, format!("prop:columns.{}.opaque", cols[0].id), "retained");
    txn.encode_diff_v1(&yrs::StateVector::default())
  }
  fn change(
    state: &[u8],
    axis: DocumentTableAxis,
    change: DocumentTableAxisChange,
  ) -> Result<DocumentMutationOutput, DocumentMutationError> {
    let (_, _, id) = load(state);
    apply_document_mutation(
      state,
      &DocumentMutation::EditTableAxis {
        block_id: id,
        axis,
        change,
      },
    )
  }
  fn axes(state: &[u8]) -> (Vec<String>, Vec<String>) {
    let (doc, blocks, id) = load(state);
    let txn = doc.transact();
    let block = structure::native_block(&blocks, &txn, &id).unwrap();
    (
      coordinates(&block, &txn, DocumentTableAxis::Row)
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect(),
      coordinates(&block, &txn, DocumentTableAxis::Column)
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect(),
    )
  }
  fn value(state: &[u8], key: &str) -> Option<serde_json::Value> {
    let (doc, blocks, id) = load(state);
    let txn = doc.transact();
    structure::native_block(&blocks, &txn, &id)
      .unwrap()
      .get(&txn, key)
      .map(|v| crate::yjs_out_to_json(v, &txn))
  }

  #[test]
  fn incremental_axes_keep_native_text_identities_headers_and_creation_orders() {
    let state = fixture();
    let (rows, cols) = axes(&state);
    let (doc, blocks, id) = load(&state);
    let txn = doc.transact();
    let block = structure::native_block(&blocks, &txn, &id).unwrap();
    assert!(
      coordinates(&block, &txn, DocumentTableAxis::Row)
        .unwrap()
        .iter()
        .enumerate()
        .all(|(index, c)| c.order == format!("a0{index:08}1"))
    );
    assert!(
      coordinates(&block, &txn, DocumentTableAxis::Column)
        .unwrap()
        .iter()
        .enumerate()
        .all(|(index, c)| c.order == format!("a0{index:08}1"))
    );
    let original = block
      .iter(&txn)
      .map(|(k, v)| (k.to_string(), crate::yjs_out_to_json(v, &txn)))
      .collect::<std::collections::BTreeMap<_, _>>();
    let original_texts = block
      .iter(&txn)
      .filter_map(|(k, v)| {
        if let yrs::Out::YText(t) = v {
          Some((k.to_string(), t.clone(), t.diff(&txn, |_| ())))
        } else {
          None
        }
      })
      .collect::<Vec<_>>();
    drop(txn);
    let duplicated = change(
      &state,
      DocumentTableAxis::Row,
      DocumentTableAxisChange::Duplicate { id: rows[0].clone() },
    )
    .unwrap();
    let (new_rows, new_cols) = axes(&duplicated.state);
    assert_eq!(new_cols, cols);
    assert_eq!(new_rows.len(), 4);
    assert_eq!(new_rows[0], rows[0]);
    assert_eq!(&new_rows[2..], &rows[1..]);
    assert_eq!(value(&duplicated.state, "prop:headerRows"), Some(3.0.into()));
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&duplicated.delta).unwrap())
      .unwrap();
    let txn = doc.transact();
    for (key, text, runs) in original_texts {
      assert_eq!(block.get(&txn, &key), Some(yrs::Out::YText(text.clone())));
      assert_eq!(text.diff(&txn, |_| ()), runs);
    }
    for (key, value) in original {
      if key == "prop:headerRows" || key.starts_with("prop:rows.") && key.ends_with(".order") {
        continue;
      }
      assert_eq!(
        block.get(&txn, &key).map(|v| crate::yjs_out_to_json(v, &txn)),
        Some(value),
        "{key}"
      );
    }
    drop(txn);
    let moved = change(
      &duplicated.state,
      DocumentTableAxis::Row,
      DocumentTableAxisChange::Move {
        id: rows[2].clone(),
        after_id: None,
      },
    )
    .unwrap();
    assert_eq!(
      axes(&moved.state).0,
      vec![rows[2].clone(), rows[0].clone(), new_rows[1].clone(), rows[1].clone()]
    );
    assert_eq!(value(&moved.state, "prop:headerRows"), Some(3.0.into()));
    let inserted = change(
      &moved.state,
      DocumentTableAxis::Column,
      DocumentTableAxisChange::Insert {
        after_id: Some(cols[0].clone()),
      },
    )
    .unwrap();
    let (_, inserted_cols) = axes(&inserted.state);
    assert_eq!(inserted_cols.len(), 3);
    assert_eq!(inserted_cols[0], cols[0]);
    assert_eq!(inserted_cols[2], cols[1]);
    for row in axes(&inserted.state).0 {
      assert_eq!(
        value(
          &inserted.state,
          &cell_key(DocumentTableAxis::Column, &inserted_cols[1], &row)
        ),
        Some("".into())
      );
    }
    let cloned = change(
      &inserted.state,
      DocumentTableAxis::Column,
      DocumentTableAxisChange::Duplicate { id: cols[0].clone() },
    )
    .unwrap();
    let (_, cloned_cols) = axes(&cloned.state);
    assert_eq!(cloned_cols.len(), 4);
    let copy = &cloned_cols[1];
    assert_eq!(
      value(&cloned.state, &format!("prop:columns.{copy}.width")),
      Some(237.0.into())
    );
    assert_eq!(
      value(&cloned.state, &format!("prop:columns.{copy}.opaque")),
      Some("retained".into())
    );
    let reordered = change(
      &cloned.state,
      DocumentTableAxis::Column,
      DocumentTableAxisChange::Move {
        id: copy.clone(),
        after_id: Some(cols[1].clone()),
      },
    )
    .unwrap();
    assert_eq!(axes(&reordered.state).1.last(), Some(copy));
  }

  #[test]
  fn copied_axis_rebinds_annotations_once_and_clear_keeps_text_refs() {
    let state = fixture();
    let (doc, blocks, id) = load(&state);
    let mut txn = doc.transact_mut();
    let block = structure::native_block(&blocks, &txn, &id).unwrap();
    let rows = coordinates(&block, &txn, DocumentTableAxis::Row).unwrap();
    let cols = coordinates(&block, &txn, DocumentTableAxis::Column).unwrap();
    let fill = "--myoxus-sem-status-error-paper";
    let fill_key = format!("prop:cells.{}:{}.backgroundColor", rows[0].id, cols[0].id);
    block.insert(&mut txn, fill_key.as_str(), fill);
    for column in &cols {
      let Some(yrs::Out::YText(text)) = block.get(&txn, &cell_key(DocumentTableAxis::Row, &rows[0].id, &column.id))
      else {
        panic!("cell")
      };
      let length = text.len(&txn);
      text.format(
        &mut txn,
        0,
        length,
        Attrs::from([(
          "annotation".into(),
          Any::from_json(r#"{"id":"source-annotation"}"#).unwrap(),
        )]),
      );
    }
    let state = txn.encode_diff_v1(&yrs::StateVector::default());
    drop(txn);
    let copied = change(
      &state,
      DocumentTableAxis::Row,
      DocumentTableAxisChange::Duplicate { id: rows[0].id.clone() },
    )
    .unwrap();
    let (new_rows, _) = axes(&copied.state);
    let (copy_doc, copy_blocks, copy_id) = load(&copied.state);
    let copy_txn = copy_doc.transact();
    let copy_block = structure::native_block(&copy_blocks, &copy_txn, &copy_id).unwrap();
    let mut ids = HashSet::new();
    for column in &cols {
      let Some(yrs::Out::YText(text)) =
        copy_block.get(&copy_txn, &cell_key(DocumentTableAxis::Row, &new_rows[1], &column.id))
      else {
        panic!("copied")
      };
      for run in text.diff(&copy_txn, |_| ()) {
        if let Some(id) = crate::annotation::annotation_id(run.attributes.as_deref()) {
          ids.insert(id.to_string());
        }
      }
    }
    assert_eq!(ids.len(), 1);
    assert!(!ids.contains("source-annotation"));
    assert_eq!(
      value(
        &copied.state,
        &format!("prop:cells.{}:{}.backgroundColor", new_rows[1], cols[0].id)
      ),
      Some(fill.into())
    );
    drop(copy_txn);
    let copied_col = change(
      &state,
      DocumentTableAxis::Column,
      DocumentTableAxisChange::Duplicate { id: cols[0].id.clone() },
    )
    .unwrap();
    let (_, new_cols) = axes(&copied_col.state);
    assert_eq!(
      value(
        &copied_col.state,
        &format!("prop:cells.{}:{}.backgroundColor", rows[0].id, new_cols[1])
      ),
      Some(fill.into())
    );
    let cleared = change(
      &state,
      DocumentTableAxis::Row,
      DocumentTableAxisChange::Clear { id: rows[0].id.clone() },
    )
    .unwrap();
    let old_texts = cols
      .iter()
      .map(|column| {
        let key = cell_key(DocumentTableAxis::Row, &rows[0].id, &column.id);
        let Some(yrs::Out::YText(text)) = block.get(&doc.transact(), &key) else {
          panic!("old")
        };
        (key, text)
      })
      .collect::<Vec<_>>();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&cleared.delta).unwrap())
      .unwrap();
    for (key, text) in old_texts {
      assert_eq!(block.get(&doc.transact(), &key), Some(yrs::Out::YText(text.clone())));
      assert_eq!(text.get_string(&doc.transact()), "");
      text.insert(&mut doc.transact_mut(), 0, "Web continuation");
    }
    assert_eq!(axes(&cleared.state), axes(&state));
    assert_eq!(value(&cleared.state, &fill_key), Some(fill.into()));
    assert_eq!(value(&cleared.state, "prop:headerRows"), Some(2.0.into()));
    let cleared_col = change(
      &state,
      DocumentTableAxis::Column,
      DocumentTableAxisChange::Clear { id: cols[0].id.clone() },
    )
    .unwrap();
    assert_eq!(value(&cleared_col.state, &fill_key), Some(fill.into()));
    for row in &rows {
      assert_eq!(
        value(
          &cleared_col.state,
          &cell_key(DocumentTableAxis::Column, &cols[0].id, &row.id)
        ),
        Some("".into())
      );
    }
  }

  #[test]
  fn exact_coordinate_delimiters_and_invalid_targets_do_not_rewrite_neighbors() {
    let state = fixture();
    let (doc, blocks, id) = load(&state);
    let mut txn = doc.transact_mut();
    let block = structure::native_block(&blocks, &txn, &id).unwrap();
    let rows = coordinates(&block, &txn, DocumentTableAxis::Row).unwrap();
    let old = &rows[0].id;
    let longer = format!("{old}-long");
    let second = &rows[1].id;
    let values = block
      .iter(&txn)
      .filter_map(|(key, value)| {
        let key = if let Some(suffix) = key.strip_prefix(&format!("prop:rows.{second}.")) {
          format!("prop:rows.{longer}.{suffix}")
        } else if let Some(suffix) = key.strip_prefix(&format!("prop:cells.{second}:")) {
          format!("prop:cells.{longer}:{suffix}")
        } else {
          return None;
        };
        Some((key, value.as_prelim(&txn)))
      })
      .collect::<Vec<_>>();
    let keys = block
      .keys(&txn)
      .filter(|key| {
        key.starts_with(&format!("prop:rows.{second}.")) || key.starts_with(&format!("prop:cells.{second}:"))
      })
      .map(str::to_string)
      .collect::<Vec<_>>();
    for key in keys {
      block.remove(&mut txn, &key);
    }
    for (key, value) in values {
      block.insert(&mut txn, key, value);
    }
    block.insert(&mut txn, format!("prop:rows.{longer}.rowId"), longer.as_str());
    let state = txn.encode_diff_v1(&yrs::StateVector::default());
    drop(txn);
    let deleted = change(
      &state,
      DocumentTableAxis::Row,
      DocumentTableAxisChange::Delete { id: old.clone() },
    )
    .unwrap();
    assert!(axes(&deleted.state).0.contains(&longer));
    for col in axes(&state).1 {
      assert_eq!(
        value(&deleted.state, &cell_key(DocumentTableAxis::Row, &longer, &col)),
        value(&state, &cell_key(DocumentTableAxis::Row, &longer, &col))
      );
    }
    for change in [
      DocumentTableAxisChange::Delete { id: "foreign".into() },
      DocumentTableAxisChange::Insert {
        after_id: Some("foreign".into()),
      },
      DocumentTableAxisChange::Move {
        id: old.clone(),
        after_id: Some(old.clone()),
      },
    ] {
      assert!(super::tests::change(&state, DocumentTableAxis::Row, change).is_err());
    }
  }

  #[test]
  fn deployed_ordinal_keys_convert_only_the_edited_axis_and_preserve_positions() {
    let source = fixture();
    let (doc, blocks, id) = load(&source);
    let mut txn = doc.transact_mut();
    let block = structure::native_block(&blocks, &txn, &id).unwrap();
    for axis in [DocumentTableAxis::Row, DocumentTableAxis::Column] {
      for (index, entry) in coordinates(&block, &txn, axis).unwrap().into_iter().enumerate() {
        block.insert(
          &mut txn,
          format!("prop:{}.{}.order", axis.collection(), entry.id),
          format!("{index:08}"),
        );
      }
    }
    let state = txn.encode_diff_v1(&yrs::StateVector::default());
    drop(txn);
    let (rows, cols) = axes(&state);
    let inserted = change(
      &state,
      DocumentTableAxis::Row,
      DocumentTableAxisChange::Insert {
        after_id: Some(rows[0].clone()),
      },
    )
    .unwrap();
    for (index, id) in rows.iter().enumerate() {
      assert_eq!(
        value(&inserted.state, &format!("prop:rows.{id}.order")),
        Some(format!("a0{index:08}1").into())
      );
    }
    for (index, id) in cols.iter().enumerate() {
      assert_eq!(
        value(&inserted.state, &format!("prop:columns.{id}.order")),
        Some(format!("{index:08}").into())
      );
    }
    assert_eq!(value(&inserted.state, "prop:headerRows"), Some(3.0.into()));
    assert_eq!(axes(&inserted.state).0[0], rows[0]);
    assert_eq!(&axes(&inserted.state).0[2..], &rows[1..]);
    let moved = change(
      &inserted.state,
      DocumentTableAxis::Column,
      DocumentTableAxisChange::Move {
        id: cols[1].clone(),
        after_id: None,
      },
    )
    .unwrap();
    assert_eq!(axes(&moved.state).1, [cols[1].clone(), cols[0].clone()]);
    assert_eq!(axes(&moved.state).0, axes(&inserted.state).0);
    let (long_doc, long_blocks, long_id) = load(&source);
    let mut long_txn = long_doc.transact_mut();
    let long_table = structure::native_block(&long_blocks, &long_txn, &long_id).unwrap();
    for (index, id) in rows.iter().enumerate() {
      long_table.insert(
        &mut long_txn,
        format!("prop:rows.{id}.order"),
        format!("a0{index:048}1"),
      );
    }
    let long_state = long_txn.encode_diff_v1(&yrs::StateVector::default());
    drop(long_txn);
    let between = change(
      &long_state,
      DocumentTableAxis::Row,
      DocumentTableAxisChange::Insert {
        after_id: Some(rows[0].clone()),
      },
    )
    .unwrap();
    assert_eq!(axes(&between.state).0[0], rows[0]);
    assert_eq!(axes(&between.state).0[2], rows[1]);
    // Both the original bare fractional format and converted ordinals must
    // support insertion before the first entry, with a genuinely smaller key.
    for state in [&source, &inserted.state] {
      let first = axes(state).0[0].clone();
      let result = change(
        state,
        DocumentTableAxis::Row,
        DocumentTableAxisChange::Insert { after_id: None },
      )
      .unwrap();
      assert_ne!(axes(&result.state).0[0], first);
      assert_eq!(axes(&result.state).0[1], first);
    }
  }

  #[test]
  fn coordinate_properties_keep_text_refs_and_accept_editor_resize_values_without_a_false_maximum() {
    let state = fixture();
    let (doc, blocks, id) = load(&state);
    let txn = doc.transact();
    let block = structure::native_block(&blocks, &txn, &id).unwrap();
    let (rows, cols) = axes(&state);
    let refs = block
      .iter(&txn)
      .filter_map(|(key, value)| {
        if let yrs::Out::YText(text) = value {
          Some((key.to_string(), text.clone(), text.diff(&txn, |_| ())))
        } else {
          None
        }
      })
      .collect::<Vec<_>>();
    drop(txn);
    for width in [60.0, 187.5, 511.25] {
      let properties = DocumentTableCoordinateProperties {
        background_color: Some(DocumentAttributeChange::Set {
          value: DocumentPaletteColor::Blue,
        }),
        text_align: Some(DocumentAttributeChange::Set {
          value: DocumentTextAlignment::Center,
        }),
        width: Some(DocumentAttributeChange::Set {
          value: serde_json::Number::from_f64(width).unwrap(),
        }),
      };
      let edited = apply_document_mutation(
        &state,
        &DocumentMutation::UpdateTableCoordinateProperties {
          block_id: id.clone(),
          axis: DocumentTableAxis::Column,
          id: cols[0].clone(),
          properties,
        },
      )
      .unwrap();
      assert_eq!(
        value(&edited.state, &format!("prop:columns.{}.width", cols[0]))
          .unwrap()
          .as_f64(),
        Some(width)
      );
      assert_eq!(
        value(&edited.state, &format!("prop:columns.{}.backgroundColor", cols[0])),
        Some(DocumentPaletteColor::Blue.native_value(false).into())
      );
      assert_eq!(axes(&edited.state), (rows.clone(), cols.clone()));
    }
    let edited = apply_document_mutation(
      &state,
      &DocumentMutation::UpdateTableCoordinateProperties {
        block_id: id.clone(),
        axis: DocumentTableAxis::Row,
        id: rows[0].clone(),
        properties: DocumentTableCoordinateProperties {
          background_color: Some(DocumentAttributeChange::Set {
            value: DocumentPaletteColor::Green,
          }),
          ..Default::default()
        },
      },
    )
    .unwrap();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&edited.delta).unwrap())
      .unwrap();
    for (key, text, runs) in refs {
      assert_eq!(block.get(&doc.transact(), &key), Some(yrs::Out::YText(text.clone())));
      assert_eq!(text.diff(&doc.transact(), |_| ()), runs);
    }
    assert_eq!(
      value(&edited.state, &format!("prop:rows.{}.backgroundColor", rows[0])),
      Some(DocumentPaletteColor::Green.native_value(false).into())
    );
    let reset = apply_document_mutation(
      &edited.state,
      &DocumentMutation::UpdateTableCoordinateProperties {
        block_id: id.clone(),
        axis: DocumentTableAxis::Column,
        id: cols[0].clone(),
        properties: DocumentTableCoordinateProperties {
          background_color: Some(DocumentAttributeChange::Remove {}),
          text_align: Some(DocumentAttributeChange::Remove {}),
          width: Some(DocumentAttributeChange::Remove {}),
        },
      },
    )
    .unwrap();
    for field in ["backgroundColor", "textAlign", "width"] {
      assert_eq!(value(&reset.state, &format!("prop:columns.{}.{field}", cols[0])), None);
    }
    assert_eq!(
      value(&reset.state, &format!("prop:columns.{}.textAlign", cols[1])),
      value(&state, &format!("prop:columns.{}.textAlign", cols[1]))
    );
    for (axis, id, properties) in [
      (
        DocumentTableAxis::Column,
        cols[0].clone(),
        DocumentTableCoordinateProperties {
          width: Some(DocumentAttributeChange::Set {
            value: serde_json::Number::from_f64(59.9).unwrap(),
          }),
          ..Default::default()
        },
      ),
      (
        DocumentTableAxis::Row,
        rows[0].clone(),
        DocumentTableCoordinateProperties {
          width: Some(DocumentAttributeChange::Set { value: 60.into() }),
          ..Default::default()
        },
      ),
      (
        DocumentTableAxis::Column,
        "foreign".into(),
        DocumentTableCoordinateProperties {
          background_color: Some(DocumentAttributeChange::Remove {}),
          ..Default::default()
        },
      ),
    ] {
      assert!(
        apply_document_mutation(
          &state,
          &DocumentMutation::UpdateTableCoordinateProperties {
            block_id: load(&state).2,
            axis,
            id,
            properties
          }
        )
        .is_err()
      );
    }
  }
  #[test]
  fn axis_edits_reject_child_tables_without_repairing_the_existing_model() {
    let source = fixture();
    let (doc, blocks, id) = load(&source);
    let mut txn = doc.transact_mut();
    let table = structure::native_block(&blocks, &txn, &id).unwrap();
    block_array(&table, &txn, "children")
      .unwrap()
      .push_back(&mut txn, "legacy-row");
    let state = txn.encode_diff_v1(&yrs::StateVector::default());
    drop(txn);
    assert_eq!(
      change(
        &state,
        DocumentTableAxis::Row,
        DocumentTableAxisChange::Insert { after_id: None }
      )
      .unwrap_err(),
      DocumentMutationError::InvalidBlockProperties
    );
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::UpdateTableCoordinateProperties {
          block_id: id,
          axis: DocumentTableAxis::Column,
          id: axes(&state).1[0].clone(),
          properties: DocumentTableCoordinateProperties {
            width: Some(DocumentAttributeChange::Set { value: 120.into() }),
            ..Default::default()
          }
        }
      )
      .is_err()
    );
  }
}
