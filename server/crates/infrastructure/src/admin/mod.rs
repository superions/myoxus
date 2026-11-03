//! PostgreSQL-backed [`AdminStore`] implementation.
//!
//! [`SqlxAdminStore`] executes privileged queries (user listing, workspace
//! management, admin flag updates, telemetry upserts) directly against the
//! `PgPool`.  All methods are logged at `error` level on DB failure.

use async_trait::async_trait;
use myoxus_application::admin::{
  AdminDashboardProjection, AdminSharedLinkFilter, AdminSharedLinkStats, AdminStore, AdminWorkspaceDetails,
  AdminWorkspaceFilter, AdminWorkspaceStorageStats, UserSearchRow, WorkspaceSearchRow,
};
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_domain::entities::{AccountStatus, User, Workspace};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use tracing::{error, info, instrument};
use uuid::Uuid;

/// PostgreSQL-backed implementation of [`AdminStore`].
pub struct SqlxAdminStore {
  /// Database connection pool.
  pool: PgPool,
}

impl SqlxAdminStore {
  /// Construct a `SqlxAdminStore` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_user(row: sqlx::postgres::PgRow) -> User {
    let status_str: String = row.get("status");
    let disabled = status_str == "disabled";
    User {
      id: row.get("id"),
      email: row.get("email"),
      name: row.get("name"),
      password_hash: row.get("password_hash"),
      avatar_url: None,
      avatar_key: row.get("avatar_key"),
      status: if disabled {
        AccountStatus::Disabled
      } else {
        AccountStatus::Active
      },
      is_admin: row.get("is_admin"),
      registered: true,
      disabled,
      email_verified_at: row.get("email_verified_at"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  fn map_db_err(err: sqlx::Error) -> AuthError {
    error!(error = %err, "database error in admin store");
    AuthError::Storage(err.to_string())
  }

  fn append_workspace_filters<'a>(query: &mut QueryBuilder<'a, Postgres>, filter: &AdminWorkspaceFilter) {
    if let Some(public) = filter.public {
      query.push(" AND w.public = ");
      query.push_bind(public);
    }
    if let Some(enable_ai) = filter.enable_ai {
      query.push(" AND w.enable_ai = ");
      query.push_bind(enable_ai);
    }
    if let Some(enable_sharing) = filter.enable_sharing {
      query.push(" AND w.enable_sharing = ");
      query.push_bind(enable_sharing);
    }
    if let Some(enable_url_preview) = filter.enable_url_preview {
      query.push(" AND w.enable_url_preview = ");
      query.push_bind(enable_url_preview);
    }
    if let Some(enable_doc_embedding) = filter.enable_doc_embedding {
      query.push(" AND w.enable_doc_embedding = ");
      query.push_bind(enable_doc_embedding);
    }

    if let Some(is_personal) = filter.is_personal {
      query.push(" AND w.is_personal_workspace = ");
      query.push_bind(is_personal);
    }
    if let Some(workspace_type) = filter.workspace_type.as_deref() {
      match workspace_type {
        "Personal" => {
          query.push(" AND w.is_personal_workspace = TRUE");
        }
        "UserOwned" => {
          query.push(" AND w.is_personal_workspace = FALSE AND w.owner_principal_type = 'user'");
        }
        "Shared" => {
          query.push(" AND w.owner_principal_type = 'ou'");
        }
        _ => {
          query.push(" AND FALSE");
        }
      };
    }
    if let Some(min) = filter.member_count_min {
      query.push(" AND (SELECT COUNT(*) FROM workspace_memberships m WHERE m.workspace_id = w.id) >= ");
      query.push_bind(min);
    }
    if let Some(max) = filter.member_count_max {
      query.push(" AND (SELECT COUNT(*) FROM workspace_memberships m WHERE m.workspace_id = w.id) <= ");
      query.push_bind(max);
    }

    if let Some(git_sync_enabled) = filter.git_sync_enabled {
      if git_sync_enabled {
        query.push(" AND EXISTS (SELECT 1 FROM git_sync_profiles p WHERE p.workspace_id = w.id AND p.enabled = true)");
      } else {
        query
          .push(" AND NOT EXISTS (SELECT 1 FROM git_sync_profiles p WHERE p.workspace_id = w.id AND p.enabled = true)");
      }
    }
    if let Some(status) = filter.git_sync_last_status.as_deref() {
      query.push(
        " AND (SELECT r.status \
         FROM git_sync_runs r \
         JOIN git_sync_profiles p ON p.id = r.profile_id \
         WHERE p.workspace_id = w.id \
         ORDER BY r.started_at DESC \
         LIMIT 1) = ",
      );
      query.push_bind(status.to_string());
    }
  }

  fn shared_link_pattern(keyword: Option<&str>) -> Option<String> {
    keyword
      .filter(|keyword| !keyword.is_empty())
      .map(|keyword| format!("%{}%", keyword.replace('%', "\\%").replace('_', "\\_")))
  }

  fn map_shared_link(row: sqlx::postgres::PgRow) -> AdminSharedLinkStats {
    AdminSharedLinkStats {
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      title: row.get("title"),
      published_at: row.try_get("published_at").ok(),
      doc_updated_at: row.try_get("doc_updated_at").ok(),
      workspace_owner_id: row.try_get("workspace_owner_id").ok().flatten(),
      last_updater_id: row.try_get("updated_by").ok().flatten(),
      total_views: row.try_get("total_views").unwrap_or(0),
      unique_views: row.try_get("unique_views").unwrap_or(0),
      guest_views: row.try_get("guest_views").unwrap_or(0),
      last_viewed_at: row.try_get("last_viewed_at").ok().flatten(),
    }
  }
}

#[async_trait]
impl AdminStore for SqlxAdminStore {
  #[instrument(skip(self))]
  async fn list_users(&self, skip: i64, take: i64, query: Option<String>) -> AuthResult<Vec<User>> {
    let q = format!("%{}%", query.unwrap_or_default());
    let rows = sqlx::query(
            r#"
            SELECT id, email, name, password_hash, avatar_key, status, is_admin, email_verified_at, created_at, updated_at
            FROM users
            WHERE status <> 'deleted' AND (email ILIKE $1 OR name ILIKE $1)
            ORDER BY created_at DESC, id ASC
            LIMIT $2 OFFSET $3
            "#
        )
        .bind(q)
        .bind(take)
        .bind(skip)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    let users = rows.into_iter().map(Self::map_user).collect();

    Ok(users)
  }

  #[instrument(skip_all)]
  async fn get_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<User>> {
    sqlx::query("SELECT id, email, name, password_hash, avatar_key, status, is_admin, email_verified_at, created_at, updated_at FROM users WHERE id = $1 AND status <> 'deleted'")
      .bind(user_id).fetch_optional(&self.pool).await.map(|row| row.map(Self::map_user)).map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn get_user_by_email(&self, email: &str) -> AuthResult<Option<User>> {
    // Match the existing unique expression index, including older mixed-case rows.
    sqlx::query("SELECT id, email, name, password_hash, avatar_key, status, is_admin, email_verified_at, created_at, updated_at FROM users WHERE lower(email) = lower($1) AND status <> 'deleted'")
      .bind(email).fetch_optional(&self.pool).await.map(|row| row.map(Self::map_user)).map_err(Self::map_db_err)
  }

  #[instrument(skip(self))]
  async fn count_users(&self, query: Option<String>) -> AuthResult<i64> {
    let q = format!("%{}%", query.unwrap_or_default());
    let row = sqlx::query("SELECT COUNT(*) FROM users WHERE status <> 'deleted' AND (email ILIKE $1 OR name ILIKE $1)")
      .bind(q)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(row.get(0))
  }

  #[instrument(skip(self))]
  async fn list_workspaces_filtered(&self, filter: AdminWorkspaceFilter) -> AuthResult<Vec<Workspace>> {
    let q = format!("%{}%", filter.query.as_deref().unwrap_or_default());
    let mut query = QueryBuilder::<Postgres>::new(
      "SELECT w.id, w.owner_user_id, w.name, w.description, w.avatar_key, w.public, w.enable_ai, \
       w.enable_sharing, w.enable_url_preview, w.enable_doc_embedding, w.created_at, w.updated_at, w.initial_content_policy, w.overview_settings, w.overview_revision \
       FROM workspaces w WHERE w.lifecycle_state = 'active' AND (w.name ILIKE ",
    );
    query.push_bind(q.clone());
    query.push(" OR w.id::text ILIKE ");
    query.push_bind(q);
    query.push(")");
    Self::append_workspace_filters(&mut query, &filter);

    let order = match filter.order_by.as_deref() {
      Some("MemberCount") => "(SELECT COUNT(*) FROM workspace_memberships m WHERE m.workspace_id = w.id)",
      Some("SnapshotCount") => "(SELECT COUNT(*) FROM doc_snapshots s WHERE s.workspace_id = w.id)",
      Some("SnapshotSize") => {
        "(SELECT COALESCE(SUM(LENGTH(s.payload)), 0) FROM doc_snapshots s WHERE s.workspace_id = w.id)"
      }
      Some("BlobCount") => "(SELECT COUNT(*) FROM blobs b WHERE b.workspace_id = w.id)",
      Some("BlobSize") => "(SELECT COALESCE(SUM(b.length), 0) FROM blobs b WHERE b.workspace_id = w.id)",
      Some("PublicPageCount") => {
        "(SELECT COUNT(*) FROM workspace_doc_user_settings ds WHERE ds.workspace_id = w.id AND ds.public = true)"
      }
      _ => "w.created_at",
    };
    query.push(" ORDER BY ");
    query.push(order);
    query.push(" DESC LIMIT ");
    query.push_bind(filter.take);
    query.push(" OFFSET ");
    query.push_bind(filter.skip);

    let rows = query.build().fetch_all(&self.pool).await.map_err(Self::map_db_err)?;

    let workspaces = rows
      .into_iter()
      .map(crate::workspace::map_workspace_row)
      .collect::<Result<Vec<_>, _>>()
      .map_err(Self::map_db_err)?;

    Ok(workspaces)
  }

  #[instrument(skip(self))]
  async fn count_workspaces_filtered(&self, filter: &AdminWorkspaceFilter) -> AuthResult<i64> {
    let q = format!("%{}%", filter.query.as_deref().unwrap_or_default());
    let mut query = QueryBuilder::<Postgres>::new(
      "SELECT COUNT(*) FROM workspaces w WHERE w.lifecycle_state = 'active' AND (w.name ILIKE ",
    );
    query.push_bind(q.clone());
    query.push(" OR w.id::text ILIKE ");
    query.push_bind(q);
    query.push(")");
    Self::append_workspace_filters(&mut query, filter);

    let row = query.build().fetch_one(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(row.get(0))
  }

  #[instrument(skip(self))]
  async fn get_workspace(&self, workspace_id: Uuid) -> AuthResult<Option<Workspace>> {
    let row = sqlx::query(
      r#"
            SELECT id, owner_user_id, name, description, avatar_key, public, enable_ai, enable_sharing,
                   enable_url_preview, enable_doc_embedding, created_at, updated_at, deleted_at, initial_content_policy, overview_settings, overview_revision
            FROM workspaces
            WHERE id = $1 AND lifecycle_state = 'active'
            "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let ws = row
      .map(crate::workspace::map_workspace_row)
      .transpose()
      .map_err(Self::map_db_err)?;

    Ok(ws)
  }

  #[instrument(skip(self))]
  async fn workspace_storage_stats(&self, workspace_id: Uuid) -> AuthResult<AdminWorkspaceStorageStats> {
    let row = sqlx::query(
      r#"
      SELECT
        (SELECT COUNT(*)::bigint FROM doc_snapshots WHERE workspace_id = $1) AS snapshot_count,
        COALESCE(stats.snapshot_size, 0)::bigint AS snapshot_size,
        (SELECT COUNT(*)::bigint FROM blobs WHERE workspace_id = $1) AS blob_count,
        COALESCE(stats.blob_size, 0)::bigint AS blob_size
      FROM (SELECT 1) present
      LEFT JOIN workspace_storage_stats stats ON stats.workspace_id = $1
      "#,
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(AdminWorkspaceStorageStats {
      snapshot_count: row.get("snapshot_count"),
      snapshot_size: row.get("snapshot_size"),
      blob_count: row.get("blob_count"),
      blob_size: row.get("blob_size"),
    })
  }

  #[instrument(skip(self))]
  async fn count_shared_links(&self, filter: &AdminSharedLinkFilter) -> AuthResult<i64> {
    sqlx::query_scalar(
      r#"
      SELECT COUNT(*)::bigint
      FROM docs
      WHERE public_mode IS NOT NULL
        AND deleted_at IS NULL
        AND ($1::uuid IS NULL OR workspace_id = $1)
        AND ($2::text IS NULL OR title ILIKE $2 ESCAPE '\')
      "#,
    )
    .bind(filter.workspace_id)
    .bind(Self::shared_link_pattern(filter.keyword.as_deref()))
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  #[instrument(skip(self))]
  async fn list_shared_links(&self, filter: AdminSharedLinkFilter) -> AuthResult<Vec<AdminSharedLinkStats>> {
    let rows = sqlx::query(
      r#"
      SELECT
        d.workspace_id,
        COALESCE(d.external_id, d.id::text) AS doc_id,
        COALESCE(d.title, '') AS title,
        d.updated_at AS doc_updated_at,
        d.created_at AS published_at,
        d.updated_by,
        w.owner_user_id AS workspace_owner_id,
        COALESCE(views.total_views, 0)::bigint AS total_views,
        COALESCE(views.unique_views, 0)::bigint AS unique_views,
        COALESCE(views.guest_views, 0)::bigint AS guest_views,
        views.last_accessed_at AS last_viewed_at
      FROM docs d
      LEFT JOIN workspaces w ON w.id = d.workspace_id
      LEFT JOIN LATERAL (
        SELECT
          SUM(total_views)::bigint AS total_views,
          SUM(unique_views)::bigint AS unique_views,
          SUM(guest_views)::bigint AS guest_views,
          MAX(last_accessed_at) AS last_accessed_at
        FROM workspace_doc_view_daily
        WHERE workspace_id = d.workspace_id
          AND doc_id = d.id::text
          AND date >= CURRENT_DATE - INTERVAL '28 days'
      ) views ON true
      WHERE d.public_mode IS NOT NULL
        AND d.deleted_at IS NULL
        AND ($1::uuid IS NULL OR d.workspace_id = $1)
        AND ($2::text IS NULL OR d.title ILIKE $2 ESCAPE '\')
      ORDER BY d.updated_at DESC
      LIMIT $3 OFFSET $4
      "#,
    )
    .bind(filter.workspace_id)
    .bind(Self::shared_link_pattern(filter.keyword.as_deref()))
    .bind(filter.limit)
    .bind(filter.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_shared_link).collect())
  }

  #[instrument(skip(self))]
  async fn dashboard_projection(&self, sync_hours: i32, storage_days: i32) -> AuthResult<AdminDashboardProjection> {
    let sync_active_users = sqlx::query_scalar(
      "SELECT COALESCE(SUM(active_users), 0)::bigint FROM workspace_analytics_minute WHERE bucket_at > now() - interval '5 minutes'",
    )
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let workspace_storage_bytes =
      sqlx::query_scalar("SELECT COALESCE(SUM(snapshot_size), 0)::bigint FROM workspace_storage_stats")
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    let blob_storage_bytes =
      sqlx::query_scalar("SELECT COALESCE(SUM(blob_size), 0)::bigint FROM workspace_storage_stats")
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    let sync_active_users_timeline = sqlx::query_as(
      r#"
      SELECT bucket_at, COALESCE(SUM(active_users), 0)::int
      FROM workspace_analytics_minute
      WHERE bucket_at > now() - make_interval(hours => $1)
      GROUP BY bucket_at
      ORDER BY bucket_at ASC
      "#,
    )
    .bind(sync_hours)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let workspace_storage_history = sqlx::query_as(
      r#"
      SELECT day::timestamptz, COALESCE(SUM(snapshot_size), 0)::bigint
      FROM workspace_storage_stats_daily
      WHERE day > (now() - make_interval(days => $1))::date
      GROUP BY day
      ORDER BY day ASC
      "#,
    )
    .bind(storage_days)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let blob_storage_history = sqlx::query_as(
      r#"
      SELECT day::timestamptz, COALESCE(SUM(blob_size), 0)::bigint
      FROM workspace_storage_stats_daily
      WHERE day > (now() - make_interval(days => $1))::date
      GROUP BY day
      ORDER BY day ASC
      "#,
    )
    .bind(storage_days)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let top_shared_links = sqlx::query(
      r#"
      SELECT
        d.workspace_id,
        COALESCE(d.external_id, d.id::text) AS doc_id,
        COALESCE(d.title, '') AS title,
        d.updated_at AS published_at,
        d.updated_at AS doc_updated_at,
        d.updated_by,
        w.owner_user_id AS workspace_owner_id,
        COALESCE(views.total_views, 0)::bigint AS total_views,
        COALESCE(views.unique_views, 0)::bigint AS unique_views,
        COALESCE(views.guest_views, 0)::bigint AS guest_views,
        views.last_accessed_at AS last_viewed_at
      FROM docs d
      LEFT JOIN workspaces w ON w.id = d.workspace_id
      LEFT JOIN LATERAL (
        SELECT
          SUM(total_views)::bigint AS total_views,
          SUM(unique_views)::bigint AS unique_views,
          SUM(guest_views)::bigint AS guest_views,
          MAX(last_accessed_at) AS last_accessed_at
        FROM workspace_doc_view_daily
        WHERE workspace_id = d.workspace_id
          AND doc_id = d.id::text
          AND date >= CURRENT_DATE - INTERVAL '28 days'
      ) views ON true
      WHERE d.public_mode IS NOT NULL AND d.deleted_at IS NULL
      ORDER BY COALESCE(views.total_views, 0) DESC, d.updated_at DESC
      LIMIT 20
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .into_iter()
    .map(Self::map_shared_link)
    .collect();
    Ok(AdminDashboardProjection {
      sync_active_users,
      workspace_storage_bytes,
      blob_storage_bytes,
      sync_active_users_timeline,
      workspace_storage_history,
      blob_storage_history,
      top_shared_links,
    })
  }

  #[instrument(skip(self))]
  async fn workspace_details(&self, workspace_id: Uuid) -> AuthResult<Option<AdminWorkspaceDetails>> {
    let row = sqlx::query(
      r#"
      SELECT
        w.storage_quota_bytes,
        w.owner_principal_type::text AS owner_principal_type,
        w.owner_principal_id,
        unit.name AS owner_principal_name,
        profile.id AS git_sync_profile_id,
        profile.trigger_mode AS git_sync_trigger_mode,
        cron.next_due_at AS git_sync_next_scheduled_at,
        run.status AS git_sync_last_status,
        run.started_at AS git_sync_last_run_at
      FROM workspaces w
      LEFT JOIN organization_unit unit
        ON w.owner_principal_type = 'ou' AND unit.id = w.owner_principal_id
      LEFT JOIN LATERAL (
        SELECT id, trigger_mode
        FROM git_sync_profiles
        WHERE workspace_id = w.id AND enabled = true
        ORDER BY updated_at DESC
        LIMIT 1
      ) profile ON true
      LEFT JOIN scheduling_schedules cron ON cron.id=profile.id AND cron.target_json->>'kind'='git_cron'
      LEFT JOIN LATERAL (
        SELECT runs.status, runs.started_at
        FROM git_sync_runs runs
        JOIN git_sync_profiles profiles ON profiles.id = runs.profile_id
        WHERE profiles.workspace_id = w.id
        ORDER BY runs.started_at DESC
        LIMIT 1
      ) run ON true
      WHERE w.id = $1
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| {
      AdminWorkspaceDetails {
        storage_quota_bytes: row.try_get("storage_quota_bytes").ok().flatten(),
        owner_principal_type: row
          .try_get("owner_principal_type")
          .unwrap_or_else(|_| "system".to_string()),
        owner_principal_id: row.try_get("owner_principal_id").ok().flatten(),
        owner_principal_name: row.try_get("owner_principal_name").ok().flatten(),
        git_sync_profile_id: row.try_get("git_sync_profile_id").ok().flatten(),
        git_sync_trigger_mode: row.try_get("git_sync_trigger_mode").ok().flatten(),
        git_sync_next_scheduled_at: row.try_get("git_sync_next_scheduled_at").ok().flatten(),
        git_sync_last_status: row.try_get("git_sync_last_status").ok().flatten(),
        git_sync_last_run_at: row.try_get("git_sync_last_run_at").ok().flatten(),
      }
    }))
  }

  #[instrument(skip(self))]
  async fn search_workspaces(
    &self,
    query: &str,
    ou_id: Option<Uuid>,
    exclude_ou_id: Option<Uuid>,
    limit: i64,
  ) -> AuthResult<Vec<WorkspaceSearchRow>> {
    // Substring search via ILIKE — `query` is bound, never interpolated.
    // Joins users for the owner-email snapshot and aggregates linked
    // organization_unit_workspace ids. When `ou_id` is set we filter to
    // workspaces that have at least one row linking them to that OU
    // (regardless of relationship); when `exclude_ou_id` is set we remove
    // workspaces already linked to that OU. The aggregate still returns ALL
    // OU links for each remaining workspace so the picker can show context.
    let pattern = format!("%{}%", query);
    let mut qb = QueryBuilder::<Postgres>::new(
      r#"SELECT w.id              AS id,
                w.name            AS name,
                w.owner_user_id   AS owner_user_id,
                u.email           AS owner_email,
                COALESCE(
                  (SELECT ARRAY_AGG(DISTINCT ouw2.unit_id)
                     FROM organization_unit_workspace ouw2
                    WHERE ouw2.workspace_id = w.id),
                  ARRAY[]::UUID[]
                )                 AS linked_ous
           FROM workspaces w
           LEFT JOIN users u ON u.id = w.owner_user_id
          WHERE w.lifecycle_state = 'active' AND w.name ILIKE "#,
    );
    qb.push_bind(pattern);

    if let Some(ou) = ou_id {
      qb.push(
        " AND EXISTS (
           SELECT 1 FROM organization_unit_workspace ouw
            WHERE ouw.workspace_id = w.id
              AND ouw.unit_id = ",
      );
      qb.push_bind(ou);
      qb.push(")");
    }

    if let Some(excluded_ou) = exclude_ou_id {
      qb.push(
        " AND NOT EXISTS (
           SELECT 1 FROM organization_unit_workspace ouw_excluded
            WHERE ouw_excluded.workspace_id = w.id
              AND ouw_excluded.unit_id = ",
      );
      qb.push_bind(excluded_ou);
      qb.push(")");
    }

    qb.push(" ORDER BY w.name ASC LIMIT ");
    qb.push_bind(limit);

    let rows = qb.build().fetch_all(&self.pool).await.map_err(Self::map_db_err)?;

    let out = rows
      .into_iter()
      .map(|row| WorkspaceSearchRow {
        id: row.get("id"),
        name: row.get("name"),
        owner_user_id: row.try_get("owner_user_id").ok().flatten(),
        owner_email: row.try_get("owner_email").ok().flatten(),
        linked_ou_ids: row.try_get::<Vec<Uuid>, _>("linked_ous").unwrap_or_default(),
      })
      .collect();
    Ok(out)
  }

  #[instrument(skip(self))]
  async fn search_users(&self, query: &str, features: Option<&[String]>, limit: i64) -> AuthResult<Vec<UserSearchRow>> {
    // Substring search via ILIKE against email/name. The aggregate
    // `ARRAY_AGG(... FILTER (WHERE activated))` yields the list of
    // active feature names per user (empty array when none). When
    // `features` is provided we add a `HAVING` clause that requires the
    // active-feature set to be a superset of the requested filter
    // (`@>` on text[]).
    let pattern = format!("%{}%", query);
    let mut qb = QueryBuilder::<Postgres>::new(
      r#"SELECT u.id              AS id,
                u.email            AS email,
                u.name             AS name,
                u.is_admin         AS is_admin,
                u.status           AS status,
                COALESCE(
                  ARRAY_REMOVE(
                    ARRAY_AGG(uf.feature_name) FILTER (WHERE uf.activated = TRUE),
                    NULL
                  ),
                  ARRAY[]::TEXT[]
                )                  AS features
           FROM users u
           LEFT JOIN user_features uf ON uf.user_id = u.id
          WHERE u.status <> 'deleted' AND (u.email ILIKE "#,
    );
    qb.push_bind(pattern.clone());
    qb.push(" OR u.name ILIKE ");
    qb.push_bind(pattern);
    qb.push(")");

    if let Some(feats) = features
      && !feats.is_empty()
    {
      // Require every requested feature via one EXISTS predicate per feature.
      // This avoids binding a driver-specific TEXT[] value and keeps the
      // filter independent from the aggregate used to return active features.
      for feature in feats {
        qb.push(" AND EXISTS (SELECT 1 FROM user_features req WHERE req.user_id = u.id AND req.feature_name = ");
        qb.push_bind(feature);
        qb.push(" AND req.activated = TRUE)");
      }
    }

    qb.push(" GROUP BY u.id");
    qb.push(" ORDER BY u.email ASC LIMIT ");
    qb.push_bind(limit);

    let rows = qb.build().fetch_all(&self.pool).await.map_err(Self::map_db_err)?;

    let out = rows
      .into_iter()
      .map(|row| {
        let status_str: String = row.try_get("status").unwrap_or_else(|_| "active".to_string());
        UserSearchRow {
          id: row.get("id"),
          email: row.get("email"),
          name: row.get("name"),
          features: row.try_get::<Vec<String>, _>("features").unwrap_or_default(),
          is_admin: row.try_get("is_admin").unwrap_or(false),
          disabled: status_str == "disabled",
        }
      })
      .collect();
    Ok(out)
  }

  #[instrument(skip(self))]
  async fn delete_workspace(&self, workspace_id: Uuid) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    crate::workspace::SqlxWorkspaceStore::guard_hard_delete_in_transaction(&mut tx, &[workspace_id]).await?;
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let cleanup = crate::branding::cleanup_orphaned_workspace_theme_override_rows(&mut tx)
      .await
      .map_err(|err| AuthError::Storage(err.to_string()))?;
    tx.commit().await.map_err(Self::map_db_err)?;
    info!(
      workspace_id = %workspace_id,
      deleted_workspace_themes = cleanup.themes,
      deleted_workspace_color_schemas = cleanup.color_schemas,
      deleted_workspace_typography_sets = cleanup.typography_sets,
      "workspace hard-delete cleaned orphaned workspace theme override rows"
    );
    Ok(())
  }

  #[instrument(skip(self))]
  async fn upsert_active_users_metric(
    &self,
    workspace_id: Uuid,
    minute: chrono::DateTime<chrono::Utc>,
    count: i32,
  ) -> AuthResult<()> {
    // Leased Redis observation may outlive a hard-deleted workspace. Select
    // and lock the existing parent; missing parents produce no orphan sample,
    // while concurrent deletion waits for this statement's FK-safe write.
    sqlx::query(
      r#"
            INSERT INTO workspace_analytics_minute (workspace_id, bucket_at, active_users)
            SELECT id, $2, $3 FROM workspaces WHERE id = $1 FOR KEY SHARE
            ON CONFLICT (workspace_id, bucket_at) DO UPDATE SET
                active_users = EXCLUDED.active_users
            "#,
    )
    .bind(workspace_id)
    .bind(minute)
    .bind(count)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }
}
