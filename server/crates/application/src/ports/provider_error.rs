// SPDX-License-Identifier: AGPL-3.0-or-later

use thiserror::Error;

/// Existing external-provider failures shared by chat, embeddings and speech.
#[derive(Debug, Error)]
pub enum ProviderError {
  /// The request was malformed or contained invalid parameters.
  #[error("invalid request: {0}")]
  InvalidRequest(String),
  /// The provider is not reachable or has no capacity.
  #[error("provider unavailable: {0}")]
  Unavailable(String),
  /// The provider returned a rate-limit response.
  #[error("rate limited: {0}")]
  RateLimited(String),
  /// The request exceeded the provider's response deadline.
  #[error("timeout: {0}")]
  Timeout(String),
  /// The provider rejected input that exceeds its context window.
  #[error("provider context limit exceeded")]
  ContextLimit,
  /// Generation ended at the provider's output limit, not successful completion.
  #[error("provider output was truncated at its output limit")]
  OutputTruncated,
  /// The provider returned an unexpected upstream error.
  #[error("upstream error: {0}")]
  Upstream(String),
}
