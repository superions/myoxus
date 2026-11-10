//! `myoxus-application` — business logic and port trait definitions.
//!
//! This crate implements the application layer of the hexagonal architecture.
//! It depends on `myoxus-domain` for pure entity types and exposes service
//! structs (e.g. [`auth::AuthService`], [`workspace::WorkspaceService`]) that
//! orchestrate business operations through port traits.  Concrete I/O
//! implementations live in `myoxus-infrastructure`.
//!
//! ## Module overview
//!
//! | Module | Purpose |
//! |---|---|
//! | `admin` | Admin-only operations (user/workspace listing, privilege management) |
//! | `auth` | Authentication, session management, OAuth, magic-link OTP |
//! | `calendar` | Calendar account integration and reminder dispatch |
//! | `comment` | Document comment threads, anchors, and @mention notifications |
//! | `copilot` | AI assistant sessions, streaming, RAG context building |
//! | `doc` | Document CRUD and Yjs sync |
//! | `events` | Transactional outbox event publishing port |
//! | `migration_plan` | Compile-time legacy schema migration manifest |
//! | `notification` | In-app notification lifecycle and cursor pagination |
//! | `organizer` | Shared workspace folder-system-document codec and mutations |
//! | `permission` | Cross-cutting ACL service (workspace + doc role resolution) |
//! | `ports` | Shared port traits (blob storage, Redis, mail, distributed lock) |
//! | `search` | Full-text search indexing service and job payloads |
//! | `transaction_boundaries` | Compile-time catalogue of required DB transaction scopes |
//! | `worker` | Background job queue service with lease/retry/DLQ semantics |
//! | `workspace` | Workspace membership lifecycle and invite management |

pub mod admin;
pub mod api_key;
pub mod audit;
pub mod auth;
pub mod branding;
pub mod calendar;
pub mod captcha;
pub mod client_update;
pub mod comment;
pub mod config_validation;
pub mod copilot;
pub mod database;
pub mod dns;
pub mod doc;
pub mod document_fields;
pub mod document_graph;
pub mod document_metadata;
pub mod document_metadata_policy;
pub mod document_template;
pub mod document_version;
pub mod docx;
pub mod events;
pub mod feature_bundle;
pub mod git_sync;
pub mod maintenance;
pub mod markdown;
pub mod mcp;
pub mod metrics;
pub mod migration_plan;
pub mod mime_policy;
pub mod notification;
pub mod organization;
pub mod organizer;
pub mod pdf_export;
pub mod permission;
pub mod ports;
pub mod public;
pub mod quota;
pub mod recurrence;
mod regional;
pub mod scheduling;
pub mod search;
pub mod setup;
pub mod telemetry;
pub mod template_registry;
pub mod transaction_boundaries;
pub mod transcription;
pub mod worker;
pub mod workspace;
pub mod workspace_automation;
pub mod workspace_content_operation;
pub mod workspace_export;
pub mod workspace_import;
pub mod workspace_overview;
pub mod workspace_path;
pub mod workspace_tags;
