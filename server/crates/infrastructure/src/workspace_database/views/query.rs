// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed PostgreSQL planner for authoritative Database row queries.

use std::collections::HashMap;

use myoxus_domain::database::*;
use myoxus_domain::ids::{DatabaseFieldId, DatabaseRowId, UserId};
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub(crate) struct DatabaseQueryTables {
  pub(crate) rows: &'static str,
  pub(crate) fields: &'static str,
  pub(crate) cell_values: &'static str,
}

#[derive(Debug, Clone)]
pub(crate) enum DatabaseRowQueryBind {
  Uuid(Uuid),
  Text(String),
  TextArray(Vec<String>),
  Bool(bool),
  F64(f64),
  I64(i64),
  Json(Value),
}

#[derive(Debug, Clone)]
pub(crate) struct DatabaseRowQueryPlan {
  tables: DatabaseQueryTables,
  predicate_sql: String,
  order_sql: String,
  predicate_binds: Vec<DatabaseRowQueryBind>,
  order_binds: Vec<DatabaseRowQueryBind>,
  after: Option<DatabaseRowId>,
  offset: i64,
  limit: i64,
}

impl DatabaseRowQueryPlan {
  pub(crate) fn compile(
    query: &DatabaseRowsQuery,
    page_limit: i64,
    page_offset: i64,
    actor_id: UserId,
    fields: &[DatabaseField],
    tables: DatabaseQueryTables,
  ) -> RepoResult<Self> {
    let field_map = fields.iter().map(|field| (field.id, field)).collect::<HashMap<_, _>>();
    let mut compiler = PredicateCompiler {
      fields: &field_map,
      actor_id,
      binds: Vec::new(),
      tables,
    };
    let mut predicates = Vec::new();
    for rule in &query.filter {
      predicates.push(compiler.compile_rule(rule)?);
    }
    if let Some(group) = &query.filter_tree {
      predicates.push(compiler.compile_group(group)?);
    }
    if let Some(search) = query.search.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
      predicates.push(compiler.compile_search(search, &query.search_field_ids)?);
    }
    if let Some(window) = &query.schedule_window {
      predicates.push(compiler.compile_schedule_window(window)?);
    }

    let predicate_sql = if predicates.is_empty() {
      "TRUE".to_string()
    } else {
      predicates
        .into_iter()
        .map(|value| format!("({value})"))
        .collect::<Vec<_>>()
        .join(" AND ")
    };
    let predicate_binds = compiler.binds;
    let mut order_compiler = OrderCompiler {
      fields: &field_map,
      binds: Vec::new(),
      placeholder_offset: predicate_binds.len() + 2,
      tables,
    };
    let order_sql = order_compiler.compile(&query.sort)?;
    Ok(Self {
      tables,
      predicate_sql,
      order_sql,
      predicate_binds,
      order_binds: order_compiler.binds,
      after: query.after.as_ref().map(|cursor| cursor.id),
      offset: page_offset.max(0),
      limit: page_limit.clamp(1, 500),
    })
  }

  pub(crate) fn predicate_binds(&self) -> &[DatabaseRowQueryBind] {
    &self.predicate_binds
  }

  pub(crate) fn row_binds(&self) -> Vec<DatabaseRowQueryBind> {
    let mut binds = self.predicate_binds.clone();
    binds.extend(self.order_binds.clone());
    if let Some(after) = self.after {
      binds.push(DatabaseRowQueryBind::Uuid(after));
    }
    binds
  }

  pub(crate) fn count_sql(&self) -> String {
    format!(
      "SELECT count(*)::bigint FROM {rows_table} r \
       WHERE r.database_id = $1 AND r.deleted_at IS NULL AND ({})",
      self.predicate_sql,
      rows_table = self.tables.rows,
    )
  }

  pub(crate) fn rows_sql(&self) -> String {
    let cursor_placeholder = self.predicate_binds.len() + self.order_binds.len() + 2;
    let page_predicate = if self.after.is_some() {
      format!(
        "ranked.row_number > COALESCE((SELECT cursor_row.row_number FROM ranked cursor_row WHERE cursor_row.id = ${cursor_placeholder}), 0)"
      )
    } else {
      format!("ranked.row_number > {}", self.offset)
    };
    format!(
      r#"
        WITH filtered AS (
          SELECT r.*
          FROM {rows_table} r
          WHERE r.database_id = $1
            AND r.deleted_at IS NULL
            AND ({predicate})
        ), ranked AS (
          SELECT r.*,
                 row_number() OVER (ORDER BY {order_by}) AS row_number
          FROM filtered r
        )
        SELECT ranked.id, ranked.database_id, ranked.doc_id, ranked.title,
               ranked.position, ranked.row_kind, ranked.created_by,
               ranked.updated_by, ranked.edit_revision, ranked.created_at,
               ranked.updated_at, ranked.deleted_at
        FROM ranked
        WHERE {page_predicate}
        ORDER BY ranked.row_number
        LIMIT {limit}
      "#,
      predicate = self.predicate_sql,
      order_by = self.order_sql,
      page_predicate = page_predicate,
      limit = self.limit,
      rows_table = self.tables.rows,
    )
  }

  pub(crate) fn group_binds(
    &self,
    group_field_id: DatabaseFieldId,
    subgroup_field_id: Option<DatabaseFieldId>,
  ) -> Vec<DatabaseRowQueryBind> {
    let mut binds = self.predicate_binds.clone();
    binds.push(DatabaseRowQueryBind::Uuid(group_field_id));
    if let Some(subgroup_field_id) = subgroup_field_id {
      binds.push(DatabaseRowQueryBind::Uuid(subgroup_field_id));
    }
    binds
  }

  pub(crate) fn group_sql(
    &self,
    group_field_type: DatabaseFieldType,
    subgroup_field_type: Option<DatabaseFieldType>,
  ) -> String {
    let group_placeholder = self.predicate_binds.len() + 2;
    let group_is_multi_value = is_multi_value_group_field(group_field_type);
    let (group_expansion, group_key) = if group_is_multi_value {
      (
        format!(
          "CROSS JOIN LATERAL jsonb_array_elements_text({}) group_value",
          group_values_json("group_cell", group_field_type)
        ),
        "group_value.value".to_string(),
      )
    } else {
      (String::new(), scalar_group_value_sql("group_cell", group_field_type))
    };
    let subgroup = subgroup_field_type.map(|field_type| {
      let placeholder = group_placeholder + 1;
      let is_multi_value = is_multi_value_group_field(field_type);
      let expansion = if is_multi_value {
        format!(
          "CROSS JOIN LATERAL jsonb_array_elements_text({}) subgroup_value",
          group_values_json("subgroup_cell", field_type)
        )
      } else {
        String::new()
      };
      let key = if is_multi_value {
        "subgroup_value.value".to_string()
      } else {
        scalar_group_value_sql("subgroup_cell", field_type)
      };
      (
        format!(
          "LEFT JOIN {cells_table} subgroup_cell \
             ON subgroup_cell.row_id = r.id AND subgroup_cell.field_id = ${placeholder} \
           {expansion}",
          cells_table = self.tables.cell_values,
        ),
        key,
        is_multi_value,
      )
    });
    let subgroup_key = subgroup
      .as_ref()
      .map(|(_, key, _)| key.clone())
      .unwrap_or_else(|| "NULL::text".to_string());
    let subgroup_select = if subgroup.is_some() {
      "subgroup_key"
    } else {
      "NULL::text AS subgroup_key"
    };
    let group_by = if subgroup.is_some() {
      "GROUP BY GROUPING SETS ((key), (key, subgroup_key))"
    } else {
      "GROUP BY key"
    };
    let count = if group_is_multi_value || subgroup.as_ref().is_some_and(|(_, _, is_multi)| *is_multi) {
      "count(DISTINCT id)::bigint"
    } else {
      "count(*)::bigint"
    };
    format!(
      r#"
        WITH grouped_rows AS (
          SELECT r.id,
                 {group_key} AS key,
                 {subgroup_key} AS subgroup_key
          FROM {rows_table} r
          LEFT JOIN {cells_table} group_cell
            ON group_cell.row_id = r.id AND group_cell.field_id = ${group_placeholder}
          {group_expansion}
          {subgroup_join}
          WHERE r.database_id = $1
            AND r.deleted_at IS NULL
            AND ({predicate})
        )
        SELECT key, {subgroup_select}, {count} AS row_count
        FROM grouped_rows
        {group_by}
      "#,
      group_placeholder = group_placeholder,
      group_key = group_key,
      subgroup_key = subgroup_key,
      subgroup_select = subgroup_select,
      group_expansion = group_expansion,
      subgroup_join = subgroup.as_ref().map(|(join, _, _)| join.as_str()).unwrap_or_default(),
      predicate = self.predicate_sql,
      count = count,
      group_by = group_by,
      rows_table = self.tables.rows,
      cells_table = self.tables.cell_values,
    )
  }

  pub(crate) fn progress_binds(&self, spec: &DatabaseProgressAggregateSpec) -> Vec<DatabaseRowQueryBind> {
    let mut binds = self.predicate_binds.clone();
    binds.push(DatabaseRowQueryBind::Uuid(spec.progress_field_id));
    if let Some(status_field_id) = spec.status_field_id {
      binds.push(DatabaseRowQueryBind::Uuid(status_field_id));
      binds.push(DatabaseRowQueryBind::TextArray(spec.complete_status_option_ids.clone()));
    }
    if let Some(row_kind) = spec.row_kind {
      binds.push(DatabaseRowQueryBind::Text(row_kind.as_str().to_string()));
    }
    if let Some(blocked_by_field_id) = spec.blocked_by_field_id {
      binds.push(DatabaseRowQueryBind::Uuid(blocked_by_field_id));
    }
    if let Some((due_field_id, _)) = spec.due_field {
      binds.push(DatabaseRowQueryBind::Uuid(due_field_id));
    }
    if let Some(group_field_id) = spec.group_field_id {
      binds.push(DatabaseRowQueryBind::Uuid(group_field_id));
    }
    binds
  }

  pub(crate) fn progress_sql(
    &self,
    spec: &DatabaseProgressAggregateSpec,
    group_field_type: Option<DatabaseFieldType>,
  ) -> String {
    let progress_placeholder = self.predicate_binds.len() + 2;
    let mut next_placeholder = progress_placeholder + 1;
    let (status_join, completed_value) = if spec.status_field_id.is_some() {
      let status_placeholder = next_placeholder;
      let complete_placeholder = next_placeholder + 1;
      next_placeholder += 2;
      (
        format!(
          "LEFT JOIN {cells_table} status_cell \
           ON status_cell.row_id = r.id AND status_cell.field_id = ${status_placeholder}",
          cells_table = self.tables.cell_values,
        ),
        format!("COALESCE(status_cell.value_json #>> '{{}}' = ANY(${complete_placeholder}::text[]), false)"),
      )
    } else {
      (String::new(), "false".to_string())
    };
    let row_kind_predicate = if spec.row_kind.is_some() {
      let placeholder = next_placeholder;
      next_placeholder += 1;
      format!("AND r.row_kind = ${placeholder}")
    } else {
      String::new()
    };
    let (blocked_join, blocked_value) = if spec.blocked_by_field_id.is_some() {
      let placeholder = next_placeholder;
      next_placeholder += 1;
      (
        format!(
          "LEFT JOIN {cells_table} blocked_cell \
           ON blocked_cell.row_id = r.id AND blocked_cell.field_id = ${placeholder}",
          cells_table = self.tables.cell_values,
        ),
        "CASE WHEN jsonb_typeof(blocked_cell.value_json) = 'array' THEN jsonb_array_length(blocked_cell.value_json) > 0 ELSE false END"
          .to_string(),
      )
    } else {
      (String::new(), "false".to_string())
    };
    let (due_join, overdue_value) = if let Some((_, field_type)) = spec.due_field {
      let placeholder = next_placeholder;
      next_placeholder += 1;
      let comparison = match field_type {
        DatabaseFieldType::Date => "(due_cell.value_json->>'start')::date < CURRENT_DATE",
        DatabaseFieldType::DateTime => "(due_cell.value_json->>'start')::timestamptz < CURRENT_TIMESTAMP",
        _ => "false",
      };
      (
        format!(
          "LEFT JOIN {cells_table} due_cell \
           ON due_cell.row_id = r.id AND due_cell.field_id = ${placeholder}",
          cells_table = self.tables.cell_values,
        ),
        format!("COALESCE({comparison}, false)"),
      )
    } else {
      (String::new(), "false".to_string())
    };
    let group_projection = if let Some(group_field_type) = group_field_type {
      let values = group_values_json("group_cell", group_field_type);
      let (label_join, label_expression) = match group_field_type {
        DatabaseFieldType::User | DatabaseFieldType::Users => (
          "LEFT JOIN users group_user ON group_user.id = NULLIF(group_value.value, '__empty__')::uuid".to_string(),
          "CASE WHEN group_value.value = '__empty__' THEN NULL::text ELSE COALESCE(max(group_user.name), group_value.value) END"
            .to_string(),
        ),
        DatabaseFieldType::Relation => (
          format!(
            "LEFT JOIN {rows_table} group_target ON group_target.id = NULLIF(group_value.value, '__empty__')::uuid AND group_target.database_id = $1 AND group_target.deleted_at IS NULL",
            rows_table = self.tables.rows,
          ),
          "CASE WHEN group_value.value = '__empty__' THEN NULL::text ELSE COALESCE(max(group_target.title), group_value.value) END"
            .to_string(),
        ),
        _ => (String::new(), "NULL::text".to_string()),
      };
      format!(
        r#"
          UNION ALL
          SELECT group_value.value AS group_key,
                 {label_expression} AS group_label,
                 count(*)::bigint AS total_count,
                 count(*) FILTER (WHERE base.is_completed)::bigint AS completed_count,
                 count(*) FILTER (WHERE base.is_blocked)::bigint AS blocked_count,
                 count(*) FILTER (WHERE NOT base.is_completed AND base.is_overdue)::bigint AS overdue_count,
                 count(*)::bigint AS progress_value_count,
                 avg(COALESCE((base.progress_value #>> '{{}}')::double precision, 0.0)) AS average_progress
          FROM base
          LEFT JOIN {cells_table} group_cell
            ON group_cell.row_id = base.id AND group_cell.field_id = ${next_placeholder}
          CROSS JOIN LATERAL jsonb_array_elements_text({values}) group_value
          {label_join}
          GROUP BY group_value.value
        "#,
        cells_table = self.tables.cell_values,
      )
    } else {
      String::new()
    };
    format!(
      r#"
        WITH base AS (
          SELECT r.id,
                 progress_cell.value_json AS progress_value,
                 {completed_value} AS is_completed,
                 {blocked_value} AS is_blocked,
                 {overdue_value} AS is_overdue
          FROM {rows_table} r
          LEFT JOIN {cells_table} progress_cell
            ON progress_cell.row_id = r.id AND progress_cell.field_id = ${progress_placeholder}
          {status_join}
          {blocked_join}
          {due_join}
          WHERE r.database_id = $1
            AND r.deleted_at IS NULL
            AND ({predicate})
            {row_kind_predicate}
        )
        SELECT NULL::text AS group_key,
               NULL::text AS group_label,
               count(*)::bigint AS total_count,
               count(*) FILTER (WHERE base.is_completed)::bigint AS completed_count,
               count(*) FILTER (WHERE base.is_blocked)::bigint AS blocked_count,
               count(*) FILTER (WHERE NOT base.is_completed AND base.is_overdue)::bigint AS overdue_count,
               count(*)::bigint AS progress_value_count,
               avg(COALESCE((base.progress_value #>> '{{}}')::double precision, 0.0)) AS average_progress
        FROM base
        {group_projection}
      "#,
      progress_placeholder = progress_placeholder,
      status_join = if spec.status_field_id.is_some() {
        status_join
      } else {
        // Keep the CTE projection stable without adding a bind for a missing
        // status field.
        "LEFT JOIN LATERAL (SELECT NULL::jsonb AS value_json) status_cell ON true".to_string()
      },
      predicate = self.predicate_sql,
      completed_value = completed_value,
      blocked_join = blocked_join,
      blocked_value = blocked_value,
      due_join = due_join,
      overdue_value = overdue_value,
      row_kind_predicate = row_kind_predicate,
      group_projection = group_projection,
      rows_table = self.tables.rows,
      cells_table = self.tables.cell_values,
    )
  }
}

struct PredicateCompiler<'a> {
  fields: &'a HashMap<DatabaseFieldId, &'a DatabaseField>,
  actor_id: UserId,
  binds: Vec<DatabaseRowQueryBind>,
  tables: DatabaseQueryTables,
}

impl PredicateCompiler<'_> {
  fn bind(&mut self, value: DatabaseRowQueryBind) -> usize {
    self.binds.push(value);
    self.binds.len() + 1
  }

  fn compile_group(&mut self, group: &DatabaseFilterGroup) -> RepoResult<String> {
    let mut children = Vec::new();
    for rule in &group.rules {
      children.push(self.compile_rule(rule)?);
    }
    for child in &group.groups {
      children.push(self.compile_group(child)?);
    }
    if children.is_empty() {
      return Err(RepositoryError::Validation(
        "database filter group cannot be empty".to_string(),
      ));
    }
    let conjunction = match group.conjunction {
      DatabaseFilterConjunction::And => " AND ",
      DatabaseFilterConjunction::Or => " OR ",
    };
    Ok(format!("({})", children.join(conjunction)))
  }

  fn compile_search(&mut self, search: &str, field_ids: &[DatabaseFieldId]) -> RepoResult<String> {
    let pattern = format!("%{}%", escape_like(search.to_lowercase()));
    let mut fields = Vec::new();
    for field_id in field_ids {
      let field = self.field(*field_id)?.clone();
      if field.field_type == DatabaseFieldType::Title {
        let value = self.bind(DatabaseRowQueryBind::Text(pattern.clone()));
        fields.push(format!("lower(r.title) LIKE ${value} ESCAPE '\\'"));
        continue;
      }
      let field_bind = self.bind(DatabaseRowQueryBind::Uuid(field.id));
      let value = self.bind(DatabaseRowQueryBind::Text(pattern.clone()));
      let expression = text_expression(field.field_type, "cv");
      fields.push(format!(
        "EXISTS (SELECT 1 FROM {cells_table} cv \
         WHERE cv.row_id = r.id AND cv.field_id = ${field_bind} \
         AND lower(COALESCE({expression}, '')) LIKE ${value} ESCAPE '\\')",
        cells_table = self.tables.cell_values,
      ));
    }
    if fields.is_empty() {
      return Err(RepositoryError::Validation(
        "database search requires at least one server-searchable field".to_string(),
      ));
    }
    Ok(format!("({})", fields.join(" OR ")))
  }

  fn compile_schedule_window(&mut self, window: &DatabaseScheduleWindow) -> RepoResult<String> {
    if window.end < window.start {
      return Err(RepositoryError::Validation(
        "database schedule window end cannot be before start".to_string(),
      ));
    }
    let start_field = self.field(window.field_id)?.clone();
    let end_field = window
      .end_field_id
      .map(|field_id| self.field(field_id).cloned())
      .transpose()?;
    let temporal = |field_type| {
      matches!(
        field_type,
        DatabaseFieldType::Date
          | DatabaseFieldType::DateTime
          | DatabaseFieldType::CreatedTime
          | DatabaseFieldType::UpdatedTime
      )
    };
    if !temporal(start_field.field_type) || end_field.as_ref().is_some_and(|field| !temporal(field.field_type)) {
      return Err(RepositoryError::Validation(
        "database schedule window requires date, datetime, created-time or updated-time fields".to_string(),
      ));
    }
    if window.all_day_calendar {
      let row_start = self.schedule_boundary_expression(&start_field, false, true);
      let row_end = match end_field.as_ref() {
        Some(field) => self.schedule_boundary_expression(field, false, true),
        None => self.schedule_boundary_expression(&start_field, true, true),
      };
      let start_bind = self.bind(DatabaseRowQueryBind::Text(window.start.to_rfc3339()));
      let end_bind = self.bind(DatabaseRowQueryBind::Text(window.end.to_rfc3339()));
      // Unscheduled/invalid ranges stay reachable as pinned Row diagnoses.
      // An absent separate end is a point at the start, never the start range's end.
      // This predicate also owns group counts; no client regrouping is needed.
      return Ok(format!(
        "(({row_start}) IS NULL OR ({row_end}) < ({row_start}) OR \
         (({row_start}) <= ${end_bind}::timestamptz AND COALESCE(({row_end}), ({row_start})) >= ${start_bind}::timestamptz))"
      ));
    }
    if end_field.is_none()
      && matches!(
        start_field.field_type,
        DatabaseFieldType::Date | DatabaseFieldType::DateTime
      )
    {
      let field_bind = self.bind(DatabaseRowQueryBind::Uuid(start_field.id));
      let start_bind = self.bind(DatabaseRowQueryBind::Text(window.start.to_rfc3339()));
      let end_bind = self.bind(DatabaseRowQueryBind::Text(window.end.to_rfc3339()));
      let (cell_start, cell_end, window_start, window_end) = if start_field.field_type == DatabaseFieldType::Date {
        (
          "(schedule_cell.value_json ->> 'start')::date",
          "COALESCE(schedule_cell.value_json ->> 'end', schedule_cell.value_json ->> 'start')::date",
          format!("(${start_bind}::timestamptz AT TIME ZONE 'UTC')::date"),
          format!("(${end_bind}::timestamptz AT TIME ZONE 'UTC')::date"),
        )
      } else {
        (
          "(schedule_cell.value_json ->> 'start')::timestamptz",
          "COALESCE(schedule_cell.value_json ->> 'end', schedule_cell.value_json ->> 'start')::timestamptz",
          format!("${start_bind}::timestamptz"),
          format!("${end_bind}::timestamptz"),
        )
      };
      return Ok(format!(
        "EXISTS (SELECT 1 FROM {cells_table} schedule_cell \
         WHERE schedule_cell.row_id = r.id AND schedule_cell.field_id = ${field_bind} \
         AND schedule_cell.value_json IS NOT NULL \
         AND {cell_start} <= {window_end} AND {cell_end} >= {window_start})",
        cells_table = self.tables.cell_values,
      ));
    }
    let row_start = self.schedule_boundary_expression(&start_field, false, false);
    let effective_row_end = if let Some(end_field) = end_field.as_ref() {
      self.schedule_boundary_expression(end_field, false, false)
    } else {
      self.schedule_boundary_expression(&start_field, true, false)
    };
    let start_bind = self.bind(DatabaseRowQueryBind::Text(window.start.to_rfc3339()));
    let end_bind = self.bind(DatabaseRowQueryBind::Text(window.end.to_rfc3339()));
    Ok(format!(
      "({row_start}) <= ${end_bind}::timestamptz AND ({effective_row_end}) >= ${start_bind}::timestamptz",
    ))
  }

  /// Project a persisted cell boundary or a row-owned metadata timestamp to
  /// one UTC instant. Date-only values use UTC midnight; this keeps mixed
  /// Date/DateTime end fields comparable without introducing locale-dependent
  /// SQL casts. Missing values yield NULL; the window owner decides whether
  /// to retain a diagnostic Row or exclude it from overlap.
  fn schedule_boundary_expression(
    &mut self,
    field: &DatabaseField,
    use_range_end: bool,
    all_day_calendar: bool,
  ) -> String {
    match field.field_type {
      DatabaseFieldType::CreatedTime => "r.created_at".to_string(),
      DatabaseFieldType::UpdatedTime => "r.updated_at".to_string(),
      DatabaseFieldType::Date | DatabaseFieldType::DateTime => {
        let field_bind = self.bind(DatabaseRowQueryBind::Uuid(field.id));
        let value = if use_range_end {
          "COALESCE(schedule_cell.value_json ->> 'end', schedule_cell.value_json ->> 'start')"
        } else {
          "schedule_cell.value_json ->> 'start'"
        };
        let instant = if field.field_type == DatabaseFieldType::Date {
          format!("(({value})::date::timestamp AT TIME ZONE 'UTC')")
        } else if all_day_calendar {
          // Calendar geometry uses the stored IANA day only for all-day values.
          // Timed values and the legacy Calendar/Timeline query remain instants.
          format!(
            "CASE WHEN (schedule_cell.value_json ->> 'allDay')::boolean IS TRUE             THEN CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names zone WHERE zone.name = schedule_cell.value_json ->> 'timeZone')             THEN ((({value})::timestamptz AT TIME ZONE (schedule_cell.value_json ->> 'timeZone'))::date::timestamp AT TIME ZONE 'UTC')             ELSE NULL END ELSE ({value})::timestamptz END"
          )
        } else {
          format!("({value})::timestamptz")
        };
        format!(
          "SELECT {instant} FROM {cells_table} schedule_cell \
           WHERE schedule_cell.row_id = r.id AND schedule_cell.field_id = ${field_bind} \
           AND schedule_cell.value_json IS NOT NULL",
          cells_table = self.tables.cell_values,
        )
      }
      _ => "NULL::timestamptz".to_string(),
    }
  }

  fn compile_rule(&mut self, rule: &DatabaseFilterRule) -> RepoResult<String> {
    let field = self.field(rule.field_id)?.clone();
    if field.field_type == DatabaseFieldType::Title {
      return self.compile_title_rule(rule);
    }
    if matches!(
      field.field_type,
      DatabaseFieldType::CreatedTime | DatabaseFieldType::UpdatedTime
    ) {
      let expression = if field.field_type == DatabaseFieldType::CreatedTime {
        "r.created_at"
      } else {
        "r.updated_at"
      };
      return self.compile_scalar_rule(rule, &field, expression, None);
    }
    let field_bind = self.bind(DatabaseRowQueryBind::Uuid(field.id));
    let empty = format!(
      "NOT EXISTS (SELECT 1 FROM {cells_table} cv \
       WHERE cv.row_id = r.id AND cv.field_id = ${field_bind} \
       AND cv.value_json IS NOT NULL AND cv.value_json NOT IN ('\"\"'::jsonb, '[]'::jsonb))",
      cells_table = self.tables.cell_values,
    );
    if rule.operator == DatabaseFilterOperator::Empty {
      return Ok(empty);
    }
    if rule.operator == DatabaseFilterOperator::NotEmpty {
      return Ok(format!("NOT ({empty})"));
    }
    if rule.operator == DatabaseFilterOperator::Unchecked {
      return Ok(format!(
        "NOT EXISTS (SELECT 1 FROM {cells_table} cv \
         WHERE cv.row_id = r.id AND cv.field_id = ${field_bind} \
           AND (cv.value_json #>> '{{}}')::boolean = true)",
        cells_table = self.tables.cell_values,
      ));
    }
    let value_expression = value_expression(field.field_type, "cv");
    let predicate = self.compile_scalar_predicate(rule, &field, &value_expression)?;
    let exists = format!(
      "EXISTS (SELECT 1 FROM {cells_table} cv \
       WHERE cv.row_id = r.id AND cv.field_id = ${field_bind} AND ({predicate}))",
      cells_table = self.tables.cell_values,
    );
    Ok(if is_negative_operator(rule.operator) {
      format!("NOT ({exists})")
    } else {
      exists
    })
  }

  fn compile_title_rule(&mut self, rule: &DatabaseFilterRule) -> RepoResult<String> {
    if rule.operator == DatabaseFilterOperator::Empty {
      return Ok("trim(r.title) = ''".to_string());
    }
    if rule.operator == DatabaseFilterOperator::NotEmpty {
      return Ok("trim(r.title) <> ''".to_string());
    }
    let field = self.field(rule.field_id)?.clone();
    self.compile_scalar_rule(rule, &field, "lower(r.title)", None)
  }

  fn compile_scalar_rule(
    &mut self,
    rule: &DatabaseFilterRule,
    field: &DatabaseField,
    expression: &str,
    negative_wrapper: Option<&str>,
  ) -> RepoResult<String> {
    let predicate = self.compile_scalar_predicate(rule, field, expression)?;
    Ok(match negative_wrapper {
      Some(wrapper) => format!("{wrapper} ({predicate})"),
      None if is_negative_operator(rule.operator) => format!("NOT ({predicate})"),
      None => predicate,
    })
  }

  fn compile_scalar_predicate(
    &mut self,
    rule: &DatabaseFilterRule,
    field: &DatabaseField,
    expression: &str,
  ) -> RepoResult<String> {
    use DatabaseFilterOperator as Operator;
    use DatabaseFilterValue as FilterValue;

    if rule.operator == Operator::On {
      let bind = self.bind(scalar_bind(&rule.value)?);
      return Ok(match field.field_type {
        DatabaseFieldType::Date => format!("({expression}) = ${bind}::date"),
        DatabaseFieldType::DateTime | DatabaseFieldType::CreatedTime | DatabaseFieldType::UpdatedTime => {
          format!("({expression})::date = (${bind}::timestamptz)::date")
        }
        _ => {
          return Err(RepositoryError::Validation(
            "database on filter requires a date-shaped field".to_string(),
          ));
        }
      });
    }
    let comparison = |operator| match operator {
      Operator::Is | Operator::Equals => Some("="),
      Operator::IsNot | Operator::NotEquals => Some("="),
      Operator::Greater => Some(">"),
      Operator::Less => Some("<"),
      Operator::GreaterOrEqual => Some(">="),
      Operator::LessOrEqual => Some("<="),
      Operator::Before => Some("<"),
      Operator::After => Some(">"),
      _ => None,
    };
    if let Some(operator) = comparison(rule.operator) {
      let bind = self.bind(scalar_bind(&rule.value)?);
      let comparison = format!("{expression} {operator} ${bind}");
      return match &rule.value {
        FilterValue::Currency(value) => {
          let currency_bind = self.bind(DatabaseRowQueryBind::Text(value.currency_code.clone()));
          Ok(format!(
            "({comparison}) AND cv.value_json->>'currencyCode' = ${currency_bind}"
          ))
        }
        _ => Ok(comparison),
      };
    }
    match (&rule.operator, &rule.value) {
      (Operator::Contains | Operator::DoesNotContain, FilterValue::Text(value)) => {
        let bind = self.bind(DatabaseRowQueryBind::Text(format!(
          "%{}%",
          escape_like(value.to_lowercase())
        )));
        Ok(format!("lower(COALESCE({expression}, '')) LIKE ${bind} ESCAPE '\\'"))
      }
      (Operator::Contains | Operator::DoesNotContain, FilterValue::OptionId(value)) => {
        if matches!(
          field.field_type,
          DatabaseFieldType::MultiSelect | DatabaseFieldType::Tags
        ) {
          let bind = self.bind(DatabaseRowQueryBind::Text(value.clone()));
          Ok(format!("cv.value_json ? ${bind}"))
        } else {
          let bind = self.bind(DatabaseRowQueryBind::Text(format!(
            "%{}%",
            escape_like(value.to_lowercase())
          )));
          Ok(format!("lower(COALESCE({expression}, '')) LIKE ${bind} ESCAPE '\\'"))
        }
      }
      (Operator::StartsWith, FilterValue::Text(value)) => {
        let bind = self.bind(DatabaseRowQueryBind::Text(format!(
          "{}%",
          escape_like(value.to_lowercase())
        )));
        Ok(format!("lower(COALESCE({expression}, '')) LIKE ${bind} ESCAPE '\\'"))
      }
      (Operator::EndsWith, FilterValue::Text(value)) => {
        let bind = self.bind(DatabaseRowQueryBind::Text(format!(
          "%{}",
          escape_like(value.to_lowercase())
        )));
        Ok(format!("lower(COALESCE({expression}, '')) LIKE ${bind} ESCAPE '\\'"))
      }
      (Operator::ContainsUser | Operator::DoesNotContainUser, FilterValue::UserId(value)) => {
        let bind = self.bind(DatabaseRowQueryBind::Text(value.to_string()));
        Ok(if field.field_type == DatabaseFieldType::User {
          format!("cv.value_json #>> '{{}}' = ${bind}")
        } else {
          format!("cv.value_json ? ${bind}")
        })
      }
      (Operator::ContainsRow | Operator::DoesNotContainRow, FilterValue::RelationRowId(value)) => {
        let bind = self.bind(DatabaseRowQueryBind::Text(value.to_string()));
        Ok(format!("cv.value_json ? ${bind}"))
      }
      (Operator::ContainsAll, FilterValue::Ids(values)) => {
        let bind = self.bind(DatabaseRowQueryBind::Json(serde_json::json!(values)));
        Ok(format!("cv.value_json @> ${bind}::jsonb"))
      }
      (Operator::AnyOf | Operator::NoneOf, FilterValue::Ids(values)) => {
        let bind = self.bind(DatabaseRowQueryBind::TextArray(values.clone()));
        Ok(format!("({expression}) = ANY(${bind}::text[])"))
      }
      (Operator::GroupIs | Operator::GroupIsNot, FilterValue::OptionId(group)) => {
        let values = status_group_option_ids(field, &[group.as_str()]);
        let bind = self.bind(DatabaseRowQueryBind::TextArray(values));
        Ok(format!("({expression}) = ANY(${bind}::text[])"))
      }
      (Operator::GroupAnyOf | Operator::GroupNoneOf, FilterValue::Ids(groups)) => {
        let groups = groups.iter().map(String::as_str).collect::<Vec<_>>();
        let values = status_group_option_ids(field, &groups);
        let bind = self.bind(DatabaseRowQueryBind::TextArray(values));
        Ok(format!("({expression}) = ANY(${bind}::text[])"))
      }
      (Operator::Checked, FilterValue::None) => Ok(format!("{expression} = true")),
      (Operator::Unchecked, FilterValue::None) => Ok(format!("COALESCE({expression}, false) = false")),
      (Operator::CurrentUser, FilterValue::None) => {
        let bind = self.bind(DatabaseRowQueryBind::Text(self.actor_id.to_string()));
        Ok(if field.field_type == DatabaseFieldType::User {
          format!("cv.value_json #>> '{{}}' = ${bind}")
        } else {
          format!("cv.value_json ? ${bind}")
        })
      }
      (Operator::Between, value) => self.compile_between(expression, value),
      (Operator::Relative, FilterValue::RelativeDate(preset)) => Ok(relative_date_sql(expression, *preset)),
      _ => Err(RepositoryError::Validation(format!(
        "unsupported database filter plan for {}",
        rule.operator.as_str()
      ))),
    }
  }

  fn compile_between(&mut self, expression: &str, value: &DatabaseFilterValue) -> RepoResult<String> {
    let (start, end) = range_binds(value)?;
    let mut predicates = Vec::new();
    if let Some(start) = start {
      let bind = self.bind(start);
      predicates.push(format!("{expression} >= ${bind}"));
    }
    if let Some(end) = end {
      let bind = self.bind(end);
      predicates.push(format!("{expression} <= ${bind}"));
    }
    if predicates.is_empty() {
      return Err(RepositoryError::Validation(
        "database between filter requires a bound".to_string(),
      ));
    }
    if let DatabaseFilterValue::CurrencyRange(value) = value {
      let bind = self.bind(DatabaseRowQueryBind::Text(value.currency_code.clone()));
      predicates.push(format!("cv.value_json->>'currencyCode' = ${bind}"));
    }
    Ok(predicates.join(" AND "))
  }

  fn field(&self, field_id: DatabaseFieldId) -> RepoResult<&DatabaseField> {
    self
      .fields
      .get(&field_id)
      .copied()
      .ok_or_else(|| RepositoryError::Validation("database query references an unknown field".to_string()))
  }
}

struct OrderCompiler<'a> {
  fields: &'a HashMap<DatabaseFieldId, &'a DatabaseField>,
  binds: Vec<DatabaseRowQueryBind>,
  placeholder_offset: usize,
  tables: DatabaseQueryTables,
}

impl OrderCompiler<'_> {
  fn bind(&mut self, value: DatabaseRowQueryBind) -> usize {
    self.binds.push(value);
    self.placeholder_offset + self.binds.len() - 1
  }

  fn compile(&mut self, rules: &[DatabaseSortRule]) -> RepoResult<String> {
    let mut clauses = Vec::new();
    for rule in rules {
      let field = self
        .fields
        .get(&rule.field_id)
        .copied()
        .ok_or_else(|| RepositoryError::Validation("database sort references an unknown field".to_string()))?;
      if !field.field_type.supports_saved_sort() {
        return Err(RepositoryError::Validation(
          "database sort references a field without typed ordering semantics".to_string(),
        ));
      }
      let direction = if rule.direction.is_descending() { "DESC" } else { "ASC" };
      let expression = match field.field_type {
        DatabaseFieldType::Title => "lower(r.title)".to_string(),
        DatabaseFieldType::CreatedTime => "r.created_at".to_string(),
        DatabaseFieldType::UpdatedTime => "r.updated_at".to_string(),
        DatabaseFieldType::User => {
          let field_bind = self.bind(DatabaseRowQueryBind::Uuid(field.id));
          format!(
            "(SELECT lower(u.name) FROM {cells_table} cv \
             JOIN users u ON u.id = (cv.value_json #>> '{{}}')::uuid \
             WHERE cv.row_id = r.id AND cv.field_id = ${field_bind})",
            cells_table = self.tables.cell_values,
          )
        }
        DatabaseFieldType::Users => {
          let field_bind = self.bind(DatabaseRowQueryBind::Uuid(field.id));
          format!(
            "(SELECT string_agg(lower(u.name), E'\\x1f' ORDER BY lower(u.name), u.id) \
             FROM {cells_table} cv \
             CROSS JOIN LATERAL jsonb_array_elements_text(cv.value_json) user_id \
             JOIN users u ON u.id = user_id.value::uuid \
             WHERE cv.row_id = r.id AND cv.field_id = ${field_bind})",
            cells_table = self.tables.cell_values,
          )
        }
        DatabaseFieldType::Select | DatabaseFieldType::Status => {
          let field_bind = self.bind(DatabaseRowQueryBind::Uuid(field.id));
          format!(
            "(SELECT (option_value->>'position')::integer \
             FROM {cells_table} cv \
             JOIN {fields_table} f ON f.id = cv.field_id \
             CROSS JOIN LATERAL jsonb_array_elements(f.config_json->'options') option_value \
             WHERE cv.row_id = r.id AND cv.field_id = ${field_bind} \
               AND option_value->>'id' = cv.value_json #>> '{{}}' LIMIT 1)",
            cells_table = self.tables.cell_values,
            fields_table = self.tables.fields,
          )
        }
        _ => {
          let field_bind = self.bind(DatabaseRowQueryBind::Uuid(field.id));
          let expression = value_expression(field.field_type, "cv");
          format!(
            "(SELECT {expression} FROM {cells_table} cv \
             WHERE cv.row_id = r.id AND cv.field_id = ${field_bind} LIMIT 1)",
            cells_table = self.tables.cell_values,
          )
        }
      };
      clauses.push(format!("{expression} {direction} NULLS LAST"));
    }
    clauses.push("r.position ASC".to_string());
    clauses.push("r.id ASC".to_string());
    Ok(clauses.join(", "))
  }
}

fn text_expression(field_type: DatabaseFieldType, alias: &str) -> String {
  match field_type {
    DatabaseFieldType::RichText => format!("{alias}.value_json->>'plainText'"),
    DatabaseFieldType::Currency => format!("{alias}.value_json->>'amount'"),
    DatabaseFieldType::Duration => format!("{alias}.value_json->>'minutes'"),
    DatabaseFieldType::Date | DatabaseFieldType::DateTime => format!("{alias}.value_json->>'start'"),
    _ => format!("{alias}.value_json #>> '{{}}'"),
  }
}

fn value_expression(field_type: DatabaseFieldType, alias: &str) -> String {
  match field_type {
    DatabaseFieldType::Number | DatabaseFieldType::Percent => {
      format!("({alias}.value_json #>> '{{}}')::double precision")
    }
    DatabaseFieldType::UniqueId => format!("({alias}.value_json->>'sequence')::double precision"),
    DatabaseFieldType::Currency => format!("({alias}.value_json->>'amount')::double precision"),
    DatabaseFieldType::Duration => format!("({alias}.value_json->>'minutes')::bigint"),
    DatabaseFieldType::Date => format!("({alias}.value_json->>'start')::date"),
    DatabaseFieldType::DateTime => format!("({alias}.value_json->>'start')::timestamptz"),
    DatabaseFieldType::Checkbox => format!("({alias}.value_json #>> '{{}}')::boolean"),
    DatabaseFieldType::RichText => format!("lower({alias}.value_json->>'plainText')"),
    _ => format!("lower({alias}.value_json #>> '{{}}')"),
  }
}

fn group_values_json(alias: &str, field_type: DatabaseFieldType) -> String {
  if is_multi_value_group_field(field_type) {
    // Empty/blank memberships and repeated values match the Application read
    // projection. DISTINCT counting still protects subgroup cross-products.
    return format!(
      "COALESCE((SELECT jsonb_agg(DISTINCT item.value) FROM jsonb_array_elements_text(      CASE WHEN jsonb_typeof({alias}.value_json) = 'array' THEN {alias}.value_json ELSE '[]'::jsonb END) item(value)       WHERE btrim(item.value) <> ''), '[\"__empty__\"]'::jsonb)"
    );
  }
  // Progress also consumes this helper for scalar fields. Preserve its scalar
  // expansion rather than treating every consumer as a multi-value catalog.
  let non_empty = match field_type {
    DatabaseFieldType::Date | DatabaseFieldType::DateTime => {
      format!("jsonb_build_array(to_jsonb({alias}.value_json->>'start'))")
    }
    _ => format!("jsonb_build_array({alias}.value_json)"),
  };
  format!(
    "CASE WHEN {alias}.value_json IS NULL OR {alias}.value_json IN ('\"\"'::jsonb, '[]'::jsonb)     THEN '[\"__empty__\"]'::jsonb ELSE {non_empty} END"
  )
}

fn is_multi_value_group_field(field_type: DatabaseFieldType) -> bool {
  matches!(
    field_type,
    DatabaseFieldType::MultiSelect | DatabaseFieldType::Tags | DatabaseFieldType::Users | DatabaseFieldType::Relation
  )
}

fn scalar_group_value_sql(alias: &str, field_type: DatabaseFieldType) -> String {
  let value = match field_type {
    DatabaseFieldType::Date => format!("{alias}.value_json->>'start'"),
    DatabaseFieldType::DateTime => {
      format!("(({alias}.value_json->>'start')::timestamptz AT TIME ZONE 'UTC')::date::text")
    }
    DatabaseFieldType::CreatedTime => "(r.created_at AT TIME ZONE 'UTC')::date::text".to_string(),
    DatabaseFieldType::UpdatedTime => "(r.updated_at AT TIME ZONE 'UTC')::date::text".to_string(),
    _ => format!("{alias}.value_json #>> '{{}}'"),
  };
  format!("CASE WHEN btrim(COALESCE({value}, '')) = '' THEN '__empty__' ELSE {value} END")
}

fn scalar_bind(value: &DatabaseFilterValue) -> RepoResult<DatabaseRowQueryBind> {
  match value {
    DatabaseFilterValue::Text(value) | DatabaseFilterValue::OptionId(value) => {
      Ok(DatabaseRowQueryBind::Text(value.to_lowercase()))
    }
    DatabaseFilterValue::Number(value) => Ok(DatabaseRowQueryBind::F64(*value)),
    DatabaseFilterValue::Currency(value) => Ok(DatabaseRowQueryBind::F64(value.amount)),
    DatabaseFilterValue::Duration(value) => Ok(DatabaseRowQueryBind::I64(value.minutes)),
    DatabaseFilterValue::Date(value) => Ok(DatabaseRowQueryBind::Text(value.to_string())),
    DatabaseFilterValue::Instant(value) => Ok(DatabaseRowQueryBind::Text(value.to_rfc3339())),
    DatabaseFilterValue::UserId(value) => Ok(DatabaseRowQueryBind::Text(value.to_string())),
    DatabaseFilterValue::RelationRowId(value) => Ok(DatabaseRowQueryBind::Text(value.to_string())),
    DatabaseFilterValue::Boolean(value) => Ok(DatabaseRowQueryBind::Bool(*value)),
    _ => Err(RepositoryError::Validation(
      "database filter requires a scalar value".to_string(),
    )),
  }
}

fn range_binds(
  value: &DatabaseFilterValue,
) -> RepoResult<(Option<DatabaseRowQueryBind>, Option<DatabaseRowQueryBind>)> {
  let result = match value {
    DatabaseFilterValue::NumberRange(value) => (
      value.start.map(DatabaseRowQueryBind::F64),
      value.end.map(DatabaseRowQueryBind::F64),
    ),
    DatabaseFilterValue::CurrencyRange(value) => (
      value.start.map(DatabaseRowQueryBind::F64),
      value.end.map(DatabaseRowQueryBind::F64),
    ),
    DatabaseFilterValue::DurationRange(value) => (
      value.start_minutes.map(DatabaseRowQueryBind::I64),
      value.end_minutes.map(DatabaseRowQueryBind::I64),
    ),
    DatabaseFilterValue::DateRange(value) => (
      value.start.map(|value| DatabaseRowQueryBind::Text(value.to_string())),
      value.end.map(|value| DatabaseRowQueryBind::Text(value.to_string())),
    ),
    DatabaseFilterValue::InstantRange(value) => (
      value.start.map(|value| DatabaseRowQueryBind::Text(value.to_rfc3339())),
      value.end.map(|value| DatabaseRowQueryBind::Text(value.to_rfc3339())),
    ),
    _ => {
      return Err(RepositoryError::Validation(
        "database between filter requires a range value".to_string(),
      ));
    }
  };
  Ok(result)
}

fn is_negative_operator(operator: DatabaseFilterOperator) -> bool {
  matches!(
    operator,
    DatabaseFilterOperator::DoesNotContain
      | DatabaseFilterOperator::IsNot
      | DatabaseFilterOperator::NotEquals
      | DatabaseFilterOperator::NoneOf
      | DatabaseFilterOperator::GroupIsNot
      | DatabaseFilterOperator::GroupNoneOf
      | DatabaseFilterOperator::DoesNotContainUser
      | DatabaseFilterOperator::DoesNotContainRow
  )
}

fn status_group_option_ids(field: &DatabaseField, groups: &[&str]) -> Vec<String> {
  let DatabaseFieldConfig::Status(config) = &field.config else {
    return Vec::new();
  };
  config
    .options
    .iter()
    .filter(|option| groups.contains(&option.group.as_str()))
    .map(|option| option.id.clone())
    .collect()
}

fn relative_date_sql(expression: &str, preset: DatabaseRelativeDatePreset) -> String {
  match preset {
    DatabaseRelativeDatePreset::Today => format!("({expression})::date = CURRENT_DATE"),
    DatabaseRelativeDatePreset::Yesterday => format!("({expression})::date = CURRENT_DATE - 1"),
    DatabaseRelativeDatePreset::Tomorrow => format!("({expression})::date = CURRENT_DATE + 1"),
    DatabaseRelativeDatePreset::Next7Days => {
      format!("({expression})::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7")
    }
    DatabaseRelativeDatePreset::Past7Days => {
      format!("({expression})::date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE")
    }
    DatabaseRelativeDatePreset::CurrentWeek => {
      format!("date_trunc('week', {expression}) = date_trunc('week', CURRENT_TIMESTAMP)")
    }
    DatabaseRelativeDatePreset::CurrentMonth => {
      format!("date_trunc('month', {expression}) = date_trunc('month', CURRENT_TIMESTAMP)")
    }
    DatabaseRelativeDatePreset::CurrentYear => {
      format!("date_trunc('year', {expression}) = date_trunc('year', CURRENT_TIMESTAMP)")
    }
    DatabaseRelativeDatePreset::Overdue => format!("({expression})::date < CURRENT_DATE"),
  }
}

fn escape_like(value: String) -> String {
  value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[cfg(test)]
mod tests {
  use chrono::{NaiveDate, TimeZone, Utc};

  use super::*;

  const TEST_TABLES: DatabaseQueryTables = DatabaseQueryTables {
    rows: "database_rows",
    fields: "database_fields",
    cell_values: "database_cell_values",
  };

  fn field(database_id: Uuid, field_type: DatabaseFieldType, position: i32) -> DatabaseField {
    DatabaseField {
      id: Uuid::new_v4(),
      database_id,
      name: format!("{field_type:?}"),
      field_type,
      config: DatabaseFieldConfig::empty_for(field_type),
      position,
      required: field_type == DatabaseFieldType::Title,
      edit_revision: 1,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    }
  }

  fn rule(field: &DatabaseField, operator: DatabaseFilterOperator, value: DatabaseFilterValue) -> DatabaseFilterRule {
    DatabaseFilterRule {
      field_id: field.id,
      operator,
      value,
    }
  }

  #[test]
  fn planner_binds_nested_filter_and_search_values_before_ranking() {
    let database_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let title = field(database_id, DatabaseFieldType::Title, 0);
    let number = field(database_id, DatabaseFieldType::Number, 1);
    let labels = field(database_id, DatabaseFieldType::MultiSelect, 2);
    let query = DatabaseRowsQuery {
      view_id: Some(Uuid::new_v4()),
      sort: vec![
        DatabaseSortRule {
          field_id: number.id,
          direction: DatabaseSortDirection::Desc,
        },
        DatabaseSortRule {
          field_id: title.id,
          direction: DatabaseSortDirection::Asc,
        },
      ],
      filter_tree: Some(DatabaseFilterGroup {
        conjunction: DatabaseFilterConjunction::Or,
        rules: vec![rule(
          &number,
          DatabaseFilterOperator::Between,
          DatabaseFilterValue::NumberRange(DatabaseNumberRange {
            start: Some(10.0),
            end: Some(20.0),
          }),
        )],
        groups: vec![DatabaseFilterGroup {
          conjunction: DatabaseFilterConjunction::And,
          rules: vec![rule(
            &labels,
            DatabaseFilterOperator::ContainsAll,
            DatabaseFilterValue::Ids(vec!["alpha".to_string(), "beta".to_string()]),
          )],
          groups: Vec::new(),
        }],
      }),
      search: Some("needle_%".to_string()),
      search_field_ids: vec![title.id],
      first: Some(25),
      ..Default::default()
    };

    let plan = DatabaseRowQueryPlan::compile(&query, 25, 0, actor_id, &[title, number, labels], TEST_TABLES)
      .expect("complete typed query must compile");
    let rows_sql = plan.rows_sql();
    assert!(rows_sql.contains("WITH filtered AS"));
    assert!(rows_sql.contains("row_number() OVER"));
    assert!(rows_sql.contains("FROM filtered r"));
    assert!(!rows_sql.contains("needle_%"), "search values must remain binds");
    assert!(!rows_sql.contains("alpha"), "filter values must remain binds");
    assert_eq!(plan.predicate_binds().len(), 6);
  }

  #[test]
  fn progress_plan_keeps_project_metrics_and_relation_labels_in_one_acl_query() {
    let database_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let progress = field(database_id, DatabaseFieldType::Percent, 0);
    let status = field(database_id, DatabaseFieldType::Status, 1);
    let phase = field(database_id, DatabaseFieldType::Relation, 2);
    let blocked_by = field(database_id, DatabaseFieldType::Relation, 3);
    let due = field(database_id, DatabaseFieldType::DateTime, 4);
    let plan = DatabaseRowQueryPlan::compile(
      &DatabaseRowsQuery::default(),
      100,
      0,
      actor_id,
      &[
        progress.clone(),
        status.clone(),
        phase.clone(),
        blocked_by.clone(),
        due.clone(),
      ],
      TEST_TABLES,
    )
    .expect("Project Progress query must compile");
    let spec = DatabaseProgressAggregateSpec {
      progress_field_id: progress.id,
      status_field_id: Some(status.id),
      complete_status_option_ids: vec!["status.done".to_string()],
      group_field_id: Some(phase.id),
      blocked_by_field_id: Some(blocked_by.id),
      due_field: Some((due.id, due.field_type)),
      row_kind: Some(DatabaseRowKind::Task),
    };
    let sql = plan.progress_sql(&spec, Some(phase.field_type));

    assert!(sql.contains("r.row_kind = $"));
    assert!(sql.contains("jsonb_array_length(blocked_cell.value_json)"));
    assert!(sql.contains("CURRENT_TIMESTAMP"));
    assert!(sql.contains("count(*) FILTER (WHERE base.is_blocked)"));
    assert!(sql.contains("count(*) FILTER (WHERE NOT base.is_completed AND base.is_overdue)"));
    assert!(sql.contains("group_target.title"));
    assert!(sql.contains("NULLIF(group_value.value, '__empty__')::uuid"));
    assert_eq!(plan.progress_binds(&spec).len(), 7);
    // Normalize relation memberships in the actual ACL-bound aggregate. A
    // repeated/blank membership must not duplicate a group or invent its label.
    assert!(sql.contains("jsonb_agg(DISTINCT item.value)"));
    assert!(sql.contains("jsonb_typeof(group_cell.value_json) = 'array'"));
    assert!(sql.contains("WHERE btrim(item.value) <> ''"));
    assert!(sql.contains("'[\"__empty__\"]'::jsonb"));
  }

  #[test]
  fn planner_compiles_every_typed_operator_family_without_value_interpolation() {
    let database_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let text = field(database_id, DatabaseFieldType::Text, 0);
    let number = field(database_id, DatabaseFieldType::Number, 1);
    let date = field(database_id, DatabaseFieldType::Date, 2);
    let instant = field(database_id, DatabaseFieldType::DateTime, 3);
    let user = field(database_id, DatabaseFieldType::Users, 4);
    let relation = field(database_id, DatabaseFieldType::Relation, 5);
    let checkbox = field(database_id, DatabaseFieldType::Checkbox, 6);
    let select = field(database_id, DatabaseFieldType::Select, 7);
    let fields = vec![
      text.clone(),
      number.clone(),
      date.clone(),
      instant.clone(),
      user.clone(),
      relation.clone(),
      checkbox.clone(),
      select.clone(),
    ];
    let user_id = Uuid::new_v4();
    let row_id = Uuid::new_v4();
    let instant_value = Utc.with_ymd_and_hms(2026, 7, 11, 12, 0, 0).unwrap();
    let cases = vec![
      rule(&text, DatabaseFilterOperator::Empty, DatabaseFilterValue::None),
      rule(&text, DatabaseFilterOperator::NotEmpty, DatabaseFilterValue::None),
      rule(
        &text,
        DatabaseFilterOperator::Contains,
        DatabaseFilterValue::Text("secret".to_string()),
      ),
      rule(
        &text,
        DatabaseFilterOperator::DoesNotContain,
        DatabaseFilterValue::Text("secret".to_string()),
      ),
      rule(
        &text,
        DatabaseFilterOperator::Is,
        DatabaseFilterValue::Text("secret".to_string()),
      ),
      rule(
        &text,
        DatabaseFilterOperator::IsNot,
        DatabaseFilterValue::Text("secret".to_string()),
      ),
      rule(
        &text,
        DatabaseFilterOperator::StartsWith,
        DatabaseFilterValue::Text("sec".to_string()),
      ),
      rule(
        &text,
        DatabaseFilterOperator::EndsWith,
        DatabaseFilterValue::Text("ret".to_string()),
      ),
      rule(
        &number,
        DatabaseFilterOperator::Equals,
        DatabaseFilterValue::Number(12.0),
      ),
      rule(
        &number,
        DatabaseFilterOperator::NotEquals,
        DatabaseFilterValue::Number(12.0),
      ),
      rule(
        &number,
        DatabaseFilterOperator::Greater,
        DatabaseFilterValue::Number(12.0),
      ),
      rule(&number, DatabaseFilterOperator::Less, DatabaseFilterValue::Number(12.0)),
      rule(
        &number,
        DatabaseFilterOperator::GreaterOrEqual,
        DatabaseFilterValue::Number(12.0),
      ),
      rule(
        &number,
        DatabaseFilterOperator::LessOrEqual,
        DatabaseFilterValue::Number(12.0),
      ),
      rule(
        &number,
        DatabaseFilterOperator::Between,
        DatabaseFilterValue::NumberRange(DatabaseNumberRange {
          start: Some(10.0),
          end: Some(20.0),
        }),
      ),
      rule(
        &select,
        DatabaseFilterOperator::AnyOf,
        DatabaseFilterValue::Ids(vec!["a".to_string(), "b".to_string()]),
      ),
      rule(
        &select,
        DatabaseFilterOperator::NoneOf,
        DatabaseFilterValue::Ids(vec!["a".to_string(), "b".to_string()]),
      ),
      rule(&checkbox, DatabaseFilterOperator::Checked, DatabaseFilterValue::None),
      rule(&checkbox, DatabaseFilterOperator::Unchecked, DatabaseFilterValue::None),
      rule(
        &user,
        DatabaseFilterOperator::ContainsUser,
        DatabaseFilterValue::UserId(user_id),
      ),
      rule(
        &user,
        DatabaseFilterOperator::DoesNotContainUser,
        DatabaseFilterValue::UserId(user_id),
      ),
      rule(&user, DatabaseFilterOperator::CurrentUser, DatabaseFilterValue::None),
      rule(
        &relation,
        DatabaseFilterOperator::ContainsRow,
        DatabaseFilterValue::RelationRowId(row_id),
      ),
      rule(
        &relation,
        DatabaseFilterOperator::DoesNotContainRow,
        DatabaseFilterValue::RelationRowId(row_id),
      ),
      rule(
        &date,
        DatabaseFilterOperator::On,
        DatabaseFilterValue::Date(NaiveDate::from_ymd_opt(2026, 7, 11).unwrap()),
      ),
      rule(
        &instant,
        DatabaseFilterOperator::Before,
        DatabaseFilterValue::Instant(instant_value),
      ),
      rule(
        &instant,
        DatabaseFilterOperator::After,
        DatabaseFilterValue::Instant(instant_value),
      ),
      rule(
        &instant,
        DatabaseFilterOperator::Relative,
        DatabaseFilterValue::RelativeDate(DatabaseRelativeDatePreset::CurrentWeek),
      ),
    ];

    for filter in cases {
      let query = DatabaseRowsQuery {
        filter: vec![filter],
        ..Default::default()
      };
      let plan = DatabaseRowQueryPlan::compile(&query, 10, 0, actor_id, &fields, TEST_TABLES)
        .expect("validated operator/value family must compile");
      assert!(!plan.rows_sql().contains("secret"), "text operands must remain binds");
      assert!(
        !plan.rows_sql().contains(&user_id.to_string()),
        "user ids must remain binds"
      );
      assert!(
        !plan.rows_sql().contains(&row_id.to_string()),
        "row ids must remain binds"
      );
    }
  }

  #[test]
  fn custom_sort_cursor_pages_by_rank_not_physical_position() {
    let database_id = Uuid::new_v4();
    let number = field(database_id, DatabaseFieldType::Number, 0);
    let cursor_id = Uuid::new_v4();
    let query = DatabaseRowsQuery {
      sort: vec![DatabaseSortRule {
        field_id: number.id,
        direction: DatabaseSortDirection::Desc,
      }],
      after: Some(DatabaseRowCursor {
        position: 999,
        id: cursor_id,
      }),
      ..Default::default()
    };
    let plan = DatabaseRowQueryPlan::compile(&query, 10, 0, Uuid::new_v4(), &[number], TEST_TABLES).unwrap();
    let sql = plan.rows_sql();
    assert!(sql.contains("cursor_row.row_number"));
    assert!(!sql.contains("r.position, r.id) >"));
    assert!(matches!(plan.row_binds().last(), Some(DatabaseRowQueryBind::Uuid(value)) if *value == cursor_id));
  }

  #[test]
  fn scalar_group_plan_avoids_array_expansion_and_distinct_counting() {
    let database_id = Uuid::new_v4();
    let select = field(database_id, DatabaseFieldType::Select, 0);
    let plan = DatabaseRowQueryPlan::compile(
      &DatabaseRowsQuery::default(),
      10,
      0,
      Uuid::new_v4(),
      std::slice::from_ref(&select),
      TEST_TABLES,
    )
    .unwrap();

    let sql = plan.group_sql(select.field_type, None);
    assert!(!sql.contains("jsonb_array_elements_text"));
    assert!(sql.contains("count(*)::bigint"));
    assert!(!sql.contains("count(DISTINCT id)"));
  }

  #[test]
  fn multi_value_group_plan_retains_row_deduplication() {
    let database_id = Uuid::new_v4();
    let labels = field(database_id, DatabaseFieldType::MultiSelect, 0);
    let status = field(database_id, DatabaseFieldType::Status, 1);
    let plan = DatabaseRowQueryPlan::compile(
      &DatabaseRowsQuery::default(),
      10,
      0,
      Uuid::new_v4(),
      &[labels.clone(), status.clone()],
      TEST_TABLES,
    )
    .unwrap();

    let sql = plan.group_sql(labels.field_type, Some(status.field_type));
    assert!(sql.contains("jsonb_array_elements_text"));
    assert!(sql.contains("count(DISTINCT id)::bigint"));
    assert!(sql.contains("GROUPING SETS ((key), (key, subgroup_key))"));
  }

  #[test]
  fn planner_rejects_field_kinds_without_stable_saved_sort_semantics() {
    let database_id = Uuid::new_v4();
    let files = field(database_id, DatabaseFieldType::Files, 0);
    let query = DatabaseRowsQuery {
      sort: vec![DatabaseSortRule {
        field_id: files.id,
        direction: DatabaseSortDirection::Asc,
      }],
      ..Default::default()
    };

    let error = DatabaseRowQueryPlan::compile(&query, 10, 0, Uuid::new_v4(), &[files], TEST_TABLES)
      .expect_err("Files JSON must never be used as an accidental ordering key");
    assert!(matches!(error, RepositoryError::Validation(_)));
  }

  #[test]
  fn schedule_window_is_an_inclusive_composed_sql_predicate() {
    let database_id = Uuid::new_v4();
    let starts = field(database_id, DatabaseFieldType::DateTime, 0);
    let query = DatabaseRowsQuery {
      schedule_window: Some(DatabaseScheduleWindow {
        all_day_calendar: false,
        field_id: starts.id,
        end_field_id: None,
        start: Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap(),
        end: Utc.with_ymd_and_hms(2026, 7, 31, 23, 59, 59).unwrap(),
      }),
      ..Default::default()
    };
    let plan = DatabaseRowQueryPlan::compile(&query, 25, 0, Uuid::new_v4(), &[starts], TEST_TABLES)
      .expect("DateTime overlap window must compile");
    let sql = plan.rows_sql();
    assert!(sql.contains("schedule_cell.value_json ->> 'start'"));
    assert!(sql.contains("COALESCE(schedule_cell.value_json ->> 'end'"));
    assert!(sql.contains("<=") && sql.contains(">="));
    assert_eq!(plan.predicate_binds().len(), 3, "field, start and end remain binds");
  }

  #[test]
  fn schedule_window_uses_separate_end_field_for_interval_overlap() {
    let database_id = Uuid::new_v4();
    let starts = field(database_id, DatabaseFieldType::DateTime, 0);
    let ends = field(database_id, DatabaseFieldType::Date, 1);
    let query = DatabaseRowsQuery {
      schedule_window: Some(DatabaseScheduleWindow {
        all_day_calendar: false,
        field_id: starts.id,
        end_field_id: Some(ends.id),
        start: Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap(),
        end: Utc.with_ymd_and_hms(2026, 7, 31, 23, 59, 59).unwrap(),
      }),
      ..Default::default()
    };
    let plan = DatabaseRowQueryPlan::compile(&query, 25, 0, Uuid::new_v4(), &[starts, ends], TEST_TABLES)
      .expect("separate temporal end field must compile");
    let sql = plan.rows_sql();
    assert_eq!(sql.matches("schedule_cell.field_id").count(), 2);
    assert!(sql.contains("::date::timestamp AT TIME ZONE 'UTC'"));
    assert!(sql.contains("<=$") || sql.contains("<= $"));
    assert!(sql.contains(">=$") || sql.contains(">= $"));
    assert_eq!(
      plan.predicate_binds().len(),
      4,
      "two fields and two window bounds are binds"
    );
  }

  #[test]
  fn schedule_window_projects_created_and_updated_time_from_rows() {
    let database_id = Uuid::new_v4();
    let created = field(database_id, DatabaseFieldType::CreatedTime, 0);
    let updated = field(database_id, DatabaseFieldType::UpdatedTime, 1);
    let query = DatabaseRowsQuery {
      schedule_window: Some(DatabaseScheduleWindow {
        all_day_calendar: false,
        field_id: created.id,
        end_field_id: Some(updated.id),
        start: Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap(),
        end: Utc.with_ymd_and_hms(2026, 7, 31, 23, 59, 59).unwrap(),
      }),
      ..Default::default()
    };
    let plan = DatabaseRowQueryPlan::compile(&query, 25, 0, Uuid::new_v4(), &[created, updated], TEST_TABLES)
      .expect("row-owned temporal projections must compile");
    let sql = plan.rows_sql();
    assert!(sql.contains("r.created_at"));
    assert!(sql.contains("r.updated_at"));
    assert!(!sql.contains("schedule_cell.field_id"));
    assert_eq!(
      plan.predicate_binds().len(),
      2,
      "only window bounds are bound for projections"
    );
  }
}
