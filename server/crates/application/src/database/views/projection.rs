// SPDX-License-Identifier: AGPL-3.0-or-later
//! Non-persisted native metadata Cells used by reads and editing responses.
use super::*;

pub fn attach_projection_cells(record: &mut DatabaseRowRecord, fields: &[DatabaseField]) {
  let mut updated_at = record.row.updated_at;
  let mut updated_by = record.row.updated_by;
  for cell in &record.cells {
    if cell.updated_at > updated_at {
      updated_at = cell.updated_at;
      updated_by = cell.updated_by;
    }
  }
  if record.row.updated_at != updated_at
    && let Some(cell) = record
      .cells
      .iter()
      .filter(|cell| cell.updated_at == updated_at)
      .min_by_key(|cell| cell.field_id)
  {
    updated_by = cell.updated_by;
  }
  for field in fields {
    let projection = match field.field_type {
      DatabaseFieldType::CreatedTime => Some((
        DatabaseCellValueData::CreatedTime(record.row.created_at),
        record.row.created_at,
      )),
      DatabaseFieldType::CreatedBy => record
        .row
        .created_by
        .map(|value| (DatabaseCellValueData::CreatedBy(value), record.row.created_at)),
      DatabaseFieldType::UpdatedTime => Some((DatabaseCellValueData::UpdatedTime(updated_at), updated_at)),
      DatabaseFieldType::UpdatedBy => updated_by.map(|value| (DatabaseCellValueData::UpdatedBy(value), updated_at)),
      _ => None,
    };
    if let Some((value, updated_at)) = projection {
      record.cells.push(DatabaseCellValue {
        row_id: record.row.id,
        field_id: field.id,
        field_type: field.field_type,
        value,
        updated_by: None,
        edit_revision: 0,
        updated_at,
      });
    }
  }
}
