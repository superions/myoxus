//! async-graphql schema definition for the Myoxus API.
//!
//! Declares [`ApiSchema`] (the root async-graphql [`Schema`] type), the
//! [`ApiQueryRoot`] and [`ApiMutationRoot`] resolver roots, and all GraphQL
//! object/input/enum types used in the public API surface. Sub-modules handle
//! auth/user resolvers ([`auth`]), admin resolvers ([`admin`]), organization
//! resolvers ([`organization`]), and shared utilities ([`utils`]).

pub mod admin;
pub mod admin_config;
pub mod api_key;
pub mod audit_types;
pub mod auth;
pub mod branding;
pub(crate) mod config;
pub(crate) mod copilot_helpers;
pub mod dashboard_types;
pub mod document_audit;
pub mod document_metadata;
pub mod document_metadata_policy;
pub mod document_version;
pub mod error_types;
pub mod git_sync;
pub mod logging_types;
pub mod organization;
pub mod organization_lifecycle;
pub mod pdf_export;
pub mod pdf_font;
pub mod pdf_icc;
pub mod pdf_template_admin;
pub mod pdf_workspace;
pub mod template_registry;
mod transcription;
pub mod utils;
pub mod workspace_types;

// Re-export moved types so existing `use crate::graphql::FooType` paths keep working.
pub use dashboard_types::*;
pub use logging_types::*;
pub use workspace_types::*;

use async_graphql::{Context, EmptySubscription, ErrorExtensions, ID, MaybeUndefined, Result, Schema, Upload};
use chrono::{DateTime, Utc};
use myoxus_application::git_sync::{
  CreateGitSyncProfile, EncryptedGitCredential, GitSyncLifecycleError, GitSyncLifecycleService,
  GitSyncLifecycleStoreError, GitSyncProfilePatch, UpdateGitSyncProfile,
};
use myoxus_application::metrics::MetricsRecorder;
use myoxus_application::permission::AccessController;
use serde_json::json;
use std::{collections::HashMap, sync::Arc, sync::atomic::Ordering};
use tracing::instrument;
use uuid::Uuid;

use crate::git_sync_engine::policy::EffectiveGitSyncPolicy;

pub type ApiSchema = Schema<ApiQueryRoot, ApiMutationRoot, EmptySubscription>;

// Billing types are defined for schema compatibility but not actively used.
// Per project rules, billing is permanently out of scope. These types exist
// solely so that the GraphQL schema matches what the client expects — the
// resolvers return neutral/stub values (see `neutral_subscription()`).
#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
pub enum SubscriptionPlanType {
  #[graphql(name = "AI")]
  AI,
  #[graphql(name = "Enterprise")]
  Enterprise,
  #[graphql(name = "Free")]
  Free,
  #[graphql(name = "Pro")]
  Pro,
  #[graphql(name = "SelfHosted")]
  SelfHosted,
  #[graphql(name = "SelfHostedTeam")]
  SelfHostedTeam,
  #[graphql(name = "Team")]
  Team,
}

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
pub enum SubscriptionRecurringType {
  #[graphql(name = "Lifetime")]
  Lifetime,
  #[graphql(name = "Monthly")]
  Monthly,
  #[graphql(name = "Yearly")]
  Yearly,
}

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
pub enum SubscriptionStatusType {
  #[graphql(name = "Active")]
  Active,
  #[graphql(name = "Canceled")]
  Canceled,
  #[graphql(name = "Incomplete")]
  Incomplete,
  #[graphql(name = "IncompleteExpired")]
  IncompleteExpired,
  #[graphql(name = "PastDue")]
  PastDue,
  #[graphql(name = "Paused")]
  Paused,
  #[graphql(name = "Trialing")]
  Trialing,
  #[graphql(name = "Unpaid")]
  Unpaid,
}

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
pub enum SubscriptionVariantType {
  #[graphql(name = "EA")]
  EA,
  #[graphql(name = "Onetime")]
  Onetime,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct SubscriptionPriceType {
  pub r#type: String,
  pub plan: SubscriptionPlanType,
  pub currency: String,
  pub amount: Option<i32>,
  pub yearly_amount: Option<i32>,
  pub lifetime_amount: Option<i32>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct SubscriptionType {
  pub id: String,
  pub status: SubscriptionStatusType,
  pub plan: SubscriptionPlanType,
  pub recurring: SubscriptionRecurringType,
  pub start: DateTime<Utc>,
  pub end: Option<DateTime<Utc>>,
  pub next_bill_at: Option<DateTime<Utc>>,
  pub canceled_at: Option<DateTime<Utc>>,
  pub variant: Option<SubscriptionVariantType>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct LicenseType {
  pub expired_at: Option<DateTime<Utc>>,
  pub installed_at: DateTime<Utc>,
  pub quantity: i32,
  pub recurring: SubscriptionRecurringType,
  pub validated_at: DateTime<Utc>,
  pub variant: Option<SubscriptionVariantType>,
}

/// One authentication method in the server-owned setup diagnosis.
#[derive(async_graphql::SimpleObject, Clone)]
pub struct AuthMethodCapabilityType {
  pub method: String,
  pub supported: bool,
  pub usable: bool,
  pub reason_code: Option<String>,
}

/// Locale-neutral operational finding. Clients own visible translations.
#[derive(async_graphql::SimpleObject, Clone)]
pub struct ServerSetupFindingType {
  pub code: String,
  pub severity: String,
}

/// Persisted wizard completion and current operational readiness.
#[derive(async_graphql::SimpleObject, Clone)]
pub struct ServerSetupStatusType {
  pub setup_completed: bool,
  pub operational_ready: bool,
  pub bootstrap_available: bool,
  pub auth_methods: Vec<AuthMethodCapabilityType>,
  pub findings: Vec<ServerSetupFindingType>,
  /// Compatibility alias for clients predating setup/readiness separation.
  #[graphql(deprecation = "use setupCompleted")]
  pub is_configured: bool,
  /// Compatibility code projection; new clients should consume findings.
  #[graphql(deprecation = "use findings")]
  pub missing_critical: Vec<String>,
  /// Compatibility code projection; new clients should consume findings.
  #[graphql(deprecation = "use findings")]
  pub warnings: Vec<String>,
}

#[derive(async_graphql::InputObject)]
pub struct CreateCheckoutSessionInput {
  pub args: Option<serde_json::Value>,
  pub coupon: Option<String>,
  pub idempotency_key: Option<String>,
  pub plan: Option<SubscriptionPlanType>,
  pub recurring: Option<SubscriptionRecurringType>,
  pub success_callback_link: String,
  pub variant: Option<SubscriptionVariantType>,
}

fn subscription_plan_from_config(plan: &crate::config::BillingPlan) -> SubscriptionPlanType {
  match plan {
    crate::config::BillingPlan::AI => SubscriptionPlanType::AI,
    crate::config::BillingPlan::Enterprise => SubscriptionPlanType::Enterprise,
    crate::config::BillingPlan::Free => SubscriptionPlanType::Free,
    crate::config::BillingPlan::Pro => SubscriptionPlanType::Pro,
    crate::config::BillingPlan::SelfHosted => SubscriptionPlanType::SelfHosted,
    crate::config::BillingPlan::SelfHostedTeam => SubscriptionPlanType::SelfHostedTeam,
    crate::config::BillingPlan::Team => SubscriptionPlanType::Team,
  }
}

fn subscription_recurring_from_config(recurring: &crate::config::BillingRecurring) -> SubscriptionRecurringType {
  match recurring {
    crate::config::BillingRecurring::Lifetime => SubscriptionRecurringType::Lifetime,
    crate::config::BillingRecurring::Monthly => SubscriptionRecurringType::Monthly,
    crate::config::BillingRecurring::Yearly => SubscriptionRecurringType::Yearly,
  }
}

fn subscription_status_from_config(status: &crate::config::BillingStatus) -> SubscriptionStatusType {
  match status {
    crate::config::BillingStatus::Active => SubscriptionStatusType::Active,
    crate::config::BillingStatus::Canceled => SubscriptionStatusType::Canceled,
    crate::config::BillingStatus::Incomplete => SubscriptionStatusType::Incomplete,
    crate::config::BillingStatus::IncompleteExpired => SubscriptionStatusType::IncompleteExpired,
    crate::config::BillingStatus::PastDue => SubscriptionStatusType::PastDue,
    crate::config::BillingStatus::Paused => SubscriptionStatusType::Paused,
    crate::config::BillingStatus::Trialing => SubscriptionStatusType::Trialing,
    crate::config::BillingStatus::Unpaid => SubscriptionStatusType::Unpaid,
  }
}

fn subscription_variant_from_config(
  variant: &Option<crate::config::BillingVariant>,
) -> Option<SubscriptionVariantType> {
  match variant {
    Some(crate::config::BillingVariant::EA) => Some(SubscriptionVariantType::EA),
    Some(crate::config::BillingVariant::Onetime) => Some(SubscriptionVariantType::Onetime),
    None => None,
  }
}

fn join_origin_url(origin: &str, path: &str) -> String {
  if path.starts_with("http://") || path.starts_with("https://") {
    return path.to_string();
  }
  let origin = origin.trim_end_matches('/');
  let path = if path.starts_with('/') {
    path.to_string()
  } else {
    format!("/{path}")
  };
  format!("{origin}{path}")
}

/// L-03: Creates a synthetic SubscriptionType stub for client compatibility.
///
/// Billing/payment/subscription mechanics are permanently out of scope for this
/// project, but the frontend clients expect `subscription` fields on UserType
/// and WorkspaceType.  This function returns a neutral stub object with
/// plausible-looking values so the client schema contract is satisfied without
/// any real billing backend.
fn neutral_subscription(
  id: String,
  plan: SubscriptionPlanType,
  recurring: SubscriptionRecurringType,
  status: SubscriptionStatusType,
  variant: Option<SubscriptionVariantType>,
) -> SubscriptionType {
  let now = Utc::now();
  SubscriptionType {
    id,
    status,
    plan,
    recurring,
    start: now,
    end: None,
    next_bill_at: None,
    canceled_at: if status == SubscriptionStatusType::Canceled {
      Some(now)
    } else {
      None
    },
    variant,
    created_at: now,
    updated_at: now,
  }
}

pub struct ApiQueryRoot;

#[async_graphql::Object]
impl ApiQueryRoot {
  #[graphql(name = "gitSyncSchedulePreview")]
  async fn git_sync_schedule_preview(
    &self,
    ctx: &Context<'_>,
    cron: String,
    #[graphql(name = "cronTimezone")] cron_timezone: String,
    count: Option<i32>,
  ) -> Result<Vec<git_sync::GitSyncScheduleOccurrenceType>> {
    let _ = crate::graphql::utils::require_session(ctx).await?;
    let count = count.unwrap_or(5);
    if !(1..=100).contains(&count) {
      return Err(
        async_graphql::Error::new("count must be between 1 and 100").extend_with(|_, extensions| {
          extensions.set("code", "GitSyncInvalidSchedule");
          extensions.set("field", "count");
        }),
      );
    }
    let schedule = myoxus_application::scheduling::cron::CronSchedule::parse(&cron, &cron_timezone)
      .map_err(map_git_sync_schedule_error)?;
    schedule
      .occurrences_after(chrono::Utc::now(), count as usize)
      .map(|values| {
        values
          .into_iter()
          .map(|value| git_sync::GitSyncScheduleOccurrenceType {
            scheduled_at_utc: value.scheduled_at_utc,
            local_date_time: value.local_date_time,
            utc_offset_seconds: value.utc_offset_seconds,
          })
          .collect()
      })
      .map_err(map_git_sync_schedule_error)
  }

  #[graphql(name = "gitSyncTimezones")]
  async fn git_sync_timezones(&self, ctx: &Context<'_>) -> Result<Vec<String>> {
    let _ = crate::graphql::utils::require_session(ctx).await?;
    let mut values = chrono_tz::TZ_VARIANTS
      .iter()
      .map(ToString::to_string)
      .collect::<Vec<_>>();
    values.sort();
    Ok(values)
  }

  async fn auth(&self) -> auth::QueryRoot {
    auth::QueryRoot
  }

  /// MCP API key management queries.
  async fn api_keys(&self) -> api_key::ApiKeyQueryRoot {
    api_key::ApiKeyQueryRoot
  }

  /// List the current user's MCP API keys (root-level alias).
  async fn list_api_keys(&self, ctx: &Context<'_>) -> Result<Vec<api_key::ApiKeyType>> {
    api_key::ApiKeyQueryRoot.list_api_keys(ctx).await
  }

  // Root-level aliases keep legacy GraphQL compatibility while `auth { ... }` remains available.
  async fn server_config(&self, ctx: &Context<'_>) -> Result<auth::ServerConfigType> {
    auth::QueryRoot.server_config(ctx).await
  }

  /// Public, cache-free Browser Web update policy.
  async fn client_update_control(&self, ctx: &Context<'_>) -> Result<auth::ClientUpdateControlType> {
    auth::QueryRoot.client_update_control(ctx).await
  }

  async fn current_user(&self, ctx: &Context<'_>) -> Result<Option<auth::UserType>> {
    auth::QueryRoot.current_user(ctx).await
  }

  /// Existing catalog themes selectable for the canonical personal workspace.
  async fn personal_workspace_theme_catalog(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<branding::PersonalWorkspaceThemeOptionType>> {
    branding::PersonalWorkspaceThemeQueryRoot
      .personal_workspace_theme_catalog(ctx, workspace_id)
      .await
  }

  /// Effective catalog-theme selection for the canonical personal workspace.
  async fn personal_workspace_theme_selection(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<branding::PersonalWorkspaceThemeSelectionType> {
    branding::PersonalWorkspaceThemeQueryRoot
      .personal_workspace_theme_selection(ctx, workspace_id)
      .await
  }

  /// Caller-scoped: organisation units in which the current session user is
  /// a member (any role). Used by manager-scope UIs in web/admin frontends.
  async fn my_organization_units(&self, ctx: &Context<'_>) -> Result<Vec<organization::OrganizationUnitTypeOutput>> {
    organization::OrganizationQueryRoot.my_organization_units(ctx).await
  }

  /// Caller-scoped: workspaces accessible via the user's OU memberships.
  async fn my_organization_unit_workspaces(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<organization::MyOrganizationUnitWorkspace>> {
    organization::OrganizationManagerQueryRoot
      .my_organization_unit_workspaces(ctx)
      .await
  }

  /// Caller-scoped: project-creation policy gate. `unitId=null` queries
  /// the root-policy.
  async fn can_create_organization_project(
    &self,
    ctx: &Context<'_>,
    unit_id: Option<ID>,
  ) -> Result<organization::ProjectCreationDecisionEnum> {
    organization::OrganizationManagerQueryRoot
      .can_create_organization_project(ctx, unit_id)
      .await
  }

  /// Caller-scoped: workspace-creation policy gate for a specific OU.
  async fn can_create_workspace_in_organization_unit(&self, ctx: &Context<'_>, unit_id: ID) -> Result<bool> {
    organization::OrganizationManagerQueryRoot
      .can_create_workspace_in_organization_unit(ctx, unit_id)
      .await
  }

  /// Caller-scoped: members of an OU the user manages (manager-only).
  async fn my_organization_unit_members(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
  ) -> Result<Vec<organization::OrganizationUnitMemberType>> {
    organization::OrganizationManagerQueryRoot
      .my_organization_unit_members(ctx, unit_id)
      .await
  }

  /// Caller-scoped audit log for an OU managed by the current actor.
  /// Manager-only; filters on `target_unit_id = unit_id`. See ORG-G-06.
  async fn my_organization_audit_log(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    skip: Option<i64>,
    take: Option<i64>,
  ) -> Result<Vec<crate::graphql::audit_types::AdminAuditLogEntryType>> {
    organization::OrganizationManagerQueryRoot
      .my_organization_audit_log(ctx, unit_id, skip, take)
      .await
  }

  /// P-AR-0-S01: Free-text search over OUs (`name`/`slug` ILIKE).
  /// Admin sees all hits, non-admin sees only OUs they are a member of.
  /// Forwarder for `OrganizationManagerQueryRoot::search_organization_units`.
  async fn search_organization_units(
    &self,
    ctx: &Context<'_>,
    query: String,
    limit: Option<i32>,
  ) -> Result<Vec<organization::OrganizationUnitSearchResult>> {
    organization::OrganizationManagerQueryRoot
      .search_organization_units(ctx, query, limit)
      .await
  }

  /// P-AR-0-S02: Manager-scoped user search. Permission gate:
  /// `is_manager_for_unit(caller, unitId)`. Forwarder for
  /// `OrganizationManagerQueryRoot::manager_search_users`.
  async fn manager_search_users(
    &self,
    ctx: &Context<'_>,
    query: String,
    unit_id: ID,
    limit: Option<i32>,
  ) -> Result<Vec<organization::ManagerUserSearchResult>> {
    organization::OrganizationManagerQueryRoot
      .manager_search_users(ctx, query, unit_id, limit)
      .await
  }

  /// Return structured error metadata for a given error name (introspection/documentation).
  async fn error(&self, name: error_types::ErrorNames) -> error_types::ErrorDataUnion {
    error_types::resolve_error(name)
  }

  /// Check server setup status for admin setup wizard (P91-CFG-C-01).
  /// Reports whether critical configuration is complete.
  /// Accessible by any authenticated user (for setup wizard redirect logic).
  #[instrument(skip(self, ctx), level = "debug")]
  async fn server_setup_status(&self, ctx: &Context<'_>) -> Result<ServerSetupStatusType> {
    let (state, _) = crate::graphql::utils::require_session_allow_unverified(ctx).await?;

    let status = crate::graphql::config::check_server_setup_status(&state).await?;
    let missing_critical = status
      .findings
      .iter()
      .filter(|finding| finding.severity == crate::graphql::config::ServerSetupFindingSeverity::Critical)
      .map(|finding| finding.code.to_string())
      .collect();
    let warnings = status
      .findings
      .iter()
      .filter(|finding| finding.severity == crate::graphql::config::ServerSetupFindingSeverity::Warning)
      .map(|finding| finding.code.to_string())
      .collect();
    Ok(ServerSetupStatusType {
      setup_completed: status.setup_completed,
      operational_ready: status.operational_ready,
      bootstrap_available: status.auth_capabilities.bootstrap_available,
      auth_methods: status
        .auth_capabilities
        .methods
        .iter()
        .map(|method| AuthMethodCapabilityType {
          method: method.method.as_str().to_string(),
          supported: method.supported,
          usable: method.usable,
          reason_code: method.reason_code.map(|reason| reason.as_str().to_string()),
        })
        .collect(),
      findings: status
        .findings
        .iter()
        .map(|finding| ServerSetupFindingType {
          code: finding.code.to_string(),
          severity: finding.severity.as_str().to_string(),
        })
        .collect(),
      is_configured: status.setup_completed,
      missing_critical,
      warnings,
    })
  }

  async fn user(&self, ctx: &Context<'_>, email: String) -> Result<Option<auth::UserOrLimitedUser>> {
    auth::QueryRoot.user(ctx, email).await
  }

  async fn public_user_by_id(&self, ctx: &Context<'_>, id: String) -> Result<Option<auth::PublicUserType>> {
    auth::QueryRoot.public_user_by_id(ctx, id).await
  }

  async fn oauth_providers(&self, ctx: &Context<'_>) -> Result<Vec<auth::OAuthProviderType>> {
    auth::QueryRoot.oauth_providers(ctx).await
  }

  #[graphql(deprecation = "use currentUser.revealedAccessTokens")]
  async fn revealed_access_tokens(&self, ctx: &Context<'_>) -> Result<Vec<auth::RevealedAccessToken>> {
    auth::QueryRoot.revealed_access_tokens(ctx).await
  }

  async fn workspaces(&self, ctx: &Context<'_>) -> Result<Vec<auth::WorkspaceType>> {
    auth::QueryRoot.workspaces(ctx).await
  }

  async fn workspace_import(&self, ctx: &Context<'_>, workspace_import_id: ID) -> Result<auth::WorkspaceImportType> {
    auth::QueryRoot.workspace_import(ctx, workspace_import_id).await
  }

  /// Actor-scoped, redacted durable XWS status.
  async fn workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<auth::WorkspaceContentOperationType> {
    auth::QueryRoot.workspace_content_operation(ctx, operation_id).await
  }

  /// Resolve an old XWS route without exposing a target the actor cannot read.
  async fn workspace_content_redirect(
    &self,
    ctx: &Context<'_>,
    input: auth::WorkspaceContentRedirectInput,
  ) -> Result<Option<auth::WorkspaceContentRedirectType>> {
    auth::QueryRoot.workspace_content_redirect(ctx, input).await
  }

  async fn preview_legacy_database_migration(
    &self,
    ctx: &Context<'_>,
    input: auth::database::LegacyDatabaseMigrationInput,
  ) -> Result<auth::database::LegacyDatabaseMigrationPlanObjectType> {
    auth::QueryRoot.preview_legacy_database_migration(ctx, input).await
  }

  #[graphql(name = "serverUsers")]
  async fn server_users(
    &self,
    ctx: &Context<'_>,
    search: String,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<auth::ServerUserSearchResult>> {
    auth::QueryRoot.server_users(ctx, search, skip, take).await
  }

  async fn workspace(
    &self,
    ctx: &Context<'_>,
    id: String,
    #[graphql(name = "docId")] doc_id: Option<String>,
  ) -> Result<Option<auth::WorkspaceType>> {
    auth::QueryRoot.workspace(ctx, id, doc_id).await
  }

  async fn workspace_role_permissions(&self, ctx: &Context<'_>, id: String) -> Result<auth::WorkspaceRolePermissions> {
    auth::QueryRoot.workspace_role_permissions(ctx, id).await
  }

  #[allow(clippy::too_many_arguments)]
  async fn search(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    query: String,
    language: Option<String>,
    skip: Option<i32>,
    take: Option<i32>,
    sort_by: Option<auth::SearchSortByType>,
    sort_direction: Option<auth::SortDirectionType>,
    #[graphql(name = "useSemanticSearch")] use_semantic_search: Option<bool>,
  ) -> Result<Vec<auth::SearchDocType>> {
    auth::QueryRoot
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

  #[allow(clippy::too_many_arguments)]
  async fn search_docs(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    query: String,
    language: Option<String>,
    skip: Option<i32>,
    take: Option<i32>,
    sort_by: Option<auth::SearchSortByType>,
    sort_direction: Option<auth::SortDirectionType>,
    #[graphql(name = "useSemanticSearch")] use_semantic_search: Option<bool>,
  ) -> Result<Vec<auth::SearchDocType>> {
    auth::QueryRoot
      .search_docs(
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

  async fn aggregate(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    query: String,
    language: Option<String>,
  ) -> Result<auth::SearchAggregateType> {
    auth::QueryRoot.aggregate(ctx, workspace_id, query, language).await
  }

  async fn calendar_providers(&self, ctx: &Context<'_>) -> Result<Vec<String>> {
    auth::QueryRoot.calendar_providers(ctx).await
  }

  #[graphql(name = "calendarCalDAVProviders")]
  async fn calendar_caldav_providers(&self, ctx: &Context<'_>) -> Result<Vec<String>> {
    auth::QueryRoot.calendar_caldav_providers(ctx).await
  }

  async fn calendar_accounts(&self, ctx: &Context<'_>) -> Result<Vec<auth::CalendarAccountType>> {
    auth::QueryRoot.calendar_accounts(ctx).await
  }

  async fn calendar_events(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    from: chrono::DateTime<chrono::Utc>,
    to: chrono::DateTime<chrono::Utc>,
  ) -> Result<Vec<auth::CalendarEventType>> {
    auth::QueryRoot.calendar_events(ctx, workspace_id, from, to).await
  }

  /// Resolve a single workspace event by its stable local identifier.
  async fn calendar_event(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    event_id: String,
  ) -> Result<Option<auth::CalendarEventType>> {
    auth::QueryRoot.calendar_event(ctx, workspace_id, event_id).await
  }

  async fn workspace_calendars(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Vec<auth::WorkspaceCalendarType>> {
    auth::QueryRoot.workspace_calendars(ctx, workspace_id).await
  }

  /// Authored native series, independent of their current projected window.
  async fn workspace_calendar_series(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Vec<auth::CalendarEventType>> {
    auth::QueryRoot.workspace_calendar_series(ctx, workspace_id).await
  }

  /// Query free/busy information for workspace members (P90-CAL-H-07).
  async fn calendar_free_busy(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    user_ids: Vec<String>,
    from: chrono::DateTime<chrono::Utc>,
    to: chrono::DateTime<chrono::Utc>,
  ) -> Result<Vec<auth::UserFreeBusy>> {
    auth::QueryRoot
      .calendar_free_busy(ctx, workspace_id, user_ids, from, to)
      .await
  }

  // ── Native-calendar queries (P-JCAL-SERVER-03-C) ─────────────────────────

  /// List workspace event tags (P-JCAL-SERVER-03).
  async fn calendar_event_tags(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Vec<auth::CalendarEventTagType>> {
    auth::QueryRoot.calendar_event_tags(ctx, workspace_id).await
  }

  /// Get workspace calendar settings (writeback target + default reminder).
  async fn workspace_calendar_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Option<auth::WorkspaceCalendarSettingsType>> {
    auth::QueryRoot.workspace_calendar_settings(ctx, workspace_id).await
  }

  /// Export workspace-native events as an ICS string (P-JCAL-SERVER-07-A).
  async fn export_workspace_calendar_ics(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    from: chrono::DateTime<chrono::Utc>,
    to: chrono::DateTime<chrono::Utc>,
  ) -> Result<String> {
    auth::QueryRoot
      .export_workspace_calendar_ics(ctx, workspace_id, from, to)
      .await
  }

  async fn comment_threads(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    filter: Option<auth::CommentThreadFilterType>,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<auth::CommentType>> {
    auth::QueryRoot
      .comment_threads(ctx, workspace_id, doc_id, filter, skip, take)
      .await
  }

  async fn comment_replies(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    parent_comment_id: String,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<auth::CommentType>> {
    auth::QueryRoot
      .comment_replies(ctx, workspace_id, doc_id, parent_comment_id, skip, take)
      .await
  }

  async fn comment_edit_history(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    comment_id: String,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<auth::CommentEditHistoryType>> {
    auth::QueryRoot
      .comment_edit_history(ctx, workspace_id, doc_id, comment_id, skip, take)
      .await
  }

  async fn get_invite_info(&self, ctx: &Context<'_>, invite_id: String) -> Result<auth::InvitationType> {
    auth::QueryRoot.get_invite_info(ctx, invite_id).await
  }

  async fn admin(&self) -> admin::AdminRoot {
    admin::AdminRoot
  }

  // Billing/payment compatibility surface with neutral, non-restrictive values.
  async fn prices(&self, ctx: &Context<'_>) -> Result<Vec<SubscriptionPriceType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let billing = &state.config.compat.billing;
    Ok(vec![SubscriptionPriceType {
      r#type: billing.prices.type_name.clone(),
      plan: subscription_plan_from_config(&billing.plan),
      currency: billing.currency.clone(),
      amount: billing.prices.amount,
      yearly_amount: billing.prices.yearly_amount,
      lifetime_amount: billing.prices.lifetime_amount,
    }])
  }

  async fn apply_doc_updates(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    op: String,
    updates: String,
  ) -> Result<String> {
    apply_doc_updates_impl(ctx, workspace_id, doc_id, op, updates).await
  }

  async fn query_workspace_embedding_status(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<ContextWorkspaceEmbeddingStatusType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::Copilot,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    let index = state
      .copilot_embedding_repo()
      .ok_or_else(|| async_graphql::Error::new("embedding repository unavailable"))?
      .workspace_index_status(
        workspace_uuid,
        &state.config.copilot.embedding.model,
        state.config.copilot.embedding.dimensions,
      )
      .await
      .map_err(|_| async_graphql::Error::new("embedding status unavailable"))?;
    let configured = state.copilot_embedding_provider().is_ok();
    let status = if !configured {
      ContextEmbedStatusType::Failed
    } else if index.processing {
      ContextEmbedStatusType::Processing
    } else if index.failed || index.total == 0 || index.embedded < index.total {
      ContextEmbedStatusType::Failed
    } else {
      ContextEmbedStatusType::Finished
    };
    Ok(ContextWorkspaceEmbeddingStatusType {
      embedded: index.embedded,
      total: index.total,
      available: configured && index.embedded > 0,
      status,
      error: if !configured {
        Some("EMBEDDING_UNCONFIGURED".into())
      } else if status == ContextEmbedStatusType::Failed {
        Some("EMBEDDING_INDEX_UNAVAILABLE".into())
      } else {
        None
      },
    })
  }

  /// Admin-only: disk usage for the git sync mirror repository directory.
  #[tracing::instrument(skip(self, ctx))]
  async fn git_sync_storage_usage(&self, ctx: &Context<'_>) -> Result<GitSyncStorageUsageType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    ensure_admin(ctx, state).await?;

    let repo_base_dir = std::path::PathBuf::from(&state.config.git_sync.repo_base_dir);
    let max_mirror_storage_mb = state.config.git_sync.max_mirror_storage_mb;

    let usage = myoxus_infrastructure::disk::compute_usage(&repo_base_dir, max_mirror_storage_mb).await;

    Ok(GitSyncStorageUsageType {
      total_bytes: usage.total_bytes as i64,
      repo_count: usage.entry_count as i32,
      free_bytes: usage.free_bytes as i64,
      capacity_bytes: usage.capacity_bytes as i64,
      limit_bytes: usage.limit_bytes as i64,
      usage_percent: usage.usage_percent(),
    })
  }

  /// Admin-only: list persisted SSH host-key pins used by Git-Sync.
  #[tracing::instrument(skip(self, ctx))]
  #[graphql(name = "gitSyncSshHostKeys")]
  async fn git_sync_ssh_host_keys(&self, ctx: &Context<'_>) -> Result<Vec<git_sync::GitSyncSshHostKeyType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    ensure_admin(ctx, state).await?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    let keys = store
      .list_ssh_host_keys()
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to list SSH host keys: {e}")))?;
    Ok(keys.into_iter().map(git_sync::map_ssh_host_key).collect())
  }

  /// Poll the status of a PDF export job.
  async fn pdf_export_job(&self, ctx: &Context<'_>, job_id: String) -> Result<pdf_export::PdfExportJobType> {
    pdf_export::PdfExportQueryRoot.pdf_export_job(ctx, job_id).await
  }

  /// List recent PDF export jobs for a document. Workspace-read protected.
  async fn document_pdf_export_history(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    limit: Option<i32>,
  ) -> Result<Vec<pdf_export::PdfExportHistoryEntryType>> {
    pdf_export::PdfExportQueryRoot
      .document_pdf_export_history(ctx, workspace_id, doc_id, limit)
      .await
  }

  /// Read the committed content revision used to confirm a history restore.
  async fn document_history_revision(&self, ctx: &Context<'_>, workspace_id: ID, doc_id: ID) -> Result<String> {
    document_version::DocumentVersionQueryRoot
      .document_history_revision(ctx, workspace_id, doc_id)
      .await
  }

  /// List user-visible named versions for a document.
  async fn document_versions(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
  ) -> Result<Vec<document_version::DocumentVersionType>> {
    document_version::DocumentVersionQueryRoot
      .document_versions(ctx, workspace_id, doc_id)
      .await
  }

  /// Fetch one named document version by id.
  async fn document_version(&self, ctx: &Context<'_>, id: ID) -> Result<Option<document_version::DocumentVersionType>> {
    document_version::DocumentVersionQueryRoot
      .document_version(ctx, id)
      .await
  }

  /// Compute a diff between two named document versions.
  async fn document_version_diff(
    &self,
    ctx: &Context<'_>,
    from_id: ID,
    to_id: ID,
  ) -> Result<document_version::DocumentVersionDiffType> {
    document_version::DocumentVersionQueryRoot
      .document_version_diff(ctx, from_id, to_id)
      .await
  }

  /// Fetch per-document versioning settings for the PDF export picker.
  async fn document_versioning_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
  ) -> Result<document_version::DocumentVersioningSettingsType> {
    document_version::DocumentVersionQueryRoot
      .document_versioning_settings(ctx, workspace_id, doc_id)
      .await
  }

  async fn workspace_history_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<document_version::WorkspaceHistorySettingsType> {
    document_version::DocumentVersionQueryRoot
      .workspace_history_settings(ctx, workspace_id)
      .await
  }

  /// List global/workspace versioning policies selectable in workspace settings.
  async fn document_version_policies(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<document_version::DocumentVersionPolicyType>> {
    document_version::DocumentVersionQueryRoot
      .document_version_policies(ctx, workspace_id)
      .await
  }

  async fn document_metadata_field_definitions(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<document_metadata_policy::DocumentMetadataFieldDefinitionType>> {
    document_metadata_policy::DocumentMetadataPolicyQueryRoot
      .document_metadata_field_definitions(ctx)
      .await
  }

  async fn document_metadata_value_definitions(
    &self,
    ctx: &Context<'_>,
    field_key: String,
  ) -> Result<Vec<document_metadata_policy::DocumentMetadataValueDefinitionType>> {
    document_metadata_policy::DocumentMetadataPolicyQueryRoot
      .document_metadata_value_definitions(ctx, field_key)
      .await
  }

  async fn document_status_schemas(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<document_metadata_policy::DocumentStatusSchemaType>> {
    document_metadata_policy::DocumentMetadataPolicyQueryRoot
      .document_status_schemas(ctx)
      .await
  }

  async fn document_status_values(
    &self,
    ctx: &Context<'_>,
    schema_key: String,
  ) -> Result<Vec<document_metadata_policy::DocumentStatusValueType>> {
    document_metadata_policy::DocumentMetadataPolicyQueryRoot
      .document_status_values(ctx, schema_key)
      .await
  }

  async fn document_types(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<document_metadata_policy::DocumentTypeDefinitionType>> {
    document_metadata_policy::DocumentMetadataPolicyQueryRoot
      .document_types(ctx)
      .await
  }

  async fn workspace_document_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Option<document_metadata_policy::WorkspaceDocumentSettingsType>> {
    document_metadata_policy::DocumentMetadataPolicyQueryRoot
      .workspace_document_settings(ctx, workspace_id)
      .await
  }

  async fn document_metadata_index(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<document_metadata_policy::DocumentMetadataIndexRowType>> {
    document_metadata_policy::DocumentMetadataPolicyQueryRoot
      .document_metadata_index(ctx, workspace_id)
      .await
  }

  async fn document_field_catalog(&self, ctx: &Context<'_>) -> Result<document_metadata::DocumentFieldCatalogType> {
    document_metadata::DocumentMetadataQueryRoot
      .document_field_catalog(ctx)
      .await
  }

  async fn document_field_output(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    fields: async_graphql::Json<serde_json::Value>,
  ) -> Result<Vec<String>> {
    document_metadata::DocumentMetadataQueryRoot
      .document_field_output(ctx, workspace_id, doc_id, fields)
      .await
  }

  async fn document_field_presentations(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    fields: async_graphql::Json<serde_json::Value>,
  ) -> Result<Vec<document_metadata::DocumentFieldPresentationType>> {
    document_metadata::DocumentMetadataQueryRoot
      .document_field_presentations(ctx, workspace_id, doc_id, fields)
      .await
  }

  async fn document_metadata(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    requested_projection_mode: Option<document_metadata::DocumentMetadataProjectionModeType>,
  ) -> Result<document_metadata::DocumentMetadataType> {
    document_metadata::DocumentMetadataQueryRoot
      .document_metadata(ctx, workspace_id, doc_id, requested_projection_mode)
      .await
  }

  async fn document_review_planning(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
  ) -> Result<document_metadata::DocumentReviewPlanningType> {
    document_metadata::DocumentMetadataQueryRoot
      .document_review_planning(ctx, workspace_id, doc_id)
      .await
  }

  async fn document_metadata_validation(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    action: Option<document_metadata::DocumentMetadataValidationActionType>,
  ) -> Result<document_metadata::DocumentMetadataValidationType> {
    document_metadata::DocumentMetadataQueryRoot
      .document_metadata_validation(ctx, workspace_id, doc_id, action)
      .await
  }

  /// Render a template preview PDF with representative document content.
  ///
  /// Admins call this without `workspaceId`; workspace clients must pass
  /// `workspaceId`, which restricts access to templates assigned to that
  /// workspace.
  async fn pdf_template_preview_pdf(
    &self,
    ctx: &Context<'_>,
    template_id: String,
    locale: Option<String>,
    workspace_id: Option<String>,
  ) -> Result<String> {
    pdf_export::PdfExportQueryRoot
      .pdf_template_preview_pdf(ctx, template_id, locale, workspace_id)
      .await
  }

  /// P-PDF-TPL-10-01: list PDF templates assigned to a workspace.
  /// Members-only — non-members of `workspace_id` are rejected.
  async fn available_pdf_templates(
    &self,
    ctx: &Context<'_>,
    workspace_id: async_graphql::ID,
    locale: Option<String>,
  ) -> Result<Vec<pdf_workspace::PdfTemplatePublic>> {
    pdf_workspace::PdfWorkspaceQueryRoot
      .available_pdf_templates(ctx, workspace_id, locale)
      .await
  }

  /// Workspace document-branding profile (audit fields stripped).
  /// Members-only.
  async fn document_branding_profile(
    &self,
    ctx: &Context<'_>,
    workspace_id: async_graphql::ID,
  ) -> Result<pdf_workspace::DocumentBrandingProfilePublic> {
    pdf_workspace::PdfWorkspaceQueryRoot
      .document_branding_profile(ctx, workspace_id)
      .await
  }

  /// Per-workspace export-time defaults (default template, locale, paper size,
  /// color profile, image quality, ligatures). Members-only.
  async fn pdf_export_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: async_graphql::ID,
  ) -> Result<pdf_workspace::PdfExportSettings> {
    pdf_workspace::PdfWorkspaceQueryRoot
      .pdf_export_settings(ctx, workspace_id)
      .await
  }
}

pub struct ApiMutationRoot;

#[derive(async_graphql::InputObject, Clone)]
pub struct ManageUserInput {
  #[graphql(validator(max_length = 255))]
  pub email: Option<String>,
  #[graphql(validator(max_length = 255))]
  pub name: Option<String>,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct CreateUserInput {
  #[graphql(validator(max_length = 255))]
  pub email: String,
  #[graphql(validator(max_length = 255))]
  pub name: Option<String>,
  #[graphql(validator(max_length = 255))]
  pub password: Option<String>,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct ImportUsersInput {
  pub users: Vec<CreateUserInput>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "UserImportFailedType")]
pub struct UserImportFailedType {
  pub email: String,
  pub error: String,
}

#[derive(async_graphql::Union)]
#[graphql(name = "UserImportResultType")]
pub enum UserImportResultType {
  User(auth::UserType),
  Failed(UserImportFailedType),
}

#[async_graphql::Object]
impl ApiMutationRoot {
  /// Admin operations sub-root. All admin mutations are accessible via this field.
  async fn admin(&self) -> admin::AdminRoot {
    admin::AdminRoot
  }

  async fn auth(&self) -> auth::MutationRoot {
    auth::MutationRoot
  }

  /// Select an existing server-owned theme for the canonical personal workspace.
  async fn set_personal_workspace_theme(
    &self,
    ctx: &Context<'_>,
    input: branding::SetPersonalWorkspaceThemeInput,
  ) -> Result<branding::PersonalWorkspaceThemeSelectionType> {
    branding::PersonalWorkspaceThemeMutationRoot
      .set_personal_workspace_theme(ctx, input)
      .await
  }

  /// Reset the canonical personal workspace to the inherited server theme.
  async fn reset_personal_workspace_theme(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<branding::PersonalWorkspaceThemeSelectionType> {
    branding::PersonalWorkspaceThemeMutationRoot
      .reset_personal_workspace_theme(ctx, workspace_id)
      .await
  }

  /// MCP API key management mutations.
  async fn api_keys(&self) -> api_key::ApiKeyMutationRoot {
    api_key::ApiKeyMutationRoot
  }

  /// Create a new MCP API key (root-level alias).
  async fn create_api_key(
    &self,
    ctx: &Context<'_>,
    name: String,
    scopes: Vec<String>,
    expires_in_days: Option<i32>,
  ) -> Result<api_key::CreatedApiKeyType> {
    api_key::ApiKeyMutationRoot
      .create_api_key(ctx, name, scopes, expires_in_days)
      .await
  }

  /// Revoke an MCP API key (root-level alias).
  async fn revoke_api_key(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    api_key::ApiKeyMutationRoot.revoke_api_key(ctx, id).await
  }

  async fn create_workspace_import_upload(
    &self,
    ctx: &Context<'_>,
    source_size_bytes: i64,
    source_hash: String,
    parts: Vec<auth::WorkspaceImportPartManifestInput>,
    source_format: Option<auth::WorkspaceImportSourceFormatInput>,
  ) -> Result<auth::WorkspaceImportUploadType> {
    auth::MutationRoot
      .create_workspace_import_upload(ctx, source_size_bytes, source_hash, parts, source_format)
      .await
  }

  async fn complete_workspace_import_upload(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
    source_size_bytes: i64,
    source_hash: String,
  ) -> Result<auth::WorkspaceImportType> {
    auth::MutationRoot
      .complete_workspace_import_upload(ctx, workspace_import_id, source_size_bytes, source_hash)
      .await
  }

  async fn preview_workspace_import(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<auth::WorkspaceImportType> {
    auth::MutationRoot
      .preview_workspace_import(ctx, workspace_import_id)
      .await
  }

  async fn apply_workspace_import(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<auth::WorkspaceImportType> {
    auth::MutationRoot
      .apply_workspace_import(ctx, workspace_import_id)
      .await
  }

  async fn cancel_workspace_import(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<auth::WorkspaceImportType> {
    auth::MutationRoot
      .cancel_workspace_import(ctx, workspace_import_id)
      .await
  }

  async fn retry_workspace_import_cleanup(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<auth::WorkspaceImportType> {
    auth::MutationRoot
      .retry_workspace_import_cleanup(ctx, workspace_import_id)
      .await
  }

  /// Build and persist one server-authoritative XWS preflight.
  async fn workspace_content_preflight(
    &self,
    ctx: &Context<'_>,
    input: auth::WorkspaceContentPreflightInput,
  ) -> Result<auth::WorkspaceContentPreflightType> {
    auth::MutationRoot.workspace_content_preflight(ctx, input).await
  }

  /// Execute exactly the current XWS preflight revision.
  async fn execute_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    input: auth::WorkspaceContentExecuteInput,
  ) -> Result<auth::WorkspaceContentOperationType> {
    auth::MutationRoot.execute_workspace_content_operation(ctx, input).await
  }

  /// Cancel an actor-owned XWS operation before canonical publication.
  async fn cancel_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<auth::WorkspaceContentOperationType> {
    auth::MutationRoot
      .cancel_workspace_content_operation(ctx, operation_id)
      .await
  }

  /// Re-authorize and resume an actor-owned failed XWS operation.
  async fn retry_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<auth::WorkspaceContentOperationType> {
    auth::MutationRoot
      .retry_workspace_content_operation(ctx, operation_id)
      .await
  }

  /// Preflight Undo as a separately authorized counter-operation.
  async fn undo_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    origin_operation_id: Uuid,
    idempotency_id: Uuid,
  ) -> Result<auth::WorkspaceContentPreflightType> {
    auth::MutationRoot
      .undo_workspace_content_operation(ctx, origin_operation_id, idempotency_id)
      .await
  }

  async fn apply_legacy_database_migration(
    &self,
    ctx: &Context<'_>,
    input: auth::database::LegacyDatabaseMigrationInput,
  ) -> Result<auth::database::LegacyDatabaseMigrationApplyObjectType> {
    auth::MutationRoot.apply_legacy_database_migration(ctx, input).await
  }

  async fn change_password(
    &self,
    ctx: &Context<'_>,
    token: String,
    new_password: String,
    user_id: Option<String>,
  ) -> Result<bool> {
    auth::MutationRoot
      .change_password(ctx, token, new_password, user_id)
      .await
  }

  async fn change_email(&self, ctx: &Context<'_>, token: String, email: String) -> Result<auth::UserType> {
    auth::MutationRoot.change_email(ctx, token, email).await
  }

  async fn verify_email(&self, ctx: &Context<'_>, token: String) -> Result<bool> {
    auth::MutationRoot.verify_email(ctx, token).await
  }

  async fn send_change_password_email(
    &self,
    ctx: &Context<'_>,
    callback_url: Option<String>,
    email: Option<String>,
  ) -> Result<bool> {
    auth::MutationRoot
      .send_change_password_email(ctx, callback_url, email)
      .await
  }

  async fn send_set_password_email(
    &self,
    ctx: &Context<'_>,
    callback_url: Option<String>,
    email: Option<String>,
  ) -> Result<bool> {
    auth::MutationRoot
      .send_set_password_email(ctx, callback_url, email)
      .await
  }

  async fn send_change_email(&self, ctx: &Context<'_>, callback_url: String, email: Option<String>) -> Result<bool> {
    auth::MutationRoot.send_change_email(ctx, callback_url, email).await
  }

  async fn send_verify_change_email(
    &self,
    ctx: &Context<'_>,
    token: String,
    email: String,
    callback_url: String,
  ) -> Result<bool> {
    auth::MutationRoot
      .send_verify_change_email(ctx, token, email, callback_url)
      .await
  }

  async fn send_verify_email(&self, ctx: &Context<'_>, callback_url: String) -> Result<bool> {
    auth::MutationRoot.send_verify_email(ctx, callback_url).await
  }

  async fn update_profile(&self, ctx: &Context<'_>, input: auth::UpdateUserInput) -> Result<auth::UserType> {
    auth::MutationRoot.update_profile(ctx, input).await
  }

  async fn save_assistant_setup(
    &self,
    ctx: &Context<'_>,
    expected_user_id: ID,
    input: auth::SaveAssistantSetupInput,
  ) -> Result<auth::UserPreferencesType> {
    auth::MutationRoot
      .save_assistant_setup(ctx, expected_user_id, input)
      .await
  }

  async fn delete_assistant_setup(
    &self,
    ctx: &Context<'_>,
    expected_user_id: ID,
    id: ID,
  ) -> Result<auth::UserPreferencesType> {
    auth::MutationRoot
      .delete_assistant_setup(ctx, expected_user_id, id)
      .await
  }

  async fn update_preferences(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateUserPreferencesInput,
  ) -> Result<auth::UserPreferencesType> {
    auth::MutationRoot.update_preferences(ctx, input).await
  }

  async fn upload_avatar(&self, ctx: &Context<'_>, avatar: Upload) -> Result<auth::UserType> {
    auth::MutationRoot.upload_avatar(ctx, avatar).await
  }

  async fn remove_avatar(&self, ctx: &Context<'_>) -> Result<auth::RemoveAvatar> {
    auth::MutationRoot.remove_avatar(ctx).await
  }

  async fn delete_account(&self, ctx: &Context<'_>) -> Result<auth::DeleteAccount> {
    auth::MutationRoot.delete_account(ctx).await
  }

  async fn generate_user_access_token(
    &self,
    ctx: &Context<'_>,
    input: auth::GenerateAccessTokenInput,
  ) -> Result<auth::RevealedAccessToken> {
    auth::MutationRoot.generate_user_access_token(ctx, input).await
  }

  async fn revoke_user_access_token(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    auth::MutationRoot.revoke_user_access_token(ctx, id).await
  }

  async fn create_workspace(
    &self,
    ctx: &Context<'_>,
    init: Option<Upload>,
    input: Option<auth::CreateWorkspaceInput>,
  ) -> Result<auth::WorkspaceType> {
    auth::MutationRoot.create_workspace(ctx, init, input).await
  }

  async fn create_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateWorkspaceTagInput,
  ) -> Result<auth::WorkspaceTagObjectType> {
    auth::MutationRoot.create_workspace_tag(ctx, input).await
  }

  async fn rename_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: auth::RenameWorkspaceTagInput,
  ) -> Result<auth::WorkspaceTagObjectType> {
    auth::MutationRoot.rename_workspace_tag(ctx, input).await
  }

  async fn recolor_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: auth::RecolorWorkspaceTagInput,
  ) -> Result<auth::WorkspaceTagObjectType> {
    auth::MutationRoot.recolor_workspace_tag(ctx, input).await
  }

  async fn update_workspace_tag_description(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateWorkspaceTagDescriptionInput,
  ) -> Result<auth::WorkspaceTagObjectType> {
    auth::MutationRoot.update_workspace_tag_description(ctx, input).await
  }

  async fn archive_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: auth::WorkspaceTagLifecycleInput,
  ) -> Result<auth::WorkspaceTagObjectType> {
    auth::MutationRoot.archive_workspace_tag(ctx, input).await
  }

  async fn restore_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: auth::WorkspaceTagLifecycleInput,
  ) -> Result<auth::WorkspaceTagObjectType> {
    auth::MutationRoot.restore_workspace_tag(ctx, input).await
  }

  async fn delete_workspace_tag_permanently(
    &self,
    ctx: &Context<'_>,
    input: auth::WorkspaceTagLifecycleInput,
  ) -> Result<bool> {
    auth::MutationRoot.delete_workspace_tag_permanently(ctx, input).await
  }

  async fn set_document_workspace_tags(
    &self,
    ctx: &Context<'_>,
    input: auth::SetDocumentWorkspaceTagsInput,
  ) -> Result<Vec<ID>> {
    auth::MutationRoot.set_document_workspace_tags(ctx, input).await
  }

  async fn import_workspace_tags(
    &self,
    ctx: &Context<'_>,
    input: auth::ImportWorkspaceTagsInput,
  ) -> Result<auth::WorkspaceTagTransferObjectType> {
    auth::MutationRoot.import_workspace_tags(ctx, input).await
  }

  async fn bootstrap_workspace_tags(
    &self,
    ctx: &Context<'_>,
    input: auth::BootstrapWorkspaceTagsInput,
  ) -> Result<auth::WorkspaceTagBootstrapResultObjectType> {
    auth::MutationRoot.bootstrap_workspace_tags(ctx, input).await
  }

  async fn create_database(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseInput,
  ) -> Result<auth::DatabaseRecordObjectType> {
    auth::MutationRoot.create_database(ctx, input).await
  }

  async fn create_project(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateProjectInput,
  ) -> Result<auth::DatabaseRecordObjectType> {
    auth::MutationRoot.create_project(ctx, input).await
  }

  async fn retry_workspace_creation(
    &self,
    ctx: &Context<'_>,
    input: auth::RetryWorkspaceCreationInput,
  ) -> Result<Option<auth::WorkspaceCreationResultType>> {
    auth::MutationRoot.retry_workspace_creation(ctx, input).await
  }

  async fn stop_workspace_creation(
    &self,
    ctx: &Context<'_>,
    input: auth::StopWorkspaceCreationInput,
  ) -> Result<Option<auth::WorkspaceCreationResultType>> {
    auth::MutationRoot.stop_workspace_creation(ctx, input).await
  }

  async fn stop_project_setup(
    &self,
    ctx: &Context<'_>,
    input: auth::StopProjectSetupInput,
  ) -> Result<auth::ProjectSetupObjectType> {
    auth::MutationRoot.stop_project_setup(ctx, input).await
  }

  async fn apply_context_documents(
    &self,
    ctx: &Context<'_>,
    input: auth::ApplyContextDocumentsInput,
  ) -> Result<auth::ContextDocumentsObjectType> {
    auth::MutationRoot.apply_context_documents(ctx, input).await
  }

  async fn retry_context_documents(
    &self,
    ctx: &Context<'_>,
    input: auth::RetryContextDocumentsInput,
  ) -> Result<auth::ContextDocumentsObjectType> {
    auth::MutationRoot.retry_context_documents(ctx, input).await
  }

  async fn stop_context_documents(
    &self,
    ctx: &Context<'_>,
    input: auth::StopContextDocumentsInput,
  ) -> Result<auth::ContextDocumentsObjectType> {
    auth::MutationRoot.stop_context_documents(ctx, input).await
  }

  async fn start_task_handover(
    &self,
    ctx: &Context<'_>,
    input: auth::StartTaskHandoverInput,
  ) -> Result<auth::TaskHandoverObjectType> {
    auth::MutationRoot.start_task_handover(ctx, input).await
  }

  async fn retry_task_handover(
    &self,
    ctx: &Context<'_>,
    input: auth::TaskHandoverRunInput,
  ) -> Result<auth::TaskHandoverObjectType> {
    auth::MutationRoot.retry_task_handover(ctx, input).await
  }

  async fn stop_task_handover(
    &self,
    ctx: &Context<'_>,
    input: auth::TaskHandoverRunInput,
  ) -> Result<auth::TaskHandoverObjectType> {
    auth::MutationRoot.stop_task_handover(ctx, input).await
  }

  async fn configure_task_preparation(
    &self,
    ctx: &Context<'_>,
    input: auth::ConfigureTaskPreparationInput,
  ) -> Result<auth::TaskPreparationConfigurationObjectType> {
    auth::MutationRoot.configure_task_preparation(ctx, input).await
  }
  async fn retry_task_preparation_run(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<auth::TaskPreparationRunObjectType> {
    auth::MutationRoot.retry_task_preparation_run(ctx, run_id).await
  }
  async fn stop_task_preparation_run(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<auth::TaskPreparationRunObjectType> {
    auth::MutationRoot.stop_task_preparation_run(ctx, run_id).await
  }
  async fn configure_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: auth::ConfigureTaskPreparationInput,
  ) -> Result<auth::TaskPreparationConfigurationObjectType> {
    auth::MutationRoot.configure_task_maintenance(ctx, input).await
  }
  async fn start_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: auth::StartTaskMaintenanceInput,
  ) -> Result<auth::TaskMaintenanceObjectType> {
    auth::MutationRoot.start_task_maintenance(ctx, input).await
  }

  async fn retry_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: auth::TaskMaintenanceRunInput,
  ) -> Result<auth::TaskMaintenanceObjectType> {
    auth::MutationRoot.retry_task_maintenance(ctx, input).await
  }

  async fn stop_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: auth::TaskMaintenanceRunInput,
  ) -> Result<auth::TaskMaintenanceObjectType> {
    auth::MutationRoot.stop_task_maintenance(ctx, input).await
  }

  async fn confirm_task_corrections(
    &self,
    ctx: &Context<'_>,
    input: auth::ConfirmTaskCorrectionsInput,
  ) -> Result<auth::TaskMaintenanceObjectType> {
    auth::MutationRoot.confirm_task_corrections(ctx, input).await
  }

  async fn start_document_review(
    &self,
    ctx: &Context<'_>,
    input: auth::StartDocumentReviewInput,
  ) -> Result<auth::DocumentReviewObjectType> {
    auth::MutationRoot.start_document_review(ctx, input).await
  }

  async fn decide_document_review(
    &self,
    ctx: &Context<'_>,
    input: auth::DecideDocumentReviewInput,
  ) -> Result<auth::DocumentReviewObjectType> {
    auth::MutationRoot.decide_document_review(ctx, input).await
  }

  async fn stop_document_review(
    &self,
    ctx: &Context<'_>,
    input: auth::DocumentReviewRunInput,
  ) -> Result<auth::DocumentReviewObjectType> {
    auth::MutationRoot.stop_document_review(ctx, input).await
  }

  async fn retry_document_review(
    &self,
    ctx: &Context<'_>,
    input: auth::DocumentReviewRunInput,
  ) -> Result<auth::DocumentReviewObjectType> {
    auth::MutationRoot.retry_document_review(ctx, input).await
  }

  async fn create_database_from_template(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseFromTemplateInput,
  ) -> Result<auth::DatabaseRecordObjectType> {
    auth::MutationRoot.create_database_from_template(ctx, input).await
  }

  async fn update_database(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateDatabaseInput,
  ) -> Result<auth::DatabaseRecordObjectType> {
    auth::MutationRoot.update_database(ctx, input).await
  }

  async fn trash_database(
    &self,
    ctx: &Context<'_>,
    input: auth::DatabaseLifecycleInput,
  ) -> Result<auth::DatabaseRecordObjectType> {
    auth::MutationRoot.trash_database(ctx, input).await
  }

  async fn restore_database(
    &self,
    ctx: &Context<'_>,
    input: auth::DatabaseLifecycleInput,
  ) -> Result<auth::DatabaseRecordObjectType> {
    auth::MutationRoot.restore_database(ctx, input).await
  }

  async fn delete_database_permanently(&self, ctx: &Context<'_>, input: auth::DatabaseLifecycleInput) -> Result<bool> {
    auth::MutationRoot.delete_database_permanently(ctx, input).await
  }

  async fn set_database_row_reminder(
    &self,
    ctx: &Context<'_>,
    input: auth::SetDatabaseRowReminderInput,
  ) -> Result<auth::DatabaseRowReminderObjectType> {
    auth::MutationRoot.set_database_row_reminder(ctx, input).await
  }

  async fn delete_database_row_reminder(
    &self,
    ctx: &Context<'_>,
    input: auth::DeleteDatabaseRowReminderInput,
  ) -> Result<bool> {
    auth::MutationRoot.delete_database_row_reminder(ctx, input).await
  }

  async fn create_workspace_automation(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateWorkspaceAutomationInput,
  ) -> Result<auth::WorkspaceAutomationObjectType> {
    auth::MutationRoot.create_workspace_automation(ctx, input).await
  }

  async fn configure_task_recurrence(
    &self,
    ctx: &Context<'_>,
    input: auth::ConfigureTaskRecurrenceInput,
  ) -> Result<auth::TaskRecurrenceObject> {
    auth::MutationRoot.configure_task_recurrence(ctx, input).await
  }

  async fn update_task_recurrence(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateTaskRecurrenceInput,
  ) -> Result<auth::TaskRecurrenceObject> {
    auth::MutationRoot.update_task_recurrence(ctx, input).await
  }

  async fn skip_task_recurrence(
    &self,
    ctx: &Context<'_>,
    input: auth::SkipTaskRecurrenceInput,
  ) -> Result<auth::TaskRecurrenceObject> {
    auth::MutationRoot.skip_task_recurrence(ctx, input).await
  }

  async fn pause_task_recurrence(
    &self,
    ctx: &Context<'_>,
    input: auth::TaskRecurrenceControlInput,
  ) -> Result<auth::TaskRecurrenceObject> {
    auth::MutationRoot.pause_task_recurrence(ctx, input).await
  }

  async fn resume_task_recurrence(
    &self,
    ctx: &Context<'_>,
    input: auth::TaskRecurrenceControlInput,
  ) -> Result<auth::TaskRecurrenceObject> {
    auth::MutationRoot.resume_task_recurrence(ctx, input).await
  }

  async fn end_task_recurrence(
    &self,
    ctx: &Context<'_>,
    input: auth::TaskRecurrenceControlInput,
  ) -> Result<auth::TaskRecurrenceObject> {
    auth::MutationRoot.end_task_recurrence(ctx, input).await
  }

  async fn disable_workspace_automation(
    &self,
    ctx: &Context<'_>,
    input: auth::DisableWorkspaceAutomationInput,
  ) -> Result<auth::WorkspaceAutomationObjectType> {
    auth::MutationRoot.disable_workspace_automation(ctx, input).await
  }

  async fn create_database_field(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseFieldInput,
  ) -> Result<auth::DatabaseFieldObjectType> {
    auth::MutationRoot.create_database_field(ctx, input).await
  }

  async fn update_database_field(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateDatabaseFieldInput,
  ) -> Result<auth::DatabaseFieldObjectType> {
    auth::MutationRoot.update_database_field(ctx, input).await
  }

  async fn delete_database_field(&self, ctx: &Context<'_>, input: auth::DeleteDatabaseFieldInput) -> Result<bool> {
    auth::MutationRoot.delete_database_field(ctx, input).await
  }

  async fn reorder_database_fields(
    &self,
    ctx: &Context<'_>,
    input: auth::ReorderDatabaseFieldsInput,
  ) -> Result<Vec<auth::DatabaseFieldObjectType>> {
    auth::MutationRoot.reorder_database_fields(ctx, input).await
  }

  async fn create_database_view(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseViewInput,
  ) -> Result<auth::DatabaseViewObjectType> {
    auth::MutationRoot.create_database_view(ctx, input).await
  }

  async fn update_database_view(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateDatabaseViewInput,
  ) -> Result<auth::DatabaseViewObjectType> {
    auth::MutationRoot.update_database_view(ctx, input).await
  }

  async fn upsert_database_view_user_state(
    &self,
    ctx: &Context<'_>,
    input: auth::UpsertDatabaseViewUserStateInput,
  ) -> Result<auth::DatabaseViewUserStateObjectType> {
    auth::MutationRoot.upsert_database_view_user_state(ctx, input).await
  }

  async fn reset_database_view_user_state(
    &self,
    ctx: &Context<'_>,
    input: auth::ResetDatabaseViewUserStateInput,
  ) -> Result<bool> {
    auth::MutationRoot.reset_database_view_user_state(ctx, input).await
  }

  async fn save_database_view_user_state(
    &self,
    ctx: &Context<'_>,
    input: auth::SaveDatabaseViewUserStateInput,
  ) -> Result<auth::DatabaseViewObjectType> {
    auth::MutationRoot.save_database_view_user_state(ctx, input).await
  }

  async fn delete_database_view(&self, ctx: &Context<'_>, input: auth::DeleteDatabaseViewInput) -> Result<bool> {
    auth::MutationRoot.delete_database_view(ctx, input).await
  }

  async fn reorder_database_views(
    &self,
    ctx: &Context<'_>,
    input: auth::ReorderDatabaseViewsInput,
  ) -> Result<Vec<auth::DatabaseViewObjectType>> {
    auth::MutationRoot.reorder_database_views(ctx, input).await
  }

  async fn create_database_task_from_source(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseTaskFromSourceInput,
  ) -> Result<auth::DatabaseTaskCaptureResultObjectType> {
    auth::MutationRoot.create_database_task_from_source(ctx, input).await
  }

  async fn move_database_tasks(
    &self,
    ctx: &Context<'_>,
    input: auth::DatabaseTaskMoveInput,
  ) -> Result<auth::DatabaseTaskMoveResultObjectType> {
    auth::MutationRoot.move_database_tasks(ctx, input).await
  }

  async fn create_database_row(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseRowInput,
  ) -> Result<auth::DatabaseRowRecordObjectType> {
    auth::MutationRoot.create_database_row(ctx, input).await
  }

  async fn create_database_row_template(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseRowTemplateInput,
  ) -> Result<auth::DatabaseRowTemplateBindingObjectType> {
    auth::MutationRoot.create_database_row_template(ctx, input).await
  }

  async fn update_database_row_template(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateDatabaseRowTemplateInput,
  ) -> Result<auth::DatabaseRowTemplateBindingObjectType> {
    auth::MutationRoot.update_database_row_template(ctx, input).await
  }

  async fn delete_database_row_template(
    &self,
    ctx: &Context<'_>,
    input: auth::DeleteDatabaseRowTemplateInput,
  ) -> Result<bool> {
    auth::MutationRoot.delete_database_row_template(ctx, input).await
  }

  async fn create_database_row_from_template(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseRowFromTemplateInput,
  ) -> Result<auth::DatabaseRowRecordObjectType> {
    auth::MutationRoot.create_database_row_from_template(ctx, input).await
  }

  async fn update_database_row_title(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateDatabaseRowTitleInput,
  ) -> Result<auth::DatabaseCellValueObjectType> {
    auth::MutationRoot.update_database_row_title(ctx, input).await
  }

  async fn update_database_row_position(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateDatabaseRowPositionInput,
  ) -> Result<auth::DatabaseRowRecordObjectType> {
    auth::MutationRoot.update_database_row_position(ctx, input).await
  }

  async fn update_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateDatabaseCellValueInput,
  ) -> Result<auth::DatabaseCellValueObjectType> {
    auth::MutationRoot.update_database_cell_value(ctx, input).await
  }

  async fn clear_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: auth::ClearDatabaseCellValueInput,
  ) -> Result<auth::DatabaseCellRevisionObjectType> {
    auth::MutationRoot.clear_database_cell_value(ctx, input).await
  }

  async fn delete_database_row(&self, ctx: &Context<'_>, input: auth::DeleteDatabaseRowInput) -> Result<bool> {
    auth::MutationRoot.delete_database_row(ctx, input).await
  }

  // P-DB-26: bulk operation mutations. Every bulk mutation returns a
  // `DatabaseBulkOperationResult` carrying per-row diagnostics so the
  // client can render a structured toast (e.g. "3 of 12 updated, 9
  // failed: cell invalid") without re-deriving counts. Each operation
  // is atomic on the server: a per-row validation failure or storage
  // error rolls back the entire batch.
  async fn bulk_set_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: auth::BulkSetDatabaseCellValueInput,
  ) -> Result<auth::DatabaseBulkOperationResultObjectType> {
    auth::MutationRoot.bulk_set_database_cell_value(ctx, input).await
  }

  async fn bulk_clear_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: auth::BulkClearDatabaseCellValueInput,
  ) -> Result<auth::DatabaseBulkOperationResultObjectType> {
    auth::MutationRoot.bulk_clear_database_cell_value(ctx, input).await
  }

  async fn bulk_apply_database_cell_patches(
    &self,
    ctx: &Context<'_>,
    input: auth::BulkApplyDatabaseCellPatchesInput,
  ) -> Result<auth::DatabaseBulkOperationResultObjectType> {
    auth::MutationRoot.bulk_apply_database_cell_patches(ctx, input).await
  }

  async fn bulk_delete_database_rows(
    &self,
    ctx: &Context<'_>,
    input: auth::BulkDeleteDatabaseRowsInput,
  ) -> Result<auth::DatabaseBulkOperationResultObjectType> {
    auth::MutationRoot.bulk_delete_database_rows(ctx, input).await
  }

  async fn bulk_restore_database_rows(
    &self,
    ctx: &Context<'_>,
    input: auth::BulkRestoreDatabaseRowsInput,
  ) -> Result<auth::DatabaseBulkOperationResultObjectType> {
    auth::MutationRoot.bulk_restore_database_rows(ctx, input).await
  }

  async fn bulk_update_database_row_positions(
    &self,
    ctx: &Context<'_>,
    input: auth::BulkUpdateDatabaseRowPositionsInput,
  ) -> Result<auth::DatabaseBulkOperationResultObjectType> {
    auth::MutationRoot.bulk_update_database_row_positions(ctx, input).await
  }

  async fn create_database_row_content_document(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateDatabaseRowContentDocumentInput,
  ) -> Result<auth::DatabaseRowRecordObjectType> {
    auth::MutationRoot
      .create_database_row_content_document(ctx, input)
      .await
  }

  async fn attach_database_row_content_document(
    &self,
    ctx: &Context<'_>,
    input: auth::AttachDatabaseRowContentDocumentInput,
  ) -> Result<auth::DatabaseRowRecordObjectType> {
    auth::MutationRoot
      .attach_database_row_content_document(ctx, input)
      .await
  }

  async fn detach_database_row_content_document(
    &self,
    ctx: &Context<'_>,
    input: auth::DetachDatabaseRowContentDocumentInput,
  ) -> Result<auth::DatabaseRowRecordObjectType> {
    auth::MutationRoot
      .detach_database_row_content_document(ctx, input)
      .await
  }

  async fn preview_database_csv_import(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: auth::PreviewDatabaseCsvImportInput,
  ) -> Result<auth::DatabaseCsvPreviewObjectType> {
    auth::MutationRoot.preview_database_csv_import(ctx, file, input).await
  }

  async fn import_database_csv(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: auth::ImportDatabaseCsvInput,
  ) -> Result<auth::DatabaseCsvImportResultObjectType> {
    auth::MutationRoot.import_database_csv(ctx, file, input).await
  }

  async fn preview_database_json_import(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: auth::PreviewDatabaseJsonImportInput,
  ) -> Result<auth::DatabaseJsonPreviewObjectType> {
    auth::MutationRoot.preview_database_json_import(ctx, file, input).await
  }

  async fn import_database_json(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: auth::ImportDatabaseJsonInput,
  ) -> Result<auth::DatabaseJsonImportResultObjectType> {
    auth::MutationRoot.import_database_json(ctx, file, input).await
  }

  /// P-DB-29: Notion HTML / ZIP preview. Same input shape as the JSON
  /// preview but the upload is interpreted as a Notion export. The
  /// preview returns a [`DatabaseJsonPreviewObjectType`] so the Web
  /// UI can render the result through the same modal as JSON imports.
  async fn preview_database_notion_import(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: auth::PreviewDatabaseJsonImportInput,
  ) -> Result<auth::DatabaseJsonPreviewObjectType> {
    auth::MutationRoot
      .preview_database_notion_import(ctx, file, input)
      .await
  }

  /// P-DB-29: Notion HTML / ZIP apply. Mirrors `importDatabaseJson`
  /// but interprets the upload as a Notion export.
  async fn import_database_notion(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: auth::ImportDatabaseJsonInput,
  ) -> Result<auth::DatabaseJsonImportResultObjectType> {
    auth::MutationRoot.import_database_notion(ctx, file, input).await
  }

  async fn export_database_csv(
    &self,
    ctx: &Context<'_>,
    input: auth::ExportDatabaseCsvInput,
  ) -> Result<auth::DatabaseCsvExportObjectType> {
    auth::MutationRoot.export_database_csv(ctx, input).await
  }

  /// P-DB-27: save (or update) a CSV mapping template.
  async fn save_database_csv_mapping_template(
    &self,
    ctx: &Context<'_>,
    input: auth::SaveDatabaseCsvMappingTemplateInput,
  ) -> Result<auth::DatabaseCsvMappingTemplateObjectType> {
    auth::MutationRoot.save_database_csv_mapping_template(ctx, input).await
  }

  /// P-DB-27: load a saved CSV mapping template by name.
  async fn load_database_csv_mapping_template(
    &self,
    ctx: &Context<'_>,
    input: auth::LoadDatabaseCsvMappingTemplateInput,
  ) -> Result<Option<auth::DatabaseCsvMappingTemplateObjectType>> {
    auth::MutationRoot.load_database_csv_mapping_template(ctx, input).await
  }

  /// P-DB-27: delete a saved CSV mapping template by name.
  async fn delete_database_csv_mapping_template(
    &self,
    ctx: &Context<'_>,
    input: auth::DeleteDatabaseCsvMappingTemplateInput,
  ) -> Result<bool> {
    auth::MutationRoot
      .delete_database_csv_mapping_template(ctx, input)
      .await
  }

  async fn export_database_json(
    &self,
    ctx: &Context<'_>,
    input: auth::ExportDatabaseJsonInput,
  ) -> Result<auth::DatabaseJsonExportObjectType> {
    auth::MutationRoot.export_database_json(ctx, input).await
  }

  /// Manager-scoped project creation. Routes through the policy gate;
  /// see `OrganizationManagerMutationRoot` for the three-state outcome.
  async fn create_organization_project(
    &self,
    ctx: &Context<'_>,
    input: organization::CreateOrganizationProjectInput,
  ) -> Result<organization::OrganizationProjectCreationResult> {
    organization::OrganizationManagerMutationRoot
      .create_organization_project(ctx, input)
      .await
  }

  /// Manager-scoped workspace creation inside a specific OU. Combines
  /// the workspace-creation flow with an `owner` link in the OU.
  async fn create_workspace_in_organization_unit(
    &self,
    ctx: &Context<'_>,
    input: organization::CreateWorkspaceInOrganizationUnitInput,
  ) -> Result<auth::WorkspaceType> {
    organization::OrganizationManagerMutationRoot
      .create_workspace_in_organization_unit(ctx, input)
      .await
  }

  /// Manager cancels their own pending project request.
  async fn cancel_organization_project_request(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    organization::OrganizationManagerMutationRoot
      .cancel_organization_project_request(ctx, id)
      .await
  }

  /// Manager-scoped: add (or update) an OU member's role. Anti-escalation
  /// rules apply (no `manager` role, no admin escalation).
  async fn add_organization_unit_member_as_manager(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    user_id: ID,
    role: organization::OrganizationUnitRoleEnum,
  ) -> Result<organization::OrganizationUnitMemberType> {
    organization::OrganizationManagerMutationRoot
      .add_organization_unit_member_as_manager(ctx, unit_id, user_id, role)
      .await
  }

  /// Manager-scoped: remove a non-manager OU member.
  async fn remove_organization_unit_member_as_manager(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    user_id: ID,
  ) -> Result<bool> {
    organization::OrganizationManagerMutationRoot
      .remove_organization_unit_member_as_manager(ctx, unit_id, user_id)
      .await
  }

  async fn update_workspace(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateWorkspaceInput,
  ) -> Result<auth::WorkspaceType> {
    auth::MutationRoot.update_workspace(ctx, input).await
  }

  async fn delete_workspace(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    auth::MutationRoot.delete_workspace(ctx, id).await
  }

  async fn delete_document_permanently(
    &self,
    ctx: &Context<'_>,
    input: auth::DeleteDocumentPermanentlyInput,
  ) -> Result<auth::DeleteDocumentsPermanentlyPayload> {
    auth::MutationRoot.delete_document_permanently(ctx, input).await
  }

  async fn delete_documents_permanently(
    &self,
    ctx: &Context<'_>,
    input: auth::DeleteDocumentsPermanentlyInput,
  ) -> Result<auth::DeleteDocumentsPermanentlyPayload> {
    auth::MutationRoot.delete_documents_permanently(ctx, input).await
  }

  async fn empty_workspace_trash(
    &self,
    ctx: &Context<'_>,
    input: auth::EmptyWorkspaceTrashInput,
  ) -> Result<auth::DeleteDocumentsPermanentlyPayload> {
    auth::MutationRoot.empty_workspace_trash(ctx, input).await
  }

  async fn link_calendar_account(&self, ctx: &Context<'_>, input: auth::LinkCalendarAccountInput) -> Result<String> {
    auth::MutationRoot.link_calendar_account(ctx, input).await
  }

  #[graphql(name = "linkCalDAVAccount")]
  async fn link_caldav_account(
    &self,
    ctx: &Context<'_>,
    input: auth::LinkCalDAVAccountInput,
  ) -> Result<auth::CalendarAccountObjectType> {
    auth::MutationRoot.link_caldav_account(ctx, input).await
  }

  async fn upsert_calendar_event(
    &self,
    ctx: &Context<'_>,
    input: auth::CalendarEventInput,
  ) -> Result<auth::CalendarEventType> {
    auth::MutationRoot.upsert_calendar_event(ctx, input).await
  }

  /// Delete a calendar event by ID (P90-CAL-E-08).
  async fn delete_calendar_event(&self, ctx: &Context<'_>, event_id: String) -> Result<bool> {
    auth::MutationRoot.delete_calendar_event(ctx, event_id).await
  }

  async fn update_calendar_reminder_status(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    reminder_id: String,
    delivered: bool,
  ) -> Result<auth::CalendarReminderStatusResult> {
    auth::MutationRoot
      .update_calendar_reminder_status(ctx, workspace_id, reminder_id, delivered)
      .await
  }

  async fn update_calendar_account(
    &self,
    ctx: &Context<'_>,
    account_id: Option<String>,
    refresh_interval_minutes: Option<i32>,
    input: Option<auth::UpdateCalendarAccountInput>,
  ) -> Result<Option<auth::CalendarAccountObjectType>> {
    auth::MutationRoot
      .update_calendar_account(ctx, account_id, refresh_interval_minutes, input)
      .await
  }

  async fn unlink_calendar_account(&self, ctx: &Context<'_>, account_id: String) -> Result<bool> {
    auth::MutationRoot.unlink_calendar_account(ctx, account_id).await
  }

  async fn update_workspace_calendars(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateWorkspaceCalendarsInput,
  ) -> Result<auth::WorkspaceCalendarObjectType> {
    auth::MutationRoot.update_workspace_calendars(ctx, input).await
  }

  /// Update a single calendar event instance (P90-CAL-I-05).
  async fn update_calendar_event_instance(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateCalendarEventInstanceInput,
  ) -> Result<auth::UpdateCalendarEventInstanceResult> {
    auth::MutationRoot.update_calendar_event_instance(ctx, input).await
  }

  /// Delete a calendar event instance (P90-CAL-I-05).
  async fn delete_calendar_event_instance(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    instance_start: chrono::DateTime<chrono::Utc>,
    scope: auth::InstanceEditScope,
  ) -> Result<bool> {
    auth::MutationRoot
      .delete_calendar_event_instance(ctx, event_id, instance_start, scope)
      .await
  }

  /// Resolve a calendar conflict (P90-CAL-F-04).
  async fn resolve_calendar_conflict(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    resolution: auth::ConflictResolution,
    base_version: Option<serde_json::Value>,
  ) -> Result<auth::CalendarEventType> {
    auth::MutationRoot
      .resolve_calendar_conflict(ctx, event_id, resolution, base_version)
      .await
  }

  /// Update the RSVP status of the current user for a calendar event
  /// (P90-CAL-H-04).
  async fn update_calendar_event_rsvp(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    status: auth::CalendarRsvpStatus,
  ) -> Result<auth::CalendarEventType> {
    auth::MutationRoot
      .update_calendar_event_rsvp(ctx, event_id, status)
      .await
  }

  // ── Native-event mutations (P-JCAL-SERVER-03-B) ──────────────────────────

  async fn control_workspace_event_recurrence(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    event_id: String,
    expected_revision: i64,
    action: auth::CalendarTimingAction,
  ) -> Result<auth::CalendarEventType> {
    auth::MutationRoot
      .control_workspace_event_recurrence(ctx, workspace_id, event_id, expected_revision, action)
      .await
  }

  /// Create a workspace-native calendar event (INV-CAL-NATIVE-03).
  async fn create_workspace_event(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateWorkspaceEventInput,
  ) -> Result<auth::CalendarEventType> {
    auth::MutationRoot.create_workspace_event(ctx, input).await
  }

  /// Update a workspace-native calendar event.
  ///
  /// `scope=All` edits the master; `scope=This` creates an EXDATE+override.
  /// Returns FORBIDDEN for external events (INV-CAL-NATIVE-02).
  async fn update_workspace_event(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    workspace_id: String,
    scope: auth::NativeEventScope,
    instance_start: Option<chrono::DateTime<chrono::Utc>>,
    input: auth::UpdateWorkspaceEventInput,
  ) -> Result<auth::CalendarEventType> {
    auth::MutationRoot
      .update_workspace_event(ctx, event_id, workspace_id, scope, instance_start, input)
      .await
  }

  /// Delete a workspace-native calendar event (INV-CAL-NATIVE-02).
  async fn delete_workspace_event(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    workspace_id: String,
    scope: auth::NativeEventScope,
    instance_start: Option<chrono::DateTime<chrono::Utc>>,
  ) -> Result<bool> {
    auth::MutationRoot
      .delete_workspace_event(ctx, event_id, workspace_id, scope, instance_start)
      .await
  }

  /// Create a workspace event tag (INV-CAL-TAG-01).
  async fn create_event_tag(
    &self,
    ctx: &Context<'_>,
    input: auth::CreateEventTagInput,
  ) -> Result<auth::CalendarEventTagType> {
    auth::MutationRoot.create_event_tag(ctx, input).await
  }

  /// Update a workspace event tag.
  async fn update_event_tag(
    &self,
    ctx: &Context<'_>,
    tag_id: String,
    input: auth::UpdateEventTagInput,
  ) -> Result<auth::CalendarEventTagType> {
    auth::MutationRoot.update_event_tag(ctx, tag_id, input).await
  }

  /// Delete a workspace event tag (events lose their tag via FK SET NULL).
  async fn delete_event_tag(&self, ctx: &Context<'_>, tag_id: String, workspace_id: String) -> Result<bool> {
    auth::MutationRoot.delete_event_tag(ctx, tag_id, workspace_id).await
  }

  /// Update workspace-level calendar settings (writeback target + default reminder).
  async fn update_workspace_calendar_settings(
    &self,
    ctx: &Context<'_>,
    input: auth::UpdateWorkspaceCalendarSettingsInput,
  ) -> Result<auth::WorkspaceCalendarSettingsType> {
    auth::MutationRoot.update_workspace_calendar_settings(ctx, input).await
  }

  /// Import events from an ICS blob into a workspace (P-JCAL-SERVER-07-B).
  async fn import_workspace_calendar_ics(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    ics_body: String,
  ) -> Result<auth::CalendarIcsImportResult> {
    auth::MutationRoot
      .import_workspace_calendar_ics(ctx, workspace_id, ics_body)
      .await
  }

  async fn invite_members(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    emails: Vec<String>,
  ) -> Result<Vec<auth::InviteResult>> {
    auth::MutationRoot.invite_members(ctx, workspace_id, emails).await
  }

  /// P100-SRV-F-02: Invite an existing server user by user ID.
  async fn invite_server_user_by_id(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    user_id: String,
    role: Option<String>,
  ) -> Result<String> {
    auth::MutationRoot
      .invite_server_user_by_id(ctx, workspace_id, user_id, role)
      .await
  }

  async fn accept_invite_by_id(&self, ctx: &Context<'_>, workspace_id: String, invite_id: String) -> Result<bool> {
    auth::MutationRoot
      .accept_invite_by_id(ctx, workspace_id, invite_id)
      .await
  }

  async fn create_invite_link(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    expire_time: auth::WorkspaceInviteLinkExpireTime,
  ) -> Result<auth::InviteLinkType> {
    auth::MutationRoot
      .create_invite_link(ctx, workspace_id, expire_time)
      .await
  }

  async fn create_workspace_invite_link(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    expire_time: f64,
  ) -> Result<auth::WorkspaceInviteLinkType> {
    auth::MutationRoot
      .create_workspace_invite_link(ctx, workspace_id, expire_time)
      .await
  }

  async fn revoke_invite_link(&self, ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    auth::MutationRoot.revoke_workspace_invite_link(ctx, workspace_id).await
  }

  async fn revoke_workspace_invite_link(&self, ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    auth::MutationRoot.revoke_workspace_invite_link(ctx, workspace_id).await
  }

  async fn accept_workspace_invite(&self, ctx: &Context<'_>, workspace_id: String, invite_id: String) -> Result<bool> {
    auth::MutationRoot
      .accept_workspace_invite(ctx, workspace_id, invite_id)
      .await
  }

  async fn revoke_member(&self, ctx: &Context<'_>, workspace_id: String, user_id: String) -> Result<bool> {
    auth::MutationRoot.revoke_member(ctx, workspace_id, user_id).await
  }

  async fn leave_workspace(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    send_leave_mail: Option<bool>,
    workspace_name: Option<String>,
  ) -> Result<bool> {
    auth::MutationRoot
      .leave_workspace(ctx, workspace_id, send_leave_mail, workspace_name)
      .await
  }

  async fn grant_member(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    user_id: String,
    permission: auth::WorkspaceRole,
  ) -> Result<bool> {
    auth::MutationRoot
      .grant_member(ctx, workspace_id, user_id, permission)
      .await
  }

  async fn approve_member(&self, ctx: &Context<'_>, workspace_id: String, user_id: String) -> Result<bool> {
    auth::MutationRoot.approve_member(ctx, workspace_id, user_id).await
  }

  async fn create_copilot_session(&self, ctx: &Context<'_>, options: auth::CreateChatSessionInput) -> Result<String> {
    auth::MutationRoot.create_copilot_session(ctx, options).await
  }

  async fn create_copilot_session_with_history(
    &self,
    ctx: &Context<'_>,
    options: auth::CreateChatSessionInput,
  ) -> Result<auth::CopilotHistoriesType> {
    auth::MutationRoot
      .create_copilot_session_with_history(ctx, options)
      .await
  }

  async fn update_copilot_session(&self, ctx: &Context<'_>, options: auth::UpdateChatSessionInput) -> Result<String> {
    auth::MutationRoot.update_copilot_session(ctx, options).await
  }

  async fn cleanup_copilot_session(&self, ctx: &Context<'_>, options: auth::DeleteSessionInput) -> Result<Vec<String>> {
    auth::MutationRoot.cleanup_copilot_session(ctx, options).await
  }

  async fn export_copilot_message(
    &self,
    ctx: &Context<'_>,
    message_id: ID,
    format: auth::CopilotExportFormat,
  ) -> Result<auth::CopilotGeneratedFileType> {
    auth::MutationRoot.export_copilot_message(ctx, message_id, format).await
  }

  async fn create_copilot_message(&self, ctx: &Context<'_>, options: auth::CreateChatMessageInput) -> Result<String> {
    auth::MutationRoot.create_copilot_message(ctx, options).await
  }

  #[allow(clippy::too_many_arguments)]
  async fn create_comment(
    &self,
    ctx: &Context<'_>,
    input: Option<auth::CommentCreateInput>,
    workspace_id: Option<String>,
    doc_id: Option<String>,
    parent_comment_id: Option<String>,
    body: Option<serde_json::Value>,
    attachment_keys: Option<Vec<String>>,
    selection_anchor: Option<auth::SelectionAnchorInput>,
    doc_text: Option<String>,
  ) -> Result<auth::CommentObjectType> {
    auth::MutationRoot
      .create_comment(
        ctx,
        input,
        workspace_id,
        doc_id,
        parent_comment_id,
        body,
        attachment_keys,
        selection_anchor,
        doc_text,
      )
      .await
  }

  async fn update_comment(
    &self,
    ctx: &Context<'_>,
    input: Option<auth::CommentUpdateInput>,
    comment_id: Option<String>,
    body: Option<serde_json::Value>,
  ) -> Result<bool> {
    auth::MutationRoot.update_comment(ctx, input, comment_id, body).await
  }

  async fn resolve_comment(
    &self,
    ctx: &Context<'_>,
    input: Option<auth::CommentResolveInput>,
    comment_id: Option<String>,
  ) -> Result<bool> {
    auth::MutationRoot.resolve_comment(ctx, input, comment_id).await
  }

  async fn reopen_comment(&self, ctx: &Context<'_>, comment_id: String) -> Result<auth::CommentType> {
    auth::MutationRoot.reopen_comment(ctx, comment_id).await
  }

  async fn delete_comment(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    auth::MutationRoot.delete_comment(ctx, id).await
  }

  async fn create_reply(&self, ctx: &Context<'_>, input: auth::ReplyCreateInput) -> Result<auth::ReplyObjectType> {
    auth::MutationRoot.create_reply(ctx, input).await
  }

  async fn update_reply(&self, ctx: &Context<'_>, input: auth::ReplyUpdateInput) -> Result<bool> {
    auth::MutationRoot.update_reply(ctx, input).await
  }

  async fn delete_reply(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    auth::MutationRoot.delete_reply(ctx, id).await
  }

  async fn mention_user(&self, ctx: &Context<'_>, input: auth::MentionInput) -> Result<ID> {
    auth::MutationRoot.mention_user(ctx, input).await
  }

  async fn mark_comment_thread_read(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    comment_id: String,
  ) -> Result<bool> {
    auth::MutationRoot
      .mark_comment_thread_read(ctx, workspace_id, doc_id, comment_id)
      .await
  }

  async fn mark_all_comment_threads_read(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
  ) -> Result<i32> {
    auth::MutationRoot
      .mark_all_comment_threads_read(ctx, workspace_id, doc_id)
      .await
  }

  async fn read_notification(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    auth::MutationRoot.read_notification(ctx, id).await
  }

  async fn read_all_notifications(&self, ctx: &Context<'_>) -> Result<bool> {
    auth::MutationRoot.read_all_notifications(ctx).await
  }

  async fn create_blob_upload(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    key: String,
    size: i32,
    mime: String,
  ) -> Result<auth::BlobUploadInitType> {
    auth::MutationRoot
      .create_blob_upload(ctx, workspace_id, key, size, mime)
      .await
  }

  async fn set_blob(&self, ctx: &Context<'_>, workspace_id: String, blob: Upload) -> Result<String> {
    auth::MutationRoot.set_blob(ctx, workspace_id, blob).await
  }

  /// Adopt a copilot-generated blob into the workspace blob store (root-level alias).
  async fn adopt_copilot_blob(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    copilot_blob_key: String,
  ) -> Result<String> {
    auth::MutationRoot
      .adopt_copilot_blob(ctx, workspace_id, copilot_blob_key)
      .await
  }

  async fn complete_blob_upload(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    key: String,
    upload_id: Option<String>,
    parts: Option<Vec<auth::BlobUploadPartInputType>>,
  ) -> Result<String> {
    auth::MutationRoot
      .complete_blob_upload(ctx, workspace_id, key, upload_id, parts)
      .await
  }

  async fn abort_blob_upload(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    key: String,
    upload_id: String,
  ) -> Result<bool> {
    auth::MutationRoot
      .abort_blob_upload(ctx, workspace_id, key, upload_id)
      .await
  }

  async fn delete_blob(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    hash: Option<String>,
    key: Option<String>,
    permanently: Option<bool>,
  ) -> Result<bool> {
    auth::MutationRoot
      .delete_blob(ctx, workspace_id, hash, key, permanently)
      .await
  }

  async fn release_deleted_blobs(&self, ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    auth::MutationRoot.release_deleted_blobs(ctx, workspace_id).await
  }

  async fn upload_comment_attachment(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    attachment: Upload,
  ) -> Result<String> {
    auth::MutationRoot
      .upload_comment_attachment(ctx, workspace_id, doc_id, attachment)
      .await
  }

  // Billing/payment compatibility surface. No product restrictions are enforced.
  async fn cancel_subscription(
    &self,
    ctx: &Context<'_>,
    plan: Option<SubscriptionPlanType>,
    workspace_id: Option<String>,
    idempotency_key: Option<String>,
  ) -> Result<SubscriptionType> {
    let _ = (workspace_id, idempotency_key);
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let billing = &state.config.compat.billing;
    let effective_plan = plan.unwrap_or_else(|| subscription_plan_from_config(&billing.plan));
    Ok(neutral_subscription(
      billing.subscription.id.clone(),
      effective_plan,
      subscription_recurring_from_config(&billing.recurring),
      subscription_status_from_config(&billing.subscription.cancel_status),
      subscription_variant_from_config(&billing.subscription.variant),
    ))
  }

  async fn resume_subscription(
    &self,
    ctx: &Context<'_>,
    plan: Option<SubscriptionPlanType>,
    workspace_id: Option<String>,
    idempotency_key: Option<String>,
  ) -> Result<SubscriptionType> {
    let _ = (workspace_id, idempotency_key);
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let billing = &state.config.compat.billing;
    let effective_plan = plan.unwrap_or_else(|| subscription_plan_from_config(&billing.plan));
    Ok(neutral_subscription(
      billing.subscription.id.clone(),
      effective_plan,
      subscription_recurring_from_config(&billing.recurring),
      subscription_status_from_config(&billing.subscription.default_status),
      subscription_variant_from_config(&billing.subscription.variant),
    ))
  }

  async fn update_subscription_recurring(
    &self,
    ctx: &Context<'_>,
    recurring: SubscriptionRecurringType,
    plan: Option<SubscriptionPlanType>,
    workspace_id: Option<String>,
    idempotency_key: Option<String>,
  ) -> Result<SubscriptionType> {
    let _ = (workspace_id, idempotency_key);
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let billing = &state.config.compat.billing;
    let effective_plan = plan.unwrap_or_else(|| subscription_plan_from_config(&billing.plan));
    Ok(neutral_subscription(
      billing.subscription.id.clone(),
      effective_plan,
      recurring,
      subscription_status_from_config(&billing.subscription.default_status),
      subscription_variant_from_config(&billing.subscription.variant),
    ))
  }

  async fn refresh_user_subscriptions(&self) -> Result<Vec<SubscriptionType>> {
    Ok(Vec::new())
  }

  async fn request_apply_subscription(&self, _transaction_id: String) -> Result<Vec<SubscriptionType>> {
    Ok(Vec::new())
  }

  async fn create_checkout_session(&self, ctx: &Context<'_>, input: CreateCheckoutSessionInput) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let mut url = input.success_callback_link;
    if url.trim().is_empty() {
      url = join_origin_url(
        &state.config.server.origin,
        &state.config.compat.billing.portal.checkout_path,
      );
    }
    Ok(url)
  }

  async fn create_customer_portal(&self, ctx: &Context<'_>) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    Ok(join_origin_url(
      &state.config.server.origin,
      &state.config.compat.billing.portal.customer_portal_path,
    ))
  }

  async fn create_selfhost_workspace_customer_portal(&self, ctx: &Context<'_>, workspace_id: String) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let base = join_origin_url(
      &state.config.server.origin,
      &state.config.compat.billing.portal.customer_portal_path,
    );
    Ok(format!("{base}?workspaceId={workspace_id}"))
  }

  async fn generate_license_key(&self, _ctx: &Context<'_>, session_id: String) -> Result<String> {
    Ok(format!("neutral-{session_id}"))
  }

  async fn activate_license(&self, ctx: &Context<'_>, workspace_id: String, license: String) -> Result<LicenseType> {
    let _ = (workspace_id, license);
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let billing = &state.config.compat.billing;
    let now = Utc::now();
    Ok(LicenseType {
      expired_at: None,
      installed_at: now,
      quantity: billing.license.quantity,
      recurring: subscription_recurring_from_config(&billing.license.recurring),
      validated_at: now,
      variant: subscription_variant_from_config(&billing.license.variant),
    })
  }

  async fn deactivate_license(&self, _ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    let _ = workspace_id;
    Ok(true)
  }

  async fn install_license(&self, ctx: &Context<'_>, workspace_id: String, license: Upload) -> Result<LicenseType> {
    let _ = (workspace_id, license);
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let billing = &state.config.compat.billing;
    let now = Utc::now();
    Ok(LicenseType {
      expired_at: None,
      installed_at: now,
      quantity: billing.license.quantity,
      recurring: subscription_recurring_from_config(&billing.license.recurring),
      validated_at: now,
      variant: subscription_variant_from_config(&billing.license.variant),
    })
  }

  // Configuration writes live only at admin { adminUpdateConfig }.

  async fn apply_doc_updates(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    op: String,
    updates: String,
  ) -> Result<String> {
    apply_doc_updates_impl(ctx, workspace_id, doc_id, op, updates).await
  }

  async fn create_copilot_context(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    session_id: String,
  ) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::Copilot,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let lock_key = format!("copilot:context:{session_id}");
    let acquired = state
      .distributed_lock()
      .acquire(&lock_key, 15)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;
    if !acquired {
      return Err(async_graphql::Error::new("Server is busy"));
    }

    let result = async {
      let session_context_name = format!("session-{session_id}");
      let session_uuid =
        uuid::Uuid::parse_str(&session_id).map_err(|_| async_graphql::Error::new("invalid session id"))?;
      let session = state
        .copilot()
        .get_session(session_uuid)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
      if session.user_id != snapshot.user.id || session.workspace_id != Some(workspace_uuid) {
        return Err(async_graphql::Error::new("copilot session not found"));
      }
      auth::assert_copilot_session_access(state, snapshot.user.id, &session, "create_copilot_context").await?;
      if let Some(existing) = state
        .copilot()
        .find_context(snapshot.user.id, workspace_uuid, &session_context_name)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?
      {
        return Ok(existing.id.to_string());
      }

      let metadata = json!({ "sessionId": session_id, "name": "session-context" });
      let context = state
        .copilot()
        .create_context(snapshot.user.id, Some(workspace_uuid), session_context_name, metadata)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
      Ok(context.id.to_string())
    }
    .await;

    let _ = state.distributed_lock().release(&lock_key).await;
    result
  }

  async fn add_context_doc(&self, ctx: &Context<'_>, options: AddContextDocInput) -> Result<CopilotContextDocType> {
    let created_at = add_copilot_context_item(ctx, &options.context_id, "doc", &options.doc_id, json!({})).await?;
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let context_id =
      uuid::Uuid::parse_str(&options.context_id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
    let context = ensure_context_owned(&state, snapshot.user.id, context_id, None, true)
      .await?
      .ok_or("context not found")?;
    let status = copilot_doc_context_status(&state, snapshot.user.id, context.workspace_id, &options.doc_id).await;
    Ok(CopilotContextDocType {
      id: options.doc_id,
      created_at,
      status: Some(status),
    })
  }

  async fn add_context_blob(&self, ctx: &Context<'_>, options: AddContextBlobInput) -> Result<CopilotContextBlobType> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let context_id =
      uuid::Uuid::parse_str(&options.context_id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
    let item = state
      .context_ingestion()
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .attach(snapshot.user.id, context_id, &options.blob_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(CopilotContextBlobType {
      id: options.blob_id,
      created_at: item.created_at.timestamp_millis(),
      status: Some(context_ingestion_status(&item)),
    })
  }

  async fn add_context_category(
    &self,
    ctx: &Context<'_>,
    options: AddContextCategoryInput,
  ) -> Result<CopilotContextCategoryType> {
    let created_at = add_copilot_context_item(
      ctx,
      &options.context_id,
      "category",
      &options.category_id,
      json!({
        "type": options.category_type,
        "docs": options.docs.unwrap_or_default(),
      }),
    )
    .await?;
    Ok(CopilotContextCategoryType {
      id: options.category_id,
      created_at,
      category_type: options.category_type,
      docs: vec![],
    })
  }

  async fn add_context_file(
    &self,
    ctx: &Context<'_>,
    options: AddContextFileInput,
    content: Upload,
  ) -> Result<CopilotContextFileType> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let context_id =
      uuid::Uuid::parse_str(&options.context_id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
    let ingestion = state
      .context_ingestion()
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    ingestion
      .authorize(context_id, Some(snapshot.user.id), true)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let upload = content
      .value(ctx)
      .map_err(|_| async_graphql::Error::new("invalid context upload"))?;
    let item = ingestion
      .upload(
        snapshot.user.id,
        context_id,
        upload.filename,
        upload.content_type,
        upload.content,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(project_copilot_context_file(&item))
  }

  async fn retry_context_file(
    &self,
    ctx: &Context<'_>,
    options: RemoveContextFileInput,
  ) -> Result<CopilotContextFileType> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let context_id =
      uuid::Uuid::parse_str(&options.context_id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
    let item = state
      .context_ingestion()
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .retry(snapshot.user.id, context_id, &options.file_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(project_copilot_context_file(&item))
  }

  async fn remove_context_doc(&self, ctx: &Context<'_>, options: RemoveContextDocInput) -> Result<bool> {
    remove_copilot_context_item(ctx, &options.context_id, "doc", &options.doc_id).await
  }

  async fn remove_context_blob(&self, ctx: &Context<'_>, options: RemoveContextBlobInput) -> Result<bool> {
    remove_copilot_context_item(ctx, &options.context_id, "blob", &options.blob_id).await
  }

  async fn remove_context_category(&self, ctx: &Context<'_>, options: RemoveContextCategoryInput) -> Result<bool> {
    remove_copilot_context_item(ctx, &options.context_id, "category", &options.category_id).await
  }

  async fn remove_context_file(&self, ctx: &Context<'_>, options: RemoveContextFileInput) -> Result<bool> {
    remove_copilot_context_item(ctx, &options.context_id, "file", &options.file_id).await
  }

  async fn update_workspace_embedding_ignored_docs(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
  ) -> Result<i32> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    let mut set: std::collections::BTreeSet<String> = state
      .copilot()
      .get_workspace_state(workspace_uuid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .map(|state| state.ignored_doc_ids.into_iter().map(|id| id.to_string()).collect())
      .unwrap_or_default();
    for doc_id in add.unwrap_or_default() {
      set.insert(doc_id);
    }
    for doc_id in remove.unwrap_or_default() {
      set.remove(&doc_id);
    }
    persist_workspace_ignored_docs(state, workspace_uuid, &set).await?;
    Ok(set.len() as i32)
  }

  async fn queue_workspace_embedding(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: Vec<String>,
  ) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::Copilot,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let explicit = !doc_id.is_empty();
    let mut ids = Vec::new();
    if explicit {
      for reference in doc_id {
        let id = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, &reference).await?;
        auth::assert_copilot_doc_access(state, snapshot.user.id, workspace_uuid, id).await?;
        if !ids.contains(&id) {
          ids.push(id);
        }
      }
    } else {
      ids = state
        .doc()
        .list_content_docs_in_workspace(workspace_uuid, i64::MAX)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?
        .into_iter()
        .filter(myoxus_application::copilot::embedding::is_embedding_document)
        .map(|doc| doc.id)
        .collect();
      let readable = state
        .permission_service()
        .readable_doc_ids(snapshot.user.id, workspace_uuid, &ids)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
      ids.retain(|id| readable.contains(id));
    }
    let indexer = state
      .embedding_indexer()
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    for id in ids {
      indexer
        .queue_source(
          workspace_uuid,
          Some(snapshot.user.id),
          myoxus_domain::entities::CopilotEmbeddingSourceType::Doc,
          id.to_string(),
        )
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
    }
    Ok(true)
  }

  async fn trigger_cleanup_trashed_doc_embeddings(&self, ctx: &Context<'_>) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    ensure_admin(ctx, state).await?;
    create_copilot_system_job(state, "cleanup_trashed_doc_embeddings", json!({})).await?;
    Ok(true)
  }

  async fn trigger_generate_title_cron(&self, ctx: &Context<'_>) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    ensure_admin(ctx, state).await?;
    create_copilot_system_job(state, "generate_title_cron", json!({})).await?;
    Ok(true)
  }

  async fn submit_audio_transcription(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    blob_id: String,
    blob: Option<Upload>,
    blobs: Option<Vec<Upload>>,
  ) -> Result<TranscriptionResultType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    if blob.is_some() && blobs.is_some() {
      return Err(async_graphql::Error::new("use one audio upload input"));
    }
    if blobs.as_ref().is_some_and(Vec::is_empty) {
      return Err(async_graphql::Error::new("audio upload list is empty"));
    }
    let mut uploads = Vec::new();
    for upload in blob.into_iter().chain(blobs.into_iter().flatten()) {
      let upload = upload
        .value(ctx)
        .map_err(|_| async_graphql::Error::new("invalid audio upload"))?;
      uploads.push(myoxus_application::transcription::pipeline::TranscriptionUpload {
        filename: upload.filename,
        file: upload.content,
      });
    }
    let service = state
      .transcription_service()
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    let job = state
      .transcription_pipeline()
      .map_err(crate::graphql::utils::map_gql_error)?
      .submit(
        snapshot.user.id,
        workspace_uuid,
        &blob_id,
        uploads,
        service,
        state.transcription_job_policy(),
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    fetch_transcription_job_for_owner(state, job.id, snapshot.user.id, Some(workspace_uuid)).await
  }

  async fn retry_audio_transcription(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    job_id: String,
  ) -> Result<TranscriptionResultType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let job_uuid = uuid::Uuid::parse_str(&job_id).map_err(|_| async_graphql::Error::new("invalid job id"))?;
    let service = state
      .transcription_service()
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    state
      .transcription_pipeline()
      .map_err(crate::graphql::utils::map_gql_error)?
      .retry(
        snapshot.user.id,
        workspace_uuid,
        job_uuid,
        service,
        state.transcription_job_policy(),
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    fetch_transcription_job_for_owner(state, job_uuid, snapshot.user.id, Some(workspace_uuid)).await
  }

  /// Explicit, independently gated generation; never submits or retries speech.
  async fn enrich_audio_transcription(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    job_id: String,
    summary: bool,
    actions: bool,
  ) -> Result<transcription::TranscriptionEnrichmentType> {
    transcription::generate_enrichment(ctx, workspace_id, job_id, summary, actions).await
  }

  async fn claim_audio_transcription(&self, ctx: &Context<'_>, job_id: String) -> Result<TranscriptionResultType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let job_uuid = uuid::Uuid::parse_str(&job_id).map_err(|_| async_graphql::Error::new("invalid job id"))?;
    fetch_transcription_job_for_owner(state, job_uuid, snapshot.user.id, None).await
  }

  async fn add_workspace_embedding_files(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    blob: Upload,
  ) -> Result<CopilotWorkspaceFileType> {
    let upload = blob
      .value(ctx)
      .map_err(|e| async_graphql::Error::new(format!("invalid upload: {e}")))?;
    let file_id = uuid::Uuid::new_v4().to_string();
    let item = CopilotWorkspaceFileType {
      id: file_id.clone(),
      blob_id: file_id,
      name: upload.filename,
      mime_type: upload
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string()),
      created_at: Utc::now(),
      size: 0,
      workspace_id: workspace_id.clone(),
    };
    persist_workspace_file(ctx, workspace_id, item.clone(), true).await?;
    Ok(item)
  }

  async fn remove_workspace_embedding_files(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    file_id: String,
  ) -> Result<bool> {
    persist_workspace_file_removal(ctx, workspace_id, &file_id).await
  }

  async fn grant_doc_user_roles(&self, ctx: &Context<'_>, input: GrantDocUserRolesInput) -> Result<bool> {
    let external_doc_id = required_external_doc_id(input.external_doc_id, input.doc_id)?;
    update_doc_roles(
      ctx,
      input.workspace_id,
      external_doc_id,
      input.user_ids,
      Some(input.role),
      false,
    )
    .await
  }

  async fn revoke_doc_user_roles(&self, ctx: &Context<'_>, input: RevokeDocUserRoleInput) -> Result<bool> {
    let external_doc_id = required_external_doc_id(input.external_doc_id, input.doc_id)?;
    update_doc_roles(ctx, input.workspace_id, external_doc_id, input.user_ids, None, true).await
  }

  async fn update_doc_user_role(&self, ctx: &Context<'_>, input: UpdateDocUserRoleInput) -> Result<bool> {
    let external_doc_id = required_external_doc_id(input.external_doc_id, input.doc_id)?;
    update_doc_roles(
      ctx,
      input.workspace_id,
      external_doc_id,
      vec![input.user_id],
      Some(input.role),
      false,
    )
    .await
  }

  async fn update_doc_default_role(&self, ctx: &Context<'_>, input: UpdateDocDefaultRoleInput) -> Result<bool> {
    let external_doc_id = required_external_doc_id(input.external_doc_id, input.doc_id)?;
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&input.workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, &external_doc_id).await?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::DocResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
          doc_id: doc_uuid,
        },
        myoxus_domain::permission::DocAction::UsersManage,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    state
      .doc()
      .update_default_role(
        workspace_uuid,
        doc_uuid,
        match input.role {
          DocRoleType::Editor | DocRoleType::Manager | DocRoleType::Owner => {
            myoxus_domain::entities::DocDefaultRole::Editor
          }
          _ => myoxus_domain::entities::DocDefaultRole::Viewer,
        },
        snapshot.user.id,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .ok_or_else(|| async_graphql::Error::new("document not found"))?;
    Ok(true)
  }

  async fn publish_doc(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    mode: Option<PublicDocModeType>,
  ) -> Result<DocCompatType> {
    update_public_doc_mode(ctx, workspace_id, doc_id, mode.unwrap_or(PublicDocModeType::Page), true).await
  }

  async fn revoke_public_doc(&self, ctx: &Context<'_>, workspace_id: String, doc_id: String) -> Result<DocCompatType> {
    update_public_doc_mode(ctx, workspace_id, doc_id, PublicDocModeType::Page, false).await
  }

  async fn recover_doc(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    guid: String,
    timestamp: Option<DateTime<Utc>>,
    snapshot_id: Option<ID>,
    expected_revision: Option<String>,
  ) -> Result<DateTime<Utc>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, &guid).await?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::DocResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
          doc_id: doc_uuid,
        },
        myoxus_domain::permission::DocAction::Restore,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let history = match (snapshot_id, timestamp) {
      (Some(id), None) => {
        let id = id
          .as_str()
          .parse::<i64>()
          .ok()
          .filter(|id| *id > 0)
          .ok_or_else(|| async_graphql::Error::new("invalid snapshot id"))?;
        state.doc().history_entry(id).await
      }
      (None, Some(timestamp)) => {
        state
          .doc()
          .history_at_or_before(workspace_uuid, doc_uuid, timestamp)
          .await
      }
      _ => return Err(async_graphql::Error::new("provide either snapshotId or timestamp")),
    };
    let Some(history) = history.map_err(crate::graphql::utils::map_gql_error)? else {
      return Err(async_graphql::Error::new("history not found"));
    };
    if history.doc_id != doc_uuid || history.workspace_id != workspace_uuid {
      return Err(async_graphql::Error::new("history not found"));
    }
    state
      .doc()
      .history
      .restore(myoxus_application::doc::history::HistoryRestoreRequest {
        workspace_id: workspace_uuid,
        doc_id: doc_uuid,
        history_id: history.id,
        expected_sequence: document_version::parse_history_revision(expected_revision)?,
        actor: crate::graphql::admin::resolve_audit_actor(ctx).await,
        named: None,
      })
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    Ok(Utc::now())
  }

  async fn fork_copilot_session(&self, ctx: &Context<'_>, options: ForkChatSessionInput) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let source_session =
      uuid::Uuid::parse_str(&options.session_id).map_err(|_| async_graphql::Error::new("invalid session id"))?;
    let source = state
      .copilot()
      .get_session(source_session)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    auth::assert_copilot_session_access(state, snapshot.user.id, &source, "fork_copilot_session").await?;
    let workspace_id = source
      .workspace_id
      .ok_or_else(|| crate::graphql::utils::map_gql_error(myoxus_application::auth::AuthError::ActionForbidden))?;
    let requested_workspace =
      uuid::Uuid::parse_str(&options.workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    if requested_workspace != workspace_id {
      return Err(crate::graphql::utils::map_gql_error(
        myoxus_application::auth::AuthError::ActionForbidden,
      ));
    }
    let doc_id = crate::graphql::utils::resolve_doc_id(state, workspace_id, &options.doc_id).await?;
    auth::assert_copilot_doc_access(state, snapshot.user.id, workspace_id, doc_id).await?;
    let latest_message_id = options
      .latest_message_id
      .as_deref()
      .filter(|id| !id.trim().is_empty())
      .map(uuid::Uuid::parse_str)
      .transpose()
      .map_err(|_| async_graphql::Error::new("invalid latest message id"))?;
    let can_read_attachments = state
      .permission_service()
      .can(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::BlobsRead,
      )
      .await;
    let created = state
      .copilot()
      .fork_session(myoxus_application::copilot::ForkCopilotSession {
        user_id: snapshot.user.id,
        workspace_id,
        source_session_id: source_session,
        doc_id,
        latest_message_id,
        can_read_attachments,
      })
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(created.id.to_string())
  }

  // ─── P21: Git Sync mutations ─────────────────────────────────────────────────

  /// Create a Git Sync profile for a workspace.
  ///
  /// Requires workspace admin/owner permission. Existing profiles are changed
  /// only through the partial-update mutation so their identity and history
  /// cannot be replaced accidentally.
  #[graphql(name = "createGitSyncProfile")]
  async fn create_git_sync_profile(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    input: git_sync::GitSyncProfileInput,
  ) -> Result<git_sync::GitSyncProfileType> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let workspace_id =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    // Require admin permission on the workspace
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let policy = state
      .effective_git_sync_policy()
      .await
      .map_err(async_graphql::Error::new)?;
    let auth_method = git_sync::map_auth_method_to_domain(input.auth_method);
    let sync_direction = input
      .sync_direction
      .map(git_sync::map_sync_direction_to_domain)
      .unwrap_or(myoxus_domain::git_sync::SyncDirection::Bidirectional);
    let trigger_mode = input
      .trigger_mode
      .map(git_sync::map_trigger_mode_to_domain)
      .unwrap_or(myoxus_domain::git_sync::TriggerMode::Manual);
    let repo_url = normalize_required_input("repo_url", input.repo_url.as_str())?;
    let branch = match input.branch.as_deref() {
      Some(branch) => normalize_required_input("branch", branch)?,
      None => normalize_required_input("default_branch", policy.default_branch.as_str())?,
    };
    let root_path = normalize_root_path(input.root_path.as_deref().unwrap_or("content/"))?;
    let credential_plaintext = build_credential_payload(auth_method, &input)?;
    let credential_data =
      myoxus_infrastructure::crypto::encrypt(&state.config.crypto.private_key, &credential_plaintext)
        .map_err(|e| async_graphql::Error::new(format!("credential encryption failed: {e}")))?;
    let credential_json: serde_json::Value = serde_json::from_slice(&credential_plaintext)
      .map_err(|_| async_graphql::Error::new("invalid credential payload"))?;
    let remote_auth = crate::git_sync_engine::credential::build_auth(uuid::Uuid::nil(), auth_method, &credential_json)
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    let credential_expires_at = input.credential_expires_at;
    let service = git_sync_lifecycle_service(&state, pool, &policy, "graphql_profile_create", Some(snapshot.user.id));
    let created = service
      .create(
        &policy.lifecycle_policy(),
        CreateGitSyncProfile {
          workspace_id,
          owner_id: snapshot.user.id,
          repo_url,
          branch,
          root_path,
          sync_direction,
          trigger_mode,
          polling_interval_secs: input.polling_interval_secs,
          cron_expression: input.cron_expression,
          cron_timezone: input.cron_timezone,
          cron_misfire_policy: input
            .cron_misfire_policy
            .map(git_sync::map_cron_misfire_policy_to_domain),
          auth_method,
          enabled: true,
          max_mirror_storage_mb: input.max_mirror_storage_mb,
          credential: EncryptedGitCredential {
            label: "default".to_string(),
            ciphertext: credential_data,
            expires_at: credential_expires_at,
          },
          remote_auth,
        },
      )
      .await
      .map_err(map_git_sync_lifecycle_error)?;
    Ok(git_sync::map_profile_with_expiry(created, credential_expires_at))
  }

  /// Partially update a Git-Sync profile while preserving profile identity and
  /// history. A replacement credential is atomically rotated when present.
  #[graphql(name = "updateGitSyncProfile")]
  async fn update_git_sync_profile(
    &self,
    ctx: &Context<'_>,
    profile_id: String,
    input: git_sync::UpdateGitSyncProfileInput,
  ) -> Result<git_sync::GitSyncProfileType> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let profile_id = uuid::Uuid::parse_str(&profile_id).map_err(|_| async_graphql::Error::new("invalid profile id"))?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
    let current = store
      .get_profile(profile_id)
      .await
      .map_err(|_| async_graphql::Error::new("Git-Sync profile not found"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: current.workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    let policy = state
      .effective_git_sync_policy()
      .await
      .map_err(async_graphql::Error::new)?;
    let (auth_method, remote_auth, encrypted_credential) = if let Some(credential) = input.credential {
      let auth_method = git_sync::map_auth_method_to_domain(credential.auth_method);
      let plaintext = build_credential_payload_fields(
        auth_method,
        credential.token.as_deref(),
        credential.password.as_deref(),
        credential.username.as_deref(),
        credential.ssh_private_key.as_deref(),
        credential.ssh_passphrase.as_deref(),
      )?;
      let json: serde_json::Value =
        serde_json::from_slice(&plaintext).map_err(|_| async_graphql::Error::new("invalid credential payload"))?;
      let remote_auth = crate::git_sync_engine::credential::build_auth(profile_id, auth_method, &json)
        .map_err(|error| async_graphql::Error::new(error.to_string()))?;
      let encrypted = myoxus_infrastructure::crypto::encrypt(&state.config.crypto.private_key, &plaintext)
        .map_err(|_| async_graphql::Error::new("credential encryption failed"))?;
      (
        Some(auth_method),
        remote_auth,
        Some(EncryptedGitCredential {
          label: "default".to_string(),
          ciphertext: encrypted,
          expires_at: credential.expires_at,
        }),
      )
    } else {
      let credential_id = current
        .credential_id
        .ok_or_else(|| async_graphql::Error::new("Git-Sync profile has no credential"))?;
      let encrypted = store
        .get_credential_encrypted_data(credential_id)
        .await
        .map_err(|_| async_graphql::Error::new("Git-Sync credential not found"))?;
      let json = crate::git_sync_engine::credential::decrypt(&state.config.crypto.private_key, &encrypted)
        .map_err(|_| async_graphql::Error::new("Git-Sync credential could not be decoded"))?;
      let remote_auth = crate::git_sync_engine::credential::build_auth(profile_id, current.auth_method, &json)
        .map_err(|_| async_graphql::Error::new("Git-Sync credential is invalid"))?;
      (None, remote_auth, None)
    };

    let patch = GitSyncProfilePatch {
      repo_url: input
        .repo_url
        .as_deref()
        .map(|value| normalize_required_input("repo_url", value))
        .transpose()?,
      branch: input
        .branch
        .as_deref()
        .map(|value| normalize_required_input("branch", value))
        .transpose()?,
      root_path: input.root_path.as_deref().map(normalize_root_path).transpose()?,
      sync_direction: input.sync_direction.map(git_sync::map_sync_direction_to_domain),
      trigger_mode: input.trigger_mode.map(git_sync::map_trigger_mode_to_domain),
      polling_interval_secs: maybe_i64(input.polling_interval_secs),
      cron_expression: maybe_string(input.cron_expression),
      cron_timezone: maybe_string(input.cron_timezone),
      cron_misfire_policy: match input.cron_misfire_policy {
        async_graphql::MaybeUndefined::Undefined => None,
        async_graphql::MaybeUndefined::Null => Some(None),
        async_graphql::MaybeUndefined::Value(value) => Some(Some(git_sync::map_cron_misfire_policy_to_domain(value))),
      },
      auth_method,
      enabled: input.enabled,
      max_mirror_storage_mb: maybe_i64(input.max_mirror_storage_mb),
    };
    let service = git_sync_lifecycle_service(&state, pool, &policy, "graphql_profile_update", Some(snapshot.user.id));
    let updated = service
      .update(
        &policy.lifecycle_policy(),
        UpdateGitSyncProfile {
          profile_id,
          patch,
          credential: encrypted_credential,
          remote_auth,
        },
      )
      .await
      .map_err(map_git_sync_lifecycle_error)?;
    let expires_at = if let Some(credential_id) = updated.credential_id {
      store
        .get_credential(credential_id)
        .await
        .ok()
        .and_then(|credential| credential.expires_at)
    } else {
      None
    };
    Ok(git_sync::map_profile_with_expiry(updated, expires_at))
  }

  /// Delete a Git Sync profile.
  ///
  /// Cascades to all bindings, runs, conflicts, credentials, and baselines.
  /// Requires workspace admin/owner permission.
  #[graphql(name = "deleteGitSyncProfile")]
  async fn delete_git_sync_profile(&self, ctx: &Context<'_>, profile_id: String) -> Result<bool> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let profile_id = uuid::Uuid::parse_str(&profile_id).map_err(|_| async_graphql::Error::new("invalid profile id"))?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
    // Fetch profile to check workspace ownership
    let profile = store
      .get_profile(profile_id)
      .await
      .map_err(|e| async_graphql::Error::new(format!("profile not found: {e}")))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: profile.workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let service = GitSyncLifecycleService::new(
      Arc::new(myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool)),
      Arc::new(myoxus_infrastructure::git_sync::Git2Adapter::new()),
    );
    service.delete(profile_id).await.map_err(map_git_sync_lifecycle_error)?;
    tracing::info!(
      profile_id = %profile_id,
      user_id = %snapshot.user.id,
      workspace_id = %profile.workspace_id,
      action = "credential_deleted",
      auth_method = %profile.auth_method,
      "git-sync credentials deleted (profile removed)"
    );
    Ok(true)
  }

  /// Preview the exact cascade impact without modifying profile state.
  #[graphql(name = "gitSyncProfileDeleteImpact")]
  async fn git_sync_profile_delete_impact(
    &self,
    ctx: &Context<'_>,
    profile_id: String,
  ) -> Result<git_sync::GitSyncDeleteImpactType> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let profile_id = uuid::Uuid::parse_str(&profile_id).map_err(|_| async_graphql::Error::new("invalid profile id"))?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
    let profile = store
      .get_profile(profile_id)
      .await
      .map_err(|_| async_graphql::Error::new("Git-Sync profile not found"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: profile.workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let service = GitSyncLifecycleService::new(
      Arc::new(myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool)),
      Arc::new(myoxus_infrastructure::git_sync::Git2Adapter::new()),
    );
    service
      .delete_impact(profile_id)
      .await
      .map(git_sync::map_delete_impact)
      .map_err(map_git_sync_lifecycle_error)
  }

  /// Trigger a manual sync run.
  ///
  /// Creates a `Pending` run record and queues a worker job. Requires workspace
  /// admin/owner permission.
  #[graphql(name = "triggerGitSync")]
  async fn trigger_git_sync(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    direction: Option<git_sync::GitSyncDirectionType>,
  ) -> Result<git_sync::GitSyncRunType> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let workspace_id =
      uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
    let policy = state
      .effective_git_sync_policy()
      .await
      .map_err(async_graphql::Error::new)?;
    if !policy.enabled {
      return Err(async_graphql::Error::new(
        "Git Sync is disabled by administrator policy",
      ));
    }
    let profile = store
      .get_profile_by_workspace(workspace_id)
      .await
      .map_err(|e| async_graphql::Error::new(format!("store error: {e}")))?
      .ok_or_else(|| async_graphql::Error::new("no git sync profile configured for this workspace"))?;
    if !profile.enabled {
      return Err(async_graphql::Error::new("Git Sync profile is disabled"));
    }
    let run_direction = direction
      .map(git_sync::map_sync_direction_to_domain)
      .unwrap_or(profile.sync_direction);
    if run_direction != profile.sync_direction {
      return Err(async_graphql::Error::new(
        "manual trigger direction must equal the configured profile direction",
      ));
    }
    if !policy.is_sync_direction_allowed(run_direction) {
      return Err(async_graphql::Error::new(
        "sync direction is not allowed by administrator policy",
      ));
    }
    let (created, inserted) = store
      .create_pending_run_if_absent(
        profile.id,
        run_direction,
        myoxus_domain::git_sync::GitSyncRunSource::Manual,
      )
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to create or select run: {e}")))?;
    tracing::info!(run_id = %created.id, profile_id = %profile.id, inserted, "sync run triggered via GraphQL");

    let queue = state.redis_queue().ok_or_else(|| {
      async_graphql::Error::new("Git Sync dispatcher is unavailable; Pending run remains recoverable")
    })?;
    let dispatched = crate::git_sync_engine::dispatch::dispatch_run(
      &queue,
      &store,
      crate::git_sync_engine::dispatch::pending_dispatch(created),
    )
    .await
    .map_err(|error| {
      tracing::error!(profile_id = %profile.id, %error, "Git-Sync manual dispatch failed");
      async_graphql::Error::new(format!(
        "Git Sync dispatcher failed; Pending run remains recoverable: {error}"
      ))
    })?;

    Ok(git_sync::map_run(dispatched))
  }

  /// Test connection to a Git repository.
  ///
  /// Attempts to list-remote the repository to verify the URL and
  /// credentials are valid. Supports all auth methods: HttpsToken,
  /// HttpsPassword, and SshKey. Requires authentication.
  #[graphql(name = "testGitConnection")]
  #[allow(clippy::too_many_arguments)]
  async fn test_git_connection(
    &self,
    ctx: &Context<'_>,
    repo_url: String,
    branch: Option<String>,
    auth_method: git_sync::GitSyncAuthMethodType,
    token: Option<String>,
    username: Option<String>,
    password: Option<String>,
    #[graphql(name = "sshPrivateKey")] ssh_private_key: Option<String>,
    #[graphql(name = "sshPassphrase")] ssh_passphrase: Option<String>,
  ) -> Result<bool> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let policy = state
      .effective_git_sync_policy()
      .await
      .map_err(async_graphql::Error::new)?;
    let auth_method_domain = git_sync::map_auth_method_to_domain(auth_method);
    let repo_url = normalize_required_input("repo_url", &repo_url)?;
    let branch = branch
      .as_deref()
      .unwrap_or(policy.default_branch.as_str())
      .trim()
      .to_string();
    let credential_plaintext = build_credential_payload_fields(
      auth_method_domain,
      token.as_deref(),
      password.as_deref(),
      username.as_deref(),
      ssh_private_key.as_deref(),
      ssh_passphrase.as_deref(),
    )?;
    let credential_json: serde_json::Value = serde_json::from_slice(&credential_plaintext)
      .map_err(|_| async_graphql::Error::new("invalid credential payload"))?;
    let git_auth =
      crate::git_sync_engine::credential::build_auth(uuid::Uuid::nil(), auth_method_domain, &credential_json)
        .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    let service = git_sync_lifecycle_service(&state, pool, &policy, "graphql_connection_test", Some(snapshot.user.id));
    service
      .test_connection(
        &policy.lifecycle_policy(),
        &repo_url,
        &branch,
        auth_method_domain,
        &git_auth,
      )
      .await
      .map(|_| true)
      .map_err(map_git_sync_lifecycle_error)
  }

  /// Admin-only: disable a persisted Git-Sync SSH host key without deleting audit context.
  #[graphql(name = "disableGitSyncSshHostKey")]
  async fn disable_git_sync_ssh_host_key(
    &self,
    ctx: &Context<'_>,
    host: String,
    port: i32,
    #[graphql(name = "keyType")] key_type: String,
  ) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    ensure_admin(ctx, state).await?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    store
      .disable_ssh_host_key(&host, port, &key_type)
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to disable SSH host key: {e}")))
  }

  /// Admin-only: delete a persisted Git-Sync SSH host key pin.
  #[graphql(name = "deleteGitSyncSshHostKey")]
  async fn delete_git_sync_ssh_host_key(
    &self,
    ctx: &Context<'_>,
    host: String,
    port: i32,
    #[graphql(name = "keyType")] key_type: String,
  ) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    ensure_admin(ctx, state).await?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    store
      .delete_ssh_host_key(&host, port, &key_type)
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to delete SSH host key: {e}")))
  }

  /// Resolve a Git Sync conflict.
  ///
  /// Applies the selected document resolution server-side, updates document
  /// snapshot/baseline state where required, then marks the conflict resolved.
  /// Requires workspace admin/owner permission on the conflict's workspace.
  #[graphql(name = "resolveGitSyncConflict")]
  async fn resolve_git_sync_conflict(&self, ctx: &Context<'_>, input: git_sync::ResolveConflictInput) -> Result<bool> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let conflict_id =
      uuid::Uuid::parse_str(&input.conflict_id).map_err(|_| async_graphql::Error::new("invalid conflict id"))?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
    // Fetch conflict first to get profile_id, then check permission BEFORE resolving
    let conflict = store
      .get_conflict(conflict_id)
      .await
      .map_err(|e| async_graphql::Error::new(format!("conflict not found: {e}")))?;
    let profile = store
      .get_profile(conflict.profile_id)
      .await
      .map_err(|e| async_graphql::Error::new(format!("profile not found: {e}")))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: profile.workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let resolution = git_sync::map_resolution_to_domain(input.resolution);
    crate::git_sync_engine::conflicts::resolve_document_conflict(
      &store,
      &conflict,
      &profile,
      resolution,
      input.merged_content,
      snapshot.user.id,
    )
    .await?;
    myoxus_infrastructure::quota_cache::QuotaCache::with_all_ttls(
      state.redis_port(),
      &state.config.redis.namespace,
      state.config.redis.cache_ttl_quota_seconds,
      state.config.redis.cache_ttl_usage_seconds,
      state.config.redis.cache_ttl_git_status_seconds,
    )
    .invalidate_git_status(profile.workspace_id)
    .await;
    tracing::info!(conflict_id = %conflict_id, resolution = %resolution, "conflict resolved via GraphQL");
    Ok(true)
  }

  /// Resolve a non-Markdown Git Sync file conflict.
  ///
  /// File conflicts are resolved server-side because they mutate Git-Sync
  /// baseline/binding/blob state. Clients only choose the strategy.
  #[graphql(name = "resolveGitSyncFileConflict")]
  async fn resolve_git_sync_file_conflict(
    &self,
    ctx: &Context<'_>,
    input: git_sync::ResolveFileConflictInput,
  ) -> Result<bool> {
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let conflict_id =
      uuid::Uuid::parse_str(&input.conflict_id).map_err(|_| async_graphql::Error::new("invalid conflict id"))?;
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("database not available"));
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
    let conflict = store
      .get_file_conflict(conflict_id)
      .await
      .map_err(|e| async_graphql::Error::new(format!("file conflict not found: {e}")))?;
    let profile = store
      .get_profile(conflict.profile_id)
      .await
      .map_err(|e| async_graphql::Error::new(format!("profile not found: {e}")))?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: profile.workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    let resolution = git_sync::map_resolution_to_domain(input.resolution);
    let policy = state
      .effective_git_sync_policy()
      .await
      .map_err(async_graphql::Error::new)?;
    crate::git_sync_engine::conflicts::resolve_file_conflict(
      &store,
      &conflict,
      &profile,
      resolution,
      snapshot.user.id,
      state.storage().as_ref(),
      &state.config,
      &policy,
    )
    .await?;
    myoxus_infrastructure::quota_cache::QuotaCache::with_all_ttls(
      state.redis_port(),
      &state.config.redis.namespace,
      state.config.redis.cache_ttl_quota_seconds,
      state.config.redis.cache_ttl_usage_seconds,
      state.config.redis.cache_ttl_git_status_seconds,
    )
    .invalidate_git_status(profile.workspace_id)
    .await;
    tracing::info!(conflict_id = %conflict_id, resolution = %resolution, "file conflict resolved via GraphQL");
    Ok(true)
  }

  // -----------------------------------------------------------------------
  // Logging mutations (P33-C)
  // -----------------------------------------------------------------------

  // ─── Builtin Template Bridge (P125-TPL-S-04) ────────────────────────────

  async fn workspace_template_reconcile_slugs(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    locale: String,
    provision_sources: Option<bool>,
  ) -> Result<Vec<template_registry::BuiltinReconcileEntryType>> {
    auth::MutationRoot
      .workspace_template_reconcile_slugs(ctx, workspace_id, locale, provision_sources)
      .await
  }

  async fn report_template_builder_applied(
    &self,
    ctx: &Context<'_>,
    input: template_registry::ReportBuilderAppliedInput,
  ) -> Result<bool> {
    auth::MutationRoot.report_template_builder_applied(ctx, input).await
  }

  async fn report_template_builder_trashed(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    slug: String,
  ) -> Result<bool> {
    auth::MutationRoot
      .report_template_builder_trashed(ctx, workspace_id, slug)
      .await
  }

  /// Cancel a queued PDF export job as the requester or as an admin.
  async fn cancel_pdf_export_job(&self, ctx: &Context<'_>, job_id: String) -> Result<bool> {
    pdf_export::PdfExportMutationRoot
      .cancel_pdf_export_job(ctx, job_id)
      .await
  }

  /// V2 export mutation (`P-PDF-TPL-11-{01,02}`). Accepts the full L3
  /// shape (locale, paper_size, image_quality, cover_page, toc_behavior,
  /// confidentiality_label, typed_inputs); runs the manifest-driven
  /// capability validator before dispatch and refuses
  /// off-capability inputs with `extensions.class = "CapabilityViolation"`.
  async fn export_pdf(
    &self,
    ctx: &Context<'_>,
    input: pdf_export::PdfExportInputV2Input,
  ) -> Result<pdf_export::PdfExportJobType> {
    pdf_export::PdfExportMutationRoot.export_pdf(ctx, input).await
  }

  /// Create a named document version from the current document state.
  async fn capture_document_history(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    request_key: ID,
    name: Option<String>,
    description: Option<String>,
  ) -> Result<document_version::DocumentHistoryCaptureType> {
    document_version::DocumentVersionMutationRoot
      .capture_document_history(ctx, workspace_id, doc_id, request_key, name, description)
      .await
  }

  /// Attach a name to an existing immutable document history state.
  async fn name_document_history_state(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    history_id: ID,
    expected_version_ids: Vec<ID>,
    name: String,
    description: Option<String>,
  ) -> Result<document_version::DocumentVersionType> {
    document_version::DocumentVersionMutationRoot
      .name_document_history_state(
        ctx,
        workspace_id,
        doc_id,
        history_id,
        expected_version_ids,
        name,
        description,
      )
      .await
  }

  /// Create a named document version from the current document state.
  async fn create_document_version(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    label: String,
    description: Option<String>,
  ) -> Result<document_version::DocumentVersionType> {
    document_version::DocumentVersionMutationRoot
      .create_document_version(ctx, workspace_id, doc_id, label, description)
      .await
  }

  /// Pin a named document version.
  async fn pin_document_version(&self, ctx: &Context<'_>, id: ID) -> Result<document_version::DocumentVersionType> {
    document_version::DocumentVersionMutationRoot
      .pin_document_version(ctx, id)
      .await
  }

  /// Unpin a named document version.
  async fn unpin_document_version(&self, ctx: &Context<'_>, id: ID) -> Result<document_version::DocumentVersionType> {
    document_version::DocumentVersionMutationRoot
      .unpin_document_version(ctx, id)
      .await
  }

  /// Update a named document version's mutable label/description metadata.
  async fn update_document_version(
    &self,
    ctx: &Context<'_>,
    id: ID,
    label: String,
    description: Option<String>,
  ) -> Result<document_version::DocumentVersionType> {
    document_version::DocumentVersionMutationRoot
      .update_document_version(ctx, id, label, description)
      .await
  }

  /// Delete a non-pinned named document version.
  async fn delete_document_version(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    document_version::DocumentVersionMutationRoot
      .delete_document_version(ctx, id)
      .await
  }

  /// Restore a named document version as a new document update and snapshot.
  async fn restore_document_version(
    &self,
    ctx: &Context<'_>,
    id: ID,
    expected_revision: Option<String>,
  ) -> Result<document_version::DocumentVersionType> {
    document_version::DocumentVersionMutationRoot
      .restore_document_version(ctx, id, expected_revision)
      .await
  }

  /// Update per-document versioning settings.
  async fn update_document_versioning_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    auto_version_on: Option<Vec<document_version::AutoVersionTriggerType>>,
    retention_count: Option<i32>,
    enabled: Option<bool>,
  ) -> Result<document_version::DocumentVersioningSettingsType> {
    document_version::DocumentVersionMutationRoot
      .update_document_versioning_settings(ctx, workspace_id, doc_id, auto_version_on, retention_count, enabled)
      .await
  }

  async fn update_workspace_history_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    input: document_version::UpdateWorkspaceHistorySettingsInput,
  ) -> Result<document_version::WorkspaceHistorySettingsType> {
    document_version::DocumentVersionMutationRoot
      .update_workspace_history_settings(ctx, workspace_id, input)
      .await
  }

  async fn transition_document_status(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    input: document_metadata_policy::TransitionDocumentStatusInput,
  ) -> Result<document_metadata_policy::TransitionDocumentStatusPayload> {
    document_metadata_policy::DocumentMetadataPolicyMutationRoot
      .transition_document_status(ctx, workspace_id, doc_id, input)
      .await
  }

  async fn update_workspace_document_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    input: document_metadata_policy::UpdateWorkspaceDocumentSettingsInput,
  ) -> Result<document_metadata_policy::WorkspaceDocumentSettingsType> {
    document_metadata_policy::DocumentMetadataPolicyMutationRoot
      .update_workspace_document_settings(ctx, workspace_id, input)
      .await
  }

  async fn set_document_metadata(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    input: document_metadata::SetDocumentMetadataInput,
  ) -> Result<document_metadata::SetDocumentMetadataPayload> {
    document_metadata::DocumentMetadataMutationRoot
      .set_document_metadata(ctx, workspace_id, doc_id, input)
      .await
  }

  async fn configure_document_review_planning(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    enabled: bool,
    expected_metadata_revision: i64,
  ) -> Result<document_metadata::DocumentReviewPlanningType> {
    document_metadata::DocumentMetadataMutationRoot
      .configure_document_review_planning(ctx, workspace_id, doc_id, enabled, expected_metadata_revision)
      .await
  }
}

#[derive(async_graphql::InputObject)]
pub struct ListUserInput {
  pub features: Option<Vec<auth::FeatureType>>,
  pub first: Option<i32>,
  pub keyword: Option<String>,
  pub skip: Option<i32>,
}

#[derive(async_graphql::InputObject, Clone, Debug)]
pub struct UpdateAppConfigInput {
  pub module: String,
  pub key: String,
  // Missing or explicit GraphQL null clears nullable runtime settings such as
  // optional SMTP credentials. Validation rejects it for non-nullable keys.
  pub value: Option<serde_json::Value>,
}

#[derive(async_graphql::SimpleObject)]
pub struct AppConfigValidateResultType {
  pub module: String,
  pub key: String,
  pub value: serde_json::Value,
  pub valid: bool,
  pub error: Option<String>,
}

/// AF-PERF-D-03: Single hourly data point for the cache tuning history sparkline.
#[derive(async_graphql::SimpleObject, Clone, Debug)]
pub struct CacheTuningHistoryPoint {
  /// Start of the hourly bucket (UTC).
  pub bucket: DateTime<Utc>,
  /// Average hit rate in [0.0, 1.0] during this hour.
  pub hit_rate: f64,
  /// Recommended TTL in seconds at the end of this bucket.
  pub ttl_seconds: i32,
}

/// P84-J-26: Per-cache tuning status returned by `adminCacheTuningStatus`.
#[derive(async_graphql::SimpleObject, Clone, Debug)]
pub struct CacheTuningStatusType {
  /// Cache name (e.g. `"app_config"`, `"user_features"`).
  pub name: String,
  /// Current effective TTL in seconds (may have been updated by tuning cycles).
  pub current_ttl_seconds: i32,
  /// Average hit rate over the last 1 hour (from `cache_tuning_metrics`).
  /// `null` when no data is available yet.
  pub hit_rate_1h: Option<f64>,
  /// Average hit rate over the last 24 hours.
  pub hit_rate_24h: Option<f64>,
  /// Last tuning action taken (e.g. `"increased"`, `"decreased"`, `"unchanged"`, `"skipped"`).
  pub last_action: Option<String>,
  /// When the last tuning action was recorded.
  pub last_action_at: Option<DateTime<Utc>>,
  /// Whether a fixed admin override is active (`cache.{name}_fixed_ttl_seconds` is set).
  pub is_fixed_override: bool,
}

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DocRole", rename_items = "PascalCase")]
pub enum DocRoleType {
  Commenter,
  Editor,
  External,
  Manager,
  None,
  Owner,
  Reader,
}

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "PublicDocMode", rename_items = "PascalCase")]
pub enum PublicDocModeType {
  Edgeless,
  Page,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "DocType")]
pub struct DocCompatType {
  pub id: String,
  pub workspace_id: String,
  pub public: bool,
  pub mode: PublicDocModeType,
  pub default_role: DocRoleType,
  pub created_at: Option<DateTime<Utc>>,
  pub updated_at: Option<DateTime<Utc>>,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct GrantDocUserRolesInput {
  pub workspace_id: String,
  pub external_doc_id: MaybeUndefined<String>,
  /// Deprecated: use `externalDocId`. This alias carries the same workspace-local external key.
  pub doc_id: MaybeUndefined<String>,
  pub user_ids: Vec<String>,
  pub role: DocRoleType,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct RevokeDocUserRoleInput {
  pub workspace_id: String,
  pub external_doc_id: MaybeUndefined<String>,
  /// Deprecated: use `externalDocId`. This alias carries the same workspace-local external key.
  pub doc_id: MaybeUndefined<String>,
  pub user_ids: Vec<String>,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct UpdateDocUserRoleInput {
  pub workspace_id: String,
  pub external_doc_id: MaybeUndefined<String>,
  /// Deprecated: use `externalDocId`. This alias carries the same workspace-local external key.
  pub doc_id: MaybeUndefined<String>,
  pub user_id: String,
  pub role: DocRoleType,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct UpdateDocDefaultRoleInput {
  pub workspace_id: String,
  pub external_doc_id: MaybeUndefined<String>,
  /// Deprecated: use `externalDocId`. This alias carries the same workspace-local external key.
  pub doc_id: MaybeUndefined<String>,
  pub role: DocRoleType,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "ContextWorkspaceEmbeddingStatus")]
pub struct ContextWorkspaceEmbeddingStatusType {
  pub embedded: i64,
  pub total: i64,
  pub available: bool,
  pub status: ContextEmbedStatusType,
  pub error: Option<String>,
}

/// Copilot context with sub-fields for items (blobs, docs, files, tags, collections).
///
/// Maps to `CopilotContext` in the GraphQL schema, returned by
/// `copilot { contexts(...) }`.
pub struct CopilotContextType {
  pub id: String,
  pub workspace_id: Option<String>,
  pub name: String,
  pub created_at: i64,
}

/// Workspace embedding resolver container — returned by `workspace { embedding { ... } }`.
///
/// Provides sub-resolvers for files, ignoredDocs, and allIgnoredDocs.
pub struct WorkspaceEmbeddingType {
  pub workspace_id: uuid::Uuid,
}

/// Match result for vector/embedding search.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotContextMatchedDoc")]
pub struct CopilotContextMatchedDocType {
  pub doc_id: String,
  pub content: String,
  /// Chunk index from the embedding record.
  pub chunk: i32,
  /// Cosine distance exposed as `distance` for client compatibility.
  #[graphql(name = "distance")]
  pub score: f64,
}

/// Match result for file search.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotContextMatchedFile")]
pub struct CopilotContextMatchedFileType {
  pub file_id: String,
  pub content: String,
  /// Original blob ID from the file record.
  pub blob_id: String,
  /// File name from the file record.
  pub name: String,
  /// MIME type from the file record.
  pub mime_type: String,
  /// Chunk index from the embedding record.
  pub chunk: i32,
  /// Cosine distance exposed as `distance` for client compatibility.
  #[graphql(name = "distance")]
  pub score: f64,
}

/// A single ignored doc entry with metadata.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotIgnoredDocNode")]
pub struct CopilotIgnoredDocNode {
  #[graphql(name = "docId")]
  pub doc_id: String,
  #[graphql(name = "createdAt")]
  pub created_at: Option<DateTime<Utc>>,
  #[graphql(name = "docCreatedAt")]
  pub doc_created_at: Option<DateTime<Utc>>,
  #[graphql(name = "docUpdatedAt")]
  pub doc_updated_at: Option<DateTime<Utc>>,
  pub title: Option<String>,
  #[graphql(name = "createdBy")]
  pub created_by: Option<String>,
  #[graphql(name = "createdByAvatar")]
  pub created_by_avatar: Option<String>,
  #[graphql(name = "updatedBy")]
  pub updated_by: Option<String>,
}

/// Edge wrapper for paginated ignored doc results.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotIgnoredDocEdge")]
pub struct CopilotIgnoredDocEdge {
  pub node: CopilotIgnoredDocNode,
}

/// Relay-style paginated ignored docs.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "PaginatedCopilotIgnoredDocs")]
pub struct PaginatedCopilotIgnoredDocsType {
  #[graphql(name = "totalCount")]
  pub total_count: i32,
  #[graphql(name = "pageInfo")]
  pub page_info: auth::PageInfoType,
  pub edges: Vec<CopilotIgnoredDocEdge>,
}

/// Minimal ignored doc entry for allIgnoredDocs.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotIgnoredDocBasic")]
pub struct CopilotIgnoredDocBasic {
  #[graphql(name = "docId")]
  pub doc_id: String,
  #[graphql(name = "createdAt")]
  pub created_at: Option<DateTime<Utc>>,
}

/// Edge wrapper for paginated workspace file results.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotWorkspaceFileEdge")]
pub struct CopilotWorkspaceFileEdge {
  pub node: CopilotWorkspaceFileType,
}

/// Relay-style paginated workspace files.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "PaginatedCopilotWorkspaceFiles")]
pub struct PaginatedCopilotWorkspaceFilesType {
  #[graphql(name = "totalCount")]
  pub total_count: i32,
  #[graphql(name = "pageInfo")]
  pub page_info: auth::PageInfoType,
  pub edges: Vec<CopilotWorkspaceFileEdge>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotContextBlob")]
pub struct CopilotContextBlobType {
  pub id: String,
  pub created_at: i64,
  pub status: Option<ContextEmbedStatusType>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotContextDoc")]
pub struct CopilotContextDocType {
  pub id: String,
  pub created_at: i64,
  pub status: Option<ContextEmbedStatusType>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotContextCategory")]
pub struct CopilotContextCategoryType {
  pub id: String,
  pub created_at: i64,
  #[graphql(name = "type")]
  pub category_type: String,
  pub docs: Vec<CopilotContextDocType>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotContextFile")]
pub struct CopilotContextFileType {
  pub id: String,
  pub blob_id: String,
  pub name: String,
  pub mime_type: String,
  pub chunk_size: i64,
  pub created_at: i64,
  pub status: ContextEmbedStatusType,
  pub error: Option<String>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "CopilotWorkspaceFile")]
pub struct CopilotWorkspaceFileType {
  #[graphql(name = "fileId")]
  pub id: String,
  pub blob_id: String,
  #[graphql(name = "fileName")]
  pub name: String,
  pub mime_type: String,
  /// File creation timestamp in UTC.
  pub created_at: DateTime<Utc>,
  /// File size in bytes (default 0).
  pub size: i64,
  /// Workspace ID that owns this file.
  pub workspace_id: String,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "TranscriptionItemType")]
pub struct TranscriptionItemType {
  pub start: String,
  pub end: String,
  pub speaker: String,
  pub transcription: String,
}

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AiJobStatus", rename_items = "PascalCase")]
pub enum AiJobStatusType {
  Failed,
  Finished,
  Pending,
  Running,
}

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "ContextEmbedStatus")]
pub enum ContextEmbedStatusType {
  #[graphql(name = "failed")]
  Failed,
  #[graphql(name = "finished")]
  Finished,
  #[graphql(name = "processing")]
  Processing,
}

/// Provider timing and speakers remain unknown when absent.
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "TranscriptionSegmentType")]
pub struct TranscriptionSegmentType {
  pub text: String,
  pub start_seconds: Option<f64>,
  pub end_seconds: Option<f64>,
  pub speaker: Option<String>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "TranscriptionResultType", complex)]
pub struct TranscriptionResultType {
  pub id: String,
  pub status: AiJobStatusType,
  /// Existing durable job failure; no client-specific error classification.
  pub error_message: Option<String>,
  pub title: Option<String>,
  pub summary: Option<String>,
  pub actions: Option<String>,
  pub transcription: Option<Vec<TranscriptionItemType>>,
  pub text: Option<String>,
  pub segments: Option<Vec<TranscriptionSegmentType>>,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct AddContextBlobInput {
  pub context_id: String,
  pub blob_id: String,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct AddContextDocInput {
  pub context_id: String,
  pub doc_id: String,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct AddContextCategoryInput {
  pub context_id: String,
  pub category_id: String,
  #[graphql(name = "type")]
  pub category_type: String,
  pub docs: Option<Vec<String>>,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct AddContextFileInput {
  pub context_id: String,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct RemoveContextBlobInput {
  pub context_id: String,
  pub blob_id: String,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct RemoveContextDocInput {
  pub context_id: String,
  pub doc_id: String,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct RemoveContextCategoryInput {
  pub context_id: String,
  pub category_id: String,
  #[graphql(name = "type")]
  pub category_type: String,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct RemoveContextFileInput {
  pub context_id: String,
  pub file_id: String,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct ForkChatSessionInput {
  pub session_id: String,
  pub doc_id: String,
  pub workspace_id: String,
  pub latest_message_id: Option<String>,
}

#[tracing::instrument(skip_all)]
pub async fn ensure_admin(ctx: &Context<'_>, _state: &Arc<crate::state::ApiState>) -> Result<()> {
  ensure_admin_snapshot(ctx, _state).await.map(|_| ())
}

/// Alias for `ensure_admin` used by the `admin` sub-module.
pub async fn ensure_admin_fn(ctx: &Context<'_>, state: &Arc<crate::state::ApiState>) -> Result<()> {
  ensure_admin(ctx, state).await
}

pub async fn ensure_admin_snapshot_fn(
  ctx: &Context<'_>,
  state: &Arc<crate::state::ApiState>,
) -> Result<myoxus_application::auth::SessionSnapshot> {
  ensure_admin_snapshot(ctx, state).await
}

async fn ensure_admin_snapshot(
  ctx: &Context<'_>,
  _state: &Arc<crate::state::ApiState>,
) -> Result<myoxus_application::auth::SessionSnapshot> {
  let (_, snapshot) = crate::graphql::utils::require_session(ctx).await?;
  if !snapshot.user.is_admin {
    return Err(crate::graphql::utils::map_gql_error(
      myoxus_application::auth::AuthError::ActionForbidden,
    ));
  }
  Ok(snapshot)
}

async fn ensure_authenticated_snapshot(
  ctx: &Context<'_>,
  _state: &Arc<crate::state::ApiState>,
) -> Result<myoxus_application::auth::SessionSnapshot> {
  let (_, snapshot) = crate::graphql::utils::require_session(ctx).await?;
  Ok(snapshot)
}

// ---------------------------------------------------------------------------
// Logging helper functions (P33-C)
// ---------------------------------------------------------------------------

/// Build a `GqlLogOutputConfig` from the server's logging config.
fn build_log_output_config(cfg: &crate::config::LoggingConfig) -> GqlLogOutputConfig {
  let (path_valid, path_error) = if let Some(ref path) = cfg.file_path {
    validate_log_path(path)
  } else {
    (true, None)
  };

  GqlLogOutputConfig {
    file_path: cfg.file_path.clone(),
    rotation: match cfg.rotation {
      crate::config::LogRotation::Never => GqlLogRotation::Never,
      crate::config::LogRotation::Hourly => GqlLogRotation::Hourly,
      crate::config::LogRotation::Daily => GqlLogRotation::Daily,
    },
    max_files: cfg.max_files as i32,
    path_valid,
    path_error,
    requires_restart: false,
  }
}

/// Validate that a log file path's parent directory exists and is writable.
pub fn validate_log_path(path: &str) -> (bool, Option<String>) {
  let p = std::path::Path::new(path);
  let dir = p.parent().unwrap_or(std::path::Path::new("."));

  if !dir.exists() {
    return (false, Some(format!("directory does not exist: {}", dir.display())));
  }

  // Try to create and immediately remove a test file to check writability.
  let test_file = dir.join(".myoxus_log_path_test");
  match std::fs::File::create(&test_file) {
    Ok(_) => {
      let _ = std::fs::remove_file(&test_file);
      (true, None)
    }
    Err(e) => (false, Some(format!("directory not writable: {e}"))),
  }
}

/// Compute disk usage for the log directory.
fn compute_log_disk_usage(file_path: Option<&str>) -> GqlLogDiskUsage {
  let Some(path) = file_path else {
    return GqlLogDiskUsage {
      total_bytes: 0,
      file_count: 0,
      free_bytes: 0,
    };
  };

  let dir = std::path::Path::new(path).parent().unwrap_or(std::path::Path::new("."));

  let mut total_bytes: i64 = 0;
  let mut file_count: i32 = 0;

  if let Ok(entries) = std::fs::read_dir(dir) {
    for entry in entries.flatten() {
      if let Ok(meta) = entry.metadata()
        && meta.is_file()
      {
        total_bytes += meta.len() as i64;
        file_count += 1;
      }
    }
  }

  // Try to get free space using statvfs on Unix.
  let free_bytes = get_free_space(dir);

  GqlLogDiskUsage {
    total_bytes,
    file_count,
    free_bytes,
  }
}

/// Get free disk space for a directory. Returns 0 on failure.
fn get_free_space(dir: &std::path::Path) -> i64 {
  fs2::available_space(dir).map(|s| s as i64).unwrap_or(0)
}

/// Convert a `LogRotation` enum to its string representation.
pub fn rotation_to_string(r: &crate::config::LogRotation) -> String {
  match r {
    crate::config::LogRotation::Never => "NEVER".to_string(),
    crate::config::LogRotation::Daily => "DAILY".to_string(),
    crate::config::LogRotation::Hourly => "HOURLY".to_string(),
  }
}

fn doc_role_from_input(role: DocRoleType) -> myoxus_domain::entities::DocRole {
  match role {
    DocRoleType::None => myoxus_domain::entities::DocRole::None,
    DocRoleType::External => myoxus_domain::entities::DocRole::External,
    DocRoleType::Reader => myoxus_domain::entities::DocRole::Reader,
    DocRoleType::Commenter => myoxus_domain::entities::DocRole::Commenter,
    DocRoleType::Editor => myoxus_domain::entities::DocRole::Editor,
    DocRoleType::Manager => myoxus_domain::entities::DocRole::Manager,
    DocRoleType::Owner => myoxus_domain::entities::DocRole::Owner,
  }
}

fn public_mode_from_db(value: Option<String>) -> PublicDocModeType {
  match value
    .unwrap_or_else(|| "Page".to_string())
    .to_ascii_lowercase()
    .as_str()
  {
    "edgeless" => PublicDocModeType::Edgeless,
    _ => PublicDocModeType::Page,
  }
}

fn publish_doc_not_found_error(workspace_id: uuid::Uuid, doc_id: &str) -> async_graphql::Error {
  async_graphql::Error::new("Document not found.").extend_with(|_, e| {
    e.set("code", "NOT FOUND");
    e.set("type", "DOC_NOT_FOUND");
    e.set("name", "DOC_NOT_FOUND");
    if let Ok(value) = async_graphql::Value::from_json(json!({
      "docId": doc_id,
      "spaceId": workspace_id.to_string(),
    })) {
      e.set("data", value);
    }
  })
}

async fn update_public_doc_mode(
  ctx: &Context<'_>,
  workspace_id: String,
  doc_id: String,
  mode: PublicDocModeType,
  publish: bool,
) -> Result<DocCompatType> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_uuid =
    uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
  let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, &doc_id).await?;
  let publication_mode = publish.then(|| match mode {
    PublicDocModeType::Page => myoxus_application::public::PublicDocumentMode::Page,
    PublicDocModeType::Edgeless => myoxus_application::public::PublicDocumentMode::Edgeless,
  });
  let row = state
    .document_publication_service()
    .set_mode(snapshot.user.id, workspace_uuid, doc_uuid, publication_mode)
    .await
    .map_err(|error| match error {
      myoxus_application::public::DocumentPublicationError::Authorization(error) => {
        crate::graphql::utils::map_gql_error(error)
      }
      myoxus_application::public::DocumentPublicationError::DeliveryUnavailable => {
        async_graphql::Error::new("Public publishing is unavailable for this server.")
      }
      myoxus_application::public::DocumentPublicationError::WorkspaceUnavailable => {
        async_graphql::Error::new("Make the workspace public with sharing enabled before publishing documents.")
      }
      myoxus_application::public::DocumentPublicationError::NotFound => {
        publish_doc_not_found_error(workspace_uuid, &doc_id)
      }
      error => async_graphql::Error::new(error.to_string()),
    })?;
  state.metrics().record(
    myoxus_application::metrics::MetricsCategory::Doc,
    "doc_share_changed",
    &[("published", if publish { "true" } else { "false" })],
  );
  let default_role = match row.default_role {
    myoxus_domain::entities::DocDefaultRole::Editor => DocRoleType::Editor,
    myoxus_domain::entities::DocDefaultRole::Viewer => DocRoleType::Reader,
  };
  Ok(DocCompatType {
    id: row.external_id,
    workspace_id: row.workspace_id.unwrap_or(workspace_uuid).to_string(),
    public: row.public_mode.is_some(),
    mode: public_mode_from_db(row.public_mode),
    default_role,
    created_at: Some(row.created_at),
    updated_at: Some(row.updated_at),
  })
}

async fn update_doc_roles(
  ctx: &Context<'_>,
  workspace_id: String,
  doc_id: String,
  user_ids: Vec<String>,
  role: Option<DocRoleType>,
  revoke: bool,
) -> Result<bool> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_uuid =
    uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
  let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, &doc_id).await?;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::DocResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
        doc_id: doc_uuid,
      },
      myoxus_domain::permission::DocAction::UsersManage,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  // Parse all user IDs upfront so we fail fast on invalid input.
  let uids: Vec<uuid::Uuid> = user_ids
    .iter()
    .map(|id| uuid::Uuid::parse_str(id).map_err(|_| async_graphql::Error::new("invalid user id")))
    .collect::<Result<Vec<_>>>()?;
  if revoke {
    state
      .doc()
      .bulk_revoke_doc_permission(doc_uuid, &uids)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
  } else {
    let target_role = doc_role_from_input(role.ok_or_else(|| async_graphql::Error::new("role is required"))?);
    state
      .doc()
      .bulk_grant_doc_permission(doc_uuid, &uids, target_role, snapshot.user.id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
  }
  Ok(true)
}

fn required_external_doc_id(
  external_doc_id: MaybeUndefined<String>,
  legacy_doc_id: MaybeUndefined<String>,
) -> Result<String> {
  match (external_doc_id, legacy_doc_id) {
    (MaybeUndefined::Value(external_doc_id), MaybeUndefined::Undefined) => Ok(external_doc_id),
    (MaybeUndefined::Undefined, MaybeUndefined::Value(legacy_doc_id)) => Ok(legacy_doc_id),
    (MaybeUndefined::Undefined | MaybeUndefined::Null, MaybeUndefined::Undefined)
    | (MaybeUndefined::Undefined, MaybeUndefined::Null) => Err(async_graphql::Error::new(
      "exactly one of externalDocId or docId is required",
    )),
    _ => Err(async_graphql::Error::new(
      "externalDocId and docId cannot be supplied together",
    )),
  }
}

async fn apply_doc_updates_impl(
  ctx: &Context<'_>,
  workspace_id: String,
  doc_id: String,
  op: String,
  updates: String,
) -> Result<String> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_uuid =
    uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
  let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, &doc_id).await?;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::DocResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
        doc_id: doc_uuid,
      },
      myoxus_domain::permission::DocAction::Update,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  if state
    .doc()
    .get_metadata(doc_uuid)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?
    .is_none()
  {
    return Err(async_graphql::Error::new("document not found"));
  }
  let trimmed = updates.trim();
  if trimmed.is_empty() {
    return Ok(String::new());
  }
  if op.eq_ignore_ascii_case("replace") {
    return Ok(trimmed.to_string());
  }
  Ok(format!("{trimmed}\n"))
}

fn copilot_item_type_from_key(item_type: &str) -> myoxus_domain::entities::CopilotContextItemType {
  match item_type {
    "doc" => myoxus_domain::entities::CopilotContextItemType::Doc,
    "file" => myoxus_domain::entities::CopilotContextItemType::File,
    "blob" => myoxus_domain::entities::CopilotContextItemType::Blob,
    "category" => myoxus_domain::entities::CopilotContextItemType::Category,
    "tag" => myoxus_domain::entities::CopilotContextItemType::Tag,
    "collection" => myoxus_domain::entities::CopilotContextItemType::Collection,
    "workspace" => myoxus_domain::entities::CopilotContextItemType::Workspace,
    _ => myoxus_domain::entities::CopilotContextItemType::Unknown,
  }
}

async fn add_copilot_context_item(
  ctx: &Context<'_>,
  context_id: &str,
  item_type: &str,
  item_ref: &str,
  metadata: serde_json::Value,
) -> Result<i64> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let context_uuid = uuid::Uuid::parse_str(context_id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
  let context = ensure_context_owned(state, snapshot.user.id, context_uuid, None, true)
    .await?
    .ok_or_else(|| async_graphql::Error::new("context not found"))?;
  let workspace_id = context
    .workspace_id
    .ok_or_else(|| crate::graphql::utils::map_gql_error(myoxus_application::auth::AuthError::ActionForbidden))?;
  let mut doc_refs = Vec::new();
  if item_type == "doc" {
    doc_refs.push(item_ref);
  }
  if let Some(docs) = metadata.get("docs").and_then(serde_json::Value::as_array) {
    doc_refs.extend(docs.iter().filter_map(serde_json::Value::as_str));
  }
  for doc_ref in doc_refs {
    let doc_id = crate::graphql::utils::resolve_doc_id(state, workspace_id, doc_ref).await?;
    auth::assert_copilot_doc_access(state, snapshot.user.id, workspace_id, doc_id).await?;
  }

  let item = state
    .copilot()
    .add_context_item(
      context_uuid,
      copilot_item_type_from_key(item_type),
      item_ref.to_string(),
      metadata,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(item.created_at.timestamp_millis())
}

async fn remove_copilot_context_item(
  ctx: &Context<'_>,
  context_id: &str,
  item_type: &str,
  item_ref: &str,
) -> Result<bool> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let context_uuid = uuid::Uuid::parse_str(context_id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
  if ensure_context_owned(state, snapshot.user.id, context_uuid, None, false)
    .await?
    .is_none()
  {
    return Ok(false);
  }
  state
    .copilot()
    .remove_context_item(context_uuid, copilot_item_type_from_key(item_type), item_ref)
    .await
    .map_err(crate::graphql::utils::map_gql_error)
}

async fn ensure_context_owned(
  state: &Arc<crate::state::ApiState>,
  user_id: uuid::Uuid,
  context_id: uuid::Uuid,
  requested_workspace: Option<uuid::Uuid>,
  require_exists: bool,
) -> Result<Option<myoxus_domain::entities::CopilotContext>> {
  let context = state
    .copilot()
    .get_context(context_id)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  if context.as_ref().is_some_and(|context| {
    context.user_id != user_id || requested_workspace.is_some_and(|workspace| context.workspace_id != Some(workspace))
  }) {
    return Err(crate::graphql::utils::map_gql_error(
      myoxus_application::auth::AuthError::ActionForbidden,
    ));
  }
  if context.is_none() && require_exists {
    return Err(async_graphql::Error::new("context not found"));
  }
  if let Some(context) = &context {
    let workspace_id = context
      .workspace_id
      .ok_or_else(|| crate::graphql::utils::map_gql_error(myoxus_application::auth::AuthError::ActionForbidden))?;
    auth::assert_copilot_workspace_access(state, user_id, workspace_id, "copilot.context").await?;
    if let Some(session_id) = context.metadata.get("sessionId").and_then(serde_json::Value::as_str) {
      let session_id =
        uuid::Uuid::parse_str(session_id).map_err(|_| async_graphql::Error::new("invalid context session"))?;
      let session = state
        .copilot()
        .get_session(session_id)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
      if session.workspace_id != Some(workspace_id) {
        return Err(crate::graphql::utils::map_gql_error(
          myoxus_application::auth::AuthError::ActionForbidden,
        ));
      }
      auth::assert_copilot_session_access(state, user_id, &session, "copilot.context").await?;
    }
  }
  Ok(context)
}

/// Authorize the stored context before loading any attachment/document metadata.
async fn load_copilot_context_items(
  ctx: &Context<'_>,
  context_id: &str,
) -> Result<Vec<myoxus_domain::entities::CopilotContextItem>> {
  let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
  let id = uuid::Uuid::parse_str(context_id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
  ensure_context_owned(&state, snapshot.user.id, id, None, true).await?;
  state
    .copilot()
    .list_context_items(id)
    .await
    .map_err(crate::graphql::utils::map_gql_error)
}

/// Direct document readiness is not an embedding job. Check current access and
/// canonical materialization so an explicit readable source can terminate polling.
async fn copilot_doc_context_status(
  state: &Arc<crate::state::ApiState>,
  user_id: uuid::Uuid,
  workspace_id: Option<uuid::Uuid>,
  doc_ref: &str,
) -> ContextEmbedStatusType {
  let result = async {
    let workspace_id = workspace_id.ok_or_else(|| async_graphql::Error::new("context workspace unavailable"))?;
    let doc_id = crate::graphql::utils::resolve_doc_id(state, workspace_id, doc_ref).await?;
    auth::assert_copilot_doc_access(state, user_id, workspace_id, doc_id).await?;
    myoxus_application::copilot::context_prompt::materialize_selected_document(
      state.doc(),
      workspace_id,
      doc_id,
      state.config.mcp.document_export_max_bytes,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
    Ok::<_, async_graphql::Error>(())
  }
  .await;
  match result {
    Ok(()) => ContextEmbedStatusType::Finished,
    Err(_) => ContextEmbedStatusType::Failed,
  }
}

// ─── CopilotContextType sub-resolvers ────────────────────────────────────────

fn project_copilot_context_file(item: &myoxus_domain::entities::CopilotContextItem) -> CopilotContextFileType {
  let status = context_ingestion_status(item);
  CopilotContextFileType {
    id: item.item_ref.clone(),
    blob_id: item.metadata["blobId"].as_str().unwrap_or_default().into(),
    name: item.metadata["name"].as_str().unwrap_or_default().into(),
    mime_type: item.metadata["mimeType"]
      .as_str()
      .unwrap_or("application/octet-stream")
      .into(),
    chunk_size: item.metadata["chunkSize"].as_i64().unwrap_or(0),
    created_at: item.created_at.timestamp_millis(),
    status,
    error: (status == ContextEmbedStatusType::Failed).then(|| {
      item.metadata["error"]
        .as_str()
        .unwrap_or("CONTEXT_INPUT_UNAVAILABLE")
        .to_owned()
    }),
  }
}

fn context_ingestion_status(item: &myoxus_domain::entities::CopilotContextItem) -> ContextEmbedStatusType {
  match item.metadata["ingestStatus"].as_str() {
    Some("queued" | "running") => ContextEmbedStatusType::Processing,
    Some("finished")
      if item.metadata["text"]
        .as_str()
        .is_some_and(|text| !text.trim().is_empty()) =>
    {
      ContextEmbedStatusType::Finished
    }
    _ => ContextEmbedStatusType::Failed,
  }
}

async fn current_context_file_status(
  state: &crate::state::ApiState,
  workspace: Option<uuid::Uuid>,
  mut item: myoxus_domain::entities::CopilotContextItem,
) -> Result<myoxus_domain::entities::CopilotContextItem> {
  let blob = if let (Some(workspace), Some(blob)) = (workspace, item.metadata["blobId"].as_str()) {
    state
      .blob()
      .get_blob_metadata(workspace, blob)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
  } else {
    None
  };
  if blob.is_none_or(|blob| {
    blob.deleted_at.is_some() || blob.status != myoxus_application::ports::blob::BlobStatus::Completed
  }) {
    item.metadata["ingestStatus"] = json!("failed");
    item.metadata["error"] = json!("CONTEXT_INPUT_UNAVAILABLE");
  }
  Ok(item)
}

#[async_graphql::Object(name = "CopilotContext")]
impl CopilotContextType {
  async fn id(&self) -> &str {
    &self.id
  }
  async fn name(&self) -> &str {
    &self.name
  }
  #[graphql(name = "workspaceId")]
  async fn workspace_id(&self) -> &Option<String> {
    &self.workspace_id
  }
  #[graphql(name = "createdAt")]
  async fn created_at(&self) -> i64 {
    self.created_at
  }

  async fn blobs(&self, ctx: &Context<'_>) -> Result<Vec<CopilotContextBlobType>> {
    let items = load_copilot_context_items(ctx, &self.id).await?;
    let (state, _) = crate::graphql::utils::require_session(ctx).await?;
    let workspace = self
      .workspace_id
      .as_deref()
      .and_then(|id| uuid::Uuid::parse_str(id).ok());
    let mut result = Vec::new();
    for item in items
      .into_iter()
      .filter(|item| item.item_type == myoxus_domain::entities::CopilotContextItemType::Blob)
    {
      let item = current_context_file_status(&state, workspace, item).await?;
      result.push(CopilotContextBlobType {
        id: item.item_ref.clone(),
        created_at: item.created_at.timestamp_millis(),
        status: Some(context_ingestion_status(&item)),
      });
    }
    Ok(result)
  }

  async fn docs(&self, ctx: &Context<'_>) -> Result<Vec<CopilotContextDocType>> {
    let items = load_context_items_by_type(ctx, &self.id, "doc").await?;
    let (state, snapshot) = crate::graphql::utils::require_session(ctx).await?;
    let workspace_id = self
      .workspace_id
      .as_deref()
      .and_then(|id| uuid::Uuid::parse_str(id).ok());
    let mut docs = Vec::with_capacity(items.len());
    for (item_ref, created_at) in items {
      let status = copilot_doc_context_status(&state, snapshot.user.id, workspace_id, &item_ref).await;
      docs.push(CopilotContextDocType {
        id: item_ref,
        created_at,
        status: Some(status),
      });
    }
    Ok(docs)
  }

  async fn files(&self, ctx: &Context<'_>) -> Result<Vec<CopilotContextFileType>> {
    let items = load_copilot_context_items(ctx, &self.id).await?;
    let (state, _) = crate::graphql::utils::require_session(ctx).await?;
    let workspace = self
      .workspace_id
      .as_deref()
      .and_then(|id| uuid::Uuid::parse_str(id).ok());
    let mut result = Vec::new();
    for item in items
      .into_iter()
      .filter(|item| item.item_type == myoxus_domain::entities::CopilotContextItemType::File)
    {
      result.push(project_copilot_context_file(
        &current_context_file_status(&state, workspace, item).await?,
      ));
    }
    Ok(result)
  }

  async fn tags(&self, ctx: &Context<'_>) -> Result<Vec<CopilotContextCategoryType>> {
    let items = load_copilot_context_items(ctx, &self.id).await?;
    Ok(
      items
        .into_iter()
        .filter(|item| item.item_type == myoxus_domain::entities::CopilotContextItemType::Tag)
        .map(|item| CopilotContextCategoryType {
          id: item.item_ref,
          created_at: item.created_at.timestamp_millis(),
          category_type: item
            .metadata
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("tag")
            .to_string(),
          docs: vec![],
        })
        .collect(),
    )
  }

  async fn collections(&self, ctx: &Context<'_>) -> Result<Vec<CopilotContextCategoryType>> {
    let items = load_copilot_context_items(ctx, &self.id).await?;
    Ok(
      items
        .into_iter()
        .filter(|item| item.item_type == myoxus_domain::entities::CopilotContextItemType::Collection)
        .map(|item| CopilotContextCategoryType {
          id: item.item_ref,
          created_at: item.created_at.timestamp_millis(),
          category_type: item
            .metadata
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("collection")
            .to_string(),
          docs: vec![],
        })
        .collect(),
    )
  }

  /// Search workspace file embeddings by semantic similarity.
  ///
  /// Query the productive index through the shared configured embedding port.
  /// Only finished, selected source identities are eligible; unavailable
  /// retrieval is an explicit error, not a successful empty search.
  #[graphql(name = "matchFiles")]
  #[tracing::instrument(skip_all, fields(context_id = %self.id))]
  async fn match_files(
    &self,
    ctx: &Context<'_>,
    content: String,
    limit: Option<i32>,
    scoped_threshold: Option<f64>,
    threshold: Option<f64>,
  ) -> Result<Vec<CopilotContextMatchedFileType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;

    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_id = self
      .workspace_id
      .as_deref()
      .and_then(|id| uuid::Uuid::parse_str(id).ok())
      .ok_or_else(|| async_graphql::Error::new("no workspace_id on context"))?;
    let context_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
    ensure_context_owned(state, snapshot.user.id, context_id, Some(workspace_id), true).await?;
    let selected_items = load_copilot_context_items(ctx, &self.id)
      .await?
      .into_iter()
      .filter(|item| {
        matches!(
          item.item_type,
          myoxus_domain::entities::CopilotContextItemType::File | myoxus_domain::entities::CopilotContextItemType::Blob
        ) && item.metadata["ingestStatus"] == "finished"
      })
      .collect::<Vec<_>>();
    let selected_files = selected_items
      .iter()
      .flat_map(|item| {
        let mut ids = vec![item.item_ref.clone()];
        if let Some(blob) = item.metadata["blobId"].as_str() {
          ids.push(blob.to_string());
        }
        ids
      })
      .collect::<std::collections::HashSet<_>>();

    if selected_files.is_empty() {
      return Ok(Vec::new());
    }
    let embedding_repo = state.copilot_embedding_repo().ok_or_else(retrieval_unavailable_error)?;
    if !embedding_repo
      .has_indexed_file_sources(
        workspace_id,
        &state.config.copilot.embedding.model,
        state.config.copilot.embedding.dimensions,
        &selected_files.iter().cloned().collect::<Vec<_>>(),
      )
      .await
      .map_err(|_| retrieval_unavailable_error())?
    {
      return Err(retrieval_unavailable_error());
    }
    let embedding = state
      .embed_copilot_query(&content)
      .await
      .map_err(|_| retrieval_unavailable_error())?;

    let limit = limit.unwrap_or(5).clamp(1, 100);

    tracing::debug!(
      scoped_threshold = ?scoped_threshold,
      threshold = ?threshold,
      "matchFiles: filtering with thresholds"
    );

    let rows = embedding_repo
      .similarity_search_workspace_files(
        workspace_id,
        &embedding,
        limit,
        scoped_threshold.or(threshold),
        &state.config.copilot.embedding.model,
        &selected_files.iter().cloned().collect::<Vec<_>>(),
      )
      .await
      .map_err(|e| {
        tracing::error!(error = %e, "matchFiles: pgvector query failed");
        async_graphql::Error::new(format!("embedding query error: {e}"))
      })?;

    tracing::info!(workspace_id = %workspace_id, results = rows.len(), "matchFiles: query complete");

    Ok(
      rows
        .into_iter()
        .filter_map(|row| {
          let item = selected_items
            .iter()
            .find(|item| item.item_ref == row.file_id || item.metadata["blobId"].as_str() == row.blob_id.as_deref())?;
          Some(CopilotContextMatchedFileType {
            file_id: item.item_ref.clone(),
            content: row.content,
            blob_id: row.blob_id.unwrap_or_else(|| row.file_id.clone()),
            name: item.metadata["name"].as_str().unwrap_or(&row.name).into(),
            mime_type: row.mime_type,
            chunk: row.chunk,
            // Cosine distance (0=identical, 2=opposite) — client expects raw distance
            score: row.distance,
          })
        })
        .collect(),
    )
  }

  /// Search workspace document embeddings by semantic similarity.
  ///
  /// Search the productive document index for the configured embedding model;
  /// current selection, ignored documents and live ACLs still bound results.
  #[graphql(name = "matchWorkspaceDocs")]
  #[tracing::instrument(skip_all, fields(context_id = %self.id))]
  async fn match_workspace_docs(
    &self,
    ctx: &Context<'_>,
    content: String,
    limit: Option<i32>,
    scoped_threshold: Option<f64>,
    threshold: Option<f64>,
  ) -> Result<Vec<CopilotContextMatchedDocType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;

    let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid = self
      .workspace_id
      .as_deref()
      .and_then(|id| uuid::Uuid::parse_str(id).ok())
      .ok_or_else(|| async_graphql::Error::new("no workspace_id on context"))?;
    let context_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid context id"))?;
    ensure_context_owned(state, snapshot.user.id, context_id, Some(workspace_uuid), true).await?;
    let items = load_copilot_context_items(ctx, &self.id).await?;
    let mut scope = std::collections::HashSet::new();
    for item in &items {
      let mut refs = Vec::new();
      if item.item_type == myoxus_domain::entities::CopilotContextItemType::Doc {
        refs.push(item.item_ref.as_str());
      }
      if let Some(docs) = item.metadata.get("docs").and_then(serde_json::Value::as_array) {
        refs.extend(docs.iter().filter_map(serde_json::Value::as_str));
      }
      for id in refs {
        let id = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, id).await?;
        auth::assert_copilot_doc_access(state, snapshot.user.id, workspace_uuid, id).await?;
        scope.insert(id);
      }
    }
    let ignored = state
      .copilot()
      .get_workspace_state(workspace_uuid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .map(|state| state.ignored_doc_ids)
      .unwrap_or_default();

    let embedding_repo = state.copilot_embedding_repo().ok_or_else(retrieval_unavailable_error)?;
    let index = embedding_repo
      .workspace_index_status(
        workspace_uuid,
        &state.config.copilot.embedding.model,
        state.config.copilot.embedding.dimensions,
      )
      .await
      .map_err(|_| retrieval_unavailable_error())?;
    if index.embedded == 0 {
      return Err(retrieval_unavailable_error());
    }
    let embedding = state
      .embed_copilot_query(&content)
      .await
      .map_err(|_| retrieval_unavailable_error())?;

    let limit = limit.unwrap_or(5).clamp(1, 100);

    tracing::debug!(
      scoped_threshold = ?scoped_threshold,
      threshold = ?threshold,
      "matchWorkspaceDocs: filtering with thresholds"
    );

    let rows = embedding_repo
      .similarity_search_workspace_docs(
        workspace_uuid,
        &embedding,
        limit,
        if scope.is_empty() {
          threshold
        } else {
          scoped_threshold.or(threshold)
        },
        &state.config.copilot.embedding.model,
        &scope.iter().copied().collect::<Vec<_>>(),
      )
      .await
      .map_err(|e| {
        tracing::error!(error = %e, "matchWorkspaceDocs: pgvector query failed");
        async_graphql::Error::new(format!("embedding query error: {e}"))
      })?;

    tracing::info!(workspace_id = %workspace_uuid, results = rows.len(), "matchWorkspaceDocs: query complete");

    let mut allowed = Vec::with_capacity(rows.len());
    for row in rows {
      if ignored.contains(&row.doc_id) || (!scope.is_empty() && !scope.contains(&row.doc_id)) {
        continue;
      }
      if auth::can_read_copilot_doc(state, snapshot.user.id, workspace_uuid, row.doc_id).await? {
        allowed.push(row);
      }
    }
    Ok(
      allowed
        .into_iter()
        .map(|row| CopilotContextMatchedDocType {
          doc_id: row.doc_id.to_string(),
          content: row.content,
          chunk: row.chunk,
          // Cosine distance (0=identical, 2=opposite) — client expects raw distance
          score: row.distance,
        })
        .collect(),
    )
  }
}

fn retrieval_unavailable_error() -> async_graphql::Error {
  async_graphql::Error::new("Workspace retrieval is unavailable")
    .extend_with(|_, extensions| extensions.set("code", "COPILOT_RETRIEVAL_UNAVAILABLE"))
}

/// Load context items of a given type, returns Vec<(item_ref, created_at_millis)>.
async fn load_context_items_by_type(
  ctx: &Context<'_>,
  context_id: &str,
  item_type: &str,
) -> Result<Vec<(String, i64)>> {
  let expected_type = copilot_item_type_from_key(item_type);
  Ok(
    load_copilot_context_items(ctx, context_id)
      .await?
      .into_iter()
      .filter(|item| item.item_type == expected_type)
      .map(|item| (item.item_ref, item.created_at.timestamp_millis()))
      .collect(),
  )
}

// ─── WorkspaceEmbeddingType sub-resolvers ────────────────────────────────────

#[async_graphql::Object(name = "WorkspaceEmbeddingType")]
impl WorkspaceEmbeddingType {
  async fn files(
    &self,
    ctx: &Context<'_>,
    pagination: Option<auth::PaginationInputType>,
  ) -> Result<PaginatedCopilotWorkspaceFilesType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "Internal error")?;
    let empty = PaginatedCopilotWorkspaceFilesType {
      total_count: 0,
      page_info: auth::PageInfoType {
        has_next_page: false,
        has_previous_page: false,
        end_cursor: None,
        start_cursor: None,
      },
      edges: Vec::new(),
    };
    let Some(workspace_state) = state
      .copilot()
      .get_workspace_state(self.workspace_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
    else {
      return Ok(empty);
    };
    let files = workspace_state
      .metadata
      .get("workspaceFiles")
      .and_then(|v| v.as_array())
      .cloned()
      .unwrap_or_default();
    let total_count = files.len() as i32;
    let pagination = pagination.unwrap_or_default();
    let skip = pagination.offset.unwrap_or(0).max(0) as usize;
    let take = pagination.first.unwrap_or(20).clamp(1, 100) as usize;
    let page: Vec<CopilotWorkspaceFileType> = files
      .into_iter()
      .skip(skip)
      .take(take)
      .filter_map(|f| {
        let created_at_str = f.get("createdAt")?.as_str()?;
        let created_at = DateTime::parse_from_rfc3339(created_at_str).ok()?.with_timezone(&Utc);
        Some(CopilotWorkspaceFileType {
          id: f.get("id")?.as_str()?.to_string(),
          blob_id: f.get("blobId")?.as_str()?.to_string(),
          name: f.get("name")?.as_str()?.to_string(),
          mime_type: f
            .get("mimeType")
            .and_then(|v| v.as_str())
            .unwrap_or("application/octet-stream")
            .to_string(),
          created_at,
          size: f.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
          workspace_id: f.get("workspaceId")?.as_str()?.to_string(),
        })
      })
      .collect();
    let has_next_page = (skip + take) < total_count as usize;
    Ok(PaginatedCopilotWorkspaceFilesType {
      total_count,
      page_info: auth::PageInfoType {
        has_next_page,
        has_previous_page: skip > 0,
        end_cursor: None,
        start_cursor: None,
      },
      edges: page.into_iter().map(|node| CopilotWorkspaceFileEdge { node }).collect(),
    })
  }

  #[graphql(name = "ignoredDocs")]
  async fn ignored_docs(
    &self,
    ctx: &Context<'_>,
    pagination: Option<auth::PaginationInputType>,
  ) -> Result<PaginatedCopilotIgnoredDocsType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "Internal error")?;
    let workspace_state = state
      .copilot()
      .get_workspace_state(self.workspace_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let all_entries = workspace_state
      .map(|workspace_state| ignored_doc_entries(&workspace_state))
      .unwrap_or_default();
    let total_count = all_entries.len() as i32;
    let pagination = pagination.unwrap_or_default();
    let skip = pagination.offset.unwrap_or(0).max(0) as usize;
    let take = pagination.first.unwrap_or(20).clamp(1, 100) as usize;
    let page = all_entries.into_iter().skip(skip).take(take).collect::<Vec<_>>();
    let has_next_page = (skip + take) < total_count as usize;
    let end_cursor = if page.is_empty() {
      None
    } else {
      Some(format!("{}", skip + page.len()))
    };
    let edges = page
      .into_iter()
      .map(|(doc_id, created_at)| CopilotIgnoredDocEdge {
        node: CopilotIgnoredDocNode {
          doc_id,
          created_at,
          doc_created_at: None,
          doc_updated_at: None,
          title: None,
          created_by: None,
          created_by_avatar: None,
          updated_by: None,
        },
      })
      .collect();
    Ok(PaginatedCopilotIgnoredDocsType {
      total_count,
      page_info: auth::PageInfoType {
        has_next_page,
        has_previous_page: skip > 0,
        end_cursor,
        start_cursor: if skip > 0 { Some(format!("{}", skip)) } else { None },
      },
      edges,
    })
  }

  #[graphql(name = "allIgnoredDocs")]
  async fn all_ignored_docs(&self, ctx: &Context<'_>) -> Result<Vec<CopilotIgnoredDocBasic>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "Internal error")?;
    let workspace_state = state
      .copilot()
      .get_workspace_state(self.workspace_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(
      workspace_state
        .map(|workspace_state| {
          ignored_doc_entries(&workspace_state)
            .into_iter()
            .map(|(doc_id, created_at)| CopilotIgnoredDocBasic { doc_id, created_at })
            .collect()
        })
        .unwrap_or_default(),
    )
  }
}

fn ignored_doc_entries(
  workspace_state: &myoxus_domain::entities::CopilotWorkspaceState,
) -> Vec<(String, Option<DateTime<Utc>>)> {
  let created_at_by_doc = workspace_state
    .metadata
    .get("ignoredDocCreatedAt")
    .and_then(serde_json::Value::as_object);
  workspace_state
    .ignored_doc_ids
    .iter()
    .map(|doc_id| {
      let doc_id = doc_id.to_string();
      let created_at = created_at_by_doc
        .and_then(|timestamps| timestamps.get(&doc_id))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
      (doc_id, created_at)
    })
    .collect()
}

// Copilot helpers extracted to graphql/copilot_helpers.rs (P22-B-03 / P22-C-01).
use copilot_helpers::{
  create_copilot_system_job, fetch_transcription_job_for_owner, persist_workspace_file, persist_workspace_file_removal,
  persist_workspace_ignored_docs,
};

// Config helpers are imported locally where needed (see adminUpdateConfig resolver).

pub const USER_FEATURE_UNLIMITED_COPILOT: &str = "unlimited_copilot";
/// `user_features.feature_name` value for the global Manager capability.
/// Together with an `organization_unit_member` membership whose role is
/// `manager`, this enables Manager actions. See learning
/// `LRN-20260502-ORG-A-01`.
pub const USER_FEATURE_MANAGER: &str = "manager";

#[derive(Default, Clone, Copy)]
pub(crate) struct UserFeatureOverrides {
  pub(crate) unlimited_copilot: Option<bool>,
}

fn default_user_feature_set(state: &crate::state::ApiState) -> Vec<auth::FeatureType> {
  state
    .config
    .compat
    .features
    .user
    .iter()
    .copied()
    .filter(|feature| is_runtime_user_feature(*feature))
    .map(auth::FeatureType::from)
    .collect::<Vec<_>>()
}

fn is_runtime_user_feature(feature: crate::config::CompatibilityFeature) -> bool {
  !matches!(
    feature,
    crate::config::CompatibilityFeature::Admin
      | crate::config::CompatibilityFeature::FreePlan
      | crate::config::CompatibilityFeature::LifetimeProPlan
      | crate::config::CompatibilityFeature::ProPlan
      | crate::config::CompatibilityFeature::TeamPlan
      | crate::config::CompatibilityFeature::UnlimitedWorkspace
  )
}

fn is_runtime_workspace_feature(feature: crate::config::CompatibilityFeature) -> bool {
  !matches!(
    feature,
    crate::config::CompatibilityFeature::Admin
      | crate::config::CompatibilityFeature::FreePlan
      | crate::config::CompatibilityFeature::LifetimeProPlan
      | crate::config::CompatibilityFeature::ProPlan
      | crate::config::CompatibilityFeature::TeamPlan
      | crate::config::CompatibilityFeature::UnlimitedWorkspace
  )
}

fn has_effective_feature(
  is_admin: bool,
  defaults: &[auth::FeatureType],
  overrides: UserFeatureOverrides,
  feature: auth::FeatureType,
) -> bool {
  match feature {
    auth::FeatureType::Admin => is_admin,
    auth::FeatureType::UnlimitedCopilot => overrides
      .unlimited_copilot
      .unwrap_or_else(|| defaults.contains(&auth::FeatureType::UnlimitedCopilot)),
    _ => defaults.contains(&feature),
  }
}

async fn load_user_feature_overrides(
  state: &crate::state::ApiState,
  user_ids: &[uuid::Uuid],
) -> Result<HashMap<uuid::Uuid, UserFeatureOverrides>> {
  state
    .auth()
    .user_feature_overrides(user_ids, USER_FEATURE_UNLIMITED_COPILOT)
    .await
    .map(|overrides| {
      overrides
        .into_iter()
        .map(|(user_id, activated)| {
          (
            user_id,
            UserFeatureOverrides {
              unlimited_copilot: Some(activated),
            },
          )
        })
        .collect()
    })
    .map_err(crate::graphql::utils::map_gql_error)
}

pub async fn persist_user_feature_override(
  state: &crate::state::ApiState,
  user_id: uuid::Uuid,
  feature_name: &str,
  activated: bool,
) -> Result<()> {
  state
    .auth()
    .set_user_feature_override(user_id, feature_name, activated, "admin panel")
    .await
    .map_err(crate::graphql::utils::map_gql_error)
}

pub async fn list_users_with_feature_filter(
  state: &Arc<crate::state::ApiState>,
  keyword: Option<String>,
  features: Option<Vec<auth::FeatureType>>,
) -> Result<Vec<myoxus_domain::entities::User>> {
  let default_user_features = default_user_feature_set(state);
  let features = features.unwrap_or_default();
  if features.is_empty() {
    return state
      .admin()
      .list_users(0, 10_000, keyword)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()));
  }

  let mut offset = 0_i64;
  let mut matched = Vec::new();
  loop {
    let batch = state
      .admin()
      .list_users(offset, 500, keyword.clone())
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;
    if batch.is_empty() {
      break;
    }
    matched.extend(batch);
    offset += 500;
  }

  let user_ids = matched.iter().map(|user| user.id).collect::<Vec<_>>();
  let overrides_by_user = load_user_feature_overrides(state, &user_ids).await?;

  Ok(
    matched
      .into_iter()
      .filter(|user| {
        let overrides = overrides_by_user
          .get(&user.id)
          .copied()
          .unwrap_or_else(UserFeatureOverrides::default);
        user_matches_features(user.is_admin, &default_user_features, overrides, &features)
      })
      .collect(),
  )
}

pub async fn build_admin_workspace_compat(
  state: &Arc<crate::state::ApiState>,
  ws: myoxus_domain::entities::Workspace,
) -> Result<AdminWorkspaceType> {
  let owner = state
    .workspace()
    .get_owner(ws.id)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?
    .map(|owner| AdminWorkspaceOwnerType {
      id: owner.id.to_string(),
      email: owner.email,
      name: owner.name,
      avatar_url: owner.avatar_url,
    });
  let ws_features = state
    .config
    .compat
    .features
    .workspace
    .iter()
    .copied()
    .filter(|f| is_runtime_workspace_feature(*f))
    .map(auth::FeatureType::from)
    .collect::<Vec<_>>();
  let (
    storage_quota_bytes,
    owner_principal_type,
    owner_principal_id,
    owner_principal_name,
    git_sync_profile_id,
    git_sync_trigger_mode,
    git_sync_next_scheduled_at,
    git_sync_last_status,
    git_sync_last_run_at,
  ) = {
    let details = state
      .admin()
      .workspace_details(ws.id)
      .await
      .map_err(|error| async_graphql::Error::new(format!("workspace owner projection query failed: {error}")))?;
    if let Some(details) = details {
      (
        details.storage_quota_bytes,
        details.owner_principal_type,
        details.owner_principal_id.map(|id| id.to_string()),
        details.owner_principal_name,
        details.git_sync_profile_id.map(|id| id.to_string()),
        details.git_sync_trigger_mode,
        details.git_sync_next_scheduled_at,
        details.git_sync_last_status,
        details.git_sync_last_run_at,
      )
    } else {
      (
        None,
        if ws.owner_user_id.is_some() { "user" } else { "system" }.to_string(),
        ws.owner_user_id.map(|id| id.to_string()),
        None,
        None,
        None,
        None,
        None,
        None,
      )
    }
  };
  let rotation = if let (Some(service), Some(profile_id)) = (
    state.git_token_rotation_service(),
    git_sync_profile_id
      .as_deref()
      .and_then(|profile_id| Uuid::parse_str(profile_id).ok()),
  ) {
    service
      .status(profile_id)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?
  } else {
    None
  };
  Ok(AdminWorkspaceType {
    id: ws.id.to_string(),
    name: Some(ws.name),
    public: ws.public,
    created_at: ws.created_at,
    enable_ai: ws.enable_ai,
    enable_sharing: ws.enable_sharing,
    enable_url_preview: ws.enable_url_preview,
    enable_doc_embedding: ws.enable_doc_embedding,
    owner,
    owner_principal_type,
    owner_principal_id,
    owner_principal_name,
    features: ws_features,
    storage_quota_bytes,
    git_sync_profile_id,
    git_sync_trigger_mode,
    git_sync_next_scheduled_at,
    git_sync_last_status,
    git_sync_last_run_at,
    git_sync_token_rotation_provider: rotation
      .as_ref()
      .map(|status| crate::graphql::git_sync::map_token_rotation_provider(status.provider)),
    git_sync_token_rotation_enabled: rotation.as_ref().map(|status| status.enabled),
    git_sync_token_rotation_state: rotation
      .map(|status| crate::graphql::git_sync::map_token_rotation_state(status.state)),
  })
}

fn normalize_required_input(field_name: &str, value: &str) -> Result<String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return Err(async_graphql::Error::new(format!("{field_name} must not be empty")));
  }
  Ok(trimmed.to_string())
}

fn normalize_optional_secret(value: Option<&str>) -> Option<String> {
  value.filter(|value| !value.trim().is_empty()).map(str::to_string)
}

fn normalize_optional_credential_identity(value: Option<&str>) -> Option<String> {
  value
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

fn normalize_root_path(root_path: &str) -> Result<String> {
  let root_path = root_path.trim();
  if root_path.is_empty() {
    return Err(async_graphql::Error::new("rootPath must not be empty"));
  }
  if root_path.starts_with('/') {
    return Err(async_graphql::Error::new(
      "rootPath must be relative and must not start with '/'",
    ));
  }
  if root_path.contains('\\') {
    return Err(async_graphql::Error::new("rootPath must not contain backslashes"));
  }
  if root_path.contains('\0') {
    return Err(async_graphql::Error::new("rootPath must not contain null bytes"));
  }
  if root_path.split('/').any(|segment| segment == "..") {
    return Err(async_graphql::Error::new(
      "rootPath must not contain '..' path traversal segments",
    ));
  }

  let mut normalized = root_path.to_string();
  if !normalized.ends_with('/') {
    normalized.push('/');
  }
  Ok(normalized)
}

fn build_credential_payload(
  auth_method: myoxus_domain::git_sync::AuthMethod,
  input: &git_sync::GitSyncProfileInput,
) -> Result<Vec<u8>> {
  build_credential_payload_fields(
    auth_method,
    input.token.as_deref(),
    input.password.as_deref(),
    input.username.as_deref(),
    input.ssh_private_key.as_deref(),
    input.ssh_passphrase.as_deref(),
  )
}

fn build_credential_payload_fields(
  auth_method: myoxus_domain::git_sync::AuthMethod,
  token: Option<&str>,
  password: Option<&str>,
  username: Option<&str>,
  ssh_private_key: Option<&str>,
  ssh_passphrase: Option<&str>,
) -> Result<Vec<u8>> {
  let payload = match auth_method {
    myoxus_domain::git_sync::AuthMethod::HttpsToken => {
      let token = normalize_optional_secret(token)
        .ok_or_else(|| async_graphql::Error::new("token required for HttpsToken authentication"))?;
      let username = normalize_optional_credential_identity(username);
      json!({
        "token": token,
        "username": username,
      })
    }
    myoxus_domain::git_sync::AuthMethod::HttpsPassword => {
      let password = normalize_optional_secret(password)
        .ok_or_else(|| async_graphql::Error::new("password required for HttpsPassword authentication"))?;
      let username = normalize_optional_credential_identity(username)
        .ok_or_else(|| async_graphql::Error::new("username required for HttpsPassword authentication"))?;
      json!({
        "username": username,
        "password": password,
      })
    }
    myoxus_domain::git_sync::AuthMethod::SshKey => {
      let private_key = normalize_optional_secret(ssh_private_key)
        .ok_or_else(|| async_graphql::Error::new("sshPrivateKey required for SshKey authentication"))?;
      let passphrase = normalize_optional_secret(ssh_passphrase);
      json!({
        "privateKey": private_key,
        "passphrase": passphrase,
      })
    }
  };

  serde_json::to_vec(&payload).map_err(|e| async_graphql::Error::new(format!("invalid credential payload: {e}")))
}

fn maybe_i64(value: async_graphql::MaybeUndefined<i64>) -> Option<Option<i64>> {
  match value {
    async_graphql::MaybeUndefined::Undefined => None,
    async_graphql::MaybeUndefined::Null => Some(None),
    async_graphql::MaybeUndefined::Value(value) => Some(Some(value)),
  }
}

fn maybe_string(value: async_graphql::MaybeUndefined<String>) -> Option<Option<String>> {
  match value {
    async_graphql::MaybeUndefined::Undefined => None,
    async_graphql::MaybeUndefined::Null => Some(None),
    async_graphql::MaybeUndefined::Value(value) => Some(Some(value)),
  }
}

fn git_sync_lifecycle_service(
  state: &Arc<crate::state::ApiState>,
  pool: sqlx::PgPool,
  policy: &EffectiveGitSyncPolicy,
  source: &'static str,
  actor_id: Option<uuid::Uuid>,
) -> GitSyncLifecycleService {
  let store = Arc::new(myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone()));
  let repository = state
    .git_sync_repository_builder()
    .build(pool, policy, source, actor_id);
  GitSyncLifecycleService::new(store, repository)
}

fn map_git_sync_lifecycle_error(error: GitSyncLifecycleError) -> async_graphql::Error {
  let (message, code) = match error {
    GitSyncLifecycleError::InvalidInput(message) => (message, "GitSyncInvalidInput".to_string()),
    GitSyncLifecycleError::Connection(failure) => (failure.message, failure.class.to_string()),
    GitSyncLifecycleError::Store(GitSyncLifecycleStoreError::NotFound) => {
      ("Git-Sync profile not found".to_string(), "GitSyncNotFound".to_string())
    }
    GitSyncLifecycleError::Store(GitSyncLifecycleStoreError::RunningSync) => (
      "Git-Sync profile has a running sync and cannot be changed".to_string(),
      "GitSyncRunning".to_string(),
    ),
    GitSyncLifecycleError::Store(GitSyncLifecycleStoreError::Conflict(message)) => {
      (message, "GitSyncConflict".to_string())
    }
    GitSyncLifecycleError::Store(GitSyncLifecycleStoreError::Storage(message)) => {
      tracing::error!(error = %message, "Git-Sync lifecycle persistence failed");
      (
        "Git-Sync lifecycle persistence failed".to_string(),
        "GitSyncPersistence".to_string(),
      )
    }
  };
  let field = if message.contains("timezone") || message.contains("IANA") {
    Some("cronTimezone")
  } else if message.contains("misfire") {
    Some("cronMisfirePolicy")
  } else if message.contains("Cron") {
    Some("cronExpression")
  } else {
    None
  };
  async_graphql::Error::new(message).extend_with(|_, extensions| {
    extensions.set("code", code);
    if let Some(field) = field {
      extensions.set("field", field);
    }
  })
}

fn map_git_sync_schedule_error(error: myoxus_application::scheduling::cron::CronScheduleError) -> async_graphql::Error {
  use myoxus_application::scheduling::cron::CronScheduleError;
  let field = match error {
    CronScheduleError::Timezone(_) => "cronTimezone",
    _ => "cronExpression",
  };
  async_graphql::Error::new(error.to_string()).extend_with(|_, extensions| {
    extensions.set("code", "GitSyncInvalidSchedule");
    extensions.set("field", field);
  })
}

fn user_matches_features(
  is_admin: bool,
  default_features: &[auth::FeatureType],
  overrides: UserFeatureOverrides,
  required: &[auth::FeatureType],
) -> bool {
  required
    .iter()
    .all(|feature| has_effective_feature(is_admin, default_features, overrides, *feature))
}

// SMTP testing helpers moved to graphql/config.rs (P22-C-01).

/// Extract the cache tuning status resolver body for use by the admin sub-root.
pub async fn resolve_admin_cache_tuning_status(
  state: &Arc<crate::state::ApiState>,
) -> Result<Vec<CacheTuningStatusType>> {
  let cache = &state.query_cache;
  let config = &state.config.cache;
  let effective = state.effective_config().await;
  let db_fixed_keys = effective
    .overrides
    .overrides
    .keys()
    .filter(|path| path.starts_with("cache.") && path.ends_with("_fixed_ttl_seconds"))
    .cloned()
    .collect::<std::collections::HashSet<_>>();

  let mut results = Vec::with_capacity(4);
  for (name, ttl_atomic) in cache.all_current_ttls() {
    let current_ttl = ttl_atomic.load(std::sync::atomic::Ordering::Acquire) as i32;
    let yaml_fixed = match name {
      "server_config" => config.server_config_fixed_ttl_seconds.is_some(),
      "user_features" => config.user_features_fixed_ttl_seconds.is_some(),
      "throttle_config" => config.throttle_config_fixed_ttl_seconds.is_some(),
      "ws_settings" => config.ws_settings_fixed_ttl_seconds.is_some(),
      _ => false,
    };
    let db_config_key = match name {
      "server_config" => "cache.server_config_fixed_ttl_seconds",
      "user_features" => "cache.user_features_fixed_ttl_seconds",
      "throttle_config" => "cache.throttle_config_fixed_ttl_seconds",
      "ws_settings" => "cache.ws_settings_fixed_ttl_seconds",
      _ => "",
    };
    let db_fixed = !db_config_key.is_empty() && db_fixed_keys.contains(db_config_key);
    let is_fixed_override = yaml_fixed || db_fixed;

    let tuning = state.metrics().cache_tuning_snapshot(name).await.unwrap_or_default();

    results.push(CacheTuningStatusType {
      name: name.to_string(),
      current_ttl_seconds: current_ttl,
      hit_rate_1h: tuning.hit_rate_1h,
      hit_rate_24h: tuning.hit_rate_24h,
      last_action: tuning.last_action,
      last_action_at: tuning.last_action_at,
      is_fixed_override,
    });
  }
  // P104-B/P104-C: Doc-Cache entries — tunable caches read current TTL from atomics,
  // non-tunable ones from config. Hit rates come from cache_tuning_metrics if available.
  let redis_cfg = &state.config.redis;
  let cache_cfg = &state.config.cache;

  // Tunable doc-caches: TTL from atomic (live), hit rates from metrics table.
  let tunable: &[(&str, bool)] = &[
    ("doc_snapshot", redis_cfg.doc_snapshot_cache_enabled),
    ("doc_metadata", redis_cfg.doc_metadata_cache_enabled),
    (
      "doc_metadata_projection",
      redis_cfg.doc_metadata_projection_cache_enabled,
    ),
    ("doc_timestamps", redis_cfg.doc_timestamps_cache_enabled),
  ];

  let tuning_handles = state.doc_cache_tuning();
  let tunable_ttls: [u64; 4] = if let Some(h) = tuning_handles {
    use std::sync::atomic::Ordering;
    [
      h.snapshot_ttl.load(Ordering::Acquire),
      h.metadata_ttl.load(Ordering::Acquire),
      h.metadata_projection_ttl.load(Ordering::Acquire),
      h.timestamps_ttl.load(Ordering::Acquire),
    ]
  } else {
    [
      redis_cfg.cache_ttl_doc_snapshot_seconds,
      redis_cfg.cache_ttl_doc_metadata_seconds,
      redis_cfg.cache_ttl_doc_metadata_projection_seconds,
      redis_cfg.cache_ttl_doc_timestamps_seconds,
    ]
  };
  let fixed_overrides: [Option<u64>; 4] = [
    cache_cfg.doc_snapshot_fixed_ttl_seconds,
    cache_cfg.doc_metadata_fixed_ttl_seconds,
    cache_cfg.doc_metadata_projection_fixed_ttl_seconds,
    cache_cfg.doc_timestamps_fixed_ttl_seconds,
  ];

  for (i, (name, enabled)) in tunable.iter().enumerate() {
    // Query last hit rates from cache_tuning_metrics if pool is available.
    let tuning = state.metrics().cache_tuning_snapshot(name).await.unwrap_or_default();
    let current_ttl = tunable_ttls[i];
    let is_fixed = fixed_overrides[i].is_some();
    results.push(CacheTuningStatusType {
      name: name.to_string(),
      current_ttl_seconds: if *enabled { current_ttl as i32 } else { -1 },
      hit_rate_1h: tuning.hit_rate_1h.filter(|value| !value.is_nan()),
      hit_rate_24h: tuning.hit_rate_24h.filter(|value| !value.is_nan()),
      last_action: tuning.last_action,
      last_action_at: tuning.last_action_at,
      is_fixed_override: is_fixed,
    });
  }

  // Non-tunable doc-caches (view_dedup, compaction_lock): static config only.
  let non_tunable: &[(&str, bool, u64)] = &[
    ("doc_view_dedup", redis_cfg.doc_view_dedup_enabled, 0),
    (
      "doc_compaction_lock",
      redis_cfg.compaction_lock_enabled,
      redis_cfg.compaction_lock_ttl_seconds,
    ),
  ];
  for (name, enabled, ttl) in non_tunable {
    results.push(CacheTuningStatusType {
      name: name.to_string(),
      current_ttl_seconds: if *enabled { *ttl as i32 } else { -1 },
      hit_rate_1h: None,
      hit_rate_24h: None,
      last_action: Some(if *enabled {
        "enabled".to_string()
      } else {
        "disabled".to_string()
      }),
      last_action_at: None,
      is_fixed_override: true,
    });
  }

  tracing::debug!(caches = results.len(), "adminCacheTuningStatus: returned status");
  Ok(results)
}

/// Extract the cache tuning history resolver body for use by the admin sub-root.
pub async fn resolve_admin_cache_tuning_history(
  state: &Arc<crate::state::ApiState>,
  cache_name: String,
  hours: Option<i32>,
) -> Result<Vec<CacheTuningHistoryPoint>> {
  let hours = hours.unwrap_or(24).clamp(1, 168) as i64;
  let rows = state
    .metrics()
    .cache_tuning_history(&cache_name, hours)
    .await
    .unwrap_or_default();
  Ok(
    rows
      .into_iter()
      .map(|row| CacheTuningHistoryPoint {
        bucket: row.bucket,
        hit_rate: row.hit_rate,
        ttl_seconds: row.ttl_seconds,
      })
      .collect(),
  )
}

/// Extract the logging config resolver body for use by the admin sub-root.
pub async fn resolve_logging_config(state: &Arc<crate::state::ApiState>) -> Result<GqlLoggingConfig> {
  let logging = state
    .logging()
    .ok_or_else(|| async_graphql::Error::new("logging service not available"))?;

  let levels = logging.current_levels().await;
  let modules: Vec<GqlLogModuleLevel> = levels
    .into_iter()
    .map(|l| GqlLogModuleLevel {
      group: l.group,
      display_name: l.display_name,
      level: l.current_level.to_string(),
      recommended_default: l.recommended_default.to_string(),
      description: l.description,
      high_volume_warning: l.high_volume_warning,
    })
    .collect();

  let history = logging.history().await;
  let recent_changes: Vec<GqlLogChangeEntry> = history
    .into_iter()
    .map(|e| GqlLogChangeEntry {
      timestamp: e.timestamp,
      group: e.group,
      previous_level: e.previous_level.to_string(),
      new_level: e.new_level.to_string(),
      changed_by: e.changed_by,
      auto_revert_at: e.auto_revert_at,
    })
    .collect();

  let configured = crate::graphql::admin_config::load_admin_config_json(state).await?;
  let configured_logging: crate::config::LoggingConfig = serde_json::from_value(
    configured
      .get("logging")
      .cloned()
      .unwrap_or_else(|| serde_json::json!({})),
  )
  .map_err(|error| async_graphql::Error::new(format!("invalid configured logging values: {error}")))?;
  let output = build_log_output_config(&configured_logging);
  let disk_usage = compute_log_disk_usage(configured_logging.file_path.as_deref());

  let available_levels = vec![
    GqlLogLevel::Trace,
    GqlLogLevel::Debug,
    GqlLogLevel::Info,
    GqlLogLevel::Warn,
    GqlLogLevel::Error,
  ];

  Ok(GqlLoggingConfig {
    modules,
    output,
    recent_changes,
    disk_usage,
    available_levels,
  })
}

/// Extract the admin dashboard resolver body for use by the admin sub-root.
/// Caller must have already verified admin access before calling this function.
pub async fn resolve_admin_dashboard(
  state: &Arc<crate::state::ApiState>,
  input: Option<AdminDashboardInput>,
) -> Result<AdminDashboardType> {
  let now = Utc::now();
  let input = input.unwrap_or_default();
  let sync_hours = input.sync_history_hours.unwrap_or(30).clamp(1, 168) as i64;
  let storage_days = input.storage_history_days.unwrap_or(30).clamp(1, 365) as i64;
  let timezone = input.timezone.unwrap_or_else(|| "UTC".to_string());

  let sync_window = TimeWindowType {
    from: now - chrono::Duration::hours(sync_hours),
    to: now,
    timezone: timezone.clone(),
    bucket: TimeBucket::Minute,
    requested_size: sync_hours as i32 * 60,
    effective_size: sync_hours as i32 * 60,
  };
  let storage_window = TimeWindowType {
    from: now - chrono::Duration::days(storage_days),
    to: now,
    timezone: timezone.clone(),
    bucket: TimeBucket::Day,
    requested_size: storage_days as i32,
    effective_size: storage_days as i32,
  };

  let pool = state.metrics_pool();
  let requests_total = state.request_count();
  let requests_error_total = state.request_error_count();
  let uptime_seconds = state.uptime_seconds();
  let runtime = AdminDashboardRuntimeType {
    process_uptime_seconds: uptime_seconds.min(i64::MAX as u64) as i64,
    requests_total: requests_total.min(i64::MAX as u64) as i64,
    requests_error_total: requests_error_total.min(i64::MAX as u64) as i64,
    request_error_rate: if requests_total == 0 {
      0.0
    } else {
      requests_error_total as f64 / requests_total as f64
    },
    request_throughput_rps: if uptime_seconds == 0 {
      0.0
    } else {
      requests_total as f64 / uptime_seconds as f64
    },
    request_latency_avg_ms: if requests_total == 0 {
      0.0
    } else {
      (state.request_latency_total_micros() as f64 / requests_total as f64) / 1000.0
    },
    request_latency_max_ms: state.request_latency_max_micros() as f64 / 1000.0,
  };

  let queue_metrics = crate::handlers::metrics::collect_worker_queue_metrics(state)
    .await
    .unwrap_or_default();
  let queue_summary = AdminDashboardQueueSummaryType {
    pending_ready_total: queue_metrics.iter().map(|q| q.pending_ready).sum(),
    failed_total: queue_metrics.iter().map(|q| q.failed).sum(),
    queues: queue_metrics
      .into_iter()
      .map(|q| AdminDashboardQueueMetricType {
        queue: q.queue,
        pending_ready: q.pending_ready,
        failed: q.failed,
        dead_letter: q.dead_letter,
        queue_lag_seconds: q.queue_lag_seconds,
      })
      .collect(),
  };

  let metrics_service = state.metrics();
  let effective_config = state.effective_config().await;
  let metrics_counters = metrics_service.recorder().counters();
  let metrics_last_flush_at = metrics_service
    .last_flush_unix_secs()
    .and_then(|s| DateTime::<Utc>::from_timestamp(s as i64, 0));
  let metrics_persisted_24h = metrics_service
    .count_recent(Utc::now() - chrono::Duration::hours(24))
    .await
    .ok()
    .map(|n| n.min(i64::MAX as u64) as i64);
  let metrics_daily_rollups_7d = metrics_service
    .count_daily_since(
      (Utc::now() - chrono::Duration::days(7))
        .date_naive()
        .max(chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()),
    )
    .await
    .ok()
    .map(|n| n.min(i64::MAX as u64) as i64);
  let metrics_pipeline = AdminDashboardMetricsPipelineType {
    enabled: effective_config
      .bool("metrics.enabled")
      .unwrap_or(state.config_file_baseline.metrics.enabled),
    prometheus_enabled: effective_config
      .bool("metrics.prometheus_enabled")
      .unwrap_or(state.config_file_baseline.metrics.prometheus_enabled),
    persistence_enabled: state.config.metrics.persistence_enabled,
    active_series: metrics_service.active_series().min(i64::MAX as usize) as i64,
    persisted_24h: metrics_persisted_24h,
    daily_rollups_7d: metrics_daily_rollups_7d,
    last_flush_at: metrics_last_flush_at,
    last_flush_count: metrics_service.last_flush_count().min(i64::MAX as u64) as i64,
    flush_interval_seconds: state.config.metrics.flush_interval_seconds.min(i64::MAX as u64) as i64,
    offered_total: metrics_counters
      .offered_total
      .load(Ordering::Relaxed)
      .min(i64::MAX as u64) as i64,
    accepted_total: metrics_counters
      .accepted_total
      .load(Ordering::Relaxed)
      .min(i64::MAX as u64) as i64,
    rejected_disabled_total: metrics_counters
      .rejected_disabled_total
      .load(Ordering::Relaxed)
      .min(i64::MAX as u64) as i64,
    cardinality_drops_total: metrics_counters
      .cardinality_drops_total
      .load(Ordering::Relaxed)
      .min(i64::MAX as u64) as i64,
  };

  let telemetry_service = state.telemetry();
  let telemetry_counters = telemetry_service.counters();
  let telemetry_offered = telemetry_counters.offered_total.load(Ordering::Relaxed);
  let telemetry_duplicates = telemetry_counters.rejected_duplicate_total.load(Ordering::Relaxed);
  let telemetry_pipeline = AdminDashboardTelemetryPipelineType {
    enabled: state.config.telemetry.enabled,
    hot_buffer_len: telemetry_service.buffer_len().await.min(i64::MAX as usize) as i64,
    persisted_24h: telemetry_service
      .persisted_since(Utc::now() - chrono::Duration::hours(24))
      .await
      .ok()
      .map(|n| n.min(i64::MAX as u64) as i64),
    daily_rollups_7d: telemetry_service
      .daily_rollups_since((Utc::now() - chrono::Duration::days(7)).date_naive())
      .await
      .ok()
      .map(|n| n.min(i64::MAX as u64) as i64),
    last_flush_at: telemetry_service
      .last_flush_unix_secs()
      .and_then(|s| DateTime::<Utc>::from_timestamp(s as i64, 0)),
    last_flush_count: telemetry_service.last_flush_count().min(i64::MAX as u64) as i64,
    offered_total: telemetry_offered.min(i64::MAX as u64) as i64,
    accepted_total: telemetry_counters
      .accepted_total
      .load(Ordering::Relaxed)
      .min(i64::MAX as u64) as i64,
    rejected_total: [
      telemetry_counters.rejected_disabled_total.load(Ordering::Relaxed),
      telemetry_counters.rejected_category_total.load(Ordering::Relaxed),
      telemetry_counters.rejected_sampled_total.load(Ordering::Relaxed),
      telemetry_counters.rejected_duplicate_total.load(Ordering::Relaxed),
      telemetry_counters.rejected_invalid_total.load(Ordering::Relaxed),
    ]
    .into_iter()
    .sum::<u64>()
    .min(i64::MAX as u64) as i64,
    buffer_overflow_total: telemetry_counters
      .buffer_overflow_total
      .load(Ordering::Relaxed)
      .min(i64::MAX as u64) as i64,
    dedupe_hit_rate: if telemetry_offered == 0 {
      0.0
    } else {
      (telemetry_duplicates as f64 / telemetry_offered as f64).clamp(0.0, 1.0)
    },
  };

  let captcha = AdminDashboardCaptchaType {
    enabled: state.config.captcha.enabled,
    hmac_key_configured: !state.config.captcha.hmac_key.trim().is_empty(),
    verified_total: state.captcha_verified_count().min(i64::MAX as u64) as i64,
    rejected_total: state.captcha_rejected_count().min(i64::MAX as u64) as i64,
    honeypot_total: state.captcha_honeypot_count().min(i64::MAX as u64) as i64,
  };

  let cache_entry_counts: HashMap<&'static str, u64> = state.query_cache.all_entry_counts().into_iter().collect();
  let cache_metrics = state
    .query_cache
    .all_metrics()
    .into_iter()
    .map(|m| AdminDashboardCacheMetricType {
      name: m.name.to_string(),
      hits_total: m.hits_total().min(i64::MAX as u64) as i64,
      misses_total: m.misses_total().min(i64::MAX as u64) as i64,
      hit_rate: m.hit_rate(),
      invalidations_local_total: m.invalidations_local_total().min(i64::MAX as u64) as i64,
      invalidations_remote_total: m.invalidations_remote_total().min(i64::MAX as u64) as i64,
      entry_count: cache_entry_counts
        .get(m.name)
        .copied()
        .unwrap_or(0)
        .min(i64::MAX as u64) as i64,
    })
    .collect();

  let projection = state
    .admin()
    .dashboard_projection(sync_hours as i32, storage_days as i32)
    .await
    .unwrap_or_default();
  let sync_active_users = projection.sync_active_users as i32;
  let copilot_conversations = state.copilot().count_active_sessions().await.unwrap_or(0);
  let workspace_storage_bytes = projection.workspace_storage_bytes;
  let blob_storage_bytes = projection.blob_storage_bytes;
  let sync_active_users_timeline = projection
    .sync_active_users_timeline
    .into_iter()
    .map(|(minute, active_users)| AdminDashboardMinutePointType { minute, active_users })
    .collect();
  let workspace_storage_history = projection
    .workspace_storage_history
    .into_iter()
    .map(|(date, value)| AdminDashboardValueDayPointType { date, value })
    .collect();
  let blob_storage_history = projection
    .blob_storage_history
    .into_iter()
    .map(|(date, value)| AdminDashboardValueDayPointType { date, value })
    .collect();
  let top_shared_links = projection
    .top_shared_links
    .into_iter()
    .map(|link| {
      let workspace_id = link.workspace_id.to_string();
      let share_url = format!(
        "{}/public/{}/{}",
        state.config.server.origin.trim_end_matches('/'),
        workspace_id,
        link.doc_id
      );
      AdminSharedLinkTopItemType {
        workspace_id,
        doc_id: link.doc_id,
        title: (!link.title.is_empty()).then_some(link.title),
        share_url,
        published_at: link.published_at,
        views: link.total_views,
        unique_views: link.unique_views,
        guest_views: link.guest_views,
        last_accessed_at: link.last_viewed_at.or(link.published_at),
      }
    })
    .collect();
  let db_pool = if let Some(pool) = &pool {
    let pool_size = pool.size() as i64;
    let pool_idle = pool.num_idle() as i64;
    Some(AdminDashboardDbPoolType {
      active: pool_size.saturating_sub(pool_idle),
      idle: pool_idle,
      max: pool_size,
      user_count: state.admin().count_users(None).await.ok(),
      workspace_count: state
        .admin()
        .count_workspaces(&myoxus_application::admin::AdminWorkspaceFilter::default())
        .await
        .ok(),
    })
  } else {
    None
  };

  Ok(AdminDashboardType {
    sync_active_users,
    sync_active_users_timeline,
    sync_window,
    copilot_conversations,
    workspace_storage_bytes,
    blob_storage_bytes,
    workspace_storage_history,
    blob_storage_history,
    storage_window: storage_window.clone(),
    top_shared_links,
    top_shared_links_window: storage_window,
    runtime,
    queue_summary,
    metrics_pipeline,
    telemetry_pipeline,
    captcha,
    db_pool,
    cache_metrics,
    generated_at: now,
  })
}

/// Extract the import_users resolver body for use by the admin sub-root.
pub async fn perform_import_users(
  state: &Arc<crate::state::ApiState>,
  input: ImportUsersInput,
) -> Result<Vec<UserImportResultType>> {
  let valid_emails: Vec<String> = input
    .users
    .iter()
    .filter_map(|item| {
      let e = item.email.trim().to_lowercase();
      if !e.is_empty() && e.contains('@') {
        Some(e)
      } else {
        None
      }
    })
    .collect();
  let existing_emails = state
    .auth()
    .store
    .get_existing_emails(&valid_emails)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;

  let mut out = Vec::with_capacity(input.users.len());
  for item in input.users {
    let email = item.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
      out.push(UserImportResultType::Failed(UserImportFailedType {
        email: item.email,
        error: "invalid email".to_string(),
      }));
      continue;
    }
    if existing_emails.contains(&email) {
      out.push(UserImportResultType::Failed(UserImportFailedType {
        email: email.clone(),
        error: "email already used".to_string(),
      }));
      continue;
    }
    let password = item.password.filter(|password| !password.is_empty());
    if let Some(password) = password.as_deref()
      && let Err(error) = state.auth().validate_password(password).await
    {
      out.push(UserImportResultType::Failed(UserImportFailedType {
        email: email.clone(),
        error: error.to_string(),
      }));
      continue;
    }
    match state
      .auth()
      .store
      .fulfill_user(&email, item.name.as_deref(), None)
      .await
    {
      Ok(user) => {
        if let Err(err) = state
          .workspace()
          .ensure_personal_workspace(user.id, item.name.as_deref())
          .await
        {
          out.push(UserImportResultType::Failed(UserImportFailedType {
            email: email.clone(),
            error: format!("user created but workspace provisioning failed: {err}"),
          }));
          continue;
        }
        if let Some(password) = password.as_deref() {
          state
            .auth()
            .set_user_password(user.id, password)
            .await
            .map_err(crate::graphql::utils::map_gql_error)?;
        }
        let user = state
          .auth()
          .get_user_by_id(user.id)
          .await
          .map_err(crate::graphql::utils::map_gql_error)?
          .ok_or_else(|| async_graphql::Error::new("user not found"))?;
        out.push(UserImportResultType::User(auth::UserType::from(user)));
      }
      Err(err) => out.push(UserImportResultType::Failed(UserImportFailedType {
        email,
        error: err.to_string(),
      })),
    }
  }
  Ok(out)
}
