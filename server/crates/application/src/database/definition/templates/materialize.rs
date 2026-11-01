// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use serde_json::json;

#[expect(
  clippy::too_many_arguments,
  reason = "template materialization keeps actor, target, locale, and source explicit"
)]
pub fn materialize_template(
  limits: &DatabaseLimits,
  actor: UserId,
  workspace_id: WorkspaceId,
  title: &str,
  description: Option<String>,
  include_sample_rows: bool,
  default_currency: &str,
  template: DatabaseTemplateSpec,
) -> DatabaseResult<DatabaseInitialState> {
  materialize_template_reserved(
    limits,
    actor,
    workspace_id,
    title,
    description,
    include_sample_rows,
    default_currency,
    template,
    Uuid::new_v4(),
    &[],
  )
}

#[expect(
  clippy::too_many_arguments,
  reason = "native materialization keeps reserved identities and explicit creation content at one owner"
)]
pub(super) fn materialize_template_reserved(
  limits: &DatabaseLimits,
  actor: UserId,
  workspace_id: WorkspaceId,
  title: &str,
  description: Option<String>,
  include_sample_rows: bool,
  default_currency: &str,
  mut template: DatabaseTemplateSpec,
  database_id: DatabaseId,
  scaffold: &[(Uuid, DatabaseRowKind, String)],
) -> DatabaseResult<DatabaseInitialState> {
  apply_currency(&mut template, default_currency);
  let now = Utc::now();
  let mut fields = Vec::with_capacity(template.fields.len());
  let mut field_ids = BTreeMap::new();
  let mut field_types = BTreeMap::new();
  for (position, spec) in template.fields.iter().enumerate() {
    let id = Uuid::new_v4();
    let config = match &spec.config {
      DatabaseTemplateFieldConfig::Direct(config) => config.clone(),
      DatabaseTemplateFieldConfig::SelfRelation {
        allow_multiple,
        max_targets,
      } => DatabaseFieldConfig::Relation(DatabaseRelationFieldConfig {
        target_database_id: database_id,
        allow_multiple: *allow_multiple,
        reciprocal_field_id: None,
        max_targets: *max_targets,
      }),
    };
    crate::database::definition::rules::validate_field_config(spec.field_type, &config)?;
    field_ids.insert(spec.key.clone(), id);
    field_types.insert(spec.key.clone(), spec.field_type);
    fields.push(DatabaseField {
      id,
      database_id,
      name: spec.name.to_string(),
      field_type: spec.field_type,
      config,
      position: position as i32,
      required: spec.required,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    });
  }
  let field_map = fields.iter().map(|field| (field.id, field)).collect::<BTreeMap<_, _>>();
  let views = template
    .views
    .iter()
    .enumerate()
    .map(|(position, spec)| {
      let view = DatabaseView {
        id: Uuid::new_v4(),
        database_id,
        name: spec.name.to_string(),
        view_kind: spec.kind,
        icon: None,
        config: build_view_config(&spec.config, &field_ids, &field_types)?,
        position: position as i32,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      };
      crate::database::views::rules::validate_view_config(
        view.view_kind,
        &view.config,
        &fields,
        limits.max_fields_per_database,
      )?;
      Ok(view)
    })
    .collect::<DatabaseResult<Vec<_>>>()?;
  let row_templates = template
    .row_templates
    .iter()
    .enumerate()
    .map(|(position, spec)| {
      let mut initial_cell_values = BTreeMap::new();
      for (field_key, value) in &spec.initial_cells {
        let field_id = field_id(&field_ids, field_key)?;
        let Some(field) = field_map.get(&field_id).copied() else {
          return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "template row field not found"));
        };
        crate::database::editing::rules::validate_cell_value(field, value, limits)?;
        initial_cell_values.insert(field_id, value.clone());
      }
      Ok(DatabaseRowTemplate {
        edit_revision: 1,
        content_document_id: None,
        id: Uuid::new_v4(),
        workspace_id,
        database_id,
        template_id: row_template_catalog_id(&template.id, &spec.key),
        row_kind: spec.row_kind,
        name: spec.name.to_string(),
        description: spec.description.clone(),
        position: position.try_into().unwrap_or(i32::MAX),
        enabled: true,
        is_default: spec.is_default,
        initial_cell_values,
        created_by: Some(actor),
        updated_by: Some(actor),
        created_at: now,
        updated_at: now,
      })
    })
    .collect::<DatabaseResult<Vec<_>>>()?;
  let roles = template
    .roles
    .iter()
    .map(|role| {
      Ok(DatabaseFieldRole {
        database_id,
        profile_kind: template.profile_kind,
        role_key: role.role_key.to_string(),
        row_kind_scope: role.row_kind_scope.clone(),
        field_id: field_id(&field_ids, &role.field_key)?,
        required: role.required,
        config: role.config.clone(),
        created_at: now,
        updated_at: now,
      })
    })
    .collect::<DatabaseResult<Vec<_>>>()?;
  let mut rows = if include_sample_rows {
    let sample_row_ids = template
      .sample_rows
      .iter()
      .map(|row| (row.key.clone(), Uuid::new_v4()))
      .collect::<BTreeMap<_, _>>();
    template
      .sample_rows
      .iter()
      .enumerate()
      .map(|(position, row)| {
        let row_id = *sample_row_ids
          .get(&row.key)
          .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "template sample row key not found"))?;
        let mut cells = Vec::new();
        for (field_key, value) in &row.cells {
          let field_id = field_id(&field_ids, field_key)?;
          let field = fields
            .iter()
            .find(|candidate| candidate.id == field_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "template field not found"))?;
          let Some(value) =
            crate::database::editing::rules::normalize_editable_cell_value(field.field_type, value.clone(), limits)?
          else {
            continue;
          };
          crate::database::editing::rules::validate_cell_value(field, &value, limits)?;
          cells.push(DatabaseCellValue {
            row_id,
            field_id,
            field_type: field.field_type,
            value,
            updated_by: Some(actor),
            edit_revision: 1,
            updated_at: now,
          });
        }
        for (field_key, target_keys) in &row.relation_cells {
          let field_id = field_id(&field_ids, field_key)?;
          let field = fields
            .iter()
            .find(|candidate| candidate.id == field_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "template field not found"))?;
          if field.field_type != DatabaseFieldType::Relation {
            return Err(DatabaseServiceError::new(
              ERR_CELL_INVALID,
              "template hierarchy relation references a non-relation field",
            ));
          }
          let target_row_ids = target_keys
            .iter()
            .map(|target_key| {
              sample_row_ids.get(target_key).copied().ok_or_else(|| {
                DatabaseServiceError::new(ERR_CELL_INVALID, "template hierarchy references an unknown sample row")
              })
            })
            .collect::<DatabaseResult<Vec<_>>>()?;
          let value = DatabaseCellValueData::Relation(target_row_ids);
          crate::database::editing::rules::validate_cell_value(field, &value, limits)?;
          cells.push(DatabaseCellValue {
            row_id,
            field_id,
            field_type: field.field_type,
            value,
            updated_by: Some(actor),
            edit_revision: 1,
            updated_at: now,
          });
        }
        Ok(DatabaseRowRecord {
          row: DatabaseRow {
            id: row_id,
            database_id,
            content_document_id: None,
            row_kind: row.row_kind,
            title: row.title.to_string(),
            position: position as i32,
            created_by: Some(actor),
            updated_by: Some(actor),
            edit_revision: 1,
            created_at: now,
            updated_at: now,
            deleted_at: None,
          },
          cells,
          cell_revisions: Vec::new(),
        })
      })
      .collect::<DatabaseResult<Vec<_>>>()?
  } else {
    Vec::new()
  };
  let mut preceding_scaffold_phase = None;
  for (id, kind, title) in scaffold {
    if rows.iter().any(|row| row.row.id == *id) || !matches!(kind, DatabaseRowKind::Phase | DatabaseRowKind::Milestone)
    {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "invalid reserved Project scaffold identity",
      ));
    }
    let mut cells = Vec::new();
    if *kind == DatabaseRowKind::Phase {
      preceding_scaffold_phase = Some(*id);
    } else if template.default_structure == Some(DatabaseProjectStructurePreset::PhasesAndMilestones) {
      // Ordered scaffold milestones belong to the preceding scaffold phase.
      // Samples are an independent authored graph and never supply this parent.
      let phase = preceding_scaffold_phase.ok_or_else(|| {
        DatabaseServiceError::new(
          ERR_ROW_INVALID,
          "scaffold milestone requires a preceding scaffold phase",
        )
      })?;
      let phase_field = roles
        .iter()
        .find(|role| role.role_key == "milestone.phase")
        .and_then(|role| field_map.get(&role.field_id).copied())
        .ok_or_else(|| DatabaseServiceError::new(ERR_ROW_INVALID, "scaffold milestone phase role unavailable"))?;
      let value = DatabaseCellValueData::Relation(vec![phase]);
      crate::database::editing::rules::validate_cell_value(phase_field, &value, limits)?;
      cells.push(DatabaseCellValue {
        row_id: *id,
        field_id: phase_field.id,
        field_type: phase_field.field_type,
        value,
        updated_by: Some(actor),
        edit_revision: 1,
        updated_at: now,
      });
    }
    rows.push(DatabaseRowRecord {
      row: DatabaseRow {
        id: *id,
        database_id,
        content_document_id: None,
        row_kind: *kind,
        title: crate::database::definition::rules::validate_title(title)?,
        position: rows.len() as i32,
        created_by: Some(actor),
        updated_by: Some(actor),
        edit_revision: 1,
        created_at: now,
        updated_at: now,
        deleted_at: None,
      },
      cells,
      cell_revisions: Vec::new(),
    });
  }
  let mut profile_config = json!({
    "profile": template.profile_kind.as_str(),
    "structurePreset": template.default_structure.map(|preset| preset.as_str()),
    "priorityPreset": template.priority_preset.map(|preset| preset.as_str()),
    "complexityPreset": template.complexity_preset.map(|preset| preset.as_str()),
    "defaultCurrency": default_currency
  });
  if template.profile_kind == DatabaseProfileKind::Project {
    profile_config["rowIdRole"] = json!("task.id");
  }
  let view_roles = if template.profile_kind == DatabaseProfileKind::Project {
    views
      .iter()
      .map(|view| DatabaseViewRole {
        database_id,
        profile_kind: DatabaseProfileKind::Project,
        role_key: DatabaseViewRole::project_role_key(view.view_kind),
        view_id: view.id,
        required: true,
        created_at: now,
        updated_at: now,
      })
      .collect()
  } else {
    Vec::new()
  };
  validate_task_parent_rows(
    database_id,
    template.profile_kind,
    &fields,
    &roles,
    &[],
    &rows,
    &row_templates,
  )?;
  validate_task_blocked_by_rows(
    database_id,
    template.profile_kind,
    &fields,
    &roles,
    &[],
    &rows,
    &row_templates,
  )?;
  Ok(DatabaseInitialState {
    database: Database {
      system_role: None,
      managed_installation: None,

      id: database_id,
      workspace_id,
      profile_kind: template.profile_kind,
      profile_structure_preset: template.default_structure.map(|preset| preset.as_str().to_string()),
      profile_config,
      title: title.to_string(),
      description: description.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
      }),
      created_by: Some(actor),
      updated_by: Some(actor),
      deleted_at: None,
      deleted_by: None,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    },
    fields,
    views,
    roles,
    view_roles,
    rows,
    row_templates,
    workspace_tags: Vec::new(),
  })
}
pub(super) fn row_template_catalog_id(template_id: &str, row_template_key: &str) -> Uuid {
  Uuid::new_v5(
    &Uuid::NAMESPACE_OID,
    format!("{template_id}.row-template.{row_template_key}").as_bytes(),
  )
}

pub(super) fn build_view_config(
  spec: &DatabaseTemplateViewConfig,
  fields: &BTreeMap<String, DatabaseFieldId>,
  field_types: &BTreeMap<String, DatabaseFieldType>,
) -> DatabaseResult<DatabaseViewConfig> {
  let title_field_id = field_id(fields, "title")?;
  Ok(match spec {
    DatabaseTemplateViewConfig::Table { visible, group } => DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id,
      visible_field_ids: ids(fields, visible)?,
      field_widths: BTreeMap::new(),
      search_field_ids: visible
        .iter()
        .filter(|key| {
          field_types
            .get(*key)
            .is_some_and(|field_type| field_type.supports_server_search())
        })
        .map(|key| field_id(fields, key))
        .collect::<DatabaseResult<Vec<_>>>()?,
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      group: group.as_ref().map(|key| group_rule(fields, key)).transpose()?,
      subgroup: None,
    }),
    DatabaseTemplateViewConfig::Kanban { group, visible } => DatabaseViewConfig::Kanban(DatabaseKanbanViewConfig {
      title_field_id,
      group_field_id: field_id(fields, group)?,
      visible_field_ids: ids(fields, visible)?,
      cover_field_id: None,
      card_density: DatabaseCardDensity::Default,
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
    }),
    DatabaseTemplateViewConfig::List { visible, group } => DatabaseViewConfig::List(DatabaseListViewConfig {
      title_field_id,
      visible_field_ids: ids(fields, visible)?,
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      density: DatabaseListDensity::Default,
      show_field_labels: true,
      group: group.as_ref().map(|key| group_rule(fields, key)).transpose()?,
      subgroup: None,
    }),
    DatabaseTemplateViewConfig::Gallery {
      visible,
      cover,
      show_empty_cover,
      group,
    } => DatabaseViewConfig::Gallery(DatabaseGalleryViewConfig {
      title_field_id,
      visible_field_ids: ids(fields, visible)?,
      cover_field_id: cover.as_ref().map(|key| field_id(fields, key)).transpose()?,
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      card_density: DatabaseGalleryCardDensity::Default,
      show_empty_cover: *show_empty_cover,
      group: group.as_ref().map(|key| group_rule(fields, key)).transpose()?,
      subgroup: None,
    }),
    DatabaseTemplateViewConfig::Calendar { date, visible } => {
      DatabaseViewConfig::Calendar(DatabaseCalendarViewConfig {
        title_field_id,
        date_field_id: field_id(fields, date)?,
        visible_field_ids: ids(fields, visible)?,
        sort: Vec::new(),
        filter: Vec::new(),
        filter_tree: None,
        date_mode: DatabaseCalendarDateMode::Month,
        initial_range: DatabaseCalendarInitialRange::CurrentMonth,
        group: None,
        subgroup: None,
      })
    }
    DatabaseTemplateViewConfig::Timeline { start, end, visible } => {
      DatabaseViewConfig::Timeline(DatabaseTimelineViewConfig {
        title_field_id,
        start_field_id: field_id(fields, start)?,
        end_field_id: end.as_ref().map(|key| field_id(fields, key)).transpose()?,
        visible_field_ids: ids(fields, visible)?,
        sort: Vec::new(),
        filter: Vec::new(),
        filter_tree: None,
        group_by: DatabaseTimelineGroupBy::Month,
        order: DatabaseTimelineOrder::Asc,
        zoom: DatabaseTimelineZoom::Month,
      })
    }
    DatabaseTemplateViewConfig::Progress {
      progress,
      group,
      visible,
    } => DatabaseViewConfig::Progress(DatabaseProgressViewConfig {
      title_field_id,
      progress_field_id: field_id(fields, progress)?,
      group_field_id: group.as_ref().map(|key| field_id(fields, key)).transpose()?,
      visible_field_ids: ids(fields, visible)?,
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
    }),
  })
}

pub(super) fn field_id(fields: &BTreeMap<String, DatabaseFieldId>, key: &str) -> DatabaseResult<DatabaseFieldId> {
  fields
    .get(key)
    .copied()
    .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "starter template references an unknown field"))
}

pub(super) fn ids(fields: &BTreeMap<String, DatabaseFieldId>, keys: &[String]) -> DatabaseResult<Vec<DatabaseFieldId>> {
  keys.iter().map(|key| field_id(fields, key)).collect()
}

pub(super) fn group_rule(fields: &BTreeMap<String, DatabaseFieldId>, key: &str) -> DatabaseResult<DatabaseGroupRule> {
  Ok(DatabaseGroupRule {
    field_id: field_id(fields, key)?,
    descending: false,
    show_empty_groups: true,
  })
}

pub(super) fn apply_currency(template: &mut DatabaseTemplateSpec, currency: &str) {
  for field in &mut template.fields {
    if let DatabaseTemplateFieldConfig::Direct(DatabaseFieldConfig::Currency(config)) = &mut field.config {
      config.default_currency = currency.to_string();
    }
  }
  for value in template
    .sample_rows
    .iter_mut()
    .flat_map(|row| row.cells.iter_mut().map(|(_, value)| value))
    .chain(
      template
        .row_templates
        .iter_mut()
        .flat_map(|row| row.initial_cells.iter_mut().map(|(_, value)| value)),
    )
  {
    if let DatabaseCellValueData::Currency(value) = value {
      value.currency_code = currency.to_string();
    }
  }
}
