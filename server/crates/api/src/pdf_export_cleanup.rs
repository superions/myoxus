// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin API adapter for application-owned PDF export cleanup.

pub use myoxus_application::pdf_export::cleanup::{
  PdfExportCleanupReport, PdfExportCleanupService, STALLED_RUNNING_AFTER_SECONDS,
};

/// Drive one bounded cleanup pass through the injected application capability.
pub async fn clean_expired_pdf_export_jobs(
  service: &PdfExportCleanupService,
) -> myoxus_application::auth::AuthResult<PdfExportCleanupReport> {
  service.clean_expired().await
}
