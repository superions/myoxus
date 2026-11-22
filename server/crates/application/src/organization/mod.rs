//! Organization domain — application services.
//!
//! Wraps the `OrganizationRepository`, `OrganizationUnitTypeRepository`,
//! `OrganizationUnitRepository`, `OrganizationUnitMemberRepository`,
//! `OrganizationUnitWorkspaceRepository`, `OrganizationPolicyRepository`,
//! and `OrganizationProjectRequestRepository` traits with permission-aware
//! services that the GraphQL layer (Paket D) consumes.
//!
//! Konzept: `todo/organization-management-concept.md`
//! Vertrag: `docs/dev/server/organization-management.md`
//! Learnings: `learnings/organization-management.md`
//!
//! Manager authority comes from a Manager membership in an active OU. The
//! account-level Manager badge reflects those memberships. Workspace actions
//! use the effective workspace role materialized from direct and OU roles.

pub mod import_export;
pub mod membership;
pub mod oidc_directory;
pub mod oidc_sync;
pub mod permission;
pub mod project_request;
pub mod read;
pub mod template_context;
pub mod unit_lifecycle;

pub use import_export::{
  CsvFile, ImportError, ImportSummary, JSON_SCHEMA_VERSION, OrganizationImportCommit, OrganizationImportExportService,
  OrganizationImportFormat, OrganizationImportPresence, OrganizationImportWriter, OrganizationSnapshot,
  OrganizationSnapshotMember, OrganizationSnapshotOrganization, OrganizationSnapshotPolicy, OrganizationSnapshotUnit,
  OrganizationSnapshotUnitType, OrganizationSnapshotWorkspaceLink, PreparedOrganizationImport, UserEmailLookup,
};
pub use oidc_sync::{
  OidcGroupMapping, OidcGroupMappingRule, OidcGroupSyncAction, OidcGroupSyncError, OidcGroupSyncEvent,
  OidcGroupSyncInput, OidcGroupSyncReport, OidcGroupSyncService, OidcMissingGroupsPolicy, OidcUnknownGroupsPolicy,
};
pub use permission::{OrganizationPermissionService, ProjectCreationDecision, ProjectCreationScope};
pub use project_request::{CreateProjectRequestInput, ProjectRequestOutcome, ProjectRequestService};
pub use template_context::{OrganizationTemplateContext, OrganizationTemplateContextService};
pub use unit_lifecycle::{OrganizationUnitLifecycleError, OrganizationUnitLifecycleService};

pub use read::{OrganizationMemberProfile, OrganizationReadPage, OrganizationReadService, UserOrganizationAssignment};

pub use membership::{
  MembershipChange, MembershipCommit, MembershipOperation, OrganizationMembershipEffects,
  OrganizationMembershipService, OrganizationMembershipWriter,
};
