//! GraphQL document resolvers: doc metadata queries and doc-permission mutations.
//!
//! Provides `DocumentQuery` and `DocumentMutation` sub-objects on the
//! authenticated GraphQL root. Handles per-document access-control checks and
//! delegates persistence to `myoxus_application::doc::DocService`.

use async_graphql::{Context, InputObject, Object, Result, SimpleObject};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::graphql::utils::{map_gql_error, require_session};
use myoxus_application::auth::AuthError;
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_domain::permission::WorkspaceAction;

use super::{
  DocPermissionsType, EditorType, PageInfoType, PaginatedDocGrantedUserType, PaginationInputType, WorkspaceDocType,
  doc_permissions_for_role,
};

// ─── Analytics types (P24-D-03) ──────────────────────────────────────────────

#[derive(InputObject, Debug)]
#[graphql(name = "DocPageAnalyticsInput")]
pub struct DocPageAnalyticsInput {
  #[graphql(name = "windowDays")]
  pub window_days: Option<i32>,
  pub timezone: Option<String>,
}

// TimeWindow is defined in dashboard_types.rs as TimeWindowType (shared between admin + doc analytics).
use crate::graphql::dashboard_types::{TimeBucket, TimeWindowType};

#[derive(SimpleObject)]
#[graphql(name = "DocPageAnalyticsPoint")]
pub struct DocPageAnalyticsPoint {
  pub date: DateTime<Utc>,
  #[graphql(name = "totalViews")]
  pub total_views: i64,
  #[graphql(name = "uniqueViews")]
  pub unique_views: i64,
  #[graphql(name = "guestViews")]
  pub guest_views: i64,
}

#[derive(SimpleObject)]
#[graphql(name = "DocPageAnalyticsSummary")]
pub struct DocPageAnalyticsSummary {
  #[graphql(name = "totalViews")]
  pub total_views: i64,
  #[graphql(name = "uniqueViews")]
  pub unique_views: i64,
  #[graphql(name = "guestViews")]
  pub guest_views: i64,
  #[graphql(name = "lastAccessedAt")]
  pub last_accessed_at: Option<DateTime<Utc>>,
}

#[derive(SimpleObject)]
#[graphql(name = "DocPageAnalytics")]
pub struct DocPageAnalytics {
  pub window: TimeWindowType,
  pub series: Vec<DocPageAnalyticsPoint>,
  pub summary: DocPageAnalyticsSummary,
  #[graphql(name = "generatedAt")]
  pub generated_at: DateTime<Utc>,
}

// ─── LastAccessedMembers types (P24-D-02) ────────────────────────────────────

#[derive(SimpleObject)]
#[graphql(name = "DocMemberLastAccessNode")]
pub struct DocMemberLastAccessNode {
  pub user: EditorType,
  #[graphql(name = "lastAccessedAt")]
  pub last_accessed_at: DateTime<Utc>,
  #[graphql(name = "lastDocId")]
  pub last_doc_id: Option<String>,
}

#[derive(SimpleObject)]
#[graphql(name = "DocMemberLastAccessEdge")]
pub struct DocMemberLastAccessEdge {
  pub cursor: String,
  pub node: DocMemberLastAccessNode,
}

#[derive(SimpleObject)]
#[graphql(name = "PaginatedDocMemberLastAccess")]
pub struct PaginatedDocMemberLastAccess {
  pub edges: Vec<DocMemberLastAccessEdge>,
  #[graphql(name = "pageInfo")]
  pub page_info: PageInfoType,
  #[graphql(name = "totalCount")]
  pub total_count: Option<i64>,
}

#[Object]
impl WorkspaceDocType {
  async fn id(&self) -> &str {
    &self.id
  }

  async fn workspace_id(&self) -> &str {
    &self.workspace_id
  }

  async fn public(&self) -> bool {
    self.public
  }

  async fn mode(&self) -> crate::graphql::PublicDocModeType {
    self.mode
  }

  async fn default_role(&self) -> crate::graphql::DocRoleType {
    self.default_role
  }

  async fn title(&self) -> Option<&str> {
    self.title.as_deref()
  }

  async fn summary(&self) -> Option<&str> {
    self.summary.as_deref()
  }

  async fn created_at(&self) -> Option<DateTime<Utc>> {
    self.created_at
  }

  async fn updated_at(&self) -> Option<DateTime<Utc>> {
    self.updated_at
  }

  async fn permissions(&self, ctx: &Context<'_>) -> Result<DocPermissionsType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&self.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &self.id).await?;
    let role = state
      .permission_service()
      .get_effective_doc_role(snapshot.user.id, workspace_uuid, doc_uuid)
      .await
      .map_err(map_gql_error)?;
    let mut permissions = doc_permissions_for_role(role);
    if permissions.doc_read
      && let Some(metadata) = state.document_metadata_service()
    {
      match metadata.get_projection_uncached(doc_uuid, workspace_uuid).await {
        Ok(projection) => {
          if projection
            .template
            .as_ref()
            .is_some_and(|template| template.state == "guide")
          {
            permissions.doc_update = false;
            permissions.doc_properties_update = false;
          }
        }
        // Trashed documents retain Delete/Restore permissions while their
        // active metadata projection is deliberately absent.
        Err(myoxus_application::document_metadata::DocumentMetadataServiceError::NotFound) => {}
        Err(error) => return Err(async_graphql::Error::new(error.to_string())),
      }
    }
    if let Some(registry) = state.template_registry()
      && registry
        .is_managed_source(workspace_uuid, doc_uuid)
        .await
        .map_err(map_gql_error)?
    {
      permissions.doc_delete = false;
      permissions.doc_trash = false;
    }
    Ok(permissions)
  }

  async fn granted_users_list(
    &self,
    ctx: &Context<'_>,
    _pagination: Option<PaginationInputType>,
  ) -> Result<PaginatedDocGrantedUserType> {
    let (state, _snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&self.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &self.id).await?;
    let rows = state.doc().list_granted_users(doc_uuid).await.map_err(map_gql_error)?;

    let edges: Vec<super::DocGrantedUserTypeEdge> = rows
      .into_iter()
      .map(|row| {
        let role = match row.role {
          myoxus_domain::entities::DocRole::Owner => crate::graphql::DocRoleType::Owner,
          myoxus_domain::entities::DocRole::Manager => crate::graphql::DocRoleType::Manager,
          myoxus_domain::entities::DocRole::Editor => crate::graphql::DocRoleType::Editor,
          myoxus_domain::entities::DocRole::Commenter => crate::graphql::DocRoleType::Commenter,
          myoxus_domain::entities::DocRole::Reader => crate::graphql::DocRoleType::Reader,
          myoxus_domain::entities::DocRole::External => crate::graphql::DocRoleType::External,
          myoxus_domain::entities::DocRole::None => crate::graphql::DocRoleType::None,
        };
        super::DocGrantedUserTypeEdge {
          cursor: row.user_id.to_string(),
          node: super::DocGrantedUserType {
            role,
            user: super::PublicUserType {
              id: async_graphql::ID::from(row.user_id.to_string()),
              name: row.name,
              email: row.email,
              avatar_url: row.avatar_key,
            },
          },
        }
      })
      .collect();

    let total = edges.len() as i32;
    Ok(PaginatedDocGrantedUserType {
      total_count: total,
      edges,
      page_info: PageInfoType {
        start_cursor: None,
        end_cursor: None,
        has_next_page: false,
        has_previous_page: false,
      },
    })
  }

  /// Paginated last-accessed members for this doc.
  #[graphql(name = "lastAccessedMembers")]
  async fn last_accessed_members(
    &self,
    ctx: &Context<'_>,
    pagination: PaginationInputType,
    query: Option<String>,
    #[graphql(name = "includeTotal", default = false)] include_total: bool,
  ) -> Result<PaginatedDocMemberLastAccess> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid =
      Uuid::parse_str(&self.workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::UsersRead,
      )
      .await
      .map_err(map_gql_error)?;

    let limit = pagination.first.unwrap_or(20).min(100) as i64;
    let offset = pagination.offset.unwrap_or(0) as i64;
    let doc_id = &self.id;

    let total_count = if include_total {
      Some(
        state
          .doc()
          .count_member_last_access(workspace_uuid, doc_id)
          .await
          .map_err(map_gql_error)?,
      )
    } else {
      None
    };

    let rows = state
      .doc()
      .list_member_last_access(workspace_uuid, doc_id, query.as_deref(), limit, offset)
      .await
      .map_err(map_gql_error)?;

    let edges: Vec<DocMemberLastAccessEdge> = rows
      .into_iter()
      .enumerate()
      .map(|(i, row)| DocMemberLastAccessEdge {
        cursor: if row.user_id.is_nil() {
          format!("{}", offset + i as i64)
        } else {
          row.user_id.to_string()
        },
        node: DocMemberLastAccessNode {
          user: EditorType {
            name: row.name,
            avatar_url: row.avatar_key,
          },
          last_accessed_at: row.last_accessed_at,
          last_doc_id: Some(row.last_doc_id),
        },
      })
      .collect();

    let has_next = edges.len() as i64 == limit;
    Ok(PaginatedDocMemberLastAccess {
      edges,
      page_info: PageInfoType {
        start_cursor: None,
        end_cursor: None,
        has_next_page: has_next,
        has_previous_page: offset > 0,
      },
      total_count,
    })
  }

  /// Doc page analytics — daily view counts in a time window.
  async fn analytics(&self, ctx: &Context<'_>, input: Option<DocPageAnalyticsInput>) -> Result<DocPageAnalytics> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid =
      Uuid::parse_str(&self.workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;

    let window_days = input.as_ref().and_then(|i| i.window_days).unwrap_or(28);
    let now = Utc::now();
    let start = now - chrono::Duration::days(window_days as i64);

    let doc_id = &self.id;
    let rows = state
      .doc()
      .list_doc_view_daily(workspace_uuid, doc_id, start.date_naive(), now.date_naive())
      .await
      .map_err(map_gql_error)?;

    let mut total = 0i64;
    let mut unique = 0i64;
    let mut guest = 0i64;
    let series: Vec<DocPageAnalyticsPoint> = rows
      .into_iter()
      .map(|row| {
        total += row.total_views;
        unique += row.unique_views;
        guest += row.guest_views;
        DocPageAnalyticsPoint {
          date: row
            .date
            .and_hms_opt(0, 0, 0)
            .expect("static: midnight is always valid")
            .and_utc(),
          total_views: row.total_views,
          unique_views: row.unique_views,
          guest_views: row.guest_views,
        }
      })
      .collect();

    let effective = series.len() as i32;
    Ok(DocPageAnalytics {
      window: TimeWindowType {
        from: start,
        to: now,
        timezone: input
          .as_ref()
          .and_then(|i| i.timezone.clone())
          .unwrap_or_else(|| "UTC".to_string()),
        bucket: TimeBucket::Day,
        requested_size: window_days,
        effective_size: effective,
      },
      series,
      summary: DocPageAnalyticsSummary {
        total_views: total,
        unique_views: unique,
        guest_views: guest,
        last_accessed_at: None,
      },
      generated_at: now,
    })
  }
}
