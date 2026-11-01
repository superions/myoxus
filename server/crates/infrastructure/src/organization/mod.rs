// SPDX-License-Identifier: AGPL-3.0-or-later
//! Organization repositories and on-demand IdP group-directory reads.
//!
//! Tables: `organization`, `organization_unit_type`, `organization_unit`,
//! `organization_unit_member`, `organization_unit_workspace`,
//! `organization_policy` and `organization_project_request` from the canonical
//! schema.
//!
//! Concept: `todo/organization-management-concept.md`
//! Contract: `docs/dev/server/organization-management.md`

mod import_writer;
mod manager_capability;
mod membership_writer;
mod oidc_directory;
mod organization_repo;
mod policy_repo;
mod project_request_repo;
mod type_repo;
mod unit_lifecycle_repo;
mod unit_member_repo;
mod unit_repo;
mod unit_workspace_repo;

pub use import_writer::PgOrganizationImportWriter;
pub use manager_capability::{PgManagerCapabilityWriter, PgUserFeatureLookup};
pub use oidc_directory::HttpOidcGroupDirectory;
pub use organization_repo::PgOrganizationRepository;
pub use policy_repo::PgOrganizationPolicyRepository;
pub use project_request_repo::PgOrganizationProjectRequestRepository;
pub use type_repo::PgOrganizationUnitTypeRepository;
pub use unit_lifecycle_repo::{ORGANIZATION_LIFECYCLE_LOCK, PgOrganizationUnitLifecycleRepository};
pub use unit_member_repo::PgOrganizationUnitMemberRepository;
pub use unit_repo::PgOrganizationUnitRepository;
pub use unit_workspace_repo::PgOrganizationUnitWorkspaceRepository;

/// Maximum depth a hierarchy walk is allowed to traverse before bailing
/// out. Same value as `OrganizationPermissionService::is_manager_for_unit_or_ancestor`
/// to keep the contract symmetric.
pub const MAX_HIERARCHY_DEPTH: u32 = 32;

pub use membership_writer::PgOrganizationMembershipWriter;
