//! Unified integration test entry point (T01).
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
//! All test modules are declared here. Cargo compiles exactly one binary
//! instead of one per file, reducing disk usage from ~125 GB to ~800 MB.
//!
//! helpers and auth_test_helpers are declared first (no tests, shared code).
//! All other modules are grouped by feature area.

#[path = "support/auth_test_helpers.rs"]
mod auth_test_helpers;
#[path = "support/helpers.rs"]
mod helpers;

// ── Auth ──────────────────────────────────────────────────────────────────────
#[path = "auth/auth_error_paths_test.rs"]
mod auth_error_paths_test;
#[path = "auth/auth_magic_link_test.rs"]
mod auth_magic_link_test;
#[path = "auth/auth_oauth_test.rs"]
mod auth_oauth_test;
#[path = "auth/auth_oidc_ou_sync_test.rs"]
mod auth_oidc_ou_sync_test;
#[path = "auth/auth_password_test.rs"]
mod auth_password_test;
#[path = "auth/auth_session_regression.rs"]
mod auth_session_regression;
#[path = "auth/auth_session_test.rs"]
mod auth_session_test;
#[path = "auth/captcha_endpoint_test.rs"]
mod captcha_endpoint_test;
#[path = "auth/inv_admin_unauthorized_test.rs"]
mod inv_admin_unauthorized_test;
#[path = "auth/inv_auth_test.rs"]
mod inv_auth_test;
#[path = "auth/personal_workspace_theme_test.rs"]
mod personal_workspace_theme_test;
#[path = "auth/socketio_auth_test.rs"]
mod socketio_auth_test;
#[path = "auth/user_preferences_workbench_test.rs"]
mod user_preferences_workbench_test;
#[path = "auth/user_suspension_test.rs"]
mod user_suspension_test;

// ── Admin ─────────────────────────────────────────────────────────────────────
#[path = "admin/admin_config_journal_test.rs"]
mod admin_config_journal_test;
#[path = "admin/admin_config_schema_test.rs"]
mod admin_config_schema_test;
#[path = "admin/admin_config_update_test.rs"]
mod admin_config_update_test;
#[path = "admin/admin_endpoints.rs"]
mod admin_endpoints;
#[path = "admin/admin_frontend_schema_compat_test.rs"]
mod admin_frontend_schema_compat_test;
#[path = "admin/admin_queue_graphql_test.rs"]
mod admin_queue_graphql_test;
#[path = "admin/admin_runtime_graphql_test.rs"]
mod admin_runtime_graphql_test;
#[path = "admin/inv_admin_api_schema_test.rs"]
mod inv_admin_api_schema_test;
#[path = "admin/inv_admin_p17_cleanup_embeddings_test.rs"]
mod inv_admin_p17_cleanup_embeddings_test;
#[path = "admin/inv_audit_log_test.rs"]
mod inv_audit_log_test;
#[path = "admin/logging_admin_test.rs"]
mod logging_admin_test;
#[path = "admin/theme_branding_api_test.rs"]
mod theme_branding_api_test;

// ── Config ────────────────────────────────────────────────────────────────────
#[path = "ops/config/config_readiness_test.rs"]
mod config_readiness_test;
#[path = "ops/config/inv_config_changelog_test.rs"]
mod inv_config_changelog_test;
#[path = "ops/config/inv_config_defaults_test.rs"]
mod inv_config_defaults_test;
#[path = "ops/config/inv_config_download_url_test.rs"]
mod inv_config_download_url_test;
#[path = "ops/config/inv_config_export_test.rs"]
mod inv_config_export_test;
#[path = "ops/config/inv_config_hotreload_test.rs"]
mod inv_config_hotreload_test;
#[path = "ops/config/inv_config_import_test.rs"]
mod inv_config_import_test;
#[path = "ops/config/inv_config_password_policy_test.rs"]
mod inv_config_password_policy_test;
#[path = "ops/config/inv_config_prodcheck_test.rs"]
mod inv_config_prodcheck_test;
#[path = "ops/config/inv_config_setup_test.rs"]
mod inv_config_setup_test;
#[path = "ops/config/inv_config_yaml_compat_test.rs"]
mod inv_config_yaml_compat_test;
#[path = "ops/config/inv_deployment_type_test.rs"]
mod inv_deployment_type_test;
#[path = "ops/config/runtime_toggle_test.rs"]
mod runtime_toggle_test;

// ── Cache ─────────────────────────────────────────────────────────────────────
#[path = "ops/cache/cache_auto_tuning_test.rs"]
mod cache_auto_tuning_test;
#[path = "ops/cache/cache_stampede_test.rs"]
mod cache_stampede_test;
#[path = "ops/cache/cache_tuning_retention_test.rs"]
mod cache_tuning_retention_test;
#[path = "ops/cache/cache_user_features_test.rs"]
mod cache_user_features_test;
#[path = "ops/cache/inv_cache_test.rs"]
mod inv_cache_test;
#[path = "ops/cache/inv_doc_cache_integration_test.rs"]
mod inv_doc_cache_integration_test;
#[path = "ops/cache/inv_doc_cache_tuning_test.rs"]
mod inv_doc_cache_tuning_test;
#[path = "ops/cache/inv_p103_cache_read_path_test.rs"]
mod inv_p103_cache_read_path_test;
#[path = "ops/cache/multi_instance_cache_bus_test.rs"]
mod multi_instance_cache_bus_test;
#[path = "ops/cache/multi_instance_cache_stampede_test.rs"]
mod multi_instance_cache_stampede_test;
#[path = "ops/cache/multi_instance_config_sync_test.rs"]
mod multi_instance_config_sync_test;
#[path = "ops/cache/multi_instance_feature_toggle_test.rs"]
mod multi_instance_feature_toggle_test;
#[path = "ops/cache/multi_instance_redis_failure_test.rs"]
mod multi_instance_redis_failure_test;
#[path = "ops/cache/multi_instance_session_isolation_test.rs"]
mod multi_instance_session_isolation_test;

// ── Documents ─────────────────────────────────────────────────────────────────
#[path = "db/documents/cli_seed_root_doc_test.rs"]
mod cli_seed_root_doc_test;
#[path = "db/documents/doc_acl_test.rs"]
mod doc_acl_test;
#[path = "db/documents/doc_role_roundtrip_test.rs"]
mod doc_role_roundtrip_test;
#[path = "db/documents/doc_view_tracking_test.rs"]
mod doc_view_tracking_test;
#[path = "db/documents/doc_view_tracking_ws_e2e_test.rs"]
mod doc_view_tracking_ws_e2e_test;
#[path = "db/documents/document_audit_graphql_test.rs"]
mod document_audit_graphql_test;
#[path = "db/documents/document_metadata_graphql_test.rs"]
mod document_metadata_graphql_test;
#[path = "db/documents/document_metadata_initial_sync_concurrency_test.rs"]
mod document_metadata_initial_sync_concurrency_test;
#[path = "db/documents/document_metadata_initial_sync_test.rs"]
mod document_metadata_initial_sync_test;
#[path = "db/documents/document_metadata_policy_graphql_test.rs"]
mod document_metadata_policy_graphql_test;
#[path = "db/documents/document_permanent_delete_graphql_test.rs"]
mod document_permanent_delete_graphql_test;
#[path = "db/documents/document_transport_acl_test.rs"]
mod document_transport_acl_test;
#[path = "db/documents/document_update_replay_guard_test.rs"]
mod document_update_replay_guard_test;
#[path = "db/documents/graphql_doc_test.rs"]
mod graphql_doc_test;
#[path = "db/documents/inv_doc_logging_test.rs"]
mod inv_doc_logging_test;
#[path = "db/documents/inv_doc_path_consistency_test.rs"]
mod inv_doc_path_consistency_test;
#[path = "db/documents/inv_doc_permissions_test.rs"]
mod inv_doc_permissions_test;
#[path = "db/documents/inv_doc_service_split_test.rs"]
mod inv_doc_service_split_test;
#[path = "db/documents/inv_doc_timestamp_filter_test.rs"]
mod inv_doc_timestamp_filter_test;
#[path = "db/documents/inv_doc_trait_isolation_test.rs"]
mod inv_doc_trait_isolation_test;
#[path = "db/documents/inv_doc_view_tracking_consolidated_test.rs"]
mod inv_doc_view_tracking_consolidated_test;
#[path = "db/documents/inv_p102_compact_test.rs"]
mod inv_p102_compact_test;
#[path = "db/documents/inv_p102_trash_test.rs"]
mod inv_p102_trash_test;
#[path = "db/documents/inv_userspace_load_test.rs"]
mod inv_userspace_load_test;
#[path = "db/documents/page_lifecycle_test.rs"]
mod page_lifecycle_test;
#[path = "db/documents/sync_doc_id_roundtrip_test.rs"]
mod sync_doc_id_roundtrip_test;

// ── Workspaces ────────────────────────────────────────────────────────────────
#[path = "db/workspaces/database_socketio_collaboration_test.rs"]
mod database_socketio_collaboration_test;
#[path = "db/workspaces/graphql_admin_search_workspaces_test.rs"]
mod graphql_admin_search_workspaces_test;
#[path = "db/workspaces/graphql_admin_workspace_test.rs"]
mod graphql_admin_workspace_test;
#[path = "db/workspaces/graphql_database_test.rs"]
mod graphql_database_test;
#[path = "db/workspaces/graphql_orphaned_workspaces_test.rs"]
mod graphql_orphaned_workspaces_test;
#[path = "db/workspaces/graphql_workspace.rs"]
mod graphql_workspace;
#[path = "db/workspaces/graphql_workspace_compat.rs"]
mod graphql_workspace_compat;
#[path = "db/workspaces/graphql_workspace_resolvers_test.rs"]
mod graphql_workspace_resolvers_test;
#[path = "db/workspaces/graphql_workspace_tags_test.rs"]
mod graphql_workspace_tags_test;
#[path = "db/workspaces/inv_workspace_blob_cleanup_test.rs"]
mod inv_workspace_blob_cleanup_test;
#[path = "db/workspaces/inv_workspace_invite_test.rs"]
mod inv_workspace_invite_test;
#[path = "db/workspaces/inv_workspace_member_invite_test.rs"]
mod inv_workspace_member_invite_test;
#[path = "db/workspaces/inv_workspace_test.rs"]
mod inv_workspace_test;
#[path = "db/workspaces/inv_workspace_type_test.rs"]
mod inv_workspace_type_test;
#[path = "db/workspaces/nightly_cleanup_test.rs"]
mod nightly_cleanup_test;
#[path = "db/workspaces/pdb29b_realtime_emission_test.rs"]
mod pdb29b_realtime_emission_test;
#[path = "db/workspaces/workspace_docs_rest_compat.rs"]
mod workspace_docs_rest_compat;
#[path = "db/workspaces/workspace_preview_test.rs"]
mod workspace_preview_test;

// ── Blobs & Storage ───────────────────────────────────────────────────────────
#[path = "db/storage/blob_download_test.rs"]
mod blob_download_test;
#[path = "db/storage/blob_quota_test.rs"]
mod blob_quota_test;
#[path = "db/storage/blob_upload_test.rs"]
mod blob_upload_test;
#[path = "db/storage/inv_quota_usage_test.rs"]
mod inv_quota_usage_test;
#[path = "db/storage/inv_workspace_quota_test.rs"]
mod inv_workspace_quota_test;
#[path = "db/storage/quota_enforcement_test.rs"]
mod quota_enforcement_test;
#[path = "db/storage/storage_complex_test.rs"]
mod storage_complex_test;

// ── GraphQL ───────────────────────────────────────────────────────────────────
#[path = "contract/graphql/graphql_admin_compat.rs"]
mod graphql_admin_compat;
#[path = "contract/graphql/graphql_admin_dashboard_test.rs"]
mod graphql_admin_dashboard_test;
#[path = "contract/graphql/graphql_admin_user_test.rs"]
mod graphql_admin_user_test;
#[path = "contract/graphql/graphql_auth.rs"]
mod graphql_auth;
#[path = "contract/graphql/graphql_billing_compat.rs"]
mod graphql_billing_compat;
#[path = "contract/graphql/graphql_calendar.rs"]
mod graphql_calendar;
#[path = "contract/graphql/graphql_calendar_native_test.rs"]
mod graphql_calendar_native_test;
#[path = "contract/graphql/graphql_comments.rs"]
mod graphql_comments;
#[path = "contract/graphql/graphql_compat_config.rs"]
mod graphql_compat_config;
#[path = "contract/graphql/graphql_copilot_lifecycle.rs"]
mod graphql_copilot_lifecycle;
#[path = "contract/graphql/graphql_copilot_test.rs"]
mod graphql_copilot_test;
#[path = "contract/graphql/graphql_document_graph_identity_test.rs"]
mod graphql_document_graph_identity_test;
#[path = "contract/graphql/graphql_git_sync_profile_test.rs"]
mod graphql_git_sync_profile_test;
#[path = "contract/graphql/graphql_implicit_manager_capability_test.rs"]
mod graphql_implicit_manager_capability_test;
#[path = "contract/graphql/graphql_notifications.rs"]
mod graphql_notifications;
#[path = "contract/graphql/graphql_organization_audit_test.rs"]
mod graphql_organization_audit_test;
#[path = "contract/graphql/graphql_organization_import_export_test.rs"]
mod graphql_organization_import_export_test;
#[path = "contract/graphql/graphql_organization_legacy_team_test.rs"]
mod graphql_organization_legacy_team_test;
#[path = "contract/graphql/graphql_organization_test.rs"]
mod graphql_organization_test;
#[path = "contract/graphql/graphql_organization_unit_lifecycle_test.rs"]
mod graphql_organization_unit_lifecycle_test;
#[path = "contract/graphql/graphql_search.rs"]
mod graphql_search;
#[path = "contract/graphql/graphql_search_missing_repository_test.rs"]
mod graphql_search_missing_repository_test;
#[path = "contract/graphql/graphql_search_organization_units_test.rs"]
mod graphql_search_organization_units_test;
#[path = "contract/graphql/graphql_search_users_test.rs"]
mod graphql_search_users_test;
#[path = "contract/graphql/graphql_template_suggestions.rs"]
mod graphql_template_suggestions;
#[path = "contract/graphql/graphql_user_organization_memberships_test.rs"]
mod graphql_user_organization_memberships_test;
#[path = "contract/graphql/graphql_workspace_member_permission_test.rs"]
mod graphql_workspace_member_permission_test;
#[path = "contract/graphql/graphql_workspace_template_context_test.rs"]
mod graphql_workspace_template_context_test;
#[path = "contract/graphql/inv_mix_search_contract_test.rs"]
mod inv_mix_search_contract_test;
#[path = "contract/graphql/organization_source_gate_test.rs"]
mod organization_source_gate_test;
#[path = "contract/persistence/workspace_content_operation_persistence_test.rs"]
mod workspace_content_operation_persistence_test;

// ── Schema Compat ─────────────────────────────────────────────────────────────
#[path = "contract/schema/compat_rest_endpoints.rs"]
mod compat_rest_endpoints;
#[path = "contract/schema/graphql_enum_casing_test.rs"]
mod graphql_enum_casing_test;
#[path = "contract/schema/graphql_schema_drift_test.rs"]
mod graphql_schema_drift_test;
#[path = "contract/schema/schema_compat_mutations_test.rs"]
mod schema_compat_mutations_test;
#[path = "contract/schema/schema_compat_queries_test.rs"]
mod schema_compat_queries_test;
#[path = "contract/schema/schema_compat_types_test.rs"]
mod schema_compat_types_test;

// ── CalDAV / Calendar ─────────────────────────────────────────────────────────
#[path = "calendar/caldav_sync_integration_test.rs"]
mod caldav_sync_integration_test;
#[path = "calendar/calendar_native_repo_test.rs"]
mod calendar_native_repo_test;
#[path = "calendar/inv_caldav_test.rs"]
mod inv_caldav_test;
#[path = "calendar/inv_caldav_write_test.rs"]
mod inv_caldav_write_test;
#[path = "calendar/inv_caldav_writeback_test.rs"]
mod inv_caldav_writeback_test;
#[path = "calendar/inv_calendar_conflict_test.rs"]
mod inv_calendar_conflict_test;
#[path = "calendar/inv_calendar_ics_test.rs"]
mod inv_calendar_ics_test;
#[path = "calendar/inv_calendar_instance_test.rs"]
mod inv_calendar_instance_test;
#[path = "calendar/inv_calendar_native_schema_test.rs"]
mod inv_calendar_native_schema_test;
#[path = "calendar/inv_calendar_native_svc_test.rs"]
mod inv_calendar_native_svc_test;
#[path = "calendar/inv_calendar_realtime_test.rs"]
mod inv_calendar_realtime_test;
#[path = "calendar/inv_calendar_recurrence_test.rs"]
mod inv_calendar_recurrence_test;
#[path = "calendar/inv_calendar_reminder_test.rs"]
mod inv_calendar_reminder_test;
#[path = "calendar/inv_calendar_rsvp_test.rs"]
mod inv_calendar_rsvp_test;
#[path = "calendar/inv_calendar_security_test.rs"]
mod inv_calendar_security_test;
#[path = "calendar/inv_calendar_webhook_test.rs"]
mod inv_calendar_webhook_test;
#[path = "calendar/inv_calendar_writeback_test.rs"]
mod inv_calendar_writeback_test;

// ── Copilot ───────────────────────────────────────────────────────────────────
#[path = "copilot/copilot_embedding_pipeline_test.rs"]
mod copilot_embedding_pipeline_test;
#[path = "copilot/inv_copilot_adoption_test.rs"]
mod inv_copilot_adoption_test;
#[path = "copilot/inv_copilot_config_test.rs"]
mod inv_copilot_config_test;
#[path = "copilot/inv_copilot_exa_test.rs"]
mod inv_copilot_exa_test;
#[path = "copilot/inv_copilot_rag_test.rs"]
mod inv_copilot_rag_test;
#[path = "copilot/inv_copilot_schema_test.rs"]
mod inv_copilot_schema_test;
#[path = "copilot/inv_copilot_test.rs"]
mod inv_copilot_test;
#[path = "copilot/transcription_pipeline_test.rs"]
mod transcription_pipeline_test;
#[path = "copilot/transcription_results_test.rs"]
mod transcription_results_test;

// ── Git Sync ──────────────────────────────────────────────────────────────────
#[path = "integrations/git_sync/git_sync_conflict_resolution_test.rs"]
mod git_sync_conflict_resolution_test;
#[path = "integrations/git_sync/git_sync_db_invariants_test.rs"]
mod git_sync_db_invariants_test;
#[path = "integrations/git_sync/git_sync_enum_test.rs"]
mod git_sync_enum_test;
#[path = "integrations/git_sync/git_sync_file_pipeline_test.rs"]
mod git_sync_file_pipeline_test;
#[path = "integrations/git_sync/git_sync_rebase_test.rs"]
mod git_sync_rebase_test;
#[path = "integrations/git_sync/git_sync_runner_harness_test.rs"]
mod git_sync_runner_harness_test;
#[path = "integrations/git_sync/git_sync_scheduler_test.rs"]
mod git_sync_scheduler_test;
#[path = "integrations/git_sync/git_sync_source_guard_test.rs"]
mod git_sync_source_guard_test;
#[path = "integrations/git_sync/git_sync_ssh_host_key_policy_test.rs"]
mod git_sync_ssh_host_key_policy_test;
#[path = "integrations/git_sync/git_sync_webhook_test.rs"]
mod git_sync_webhook_test;
#[path = "integrations/git_sync/inv_git_sync_test.rs"]
mod inv_git_sync_test;

// ── Templates ─────────────────────────────────────────────────────────────────
#[path = "templates/inv_template_registry_config_test.rs"]
mod inv_template_registry_config_test;
#[path = "templates/template_builtin_bridge_invariants.rs"]
mod template_builtin_bridge_invariants;
#[path = "templates/template_registry_test.rs"]
mod template_registry_test;

// ── MCP ───────────────────────────────────────────────────────────────────────
#[path = "mcp/mcp_api_key_graphql_test.rs"]
mod mcp_api_key_graphql_test;
#[path = "mcp/mcp_blob_tools_test.rs"]
mod mcp_blob_tools_test;
#[path = "mcp/mcp_calendar_test.rs"]
mod mcp_calendar_test;
#[path = "mcp/mcp_create_page_test.rs"]
mod mcp_create_page_test;
#[path = "mcp/mcp_cross_workspace_test.rs"]
mod mcp_cross_workspace_test;
#[path = "mcp/mcp_database_test.rs"]
mod mcp_database_test;
#[path = "mcp/mcp_document_metadata_test.rs"]
mod mcp_document_metadata_test;
#[path = "mcp/mcp_document_template_test.rs"]
mod mcp_document_template_test;
#[path = "mcp/mcp_document_version_test.rs"]
mod mcp_document_version_test;
#[path = "mcp/mcp_folder_tools_test.rs"]
mod mcp_folder_tools_test;
#[path = "mcp/mcp_organization_unit_lifecycle_e2e_test.rs"]
mod mcp_organization_unit_lifecycle_e2e_test;
#[path = "mcp/mcp_pagination_test.rs"]
mod mcp_pagination_test;
#[path = "mcp/mcp_pdf_template_test.rs"]
mod mcp_pdf_template_test;
#[path = "mcp/mcp_publication_test.rs"]
mod mcp_publication_test;
#[path = "mcp/mcp_scope_enforcement_test.rs"]
mod mcp_scope_enforcement_test;
#[path = "mcp/mcp_user_management_test.rs"]
mod mcp_user_management_test;
#[path = "mcp/mcp_workspace_tag_test.rs"]
mod mcp_workspace_tag_test;

// ── Public Publishing ────────────────────────────────────────────────────────
#[path = "public_publishing/public_publishing_routes_test.rs"]
mod public_publishing_routes_test;

// ── PDF Export ────────────────────────────────────────────────────────────────
#[path = "pdf/admin_pdf_export_graphql_test.rs"]
mod admin_pdf_export_graphql_test;
#[path = "pdf/admin_template_override_graphql_test.rs"]
mod admin_template_override_graphql_test;
#[path = "pdf/document_version_graphql_test.rs"]
mod document_version_graphql_test;
#[path = "pdf/document_version_invariants.rs"]
mod document_version_invariants;
#[path = "pdf/pdf_audit_invariants_test.rs"]
mod pdf_audit_invariants_test;
#[path = "pdf/pdf_brand_admin_test.rs"]
mod pdf_brand_admin_test;
#[path = "pdf/pdf_export_api_test.rs"]
mod pdf_export_api_test;
#[path = "pdf/pdf_export_assignment_test.rs"]
mod pdf_export_assignment_test;
#[path = "pdf/pdf_export_audit_failmode_test.rs"]
mod pdf_export_audit_failmode_test;
#[path = "pdf/pdf_export_cleanup_test.rs"]
mod pdf_export_cleanup_test;
#[path = "pdf/pdf_export_contract_source_gate_test.rs"]
mod pdf_export_contract_source_gate_test;
#[path = "pdf/pdf_export_render_audit_test.rs"]
mod pdf_export_render_audit_test;
#[path = "pdf/pdf_export_v2_invariants.rs"]
mod pdf_export_v2_invariants;
#[path = "pdf/pdf_export_v2_mutation_test.rs"]
mod pdf_export_v2_mutation_test;
#[path = "pdf/pdf_font_lifecycle_test.rs"]
mod pdf_font_lifecycle_test;
#[path = "pdf/pdf_template_admin_test.rs"]
mod pdf_template_admin_test;
#[path = "pdf/pdf_workspace_admin_test.rs"]
mod pdf_workspace_admin_test;
#[path = "pdf/pdf_workspace_readonly_test.rs"]
mod pdf_workspace_readonly_test;

// ── WebSocket / Sync ──────────────────────────────────────────────────────────
#[path = "realtime/client_update_control_test.rs"]
mod client_update_control_test;
#[path = "realtime/connection_admission_test.rs"]
mod connection_admission_test;
#[path = "realtime/document_event_acl_test.rs"]
mod document_event_acl_test;
#[path = "realtime/sync_lifecycle_test.rs"]
mod sync_lifecycle_test;
#[path = "realtime/sync_permission_test.rs"]
mod sync_permission_test;
#[path = "realtime/websocket_protocol_test.rs"]
mod websocket_protocol_test;

// ── Queue / Worker ────────────────────────────────────────────────────────────
#[path = "worker/inv_metrics_pipeline_test.rs"]
mod inv_metrics_pipeline_test;
#[path = "worker/inv_telemetry_dsgvo_test.rs"]
mod inv_telemetry_dsgvo_test;
#[path = "worker/inv_telemetry_pipeline_test.rs"]
mod inv_telemetry_pipeline_test;
#[path = "worker/inv_telemetry_status_test.rs"]
mod inv_telemetry_status_test;
#[path = "worker/metrics_worker_telemetry.rs"]
mod metrics_worker_telemetry;
#[path = "worker/queue_mgmt_invariant_test.rs"]
mod queue_mgmt_invariant_test;
#[path = "worker/worker_outbox_e2e_test.rs"]
mod worker_outbox_e2e_test;
#[path = "worker/worker_outbox_test.rs"]
mod worker_outbox_test;
#[path = "worker/worker_queue_redis_test.rs"]
mod worker_queue_redis_test;

// ── HTTP / CORS / Health ──────────────────────────────────────────────────────
#[path = "ops/http/cors_test.rs"]
mod cors_test;
#[path = "ops/http/font_endpoints_test.rs"]
mod font_endpoints_test;
#[path = "ops/http/health_endpoints.rs"]
mod health_endpoints;
#[path = "ops/http/info_endpoints.rs"]
mod info_endpoints;
#[path = "ops/http/monitoring_assets_test.rs"]
mod monitoring_assets_test;
#[path = "ops/http/setup_endpoints.rs"]
mod setup_endpoints;
#[path = "ops/http/startup_failfast.rs"]
mod startup_failfast;

// ── Misc ──────────────────────────────────────────────────────────────────────
#[path = "ops/misc/indexer_job_payload_test.rs"]
mod indexer_job_payload_test;
#[path = "ops/misc/inv_ignored_docs_shape_test.rs"]
mod inv_ignored_docs_shape_test;
#[path = "ops/misc/inv_outbox_test.rs"]
mod inv_outbox_test;
#[path = "ops/misc/inv_server_directories_test.rs"]
mod inv_server_directories_test;
#[path = "ops/misc/inv_userspace_view_test.rs"]
mod inv_userspace_view_test;
#[path = "ops/misc/invite_link_hash_test.rs"]
mod invite_link_hash_test;
#[path = "ops/misc/log_rotation_test.rs"]
mod log_rotation_test;
#[path = "ops/misc/logging_tail_rotation_test.rs"]
mod logging_tail_rotation_test;
#[path = "ops/misc/notification_mail_e2e_test.rs"]
mod notification_mail_e2e_test;
#[path = "ops/misc/notification_mail_pipeline_test.rs"]
mod notification_mail_pipeline_test;
#[path = "ops/misc/search_content_test.rs"]
mod search_content_test;
#[path = "ops/misc/security_regression_test.rs"]
mod security_regression_test;

// ── Source-scan regression guards ─────────────────────────────────────────────
#[path = "contract/source_scan/lint_doc_id_parsing.rs"]
mod lint_doc_id_parsing;

#[path = "mcp/mcp_organization_membership_test.rs"]
mod mcp_organization_membership_test;
