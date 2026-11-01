//! Shared authentication capability evaluation.
//!
//! Setup diagnostics and public server configuration consume this service so
//! they cannot drift into separate password, SMTP, or OAuth availability
//! rules. Persistence and runtime configuration remain injected ports; the
//! application layer only combines their already-sanitized state.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::{AuthResult, AuthStore};

/// Stable authentication method identifiers exposed to clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethodCode {
  Password,
  MagicLink,
  Google,
  Github,
  Oidc,
  Apple,
}

impl AuthMethodCode {
  /// Return the stable wire representation used by GraphQL and i18n keys.
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Password => "password",
      Self::MagicLink => "magic_link",
      Self::Google => "google",
      Self::Github => "github",
      Self::Oidc => "oidc",
      Self::Apple => "apple",
    }
  }
}

/// Stable reason identifiers for an unavailable authentication method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthCapabilityReasonCode {
  NoActivePasswordUser,
  SmtpUnavailable,
  ProviderUnavailable,
}

impl AuthCapabilityReasonCode {
  /// Return the stable code consumed by localized clients.
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::NoActivePasswordUser => "NO_ACTIVE_PASSWORD_USER",
      Self::SmtpUnavailable => "SMTP_UNAVAILABLE",
      Self::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
    }
  }
}

/// Minimal account aggregate required by capability evaluation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuthCapabilityAccountState {
  pub total_users: u64,
  pub active_password_users: u64,
}

/// Sanitized runtime configuration state supplied by the API adapter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuthCapabilityConfigState {
  pub smtp_usable: bool,
  pub google_usable: bool,
  pub github_usable: bool,
  pub oidc_usable: bool,
  pub apple_usable: bool,
}

/// Port that resolves runtime configuration using the same validation as the
/// corresponding authentication handlers.
#[async_trait]
pub trait AuthCapabilityConfigPort: Send + Sync {
  async fn auth_capability_config_state(&self) -> AuthResult<AuthCapabilityConfigState>;
}

/// Availability of one stable authentication method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthMethodCapability {
  pub method: AuthMethodCode,
  pub supported: bool,
  pub usable: bool,
  pub reason_code: Option<AuthCapabilityReasonCode>,
}

impl AuthMethodCapability {
  fn from_availability(method: AuthMethodCode, usable: bool, unavailable_reason: AuthCapabilityReasonCode) -> Self {
    Self {
      method,
      supported: true,
      usable,
      reason_code: (!usable).then_some(unavailable_reason),
    }
  }
}

/// Complete authentication capability report for one server state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthCapabilityReport {
  pub bootstrap_available: bool,
  pub methods: Vec<AuthMethodCapability>,
}

impl AuthCapabilityReport {
  /// Whether at least one method can authenticate an existing user now.
  pub fn has_usable_method(&self) -> bool {
    self.methods.iter().any(|method| method.usable)
  }

  /// Look up one method without relying on vector position in consumers.
  pub fn method(&self, method: AuthMethodCode) -> Option<&AuthMethodCapability> {
    self.methods.iter().find(|capability| capability.method == method)
  }
}

/// Application-owned capability evaluator shared by setup and server config.
pub struct AuthCapabilityService {
  accounts: Arc<dyn AuthStore>,
  config: Arc<dyn AuthCapabilityConfigPort>,
}

impl AuthCapabilityService {
  pub fn new(accounts: Arc<dyn AuthStore>, config: Arc<dyn AuthCapabilityConfigPort>) -> Self {
    Self { accounts, config }
  }

  /// Resolve account and runtime config state and build the stable matrix.
  pub async fn evaluate(&self) -> AuthResult<AuthCapabilityReport> {
    let (accounts, config) = tokio::try_join!(
      self.accounts.auth_capability_account_state(),
      self.config.auth_capability_config_state(),
    )?;

    Ok(AuthCapabilityReport {
      bootstrap_available: accounts.total_users == 0,
      methods: vec![
        AuthMethodCapability::from_availability(
          AuthMethodCode::Password,
          accounts.active_password_users > 0,
          AuthCapabilityReasonCode::NoActivePasswordUser,
        ),
        AuthMethodCapability::from_availability(
          AuthMethodCode::MagicLink,
          config.smtp_usable,
          AuthCapabilityReasonCode::SmtpUnavailable,
        ),
        AuthMethodCapability::from_availability(
          AuthMethodCode::Google,
          config.google_usable,
          AuthCapabilityReasonCode::ProviderUnavailable,
        ),
        AuthMethodCapability::from_availability(
          AuthMethodCode::Github,
          config.github_usable,
          AuthCapabilityReasonCode::ProviderUnavailable,
        ),
        AuthMethodCapability::from_availability(
          AuthMethodCode::Oidc,
          config.oidc_usable,
          AuthCapabilityReasonCode::ProviderUnavailable,
        ),
        AuthMethodCapability::from_availability(
          AuthMethodCode::Apple,
          config.apple_usable,
          AuthCapabilityReasonCode::ProviderUnavailable,
        ),
      ],
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::auth::{AuthError, AuthUser, InMemoryAuthStore};
  use uuid::Uuid;

  struct StaticConfig(AuthCapabilityConfigState);

  #[async_trait]
  impl AuthCapabilityConfigPort for StaticConfig {
    async fn auth_capability_config_state(&self) -> AuthResult<AuthCapabilityConfigState> {
      Ok(self.0)
    }
  }

  fn user(password: bool, disabled: bool) -> AuthUser {
    let id = Uuid::new_v4();
    AuthUser {
      id,
      email: format!("{id}@example.test"),
      name: None,
      avatar_url: None,
      password_hash: password.then(|| "test-hash".to_string()),
      is_admin: false,
      disabled,
      email_verified_at: None,
      registered: true,
    }
  }

  async fn evaluate(store: Arc<InMemoryAuthStore>, config: AuthCapabilityConfigState) -> AuthCapabilityReport {
    AuthCapabilityService::new(store, Arc::new(StaticConfig(config)))
      .evaluate()
      .await
      .expect("capability evaluation")
  }

  #[tokio::test]
  async fn reports_bootstrap_without_claiming_an_unusable_method() {
    let report = evaluate(
      Arc::new(InMemoryAuthStore::default()),
      AuthCapabilityConfigState::default(),
    )
    .await;

    assert!(report.bootstrap_available);
    assert!(!report.has_usable_method());
    assert_eq!(report.methods.len(), 6);
    assert_eq!(
      report
        .method(AuthMethodCode::Password)
        .and_then(|method| method.reason_code),
      Some(AuthCapabilityReasonCode::NoActivePasswordUser)
    );
  }

  #[tokio::test]
  async fn password_requires_an_active_registered_account_with_a_hash() {
    let store = Arc::new(InMemoryAuthStore::default());
    store.insert_user(user(false, false));
    store.insert_user(user(true, true));

    let unavailable = evaluate(store.clone(), AuthCapabilityConfigState::default()).await;
    assert!(!unavailable.bootstrap_available);
    assert!(!unavailable.method(AuthMethodCode::Password).unwrap().usable);

    store.insert_user(user(true, false));
    let available = evaluate(store, AuthCapabilityConfigState::default()).await;
    assert!(available.method(AuthMethodCode::Password).unwrap().usable);
    assert_eq!(available.method(AuthMethodCode::Password).unwrap().reason_code, None);
  }

  #[tokio::test]
  async fn deleted_password_account_does_not_keep_password_usable() -> Result<(), AuthError> {
    let store = Arc::new(InMemoryAuthStore::default());
    let account = user(true, false);
    store.insert_user(account.clone());
    store.delete_user(account.id).await?;

    let report = evaluate(store, AuthCapabilityConfigState::default()).await;
    assert!(report.bootstrap_available);
    assert!(!report.method(AuthMethodCode::Password).unwrap().usable);
    Ok(())
  }

  #[tokio::test]
  async fn each_runtime_method_is_reported_independently() {
    let cases = [
      (
        AuthMethodCode::MagicLink,
        AuthCapabilityConfigState {
          smtp_usable: true,
          ..Default::default()
        },
      ),
      (
        AuthMethodCode::Google,
        AuthCapabilityConfigState {
          google_usable: true,
          ..Default::default()
        },
      ),
      (
        AuthMethodCode::Github,
        AuthCapabilityConfigState {
          github_usable: true,
          ..Default::default()
        },
      ),
      (
        AuthMethodCode::Oidc,
        AuthCapabilityConfigState {
          oidc_usable: true,
          ..Default::default()
        },
      ),
      (
        AuthMethodCode::Apple,
        AuthCapabilityConfigState {
          apple_usable: true,
          ..Default::default()
        },
      ),
    ];

    for (expected, config) in cases {
      let report = evaluate(Arc::new(InMemoryAuthStore::default()), config).await;
      let usable = report.methods.iter().filter(|method| method.usable).collect::<Vec<_>>();
      assert_eq!(usable.len(), 1, "only {expected:?} should be usable");
      assert_eq!(usable[0].method, expected);
      assert_eq!(usable[0].reason_code, None);
    }
  }

  #[tokio::test]
  async fn combined_configuration_preserves_all_six_methods() {
    let store = Arc::new(InMemoryAuthStore::default());
    store.insert_user(user(true, false));
    let report = evaluate(
      store,
      AuthCapabilityConfigState {
        smtp_usable: true,
        google_usable: true,
        github_usable: true,
        oidc_usable: true,
        apple_usable: true,
      },
    )
    .await;

    assert!(report.methods.iter().all(|method| method.supported && method.usable));
  }
}
