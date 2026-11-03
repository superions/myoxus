//! Bounded API integration smoke target.
#![allow(
  clippy::await_holding_lock,
  clippy::doc_overindented_list_items,
  clippy::duplicate_mod,
  clippy::type_complexity,
  dead_code,
  non_snake_case,
  unused_imports
)]
//!
//! The full `integration` target owns the complete API integration matrix.
//! This target intentionally declares only the modules containing the exact
//! changed-path smoke tests, so a cold quick gate does not compile and link the
//! complete integration suite.

#[path = "support/auth_test_helpers.rs"]
mod auth_test_helpers;
#[path = "support/helpers.rs"]
mod helpers;

#[path = "admin/admin_config_schema_test.rs"]
mod admin_config_schema_test;
#[path = "admin/admin_config_update_test.rs"]
mod admin_config_update_test;
#[path = "auth/auth_error_paths_test.rs"]
mod auth_error_paths_test;
#[path = "auth/auth_oidc_ou_sync_test.rs"]
mod auth_oidc_ou_sync_test;
#[path = "auth/auth_password_test.rs"]
mod auth_password_test;
#[path = "db/storage/blob_upload_test.rs"]
mod blob_upload_test;
#[path = "realtime/connection_admission_test.rs"]
mod connection_admission_test;
#[path = "db/documents/document_metadata_graphql_test.rs"]
mod document_metadata_graphql_test;
#[path = "integrations/git_sync/git_sync_db_invariants_test.rs"]
mod git_sync_db_invariants_test;
#[path = "integrations/git_sync/git_sync_file_pipeline_test.rs"]
mod git_sync_file_pipeline_test;
#[path = "integrations/git_sync/git_sync_mirror_maintenance_test.rs"]
mod git_sync_mirror_maintenance_test;
#[path = "integrations/git_sync/git_sync_rebase_test.rs"]
mod git_sync_rebase_test;
#[path = "integrations/git_sync/git_sync_runner_harness_test.rs"]
mod git_sync_runner_harness_test;
#[path = "integrations/git_sync/git_sync_scheduler_test.rs"]
mod git_sync_scheduler_test;
#[path = "contract/graphql/graphql_admin_user_test.rs"]
mod graphql_admin_user_test;
#[path = "contract/graphql/graphql_calendar.rs"]
mod graphql_calendar;
#[path = "contract/graphql/graphql_calendar_native_test.rs"]
mod graphql_calendar_native_test;
#[path = "db/documents/graphql_doc_test.rs"]
mod graphql_doc_test;
#[path = "contract/graphql/graphql_document_graph_identity_test.rs"]
mod graphql_document_graph_identity_test;
#[path = "contract/graphql/graphql_git_sync_profile_test.rs"]
mod graphql_git_sync_profile_test;
#[path = "contract/graphql/graphql_organization_import_export_test.rs"]
mod graphql_organization_import_export_test;
#[path = "contract/schema/graphql_schema_drift_test.rs"]
mod graphql_schema_drift_test;
#[path = "contract/graphql/graphql_search_missing_repository_test.rs"]
mod graphql_search_missing_repository_test;
#[path = "contract/graphql/graphql_workspace_member_permission_test.rs"]
mod graphql_workspace_member_permission_test;
#[path = "db/workspaces/graphql_workspace_tags_test.rs"]
mod graphql_workspace_tags_test;
#[path = "contract/graphql/graphql_workspace_template_context_test.rs"]
mod graphql_workspace_template_context_test;
#[path = "ops/http/health_endpoints.rs"]
mod health_endpoints;
#[path = "ops/config/inv_config_import_test.rs"]
mod inv_config_import_test;
#[path = "ops/config/inv_config_setup_test.rs"]
mod inv_config_setup_test;
#[path = "contract/source_scan/lint_doc_id_parsing.rs"]
mod lint_doc_id_parsing;
#[path = "mcp/mcp_blob_tools_test.rs"]
mod mcp_blob_tools_test;
#[path = "mcp/mcp_create_page_test.rs"]
mod mcp_create_page_test;
#[path = "mcp/mcp_document_template_test.rs"]
mod mcp_document_template_test;
#[path = "mcp/mcp_folder_tools_test.rs"]
mod mcp_folder_tools_test;
#[path = "mcp/mcp_publication_test.rs"]
mod mcp_publication_test;
#[path = "mcp/mcp_workspace_tag_test.rs"]
mod mcp_workspace_tag_test;
#[path = "db/documents/page_lifecycle_test.rs"]
mod page_lifecycle_test;
#[path = "auth/socketio_auth_test.rs"]
mod socketio_auth_test;
#[path = "db/documents/sync_doc_id_roundtrip_test.rs"]
mod sync_doc_id_roundtrip_test;
#[path = "realtime/sync_permission_test.rs"]
mod sync_permission_test;
#[path = "contract/persistence/workspace_content_operation_persistence_test.rs"]
mod workspace_content_operation_persistence_test;
#[path = "db/workspaces/workspace_docs_rest_compat.rs"]
mod workspace_docs_rest_compat;
