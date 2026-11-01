// SPDX-License-Identifier: AGPL-3.0-or-later
//! CLI journeys share one immutable shipped-source capture while each spawned
//! CLI retains its private distribution and full native startup admission.

mod support;

#[path = "cases/audit_cli_test.rs"]
mod audit_cli_test;
#[path = "cases/client_update.rs"]
mod client_update;
#[path = "cases/config_roundtrip_cli_test.rs"]
mod config_roundtrip_cli_test;
#[path = "cases/doc_projection_cli_test.rs"]
mod doc_projection_cli_test;
#[path = "cases/document_metadata_cli_test.rs"]
mod document_metadata_cli_test;
#[path = "cases/document_versions_cli_test.rs"]
mod document_versions_cli_test;
#[path = "cases/export_docs_cli_test.rs"]
mod export_docs_cli_test;
#[path = "cases/git_sync_cli_test.rs"]
mod git_sync_cli_test;
#[path = "cases/organization_cli_test.rs"]
mod organization_cli_test;
#[path = "cases/organizer_cli_test.rs"]
mod organizer_cli_test;
#[path = "cases/pdf_template_engine_migration.rs"]
mod pdf_template_engine_migration;
#[path = "cases/public_snapshot_cli_test.rs"]
mod public_snapshot_cli_test;
#[path = "cases/sessions_cli_test.rs"]
mod sessions_cli_test;
#[path = "cases/template_catalog_lifecycle_cli_test.rs"]
mod template_catalog_lifecycle_cli_test;
#[path = "cases/template_default_replacement_cli_test.rs"]
mod template_default_replacement_cli_test;
#[path = "cases/template_release_recovery_cli_test.rs"]
mod template_release_recovery_cli_test;
#[path = "cases/template_repair_cli_test.rs"]
mod template_repair_cli_test;
#[path = "cases/users_cli_test.rs"]
mod users_cli_test;
#[path = "cases/workspaces_cli_test.rs"]
mod workspaces_cli_test;
