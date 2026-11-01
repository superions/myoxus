// SPDX-License-Identifier: AGPL-3.0-or-later
//! Composition and current-configuration caching for the speech application port.

use crate::config::TranscriptionConfig;
use myoxus_application::transcription::{ProviderError, TranscriptionConcurrency, TranscriptionService};
use myoxus_infrastructure::transcription::OpenAiTranscriptionTransport;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct TranscriptionRuntime {
  current: Mutex<Option<(TranscriptionConfig, Arc<TranscriptionService>)>>,
  concurrency: Arc<TranscriptionConcurrency>,
}

impl TranscriptionRuntime {
  /// A live reload clears the last outcome even if an off/on transition occurs
  /// between uses and returns to the same endpoint and model.
  pub async fn invalidate(&self) {
    *self.current.lock().await = None;
  }

  pub async fn service(
    &self,
    config: TranscriptionConfig,
    ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
  ) -> Result<Arc<TranscriptionService>, ProviderError> {
    let mut current = self.current.lock().await;
    if !config.configured() {
      *current = None;
      return Err(ProviderError::Unavailable("transcription is not configured".into()));
    }
    if let Some((settings, service)) = current.as_ref()
      && *settings == config
    {
      return Ok(service.clone());
    }
    // Replacing this one slot invalidates the previous check outcome. Active
    // requests may finish using their admitted snapshot and shared limiter.
    let transport = OpenAiTranscriptionTransport::new(
      config.endpoint.clone(),
      config.api_key.clone(),
      Duration::from_millis(config.request_timeout_ms),
      ca,
    )?;
    let service = Arc::new(TranscriptionService::new(
      config.enabled,
      config.execution_snapshot(),
      Arc::new(transport),
      self.concurrency.clone(),
    ));
    *current = Some((config, service.clone()));
    Ok(service)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  fn fixture() -> crate::config::AppConfig {
    yaml_serde::from_str(include_str!("../../../config/default.yaml")).unwrap()
  }

  #[tokio::test]
  async fn adapter_selection_keeps_the_snapshot_lock_until_reload_can_invalidate_it() {
    let state = Arc::new(crate::state::ApiState::new(fixture()));
    state.config_overrides.write().await.overrides.extend([
      ("transcription.enabled".into(), serde_json::json!(true)),
      (
        "transcription.endpoint".into(),
        serde_json::json!("http://127.0.0.1:1/v1"),
      ),
      ("transcription.model".into(), serde_json::json!("old-model")),
    ]);
    let blocked = state.transcription_runtime.current.lock().await;
    let reader = tokio::spawn({
      let state = state.clone();
      async move { state.transcription_snapshot().await }
    });
    // The reader is held at adapter selection. Releasing its config guard
    // earlier would let every try_write succeed and makes this deadline fail.
    tokio::time::timeout(Duration::from_secs(1), async {
      loop {
        if state.config_overrides.try_write().is_err() {
          break;
        }
        tokio::task::yield_now().await;
      }
    })
    .await
    .expect("selection must hold its effective snapshot");
    let mut changed = state.config_overrides.read().await.clone();
    changed
      .overrides
      .insert("transcription.model".into(), serde_json::json!("new-model"));
    let publisher = tokio::spawn({
      let state = state.clone();
      async move {
        crate::config_reload::publish_config_overrides(
          &state.config_overrides,
          changed,
          Some(&state.transcription_runtime),
        )
        .await;
      }
    });
    drop(blocked);
    let (selected, old) = reader.await.unwrap();
    assert_eq!(selected.model, "old-model");
    let old = old.unwrap();
    publisher.await.unwrap();
    let (selected, current) = state.transcription_snapshot().await;
    assert_eq!(selected.model, "new-model");
    let current = current.unwrap();
    assert!(!Arc::ptr_eq(&old, &current));
    assert!(old.check_connection().await.is_err());
    assert!(old.last_connection_check().await.is_some());
    assert_eq!(current.last_connection_check().await, None);
  }
  #[test]
  fn complete_candidate_requires_explicit_setup_and_redacts_debug_credentials() {
    let config = fixture();
    let incomplete = std::collections::HashMap::from([("transcription.enabled".into(), serde_json::json!(true))]);
    assert!(config.clone().with_database_overrides(&incomplete).is_err());
    let overrides = std::collections::HashMap::from([
      ("transcription.enabled".into(), serde_json::json!(true)),
      (
        "transcription.endpoint".into(),
        serde_json::json!("http://operator-stt/v1"),
      ),
      ("transcription.model".into(), serde_json::json!("operator-model")),
      (
        "transcription.api_key".into(),
        serde_json::json!("deliberately-fake-test-key"),
      ),
    ]);
    let effective = config.with_database_overrides(&overrides).unwrap();
    assert!(!effective.copilot.enabled);
    assert!(effective.transcription.enabled);
    assert!(!format!("{:?}", effective.transcription).contains("deliberately-fake-test-key"));
    assert!(
      !serde_json::to_string(&effective.transcription.execution_snapshot())
        .unwrap()
        .contains("deliberately-fake-test-key")
    );
  }
}
