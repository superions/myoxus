// SPDX-License-Identifier: AGPL-3.0-or-later
//! Field-scoped option references shared by native schema conversion and Views.
use crate::database::{
  DatabaseFieldId, DatabaseFilterGroup, DatabaseFilterValue, DatabaseSelectOptionMapping, DatabaseSelectUpdateError,
  DatabaseSelectUpdateReason, DatabaseViewConfig,
};

/// Rewrite typed operands only for this field, preserving all other predicates.
/// The caller owns the transaction/revision fence around the captured tree.
pub fn map_select_filter_group(
  group: &mut DatabaseFilterGroup,
  field: DatabaseFieldId,
  mapping: &DatabaseSelectOptionMapping,
) -> Result<(), DatabaseSelectUpdateError> {
  for rule in &mut group.rules {
    if rule.field_id != field {
      continue;
    }
    rule.value = match &rule.value {
      DatabaseFilterValue::None => DatabaseFilterValue::None,
      DatabaseFilterValue::OptionId(value) => DatabaseFilterValue::OptionId(mapping.map_option_id(value)?),
      DatabaseFilterValue::Ids(values) => DatabaseFilterValue::Ids(mapping.map_ids(values)?),
      _ => {
        return Err(DatabaseSelectUpdateError {
          reason: DatabaseSelectUpdateReason::IncompatibleValueType,
          path: format!("filters/{field}"),
        });
      }
    };
  }
  for child in &mut group.groups {
    map_select_filter_group(child, field, mapping)?;
  }
  Ok(())
}

/// Actual group axes, without interpreting presentation labels or stored keys.
fn view_group_field_ids(config: &DatabaseViewConfig) -> Vec<DatabaseFieldId> {
  let pair = |a: &Option<crate::database::DatabaseGroupRule>, b: &Option<crate::database::DatabaseGroupRule>| {
    a.iter().chain(b).map(|group| group.field_id).collect()
  };
  match config {
    DatabaseViewConfig::Table(config) => pair(&config.group, &config.subgroup),
    DatabaseViewConfig::List(config) => pair(&config.group, &config.subgroup),
    DatabaseViewConfig::Gallery(config) => pair(&config.group, &config.subgroup),
    DatabaseViewConfig::Kanban(config) => vec![config.group_field_id],
    DatabaseViewConfig::Timeline(_) => vec![],
    DatabaseViewConfig::Gantt(config) => config.group.iter().map(|group| group.field_id).collect(),
    DatabaseViewConfig::Progress(config) => config.group_field_id.into_iter().collect(),
    DatabaseViewConfig::Calendar(config) => pair(&config.group, &config.subgroup),
  }
}

/// Group/subgroup option IDs share a raw-key namespace. Resolve every original
/// key against all source axes before mapping once; sequential per-field passes
/// could cascade one field's result through another field's mapping. An
/// ambiguous existing key fails rather than guessing which selection to retain.
pub fn map_select_view_group_keys(
  keys: &[String],
  config: &DatabaseViewConfig,
  fields: &[crate::database::DatabaseField],
  mappings: &[(DatabaseFieldId, &DatabaseSelectOptionMapping)],
) -> Result<Vec<String>, DatabaseSelectUpdateError> {
  let axes = view_group_field_ids(config);
  if !mappings.iter().any(|(id, _)| axes.contains(id)) {
    return Ok(keys.to_vec());
  }
  let mut seen = std::collections::BTreeSet::new();
  let mut result = Vec::new();
  for key in keys {
    let mut candidates = std::collections::BTreeSet::new();
    let mut open_axis = false;
    if key.is_empty() || key == "__empty__" {
      candidates.insert(key.clone());
    } else {
      for id in &axes {
        let field = fields
          .iter()
          .find(|field| field.id == *id)
          .ok_or_else(|| DatabaseSelectUpdateError {
            reason: DatabaseSelectUpdateReason::IncompatibleValueType,
            path: format!("groupFields/{id}"),
          })?;
        let options = field.config.select_options();
        let statuses = field.config.status_options();
        let known = options.iter().any(|option| option.id == *key) || statuses.iter().any(|option| option.id == *key);
        if known {
          let next = mappings
            .iter()
            .find(|(field, _)| field == id)
            .map(|(_, mapping)| mapping.map_option_id(key))
            .transpose()?
            .unwrap_or_else(|| key.clone());
          candidates.insert(next);
        } else if !matches!(
          field.config,
          crate::database::DatabaseFieldConfig::Select(_)
            | crate::database::DatabaseFieldConfig::MultiSelect(_)
            | crate::database::DatabaseFieldConfig::Status(_)
        ) {
          open_axis = true;
        }
      }
      if open_axis {
        candidates.insert(key.clone());
      }
      if candidates.is_empty() {
        return Err(DatabaseSelectUpdateError {
          reason: DatabaseSelectUpdateReason::UnknownSourceOption,
          path: String::new(),
        });
      }
    }
    if candidates.len() != 1 {
      return Err(DatabaseSelectUpdateError {
        reason: DatabaseSelectUpdateReason::AmbiguousGroupReference,
        path: String::new(),
      });
    }
    let next = candidates.into_iter().next().expect("one admitted group key");
    if seen.insert(next.clone()) {
      result.push(next);
    }
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::database::*;
  use std::collections::BTreeMap;
  fn field(options: &[&str]) -> DatabaseField {
    DatabaseField {
      id: uuid::Uuid::new_v4(),
      database_id: uuid::Uuid::nil(),
      name: "Native options".into(),
      field_type: DatabaseFieldType::Select,
      config: DatabaseFieldConfig::Select(DatabaseSelectFieldConfig {
        options: options
          .iter()
          .enumerate()
          .map(|(position, id)| DatabaseSelectOption {
            id: (*id).into(),
            name: (*id).into(),
            position: position as i32,
            color_role: "neutral".into(),
          })
          .collect(),
      }),
      position: 0,
      required: false,
      edit_revision: 1,
      created_at: chrono::Utc::now(),
      updated_at: chrono::Utc::now(),
    }
  }
  fn grouped(primary: DatabaseFieldId, secondary: Option<DatabaseFieldId>) -> DatabaseViewConfig {
    let rule = |id| DatabaseGroupRule {
      field_id: id,
      descending: false,
      show_empty_groups: true,
    };
    DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: uuid::Uuid::nil(),
      visible_field_ids: vec![],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![],
      sort: vec![],
      filter: vec![],
      filter_tree: None,
      group: Some(rule(primary)),
      subgroup: secondary.map(rule),
    })
  }
  #[test]
  fn grouped_option_fields_map_original_keys_once_without_cross_field_cascades() {
    let first = field(&["a", "b"]);
    let second = field(&["x", "y"]);
    let first_map = DatabaseSelectOptionMapping::new(
      &first.config,
      &field(&["b", "c"]).config,
      BTreeMap::from([("a".into(), "b".into()), ("b".into(), "c".into())]),
    )
    .unwrap();
    let second_map = DatabaseSelectOptionMapping::new(
      &second.config,
      &field(&["y", "z"]).config,
      BTreeMap::from([("x".into(), "y".into()), ("y".into(), "z".into())]),
    )
    .unwrap();
    let keys = vec!["a".into(), "b".into(), "x".into(), "y".into(), "__empty__".into()];
    let fields = vec![first.clone(), second.clone()];
    let config = grouped(first.id, Some(second.id));
    assert_eq!(
      map_select_view_group_keys(
        &keys,
        &config,
        &fields,
        &[(first.id, &first_map), (second.id, &second_map)]
      )
      .unwrap(),
      vec!["b", "c", "y", "z", "__empty__"]
    );
    assert_eq!(
      map_select_view_group_keys(&keys, &config, &fields, &[(first.id, &first_map)]).unwrap(),
      vec!["b", "c", "x", "y", "__empty__"]
    );
    let unrelated = grouped(second.id, None);
    assert_eq!(
      map_select_view_group_keys(&keys, &unrelated, &fields, &[(first.id, &first_map)]).unwrap(),
      keys
    );
    assert_eq!(
      map_select_view_group_keys(
        &["missing".into()],
        &grouped(first.id, None),
        &fields,
        &[(first.id, &first_map)]
      )
      .unwrap_err()
      .reason,
      DatabaseSelectUpdateReason::UnknownSourceOption
    );
    let converge = DatabaseSelectOptionMapping::new(
      &first.config,
      &field(&["b"]).config,
      BTreeMap::from([("a".into(), "b".into())]),
    )
    .unwrap();
    assert_eq!(
      map_select_view_group_keys(
        &["a".into(), "b".into(), "__empty__".into()],
        &grouped(first.id, None),
        &fields,
        &[(first.id, &converge)]
      )
      .unwrap(),
      vec!["b", "__empty__"]
    );
  }
  #[test]
  fn ambiguous_cross_axis_keys_fail_without_guessing_a_users_selection() {
    let first = field(&["a"]);
    let second = field(&["a"]);
    let mapping = DatabaseSelectOptionMapping::new(
      &first.config,
      &field(&["b"]).config,
      BTreeMap::from([("a".into(), "b".into())]),
    )
    .unwrap();
    assert_eq!(
      map_select_view_group_keys(
        &["a".into()],
        &grouped(first.id, Some(second.id)),
        &[first.clone(), second],
        &[(first.id, &mapping)]
      )
      .unwrap_err()
      .reason,
      DatabaseSelectUpdateReason::AmbiguousGroupReference
    );
  }
}
