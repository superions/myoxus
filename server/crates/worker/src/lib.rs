// SPDX-License-Identifier: AGPL-3.0-or-later
//! `myoxus-worker` — Redis-backed BullMQ-compatible job queue and worker runtime.
//!
//! This crate provides:
//! - [`RedisQueue`] — atomic job enqueue/dequeue/ack/fail operations using
//!   BullMQ-compatible Redis key layouts
//! - [`WorkerRuntime`] — manages one Tokio task per queue, each enforcing
//!   per-queue concurrency via a [`tokio::sync::Semaphore`]
//! - [`JobHandler`] — trait for implementing queue-specific job processors
//! - [`scheduler::run_delayed_promotion`] — background task that promotes
//!   delayed jobs to the wait list when their run-at time arrives
//!
//! ## BullMQ key layout
//!
//! ```text
//! bull:<queue>:wait       List  — waiting job IDs
//! bull:<queue>:active     List  — currently processing job IDs
//! bull:<queue>:completed  Set   — completed job IDs
//! bull:<queue>:failed     Set   — permanently failed job IDs
//! bull:<queue>:delayed    ZSet  — delayed jobs (score = run-at ms)
//! bull:<queue>:stalled    Set   — stalled job IDs (worker died)
//! bull:<queue>:id         Int   — auto-incrementing job ID counter
//! bull:<queue>:<jobId>    Hash  — job data (name, data, opts, …)
//! ```

pub mod config;
pub mod font_materializer;
pub mod job;
pub mod metrics;
pub mod pdf_export_handler;
pub mod pdf_export_metrics;
pub mod pdf_pipeline;
pub mod queue;
pub mod runtime;
pub mod scheduler;

pub use config::{JobConfigSnapshot, QueueConfig, RuntimeConfig, TerminalRetentionPolicy};
pub use job::{BackoffStrategy, Job, JobCounts, JobError, JobOptions, JobRepeatOpts, JobStatus};
pub use metrics::QueueStats;
pub use pdf_export_handler::{
  PDF_EXPORT_QUEUE, PdfAssetReader, PdfBlobWriter, PdfExportJobHandler, PdfExportLimits, PdfFontReader,
  pdf_export_storage_key,
};
pub use pdf_export_metrics::{NoopPdfExportMetrics, PdfExportMetrics, PdfExportOutcome};
pub use pdf_pipeline::{SyncRenderInputs, SyncRenderOutcome, try_sync_render};
pub use queue::{QueueError, QueueResult, RedisQueue};
pub use runtime::{JobHandler, WorkerRuntime};
pub use scheduler::{CronJob, run_cron_scheduler};
