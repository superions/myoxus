//! GraphQL user-profile resolvers: current-user query, avatar upload, account
//! deletion, session management, and API-key operations.
//!
//! Provides `UserQuery` and `UserMutation` sub-objects on the authenticated
//! GraphQL root. Delegates to `myoxus_application::auth::AuthService` and
//! `myoxus_application::api_key::ApiKeyService`.

use std::{
  collections::{HashMap, HashSet},
  sync::Arc,
};

use async_graphql::{Context, ID, Object, Result};
use axum::http::{HeaderMap, header::USER_AGENT};

use tracing::{instrument, warn};
use uuid::Uuid;

use crate::config::{CompatibilityQuotaConfig, QuotaPlan};
use crate::graphql::utils::{map_gql_error, require_session, x_forwarded_for};
use crate::state::ApiState;
use myoxus_application::auth::{AuthError, SessionContext, UserPreferencesRecord};
use myoxus_application::notification::NotificationListRequest as NotificationListRequestModel;

use super::calendar::{CalendarAccountObjectType, map_calendar_account_object};
use super::{
  AccessToken, CopilotType, FeatureType, NotificationLevelType, NotificationListFilterInput, NotificationObjectType,
  NotificationObjectTypeEdge, NotificationTypeType, PageInfoType, PaginatedNotificationObjectType, PaginationInputType,
  RevealedAccessToken, TokenType, UserPreferencesType, UserQuotaType, UserQuotaUsageType, UserType,
  count_license_seat_usage, neutral_copilot_quota, neutral_user_quota, neutral_user_quota_with_member_usage,
};

pub(super) async fn map_user_preferences(state: &ApiState, record: UserPreferencesRecord) -> UserPreferencesType {
  let effective = record.values.resolve(&state.user_preference_defaults().await);

  UserPreferencesType {
    values: record.values.into(),
    effective_values: effective.into(),
    updated_at: record.updated_at,
  }
}

#[async_graphql::ComplexObject]
impl UserPreferencesType {
  /// Resolve confirmed personal policy against current Workspace/Project authority.
  #[instrument(skip_all)]
  async fn assistance(
    &self,
    ctx: &Context<'_>,
    workspace_id: Option<async_graphql::ID>,
    project_id: Option<async_graphql::ID>,
  ) -> Result<super::EffectiveAssistanceType> {
    let (state, snapshot) = require_session(ctx).await?;
    let parse = |id: async_graphql::ID| {
      Uuid::parse_str(id.as_str())
        .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid assistance context UUID".into())))
    };
    state
      .auth()
      .get_assistance(
        snapshot.user.id,
        workspace_id.map(parse).transpose()?,
        project_id.map(parse).transpose()?,
      )
      .await
      .map(Into::into)
      .map_err(map_gql_error)
  }
}

// Invalid/denied targets are neutral. Infrastructure failures remain visible,
// but raw decoder/SQL errors must never enter the public notification response.
fn notification_database_read_error(error: myoxus_application::database::DatabaseServiceError) -> Result<()> {
  if error.is_retryable_storage_failure() || error.code == myoxus_application::database::ERR_STORAGE {
    return Err(map_gql_error(AuthError::Storage(
      "database notification projection unavailable".into(),
    )));
  }
  Ok(())
}

/// Hydrate document changes with batched metadata/actor reads and Database
/// notices with one cached current target per scoped Row. Historical Reminder
/// display values never grant access; current DateTime Cells own their date,
/// timezone and label. Unavailable targets expose no historical display data.
async fn notification_bodies(
  state: &ApiState,
  user_id: Uuid,
  edges: &[myoxus_application::notification::NotificationEdge],
) -> Result<HashMap<Uuid, serde_json::Value>> {
  let parse_id =
    |body: &serde_json::Value, field: &str| body[field].as_str().and_then(|value| value.parse::<Uuid>().ok());
  let project = |kind: &str, body: &serde_json::Value| {
    kind == "document_changed"
      || (matches!(kind, "mention" | "comment_mention" | "comment_reply" | "comment") && body.get("doc").is_none())
  };
  let ids: HashSet<Uuid> = edges
    .iter()
    .filter(|edge| project(&edge.node.notification_type, &edge.node.payload))
    .filter_map(|edge| parse_id(&edge.node.payload, "docId"))
    .collect();
  let metadata = state
    .doc()
    .get_metadata_batch(&ids.into_iter().collect::<Vec<_>>())
    .await
    .map_err(map_gql_error)?;
  let mut scopes: HashMap<Uuid, HashSet<Uuid>> = HashMap::new();
  for edge in edges
    .iter()
    .filter(|edge| project(&edge.node.notification_type, &edge.node.payload))
  {
    if let (Some(workspace), Some(doc)) = (
      parse_id(&edge.node.payload, "workspaceId"),
      parse_id(&edge.node.payload, "docId"),
    ) {
      scopes.entry(workspace).or_default().insert(doc);
    }
  }
  let mut readable = HashMap::new();
  for (workspace, ids) in scopes {
    let docs = ids.into_iter().filter_map(|id| metadata.get(&id).cloned()).collect();
    for doc in crate::document_access::filter_readable_workspace_documents(state, user_id, workspace, docs)
      .await
      .map_err(map_gql_error)?
    {
      readable.insert((workspace, doc.id), doc);
    }
  }
  let target = |body: &serde_json::Value| {
    let workspace = parse_id(body, "workspaceId")?;
    let doc = parse_id(body, "docId")?;
    readable.get(&(workspace, doc))
  };
  let actor_field = |kind: &str| {
    if kind == "document_changed" {
      "latestActorId"
    } else {
      "authorId"
    }
  };
  let actor_ids: HashSet<Uuid> = edges
    .iter()
    .filter(|edge| project(&edge.node.notification_type, &edge.node.payload) && target(&edge.node.payload).is_some())
    .filter_map(|edge| parse_id(&edge.node.payload, actor_field(&edge.node.notification_type)))
    .collect();
  let actors = if actor_ids.is_empty() {
    HashMap::new()
  } else {
    state
      .auth()
      .get_users_by_ids(&actor_ids.into_iter().collect::<Vec<_>>())
      .await
      .map_err(map_gql_error)?
  };
  let mut bodies = HashMap::with_capacity(edges.len());
  let mut assignment_targets = HashMap::new();
  let mut reminder_rows = HashMap::new();
  if let Some(services) = state.database_services() {
    let scopes: HashSet<_> = edges
      .iter()
      .filter(|edge| edge.node.notification_type == "database_row_reminder")
      .filter_map(|edge| {
        let body = &edge.node.payload;
        parse_id(body, "fieldId")?;
        Some((
          parse_id(body, "workspaceId")?,
          parse_id(body, "databaseId")?,
          parse_id(body, "rowId")?,
        ))
      })
      .collect();
    for (workspace, database, row) in scopes {
      let record = match services.definition.get_database(user_id, database).await {
        Ok(record) if record.database.workspace_id == workspace => Some(record),
        Ok(_) => None,
        Err(error) => {
          notification_database_read_error(error)?;
          None
        }
      };
      let current = if record.is_some() {
        match services.views.get_row_for_read(user_id, database, row, false).await {
          Ok(row) => row,
          Err(error) => {
            notification_database_read_error(error)?;
            None
          }
        }
      } else {
        None
      };
      // Final retained-scope authorization follows the metadata/Cell reads.
      // It also distinguishes recoverable Trash without exposing its display.
      let target = match services
        .views
        .notification_row_target(user_id, workspace, database, row)
        .await
      {
        Ok(target) => target,
        Err(error) => {
          notification_database_read_error(error)?;
          None
        }
      };
      assignment_targets.insert((workspace, database, row), target);
      reminder_rows.insert((workspace, database, row), record.zip(current));
    }
  }
  for edge in edges {
    let kind = edge.node.notification_type.as_str();
    let stored = &edge.node.payload;
    if matches!(
      kind,
      "database.row.assigned" | "database_row_assigned" | "database.task.changed" | "database_row_reminder"
    ) {
      let workspace = parse_id(stored, "workspaceId");
      let database = parse_id(stored, "databaseId");
      let row = parse_id(stored, "rowId");
      let mut body = serde_json::json!({"workspaceId":workspace,"databaseId":database,"rowId":row,
        "state":"Unavailable","targetKind":null,"rowTitle":null});
      let reminder = kind == "database_row_reminder";
      let field_id = parse_id(stored, "fieldId");
      if reminder {
        body["fieldId"] = serde_json::json!(field_id);
        body["fieldName"] = serde_json::Value::Null;
        body["scheduledFor"] = serde_json::Value::Null;
        body["allDay"] = serde_json::Value::Null;
        body["timeZone"] = serde_json::Value::Null;
      }
      if let (Some(workspace), Some(database), Some(row), Some(services)) =
        (workspace, database, row, state.database_services())
      {
        let key = (workspace, database, row);
        if !assignment_targets.contains_key(&key) {
          let target = match services
            .views
            .notification_row_target(user_id, workspace, database, row)
            .await
          {
            Ok(target) => target,
            Err(error) => {
              notification_database_read_error(error)?;
              None
            }
          };
          assignment_targets.insert(key, target);
        }
        if let Some((database, row)) = assignment_targets.get(&key).and_then(Option::as_ref) {
          if kind == "database.task.changed"
            && !(database.profile_kind == myoxus_domain::database::DatabaseProfileKind::Project
              && row.row_kind == myoxus_domain::database::DatabaseRowKind::Task)
          {
            // Changed never projects a Generic Row, even from malformed stored intent.
          } else if database.deleted_at.is_some() || row.deleted_at.is_some() {
            body["state"] = serde_json::json!("Trashed");
          } else if reminder {
            use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldConfig, DatabaseFieldType};
            if let Some((record, current)) = reminder_rows.get(&key).and_then(Option::as_ref)
              && let Some(field_id) = field_id
              && let Some(field) = record.fields.iter().find(|field| {
                field.id == field_id
                  && field.field_type == DatabaseFieldType::DateTime
                  && matches!(&field.config, DatabaseFieldConfig::DateTime(_))
              })
              && let Some(DatabaseCellValueData::DateTime(date)) = current
                .cells
                .iter()
                .find(|cell| cell.field_id == field_id)
                .map(|cell| &cell.value)
            {
              body["state"] = serde_json::json!("Available");
              body["rowTitle"] = serde_json::json!(row.title);
              body["fieldName"] = serde_json::json!(field.name);
              body["scheduledFor"] = serde_json::json!(date.start);
              body["allDay"] = serde_json::json!(date.all_day);
              body["timeZone"] = serde_json::json!(date.time_zone);
              body["targetKind"] = serde_json::json!(if database.profile_kind
                == myoxus_domain::database::DatabaseProfileKind::Project
                && row.row_kind == myoxus_domain::database::DatabaseRowKind::Task
              {
                "Task"
              } else {
                "DatabaseRow"
              });
            }
          } else {
            body["state"] = serde_json::json!("Available");
            body["rowTitle"] = serde_json::json!(row.title);
            body["targetKind"] = serde_json::json!(if database.profile_kind
              == myoxus_domain::database::DatabaseProfileKind::Project
              && row.row_kind == myoxus_domain::database::DatabaseRowKind::Task
            {
              "Task"
            } else {
              "DatabaseRow"
            });
          }
        }
      }
      // Database notifications always supply a projection, even for malformed IDs. The
      // outer feed must never fall back to a historical private display payload.
      bodies.insert(edge.node.id, body);
      continue;
    }
    if !project(kind, stored) {
      continue;
    }
    let doc = target(stored);
    let mut body = if kind == "document_changed" {
      // Build the public body from allowed fields, never copy stored display data.
      if doc.is_some() {
        serde_json::json!({
          "workspaceId": stored["workspaceId"],
          "firstChangedAt": stored["firstChangedAt"],
          "lastChangedAt": stored["lastChangedAt"],
          "otherActorCount": stored["actorCount"].as_u64().unwrap_or(1).saturating_sub(1),
        })
      } else {
        serde_json::json!({})
      }
    } else {
      stored.clone()
    };
    body["doc"] = doc
      .map(|doc| {
        serde_json::json!({
          "id":doc.external_id, "title":doc.title,
          "mode":if doc.meta["mode"].as_str() == Some("edgeless") { "edgeless" } else { "page" },
        })
      })
      .unwrap_or(serde_json::Value::Null);
    body["createdByUser"] = doc
      .and_then(|_| parse_id(stored, actor_field(kind)))
      .and_then(|id| actors.get(&id))
      .filter(|user| !user.disabled)
      .map(|user| serde_json::json!({"name":user.name,"avatarUrl":user.avatar_url}))
      .unwrap_or(serde_json::Value::Null);
    bodies.insert(edge.node.id, body);
  }
  Ok(bodies)
}

#[Object]
impl UserType {
  async fn id(&self) -> Uuid {
    self.id
  }
  async fn email(&self) -> &str {
    &self.email
  }
  async fn email_verified(&self) -> bool {
    self.email_verified
  }
  async fn avatar_url(&self) -> Option<&str> {
    self.avatar_url.as_deref()
  }
  async fn name(&self) -> Option<&str> {
    self.name.as_deref()
  }
  async fn is_admin(&self) -> bool {
    self.is_admin
  }
  async fn disabled(&self) -> bool {
    self.disabled
  }
  async fn has_password(&self) -> bool {
    self.has_password
  }

  #[instrument(skip_all)]
  async fn features(&self, ctx: &Context<'_>) -> Vec<FeatureType> {
    let mut features = Vec::new();
    let defaults = Vec::new();
    if let Ok(state) = ctx.data::<Arc<ApiState>>() {
      let defaults = crate::graphql::default_user_feature_set(state);
      // P84-I-II: Use three-tier cache (moka L1 → Redis L2 → DB L3)
      // instead of the L1-only cache for cross-instance consistency.
      let active = state.user_feature_flags_cached_l2(self.id).await.unwrap_or_default();
      let unlimited_copilot = crate::state::feature_override_result(&active);
      let overrides = crate::graphql::UserFeatureOverrides { unlimited_copilot };
      for feature in [
        FeatureType::AIEarlyAccess,
        FeatureType::EarlyAccess,
        FeatureType::FreePlan,
        FeatureType::LifetimeProPlan,
        FeatureType::ProPlan,
        FeatureType::TeamPlan,
        FeatureType::UnlimitedCopilot,
        FeatureType::UnlimitedWorkspace,
      ] {
        if crate::graphql::has_effective_feature(self.is_admin, &defaults, overrides, feature) {
          features.push(feature);
        }
      }
      if active.iter().any(|name| name == crate::graphql::USER_FEATURE_MANAGER) {
        features.push(FeatureType::Manager);
      }
    } else {
      features = defaults;
    }
    if self.is_admin && !features.contains(&FeatureType::Admin) {
      features.push(FeatureType::Admin);
    }
    features
  }

  #[instrument(skip_all)]
  async fn assistant_packages(
    &self,
    ctx: &Context<'_>,
    context: super::database::AssistantPackageContextType,
  ) -> Result<Vec<super::database::AssistantPackageObjectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    if snapshot.user.id != self.id {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    if context != super::database::AssistantPackageContextType::WorkspaceCreation {
      return Err(map_gql_error(AuthError::InvalidInput(
        "preallocation supports WorkspaceCreation only".into(),
      )));
    }
    Ok(
      super::database::package_service(&state)?
        .list(context.into())
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }
  #[instrument(skip_all)]
  async fn prepare_workspace_assistant(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareWorkspaceAssistantInput,
  ) -> Result<super::database::PreparedWorkspaceAssistantObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    if snapshot.user.id != self.id {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let project = super::database::workspace_project_input(&state, snapshot.user.id, input.project).await?;
    let setup = super::database::workspace_setup_input(input.setup)?;
    let plan = super::database::package_service(&state)?
      .prepare_workspace_creation(
        snapshot.user.id,
        &input.identity.into(),
        super::database::package_answers(input.answers.0)?,
        project.as_ref(),
        setup.as_ref(),
        state.auth(),
      )
      .await
      .map_err(|_| {
        map_gql_error(AuthError::InvalidInput(
          "invalid Workspace assistant preparation".into(),
        ))
      })?;
    (snapshot.user.id, plan).try_into()
  }

  /// Resolving a saved preference prepares no execution and changes no mode.
  #[instrument(skip_all)]
  async fn resolve_saved_assistant_setup(
    &self,
    ctx: &Context<'_>,
    id: ID,
  ) -> Result<Option<super::database::SavedSetupResolutionObjectType>> {
    super::database::resolve_saved_assistant_setup(ctx, self.id, id).await
  }

  /// Receipt readback is read-only, including personal assistance preferences.
  #[instrument(skip_all)]
  async fn workspace_creation(
    &self,
    ctx: &Context<'_>,
    request_id: ID,
  ) -> Result<Option<super::WorkspaceCreationResultType>> {
    let (state, snapshot) = require_session(ctx).await?;
    if snapshot.user.id != self.id {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let request = Uuid::parse_str(request_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid requestId".into())))?;
    let packages = state.assistant_packages();
    let outcome = state
      .workspace()
      .get_workspace_creation(snapshot.user.id, request, packages.as_deref(), state.auth())
      .await
      .map_err(super::workspace::map_workspace_starter_error)?;
    outcome
      .as_ref()
      .map(super::WorkspaceCreationResultType::try_from)
      .transpose()
  }

  #[instrument(skip_all)]
  async fn preferences(&self, ctx: &Context<'_>) -> Result<UserPreferencesType> {
    let (state, snapshot) = require_session(ctx).await?;

    if snapshot.user.id != self.id {
      warn!(current_user_id = %snapshot.user.id, target_user_id = %self.id, "unauthorized settings access attempt");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }

    let record = state
      .auth()
      .get_user_preferences(self.id)
      .await
      .map_err(map_gql_error)?;
    Ok(map_user_preferences(&state, record).await)
  }

  #[instrument(skip_all)]
  async fn notifications(
    &self,
    ctx: &Context<'_>,
    pagination: PaginationInputType,
    filter: Option<NotificationListFilterInput>,
  ) -> Result<PaginatedNotificationObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    if snapshot.user.id != self.id {
      warn!(current_user_id = %snapshot.user.id, target_user_id = %self.id, "unauthorized notification list access attempt");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let include_read = filter.as_ref().and_then(|value| value.include_read);
    let notification_types = filter.and_then(|value| {
      value.types.map(|types| {
        types
          .into_iter()
          .flat_map(|notification_type| {
            if notification_type == NotificationTypeType::DatabaseRowAssigned {
              vec!["database.row.assigned".to_string(), "database_row_assigned".to_string()]
            } else {
              vec![notification_type.as_storage().to_string()]
            }
          })
          .collect()
      })
    });

    let connection = state
      .notification()
      .list_notifications(
        self.id,
        NotificationListRequestModel {
          first: pagination.first.map(|v| v as i64),
          offset: pagination.offset.map(|v| v as i64),
          after: pagination.after,
          include_read,
          notification_types,
        },
      )
      .await
      .map_err(map_gql_error)?;

    let bodies = notification_bodies(&state, self.id, &connection.edges).await?;
    let mut edges = Vec::with_capacity(connection.edges.len());
    for edge in connection.edges {
      let body = bodies.get(&edge.node.id).cloned().unwrap_or(edge.node.payload);
      edges.push(NotificationObjectTypeEdge {
        cursor: edge.cursor,
        node: NotificationObjectType {
          id: ID::from(edge.node.id.to_string()),
          notification_type: NotificationTypeType::from_storage(&edge.node.notification_type),
          level: NotificationLevelType::from_storage(&edge.node.notification_level),
          read: edge.node.read_at.is_some(),
          created_at: edge.node.created_at,
          updated_at: edge.node.updated_at,
          body,
        },
      });
    }
    Ok(PaginatedNotificationObjectType {
      total_count: connection.total_count as i32,
      edges,
      page_info: PageInfoType {
        start_cursor: connection.page_info.start_cursor,
        end_cursor: connection.page_info.end_cursor,
        has_next_page: connection.page_info.has_next_page,
        has_previous_page: connection.page_info.has_previous_page,
      },
    })
  }

  #[instrument(skip_all)]
  async fn quota(&self, ctx: &Context<'_>) -> UserQuotaType {
    if let Ok(state) = ctx.data::<Arc<ApiState>>() {
      let member_count = match count_license_seat_usage(state).await {
        Ok(value) => value,
        Err(error) => {
          warn!(error = %error, "failed to count global license seat usage for current user quota");
          0
        }
      };
      return neutral_user_quota_with_member_usage(
        state.config.compat.quota_plan.clone(),
        &state.config.compat.quota,
        member_count,
      );
    }
    neutral_user_quota(QuotaPlan::Pro, &CompatibilityQuotaConfig::default())
  }

  #[instrument(skip_all)]
  async fn quota_usage(&self, ctx: &Context<'_>) -> UserQuotaUsageType {
    let storage = if let Ok(state) = ctx.data::<Arc<ApiState>>() {
      match state.blob().user_workspace_blob_size(self.id).await {
        Ok(total) => total.min(i64::MAX as u64) as i64,
        Err(error) => {
          warn!(%error, user_id = %self.id, "failed to query workspace blob usage");
          0
        }
      }
    } else {
      0
    };
    UserQuotaUsageType { storage_quota: storage }
  }

  #[instrument(skip_all)]
  async fn copilot(
    &self,
    ctx: &Context<'_>,
    workspace_id: Option<String>,
    #[graphql(name = "promptName")] _prompt_name: Option<String>,
  ) -> Result<CopilotType> {
    let workspace_id = match workspace_id {
      Some(value) => Some(Uuid::parse_str(&value).map_err(|_| "Invalid workspace id")?),
      None => None,
    };
    let quota = if let Ok(state) = ctx.data::<Arc<ApiState>>() {
      neutral_copilot_quota(&state.config.compat.quota)
    } else {
      neutral_copilot_quota(&CompatibilityQuotaConfig::default())
    };
    Ok(CopilotType {
      quota,
      user_id: self.id,
      workspace_id,
    })
  }

  #[instrument(skip_all)]
  async fn access_tokens(&self, ctx: &Context<'_>) -> Result<Vec<AccessToken>> {
    let (state, snapshot) = require_session(ctx).await?;

    if snapshot.user.id != self.id {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }

    let tokens = state.auth().list_access_tokens(self.id).await.map_err(map_gql_error)?;
    Ok(
      tokens
        .into_iter()
        .map(|t| AccessToken {
          id: t.id,
          name: t.name,
          created_at: t.created_at,
          expires_at: t.expires_at,
        })
        .collect(),
    )
  }

  #[instrument(skip_all)]
  async fn revealed_access_tokens(&self, ctx: &Context<'_>) -> Result<Vec<RevealedAccessToken>> {
    let (state, snapshot) = require_session(ctx).await?;

    if snapshot.user.id != self.id {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }

    let tokens = state.auth().list_access_tokens(self.id).await.map_err(map_gql_error)?;
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

  #[graphql(deprecation = "use [/api/auth/sign-in?native=true] instead")]
  #[instrument(skip_all)]
  async fn token(&self, ctx: &Context<'_>) -> Result<TokenType> {
    let (state, snapshot) = require_session(ctx).await?;
    let headers = ctx.data::<HeaderMap>().map_err(|_| "Internal error")?;

    if snapshot.user.id != self.id {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }

    let context = SessionContext {
      user_agent: headers
        .get(USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string()),
      ip_address: x_forwarded_for(headers),
    };

    let session = state
      .auth()
      .create_user_session(self.id, context)
      .await
      .map_err(map_gql_error)?;

    Ok(TokenType {
      session_token: Some(session.id.to_string()),
      token: session.id.to_string(),
      refresh: "".to_string(),
    })
  }

  #[instrument(skip(self, ctx))]
  async fn calendar_accounts(&self, ctx: &Context<'_>) -> Result<Vec<CalendarAccountObjectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    if snapshot.user.id != self.id {
      warn!(current_user_id = %snapshot.user.id, target_user_id = %self.id, "unauthorized calendar account access attempt");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let accounts = calendar.list_accounts(self.id).await.map_err(map_gql_error)?;
    let mut out = Vec::with_capacity(accounts.len());
    for account in accounts {
      let subscriptions = calendar
        .list_account_calendars(account.id)
        .await
        .map_err(map_gql_error)?;
      out.push(map_calendar_account_object(account, subscriptions));
    }
    Ok(out)
  }
}
