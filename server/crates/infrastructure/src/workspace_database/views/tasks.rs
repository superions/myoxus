// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace Task SQL read boundary. Only a bounded page is materialized.

use super::*;

const PROJECTS: &str = r#"
  SELECT d.id, d.workspace_id, d.title, d.deleted_at
  FROM workspace_databases d
  JOIN database_profiles profile ON profile.database_id = d.id AND profile.profile_kind = 'project'
  WHERE d.workspace_id = $1 AND d.deleted_at IS NULL AND myoxus_database_source_admitted(d.managed_installation)
"#;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn read_workspace_tasks(
    &self,
    read: DatabaseTasksRead,
  ) -> RepoResult<DatabaseTasksPage> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    self.capture_managed_admission(&mut tx).await?;
    let unavailable_rows=sqlx::query("SELECT d.id,d.title,COALESCE(d.managed_installation->>'reasonCode',CASE WHEN d.managed_installation IS NULL THEN 'MANAGED_SCHEMA_NOT_INSTALLED' ELSE 'MANAGED_SOURCE_UNAVAILABLE_ON_NODE' END) AS reason FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND (cardinality($2::uuid[])=0 OR d.id=ANY($2)) AND NOT myoxus_database_source_admitted(d.managed_installation) ORDER BY d.id LIMIT 101")
      .bind(read.workspace_id).bind(&read.query.project_ids).fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let unavailable_projects = unavailable_rows
      .into_iter()
      .map(|row| DatabaseUnavailableProject {
        database_id: row.get("id"),
        title: row.get("title"),
        reason_code: row.get("reason"),
      })
      .collect::<Vec<_>>();
    let default_ready: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_databases d WHERE d.workspace_id=$1 AND d.system_role='workspace_tasks' AND d.deleted_at IS NULL AND myoxus_database_source_admitted(d.managed_installation))")
      .bind(read.workspace_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let coverage_complete = default_ready && unavailable_projects.is_empty();
    let project_count:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND d.system_role IS NULL AND myoxus_database_source_admitted(d.managed_installation)")
      .bind(read.workspace_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    // Validate semantic role metadata even when a filter matches no Rows.
    // Invalid configuration must never masquerade as a healthy zero count.
    let roles = sqlx::query(&task_roles_sql(PROJECTS))
      .bind(read.workspace_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    validate_task_role_rows(&roles)?;
    let mut status_options = Vec::new();
    let mut status_ids = BTreeSet::new();
    for role in &roles {
      if role.get::<Option<String>, _>("role_key").as_deref() != Some("task.status") {
        continue;
      }
      let config: DatabaseFieldConfig = serde_json::from_value(role.get("config_json"))
        .map_err(|_| RepositoryError::Validation("database task unavailable: invalid task.status role".into()))?;
      if let DatabaseFieldConfig::Status(mut status) = config {
        status.options.sort_by_key(|option| option.position);
        status_options.extend(
          status
            .options
            .into_iter()
            .filter(|option| status_ids.insert(option.id.clone())),
        );
      }
    }
    if read.query.scope == DatabaseTaskScope::Following {
      // Missing optional Watchers means no membership. A present malformed or
      // aliased role cannot turn assignment into an implicit subscription.
      let invalid: bool = sqlx::query_scalar(&format!(
        r#"
        WITH projects AS ({PROJECTS})
        SELECT EXISTS (
          SELECT 1 FROM projects p JOIN database_field_roles role ON role.database_id=p.id
            AND role.role_key='task.watchers'
          LEFT JOIN workspace_database_fields field ON field.id=role.field_id AND field.database_id=p.id
          WHERE (role.row_kind_scope='task' OR NOT EXISTS (
            SELECT 1 FROM database_field_roles canonical WHERE canonical.database_id=p.id
              AND canonical.role_key='task.watchers' AND canonical.row_kind_scope='task'))
            AND (role.row_kind_scope IS DISTINCT FROM 'task' OR field.field_type IS DISTINCT FROM 'users'
            OR EXISTS (SELECT 1 FROM database_field_roles other WHERE other.database_id=p.id
              AND other.field_id=role.field_id AND other.row_kind_scope='task' AND other.role_key<>'task.watchers'))
        )
      "#
      ))
      .bind(read.workspace_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      if invalid {
        return Err(RepositoryError::Validation(
          "database task unavailable: incompatible watchers role".to_string(),
        ));
      }
    }
    let blocker_capabilities = Self::task_relation_capabilities(&mut tx, &read).await?;
    let sql = workspace_task_sql(read.query.sort);
    let sort_key = read.after.as_ref().and_then(|cursor| cursor.sort_key.as_ref());
    let lifecycle = match read.query.lifecycle {
      DatabaseTaskLifecycle::Open => "open",
      DatabaseTaskLifecycle::Closed => "closed",
      DatabaseTaskLifecycle::All => "all",
      DatabaseTaskLifecycle::Trash => "trash",
    };
    let due = read.query.due.map(|d| match d {
      DatabaseTaskDuePreset::Overdue => "overdue",
      DatabaseTaskDuePreset::Today => "today",
      DatabaseTaskDuePreset::NextSevenDays => "nextSevenDays",
      DatabaseTaskDuePreset::Unscheduled => "unscheduled",
    });
    let raw = sqlx::query(&sql)
      .bind(read.workspace_id)
      .bind(&read.query.project_ids)
      .bind(read.actor_id)
      .bind(read.query.scope == DatabaseTaskScope::Mine)
      .bind(read.query.assignee_id)
      .bind(lifecycle)
      .bind(read.query.status_group.map(DatabaseStatusGroup::as_str))
      .bind(&read.query.search)
      .bind(due)
      .bind(read.evaluated_at)
      .bind(read.local_today)
      .bind(read.local_window_end)
      .bind(read.today_start)
      .bind(read.today_end)
      .bind(read.window_end)
      .bind(read.after.as_ref().map(|c| c.row_id))
      .bind(read.after.as_ref().and_then(|c| c.due_start))
      .bind(read.limit + 1)
      .bind(read.query.blocked_only)
      .bind(blocker_capabilities)
      .bind(read.query.scope == DatabaseTaskScope::Following)
      .bind(sort_key.map(|key| key.priority_rank))
      .bind(sort_key.and_then(|key| key.project_name.as_deref()))
      .bind(sort_key.and_then(|key| key.project_id))
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let unavailable: bool = raw.try_get("unavailable").map_err(Self::map_sqlx_error)?;
    if unavailable {
      return Err(RepositoryError::Validation(
        "database task unavailable: malformed task cell".to_string(),
      ));
    }
    let total_count = raw.try_get("total_count").map_err(Self::map_sqlx_error)?;
    let values: Value = raw.try_get("rows").map_err(Self::map_sqlx_error)?;
    let mut rows: Vec<DatabaseTaskSummary> = serde_json::from_value(values)
      .map_err(|_| RepositoryError::Validation("database task unavailable: malformed task projection".to_string()))?;
    let has_more = rows.len() > read.limit as usize;
    rows.truncate(read.limit as usize);
    for row in &mut rows {
      row.can_edit = read.can_edit && row.deleted_at.is_none();
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(DatabaseTasksPage {
      status_options,
      unavailable_projects,
      coverage_complete,

      rows,
      total_count,
      project_count,
      next_cursor: has_more.then(String::new),
    })
  }
}

impl PgDatabaseRepository {
  /// Optional relation authority is resolved once per selected Project in the
  /// same snapshot as Cells/counts/page. No missing role becomes a known zero.
  async fn task_relation_capabilities(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    read: &DatabaseTasksRead,
  ) -> RepoResult<Value> {
    let rows = sqlx::query(&format!(
      r#"WITH projects AS ({PROJECTS})
      SELECT p.id AS database_id, role.role_key, role.row_kind_scope, role.field_id,
        field.field_type, field.config_json
      FROM projects p
      LEFT JOIN database_field_roles role ON role.database_id=p.id
      LEFT JOIN workspace_database_fields field ON field.id=role.field_id AND field.database_id=p.id
      WHERE cardinality($2::uuid[])=0 OR p.id=ANY($2)"#
    ))
    .bind(read.workspace_id)
    .bind(&read.query.project_ids)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut projects = BTreeMap::<DatabaseId, Vec<_>>::new();
    for row in rows {
      let database_id = row.try_get("database_id").map_err(Self::map_sqlx_error)?;
      projects.entry(database_id).or_default().push(row);
    }
    let mut values = Vec::with_capacity(projects.len());
    for (database_id, rows) in projects {
      let mut roles = Vec::new();
      for row in &rows {
        if let Some(key) = row
          .try_get::<Option<String>, _>("role_key")
          .map_err(Self::map_sqlx_error)?
        {
          roles.push((
            key,
            row
              .try_get::<Option<String>, _>("row_kind_scope")
              .map_err(Self::map_sqlx_error)?,
            row.try_get::<Uuid, _>("field_id").map_err(Self::map_sqlx_error)?,
          ));
        }
      }
      let iter = || {
        roles
          .iter()
          .map(|(key, scope, field)| (key.as_str(), scope.as_deref(), *field))
      };
      let field = task_blocked_by_field(iter());
      let parent_field = task_parent_field(iter());
      let parent_available = parent_field.is_some_and(|field_id| {
        !task_parent_has_conflicting_task_role(field_id, iter())
          && rows.iter().any(|row| {
            row.get::<Option<Uuid>, _>("field_id") == Some(field_id)
              && row.get::<Option<String>, _>("role_key").as_deref() == Some("task.parent")
              && row.get::<Option<String>, _>("row_kind_scope").as_deref() == Some("task")
              && row.get::<Option<String>, _>("field_type").as_deref() == Some("relation")
              && row
                .get::<Option<Value>, _>("config_json")
                .and_then(|value| serde_json::from_value::<DatabaseFieldConfig>(value).ok())
                .is_some_and(|config| task_parent_config_compatible(database_id, &config))
          })
      });
      let reason = if let Some(field_id) = field {
        let metadata = rows.iter().find(|row| {
          row.get::<Option<Uuid>, _>("field_id") == Some(field_id)
            && row.get::<Option<String>, _>("role_key").as_deref() == Some("task.blockedBy")
            && row.get::<Option<String>, _>("row_kind_scope").as_deref() == Some("task")
        });
        let compatible = !task_blocked_by_has_conflicting_task_role(field_id, iter())
          && metadata.is_some_and(|row| {
            row.get::<Option<String>, _>("field_type").as_deref() == Some("relation")
              && row
                .get::<Option<Value>, _>("config_json")
                .and_then(|value| serde_json::from_value::<DatabaseFieldConfig>(value).ok())
                .is_some_and(|config| task_blocked_by_config_compatible(database_id, &config))
          });
        (!compatible).then_some(DatabaseTaskRelationReason::IncompatibleRoleConfiguration)
      } else {
        Some(DatabaseTaskRelationReason::MissingRole)
      };
      values.push(serde_json::json!({
        "database_id": database_id,
        "field_id": field,
        "available": reason.is_none(),
        "parent_field_id": parent_field,
        "parent_available": parent_available,
        "diagnostics": reason.into_iter().collect::<Vec<_>>(),
      }));
    }
    Ok(Value::Array(values))
  }
}

// Match uuid::Uuid's serde string codec rather than PostgreSQL's broader
// UUID grammar. Shared by canonical relation membership and count reads.
fn task_relation_uuid_pattern() -> String {
  let hyphenated = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
  [
    "^([0-9A-Fa-f]{32}|",
    hyphenated,
    r"|\{",
    hyphenated,
    r"\}|urn:uuid:",
    hyphenated,
    ")$",
  ]
  .concat()
}

// SQL NULL is an absent Cell; JSON null and any malformed member make the
// entire relation unreadable. Callers must guard the array before UUID casts.
fn task_relation_readable_sql(value: &str) -> String {
  let uuid_pattern = task_relation_uuid_pattern();
  format!(
    r#"({value} IS NULL OR
    (jsonb_typeof({value})='array' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof({value})='array' THEN {value} ELSE '[]'::jsonb END
      ) target WHERE jsonb_typeof(target.value)<>'string' OR (target.value #>> '{{}}') !~ '{uuid_pattern}'
    )))"#
  )
}

// Counts use only canonical scoped Cells and indexed prerequisite identities.
// Resolve them before filtering/counting/paging; no derived edge index or
// per-Task graph traversal may define cockpit membership.
fn workspace_task_sql(sort: DatabaseTaskSort) -> String {
  let ctes = task_projection_ctes(PROJECTS, "(cardinality($2::uuid[]) = 0 OR p.id = ANY($2))");
  let summary = task_summary_sql();
  // Final cockpit admission also checks raw Status shape: text extraction
  // could impersonate an option ID. Other summary producers retain their policy.
  let invalid = task_invalid_sql("r");
  let readable_blockers = task_relation_readable_sql("r.blocker_ids");
  let readable_watchers = task_relation_readable_sql("r.watcher_ids");
  let readable_parent = task_relation_readable_sql("parent.value_json");
  let readable_inverse = task_relation_readable_sql("inverse_cell.value_json");
  // Selection, continuation and JSON aggregation must use identical evaluated
  // keys. Explicit collation keeps cursor comparisons independent of host locale.
  let priority = matches!(sort, DatabaseTaskSort::Priority | DatabaseTaskSort::PriorityProject);
  let project = matches!(sort, DatabaseTaskSort::Project | DatabaseTaskSort::PriorityProject);
  let keys = |alias: &str| {
    format!(
      "{}{}({alias}.due_start IS NULL), COALESCE({alias}.due_start, '-infinity'::timestamptz), {alias}.id",
      if priority {
        format!("{alias}.sort_priority, ")
      } else {
        String::new()
      },
      if project {
        format!(
          "({alias}.sort_project_name IS NULL), COALESCE({alias}.sort_project_name, '') COLLATE \"C\", COALESCE({alias}.sort_project_id, '00000000-0000-0000-0000-000000000000'::uuid), "
        )
      } else {
        String::new()
      }
    )
  };
  let page_order = keys("r");
  let aggregate_order = keys("p");
  // Bind every optional key even for Due so one stable parameter layout owns
  // all sort modes and old Due cursors need no new key materialization.
  let after_keys = format!(
    "{}{}($17::timestamptz IS NULL), COALESCE($17::timestamptz, '-infinity'::timestamptz), $16::uuid",
    if priority { "c.priority_rank, " } else { "" },
    if project {
      "(c.project_name IS NULL), COALESCE(c.project_name, '') COLLATE \"C\", COALESCE(c.project_id, '00000000-0000-0000-0000-000000000000'::uuid), "
    } else {
      ""
    }
  );
  format!(
    r#"
    {ctes}, blocker_capabilities AS (
      SELECT * FROM jsonb_to_recordset($20::jsonb)
        AS capability(database_id uuid, field_id uuid, available boolean, diagnostics jsonb,
          parent_field_id uuid, parent_available boolean)
    ), blocker_cells AS (
      SELECT r.*, capability.available AS blocking_capable,
        capability.diagnostics AS blocking_diagnostics, capability.field_id AS blocker_field_id,
        capability.parent_field_id, capability.parent_available,
        cell.value_json AS blocker_ids, watcher_cell.value_json AS watcher_ids
      FROM projected r JOIN blocker_capabilities capability ON capability.database_id=r.database_id
      LEFT JOIN workspace_database_cell_values cell ON cell.row_id=r.id AND cell.field_id=capability.field_id
      LEFT JOIN database_field_roles watcher_role ON watcher_role.database_id=r.database_id
        AND watcher_role.role_key='task.watchers' AND watcher_role.row_kind_scope='task'
      LEFT JOIN workspace_database_cell_values watcher_cell ON watcher_cell.row_id=r.id AND watcher_cell.field_id=watcher_role.field_id
    ), blocker_shapes AS (
      SELECT r.*, {readable_blockers} AS readable_blockers, {readable_watchers} AS readable_watchers
      FROM blocker_cells r
    ), blocker_states AS (
      SELECT r.*, counts.active_count, counts.unresolved_count, counts.has_self, counts.has_duplicates
      FROM blocker_shapes r
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE state='active')::bigint AS active_count,
          count(*) FILTER (WHERE state='unavailable')::bigint AS unresolved_count,
          COALESCE(bool_or(target_id=r.id), false) AS has_self,
          (SELECT count(*)<>count(DISTINCT regexp_replace(value #>> '{{}}', '^urn:uuid:', '')::uuid) FROM jsonb_array_elements(
            CASE WHEN r.blocking_capable AND r.readable_blockers AND jsonb_typeof(r.blocker_ids)='array'
              THEN r.blocker_ids ELSE '[]'::jsonb END
          )) AS has_duplicates
        FROM (
          SELECT targets.target_id, CASE
            WHEN targets.target_id=r.id OR prerequisite.id IS NULL OR prerequisite.deleted_at IS NOT NULL
              OR (status_cell.value_json IS NOT NULL AND status_cell.value_json<>'null'::jsonb
                AND jsonb_typeof(status_cell.value_json)<>'string')
              OR (status_cell.value_json #>> '{{}}' IS NOT NULL AND status_option.status_group IS NULL) THEN 'unavailable'
            WHEN status_option.status_group IN ('complete', 'archived') THEN 'inactive'
            ELSE 'active' END AS state
          FROM (
            SELECT DISTINCT regexp_replace(value #>> '{{}}', '^urn:uuid:', '')::uuid AS target_id
            FROM jsonb_array_elements(
              CASE WHEN r.blocking_capable AND r.readable_blockers AND jsonb_typeof(r.blocker_ids)='array'
                THEN r.blocker_ids ELSE '[]'::jsonb END
            )
          ) targets
          LEFT JOIN workspace_database_rows prerequisite ON prerequisite.database_id=r.database_id
            AND prerequisite.id=targets.target_id AND prerequisite.row_kind='task'
          LEFT JOIN database_field_roles status_role ON status_role.database_id=r.database_id
            AND status_role.role_key='task.status' AND status_role.row_kind_scope='task'
          LEFT JOIN workspace_database_fields status_field ON status_field.id=status_role.field_id
          LEFT JOIN workspace_database_cell_values status_cell ON status_cell.row_id=prerequisite.id
            AND status_cell.field_id=status_role.field_id
          LEFT JOIN LATERAL (
            SELECT value->>'group' AS status_group FROM jsonb_array_elements(status_field.config_json->'options')
            WHERE value->>'id'=status_cell.value_json #>> '{{}}'
          ) status_option ON true
        ) states
      ) counts
    ), blocking AS (
      SELECT r.*, jsonb_build_object(
        'available', r.blocking_capable AND r.readable_blockers AND r.deleted_at IS NULL,
        'activeCount', CASE WHEN r.blocking_capable AND r.readable_blockers AND r.deleted_at IS NULL THEN r.active_count END,
        'unresolvedCount', CASE WHEN r.blocking_capable AND r.readable_blockers AND r.deleted_at IS NULL THEN r.unresolved_count END,
        'diagnostics', r.blocking_diagnostics
          || CASE WHEN NOT r.readable_blockers THEN '["IncompatibleRoleConfiguration"]'::jsonb ELSE '[]'::jsonb END
          || CASE WHEN r.deleted_at IS NOT NULL OR r.unresolved_count>0 THEN '["UnavailableTarget"]'::jsonb ELSE '[]'::jsonb END
          || CASE WHEN r.has_self THEN '["SelfBlockedBy"]'::jsonb ELSE '[]'::jsonb END
          || CASE WHEN r.has_duplicates THEN '["DuplicateTargets"]'::jsonb ELSE '[]'::jsonb END
      ) AS blockers
      FROM blocker_states r
    ), filtered AS MATERIALIZED (
      SELECT * FROM blocking r
      WHERE (NOT $19::boolean OR (r.blocking_capable AND r.readable_blockers AND r.deleted_at IS NULL AND r.active_count>0))
        AND (NOT $21::boolean OR NOT r.readable_watchers OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN r.readable_watchers AND jsonb_typeof(r.watcher_ids)='array'
            THEN r.watcher_ids ELSE '[]'::jsonb END) member
          WHERE regexp_replace(member #>> '{{}}', '^urn:uuid:', '')::uuid=$3))
        AND (NOT $4::boolean OR r.assignee_ids @> jsonb_build_array($3::text))
        AND ($5::uuid IS NULL OR r.assignee_ids @> jsonb_build_array($5::text))
        AND (($6 = 'trash' AND r.deleted_at IS NOT NULL) OR (r.deleted_at IS NULL AND
          ($6 = 'all' OR ($6 = 'open' AND COALESCE(r.status_group, 'notStarted') NOT IN ('complete', 'archived')) OR
           ($6 = 'closed' AND r.status_group IN ('complete', 'archived')))))
        AND ($7::text IS NULL OR r.status_group = $7)
        AND ($8::text IS NULL OR strpos(lower(r.title), lower($8)) > 0)
        AND ($9::text IS NULL OR ($9 = 'unscheduled' AND r.due_start IS NULL)
          OR ($9 = 'overdue' AND CASE WHEN r.all_day THEN r.due_day < $11::date ELSE r.due_start < $10::timestamptz END)
          OR ($9 = 'today' AND CASE WHEN r.all_day THEN r.due_day = $11::date ELSE r.due_start >= $13::timestamptz AND r.due_start < $14::timestamptz END)
          OR ($9 = 'nextSevenDays' AND CASE WHEN r.all_day THEN r.due_day >= $11::date AND r.due_day < $12::date ELSE r.due_start >= $13::timestamptz AND r.due_start < $15::timestamptz END))
    ), ordered AS (
      SELECT r.*,
        CASE r.priority_id WHEN 'priority.critical' THEN 0 WHEN 'priority.high' THEN 1
          WHEN 'priority.normal' THEN 2 WHEN 'priority.low' THEN 3 WHEN 'priority.lowest' THEN 4 ELSE 5 END AS sort_priority,
        CASE WHEN d.system_role IS DISTINCT FROM 'workspace_tasks' THEN lower(d.title) END AS sort_project_name,
        CASE WHEN d.system_role IS DISTINCT FROM 'workspace_tasks' THEN d.id END AS sort_project_id
      FROM filtered r JOIN workspace_databases d ON d.id=r.database_id
    ), continuation AS (
      SELECT $22::integer AS priority_rank, $23::text AS project_name, $24::uuid AS project_id
    ), page AS (
      SELECT r.* FROM ordered r CROSS JOIN continuation c
      WHERE $16::uuid IS NULL OR ({page_order}) > ({after_keys})
      ORDER BY {page_order} LIMIT $18
    ), marked_page AS (
      -- Existence work is bounded by this page, never by the inventory count.
      SELECT p.*,
        CASE WHEN NOT p.parent_available OR p.deleted_at IS NOT NULL THEN NULL
          WHEN parent.value_json IS NULL THEN false
          WHEN NOT {readable_parent} THEN NULL
          WHEN jsonb_array_length(parent.value_json)=0 THEN false
          WHEN jsonb_array_length(parent.value_json)<>1 THEN NULL
          WHEN EXISTS (SELECT 1 FROM workspace_database_rows parent_row
            WHERE parent_row.database_id=p.database_id AND parent_row.row_kind='task'
              AND parent_row.deleted_at IS NULL AND parent_row.id<>p.id
              AND parent_row.id=regexp_replace(parent.value_json->>0, '^urn:uuid:', '')::uuid)
            THEN true ELSE NULL END AS is_subtask,
        CASE WHEN NOT p.blocking_capable OR p.deleted_at IS NOT NULL THEN NULL
          WHEN EXISTS (SELECT 1 FROM workspace_database_rows dependent
            JOIN workspace_database_cell_values inverse_cell
              ON inverse_cell.row_id=dependent.id AND inverse_cell.field_id=p.blocker_field_id
            WHERE dependent.database_id=p.database_id AND dependent.row_kind='task'
              AND dependent.deleted_at IS NULL AND dependent.id<>p.id
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                CASE WHEN {readable_inverse} AND jsonb_typeof(inverse_cell.value_json)='array'
                  THEN inverse_cell.value_json ELSE '[]'::jsonb END) target
                WHERE regexp_replace(target.value #>> '{{}}', '^urn:uuid:', '')::uuid=p.id))
            THEN true
          WHEN NOT p.readable_blockers THEN NULL
          ELSE COALESCE(jsonb_array_length(p.blocker_ids)>0, false) END AS has_dependencies
      FROM page p LEFT JOIN workspace_database_cell_values parent
        ON parent.row_id=p.id AND parent.field_id=p.parent_field_id
    )
    SELECT EXISTS (SELECT 1 FROM filtered r WHERE
        {invalid}
        OR ($21::boolean AND NOT r.readable_watchers)
        OR (r.status_value IS NOT NULL AND r.status_value<>'null'::jsonb
          AND jsonb_typeof(r.status_value)<>'string')
      ) AS unavailable,
      (SELECT count(*) FROM filtered)::bigint AS total_count,
      COALESCE((SELECT jsonb_agg({summary} || jsonb_build_object('blockers', p.blockers,
        'isSubtask', p.is_subtask, 'hasDependencies', p.has_dependencies,
        'sortKey', jsonb_build_object('priorityRank', p.sort_priority,
          'projectName', p.sort_project_name, 'projectId', p.sort_project_id))
        ORDER BY {aggregate_order}) FROM marked_page p), '[]'::jsonb) AS rows
  "#
  )
}

fn validate_task_role(row: &sqlx::postgres::PgRow) -> RepoResult<Option<String>> {
  let consumed_roles = DATABASE_PROJECT_SEMANTIC_CATALOG
    .iter()
    .filter(|role| {
      role.row_kind_scope == DatabaseRowKind::Task
        && matches!(
          role.role_key,
          "task.status" | "task.assignees" | "task.dueDate" | "task.priority"
        )
    })
    .collect::<Vec<_>>();
  let key: Option<String> = row.try_get("role_key").map_err(PgDatabaseRepository::map_sqlx_error)?;
  let Some(key) = key else { return Ok(None) };
  let unavailable = || RepositoryError::Validation(format!("database task unavailable: invalid {key} role"));
  let scope: Option<String> = row
    .try_get("row_kind_scope")
    .map_err(PgDatabaseRepository::map_sqlx_error)?;
  let kind: Option<String> = row
    .try_get("field_type")
    .map_err(PgDatabaseRepository::map_sqlx_error)?;
  let semantic = consumed_roles
    .iter()
    .find(|role| role.role_key == key)
    .ok_or_else(unavailable)?;
  let required: bool = row.try_get("required").map_err(PgDatabaseRepository::map_sqlx_error)?;
  if scope.as_deref() != Some("task")
    || kind.as_deref() != Some(semantic.field_type.as_str())
    || required != semantic.required
  {
    return Err(unavailable());
  }
  let config: Value = row
    .try_get("config_json")
    .map_err(PgDatabaseRepository::map_sqlx_error)?;
  let config: DatabaseFieldConfig = serde_json::from_value(config).map_err(|_| unavailable())?;
  if !config.matches_field_type(semantic.field_type) {
    return Err(unavailable());
  }
  // Match native field validation before joining option IDs: duplicate
  // priority IDs would otherwise multiply Rows and corrupt the count.
  let invalid_option = |id: &str, name: &str, color: &str| {
    id.trim().is_empty()
      || name.trim().is_empty()
      || color.trim().is_empty()
      || color.contains('#')
      || color.contains("rgb")
      || color.contains("hsl")
  };
  let options = config.select_options();
  let option_ids: BTreeSet<_> = options.iter().map(|option| &option.id).collect();
  if option_ids.len() != options.len()
    || options
      .iter()
      .any(|option| invalid_option(&option.id, &option.name, &option.color_role))
  {
    return Err(unavailable());
  }
  if let DatabaseFieldConfig::Status(status) = config {
    let ids: BTreeSet<_> = status.options.iter().map(|o| &o.id).collect();
    if ids.len() != status.options.len()
      || !ids.contains(&status.default_option_id)
      || status
        .options
        .iter()
        .any(|o| invalid_option(&o.id, &o.name, &o.color_role))
      || [
        DatabaseStatusGroup::NotStarted,
        DatabaseStatusGroup::Active,
        DatabaseStatusGroup::Complete,
      ]
      .iter()
      .any(|group| !status.options.iter().any(|option| option.group == *group))
    {
      return Err(unavailable());
    }
  }
  Ok(Some(key))
}

fn validate_task_role_rows(roles: &[sqlx::postgres::PgRow]) -> RepoResult<BTreeSet<DatabaseId>> {
  let mut present_roles = BTreeSet::new();
  let mut projects = BTreeSet::new();
  for row in roles {
    let database_id: DatabaseId = row
      .try_get("database_id")
      .map_err(PgDatabaseRepository::map_sqlx_error)?;
    projects.insert(database_id);
    if let Some(key) = validate_task_role(&row)? {
      present_roles.insert((database_id, key));
    }
  }
  // The catalog owns requiredness; a missing persisted association cannot
  // redefine a required role as an optional, healthy empty capability.
  for database_id in &projects {
    for role in DATABASE_PROJECT_SEMANTIC_CATALOG.iter().filter(|role| {
      role.row_kind_scope == DatabaseRowKind::Task
        && role.required
        && matches!(
          role.role_key,
          "task.status" | "task.assignees" | "task.dueDate" | "task.priority"
        )
    }) {
      if !present_roles.contains(&(*database_id, role.role_key.to_string())) {
        return Err(RepositoryError::Validation(format!(
          "database task unavailable: missing {} role",
          role.role_key
        )));
      }
    }
  }
  Ok(projects)
}

fn task_roles_sql(projects_sql: &str) -> String {
  format!(
    r#"
      WITH projects AS ({projects_sql})
      SELECT p.id AS database_id, role.role_key, role.row_kind_scope,
        role.required, field.field_type, field.config_json
      FROM projects p LEFT JOIN database_field_roles role
        ON role.database_id = p.id AND role.profile_kind = 'project'
        AND role.role_key IN ('task.status', 'task.assignees', 'task.dueDate', 'task.priority')
      LEFT JOIN workspace_database_fields field ON field.id = role.field_id AND field.database_id = p.id
      ORDER BY p.id, role.role_key
  "#
  )
}

fn task_projection_ctes(projects_sql: &str, row_filter: &str) -> String {
  task_projection_ctes_with_roles(projects_sql, row_filter, None)
}

fn task_projection_ctes_with_roles(projects_sql: &str, row_filter: &str, roles_parameter: Option<&str>) -> String {
  // Only an absent Status Cell uses the native schema's default. An existing
  // malformed/unbound value must remain unavailable rather than being repaired
  // by a read or silently displayed as open work.
  // Field IDs may be shared by malformed aliases; validate each semantic role
  // independently instead of letting a valid Priority field authorize Status.
  let guard = |role: &str| {
    roles_parameter
      .map(|parameter| format!(" AND '{role}'=ANY({parameter}::text[])"))
      .unwrap_or_default()
  };
  let status_guard = guard("task.status");
  let assignee_guard = guard("task.assignees");
  let due_guard = guard("task.dueDate");
  let priority_guard = guard("task.priority");
  let description_guard = guard("task.description");
  format!(
    r#"
    WITH projects AS ({projects_sql}), role_cells AS (
      SELECT r.id, r.database_id, r.title, r.edit_revision, r.updated_at, r.deleted_at,
        p.workspace_id, p.title AS project_title, p.deleted_at AS project_deleted_at,
        NULLIF(left(btrim(description_cell.value_json->>'plainText'), 280), '') AS description_preview,
        CASE WHEN status_cell.row_id IS NULL THEN status_field.config_json->>'defaultOptionId'
          ELSE status_cell.value_json #>> '{{}}' END AS status_id,
        status_cell.value_json AS status_value,
        status_field.config_json AS status_config,
        assignee_role.field_id IS NOT NULL AS has_assignees,
        due_role.field_id IS NOT NULL AS has_due,
        priority_role.field_id IS NOT NULL AS has_priority,
        COALESCE(assignee_cell.value_json, '[]'::jsonb) AS assignee_ids,
        due_cell.value_json AS due,
        priority_cell.value_json #>> '{{}}' AS priority_id,
        priority_field.config_json AS priority_config
      FROM projects p JOIN workspace_database_rows r ON r.database_id = p.id AND r.row_kind = 'task'
      LEFT JOIN database_field_roles description_role ON description_role.database_id = p.id AND description_role.role_key = 'task.description' AND description_role.row_kind_scope = 'task' {description_guard}
      LEFT JOIN workspace_database_fields description_field ON description_field.id = description_role.field_id AND description_field.database_id = p.id AND description_field.field_type = 'rich_text'
      LEFT JOIN workspace_database_cell_values description_cell ON description_cell.row_id = r.id AND description_cell.field_id = description_field.id
      LEFT JOIN database_field_roles status_role ON status_role.database_id = p.id AND status_role.role_key = 'task.status' AND status_role.row_kind_scope = 'task' {status_guard}
      LEFT JOIN workspace_database_fields status_field ON status_field.id = status_role.field_id
      LEFT JOIN workspace_database_cell_values status_cell ON status_cell.row_id = r.id AND status_cell.field_id = status_role.field_id
      LEFT JOIN database_field_roles assignee_role ON assignee_role.database_id = p.id AND assignee_role.role_key = 'task.assignees' AND assignee_role.row_kind_scope = 'task' {assignee_guard}
      LEFT JOIN workspace_database_cell_values assignee_cell ON assignee_cell.row_id = r.id AND assignee_cell.field_id = assignee_role.field_id
      LEFT JOIN database_field_roles due_role ON due_role.database_id = p.id AND due_role.role_key = 'task.dueDate' AND due_role.row_kind_scope = 'task' {due_guard}
      LEFT JOIN workspace_database_cell_values due_cell ON due_cell.row_id = r.id AND due_cell.field_id = due_role.field_id
      LEFT JOIN database_field_roles priority_role ON priority_role.database_id = p.id AND priority_role.role_key = 'task.priority' AND priority_role.row_kind_scope = 'task' {priority_guard}
      LEFT JOIN workspace_database_fields priority_field ON priority_field.id = priority_role.field_id
      LEFT JOIN workspace_database_cell_values priority_cell ON priority_cell.row_id = r.id AND priority_cell.field_id = priority_role.field_id
      WHERE {row_filter}
    ), projected AS (
      SELECT r.*, status_option.value AS status, status_option.value ->> 'group' AS status_group,
        priority_option.value AS priority,
        CASE WHEN pg_input_is_valid(r.due ->> 'start', 'timestamp with time zone') THEN (r.due ->> 'start')::timestamptz END AS due_start,
        COALESCE(r.due ->> 'allDay' = 'true', false) AS all_day,
        CASE WHEN r.due ->> 'allDay' = 'true' AND pg_input_is_valid(r.due ->> 'start', 'timestamp with time zone')
          AND EXISTS (SELECT 1 FROM pg_timezone_names zone WHERE zone.name = r.due ->> 'timeZone')
          THEN ((r.due ->> 'start')::timestamptz AT TIME ZONE (r.due ->> 'timeZone'))::date END AS due_day
      FROM role_cells r
      LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(r.status_config -> 'options') WHERE value ->> 'id' = r.status_id) status_option ON true
      LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(r.priority_config -> 'options') WHERE value ->> 'id' = r.priority_id) priority_option ON true
    )
  "#
  )
}

fn task_summary_sql() -> &'static str {
  r#"jsonb_build_object(
        'workspaceId', p.workspace_id, 'databaseId', p.database_id, 'rowId', p.id,
        'projectTitle', p.project_title, 'title', p.title, 'editRevision', p.edit_revision,
        'descriptionPreview', p.description_preview,
        'updatedAt', p.updated_at, 'deletedAt', p.deleted_at, 'status', p.status,
        'due', p.due, 'priority', p.priority, 'canEdit', false,
        'hasAssignees', p.has_assignees, 'hasDue', p.has_due, 'hasPriority', p.has_priority,
        'assignees', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name) ORDER BY lower(u.name), u.id), '[]'::jsonb)
          FROM users u JOIN workspace_memberships m ON m.user_id = u.id AND m.workspace_id = $1 AND m.status = 'Accepted'
          WHERE u.status = 'active' AND p.assignee_ids @> jsonb_build_array(u.id::text))
      )"#
}

fn task_invalid_sql(alias: &str) -> String {
  format!(
    r#"({alias}.status_id IS NOT NULL AND {alias}.status IS NULL)
        OR ({alias}.priority_id IS NOT NULL AND {alias}.priority IS NULL)
        OR ({alias}.due IS NOT NULL AND {alias}.due <> 'null'::jsonb AND (
          jsonb_typeof({alias}.due) <> 'object' OR {alias}.due_start IS NULL
          OR COALESCE({alias}.due ->> 'allDay', 'false') NOT IN ('true', 'false')
          OR NOT EXISTS (SELECT 1 FROM pg_timezone_names zone WHERE zone.name = {alias}.due ->> 'timeZone')))
        OR jsonb_typeof({alias}.assignee_ids) NOT IN ('array', 'null')"#
  )
}

const REFERENCE_PROJECTS: &str = r#"
  SELECT d.id, d.workspace_id, d.title, d.deleted_at
  FROM workspace_databases d
  JOIN database_profiles profile ON profile.database_id = d.id AND profile.profile_kind = 'project'
  WHERE d.workspace_id = $1 AND d.id = ANY($2::uuid[]) AND myoxus_database_source_admitted(d.managed_installation)
"#;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn read_workspace_task_references(
    &self,
    read: DatabaseTaskReferencesRead,
  ) -> RepoResult<Vec<DatabaseTaskReferenceRecord>> {
    if read.targets.len() > 500 {
      return Err(RepositoryError::Validation(
        "task reference batch exceeds 500 targets".into(),
      ));
    }
    if read.targets.is_empty() {
      return Ok(Vec::new());
    }
    let (_, row_ids): (Vec<_>, Vec<_>) = read.targets.iter().copied().unzip();
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    self.capture_managed_admission(&mut tx).await?;
    let canonical=sqlx::query("SELECT row.database_id,row.id FROM workspace_database_rows row JOIN workspace_databases d ON d.id=row.database_id WHERE d.workspace_id=$1 AND row.id=ANY($2) ORDER BY row.id")
      .bind(read.workspace_id).bind(&row_ids).fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let (database_ids, row_ids): (Vec<Uuid>, Vec<Uuid>) = canonical
      .into_iter()
      .map(|row| (row.get::<Uuid, _>("database_id"), row.get::<Uuid, _>("id")))
      .unzip();
    let roles = sqlx::query(&task_roles_sql(REFERENCE_PROJECTS))
      .bind(read.workspace_id)
      .bind(&database_ids)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut groups = BTreeMap::<DatabaseId, Vec<_>>::new();
    for row in roles {
      let id = row.try_get("database_id").map_err(Self::map_sqlx_error)?;
      groups.entry(id).or_default().push(row);
    }
    let mut valid = Vec::new();
    for (id, roles) in groups {
      match validate_task_role_rows(&roles) {
        Ok(_) => valid.push(id),
        // Bad role/schema metadata is neutral for this target, never a guessed
        // Task summary. Other valid explicit targets in the batch remain usable.
        Err(RepositoryError::Validation(_)) => {}
        Err(error) => return Err(error),
      }
    }
    let ctes = task_projection_ctes(
      REFERENCE_PROJECTS,
      "(r.database_id, r.id) IN (SELECT * FROM unnest($3::uuid[], $4::uuid[]))",
    );
    let summary = task_summary_sql();
    let invalid = task_invalid_sql("p");
    let sql =
      format!("{ctes} SELECT {summary} AS task, p.project_deleted_at, ({invalid}) AS unavailable FROM projected p");
    let raw = sqlx::query(&sql)
      .bind(read.workspace_id)
      .bind(valid)
      .bind(database_ids)
      .bind(row_ids)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut records = Vec::with_capacity(raw.len());
    for row in raw {
      if row.try_get::<bool, _>("unavailable").map_err(Self::map_sqlx_error)? {
        continue;
      }
      let value: Value = row.try_get("task").map_err(Self::map_sqlx_error)?;
      let Ok(task) = serde_json::from_value::<DatabaseTaskSummary>(value) else {
        continue;
      };
      records.push(DatabaseTaskReferenceRecord {
        task,
        project_deleted_at: row.try_get("project_deleted_at").map_err(Self::map_sqlx_error)?,
      });
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(records)
  }
}

const CHILD_PROJECT: &str = r#"
  SELECT d.id, d.workspace_id, d.title, d.deleted_at
  FROM workspace_databases d
  JOIN database_profiles profile ON profile.database_id=d.id AND profile.profile_kind='project'
  WHERE d.workspace_id=$1 AND d.id=$2 AND d.deleted_at IS NULL AND myoxus_database_source_admitted(d.managed_installation)
"#;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn read_task_children(
    &self,
    read: DatabaseTaskChildrenRead,
  ) -> RepoResult<DatabaseTaskChildrenPage> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    // Capability, membership, counts and this bounded page share one snapshot;
    // no Parent graph traversal or per-child schema read is needed.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    self.capture_managed_admission(&mut tx).await?;
    let mut result = DatabaseTaskChildrenPage {
      available: false,
      field_id: None,
      diagnostics: Vec::new(),
      rows: Vec::new(),
      total_count: 0,
      complete_count: 0,
      archived_count: 0,
      next_cursor: None,
    };
    let admitted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_databases d WHERE d.id=$1 AND d.workspace_id=$2 AND d.deleted_at IS NULL AND myoxus_database_source_admitted(d.managed_installation))")
      .bind(read.database_id).bind(read.workspace_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if !admitted {
      return Ok(result);
    }
    let roles = Self::list_field_roles_for(&mut *tx, read.database_id).await?;
    let field_id = task_parent_field(
      roles
        .iter()
        .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id)),
    );
    result.field_id = field_id;
    let source = sqlx::query(
      r#"SELECT row.row_kind, row.deleted_at AS row_deleted_at, db.deleted_at AS database_deleted_at,
                profile.profile_kind
         FROM workspace_database_rows row
         JOIN workspace_databases db ON db.id=row.database_id
         LEFT JOIN database_profiles profile ON profile.database_id=db.id
         WHERE db.workspace_id=$1 AND db.id=$2 AND row.id=$3 AND myoxus_database_source_admitted(db.managed_installation)"#,
    )
    .bind(read.workspace_id)
    .bind(read.database_id)
    .bind(read.parent_row_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if let Some(source) = source {
      if source.try_get::<String, _>("row_kind").map_err(Self::map_sqlx_error)? != "task" {
        result.diagnostics.push(DatabaseTaskRelationReason::WrongRowKind);
      }
      if source
        .try_get::<Option<DateTime<Utc>>, _>("row_deleted_at")
        .map_err(Self::map_sqlx_error)?
        .is_some()
        || source
          .try_get::<Option<DateTime<Utc>>, _>("database_deleted_at")
          .map_err(Self::map_sqlx_error)?
          .is_some()
      {
        result.diagnostics.push(DatabaseTaskRelationReason::UnavailableTarget);
      }
      if source
        .try_get::<Option<String>, _>("profile_kind")
        .map_err(Self::map_sqlx_error)?
        .as_deref()
        != Some("project")
      {
        result
          .diagnostics
          .push(DatabaseTaskRelationReason::IncompatibleRoleConfiguration);
      }
    } else {
      // Do not echo even a role identity from a Database that left this scope.
      result.field_id = None;
      result.diagnostics.push(DatabaseTaskRelationReason::UnavailableTarget);
    }
    if let Some(field_id) = field_id {
      let config = sqlx::query_scalar::<_, Value>(
        r#"SELECT config_json FROM workspace_database_fields
           WHERE database_id=$1 AND id=$2 AND field_type='relation'"#,
      )
      .bind(read.database_id)
      .bind(field_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      let compatible = roles.iter().any(|role| {
        role.role_key == "task.parent" && role.row_kind_scope.as_deref() == Some("task") && role.field_id == field_id
      }) && !task_parent_has_conflicting_task_role(
        field_id,
        roles
          .iter()
          .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id)),
      ) && config
        .and_then(|value| serde_json::from_value::<DatabaseFieldConfig>(value).ok())
        .is_some_and(|config| task_parent_config_compatible(read.database_id, &config));
      if !compatible
        && !result
          .diagnostics
          .contains(&DatabaseTaskRelationReason::IncompatibleRoleConfiguration)
      {
        result
          .diagnostics
          .push(DatabaseTaskRelationReason::IncompatibleRoleConfiguration);
      }
    } else {
      result.diagnostics.push(DatabaseTaskRelationReason::MissingRole);
    }
    if !result.diagnostics.is_empty() {
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      return Ok(result);
    }
    result.available = true;
    let role_rows = sqlx::query(&task_roles_sql(CHILD_PROJECT))
      .bind(read.workspace_id)
      .bind(read.database_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut valid_roles = Vec::<String>::new();
    for role in role_rows {
      match validate_task_role(&role) {
        Ok(Some(key)) => valid_roles.push(key),
        // Optional summary corruption cannot erase canonical child membership.
        Ok(None) | Err(RepositoryError::Validation(_)) => {}
        Err(error) => return Err(error),
      }
    }
    let readable_parent = task_relation_readable_sql("parent.value_json");
    let child_membership = format!(
      r#"r.deleted_at IS NULL AND r.id<>$3 AND EXISTS (
        SELECT 1 FROM workspace_database_cell_values parent
        WHERE parent.row_id=r.id AND parent.field_id=$4
          AND CASE WHEN {readable_parent} AND jsonb_typeof(parent.value_json)='array'
            THEN CASE WHEN jsonb_array_length(parent.value_json)=1
              THEN regexp_replace(parent.value_json->>0, '^urn:uuid:', '')::uuid=$3
              ELSE false END
            ELSE false END
      )"#
    );
    let ctes = task_projection_ctes_with_roles(CHILD_PROJECT, &child_membership, Some("$6"));
    let summary = task_summary_sql();
    let sql = format!(
      r#"{ctes}, child_page AS (
      SELECT * FROM projected WHERE ($5::uuid IS NULL OR id>$5)
      ORDER BY id LIMIT $7
    )
    SELECT count(*) AS total_count,
      count(*) FILTER (WHERE status_group='complete') AS complete_count,
      count(*) FILTER (WHERE status_group='archived') AS archived_count,
      (SELECT COALESCE(jsonb_agg({summary} ORDER BY p.id), '[]'::jsonb) FROM child_page p) AS rows
    FROM projected"#
    );
    let raw = sqlx::query(&sql)
      .bind(read.workspace_id)
      .bind(read.database_id)
      .bind(read.parent_row_id)
      .bind(field_id)
      .bind(read.after)
      .bind(valid_roles)
      .bind(read.limit.clamp(1, DATABASE_MAX_ROWS_PER_PAGE) + 1)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    result.total_count = raw.try_get("total_count").map_err(Self::map_sqlx_error)?;
    result.complete_count = raw.try_get("complete_count").map_err(Self::map_sqlx_error)?;
    result.archived_count = raw.try_get("archived_count").map_err(Self::map_sqlx_error)?;
    let values: Vec<Value> = serde_json::from_value(raw.try_get::<Value, _>("rows").map_err(Self::map_sqlx_error)?)
      .map_err(|_| RepositoryError::Storage("invalid task children page".into()))?;
    for mut value in values {
      // Corrupt optional dates render absent; the Task identity/title survives.
      if let Some(due) = value.get("due").filter(|due| !due.is_null()) {
        let valid = serde_json::from_value::<DatabaseDateTimeValue>(due.clone())
          .ok()
          .is_some_and(|due| {
            due.time_zone.parse::<chrono_tz::Tz>().is_ok() && due.end.is_none_or(|end| end >= due.start)
          });
        if !valid {
          value["due"] = Value::Null;
        }
      }
      result.rows.push(
        serde_json::from_value(value).map_err(|_| RepositoryError::Storage("invalid task children summary".into()))?,
      );
    }
    let limit = read.limit.clamp(1, DATABASE_MAX_ROWS_PER_PAGE) as usize;
    let has_more = result.rows.len() > limit;
    result.rows.truncate(limit);
    result.next_cursor = has_more.then(String::new);
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(result)
  }
}

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn read_task_blocking(
    &self,
    read: DatabaseTaskBlockingRead,
  ) -> RepoResult<DatabaseTaskBlockingPage> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    self.capture_managed_admission(&mut tx).await?;
    let mut page = DatabaseTaskBlockingPage {
      available: false,
      field_id: None,
      diagnostics: vec![],
      retained_row_ids: vec![],
      rows: vec![],
      next_cursor: None,
    };
    let source: Option<(String, bool)> = sqlx::query_as(
      r#"
      SELECT row.row_kind, row.deleted_at IS NULL AND db.deleted_at IS NULL
      FROM workspace_database_rows row JOIN workspace_databases db ON db.id=row.database_id
      JOIN database_profiles profile ON profile.database_id=db.id AND profile.profile_kind='project'
      WHERE db.workspace_id=$1 AND db.id=$2 AND row.id=$3 AND myoxus_database_source_admitted(db.managed_installation)
    "#,
    )
    .bind(read.workspace_id)
    .bind(read.database_id)
    .bind(read.row_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some((kind, live)) = source else {
      page.diagnostics.push(DatabaseTaskRelationReason::UnavailableTarget);
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      return Ok(page);
    };
    let roles = Self::list_field_roles_for(&mut *tx, read.database_id).await?;
    let iter = || {
      roles
        .iter()
        .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
    };
    let Some(field) = task_blocked_by_field(iter()) else {
      page.diagnostics.push(DatabaseTaskRelationReason::MissingRole);
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      return Ok(page);
    };
    page.field_id = Some(field);
    let value = sqlx::query_scalar::<_, Option<Value>>(
      "SELECT value_json FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2",
    )
    .bind(read.row_id)
    .bind(field)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .flatten();
    if !read.inverse
      && let Some(value) = value
    {
      match Self::map_cell_value_from_json(DatabaseFieldType::Relation, value) {
        Ok(DatabaseCellValueData::Relation(ids)) => page.retained_row_ids = ids,
        _ => page
          .diagnostics
          .push(DatabaseTaskRelationReason::IncompatibleRoleConfiguration),
      }
    }
    let config = sqlx::query_scalar::<_, Value>(
      "SELECT config_json FROM workspace_database_fields WHERE database_id=$1 AND id=$2 AND field_type='relation'",
    )
    .bind(read.database_id)
    .bind(field)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let compatible = !task_blocked_by_has_conflicting_task_role(field, iter())
      && roles.iter().any(|role| {
        role.role_key == "task.blockedBy" && role.field_id == field && role.row_kind_scope.as_deref() == Some("task")
      })
      && config
        .and_then(|value| serde_json::from_value::<DatabaseFieldConfig>(value).ok())
        .is_some_and(|config| task_blocked_by_config_compatible(read.database_id, &config));
    if !compatible {
      page
        .diagnostics
        .push(DatabaseTaskRelationReason::IncompatibleRoleConfiguration);
    }
    if kind != "task" {
      page.diagnostics.push(DatabaseTaskRelationReason::WrongRowKind);
    }
    if !live {
      page.diagnostics.push(DatabaseTaskRelationReason::UnavailableTarget);
    }
    page.diagnostics.sort();
    page.diagnostics.dedup();
    if !page.diagnostics.is_empty() {
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      return Ok(page);
    }
    page.available = true;
    if !read.inverse {
      let graph = Self::load_task_relation_graph(&mut tx, read.database_id, field).await?;
      page.diagnostics = graph.blocking_diagnostics(read.database_id, read.row_id);
    }
    let limit = read.limit.clamp(1, DATABASE_MAX_ROWS_PER_PAGE) as usize;
    let mut ids = if read.inverse {
      let readable = task_relation_readable_sql("cell.value_json");
      sqlx::query_scalar::<_, Uuid>(&format!(
        r#"
        SELECT row.id FROM workspace_database_rows row
        JOIN workspace_database_cell_values cell ON cell.row_id=row.id AND cell.field_id=$3
        WHERE row.database_id=$1 AND row.row_kind='task' AND row.deleted_at IS NULL AND row.id<>$2
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN {readable} AND jsonb_typeof(cell.value_json)='array'
                THEN cell.value_json ELSE '[]'::jsonb END
            ) target
            WHERE regexp_replace(target.value #>> '{{}}', '^urn:uuid:', '')::uuid=$2
          )
          AND ($4::uuid IS NULL OR row.id>$4)
        ORDER BY row.id LIMIT $5
      "#,
      ))
      .bind(read.database_id)
      .bind(read.row_id)
      .bind(field)
      .bind(read.after)
      .bind((limit + 1) as i64)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?
    } else {
      page
        .retained_row_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|id| read.after.is_none_or(|after| *id > after))
        .take(limit + 1)
        .collect()
    };
    let has_more = ids.len() > limit;
    ids.truncate(limit);
    let mut summary_ids = ids.clone();
    summary_ids.push(read.row_id);
    let role_rows = sqlx::query(&task_roles_sql(CHILD_PROJECT))
      .bind(read.workspace_id)
      .bind(read.database_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut valid_roles = vec![];
    for role in role_rows {
      match validate_task_role(&role) {
        Ok(Some(key)) => valid_roles.push(key),
        Ok(None) | Err(RepositoryError::Validation(_)) => {}
        Err(error) => return Err(error),
      }
    }
    let valid_status = valid_roles.iter().any(|key| key == "task.status");
    let ctes = task_projection_ctes_with_roles(CHILD_PROJECT, "r.id=ANY($3::uuid[])", Some("$4"));
    let summary = task_summary_sql();
    let raw = sqlx::query(&format!(
      r#"{ctes}
      SELECT p.id, p.deleted_at, p.status_id, p.status_group,
        EXISTS (
          SELECT 1
          FROM database_field_roles status_role
          JOIN workspace_database_cell_values status_cell
            ON status_cell.field_id = status_role.field_id AND status_cell.row_id = p.id
          WHERE status_role.database_id = p.database_id
            AND status_role.role_key = 'task.status' AND status_role.row_kind_scope = 'task'
            AND status_cell.value_json IS NOT NULL
            AND status_cell.value_json <> 'null'::jsonb
            AND jsonb_typeof(status_cell.value_json) <> 'string'
        ) AS malformed_status,
        {summary} AS task
      FROM projected p"#
    ))
    .bind(read.workspace_id)
    .bind(read.database_id)
    .bind(summary_ids)
    .bind(valid_roles)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut summaries = BTreeMap::new();
    let mut states = BTreeMap::new();
    for row in raw {
      let id: Uuid = row.try_get("id").map_err(Self::map_sqlx_error)?;
      let status_id: Option<String> = row.try_get("status_id").map_err(Self::map_sqlx_error)?;
      let group: Option<String> = row.try_get("status_group").map_err(Self::map_sqlx_error)?;
      let trashed: Option<DateTime<Utc>> = row.try_get("deleted_at").map_err(Self::map_sqlx_error)?;
      // Empty native status is unstarted; non-string JSON must not become a
      // known option through the shared summary projection's text extraction.
      let malformed_status: bool = row.try_get("malformed_status").map_err(Self::map_sqlx_error)?;
      let state = if trashed.is_some() || !valid_status || malformed_status || (status_id.is_some() && group.is_none())
      {
        DatabaseTaskBlockingState::Unavailable
      } else if matches!(group.as_deref(), Some("complete" | "archived")) {
        DatabaseTaskBlockingState::Inactive
      } else {
        DatabaseTaskBlockingState::Active
      };
      states.insert(id, state);
      if trashed.is_none() {
        let mut value: Value = row.try_get("task").map_err(Self::map_sqlx_error)?;
        if malformed_status {
          value["status"] = Value::Null;
        }
        if let Some(due) = value.get("due").filter(|due| !due.is_null())
          && !serde_json::from_value::<DatabaseDateTimeValue>(due.clone())
            .ok()
            .is_some_and(|due| {
              due.time_zone.parse::<chrono_tz::Tz>().is_ok() && due.end.is_none_or(|end| end >= due.start)
            })
        {
          value["due"] = Value::Null;
        }
        let task: DatabaseTaskSummary = serde_json::from_value(value)
          .map_err(|_| RepositoryError::Storage("invalid blocking Task summary".into()))?;
        summaries.insert(id, task);
      }
    }
    for id in ids {
      let state = states
        .get(if read.inverse { &read.row_id } else { &id })
        .copied()
        .unwrap_or(DatabaseTaskBlockingState::Unavailable);
      page.rows.push(DatabaseTaskBlockingEntry {
        row_id: id,
        state: if !read.inverse && id == read.row_id {
          DatabaseTaskBlockingState::Unavailable
        } else {
          state
        },
        task: if !read.inverse && id == read.row_id {
          None
        } else {
          summaries.remove(&id)
        },
      });
    }
    page.next_cursor = has_more.then(String::new);
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(page)
  }
}
