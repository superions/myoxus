//! Document-versioning application services.
//!
//! The persistence model lives in the domain/infrastructure repositories; this
//! module owns cross-cutting business flows such as auto-version triggers.

pub mod auto_trigger;
pub mod create_service;
pub mod diff;
pub mod edit_capture;
pub mod label_service;
pub mod restore_service;
pub mod settings;

pub use auto_trigger::{
  AutoVersionError, AutoVersionOutcome, AutoVersionSkipReason, DailyAutoVersionSummary,
  DocumentVersionAutoTriggerRequest, DocumentVersionAutoTriggerService,
};
pub use create_service::{
  DocumentHistoryNameRequest, DocumentHistoryNameResult, DocumentHistorySaveRequest, DocumentHistorySaveResult,
  DocumentVersionCreateError, DocumentVersionCreateRequest, DocumentVersionCreateService,
};
pub use diff::{
  DocumentVersionBlockDiff, DocumentVersionBlockDiffKind, DocumentVersionDiff, DocumentVersionDiffError,
  DocumentVersionStateVectorDiff, DocumentVersionTextDiff, diff_snapshots,
};
pub use edit_capture::{DocumentEditCaptureRepository, DocumentEditCaptureService, EditCaptureRunSummary};
pub use label_service::{
  DocumentVersionLabelError, DocumentVersionLabelOutcome, DocumentVersionLabelPreview, DocumentVersionLabelRequest,
  DocumentVersionLabelService,
};
pub use restore_service::{DocumentVersionHistoryPort, DocumentVersionRestoreError, DocumentVersionRestoreService};
pub use settings::{
  DEFAULT_EDIT_CAPTURE_INTERVAL_MS, EffectiveWorkspaceHistorySettings, GlobalEditCaptureSettings,
  MAX_EDIT_CAPTURE_INTERVAL_MS, MIN_EDIT_CAPTURE_INTERVAL_MS, WorkspaceHistorySettingSource,
  WorkspaceHistorySettingsService, normalize_legacy_edit_capture_interval,
  resolve_effective_workspace_history_settings,
};
