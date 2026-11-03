//! Root authenticated GraphQL query resolver (`AuthQuery`).
//!
//! Wires together all query sub-objects (user, workspace, document, blob,
//! team, search, copilot, calendar, notifications, admin) under a single
//! `AuthQuery` struct that is exposed on the schema's `Query` root after
//! session validation.

use std::sync::Arc;

use async_graphql::{Context, ErrorExtensions, ID, Object, Result};
use chrono::{DateTime, Utc};
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::graphql::utils::{map_gql_error, require_session, require_session_allow_unverified};
use crate::search::{SearchQuery, count_visible_docs, search_visible_docs};
use crate::state::ApiState;
use myoxus_application::auth::AuthError;
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::{SearchSortBy, SortDirection};

use super::calendar::{
  CalendarAccountType, CalendarCalDAVProviderPresetObjectType, CalendarEventTagType, CalendarEventType,
  CalendarFreeBusyPeriod, CalendarProviderType, UserFreeBusy, WorkspaceCalendarSettingsType, WorkspaceCalendarType,
  map_calendar_account, map_calendar_event_for_workspace, map_calendar_event_tag, map_calendar_events_for_workspace,
  map_workspace_calendar, map_workspace_calendar_settings,
};
use super::{
  ClientUpdateControlType, CommentEditHistoryType, CommentThreadFilterType, CommentType, CredentialsRequirementType,
  FeatureType, InvitationType, InvitationWorkspaceType, OAuthProviderType, PasswordLimitsType, PublicUserType,
  QueryRoot, RevealedAccessToken, SearchAggregateType, SearchDocType, SearchSortByType, ServerClientConfigType,
  ServerConfigType, ServerDeploymentType, ServerFeature, ServerGitSyncConfigType, ServerI18nConfigType,
  ServerJournalConfigType, ServerPreviewClientConfigType, SortDirectionType, UserOrLimitedUser, UserType,
  WorkspaceMemberStatus, WorkspaceMemberType, WorkspaceRolePermissions, WorkspaceType, map_search_sort_by,
  map_sort_direction,
};

#[Object]
impl QueryRoot {
  /// Actor-scoped, redacted durable XWS status.
  #[instrument(skip_all)]
  pub(crate) async fn workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<super::WorkspaceContentOperationType> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?;
    let projection = service
      .status(operation_id, snapshot.user.id)
      .await
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    Ok(super::WorkspaceContentOperationType::from_projection(projection))
  }

  /// Resolve an old XWS route only when the actor can currently read the
  /// canonical target. Denied and missing targets both return `null`.
  #[instrument(skip_all)]
  pub(crate) async fn workspace_content_redirect(
    &self,
    ctx: &Context<'_>,
    input: super::WorkspaceContentRedirectInput,
  ) -> Result<Option<super::WorkspaceContentRedirectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_content_redirect_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content redirects are unavailable"))?;
    let source = myoxus_domain::workspace_content_operation::WorkspaceContentResourceRef::new(
      input.workspace_id,
      input.resource.kind.into(),
      input.resource.id,
    )
    .map_err(|_| {
      map_gql_error(AuthError::InvalidInput(
        "invalid workspace content resource".to_string(),
      ))
    })?;
    match service.resolve(snapshot.user.id, source).await {
      Ok(target) => Ok(Some(super::WorkspaceContentRedirectType {
        workspace_id: target.workspace_id(),
        kind: target.kind().into(),
        id: target.resource_id().to_string(),
      })),
      Err(AuthError::NotFound(_)) | Err(AuthError::ActionForbidden) => Ok(None),
      Err(error) => Err(map_gql_error(error)),
    }
  }

  /// Public, cache-free projection of the server-owned Browser Web update policy.
  ///
  /// A malformed or unavailable value fails closed with a stable transport code;
  /// persistence details are intentionally kept out of the client-visible error.
  #[instrument(skip_all)]
  pub(crate) async fn client_update_control(&self, ctx: &Context<'_>) -> Result<ClientUpdateControlType> {
    let state = ctx
      .data::<Arc<ApiState>>()
      .expect("ApiState missing from GraphQL context — check handler setup");
    let runtime = state.client_update_runtime().ok_or_else(|| {
      async_graphql::Error::new("client update control unavailable").extend_with(|_, extensions| {
        extensions.set("code", "CLIENT_UPDATE_CONTROL_UNAVAILABLE");
      })
    })?;
    runtime
      .read_authoritative()
      .await
      .map(ClientUpdateControlType::from)
      .map_err(|_| {
        tracing::error!("authoritative client update control read failed");
        async_graphql::Error::new("client update control unavailable").extend_with(|_, extensions| {
          extensions.set("code", "CLIENT_UPDATE_CONTROL_UNAVAILABLE");
        })
      })
  }

  /// Plan persisted editor-local Database migration without product writes.
  #[instrument(skip_all)]
  pub(crate) async fn preview_legacy_database_migration(
    &self,
    ctx: &Context<'_>,
    input: super::database::LegacyDatabaseMigrationInput,
  ) -> Result<super::database::LegacyDatabaseMigrationPlanObjectType> {
    super::database::preview_legacy_database_migration(ctx, input).await
  }

  // Intentionally unauthenticated: client needs version, features, and OAuth providers before sign-in.
  /// Complexity 30: loads user count, feature/config state, and OAuth checks
  /// plus 2 more for gitSync and journal config.
  #[graphql(complexity = 30)]
  #[instrument(skip_all)]
  pub(crate) async fn server_config(&self, ctx: &Context<'_>) -> Result<ServerConfigType> {
    // INVARIANT: ApiState is always injected by graphql_handler via .data::<Arc<ApiState>>().
    // If it were missing that would be a startup programming error, not a runtime data issue.
    let state = ctx
      .data::<Arc<ApiState>>()
      .expect("ApiState missing from GraphQL context — check handler setup");

    // P84-H-06 + H-18: Cache the entire serverConfig result via moka
    // try_get_with() for stampede protection.  DB errors are never cached.
    let metrics = state.query_cache.metrics_server_config.clone();

    // Fast path: check if already cached.
    if let Some(cached_json) = state.query_cache.server_config.get(&"global".to_string()).await {
      metrics.record_hit();
      debug!("server_config cache HIT");
      return match serde_json::from_value::<ServerConfigType>(cached_json) {
        Ok(config) => Ok(config),
        Err(e) => {
          warn!(error = %e, "server_config deserialization failed — rebuilding");
          Self::build_server_config(state).await.map_err(|error| {
            tracing::error!(error = %error, "server_config cache-hit rebuild failed");
            async_graphql::Error::new("server configuration unavailable")
          })
        }
      };
    }
    metrics.record_miss();

    // Slow path: populate via try_get_with() for stampede protection. A
    // capability-store failure is returned and never cached as a false
    // "uninitialized/no provider" projection.
    let state_clone = state.clone();
    let cached_json: std::result::Result<serde_json::Value, Arc<crate::state::CacheLoadError>> = state
      .query_cache
      .server_config
      .try_get_with("global".to_string(), async {
        debug!("server_config cache MISS — querying DB");
        let value = Self::build_server_config(&state_clone).await?;
        serde_json::to_value(&value).map_err(|error| {
          tracing::error!(error = %error, "server_config serialization failed");
          crate::state::CacheLoadError("server configuration serialization failed".to_string())
        })
      })
      .await;
    let cached_json = cached_json.map_err(|error| {
      tracing::error!(error = %error, "server_config cache load failed");
      async_graphql::Error::new("server configuration unavailable")
    })?;

    match serde_json::from_value::<ServerConfigType>(cached_json) {
      Ok(config) => Ok(config),
      Err(e) => {
        warn!(error = %e, "server_config deserialization failed — rebuilding");
        Self::build_server_config(state).await.map_err(|error| {
          tracing::error!(error = %error, "server_config rebuild failed");
          async_graphql::Error::new("server configuration unavailable")
        })
      }
    }
  }

  #[instrument(skip_all)]
  pub(crate) async fn current_user(&self, ctx: &Context<'_>) -> Option<UserType> {
    let (_, snapshot) = require_session_allow_unverified(ctx).await.ok()?;
    Some(snapshot.user.into())
  }

  /// Search server users by name or email (privacy-scoped — no email/admin field exposure).
  ///
  /// Permission: caller must be admin OR must hold `WorkspaceRole::Admin` (or higher)
  /// on at least one workspace (`WorkspaceAction::UsersManage`).
  #[graphql(name = "serverUsers")]
  #[instrument(skip_all, fields(search = %search))]
  pub(crate) async fn server_users(
    &self,
    ctx: &Context<'_>,
    search: String,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<super::ServerUserSearchResult>> {
    let (state, snapshot) = require_session(ctx).await?;

    // Permission: admin always passes; others need UsersManage on any workspace.
    if !snapshot.user.is_admin {
      let permitted = state
        .workspace()
        .has_managed_workspace(snapshot.user.id)
        .await
        .unwrap_or(false);
      if !permitted {
        warn!(user_id = %snapshot.user.id, "serverUsers: permission denied — no managed workspace");
        return Err(map_gql_error(myoxus_application::auth::AuthError::ActionForbidden));
      }
    }

    let skip = skip.unwrap_or(0).max(0) as i64;
    let take = take.unwrap_or(20).clamp(1, 50) as i64;
    let query = if search.trim().is_empty() {
      None
    } else {
      Some(search.clone())
    };
    debug!(user_id = %snapshot.user.id, ?query, skip, take, "serverUsers search");

    let users = state
      .admin()
      .list_users(skip, take, query)
      .await
      .map_err(map_gql_error)?;

    Ok(
      users
        .into_iter()
        .map(|u| super::ServerUserSearchResult {
          id: async_graphql::ID::from(u.id.to_string()),
          name: u.name,
          // avatar_key takes precedence over avatar_url (list_users returns avatar_url=None)
          avatar_url: u.avatar_key.or(u.avatar_url),
        })
        .collect(),
    )
  }

  #[instrument(skip_all)]
  pub(crate) async fn user(&self, ctx: &Context<'_>, email: String) -> Result<Option<UserOrLimitedUser>> {
    let (state, snapshot) = require_session(ctx).await?;

    myoxus_application::auth::validate_email(&email).map_err(map_gql_error)?;
    let user = state
      .auth()
      .get_user_by_email(&email, snapshot.user.id)
      .await
      .map_err(map_gql_error)?;
    let Some(user) = user else {
      return Ok(None);
    };
    Ok(Some(UserOrLimitedUser::UserType(user.into())))
  }

  #[instrument(skip_all)]
  pub(crate) async fn public_user_by_id(&self, ctx: &Context<'_>, id: String) -> Result<Option<PublicUserType>> {
    // API-C-02: Require authentication to prevent unauthenticated user enumeration.
    let (state, _snapshot) = require_session(ctx).await?;
    let uuid = Uuid::parse_str(&id).map_err(|_| "Invalid id")?;
    let user = state.auth().get_historical_profile(uuid).await.map_err(map_gql_error)?;
    Ok(user.map(|u| PublicUserType {
      id: ID::from(u.id.to_string()),
      email: u.email.clone(),
      name: u.name.unwrap_or(u.email),
      avatar_url: u.avatar_url,
    }))
  }

  #[graphql(deprecation = "use currentUser.revealedAccessTokens")]
  #[instrument(skip_all)]
  pub(crate) async fn revealed_access_tokens(&self, ctx: &Context<'_>) -> Result<Vec<RevealedAccessToken>> {
    let (state, snapshot) = require_session(ctx).await?;

    let tokens = state
      .auth()
      .list_access_tokens(snapshot.user.id)
      .await
      .map_err(map_gql_error)?;
    Ok(
      tokens
        .into_iter()
        .map(|t| RevealedAccessToken {
          id: t.id,
          name: t.name,
          created_at: t.created_at,
          expires_at: t.expires_at,
          token: "[REDACTED]".to_string(),
        })
        .collect(),
    )
  }

  #[instrument(skip_all)]
  pub(crate) async fn oauth_providers(&self, ctx: &Context<'_>) -> Result<Vec<OAuthProviderType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    let capabilities = crate::auth::capabilities::evaluate_auth_capabilities(state)
      .await
      .map_err(map_gql_error)?;
    Ok(
      [
        (
          myoxus_application::auth::AuthMethodCode::Google,
          OAuthProviderType::Google,
        ),
        (
          myoxus_application::auth::AuthMethodCode::Github,
          OAuthProviderType::GitHub,
        ),
        (myoxus_application::auth::AuthMethodCode::Oidc, OAuthProviderType::Oidc),
        (
          myoxus_application::auth::AuthMethodCode::Apple,
          OAuthProviderType::Apple,
        ),
      ]
      .into_iter()
      .filter_map(|(method, provider)| {
        capabilities
          .method(method)
          .is_some_and(|capability| capability.usable)
          .then_some(provider)
      })
      .collect(),
    )
  }

  /// Complexity 20 * child: lists all workspaces for a user; each returned workspace
  /// may have expensive sub-field resolvers.
  #[graphql(complexity = "20 * child_complexity")]
  #[instrument(skip_all)]
  pub(crate) async fn workspaces(&self, ctx: &Context<'_>) -> Result<Vec<WorkspaceType>> {
    let (state, snapshot) = require_session(ctx).await?;

    debug!(user_id = %snapshot.user.id, "listing accessible workspaces");
    let mut workspaces = state
      .workspace()
      .list_workspaces(snapshot.user.id)
      .await
      .map_err(map_gql_error)?;

    // OU-manager scope is an authorization projection, not a synthetic
    // membership. Include those workspaces explicitly so a manager can enter
    // the same routes whose capabilities the permission service grants.
    if let Some(org_permission) = state.organization_permission_service() {
      match org_permission.manageable_workspace_ids(snapshot.user.id).await {
        Ok(workspace_ids) => {
          let mut known = workspaces
            .iter()
            .map(|workspace| workspace.id)
            .collect::<std::collections::HashSet<_>>();
          for workspace_id in workspace_ids {
            if known.insert(workspace_id)
              && let Some(workspace) = state
                .workspace()
                .get_workspace(workspace_id)
                .await
                .map_err(map_gql_error)?
            {
              workspaces.push(workspace);
            }
          }
        }
        Err(error) => {
          debug!(
            error = %error,
            user_id = %snapshot.user.id,
            "OU-manager workspace listing failed closed"
          );
        }
      }
    }

    Ok(workspaces.into_iter().map(|workspace| workspace.into()).collect())
  }

  #[instrument(skip_all)]
  pub(crate) async fn workspace_import(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<super::WorkspaceImportType> {
    let (state, snapshot) = require_session(ctx).await?;
    let import_id = Uuid::parse_str(workspace_import_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace import id".to_string())))?;
    let service = state
      .workspace_import_service()
      .ok_or_else(|| async_graphql::Error::new("workspace import service is not configured"))?;
    let record = service
      .status(snapshot.user.id, import_id)
      .await
      .map_err(map_gql_error)?;
    super::map_workspace_import(record).map_err(|_| async_graphql::Error::new("workspace import projection is invalid"))
  }

  /// Complexity 10 * child: permission check + workspace fetch; child fields may trigger
  /// additional DB queries.
  #[graphql(complexity = "10 * child_complexity")]
  #[instrument(skip_all)]
  pub(crate) async fn workspace(
    &self,
    ctx: &Context<'_>,
    id: String,
    #[graphql(name = "docId")] _doc_id: Option<String>,
  ) -> Result<Option<WorkspaceType>> {
    let (state, snapshot) = require_session(ctx).await?;

    let workspace_id = Uuid::parse_str(&id).map_err(|_| "Invalid id")?;

    let pc = state.permission_service();
    if let Err(e) = pc
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id,
        },
        WorkspaceAction::Read,
      )
      .await
    {
      warn!(workspace_id = %workspace_id, user_id = %snapshot.user.id, "access denied for workspace query");
      return Err(map_gql_error(e));
    }

    let workspace = state
      .workspace()
      .get_workspace(workspace_id)
      .await
      .map_err(map_gql_error)?;
    Ok(workspace.map(|w| w.into()))
  }

  #[instrument(skip_all)]
  pub(crate) async fn workspace_role_permissions(
    &self,
    ctx: &Context<'_>,
    id: String,
  ) -> Result<WorkspaceRolePermissions> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_id = Uuid::parse_str(&id).map_err(|_| "Invalid id")?;
    let access = state
      .permission_service()
      .resolve_workspace_access(snapshot.user.id, workspace_id)
      .await
      .map_err(map_gql_error)?;
    let effective_role = access
      .effective_role
      .unwrap_or(myoxus_domain::entities::WorkspaceRole::External);
    if !effective_role.can(WorkspaceAction::Read)
      || state
        .workspace()
        .get_workspace(workspace_id)
        .await
        .map_err(map_gql_error)?
        .is_none()
    {
      warn!(workspace_id = %id, "workspace not found or access denied for role_permissions");
      return Err(map_gql_error(AuthError::InvalidInput(
        "Workspace not found".to_string(),
      )));
    }

    let role = access
      .direct_role
      .unwrap_or(myoxus_domain::entities::WorkspaceRole::External);
    let permissions = super::WorkspacePermissions::from_role(effective_role);
    Ok(WorkspaceRolePermissions {
      role: role.into(),
      permissions,
    })
  }

  /// Complexity 50: FTS query + optional semantic search + per-doc ACL filtering.
  #[graphql(complexity = 50)]
  #[instrument(skip_all)]
  #[allow(clippy::too_many_arguments)]
  pub(crate) async fn search(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    query: String,
    language: Option<String>,
    skip: Option<i32>,
    take: Option<i32>,
    sort_by: Option<SearchSortByType>,
    sort_direction: Option<SortDirectionType>,
    use_semantic_search: Option<bool>,
  ) -> Result<Vec<SearchDocType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;

    let docs = search_visible_docs(
      state.clone(),
      snapshot.user.id,
      SearchQuery {
        workspace_id: workspace_uuid,
        query,
        language,
        limit: take.unwrap_or(20).clamp(1, 100) as i64,
        offset: skip.unwrap_or(0).max(0) as i64,
        sort_by: map_search_sort_by(sort_by),
        sort_direction: map_sort_direction(sort_direction),
        use_semantic_search: use_semantic_search.unwrap_or(false),
      },
    )
    .await
    .map_err(map_gql_error)?;
    debug!(workspace_id = %workspace_uuid, user_id = %snapshot.user.id, hits = docs.len(), "graphql search completed");
    Ok(docs.into_iter().map(SearchDocType::from).collect())
  }

  #[instrument(skip_all)]
  #[allow(clippy::too_many_arguments)]
  pub(crate) async fn search_docs(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    query: String,
    language: Option<String>,
    skip: Option<i32>,
    take: Option<i32>,
    sort_by: Option<SearchSortByType>,
    sort_direction: Option<SortDirectionType>,
    use_semantic_search: Option<bool>,
  ) -> Result<Vec<SearchDocType>> {
    self
      .search(
        ctx,
        workspace_id,
        query,
        language,
        skip,
        take,
        sort_by,
        sort_direction,
        use_semantic_search,
      )
      .await
  }

  #[instrument(skip_all)]
  pub(crate) async fn aggregate(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    query: String,
    language: Option<String>,
  ) -> Result<SearchAggregateType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;

    let total = count_visible_docs(
      state.clone(),
      snapshot.user.id,
      SearchQuery {
        workspace_id: workspace_uuid,
        query,
        language,
        limit: 100,
        offset: 0,
        sort_by: SearchSortBy::Relevance,
        sort_direction: SortDirection::Desc,
        use_semantic_search: false,
      },
    )
    .await
    .map_err(map_gql_error)?;
    debug!(workspace_id = %workspace_uuid, user_id = %snapshot.user.id, total, "graphql search aggregate completed");
    Ok(SearchAggregateType {
      total: total.clamp(0, i32::MAX as i64) as i32,
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn calendar_providers(&self, _ctx: &Context<'_>) -> Result<Vec<String>> {
    Ok(vec!["google".to_string(), "caldav".to_string()])
  }

  #[instrument(skip_all)]
  pub(crate) async fn calendar_caldav_providers(&self, _ctx: &Context<'_>) -> Result<Vec<String>> {
    Ok(vec!["generic".to_string()])
  }

  #[instrument(skip_all)]
  pub(crate) async fn calendar_accounts(&self, ctx: &Context<'_>) -> Result<Vec<CalendarAccountType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let accounts = calendar.list_accounts(snapshot.user.id).await.map_err(map_gql_error)?;
    debug!(user_id = %snapshot.user.id, count = accounts.len(), "listed calendar accounts");
    Ok(accounts.into_iter().map(map_calendar_account).collect())
  }

  #[instrument(skip_all)]
  pub(crate) async fn calendar_events(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> Result<Vec<CalendarEventType>> {
    if to < from {
      return Err(map_gql_error(AuthError::InvalidInput(
        "invalid time range: `to` must be greater than or equal to `from`".to_string(),
      )));
    }
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let events = calendar
      .list_workspace_events(workspace_uuid, from, to)
      .await
      .map_err(map_gql_error)?;
    debug!(workspace_id = %workspace_uuid, user_id = %snapshot.user.id, count = events.len(), "listed calendar events");
    map_calendar_events_for_workspace(&state, workspace_uuid, events).await
  }

  /// Resolve one calendar event inside an explicitly authorized workspace.
  ///
  /// Event blocks store only the stable event/workspace identifiers.  A
  /// dedicated lookup keeps their rendering independent from whichever date
  /// range the Journal currently has in its client cache.
  #[instrument(skip_all)]
  pub(crate) async fn calendar_event(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    event_id: String,
  ) -> Result<Option<CalendarEventType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let event_uuid = Uuid::parse_str(&event_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid calendar event id".to_string())))?;

    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;

    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let event = calendar.get_event(event_uuid).await.map_err(map_gql_error)?;
    let Some(event) = event else {
      return Ok(None);
    };
    if event.workspace_id != Some(workspace_uuid) {
      return Ok(None);
    }

    debug!(
      workspace_id = %workspace_uuid,
      event_id = %event_uuid,
      user_id = %snapshot.user.id,
      "resolved calendar event"
    );
    Ok(Some(
      map_calendar_event_for_workspace(&state, workspace_uuid, event).await?,
    ))
  }

  #[instrument(skip_all)]
  pub(crate) async fn workspace_calendars(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Vec<WorkspaceCalendarType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let values = calendar
      .list_workspace_calendars(workspace_uuid)
      .await
      .map_err(map_gql_error)?;
    Ok(values.into_iter().map(map_workspace_calendar).collect())
  }

  #[instrument(skip_all)]
  pub(crate) async fn workspace_calendar_series(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Vec<CalendarEventType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".into())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service unavailable".into())))?;
    let events = calendar
      .workspace_calendar_series(workspace)
      .await
      .map_err(map_gql_error)?;
    map_calendar_events_for_workspace(&state, workspace, events).await
  }

  /// Query free/busy information for workspace members within a time range
  /// (P90-CAL-H-07).
  ///
  /// Returns per-user busy periods derived from `calendar_event_instances`.
  /// Only non-cancelled instances are included.  The caller must be a member
  /// of the workspace to access its calendar data.
  #[instrument(skip_all)]
  pub(crate) async fn calendar_free_busy(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    user_ids: Vec<String>,
    from: chrono::DateTime<chrono::Utc>,
    to: chrono::DateTime<chrono::Utc>,
  ) -> Result<Vec<UserFreeBusy>> {
    if to < from {
      return Err(map_gql_error(AuthError::InvalidInput(
        "invalid time range: `to` must be >= `from`".to_string(),
      )));
    }
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;

    // Parse requested user IDs.
    let requested_user_ids: Vec<Uuid> = user_ids
      .iter()
      .map(|id| {
        Uuid::parse_str(id).map_err(|_| map_gql_error(AuthError::InvalidInput(format!("invalid user id: {id}"))))
      })
      .collect::<Result<Vec<_>>>()?;

    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;

    // Query all non-cancelled instances for the workspace in the time range.
    let instances = calendar
      .free_busy(workspace_uuid, from, to)
      .await
      .map_err(map_gql_error)?;

    // Group by user_id via the parent event's account.  Since instances don't
    // carry user_id directly, we return workspace-level aggregated busy times
    // and map them to each requested user (treat workspace calendar as shared).
    // This is a v1 approach — a finer-grained per-user free/busy requires
    // per-user calendar account linkage which is tracked as a future work item.
    let busy_periods: Vec<CalendarFreeBusyPeriod> = instances
      .into_iter()
      .map(|inst| CalendarFreeBusyPeriod {
        start: inst.instance_start,
        end: inst.instance_end,
      })
      .collect();

    let result = requested_user_ids
      .into_iter()
      .map(|uid| UserFreeBusy {
        user_id: async_graphql::ID::from(uid.to_string()),
        busy_periods: busy_periods.clone(),
      })
      .collect();

    Ok(result)
  }

  // ── Native-calendar queries (P-JCAL-SERVER-03-C) ────────────────────────

  /// List all event tags for the workspace.
  #[instrument(skip_all)]
  pub(crate) async fn calendar_event_tags(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Vec<CalendarEventTagType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service not configured".to_string())))?;
    let tags = calendar.list_event_tags(workspace_uuid).await.map_err(map_gql_error)?;
    Ok(tags.into_iter().map(map_calendar_event_tag).collect())
  }

  /// Get workspace calendar settings (writeback target, default reminder).
  ///
  /// Returns `None` when no settings have been saved yet (defaults apply).
  #[instrument(skip_all)]
  pub(crate) async fn workspace_calendar_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Option<WorkspaceCalendarSettingsType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service not configured".to_string())))?;
    let settings = calendar
      .get_workspace_calendar_settings(workspace_uuid)
      .await
      .map_err(map_gql_error)?;
    Ok(settings.map(map_workspace_calendar_settings))
  }

  /// Export all workspace-native events within a time window as a RFC 5545
  /// VCALENDAR string (P-JCAL-SERVER-07-A).
  ///
  /// Only native events (origin='native') owned by the workspace are included.
  /// The caller needs SettingsRead permission.
  #[instrument(skip_all)]
  pub(crate) async fn export_workspace_calendar_ics(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> Result<String> {
    if to < from {
      return Err(map_gql_error(AuthError::InvalidInput(
        "invalid time range: `to` must be >= `from`".to_string(),
      )));
    }
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let events = calendar
      .workspace_event_sources(workspace_uuid, from, to)
      .await
      .map_err(map_gql_error)?;
    let refs: Vec<&myoxus_domain::entities::CalendarEvent> = events.iter().collect();
    let ics = myoxus_infrastructure::caldav::events_to_vcalendar(&refs);
    tracing::debug!(
      workspace_id = %workspace_uuid,
      user_id = %snapshot.user.id,
      count = events.len(),
      "exported workspace calendar as ICS"
    );
    Ok(ics)
  }

  // Intentionally unauthenticated: invite links are shared with unregistered users
  // who need to see workspace name before signing up.
  #[instrument(skip_all)]
  pub(crate) async fn get_invite_info(&self, ctx: &Context<'_>, invite_id: String) -> Result<InvitationType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;

    if let Ok(invite_uuid) = Uuid::parse_str(&invite_id)
      && let Some(member) = state
        .workspace()
        .get_member_by_invite_id(invite_uuid)
        .await
        .map_err(map_gql_error)?
    {
      let workspace = state
        .workspace()
        .get_workspace(member.workspace_id)
        .await
        .map_err(map_gql_error)?
        .ok_or_else(|| map_gql_error(AuthError::InvalidInput("Workspace not found".to_string())))?;
      return Ok(InvitationType {
        workspace: InvitationWorkspaceType {
          id: ID::from(workspace.id.to_string()),
          name: workspace.name,
          avatar: String::new(),
        },
        user: None,
        status: member.status.into(),
        invitee: Some(WorkspaceMemberType::from_model(member)),
      });
    }

    let link = state
      .workspace()
      .get_invite_link_by_token(&invite_id)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidToken))?;
    if let Some(expires_at) = link.expires_at
      && expires_at <= Utc::now()
    {
      return Err(map_gql_error(AuthError::ExpiredToken));
    }
    if link.revoked_at.is_some() {
      return Err(map_gql_error(AuthError::InvalidToken));
    }

    let workspace = state
      .workspace()
      .get_workspace(link.workspace_id)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("Workspace not found".to_string())))?;
    let inviter = state
      .auth()
      .get_historical_profile(link.created_by_user_id)
      .await
      .map_err(map_gql_error)?;

    Ok(InvitationType {
      workspace: InvitationWorkspaceType {
        id: ID::from(workspace.id.to_string()),
        name: workspace.name,
        avatar: String::new(),
      },
      user: inviter.map(|u| PublicUserType {
        id: ID::from(u.id.to_string()),
        email: u.email.clone(),
        name: u.name.unwrap_or(u.email),
        avatar_url: u.avatar_url,
      }),
      status: WorkspaceMemberStatus::Pending,
      invitee: None,
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn comment_threads(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    filter: Option<CommentThreadFilterType>,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<CommentType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &doc_id).await?;
    let comments = state
      .comment()
      .list_comment_threads(
        snapshot.user.id,
        workspace_uuid,
        doc_uuid,
        skip.unwrap_or(0) as i64,
        take.unwrap_or(50).clamp(1, 100) as i64,
        match filter.unwrap_or(CommentThreadFilterType::All) {
          CommentThreadFilterType::All => myoxus_application::comment::CommentThreadFilter::All,
          CommentThreadFilterType::Open => myoxus_application::comment::CommentThreadFilter::Open,
          CommentThreadFilterType::Resolved => myoxus_application::comment::CommentThreadFilter::Resolved,
          CommentThreadFilterType::Mine => myoxus_application::comment::CommentThreadFilter::Mine,
        },
      )
      .await
      .map_err(map_gql_error)?;
    Ok(comments.into_iter().map(CommentType::from).collect())
  }

  #[instrument(skip_all)]
  pub(crate) async fn comment_replies(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    parent_comment_id: String,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<CommentType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &doc_id).await?;
    let parent_uuid = Uuid::parse_str(&parent_comment_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid parent comment id".to_string())))?;
    let comments = state
      .comment()
      .list_comment_replies(
        snapshot.user.id,
        workspace_uuid,
        doc_uuid,
        parent_uuid,
        skip.unwrap_or(0) as i64,
        take.unwrap_or(50).clamp(1, 100) as i64,
      )
      .await
      .map_err(map_gql_error)?;
    Ok(comments.into_iter().map(CommentType::from).collect())
  }

  #[instrument(skip_all)]
  pub(crate) async fn comment_edit_history(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    comment_id: String,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<CommentEditHistoryType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &doc_id).await?;
    let comment_uuid = Uuid::parse_str(&comment_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid comment id".to_string())))?;
    let edits = state
      .comment()
      .list_comment_edit_history(
        snapshot.user.id,
        workspace_uuid,
        doc_uuid,
        comment_uuid,
        skip.unwrap_or(0) as i64,
        take.unwrap_or(50).clamp(1, 100) as i64,
      )
      .await
      .map_err(map_gql_error)?;
    Ok(edits.into_iter().map(CommentEditHistoryType::from).collect())
  }
}

// -- Private helpers (outside #[Object] block to avoid GraphQL exposure) ------

impl QueryRoot {
  /// Internal helper that performs all DB queries and assembles a
  /// `ServerConfigType`.  Extracted from `server_config()` so the moka
  /// `get_with()` closure can call it without needing `&self`.
  async fn build_server_config(
    state: &Arc<ApiState>,
  ) -> std::result::Result<ServerConfigType, crate::state::CacheLoadError> {
    let config = &state.config;

    // Run all independent DB queries concurrently. Authentication methods and
    // initialization come from the shared capability service rather than a
    // second, weaker provider-presence implementation.
    let copilot_enabled_default = config.copilot.enabled;
    let deployment_type_default = config.server.deployment_type.clone();
    let effective_config = state.effective_config().await;
    let auth_capabilities = crate::auth::capabilities::evaluate_auth_capabilities(state).await;
    let copilot_manually_enabled = effective_config
      .bool("copilot.enabled")
      .unwrap_or(copilot_enabled_default);
    let server_name_override = effective_config.string("server.name");

    // Effective copilot.enabled: manual toggle AND at least one provider with api_key set.
    // If manually enabled but no provider is configured with an api_key, AI features
    // will fail at runtime — hide the feature from clients to prevent broken UI.
    let has_active_provider = config
      .copilot
      .providers
      .values()
      .any(|p| p.enabled && p.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false));
    let effective_copilot = copilot_manually_enabled && has_active_provider;
    if copilot_manually_enabled && !has_active_provider {
      debug!(
        "copilot.enabled=true in app_configs but no provider has enabled=true with api_key \
         — reporting copilot as disabled to clients (P100-SRV-H-08)"
      );
    }
    let auth_capabilities = auth_capabilities.map_err(|error| {
      tracing::error!(error = %error, "server config authentication capability evaluation failed");
      crate::state::CacheLoadError("authentication capability state unavailable".to_string())
    })?;
    let initialized = !auth_capabilities.bootstrap_available;
    let mut oauth_providers = Vec::new();
    if auth_capabilities
      .method(myoxus_application::auth::AuthMethodCode::Google)
      .is_some_and(|method| method.usable)
    {
      oauth_providers.push(OAuthProviderType::Google);
    }
    if auth_capabilities
      .method(myoxus_application::auth::AuthMethodCode::Github)
      .is_some_and(|method| method.usable)
    {
      oauth_providers.push(OAuthProviderType::GitHub);
    }
    if auth_capabilities
      .method(myoxus_application::auth::AuthMethodCode::Oidc)
      .is_some_and(|method| method.usable)
    {
      oauth_providers.push(OAuthProviderType::Oidc);
    }
    if auth_capabilities
      .method(myoxus_application::auth::AuthMethodCode::Apple)
      .is_some_and(|method| method.usable)
    {
      oauth_providers.push(OAuthProviderType::Apple);
    }
    let available_user_features = config
      .compat
      .features
      .user
      .iter()
      .copied()
      .filter(|feature| *feature != crate::config::CompatibilityFeature::Admin)
      .map(FeatureType::from)
      .collect::<Vec<_>>();
    let available_workspace_features = config
      .compat
      .features
      .workspace
      .iter()
      .copied()
      .filter(|feature| *feature != crate::config::CompatibilityFeature::Admin)
      .map(FeatureType::from)
      .collect::<Vec<_>>();
    let password_policy = state.auth().current_password_policy().await.map_err(|error| {
      tracing::error!(error = %error, "server config password policy resolution failed");
      crate::state::CacheLoadError("password policy unavailable".to_string())
    })?;

    Ok(ServerConfigType {
      version: env!("CARGO_PKG_VERSION").to_string(),
      flavor: "myoxus-rust".to_string(),
      base_url: config.server.origin.clone(),
      name: server_name_override.unwrap_or_else(|| config.server.name.clone()),
      deployment_type: {
        // Restart-bound database values are already part of the final startup
        // AppConfig. The live overlay intentionally exposes only hot-reloadable
        // paths and must not replace this value with the file-only baseline.
        match deployment_type_default.to_lowercase().as_str() {
          "cloud" => ServerDeploymentType::Cloud,
          _ => ServerDeploymentType::Standalone,
        }
      },
      server_type: {
        // Keep the deprecated string alias identical to the typed GraphQL enum.
        match deployment_type_default.to_lowercase().as_str() {
          "cloud" => "Cloud".to_string(),
          _ => "Standalone".to_string(),
        }
      },
      initialized,
      features: {
        let mut f = vec![
          ServerFeature::OAuth,
          ServerFeature::LocalWorkspace,
          ServerFeature::Indexer,
          ServerFeature::Comment,
        ];
        if effective_copilot {
          f.push(ServerFeature::Copilot);
          f.push(ServerFeature::CopilotEmbedding);
        }
        f
      },
      oauth_providers,
      calendar_providers: vec![CalendarProviderType::Google, CalendarProviderType::CalDav],
      calendar_caldav_providers: vec![CalendarCalDAVProviderPresetObjectType {
        id: "generic".to_string(),
        label: "Generic CalDAV".to_string(),
        requires_app_password: None,
        docs_url: None,
      }],
      available_upgrade: None,
      available_user_features,
      available_workspace_features,
      credentials_requirement: CredentialsRequirementType {
        password: PasswordLimitsType {
          min_length: password_policy.min_length() as i32,
          max_length: password_policy.max_length() as i32,
        },
      },
      git_sync: {
        let policy =
          crate::git_sync_engine::policy::resolve_effective_git_sync_policy(&effective_config).map_err(|error| {
            tracing::error!(error, "server config Git Sync policy resolution failed");
            crate::state::CacheLoadError("Git Sync policy unavailable".to_string())
          })?;
        ServerGitSyncConfigType {
          enabled: policy.enabled,
          allowed_directions: {
            let mut values = policy.allowed_directions.into_iter().collect::<Vec<_>>();
            values.sort();
            values
          },
          allowed_auth_methods: {
            let mut values = policy.allowed_auth_methods.into_iter().collect::<Vec<_>>();
            values.sort();
            values
          },
          default_branch: policy.default_branch,
          auto_sync_allowed: policy.auto_sync_allowed,
          webhook_allowed: policy.webhook_allowed,
          ssh_host_key_policy: policy.ssh_host_key_policy.as_str().to_string(),
          max_mirror_storage_mb: policy.max_mirror_storage_mb,
        }
      },
      journal: {
        let show_cw = effective_config.bool("journal.show_calendar_weeks").unwrap_or(true);
        let first_day = effective_config
          .string("journal.first_day_of_week")
          .unwrap_or_else(|| "monday".to_string());
        ServerJournalConfigType {
          show_calendar_weeks: show_cw,
          first_day_of_week: first_day,
        }
      },
      client: {
        let download_url = effective_config
          .string("client.download_url")
          .unwrap_or_else(|| config.client.download_url.clone());
        let clipboard_http_fallback = effective_config
          .bool("client.clipboard_http_fallback")
          .unwrap_or(config.client.clipboard_http_fallback);
        ServerClientConfigType {
          download_url,
          clipboard_http_fallback,
        }
      },
      preview: ServerPreviewClientConfigType {
        max_concurrent_requests: effective_config.preview().max_active_renders_per_actor,
        request_timeout_ms: effective_config.preview().request_timeout_ms,
        retry_count: effective_config.preview().retry_count,
      },
      i18n: {
        let available_locales = effective_config
          .string_array("i18n.available_locales")
          .unwrap_or_else(|| config.i18n.available_locales.clone());
        let default_locale = effective_config
          .string("i18n.default_locale")
          .unwrap_or_else(|| config.i18n.default_locale.clone());
        ServerI18nConfigType {
          available_locales,
          default_locale,
        }
      },
    })
  }
}
