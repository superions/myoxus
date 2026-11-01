//! Runtime adapter for application-owned authentication capabilities.

use std::sync::Arc;

use async_trait::async_trait;
use lettre::message::Mailbox;
use myoxus_application::auth::{
  AuthCapabilityConfigPort, AuthCapabilityConfigState, AuthCapabilityReport, AuthCapabilityService, AuthError,
  AuthResult,
};
use myoxus_infrastructure::mail::{SmtpClient, SmtpTransportConfig};

use crate::state::ApiState;

#[derive(Clone)]
struct RuntimeAuthCapabilityConfig {
  state: ApiState,
}

impl RuntimeAuthCapabilityConfig {
  fn valid_smtp_host(host: &str) -> bool {
    if host.is_empty() || host.trim() != host {
      return false;
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
      return true;
    }

    let hostname = host.strip_suffix('.').unwrap_or(host);
    !hostname.is_empty()
      && hostname.len() <= 253
      && hostname.split('.').all(|label| {
        !label.is_empty()
          && label.len() <= 63
          && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
          && label.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
          && label.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
      })
  }

  /// Reflect the mail adapter selected at startup. DB mail values are not
  /// considered usable until the server runtime itself hot-reloads them.
  fn smtp_usable(&self) -> bool {
    let Some(host) = self.state.config.mail.smtp_host.as_deref() else {
      return false;
    };
    Self::valid_smtp_host(host)
      && self.state.config.mail.smtp_port > 0
      && self.state.config.mail.sender.parse::<Mailbox>().is_ok()
      && SmtpClient::new(
        SmtpTransportConfig {
          host: host.to_string(),
          port: self.state.config.mail.smtp_port,
          name: self.state.config.mail.smtp_name.clone(),
          username: self.state.config.mail.smtp_user.clone(),
          password: self.state.config.mail.smtp_pass.clone(),
          transport: self.state.config.mail.smtp_transport,
          verify_certificate: self.state.config.mail.smtp_verify_certificate,
        },
        self.state.config.additional_ca.as_ref(),
      )
      .is_ok()
  }
}

#[async_trait]
impl AuthCapabilityConfigPort for RuntimeAuthCapabilityConfig {
  async fn auth_capability_config_state(&self) -> AuthResult<AuthCapabilityConfigState> {
    let (google_usable, github_usable, oidc_usable, apple_usable) = tokio::try_join!(
      crate::auth::oauth::is_provider_usable_runtime(&self.state, "google"),
      crate::auth::oauth::is_provider_usable_runtime(&self.state, "github"),
      crate::auth::oauth::is_provider_usable_runtime(&self.state, "oidc"),
      crate::auth::oauth::is_provider_usable_runtime(&self.state, "apple"),
    )
    // Provider construction can inspect credential-bearing config. Keep its
    // error opaque at the application boundary; the OAuth adapter already
    // logs storage failures with provider-only context.
    .map_err(|_| AuthError::Storage("authentication runtime configuration unavailable".to_string()))?;

    Ok(AuthCapabilityConfigState {
      smtp_usable: self.smtp_usable(),
      google_usable,
      github_usable,
      oidc_usable,
      apple_usable,
    })
  }
}

/// Evaluate capabilities through the shared application service.
pub(crate) async fn evaluate_auth_capabilities(state: &ApiState) -> AuthResult<AuthCapabilityReport> {
  AuthCapabilityService::new(
    state.auth().store.clone(),
    Arc::new(RuntimeAuthCapabilityConfig { state: state.clone() }),
  )
  .evaluate()
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn config_with_smtp(host: Option<&str>, sender: &str) -> RuntimeAuthCapabilityConfig {
    let mut config = crate::config::AppConfig::load().expect("test config");
    config.mail.smtp_host = host.map(ToOwned::to_owned);
    config.mail.smtp_port = 587;
    config.mail.sender = sender.to_string();
    RuntimeAuthCapabilityConfig {
      state: ApiState::new(config),
    }
  }

  #[test]
  fn smtp_capability_requires_a_constructible_runtime_transport() {
    assert!(config_with_smtp(Some("smtp.example.test"), "noreply@example.test").smtp_usable());
    assert!(config_with_smtp(Some("mail-relay"), "noreply@example.test").smtp_usable());
    assert!(config_with_smtp(Some("192.0.2.10"), "noreply@example.test").smtp_usable());
    assert!(!config_with_smtp(None, "noreply@example.test").smtp_usable());
    assert!(!config_with_smtp(Some("smtp.example.test"), "not-an-address").smtp_usable());
    assert!(!config_with_smtp(Some("invalid host"), "noreply@example.test").smtp_usable());
    assert!(!config_with_smtp(Some("-smtp.example.test"), "noreply@example.test").smtp_usable());
    assert!(!config_with_smtp(Some("smtp..example.test"), "noreply@example.test").smtp_usable());
  }
}
