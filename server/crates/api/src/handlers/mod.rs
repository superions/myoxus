//! Axum handler functions for all HTTP endpoints.
//!
//! Each sub-module groups handlers by domain area:
//!
//! | Module | Endpoints |
//! |---|---|
//! | `health` | `/health`, `/ready`, `/live`, `/info` |
//! | `metrics` | `/metrics`, `/metrics/prometheus` |
//! | `blob` | blob upload, multipart upload, comment-attachment download |
//! | `workspace_doc` | REST workspace-doc fetch, history, renderer |
//! | `search` | `/api/workspaces/{id}/search` |
//! | `calendar` | calendar event list, reminder status, Google webhook |
//! | `copilot` | Copilot SSE stub, blob proxy, Unsplash photos |
//! | `rpc` | `/rpc/workspaces/{id}/docs/{id}` — internal doc-content RPC |
//! | `misc` | telemetry, i18n, questionnaire, image-proxy, link-preview, MCP bridge |
//! | `middleware` | logger and throttle middlewares applied to the full router |

pub mod blob;
pub mod branding;
pub mod calendar;
pub mod captcha_admin;
pub mod config;
pub mod copilot;
pub mod feature_assets;
pub mod fonts;
pub mod git_sync;
pub mod health;
pub mod logs;
pub mod metrics;
pub mod middleware;
pub mod misc;
pub mod pdf_export;
pub mod public;
pub mod rpc;
pub mod search;
pub mod template_export;
pub mod workspace_doc;
pub mod workspace_export;
pub mod workspace_import;
