// SPDX-License-Identifier: AGPL-3.0-or-later
//! Speech recognition ports and execution, independent of generative providers.

use async_trait::async_trait;
use std::sync::{
  Arc,
  atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Mutex;
use tracing::instrument;

pub use crate::ports::provider_error::ProviderError;

pub mod enrichment;
pub mod input;
pub mod pipeline;
pub mod results;
pub use myoxus_domain::transcription::{TranscriptionExecutionConfig, TranscriptionResponse, TranscriptionSegment};

/// A catalog can list a model without proving that it accepts audio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionConnectionCheck {
  pub catalog_supported: bool,
  pub model_listed: Option<bool>,
}

/// Only the current adapter retains this safe result; configuration replacement
/// discards it. Errors are the existing provider error text, never response bodies.
pub type TranscriptionConnectionOutcome = Result<TranscriptionConnectionCheck, String>;

/// Speech transport receives encoded audio and only trusted server settings.
#[async_trait]
pub trait TranscriptionTransport: Send + Sync {
  fn provider_id(&self) -> &str;
  async fn check_connection(
    &self,
    _model: &str,
    _max_response_bytes: usize,
  ) -> Result<TranscriptionConnectionCheck, ProviderError> {
    Err(ProviderError::Unavailable(
      "connection check is not supported by this provider".into(),
    ))
  }
  async fn transcribe(
    &self,
    _audio: &[u8],
    _format: &str,
    _model: &str,
    _language: Option<&str>,
    _max_response_bytes: usize,
  ) -> Result<TranscriptionResponse, ProviderError> {
    Err(ProviderError::Unavailable(
      "transcription not supported by this provider".into(),
    ))
  }
}

/// Shared across configuration changes so replacing the adapter cannot reset
/// admission while requests from the previous configuration are still active.
#[derive(Default)]
pub struct TranscriptionConcurrency(AtomicUsize);

struct AdmissionGuard(Arc<TranscriptionConcurrency>);
impl Drop for AdmissionGuard {
  fn drop(&mut self) {
    self.0.0.fetch_sub(1, Ordering::AcqRel);
  }
}

pub struct TranscriptionService {
  enabled: bool,
  config: TranscriptionExecutionConfig,
  transport: Arc<dyn TranscriptionTransport>,
  concurrency: Arc<TranscriptionConcurrency>,
  last_check: Mutex<Option<bool>>,
  last_connection_check: Mutex<Option<TranscriptionConnectionOutcome>>,
}

/// One admission and deadline cover source reads, inspection and all deployed
/// slices. Holding this guard prevents a configuration change from resetting
/// the shared concurrency budget while an older attempt is still running.
pub struct TranscriptionAdmission<'a> {
  service: &'a TranscriptionService,
  pub config: TranscriptionExecutionConfig,
  pub deadline: Instant,
  _guard: Arc<AdmissionGuard>,
}

impl TranscriptionAdmission<'_> {
  pub fn input_work(&self) -> input::AudioInputWork {
    input::AudioInputWork {
      deadline: self.deadline,
      max_duration_seconds: self.config.max_duration_seconds,
      _guard: self._guard.clone(),
    }
  }
  pub async fn record_job_result(&self, succeeded: bool) {
    if self.config.source == self.service.config.source
      && self.config.model == self.service.config.model
      && self.config.language == self.service.config.language
    {
      *self.service.last_check.lock().await = Some(succeeded);
    }
  }
  #[instrument(skip_all)]
  pub async fn transcribe(&self, audio: &[u8], format: &str) -> Result<TranscriptionResponse, ProviderError> {
    self
      .transcribe_bounded(audio, format, self.config.max_response_bytes)
      .await
  }

  pub async fn transcribe_bounded(
    &self,
    audio: &[u8],
    format: &str,
    response_bytes: usize,
  ) -> Result<TranscriptionResponse, ProviderError> {
    if response_bytes == 0 {
      return Err(ProviderError::InvalidRequest(
        "speech output exceeds the configured limit".into(),
      ));
    }
    if audio.is_empty() || audio.len() as u64 > self.config.max_input_bytes {
      return Err(ProviderError::InvalidRequest(
        "audio is empty or exceeds the configured input limit".into(),
      ));
    }
    let result = async {
      let remaining = self.deadline.saturating_duration_since(Instant::now());
      if remaining.is_zero() {
        return Err(ProviderError::Timeout("speech request deadline exceeded".into()));
      }
      let response = tokio::time::timeout(
        remaining,
        self.service.transport.transcribe(
          audio,
          format,
          &self.config.model,
          self.config.language.as_deref(),
          self.config.max_response_bytes.min(response_bytes),
        ),
      )
      .await
      .unwrap_or_else(|_| Err(ProviderError::Timeout("speech request deadline exceeded".into())))?;
      if response
        .duration_seconds
        .is_some_and(|value| !value.is_finite() || value < 0.0 || value > self.config.max_duration_seconds as f64)
      {
        return Err(ProviderError::InvalidRequest(
          "audio duration exceeds the configured limit".into(),
        ));
      }
      Ok(response)
    }
    .await;
    self.record_job_result(result.is_ok()).await;
    result
  }
}

impl TranscriptionService {
  pub fn new(
    enabled: bool,
    config: TranscriptionExecutionConfig,
    transport: Arc<dyn TranscriptionTransport>,
    concurrency: Arc<TranscriptionConcurrency>,
  ) -> Self {
    Self {
      enabled,
      config,
      transport,
      concurrency,
      last_check: Mutex::new(None),
      last_connection_check: Mutex::new(None),
    }
  }

  pub async fn last_check(&self) -> Option<bool> {
    *self.last_check.lock().await
  }

  pub async fn last_connection_check(&self) -> Option<TranscriptionConnectionOutcome> {
    self.last_connection_check.lock().await.clone()
  }

  fn admit(&self, limit: usize) -> Result<AdmissionGuard, ProviderError> {
    self
      .concurrency
      .0
      .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
        (active < limit).then_some(active + 1)
      })
      .map_err(|_| ProviderError::RateLimited("speech concurrency limit reached".into()))?;
    Ok(AdmissionGuard(self.concurrency.clone()))
  }

  /// Checks the saved destination even while recognition is disabled. A catalog
  /// response never changes the recognition outcome or gates a first audio job.
  #[instrument(skip_all)]
  pub async fn check_connection(&self) -> TranscriptionConnectionOutcome {
    let result = async {
      let _admission = self.admit(self.config.max_concurrency)?;
      tokio::time::timeout(
        Duration::from_millis(self.config.request_timeout_ms),
        self
          .transport
          .check_connection(&self.config.model, self.config.max_response_bytes),
      )
      .await
      .unwrap_or_else(|_| {
        Err(ProviderError::Timeout(
          "speech connection check deadline exceeded".into(),
        ))
      })
    }
    .await;
    let outcome = result.map_err(|error| {
      tracing::error!(error = %error, "speech connection check failed");
      error.to_string()
    });
    *self.last_connection_check.lock().await = Some(outcome.clone());
    outcome
  }

  /// A readiness check is not required for first use. There is exactly one
  /// destination, and an older job cannot attach current credentials to a
  /// different endpoint. Explicit retry can admit a fresh execution snapshot.
  #[instrument(skip_all, fields(audio_bytes = audio.len()))]
  pub async fn transcribe(
    &self,
    audio: &[u8],
    format: &str,
    snapshot: Option<&TranscriptionExecutionConfig>,
  ) -> Result<TranscriptionResponse, ProviderError> {
    self.admit_job(snapshot)?.transcribe(audio, format).await
  }

  pub fn admit_job(
    &self,
    snapshot: Option<&TranscriptionExecutionConfig>,
  ) -> Result<TranscriptionAdmission<'_>, ProviderError> {
    if !self.enabled {
      return Err(ProviderError::Unavailable("transcription is disabled".into()));
    }
    let config = snapshot.unwrap_or(&self.config);
    if config.source != self.config.source {
      return Err(ProviderError::InvalidRequest(
        "speech destination changed; explicit retry is required".into(),
      ));
    }
    let mut config = config.clone();
    config.max_concurrency = config.max_concurrency.min(self.config.max_concurrency);
    config.max_input_bytes = config.max_input_bytes.min(self.config.max_input_bytes);
    config.max_response_bytes = config.max_response_bytes.min(self.config.max_response_bytes);
    config.max_duration_seconds = config.max_duration_seconds.min(self.config.max_duration_seconds);
    config.request_timeout_ms = config.request_timeout_ms.min(self.config.request_timeout_ms);
    let guard = self.admit(config.max_concurrency)?;
    Ok(TranscriptionAdmission {
      deadline: Instant::now() + Duration::from_millis(config.request_timeout_ms),
      config,
      service: self,
      _guard: Arc::new(guard),
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn transcription_response_round_trips_through_serde() {
    let response = TranscriptionResponse {
      text: "Hello, world!".to_string(),
      language: Some("en".to_string()),
      duration_seconds: Some(3.15),
      segments: Vec::new(),
    };
    let json = serde_json::to_string(&response).expect("serialize");
    let parsed: TranscriptionResponse = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(parsed.text, "Hello, world!");
    assert_eq!(parsed.language.as_deref(), Some("en"));
    assert!((parsed.duration_seconds.unwrap() - 3.15).abs() < f64::EPSILON);
  }

  #[test]
  fn transcription_response_round_trips_with_none_fields() {
    let response = TranscriptionResponse {
      text: "Some text".to_string(),
      language: None,
      duration_seconds: None,
      segments: Vec::new(),
    };
    let json = serde_json::to_string(&response).expect("serialize");
    let parsed: TranscriptionResponse = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(parsed.text, "Some text");
    assert!(parsed.language.is_none());
    assert!(parsed.duration_seconds.is_none());
  }

  struct SpeechTransport {
    calls: AtomicUsize,
    delayed: bool,
  }
  #[async_trait]
  impl TranscriptionTransport for SpeechTransport {
    fn provider_id(&self) -> &str {
      "external-speech"
    }
    async fn check_connection(
      &self,
      model: &str,
      _max_response_bytes: usize,
    ) -> Result<TranscriptionConnectionCheck, ProviderError> {
      self.calls.fetch_add(1, Ordering::SeqCst);
      assert_eq!(model, "configured-model");
      if self.delayed {
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
      Ok(TranscriptionConnectionCheck {
        catalog_supported: true,
        model_listed: Some(true),
      })
    }
    async fn transcribe(
      &self,
      _audio: &[u8],
      _format: &str,
      model: &str,
      language: Option<&str>,
      _max_response_bytes: usize,
    ) -> Result<TranscriptionResponse, ProviderError> {
      self.calls.fetch_add(1, Ordering::SeqCst);
      if self.delayed {
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
      assert_eq!(model, "configured-model");
      assert_eq!(language, Some("de"));
      Ok(TranscriptionResponse {
        text: "Hallo Welt".into(),
        language: Some("de".into()),
        duration_seconds: None,
        segments: vec![],
      })
    }
  }
  fn config() -> TranscriptionExecutionConfig {
    TranscriptionExecutionConfig {
      source: "http://operator-stt/v1".into(),
      model: "configured-model".into(),
      language: Some("de".into()),
      request_timeout_ms: 1000,
      max_input_bytes: 1000,
      max_response_bytes: 1024,
      max_duration_seconds: 60,
      max_concurrency: 1,
    }
  }
  #[tokio::test]
  async fn cancelled_input_keeps_concurrency_counted_until_blocking_work_exits() {
    let service = TranscriptionService::new(
      true,
      config(),
      Arc::new(SpeechTransport {
        calls: AtomicUsize::new(0),
        delayed: false,
      }),
      Arc::default(),
    );
    let admission = service.admit_job(None).unwrap();
    let work = admission.input_work();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (exit_tx, exit_rx) = std::sync::mpsc::channel();
    let task = tokio::task::spawn_blocking(move || {
      let _work = work;
      started_tx.send(()).unwrap();
      exit_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    });
    started_rx.await.unwrap();
    drop(admission);
    assert!(matches!(service.admit_job(None), Err(ProviderError::RateLimited(_))));
    exit_tx.send(()).unwrap();
    task.await.unwrap();
    assert!(service.admit_job(None).is_ok());
  }

  #[tokio::test]
  async fn admission_covers_input_work_and_slices_share_one_deadline() {
    let transport = Arc::new(SpeechTransport {
      calls: AtomicUsize::new(0),
      delayed: false,
    });
    let service = TranscriptionService::new(true, config(), transport.clone(), Arc::default());
    let mut admission = service.admit_job(None).unwrap();
    assert!(matches!(service.admit_job(None), Err(ProviderError::RateLimited(_))));
    assert_eq!(admission.transcribe(b"first", "wav").await.unwrap().text, "Hallo Welt");
    admission.deadline = Instant::now() - Duration::from_secs(1);
    assert!(matches!(
      admission.transcribe(b"second", "wav").await,
      Err(ProviderError::Timeout(_))
    ));
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    drop(admission);
    assert!(service.admit_job(None).is_ok());
  }

  #[tokio::test]
  async fn disable_limits_and_destination_changes_prevent_transfer() {
    let transport = Arc::new(SpeechTransport {
      calls: AtomicUsize::new(0),
      delayed: false,
    });
    let service = TranscriptionService::new(false, config(), transport.clone(), Arc::default());
    assert!(service.transcribe(b"audio", "wav", None).await.is_err());
    let service = TranscriptionService::new(true, config(), transport.clone(), Arc::default());
    assert!(service.transcribe(&vec![0; 1001], "wav", None).await.is_err());
    let mut snapshot = config();
    snapshot.source = "http://other-host/v1".into();
    assert!(service.transcribe(b"audio", "wav", Some(&snapshot)).await.is_err());
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    assert_eq!(service.last_check().await, None);
  }

  #[tokio::test]
  async fn a_configuration_replacement_cannot_bypass_an_active_request_limit() {
    let transport = Arc::new(SpeechTransport {
      calls: AtomicUsize::new(0),
      delayed: true,
    });
    let admission = Arc::default();
    let service = Arc::new(TranscriptionService::new(
      true,
      config(),
      transport.clone(),
      Arc::clone(&admission),
    ));
    let active = tokio::spawn({
      let service = service.clone();
      async move { service.transcribe(b"audio", "wav", None).await }
    });
    tokio::time::timeout(Duration::from_secs(1), async {
      while transport.calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
      }
    })
    .await
    .unwrap();
    let replacement = TranscriptionService::new(true, config(), transport.clone(), admission);
    assert!(matches!(
      replacement.transcribe(b"audio", "wav", None).await,
      Err(ProviderError::RateLimited(_))
    ));
    active.await.unwrap().unwrap();
    assert_eq!(
      replacement.transcribe(b"audio", "wav", None).await.unwrap().text,
      "Hallo Welt"
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
  }
}
