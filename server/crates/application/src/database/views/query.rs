// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseViewService {
  /// Read the count-free Database projection used by mixed page inventories.
  pub async fn list_database_page_identities(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    page: PageRequest,
    lifecycle: DatabaseLifecycleFilter,
  ) -> DatabaseResult<Vec<DatabasePageIdentity>> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    let page = crate::database::views::rules::clamp_page(&self.limits, page);
    let Some(cache) = self.page_inventory_cache.as_ref() else {
      return self
        .view_query_repo
        .list_database_page_identities(workspace_id, page, lifecycle)
        .await
        .map_err(Into::into);
    };
    let lifecycle_key = match lifecycle {
      DatabaseLifecycleFilter::Active => "active",
      DatabaseLifecycleFilter::Trashed => "trashed",
      DatabaseLifecycleFilter::Any => "any",
    };
    for _ in 0..3 {
      let revision = self
        .view_query_repo
        .database_page_inventory_revision(workspace_id)
        .await?;
      let version = format!("contract-v1:{revision}");
      let repo = self.view_query_repo.clone();
      let cache = cache.clone();
      let load_version = version.clone();
      let load_page = page.clone();
      let result: Result<Vec<DatabasePageIdentity>, Arc<RepositoryError>> = self
        .page_inventory_loads
        .try_get_with(
          (
            workspace_id,
            lifecycle_key.to_string(),
            page.limit,
            page.offset,
            revision,
          ),
          async move {
            if let Some(rows) = cache
              .get_database_page_inventory(
                workspace_id,
                lifecycle_key,
                load_page.limit,
                load_page.offset,
                &load_version,
              )
              .await
            {
              return Ok(rows);
            }
            let snapshot = repo
              .list_database_page_identities_versioned(workspace_id, load_page.clone(), lifecycle)
              .await?;
            if snapshot.revision != revision {
              return Err(RepositoryError::Conflict("database page inventory revision"));
            }
            cache
              .set_database_page_inventory(
                workspace_id,
                lifecycle_key,
                load_page.limit,
                load_page.offset,
                &load_version,
                &snapshot.rows,
              )
              .await;
            Ok(snapshot.rows)
          },
        )
        .await;
      let rows = match result {
        Ok(rows) => rows,
        Err(error) if matches!(error.as_ref(), RepositoryError::Conflict(message) if *message == "database page inventory revision") =>
        {
          continue;
        }
        Err(error) => return Err(clone_database_repository_error(error.as_ref()).into()),
      };
      if self
        .view_query_repo
        .database_page_inventory_revision(workspace_id)
        .await?
        == revision
      {
        return Ok(rows);
      }
    }
    Ok(
      self
        .view_query_repo
        .list_database_page_identities_versioned(workspace_id, page, lifecycle)
        .await?
        .rows,
    )
  }

  pub async fn list_databases(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    page: PageRequest,
    mut filter: DatabaseInventoryFilter,
  ) -> DatabaseResult<Vec<DatabaseSummary>> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    if let Some(search) = filter.search.take() {
      let search = search.trim();
      if search.chars().count() > 200 {
        return Err(DatabaseServiceError::new(
          ERR_QUERY_INVALID,
          "database inventory search exceeds 200 characters",
        ));
      }
      filter.search = (!search.is_empty()).then(|| search.to_string());
    }
    if let Some(database_ids) = &mut filter.database_ids {
      database_ids.sort_unstable();
      database_ids.dedup();
      if database_ids.len() > 500 {
        return Err(DatabaseServiceError::new(
          ERR_QUERY_INVALID,
          "database inventory id filter exceeds 500 entries",
        ));
      }
    }
    self
      .view_query_repo
      .list_databases(
        workspace_id,
        crate::database::views::rules::clamp_page(&self.limits, page),
        filter,
      )
      .await
      .map_err(Into::into)
  }

  pub async fn get_database_summary(&self, actor: UserId, database_id: DatabaseId) -> DatabaseResult<DatabaseSummary> {
    let summary = self
      .view_query_repo
      .get_database_summary(database_id, DatabaseLifecycleFilter::Active)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database not found"))?;
    access::assert_workspace(&self.permission, actor, summary.workspace_id, WorkspaceAction::Read).await?;
    Ok(summary)
  }

  /// Authorize a workspace-scoped Database capability without loading a
  /// Database aggregate as an indirect membership probe.
  pub async fn assert_workspace_read(&self, actor: UserId, workspace_id: WorkspaceId) -> DatabaseResult<()> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await
  }
}

impl DatabaseViewService {
  #[instrument(skip(self), fields(%actor, %database_id, %row_id))]
  pub async fn task_parent(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> DatabaseResult<DatabaseTaskParentProjection> {
    let row = self
      .get_row_for_read(actor, database_id, row_id, true)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
    if row.row.database_id != database_id {
      return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"));
    }
    let projection = self.view_query_repo.task_parent(database_id, row_id).await?;
    // Reauthorize the current owner after an identity-preserving Database Move.
    access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    Ok(projection)
  }

  /// Enumerate Database scopes for operational reindexing without exposing
  /// repository or SQL details to the API composition root.
  pub async fn list_database_scopes(
    &self,
    workspace_id: Option<WorkspaceId>,
    page: PageRequest,
  ) -> DatabaseResult<Vec<(WorkspaceId, DatabaseId)>> {
    if let Some(workspace_id) = workspace_id {
      return Ok(
        self
          .view_query_repo
          .list_databases(workspace_id, page, DatabaseInventoryFilter::default())
          .await?
          .into_iter()
          .map(|database| (workspace_id, database.id))
          .collect(),
      );
    }
    Ok(self.view_query_repo.list_database_scopes(page).await?)
  }

  pub async fn list_rows(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    page: PageRequest,
  ) -> DatabaseResult<DatabaseRowsPage> {
    self
      .list_rows_query(actor, database_id, page, DatabaseRowsQuery::default())
      .await
  }

  /// Reads one live Row through the same workspace ACL and projection path as
  /// paged Database queries. Deep links use this contract so opening Side Peek
  /// never depends on the target Row being present in the current page.
  pub async fn get_row(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> DatabaseResult<Option<DatabaseRowRead>> {
    self.get_row_for_read(actor, database_id, row_id, false).await
  }

  /// Resolve an Inbox target against its retained scope, including recoverable
  /// Trash. No stored title grants access or follows a moved Database/Row.
  #[instrument(skip_all)]
  pub async fn notification_row_target(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> DatabaseResult<Option<(DatabaseSummary, DatabaseRow)>> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    let Some((owner, row)) = access::row_read_owner(
      &self.permission,
      &self.schema_repo,
      &self.row_repo,
      actor,
      database_id,
      row_id,
      Some(workspace_id),
    )
    .await?
    else {
      return Ok(None);
    };
    let database_id = owner.database.id;
    let Some(current) = self
      .view_query_repo
      .get_database_summary(database_id, DatabaseLifecycleFilter::Any)
      .await?
    else {
      return Ok(None);
    };
    if current.workspace_id != workspace_id {
      return Ok(None);
    }
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    Ok(Some((current, row.row)))
  }

  /// Canonical authorized projection for a read-only Trash consumer. This
  /// does not change the live-only reader used by existing editable surfaces.
  #[instrument(skip(self))]
  pub async fn get_row_for_read(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    include_trashed: bool,
  ) -> DatabaseResult<Option<DatabaseRowRead>> {
    let Some((database, mut row)) = access::row_read_owner(
      &self.permission,
      &self.schema_repo,
      &self.row_repo,
      actor,
      database_id,
      row_id,
      None,
    )
    .await?
    else {
      return Ok(None);
    };
    if (!include_trashed && row.row.deleted_at.is_some()) || database.database.deleted_at.is_some() {
      return Ok(None);
    }
    crate::database::views::projection::attach_projection_cells(&mut row, &database.fields);
    Ok(Some(DatabaseRowRead {
      row: row.row,
      cells: row.cells,
      cell_revisions: row.cell_revisions,
      group_keys: Vec::new(),
      redacted: false,
    }))
  }

  pub async fn list_rows_query(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    page: PageRequest,
    query: DatabaseRowsQuery,
  ) -> DatabaseResult<DatabaseRowsPage> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let query = self.apply_view_user_state(actor, query, &record).await?;
    let (sort, filter, filter_tree, search) = Self::resolve_rows_query(&record, query.clone())?;
    let page = crate::database::views::rules::clamp_page(&self.limits, page);
    if sort.is_empty()
      && filter.is_empty()
      && filter_tree.is_none()
      && search.is_none()
      && query.schedule_window.is_none()
      && query.after.is_none()
    {
      let mut page = self.list_rows_unfiltered(&record, page).await?;
      Self::project_view_group_keys(&record, query.view_id, &mut page.rows);
      return Ok(page);
    }

    let search_field_ids = Self::view_search_field_ids(&record, query.view_id);
    Self::validate_search_fields(search.as_deref(), &search_field_ids)?;
    let first_limit = query
      .first
      .map(|value| value.clamp(1, self.limits.max_rows_per_page))
      .unwrap_or(page.limit);
    let repository_query = DatabaseRowsQuery {
      view_id: query.view_id,
      sort,
      filter,
      filter_tree,
      search,
      search_field_ids,
      schedule_window: query.schedule_window,
      first: query.first,
      after: query.after,
    };
    let records = self
      .view_query_repo
      .list_rows_filtered_paged(
        database_id,
        actor,
        repository_query,
        PageRequest {
          limit: first_limit,
          offset: page.offset,
        },
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    let mut rows = Self::row_records_to_readable(records.rows, &record.fields);
    Self::project_view_group_keys(&record, query.view_id, &mut rows);
    let end_cursor = rows.last().map(|row| {
      DatabaseRowCursor {
        position: row.row.position,
        id: row.row.id,
      }
      .encode()
    });
    Ok(DatabaseRowsPage {
      rows,
      total_count: records.total_count,
      end_cursor,
    })
  }

  pub(in crate::database) fn project_view_group_keys(
    record: &DatabaseRecord,
    view_id: Option<DatabaseViewId>,
    rows: &mut [DatabaseRowRead],
  ) {
    let field = view_id
      .and_then(|id| record.views.iter().find(|view| view.id == id))
      .and_then(|view| match &view.config {
        DatabaseViewConfig::Gantt(config) => config.group.as_ref(),
        _ => None,
      })
      .and_then(|rule| record.fields.iter().find(|field| field.id == rule.field_id));
    for row in rows {
      row.group_keys = if row.redacted {
        Vec::new()
      } else {
        field
          .map(|field| {
            Self::row_group_keys(row, field)
              .into_iter()
              .map(|(key, _)| key)
              .collect()
          })
          .unwrap_or_default()
      };
    }
  }

  /// Schedule views search their saved title and visible searchable fields.
  /// Group aggregates reuse this resolver so counts cannot drift from Rows.
  pub(in crate::database) fn view_search_field_ids(
    record: &DatabaseRecord,
    view_id: Option<DatabaseViewId>,
  ) -> Vec<DatabaseFieldId> {
    let Some(view) = view_id.and_then(|id| record.views.iter().find(|view| view.id == id)) else {
      return Vec::new();
    };
    let (title, visible) = match &view.config {
      DatabaseViewConfig::Table(config) => return config.search_field_ids.clone(),
      DatabaseViewConfig::Gantt(config) => (&config.title_field_id, &config.visible_field_ids),
      DatabaseViewConfig::Timeline(config) => (&config.title_field_id, &config.visible_field_ids),
      _ => return Vec::new(),
    };
    let mut ids = Vec::new();
    for id in std::iter::once(title).chain(visible.iter()) {
      if !ids.contains(id)
        && record
          .fields
          .iter()
          .any(|field| field.id == *id && field.field_type.supports_server_search())
      {
        ids.push(*id);
      }
    }
    ids
  }

  pub(in crate::database) fn validate_search_fields(
    search: Option<&str>,
    fields: &[DatabaseFieldId],
  ) -> DatabaseResult<()> {
    if search.is_some() && fields.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "database search requires searchable view fields",
      ));
    }
    Ok(())
  }

  /// Returns grouped row counts for a saved grouped view.
  ///
  /// This resolves the same effective query contract as `list_rows_query` and
  /// delegates counting to the repository. The Application layer only maps
  /// bounded aggregate rows to configured labels and materializes declared
  /// empty buckets; it never loads all matching rows to group them locally.
  pub async fn list_row_groups(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    search: Option<String>,
    schedule_window: Option<DatabaseScheduleWindow>,
    locale: Option<&str>,
  ) -> DatabaseResult<Vec<DatabaseRowGroupSummary>> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let view = record
      .views
      .iter()
      .find(|view| view.id == view_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "database view not found"))?;
    let (group, subgroup) = Self::view_group_rules(&view.config)?;
    let effective_query = self
      .apply_view_user_state(
        actor,
        DatabaseRowsQuery {
          view_id: Some(view_id),
          sort: Vec::new(),
          filter: Vec::new(),
          filter_tree: None,
          search,
          search_field_ids: Vec::new(),
          schedule_window: schedule_window.clone(),
          first: None,
          after: None,
        },
        &record,
      )
      .await?;
    let schedule_window = effective_query.schedule_window.clone();
    let (sort, filter, filter_tree, search) = Self::resolve_rows_query(&record, effective_query)?;
    let search_field_ids = Self::view_search_field_ids(&record, Some(view_id));
    Self::validate_search_fields(search.as_deref(), &search_field_ids)?;
    let fields_by_id = record
      .fields
      .iter()
      .map(|field| (field.id, field))
      .collect::<HashMap<_, _>>();

    let query = DatabaseRowsQuery {
      view_id: Some(view_id),
      sort,
      filter,
      filter_tree,
      search,
      search_field_ids,
      schedule_window,
      first: None,
      after: None,
    };
    let counts = self
      .view_query_repo
      .aggregate_row_groups(
        database_id,
        actor,
        query,
        group.field_id,
        subgroup.as_ref().map(|rule| rule.field_id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    let mut primary_counts = HashMap::<String, i64>::new();
    for count in &counts {
      if subgroup.is_none() || count.subgroup_key.is_none() {
        primary_counts.insert(count.key.clone(), count.row_count);
      }
    }
    let mut summaries = Self::summarize_group_counts(
      &primary_counts,
      fields_by_id.get(&group.field_id).copied(),
      group.clone(),
      matches!(&view.config, DatabaseViewConfig::Gantt(_)),
    )?;
    if let Some(subgroup) = subgroup.as_ref() {
      for summary in &mut summaries {
        let nested_counts = counts
          .iter()
          .filter(|count| count.key == summary.key)
          .filter_map(|count| count.subgroup_key.as_ref().map(|key| (key.clone(), count.row_count)))
          .collect::<HashMap<_, _>>();
        summary.groups = Self::summarize_group_counts(
          &nested_counts,
          fields_by_id.get(&subgroup.field_id).copied(),
          subgroup.clone(),
          false,
        )?;
      }
    }
    if matches!(&view.config, DatabaseViewConfig::Gantt(_)) {
      self
        .resolve_group_labels(
          actor,
          record.database.workspace_id,
          &record.fields,
          &group,
          subgroup.as_ref(),
          &mut summaries,
          locale.unwrap_or("en"),
        )
        .await?;
      // Reference labels are resolved in batches above; their display order must
      // use those names too, never the UUID order of the aggregate result.
      Self::sort_group_summaries(
        &mut summaries,
        &Self::empty_group_buckets(fields_by_id[&group.field_id], true),
        group.descending,
      );
      if let Some(rule) = subgroup.as_ref() {
        for summary in &mut summaries {
          Self::sort_group_summaries(
            &mut summary.groups,
            &Self::empty_group_buckets(fields_by_id[&rule.field_id], true),
            rule.descending,
          );
        }
      }
    }
    Ok(summaries)
  }

  /// Resolve referenced identities once per workspace after access was checked
  /// by get_database. Unknown or removed identities never leak their UUID.
  pub(in crate::database) async fn resolve_group_labels(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    fields: &[DatabaseField],
    group: &DatabaseGroupRule,
    subgroup: Option<&DatabaseGroupRule>,
    summaries: &mut [DatabaseRowGroupSummary],
    locale: &str,
  ) -> DatabaseResult<()> {
    let kinds = std::iter::once(group)
      .chain(subgroup)
      .filter_map(|rule| {
        fields
          .iter()
          .find(|field| field.id == rule.field_id)
          .map(|field| field.field_type)
      })
      .collect::<Vec<_>>();
    let mut labels = HashMap::<String, String>::new();
    if kinds.contains(&DatabaseFieldType::Tags) {
      let service = self
        .workspace_tags
        .as_ref()
        .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "workspace tag service is not configured"))?;
      for tag in service
        .list_tags(actor, workspace_id, true)
        .await
        .map_err(|error| DatabaseServiceError::new(error.code, error.message))?
      {
        labels.insert(tag.id.to_string(), tag.name);
      }
    }
    if kinds
      .iter()
      .any(|kind| matches!(kind, DatabaseFieldType::User | DatabaseFieldType::Users))
    {
      for member in self
        .workspace_store
        .accepted_members_for_lookup(workspace_id)
        .await
        .map_err(workspace_lookup_error)?
      {
        labels.insert(member.user_id.to_string(), member.display_name);
      }
    }
    fn apply(
      groups: &mut [DatabaseRowGroupSummary],
      kind: Option<DatabaseFieldType>,
      labels: &HashMap<String, String>,
      locale: &str,
    ) {
      // Translate only server-owned bucket roles. User-authored option/tag
      // names remain exact, even when they happen to equal a builtin label.
      let language = locale.split(['-', '_']).next().unwrap_or("en");
      let (empty, unavailable, checked, unchecked) = match language {
        "de" => ("Leer", "Nicht verfügbar", "Aktiviert", "Deaktiviert"),
        "fr" => ("Vide", "Indisponible", "Coché", "Non coché"),
        "es" => ("Vacío", "No disponible", "Marcado", "Sin marcar"),
        _ => ("Empty", "Unavailable", "Checked", "Unchecked"),
      };
      for group in groups {
        if group.key == "__empty__" {
          group.label = empty.to_string();
        } else if kind == Some(DatabaseFieldType::Checkbox) {
          group.label = if group.key == "true" { checked } else { unchecked }.to_string();
        } else if kind.is_some_and(|kind| {
          matches!(
            kind,
            DatabaseFieldType::Tags | DatabaseFieldType::User | DatabaseFieldType::Users
          )
        }) {
          group.label = labels
            .get(&group.key)
            .cloned()
            .unwrap_or_else(|| unavailable.to_string());
        }
      }
    }
    let kind = |rule: &DatabaseGroupRule| {
      fields
        .iter()
        .find(|field| field.id == rule.field_id)
        .map(|field| field.field_type)
    };
    apply(summaries, kind(group), &labels, locale);
    if let Some(rule) = subgroup {
      for summary in summaries {
        apply(&mut summary.groups, kind(rule), &labels, locale);
      }
    }
    Ok(())
  }

  /// Convert the SQL-pushed group counts into typed summaries while applying
  /// the same stable labels and ordering as the saved view contract.
  pub(in crate::database) fn summarize_group_counts(
    counts: &std::collections::HashMap<String, i64>,
    field: Option<&DatabaseField>,
    rule: DatabaseGroupRule,
    gantt_catalog: bool,
  ) -> DatabaseResult<Vec<DatabaseRowGroupSummary>> {
    let Some(field) = field else {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "view group references an unknown field",
      ));
    };
    let mut bucket_map = Self::empty_group_buckets(field, rule.show_empty_groups || gantt_catalog);
    // Only Gantt exposes an always-available empty lane for placement. Other
    // saved views retain their established configured-bucket semantics.
    if gantt_catalog {
      bucket_map.insert("__empty__".to_string(), Self::empty_group_bucket());
    }
    // Seed the list of keys with every configured bucket (so empty
    // groups are emitted when `show_empty_groups` is true), then merge
    // in any keys that appeared in the SQL result but were not in the
    // configured buckets.
    let mut ordered: BTreeMap<String, DatabaseRowGroupBucket> = bucket_map.clone();
    for key in counts.keys() {
      if !ordered.contains_key(key) {
        ordered.insert(
          key.clone(),
          DatabaseRowGroupBucket {
            label: key.clone(),
            order: i64::MAX,
          },
        );
      }
    }
    let mut groups: Vec<DatabaseRowGroupSummary> = ordered
      .into_iter()
      .map(|(key, bucket)| DatabaseRowGroupSummary {
        key: key.clone(),
        label: bucket.label,
        row_count: *counts.get(&key).unwrap_or(&0),
        groups: Vec::new(),
      })
      .collect();
    if !rule.show_empty_groups {
      groups.retain(|group| group.row_count > 0);
    }
    let sort_buckets = bucket_map;
    Self::sort_group_summaries(&mut groups, &sort_buckets, rule.descending);
    Ok(groups)
  }

  pub(in crate::database) fn view_group_rules(
    config: &DatabaseViewConfig,
  ) -> DatabaseResult<(DatabaseGroupRule, Option<DatabaseGroupRule>)> {
    match config {
      DatabaseViewConfig::Table(config) => Self::required_view_group(config.group.clone(), config.subgroup.clone()),
      DatabaseViewConfig::List(config) => Self::required_view_group(config.group.clone(), config.subgroup.clone()),
      DatabaseViewConfig::Gallery(config) => Self::required_view_group(config.group.clone(), config.subgroup.clone()),
      DatabaseViewConfig::Calendar(config) => Self::required_view_group(config.group.clone(), config.subgroup.clone()),
      DatabaseViewConfig::Gantt(config) => Self::required_view_group(config.group.clone(), None),
      DatabaseViewConfig::Kanban(config) => Ok((
        DatabaseGroupRule {
          field_id: config.group_field_id,
          descending: false,
          show_empty_groups: true,
        },
        None,
      )),
      DatabaseViewConfig::Timeline(_) | DatabaseViewConfig::Progress(_) => Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "database row group query requires a grouped view",
      )),
    }
  }

  pub(in crate::database) fn required_view_group(
    group: Option<DatabaseGroupRule>,
    subgroup: Option<DatabaseGroupRule>,
  ) -> DatabaseResult<(DatabaseGroupRule, Option<DatabaseGroupRule>)> {
    let Some(group) = group else {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "database row group query requires a saved group",
      ));
    };
    Ok((group, subgroup))
  }

  pub(in crate::database) fn empty_group_buckets(
    field: &DatabaseField,
    show_empty_groups: bool,
  ) -> BTreeMap<String, DatabaseRowGroupBucket> {
    let mut buckets = BTreeMap::new();
    if !show_empty_groups {
      return buckets;
    }
    match &field.config {
      DatabaseFieldConfig::Select(config) | DatabaseFieldConfig::MultiSelect(config) => {
        for option in &config.options {
          buckets.insert(
            option.id.clone(),
            DatabaseRowGroupBucket {
              label: option.name.clone(),
              order: option.position as i64,
            },
          );
        }
      }
      DatabaseFieldConfig::Status(config) => {
        for option in &config.options {
          buckets.insert(
            option.id.clone(),
            DatabaseRowGroupBucket {
              label: option.name.clone(),
              order: option.position as i64,
            },
          );
        }
      }
      _ if field.field_type == DatabaseFieldType::Checkbox => {
        buckets.insert(
          "false".to_string(),
          DatabaseRowGroupBucket {
            label: "Unchecked".to_string(),
            order: 0,
          },
        );
        buckets.insert(
          "true".to_string(),
          DatabaseRowGroupBucket {
            label: "Checked".to_string(),
            order: 1,
          },
        );
      }
      _ => {}
    }
    buckets
  }

  pub(in crate::database) fn row_group_keys(
    row: &DatabaseRowRead,
    field: &DatabaseField,
  ) -> Vec<(String, DatabaseRowGroupBucket)> {
    if field.field_type == DatabaseFieldType::CreatedTime {
      return Self::date_time_group_key(row.row.created_at);
    }
    if field.field_type == DatabaseFieldType::UpdatedTime {
      return Self::date_time_group_key(row.row.updated_at);
    }
    let value = row
      .cells
      .iter()
      .find(|cell| cell.field_id == field.id)
      .map(|cell| &cell.value);
    match value {
      Some(DatabaseCellValueData::Select(value)) | Some(DatabaseCellValueData::Status(value)) => {
        Self::non_empty_group_text(field, value)
      }
      Some(DatabaseCellValueData::MultiSelect(values)) => Self::non_empty_group_texts(field, values.iter()),
      Some(DatabaseCellValueData::Tags(values)) => {
        let values = values.iter().map(ToString::to_string).collect::<Vec<_>>();
        Self::non_empty_group_texts(field, values.iter())
      }
      Some(DatabaseCellValueData::User(value)) => vec![Self::group_bucket_for_text(field, value.to_string())],
      Some(DatabaseCellValueData::Users(values)) => {
        let values = values.iter().map(ToString::to_string).collect::<Vec<_>>();
        Self::non_empty_group_texts(field, values.iter())
      }
      Some(DatabaseCellValueData::Date(value)) => vec![Self::date_group_key(value.start)],
      Some(DatabaseCellValueData::DateTime(value)) => Self::date_time_group_key(value.start),
      Some(DatabaseCellValueData::Checkbox(value)) => vec![Self::checkbox_group_key(*value)],
      _ => vec![("__empty__".to_string(), Self::empty_group_bucket())],
    }
  }

  pub(in crate::database) fn non_empty_group_text(
    field: &DatabaseField,
    value: &str,
  ) -> Vec<(String, DatabaseRowGroupBucket)> {
    if value.trim().is_empty() {
      vec![("__empty__".to_string(), Self::empty_group_bucket())]
    } else {
      vec![Self::group_bucket_for_text(field, value.to_string())]
    }
  }

  pub(in crate::database) fn non_empty_group_texts<'a>(
    field: &DatabaseField,
    values: impl Iterator<Item = &'a String>,
  ) -> Vec<(String, DatabaseRowGroupBucket)> {
    let mut seen = HashSet::new();
    let groups = values
      .filter(|value| !value.trim().is_empty() && seen.insert((*value).clone()))
      .map(|value| Self::group_bucket_for_text(field, value.clone()))
      .collect::<Vec<_>>();
    if groups.is_empty() {
      vec![("__empty__".to_string(), Self::empty_group_bucket())]
    } else {
      groups
    }
  }

  pub(in crate::database) fn date_group_key(value: NaiveDate) -> (String, DatabaseRowGroupBucket) {
    let day = value.to_string();
    (
      day.clone(),
      DatabaseRowGroupBucket {
        label: day,
        order: value.num_days_from_ce() as i64,
      },
    )
  }

  pub(in crate::database) fn date_time_group_key(value: DateTime<Utc>) -> Vec<(String, DatabaseRowGroupBucket)> {
    let day = value.date_naive().to_string();
    vec![(
      day.clone(),
      DatabaseRowGroupBucket {
        label: day,
        order: value.timestamp_millis(),
      },
    )]
  }

  pub(in crate::database) fn checkbox_group_key(value: bool) -> (String, DatabaseRowGroupBucket) {
    (
      value.to_string(),
      if value {
        DatabaseRowGroupBucket {
          label: "Checked".to_string(),
          order: 1,
        }
      } else {
        DatabaseRowGroupBucket {
          label: "Unchecked".to_string(),
          order: 0,
        }
      },
    )
  }

  pub(in crate::database) fn group_bucket_for_text(
    field: &DatabaseField,
    value: String,
  ) -> (String, DatabaseRowGroupBucket) {
    let key = value.clone();
    let bucket = match &field.config {
      DatabaseFieldConfig::Select(config) | DatabaseFieldConfig::MultiSelect(config) => config
        .options
        .iter()
        .find(|option| option.id.eq_ignore_ascii_case(&value))
        .map(|option| DatabaseRowGroupBucket {
          label: option.name.clone(),
          order: option.position as i64,
        })
        .unwrap_or_else(|| DatabaseRowGroupBucket {
          label: value.clone(),
          order: i64::MAX / 2,
        }),
      DatabaseFieldConfig::Status(config) => config
        .options
        .iter()
        .find(|option| option.id.eq_ignore_ascii_case(&value))
        .map(|option| DatabaseRowGroupBucket {
          label: option.name.clone(),
          order: option.position as i64,
        })
        .unwrap_or_else(|| DatabaseRowGroupBucket {
          label: value.clone(),
          order: i64::MAX / 2,
        }),
      _ => DatabaseRowGroupBucket {
        label: value.clone(),
        order: i64::MAX / 2,
      },
    };
    (key, bucket)
  }

  pub(in crate::database) fn empty_group_bucket() -> DatabaseRowGroupBucket {
    DatabaseRowGroupBucket {
      label: "Empty".to_string(),
      order: i64::MAX,
    }
  }

  pub(in crate::database) fn sort_group_summaries(
    groups: &mut [DatabaseRowGroupSummary],
    buckets: &BTreeMap<String, DatabaseRowGroupBucket>,
    descending: bool,
  ) {
    groups.sort_by(|left, right| {
      let left_empty = left.key == "__empty__";
      let right_empty = right.key == "__empty__";
      if left_empty != right_empty {
        return left_empty.cmp(&right_empty);
      }
      let left_order = buckets.get(&left.key).map(|bucket| bucket.order).unwrap_or(i64::MAX);
      let right_order = buckets.get(&right.key).map(|bucket| bucket.order).unwrap_or(i64::MAX);
      let ordering = left_order
        .cmp(&right_order)
        .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
        .then_with(|| left.key.cmp(&right.key));
      if descending { ordering.reverse() } else { ordering }
    });
  }

  pub(in crate::database) async fn list_rows_unfiltered(
    &self,
    record: &DatabaseRecord,
    page: PageRequest,
  ) -> DatabaseResult<DatabaseRowsPage> {
    let rows = self.view_query_repo.list_rows(record.database.id, page).await?;
    let readable = Self::row_records_to_readable(rows, &record.fields);
    Ok(DatabaseRowsPage {
      rows: readable,
      total_count: self.view_query_repo.count_rows(record.database.id).await?,
      end_cursor: None,
    })
  }

  pub(in crate::database) fn row_records_to_readable(
    rows: Vec<DatabaseRowRecord>,
    fields: &[DatabaseField],
  ) -> Vec<DatabaseRowRead> {
    let mut readable = Vec::with_capacity(rows.len());
    for mut row in rows {
      crate::database::views::projection::attach_projection_cells(&mut row, fields);
      readable.push(DatabaseRowRead {
        row: row.row,
        cells: row.cells,
        cell_revisions: row.cell_revisions,
        group_keys: Vec::new(),
        redacted: false,
      });
    }
    readable
  }

  pub async fn progress_summary(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
  ) -> DatabaseResult<DatabaseProgressSummary> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let view = record
      .views
      .iter()
      .find(|view| view.id == view_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "database view not found"))?;
    let DatabaseViewConfig::Progress(config) = &view.config else {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "database progress query requires a progress view",
      ));
    };
    let effective_query = self
      .apply_view_user_state(
        actor,
        DatabaseRowsQuery {
          view_id: Some(view_id),
          sort: Vec::new(),
          filter: Vec::new(),
          filter_tree: None,
          search: None,
          search_field_ids: Vec::new(),
          schedule_window: None,
          first: None,
          after: None,
        },
        &record,
      )
      .await?;
    let (sort, filter, filter_tree, search) = Self::resolve_rows_query(&record, effective_query)?;
    let role_field = |role_key: &str| {
      record
        .field_roles
        .iter()
        .find(|role| role.role_key == role_key && role.row_kind_scope.as_deref() == Some("task"))
        .and_then(|role| record.fields.iter().find(|field| field.id == role.field_id))
    };
    let status_field = if record.database.profile_kind == DatabaseProfileKind::Project {
      Some(
        role_field("task.status")
          .filter(|field| field.field_type == DatabaseFieldType::Status)
          .ok_or_else(|| {
            DatabaseServiceError::new(
              ERR_FIELD_INVALID,
              "Project progress requires the typed task.status role",
            )
          })?,
      )
    } else {
      record
        .fields
        .iter()
        .find(|field| field.field_type == DatabaseFieldType::Status)
    };
    let complete_status_option_ids = status_field
      .and_then(|field| match &field.config {
        DatabaseFieldConfig::Status(config) => Some(
          config
            .options
            .iter()
            .filter(|option| option.group == DatabaseStatusGroup::Complete)
            .map(|option| option.id.clone())
            .collect::<Vec<_>>(),
        ),
        _ => None,
      })
      .unwrap_or_default();
    let query = DatabaseRowsQuery {
      view_id: Some(view_id),
      sort,
      filter,
      filter_tree,
      search,
      search_field_ids: Vec::new(),
      schedule_window: None,
      first: None,
      after: None,
    };
    let aggregates = self
      .view_query_repo
      .aggregate_progress(
        database_id,
        actor,
        query,
        DatabaseProgressAggregateSpec {
          progress_field_id: config.progress_field_id,
          status_field_id: status_field.map(|field| field.id),
          complete_status_option_ids,
          group_field_id: config.group_field_id,
          blocked_by_field_id: role_field("task.blockedBy").map(|field| field.id),
          due_field: role_field("task.dueDate").map(|field| (field.id, field.field_type)),
          row_kind: (record.database.profile_kind == DatabaseProfileKind::Project).then_some(DatabaseRowKind::Task),
        },
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    let total = aggregates
      .iter()
      .find(|aggregate| aggregate.group_key.is_none())
      .cloned()
      .unwrap_or(DatabaseProgressAggregateCount {
        group_key: None,
        group_label: None,
        total_count: 0,
        completed_count: 0,
        blocked_count: 0,
        overdue_count: 0,
        progress_value_count: 0,
        average_progress: None,
      });
    let group_field = config
      .group_field_id
      .and_then(|field_id| record.fields.iter().find(|field| field.id == field_id));
    let mut grouped = BTreeMap::<String, (DatabaseRowGroupBucket, i64, i64, i64, i64, f64, i64)>::new();
    for aggregate in aggregates.into_iter().filter(|aggregate| aggregate.group_key.is_some()) {
      let raw_key = aggregate.group_key.unwrap_or_else(|| "__empty__".to_string());
      let (key, bucket) = if let Some(field) = group_field {
        if let DatabaseFieldConfig::Status(status) = &field.config {
          status
            .options
            .iter()
            .find(|option| option.id == raw_key)
            .map(|option| {
              let key = option.group.as_str().to_string();
              let order = match option.group {
                DatabaseStatusGroup::NotStarted => 0,
                DatabaseStatusGroup::Active => 1,
                DatabaseStatusGroup::Complete => 2,
                DatabaseStatusGroup::Archived => 3,
              };
              (
                key,
                DatabaseRowGroupBucket {
                  label: Self::progress_group_label(option.group.as_str()),
                  order,
                },
              )
            })
            .unwrap_or_else(|| Self::group_bucket_for_text(field, raw_key))
        } else if raw_key == "__empty__" {
          (raw_key, Self::empty_group_bucket())
        } else {
          let (key, mut bucket) = Self::group_bucket_for_text(field, raw_key);
          if let Some(label) = aggregate.group_label.clone() {
            bucket.label = label;
          }
          (key, bucket)
        }
      } else {
        (
          raw_key.clone(),
          DatabaseRowGroupBucket {
            label: raw_key,
            order: 0,
          },
        )
      };
      let entry = grouped.entry(key).or_insert((bucket, 0, 0, 0, 0, 0.0, 0));
      entry.1 += aggregate.total_count;
      entry.2 += aggregate.completed_count;
      entry.3 += aggregate.blocked_count;
      entry.4 += aggregate.overdue_count;
      if let Some(average) = aggregate.average_progress {
        entry.5 += average * aggregate.progress_value_count as f64;
        entry.6 += aggregate.progress_value_count;
      }
    }
    let mut groups = grouped
      .into_iter()
      .map(
        |(key, (bucket, total_count, completed_count, blocked_count, overdue_count, progress_sum, progress_count))| {
          (
            bucket.clone(),
            DatabaseProgressGroupSummary {
              key,
              label: bucket.label,
              total_count,
              completed_count,
              incomplete_count: total_count - completed_count,
              blocked_count,
              overdue_count,
              average_progress: (progress_count > 0).then_some(progress_sum / progress_count as f64),
            },
          )
        },
      )
      .collect::<Vec<_>>();
    groups.sort_by(|(left_bucket, left), (right_bucket, right)| {
      left_bucket
        .order
        .cmp(&right_bucket.order)
        .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
    });
    let groups = groups.into_iter().map(|(_, group)| group).collect();
    Ok(DatabaseProgressSummary {
      view_id,
      progress_field_id: config.progress_field_id,
      group_field_id: config.group_field_id,
      total_count: total.total_count,
      completed_count: total.completed_count,
      incomplete_count: total.total_count - total.completed_count,
      blocked_count: total.blocked_count,
      overdue_count: total.overdue_count,
      average_progress: total.average_progress,
      groups,
    })
  }

  #[cfg(test)]
  pub(in crate::database) fn progress_groups_for_rows(
    rows: &[DatabaseRowRead],
    fields: &[DatabaseField],
    progress_field_id: DatabaseFieldId,
    group_field_id: Option<DatabaseFieldId>,
    status_field: Option<&DatabaseField>,
  ) -> Vec<DatabaseProgressGroupSummary> {
    let Some(group_field_id) = group_field_id else {
      return Vec::new();
    };
    let Some(group_field) = fields.iter().find(|field| field.id == group_field_id) else {
      return Vec::new();
    };
    let mut grouped: BTreeMap<String, (DatabaseRowGroupBucket, Vec<&DatabaseRowRead>)> = BTreeMap::new();
    for row in rows {
      for (key, bucket) in Self::progress_group_buckets(row, group_field) {
        grouped.entry(key).or_insert_with(|| (bucket, Vec::new())).1.push(row);
      }
    }
    let mut groups = grouped
      .into_iter()
      .map(|(key, (bucket, rows))| {
        let progress = Self::progress_counts_for_row_refs(&rows, progress_field_id, status_field);
        let label = bucket.label.clone();
        (
          bucket,
          DatabaseProgressGroupSummary {
            key,
            label,
            total_count: progress.total_count,
            completed_count: progress.completed_count,
            incomplete_count: progress.incomplete_count,
            blocked_count: 0,
            overdue_count: 0,
            average_progress: progress.average_progress,
          },
        )
      })
      .collect::<Vec<_>>();
    groups.sort_by(|(left_bucket, left), (right_bucket, right)| {
      left_bucket
        .order
        .cmp(&right_bucket.order)
        .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
        .then_with(|| left.key.cmp(&right.key))
    });
    groups.into_iter().map(|(_, group)| group).collect()
  }

  #[cfg(test)]
  pub(in crate::database) fn progress_group_buckets(
    row: &DatabaseRowRead,
    field: &DatabaseField,
  ) -> Vec<(String, DatabaseRowGroupBucket)> {
    let value = Self::row_comparable_value(row, field);
    if let Some(group) = Self::status_group_value(field, &value) {
      let order = match group {
        DatabaseStatusGroup::NotStarted => 0,
        DatabaseStatusGroup::Active => 1,
        DatabaseStatusGroup::Complete => 2,
        DatabaseStatusGroup::Archived => 3,
      };
      return vec![(
        group.as_str().to_string(),
        DatabaseRowGroupBucket {
          label: Self::progress_group_label(group.as_str()),
          order,
        },
      )];
    }
    Self::row_group_keys(row, field)
  }

  pub(in crate::database) fn progress_group_label(value: &str) -> String {
    match value {
      "notStarted" => "Not started".to_string(),
      "active" => "Active".to_string(),
      "complete" => "Complete".to_string(),
      "archived" => "Archived".to_string(),
      other => other.to_string(),
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn progress_counts_for_row_refs(
    rows: &[&DatabaseRowRead],
    progress_field_id: DatabaseFieldId,
    status_field: Option<&DatabaseField>,
  ) -> DatabaseProgressGroupSummary {
    let total_count = rows.len() as i64;
    let completed_count = rows
      .iter()
      .filter(|row| Self::row_is_complete_for_progress(row, status_field))
      .count() as i64;
    let average_progress = if rows.is_empty() {
      None
    } else {
      Some(
        rows
          .iter()
          .map(|row| Self::row_progress_percent(row, progress_field_id).unwrap_or(0.0))
          .sum::<f64>()
          / rows.len() as f64,
      )
    };
    DatabaseProgressGroupSummary {
      key: "__total__".to_string(),
      label: "Total".to_string(),
      total_count,
      completed_count,
      incomplete_count: total_count - completed_count,
      blocked_count: 0,
      overdue_count: 0,
      average_progress,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn row_progress_percent(
    row: &DatabaseRowRead,
    progress_field_id: DatabaseFieldId,
  ) -> Option<f64> {
    row
      .cells
      .iter()
      .find(|cell| cell.field_id == progress_field_id)
      .and_then(|cell| match &cell.value {
        DatabaseCellValueData::Percent(value) if value.is_finite() => Some(*value),
        _ => None,
      })
  }

  #[cfg(test)]
  pub(in crate::database) fn row_is_complete_for_progress(
    row: &DatabaseRowRead,
    status_field: Option<&DatabaseField>,
  ) -> bool {
    let Some(status_field) = status_field else {
      return false;
    };
    let value = Self::row_comparable_value(row, status_field);
    Self::status_group_value(status_field, &value) == Some(DatabaseStatusGroup::Complete)
  }

  pub(in crate::database) fn resolve_rows_query(
    record: &DatabaseRecord,
    query: DatabaseRowsQuery,
  ) -> DatabaseResult<ResolvedRowsQuery> {
    let view_config = match query.view_id {
      Some(view_id) => Some(
        record
          .views
          .iter()
          .find(|view| view.id == view_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "database view not found"))?
          .config
          .clone(),
      ),
      None => None,
    };
    let sort = if query.sort.is_empty() {
      view_config
        .as_ref()
        .map(|config| config.sort_rules().to_vec())
        .unwrap_or_default()
    } else {
      query.sort
    };
    let filter = if query.filter.is_empty() {
      view_config
        .as_ref()
        .map(|config| config.filter_rules().to_vec())
        .unwrap_or_default()
    } else {
      query.filter
    };
    let filter_tree = match query.filter_tree {
      Some(group) => Some(group),
      None => view_config
        .as_ref()
        .and_then(|config| config.filter_tree().filter(|group| !group.is_empty()).cloned()),
    };
    let fields_by_id = record
      .fields
      .iter()
      .map(|field| (field.id, field))
      .collect::<HashMap<_, _>>();
    for rule in &sort {
      if !fields_by_id.contains_key(&rule.field_id) {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view sort references an unknown field",
        ));
      }
    }
    for rule in &filter {
      let field = fields_by_id
        .get(&rule.field_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_CONFIG_INVALID, "view filter references an unknown field"))?;
      crate::database::views::rules::validate_filter_rule(field, rule)?;
    }
    if let Some(filter_tree) = &filter_tree {
      Self::validate_filter_group_for_fields(filter_tree, &fields_by_id)?;
    }
    let search = query.search.and_then(|value| {
      let trimmed = value.trim();
      (!trimmed.is_empty()).then(|| trimmed.to_lowercase())
    });
    Ok((sort, filter, filter_tree, search))
  }

  /// Applies the authenticated actor's P-DB-22 personal overrides before the
  /// shared query compiler resolves saved view defaults. Rows, grouped counts
  /// and Progress aggregates must all call this helper so they cannot drift
  /// into parallel effective-view semantics.
  pub(in crate::database) async fn apply_view_user_state(
    &self,
    actor: UserId,
    mut query: DatabaseRowsQuery,
    record: &DatabaseRecord,
  ) -> DatabaseResult<DatabaseRowsQuery> {
    if let Some(window) = query.schedule_window.as_mut() {
      window.all_day_calendar = query.view_id.is_some_and(|id| {
        record.views.iter().any(|view| {
          view.id == id
            && matches!(
              view.config,
              DatabaseViewConfig::Gantt(_) | DatabaseViewConfig::Timeline(_)
            )
        })
      });
    }
    let Some(view_id) = query.view_id else {
      return Ok(query);
    };
    let Some(personal) = self
      .view_query_repo
      .get_view_user_state(view_id, actor)
      .await
      .map_err(DatabaseServiceError::from)?
    else {
      return Ok(query);
    };
    if let Some(sort) = personal.sort {
      query.sort = sort;
    }
    if let Some(filter_tree) = personal.filter_tree {
      query.filter.clear();
      query.filter_tree = (!filter_tree.is_empty()).then_some(filter_tree);
    }
    let transient_schedule_search = query.search.is_some()
      && record.views.iter().any(|view| {
        view.id == view_id
          && matches!(
            view.config,
            DatabaseViewConfig::Gantt(_) | DatabaseViewConfig::Timeline(_)
          )
      });
    // Transient schedule demand wins over personal defaults; an explicit empty
    // string also clears that demand. Other View callers retain their contract.
    if !transient_schedule_search {
      query.search = (!personal.search_text.trim().is_empty()).then_some(personal.search_text);
    }
    Ok(query)
  }

  pub(in crate::database) fn validate_filter_group_for_fields(
    group: &DatabaseFilterGroup,
    fields_by_id: &HashMap<DatabaseFieldId, &DatabaseField>,
  ) -> DatabaseResult<()> {
    fn validate_group(
      group: &DatabaseFilterGroup,
      fields_by_id: &HashMap<DatabaseFieldId, &DatabaseField>,
      depth: usize,
    ) -> DatabaseResult<()> {
      if depth > 4 {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view filter tree is too deeply nested",
        ));
      }
      if group.rules.is_empty() && group.groups.is_empty() {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view filter tree contains an empty group",
        ));
      }
      for rule in &group.rules {
        let field = fields_by_id.get(&rule.field_id).ok_or_else(|| {
          DatabaseServiceError::new(ERR_VIEW_CONFIG_INVALID, "view filter references an unknown field")
        })?;
        crate::database::views::rules::validate_filter_rule(field, rule)?;
      }
      for child in &group.groups {
        validate_group(child, fields_by_id, depth + 1)?;
      }
      Ok(())
    }
    validate_group(group, fields_by_id, 0)
  }

  #[cfg(test)]
  pub(in crate::database) fn row_matches_filter(
    row: &DatabaseRowRead,
    fields_by_id: &HashMap<DatabaseFieldId, &DatabaseField>,
    actor: UserId,
    rule: &DatabaseFilterRule,
  ) -> bool {
    let Some(field) = fields_by_id.get(&rule.field_id) else {
      return false;
    };
    let value = Self::row_comparable_value(row, field);
    let filter = rule.value.reference_json();
    match rule.operator.as_str() {
      "empty" => Self::is_empty_comparable(&value),
      "not_empty" => !Self::is_empty_comparable(&value),
      "contains" => Self::text_or_list_contains(&value, &filter),
      "does_not_contain" => !Self::text_or_list_contains(&value, &filter),
      "contains_all" => Self::text_list_contains_all(&value, &filter),
      "is" | "equals" => Self::equals_filter_value(&value, &filter),
      "is_not" | "not_equals" => !Self::equals_filter_value(&value, &filter),
      "starts_with" => Self::text_filter_value(&filter)
        .is_some_and(|needle| Self::text_value(&value).is_some_and(|text| text.starts_with(&needle))),
      "ends_with" => Self::text_filter_value(&filter)
        .is_some_and(|needle| Self::text_value(&value).is_some_and(|text| text.ends_with(&needle))),
      "greater" => Self::numeric_filter_value(&value)
        .zip(Self::number_filter_operand(&filter))
        .is_some_and(|(left, right)| left > right),
      "less" => Self::numeric_filter_value(&value)
        .zip(Self::number_filter_operand(&filter))
        .is_some_and(|(left, right)| left < right),
      "greater_or_equal" => Self::numeric_filter_value(&value)
        .zip(Self::number_filter_operand(&filter))
        .is_some_and(|(left, right)| left >= right),
      "less_or_equal" => Self::numeric_filter_value(&value)
        .zip(Self::number_filter_operand(&filter))
        .is_some_and(|(left, right)| left <= right),
      "between" => Self::matches_between_filter(&value, &filter),
      "any_of" => Self::text_filter_list(&filter).is_some_and(|needles| {
        Self::text_value(&value).is_some_and(|text| needles.iter().any(|needle| needle == &text))
      }),
      "none_of" => Self::text_filter_list(&filter).is_some_and(|needles| {
        Self::text_value(&value).is_some_and(|text| !needles.iter().any(|needle| needle == &text))
          || Self::is_empty_comparable(&value)
      }),
      "group_is" => Self::status_group_value(field, &value)
        .zip(Self::status_group_filter_value(&filter))
        .is_some_and(|(left, right)| left == right),
      "group_is_not" => Self::status_group_value(field, &value)
        .zip(Self::status_group_filter_value(&filter))
        .is_some_and(|(left, right)| left != right),
      "group_any_of" => Self::status_group_filter_list(&filter)
        .zip(Self::status_group_value(field, &value))
        .is_some_and(|(needles, left)| needles.contains(&left)),
      "group_none_of" => Self::status_group_filter_list(&filter)
        .zip(Self::status_group_value(field, &value))
        .is_some_and(|(needles, left)| !needles.contains(&left)),
      "checked" => matches!(value, DatabaseRowComparableValue::Bool(true)),
      "unchecked" => matches!(
        value,
        DatabaseRowComparableValue::Bool(false) | DatabaseRowComparableValue::Empty
      ),
      "contains_user" | "contains_row" => Self::text_or_list_contains(&value, &filter),
      "does_not_contain_user" | "does_not_contain_row" => !Self::text_or_list_contains(&value, &filter),
      "current_user" => Self::row_contains_identity(&value, actor),
      "before" => Self::date_filter_value(&filter)
        .is_some_and(|right| Self::date_time_filter_value(&value).is_some_and(|left| left < right)),
      "after" => Self::date_filter_value(&filter)
        .is_some_and(|right| Self::date_time_filter_value(&value).is_some_and(|left| left > right)),
      "on" => Self::date_filter_value(&filter).is_some_and(|right| {
        Self::date_time_filter_value(&value).is_some_and(|left| left.date_naive() == right.date_naive())
      }),
      "relative" => {
        Self::date_time_filter_value(&value).is_some_and(|left| Self::matches_relative_date_filter(left, &filter))
      }
      _ => false,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn row_comparable_value(
    row: &DatabaseRowRead,
    field: &DatabaseField,
  ) -> DatabaseRowComparableValue {
    if field.field_type == DatabaseFieldType::Title {
      return DatabaseRowComparableValue::Text(row.row.title.to_lowercase());
    }
    if field.field_type == DatabaseFieldType::CreatedTime {
      return DatabaseRowComparableValue::DateTime(row.row.created_at);
    }
    if field.field_type == DatabaseFieldType::UpdatedTime {
      return DatabaseRowComparableValue::DateTime(row.row.updated_at);
    }
    let value = row
      .cells
      .iter()
      .find(|cell| cell.field_id == field.id)
      .map(|cell| &cell.value);
    match value {
      Some(DatabaseCellValueData::Text(value))
      | Some(DatabaseCellValueData::Select(value))
      | Some(DatabaseCellValueData::Status(value))
      | Some(DatabaseCellValueData::Url(value))
      | Some(DatabaseCellValueData::Email(value))
      | Some(DatabaseCellValueData::Phone(value)) => DatabaseRowComparableValue::Text(value.to_lowercase()),
      Some(DatabaseCellValueData::RichText(value)) => DatabaseRowComparableValue::Text(value.plain_text.to_lowercase()),
      Some(DatabaseCellValueData::Number(value)) | Some(DatabaseCellValueData::Percent(value)) => {
        DatabaseRowComparableValue::Number(*value)
      }
      Some(DatabaseCellValueData::Currency(value)) => DatabaseRowComparableValue::Number(value.amount),
      Some(DatabaseCellValueData::Duration(value)) => DatabaseRowComparableValue::Number(value.minutes as f64),
      Some(DatabaseCellValueData::Checkbox(value)) => DatabaseRowComparableValue::Bool(*value),
      Some(DatabaseCellValueData::Date(value)) => DatabaseRowComparableValue::Text(value.start.to_string()),
      Some(DatabaseCellValueData::DateTime(value)) => DatabaseRowComparableValue::DateTime(value.start),
      Some(DatabaseCellValueData::MultiSelect(values)) => {
        DatabaseRowComparableValue::TextList(values.iter().map(|value| value.to_lowercase()).collect())
      }
      Some(DatabaseCellValueData::Tags(values)) => {
        DatabaseRowComparableValue::TextList(values.iter().map(ToString::to_string).collect())
      }
      Some(DatabaseCellValueData::User(value)) => DatabaseRowComparableValue::Text(value.to_string()),
      Some(DatabaseCellValueData::Users(values)) => {
        DatabaseRowComparableValue::TextList(values.iter().map(ToString::to_string).collect())
      }
      Some(DatabaseCellValueData::Relation(values)) => {
        DatabaseRowComparableValue::TextList(values.iter().map(ToString::to_string).collect())
      }
      Some(DatabaseCellValueData::UniqueId(value)) => DatabaseRowComparableValue::Number(value.sequence as f64),
      Some(DatabaseCellValueData::CreatedTime(value)) | Some(DatabaseCellValueData::UpdatedTime(value)) => {
        DatabaseRowComparableValue::DateTime(*value)
      }
      Some(DatabaseCellValueData::CreatedBy(value)) | Some(DatabaseCellValueData::UpdatedBy(value)) => {
        DatabaseRowComparableValue::Text(value.to_string())
      }
      _ => DatabaseRowComparableValue::Empty,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn is_empty_comparable(value: &DatabaseRowComparableValue) -> bool {
    match value {
      DatabaseRowComparableValue::Empty => true,
      DatabaseRowComparableValue::Text(value) => value.trim().is_empty(),
      DatabaseRowComparableValue::TextList(values) => values.is_empty(),
      DatabaseRowComparableValue::Number(_)
      | DatabaseRowComparableValue::Bool(_)
      | DatabaseRowComparableValue::DateTime(_) => false,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn text_filter_value(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(|value| value.to_lowercase())
  }

  #[cfg(test)]
  pub(in crate::database) fn text_filter_list(value: &serde_json::Value) -> Option<Vec<String>> {
    value.as_array().map(|values| {
      values
        .iter()
        .filter_map(|value| value.as_str().map(|item| item.to_lowercase()))
        .collect()
    })
  }

  #[cfg(test)]
  pub(in crate::database) fn text_value(value: &DatabaseRowComparableValue) -> Option<String> {
    match value {
      DatabaseRowComparableValue::Text(value) => Some(value.clone()),
      DatabaseRowComparableValue::TextList(values) => Some(values.join(" ")),
      DatabaseRowComparableValue::Number(value) => Some(value.to_string()),
      DatabaseRowComparableValue::Bool(value) => Some(value.to_string()),
      DatabaseRowComparableValue::DateTime(value) => Some(value.to_rfc3339().to_lowercase()),
      DatabaseRowComparableValue::Empty => None,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn text_or_list_contains(
    value: &DatabaseRowComparableValue,
    filter: &serde_json::Value,
  ) -> bool {
    let Some(needle) = Self::text_filter_value(filter) else {
      return false;
    };
    match value {
      DatabaseRowComparableValue::Text(value) => value.contains(&needle),
      DatabaseRowComparableValue::TextList(values) => {
        values.iter().any(|value| value == &needle || value.contains(&needle))
      }
      _ => false,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn text_list_contains_all(
    value: &DatabaseRowComparableValue,
    filter: &serde_json::Value,
  ) -> bool {
    let Some(needles) = Self::text_filter_list(filter) else {
      return false;
    };
    match value {
      DatabaseRowComparableValue::TextList(values) => needles.iter().all(|needle| values.contains(needle)),
      DatabaseRowComparableValue::Text(value) => needles.iter().all(|needle| value.contains(needle)),
      _ => false,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn status_group_value(
    field: &DatabaseField,
    value: &DatabaseRowComparableValue,
  ) -> Option<DatabaseStatusGroup> {
    let DatabaseFieldConfig::Status(config) = &field.config else {
      return None;
    };
    let DatabaseRowComparableValue::Text(option_id) = value else {
      return None;
    };
    config
      .options
      .iter()
      .find(|option| option.id.eq_ignore_ascii_case(option_id))
      .map(|option| option.group)
  }

  #[cfg(test)]
  pub(in crate::database) fn status_group_filter_value(value: &serde_json::Value) -> Option<DatabaseStatusGroup> {
    let normalized = value
      .as_str()?
      .chars()
      .filter(|ch| ch.is_ascii_alphanumeric())
      .flat_map(char::to_lowercase)
      .collect::<String>();
    match normalized.as_str() {
      "notstarted" => Some(DatabaseStatusGroup::NotStarted),
      "active" => Some(DatabaseStatusGroup::Active),
      "complete" => Some(DatabaseStatusGroup::Complete),
      "archived" => Some(DatabaseStatusGroup::Archived),
      _ => None,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn status_group_filter_list(value: &serde_json::Value) -> Option<Vec<DatabaseStatusGroup>> {
    value.as_array()?.iter().map(Self::status_group_filter_value).collect()
  }

  #[cfg(test)]
  pub(in crate::database) fn row_contains_identity(value: &DatabaseRowComparableValue, identity: UserId) -> bool {
    let identity = identity.to_string();
    match value {
      DatabaseRowComparableValue::Text(value) => value == &identity,
      DatabaseRowComparableValue::TextList(values) => values.iter().any(|value| value == &identity),
      _ => false,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn equals_filter_value(
    value: &DatabaseRowComparableValue,
    filter: &serde_json::Value,
  ) -> bool {
    if let Some(right) = Self::number_filter_operand(filter) {
      return Self::numeric_filter_value(value).is_some_and(|left| (left - right).abs() < f64::EPSILON);
    }
    if let Some(needle) = Self::text_filter_value(filter) {
      return match value {
        DatabaseRowComparableValue::Text(value) => value == &needle,
        DatabaseRowComparableValue::TextList(values) => values.len() == 1 && values[0] == needle,
        _ => false,
      };
    }
    filter
      .as_bool()
      .is_some_and(|right| matches!(value, DatabaseRowComparableValue::Bool(left) if *left == right))
  }

  #[cfg(test)]
  pub(in crate::database) fn numeric_filter_value(value: &DatabaseRowComparableValue) -> Option<f64> {
    match value {
      DatabaseRowComparableValue::Number(value) if value.is_finite() => Some(*value),
      _ => None,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn number_filter_operand(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().or_else(|| {
      let object = value.as_object()?;
      object
        .get("amount")
        .or_else(|| object.get("minutes"))
        .or_else(|| object.get("sequence"))
        .and_then(serde_json::Value::as_f64)
    })
  }

  #[cfg(test)]
  pub(in crate::database) fn matches_between_filter(
    value: &DatabaseRowComparableValue,
    filter: &serde_json::Value,
  ) -> bool {
    let Some(object) = filter.as_object() else {
      return false;
    };
    if let Some(left) = Self::numeric_filter_value(value) {
      let min = object
        .get("start")
        .or_else(|| object.get("min"))
        .or_else(|| object.get("minAmount"))
        .or_else(|| object.get("minMinutes"))
        .or_else(|| object.get("minSequence"))
        .and_then(Self::number_filter_operand);
      let max = object
        .get("end")
        .or_else(|| object.get("max"))
        .or_else(|| object.get("maxAmount"))
        .or_else(|| object.get("maxMinutes"))
        .or_else(|| object.get("maxSequence"))
        .and_then(Self::number_filter_operand);
      return min.is_none_or(|min| left >= min) && max.is_none_or(|max| left <= max);
    }
    if let Some(left) = Self::date_time_filter_value(value) {
      let start = object.get("start").and_then(Self::date_filter_value);
      let end = object.get("end").and_then(Self::date_filter_value);
      return start.is_none_or(|start| left >= start) && end.is_none_or(|end| left <= end);
    }
    false
  }

  #[cfg(test)]
  pub(in crate::database) fn date_filter_value(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    let raw = value.as_str()?;
    DateTime::parse_from_rfc3339(raw)
      .map(|value| value.with_timezone(&Utc))
      .ok()
      .or_else(|| {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d")
          .ok()
          .and_then(|date| date.and_hms_opt(0, 0, 0))
          .map(|value| value.and_utc())
      })
  }

  #[cfg(test)]
  pub(in crate::database) fn date_time_filter_value(value: &DatabaseRowComparableValue) -> Option<DateTime<Utc>> {
    match value {
      DatabaseRowComparableValue::DateTime(value) => Some(*value),
      DatabaseRowComparableValue::Text(value) => serde_json::Value::String(value.clone())
        .as_str()
        .and_then(|_| Self::date_filter_value(&serde_json::Value::String(value.clone()))),
      _ => None,
    }
  }

  #[cfg(test)]
  pub(in crate::database) fn matches_relative_date_filter(left: DateTime<Utc>, filter: &serde_json::Value) -> bool {
    let Some(preset) = filter.get("preset").and_then(serde_json::Value::as_str) else {
      return false;
    };
    let today = Utc::now().date_naive();
    let value_day = left.date_naive();
    match preset.trim().to_ascii_lowercase().as_str() {
      "today" => value_day == today,
      "yesterday" => value_day == today - Duration::days(1),
      "tomorrow" => value_day == today + Duration::days(1),
      "next_7_days" | "next7_days" | "next7days" => value_day >= today && value_day <= today + Duration::days(7),
      "past_7_days" | "last_7_days" | "past7days" | "last7days" => {
        value_day <= today && value_day >= today - Duration::days(7)
      }
      "current_week" | "this_week" => {
        let week_start = today - Duration::days(today.weekday().num_days_from_monday().into());
        value_day >= week_start && value_day <= week_start + Duration::days(6)
      }
      "current_month" | "this_month" => value_day.year() == today.year() && value_day.month() == today.month(),
      "current_year" | "this_year" => value_day.year() == today.year(),
      "overdue" => value_day < today,
      _ => false,
    }
  }
}

impl DatabaseViewService {
  pub async fn relation_targets(
    &self,
    actor: UserId,
    target_row_ids: &[DatabaseRowId],
  ) -> DatabaseResult<Vec<DatabaseRelationTargetRead>> {
    let mut targets = Vec::with_capacity(target_row_ids.len());
    for row_id in target_row_ids {
      let Some(record) = self.row_repo.get_row(*row_id).await? else {
        targets.push(DatabaseRelationTargetRead {
          row_id: *row_id,
          content_document_id: None,
          title: None,
          redacted: true,
          deleted: true,
        });
        continue;
      };
      let deleted = record.row.deleted_at.is_some();
      let database = self
        .schema_repo
        .get_database(record.row.database_id)
        .await?
        .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "target database not found"))?;
      access::assert_workspace(
        &self.permission,
        actor,
        database.database.workspace_id,
        WorkspaceAction::Read,
      )
      .await?;
      targets.push(DatabaseRelationTargetRead {
        row_id: *row_id,
        content_document_id: record.row.content_document_id,
        title: Some(record.row.title),
        redacted: false,
        deleted,
      });
    }
    Ok(targets)
  }
}
