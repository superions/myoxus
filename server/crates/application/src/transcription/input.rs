// SPDX-License-Identifier: AGPL-3.0-or-later
//! Encoded media inspection never transcodes or changes the original attachment.

use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;

use super::{AdmissionGuard, ProviderError};
use std::sync::Arc;

/// Keep admission counted until blocking input work actually exits, including
/// when the request awaiting it is cancelled.
#[derive(Clone)]
pub struct AudioInputWork {
  pub deadline: Instant,
  pub max_duration_seconds: u64,
  pub(super) _guard: Arc<AdmissionGuard>,
}

#[derive(Debug, Clone)]
pub struct AudioInputInfo {
  pub format: String,
  pub mime: String,
  pub duration_seconds: f64,
}

/// Inspect the actual encoded container and audio timeline within the admitted
/// deadline. Callers bound bytes before supplying this buffer.
#[async_trait]
pub trait AudioInputInspector: Send + Sync {
  async fn inspect(&self, audio: Bytes, work: AudioInputWork) -> Result<AudioInputInfo, ProviderError>;
}
