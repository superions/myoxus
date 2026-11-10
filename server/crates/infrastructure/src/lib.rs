//! `myoxus-infrastructure` — SQLx repository implementations, Redis, storage,
//! mail, and background worker infrastructure.
//!
//! This crate provides concrete implementations of all port traits defined in
//! `myoxus-application`.  Each sub-module targets one domain area.
//!
//! ## Module overview
//!
//! | Module | Purpose |
//! |---|---|
//! | `admin` | [`AdminStore`](myoxus_application::admin::AdminStore) backed by PostgreSQL |
//! | `auth` | [`AuthStore`](myoxus_application::auth::AuthStore) backed by PostgreSQL |
//! | `blob` | [`BlobStore`](myoxus_application::ports::blob::BlobStore) via opendal + PostgreSQL metadata |
//! | `caldav` | CalDAV HTTP client (PROPFIND, REPORT) and pull-sync service |
//! | `calendar` | [`CalendarRepository`](myoxus_domain::repositories::CalendarRepository) backed by PostgreSQL |
//! | `google_calendar` | Google Calendar API v3 client (OAuth2, Events.list) and pull-sync service |
//! | `http_retry` | Shared exponential-backoff retry utilities for external HTTP calls |
//! | `comment` | [`CommentStore`](myoxus_application::comment::CommentStore) backed by PostgreSQL |
//! | `copilot` | [`CopilotRepository`](myoxus_domain::repositories::CopilotRepository) backed by PostgreSQL |
//! | `db` | Database configuration, schema manifest, ID strategy, and transaction boundary notes |
//! | `doc` | Document and Yjs update repositories backed by PostgreSQL |
//! | `mail` | [`MailPort`](myoxus_application::ports::MailPort) implementation (SMTP / sendgrid) |
//! | `notification` | [`NotificationStore`](myoxus_application::notification::NotificationStore) backed by PostgreSQL |
//! | `outbox` | Transactional outbox [`EventPublisher`](myoxus_application::events::EventPublisher) backed by PostgreSQL |
//! | `redis` | [`RedisPort`](myoxus_application::ports::RedisPort) backed by `deadpool-redis` |
//! | `search` | Search index repository backed by PostgreSQL full-text search |
//! | `storage` | Object storage helpers (opendal adapters) |
//! | `workspace` | [`WorkspaceStore`](myoxus_application::workspace::WorkspaceStore) backed by PostgreSQL |

pub mod admin;
pub mod api_key;
pub mod app_config;
mod app_config_validation;
pub mod assistant_packages;
pub mod audit;
pub mod auth;
pub mod blob;
pub mod branding;
pub mod cache_invalidation;
pub mod caldav;
pub mod calendar;
pub mod calendar_write;
pub mod captcha;
pub mod client_update;
pub mod comment;
pub mod copilot;
pub mod crypto;
pub mod database_activity;
pub mod database_templates;
pub mod db;
pub mod disk;
pub mod doc;
pub mod doc_cache;
mod document_field_capture;
pub mod document_graph;
pub mod document_metadata;
pub mod document_metadata_policy;
pub mod document_version;
pub mod feature_bundles;
pub mod git_sync;
pub mod google_calendar;
pub mod history_git_sync;
pub mod html_templates;
pub mod http_retry;
pub mod mail;
pub mod maintenance;
pub mod mcp_idempotency;
pub mod metrics;
pub mod migrations;
pub mod mime_policy_config;
pub mod notification;
pub mod organization;
pub mod outbox;
pub mod pdf_export;
pub mod public;
pub mod quota_cache;
pub mod quota_resolver;
pub mod recurrence;
pub mod redis;
pub mod redis_lease;
pub mod scheduling;
pub mod search;
pub mod storage;
pub mod telemetry;
mod template_files;
pub mod template_registry;
pub mod tls;
pub mod transcription;
pub mod workflow_runtime;
pub mod workspace;
pub mod workspace_automation;
pub mod workspace_content_operation;
pub mod workspace_database;
pub mod workspace_import;
pub mod workspace_tags;
