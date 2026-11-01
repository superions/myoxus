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
//! ## Rollen-Achse
//!
//! Drei strikt getrennte Achsen, die zusammen entscheiden:
//!
//! 1. **`FeatureType.Manager`** — global capability synchronized implicitly by
//!    Manager assignments; it grants no OU authority by itself.
//! 2. **`organization_unit_member.role`** — `reader`/`member`/`manager`
//!    pro OU. Erst eine `manager`-Mitgliedschaft + globale
//!    `FeatureType.Manager`-Capability gibt Verwaltungsrechte
//!    (`is_manager_for_unit`).
//! 3. **`workspace_memberships.role`** — bleibt unveraendert; Workspace-
//!    Aktionen werden weiterhin per `WorkspaceRole` geprueft. OU-Manager
//!    duerfen Workspace-Rollen nur bis `Admin` vergeben (nie `Owner`).
//!
//! Siehe Learning `LRN-20260502-ORG-A-01` (FeatureType allein vergibt keine
//! Rechte) und `LRN-20260502-ORG-A-02` (OU- vs Workspace-Rollen).

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
  ManagerCapabilityWriter, OidcGroupMapping, OidcGroupMappingRule, OidcGroupSyncAction, OidcGroupSyncError,
  OidcGroupSyncEvent, OidcGroupSyncInput, OidcGroupSyncReport, OidcGroupSyncService, OidcMissingGroupsPolicy,
  OidcUnknownGroupsPolicy,
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
