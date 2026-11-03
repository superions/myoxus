//! AppConfig validation, serialization, and SMTP testing helpers.
//!
//! Extracted from `graphql/mod.rs` (P22-C-01) to reduce file size.
//! These functions are used by the structured Admin configuration and SMTP
//! test resolvers.

use async_graphql::Result;
use myoxus_application::ports::{MailPort, MailTemplate, TemplateMail};
use myoxus_contracts::effective_config::{find_descriptor_parts, is_nullable_config_path};
use myoxus_infrastructure::mail::{MailConfig, SmtpMailAdapter, SmtpTransportMode};
use serde::Deserialize;
use tracing::instrument;

use super::UpdateAppConfigInput;

// ─── Validation ──────────────────────────────────────────────────────────────

/// Result of validating a single config update.
pub fn validate_update(update: UpdateAppConfigInput) -> super::AppConfigValidateResultType {
  let module = update.module.trim();
  let key = update.key.trim();
  let value = update.value.unwrap_or(serde_json::Value::Null);
  let mut error = None;
  if module.is_empty() {
    error = Some("module must not be empty".to_string());
  } else if key.is_empty() {
    error = Some("key must not be empty".to_string());
  } else if module == "system" && key == "setupCompleted" {
    // Internal wizard state uses the audited config mutation and cache
    // invalidation path, but it is deliberately absent from the operator-
    // editable config registry and schema projection.
    if !value.is_boolean() {
      error = Some("invalid value type for system.setupCompleted: expected boolean".to_string());
    }
  } else if let Some(descriptor) = find_descriptor_parts(module, key) {
    if !descriptor.database_writable() {
      error = Some(format!(
        "{}.{} is configured through YAML, environment, or a secret file only",
        module, key
      ));
    }
    // GraphQL null releases non-nullable overrides. Paths whose typed runtime
    // contract deliberately accepts null continue to persist it as a value.
    if !(value.is_null() && !is_nullable_config_path(descriptor.path))
      && let Err(validation_error) = myoxus_infrastructure::app_config::validate_config_value(descriptor.path, &value)
    {
      error = Some(validation_error.to_string());
    }
  } else {
    error = Some(format!("unknown config key {}.{}", module, key));
  }
  super::AppConfigValidateResultType {
    module: update.module,
    key: update.key,
    value,
    valid: error.is_none(),
    error,
  }
}

/// Exercises the same registered value contract used by every persistence transport.
#[cfg(test)]
fn validate_registered_app_config_value(module: &str, key: &str, value: &serde_json::Value) -> Option<String> {
  myoxus_infrastructure::app_config::validate_config_value(&format!("{module}.{key}"), value)
    .err()
    .map(|error| error.to_string())
}

// ─── JSON helpers ────────────────────────────────────────────────────────────

pub(crate) fn set_json_path_value(root: &mut serde_json::Value, dotted_path: &str, value: serde_json::Value) {
  let mut current = root;
  let mut parts = dotted_path.split('.').peekable();
  while let Some(part) = parts.next() {
    let is_last = parts.peek().is_none();
    if is_last {
      if !current.is_object() {
        *current = serde_json::Value::Object(serde_json::Map::new());
      }
      if let Some(map) = current.as_object_mut() {
        map.insert(part.to_string(), value);
      }
      return;
    }
    if !current.is_object() {
      *current = serde_json::Value::Object(serde_json::Map::new());
    }
    let map = current
      .as_object_mut()
      .expect("current is Object — guarded by if-branch above");
    current = map
      .entry(part.to_string())
      .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
  }
}

pub(crate) fn append_query_params(base: &str, params: &[(&str, String)]) -> String {
  let mut url = base.to_string();
  let mut first = !url.contains('?');
  for (key, value) in params {
    if first {
      url.push('?');
      first = false;
    } else {
      url.push('&');
    }
    url.push_str(key);
    url.push('=');
    url.push_str(&urlencoding::encode(value));
  }
  url
}

// ─── Base config builder ─────────────────────────────────────────────────────

/// Serializes the typed startup configuration before canonical database rows
/// are overlaid by the Admin projection. This is a projection, not a second
/// registry or effective-value store.
pub(crate) fn typed_app_config_json(state: &crate::state::ApiState) -> serde_json::Value {
  serde_json::to_value(&state.config).expect("typed AppConfig must serialize")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SmtpTestConfig {
  pub host: String,
  pub port: u16,
  pub name: Option<String>,
  pub username: Option<String>,
  pub password: Option<String>,
  #[serde(default)]
  pub transport: SmtpTransportMode,
  #[serde(default = "default_smtp_verify_certificate")]
  pub verify_certificate: bool,
  pub sender: Option<String>,
}

const fn default_smtp_verify_certificate() -> bool {
  true
}

pub(crate) fn parse_smtp_test_config(config: serde_json::Value, default_sender: String) -> Result<SmtpTestConfig> {
  let mut parsed: SmtpTestConfig =
    serde_json::from_value(config).map_err(|e| async_graphql::Error::new(format!("invalid smtp test config: {e}")))?;
  if parsed.host.trim().is_empty() {
    return Err(async_graphql::Error::new(
      "invalid smtp test config: host must not be empty",
    ));
  }
  if parsed.port == 0 {
    return Err(async_graphql::Error::new(
      "invalid smtp test config: port must be greater than zero",
    ));
  }
  if parsed.sender.as_deref().map(str::trim).unwrap_or_default().is_empty() {
    parsed.sender = Some(default_sender);
  }
  parsed.username = parsed
    .username
    .take()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());
  parsed.password = parsed.password.take().filter(|value| !value.trim().is_empty());
  if parsed.username.is_some() != parsed.password.is_some() {
    return Err(async_graphql::Error::new(
      "invalid smtp test config: username and password must both be provided or both be empty",
    ));
  }
  Ok(parsed)
}

/// SMTP test uses the submitted endpoint and the configured editable mail catalog.
#[instrument(skip_all)]
pub(crate) async fn send_test_email_with_templates(
  config: &SmtpTestConfig,
  target_email: &str,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
  renderer: std::sync::Arc<myoxus_infrastructure::mail::MailTemplateRenderer>,
  locale: &str,
  origin: &str,
) -> Result<()> {
  let sender = SmtpMailAdapter::with_renderer(
    MailConfig {
      smtp_host: config.host.trim().to_string(),
      smtp_port: config.port,
      smtp_name: config.name.clone(),
      smtp_user: config.username.clone(),
      smtp_pass: config.password.clone(),
      smtp_transport: config.transport,
      smtp_verify_certificate: config.verify_certificate,
      fallback_smtp: None,
      fallback_domains: vec![],
      from_email: config.sender.clone().unwrap_or_else(|| "noreply@localhost".into()),
      template_dir: renderer.directory().into(),
    },
    additional_ca.cloned(),
    renderer,
  );
  let mail = TemplateMail::new(
    target_email,
    MailTemplate::SmtpTest,
    myoxus_application::ports::MailPresentation::from_defaults(
      &myoxus_application::auth::UserPreferenceDefaults::default(),
      Some(locale),
    ),
    serde_json::json!({"url":format!("{}/adminfrontend/system",origin.trim_end_matches('/'))}),
  );
  sender
    .send_template(mail)
    .await
    .map_err(|error| async_graphql::Error::new(error.to_string()))
}

#[cfg(test)]
async fn send_test_email_via_smtp(
  config: &SmtpTestConfig,
  target_email: &str,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> Result<()> {
  let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/mail");
  send_test_email_with_templates(
    config,
    target_email,
    additional_ca,
    std::sync::Arc::new(
      myoxus_infrastructure::mail::MailTemplateRenderer::new(directory.to_str().expect("template path"))
        .expect("mail catalog"),
    ),
    "en",
    "https://myoxus.example",
  )
  .await
}

#[cfg(test)]
mod smtp_test_email_tests {
  use myoxus_tests::smtp_fixture::{SmtpFixture, SmtpFixtureAuth, SmtpFixtureOptions, SmtpFixtureTransport};

  use super::*;

  fn test_config(
    fixture: &SmtpFixture,
    transport: SmtpTransportMode,
    verify_certificate: bool,
    authenticated: bool,
  ) -> SmtpTestConfig {
    SmtpTestConfig {
      host: fixture.host().to_string(),
      port: fixture.port(),
      name: None,
      username: authenticated.then(|| "fixture-user".to_string()),
      password: authenticated.then(|| " fixture-password ".to_string()),
      transport,
      verify_certificate,
      sender: Some("sender@example.test".to_string()),
    }
  }

  #[tokio::test]
  async fn test_email_uses_the_production_transport_matrix() {
    let plain = SmtpFixture::start(SmtpFixtureOptions::plain(SmtpFixtureAuth::None)).await;
    send_test_email_via_smtp(
      &test_config(&plain, SmtpTransportMode::Plain, true, false),
      "recipient@example.test",
      None,
    )
    .await
    .expect("plain no-auth test delivery");
    assert_eq!(plain.messages().await.len(), 1);
    assert_eq!(plain.auth_attempts().await, 0);

    let starttls = SmtpFixture::start(SmtpFixtureOptions::starttls(SmtpFixtureAuth::None)).await;
    send_test_email_via_smtp(
      &test_config(&starttls, SmtpTransportMode::Starttls, false, false),
      "recipient@example.test",
      None,
    )
    .await
    .expect("STARTTLS test delivery");
    assert_eq!(starttls.messages().await.len(), 1);

    let implicit = SmtpFixture::start(SmtpFixtureOptions::implicit_tls(SmtpFixtureAuth::Accept)).await;
    send_test_email_via_smtp(
      &test_config(&implicit, SmtpTransportMode::ImplicitTls, false, true),
      "recipient@example.test",
      None,
    )
    .await
    .expect("implicit TLS authenticated test delivery");
    assert_eq!(implicit.messages().await.len(), 1);
    assert_eq!(implicit.auth_attempts().await, 1);
  }

  #[tokio::test]
  async fn test_email_rejects_missing_starttls_untrusted_certificates_and_auth_failure() {
    let missing_starttls = SmtpFixture::start(SmtpFixtureOptions {
      transport: SmtpFixtureTransport::Starttls,
      advertise_starttls: false,
      auth: SmtpFixtureAuth::None,
    })
    .await;
    let error = send_test_email_via_smtp(
      &test_config(&missing_starttls, SmtpTransportMode::Starttls, false, false),
      "recipient@example.test",
      None,
    )
    .await
    .expect_err("required STARTTLS must not downgrade");
    assert!(error.message.contains("SMTP_STARTTLS_REQUIRED"));

    let untrusted = SmtpFixture::start(SmtpFixtureOptions::implicit_tls(SmtpFixtureAuth::None)).await;
    let error = send_test_email_via_smtp(
      &test_config(&untrusted, SmtpTransportMode::ImplicitTls, true, false),
      "recipient@example.test",
      None,
    )
    .await
    .expect_err("certificate verification must reject the fixture root");
    assert!(error.message.contains("SMTP_CERTIFICATE_REJECTED"));

    let rejected = SmtpFixture::start(SmtpFixtureOptions::plain(SmtpFixtureAuth::Reject)).await;
    let error = send_test_email_via_smtp(
      &test_config(&rejected, SmtpTransportMode::Plain, true, true),
      "recipient@example.test",
      None,
    )
    .await
    .expect_err("rejected authentication must fail");
    assert!(error.message.contains("SMTP_AUTHENTICATION_REJECTED"));
    assert!(!error.message.contains("fixture-password"));
  }

  #[test]
  fn smtp_test_config_normalizes_empty_credentials_without_mutating_secret_bytes() {
    let parsed = parse_smtp_test_config(
      serde_json::json!({
        "host": "localhost",
        "port": 25,
        "username": " ",
        "password": "",
        "transport": "plain",
        "verifyCertificate": true
      }),
      "sender@example.test".to_string(),
    )
    .expect("empty credentials disable authentication");
    assert_eq!(parsed.username, None);
    assert_eq!(parsed.password, None);

    let parsed = parse_smtp_test_config(
      serde_json::json!({
        "host": "localhost",
        "port": 25,
        "username": " operator ",
        "password": " secret with spaces ",
        "transport": "plain",
        "verifyCertificate": true
      }),
      "sender@example.test".to_string(),
    )
    .expect("complete credentials");
    assert_eq!(parsed.username.as_deref(), Some("operator"));
    assert_eq!(parsed.password.as_deref(), Some(" secret with spaces "));

    assert!(
      parse_smtp_test_config(
        serde_json::json!({
          "host": "localhost",
          "port": 25,
          "username": "operator",
          "password": "",
          "transport": "plain",
          "verifyCertificate": true
        }),
        "sender@example.test".to_string(),
      )
      .is_err()
    );
  }
}

// ─── Server Setup Status (P91-CFG-C) ──────────────────────────────────────────

/// Stable severity of an operational setup finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServerSetupFindingSeverity {
  Critical,
  Warning,
}

impl ServerSetupFindingSeverity {
  pub(crate) const fn as_str(self) -> &'static str {
    match self {
      Self::Critical => "critical",
      Self::Warning => "warning",
    }
  }
}

/// Structured, locale-neutral operational setup finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerSetupFinding {
  pub code: &'static str,
  pub severity: ServerSetupFindingSeverity,
}

/// Server setup status keeps wizard completion separate from runtime health.
#[derive(Debug, Clone)]
pub(crate) struct ServerSetupStatus {
  pub setup_completed: bool,
  pub operational_ready: bool,
  pub auth_capabilities: myoxus_application::auth::AuthCapabilityReport,
  pub findings: Vec<ServerSetupFinding>,
}

fn valid_external_origin(origin: &str) -> bool {
  let Ok(url) = reqwest::Url::parse(origin) else {
    return false;
  };
  if !matches!(url.scheme(), "http" | "https") {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("0.0.0.0") {
    return false;
  }
  host
    .trim_start_matches('[')
    .trim_end_matches(']')
    .parse::<std::net::IpAddr>()
    .map(|address| !address.is_loopback() && !address.is_unspecified())
    .unwrap_or(true)
}

fn evaluate_server_setup_status(
  setup_completed: bool,
  crypto_key: &str,
  external_origin: &str,
  throttle_enabled: bool,
  auth_capabilities: myoxus_application::auth::AuthCapabilityReport,
) -> ServerSetupStatus {
  use myoxus_application::auth::AuthMethodCode;

  let mut findings = Vec::new();
  if crypto_key.trim().len() < 32 || crypto_key == "myoxus-change-me-private-key" {
    findings.push(ServerSetupFinding {
      code: "CRYPTO_UNSAFE",
      severity: ServerSetupFindingSeverity::Critical,
    });
  }
  if !valid_external_origin(external_origin) {
    findings.push(ServerSetupFinding {
      code: "SERVER_ORIGIN_INVALID",
      severity: ServerSetupFindingSeverity::Critical,
    });
  }
  if !auth_capabilities
    .method(AuthMethodCode::MagicLink)
    .is_some_and(|method| method.usable)
  {
    findings.push(ServerSetupFinding {
      code: "SMTP_UNAVAILABLE",
      severity: ServerSetupFindingSeverity::Warning,
    });
  }
  if !auth_capabilities.bootstrap_available && !auth_capabilities.has_usable_method() {
    findings.push(ServerSetupFinding {
      code: "AUTH_METHOD_UNAVAILABLE",
      severity: ServerSetupFindingSeverity::Critical,
    });
  }
  if !throttle_enabled {
    findings.push(ServerSetupFinding {
      code: "RATE_LIMIT_DISABLED",
      severity: ServerSetupFindingSeverity::Warning,
    });
  }
  let operational_ready = findings
    .iter()
    .all(|finding| finding.severity != ServerSetupFindingSeverity::Critical);

  ServerSetupStatus {
    setup_completed,
    operational_ready,
    auth_capabilities,
    findings,
  }
}

async fn read_setup_completed(state: &crate::state::ApiState) -> async_graphql::Result<bool> {
  state.setup_state().setup_completed().await.map_err(|error| {
    tracing::error!(error = %error, "failed to read setup completion state");
    async_graphql::Error::new("setup completion state unavailable")
  })
}

/// Evaluate persisted wizard state and current operational readiness.
pub(crate) async fn check_server_setup_status(
  state: &crate::state::ApiState,
) -> async_graphql::Result<ServerSetupStatus> {
  let (setup_completed, auth_capabilities) = tokio::try_join!(read_setup_completed(state), async {
    crate::auth::capabilities::evaluate_auth_capabilities(state)
      .await
      .map_err(|error| {
        tracing::error!(error = %error, "failed to evaluate authentication capabilities");
        async_graphql::Error::new("authentication capability state unavailable")
      })
  })?;

  Ok(evaluate_server_setup_status(
    setup_completed,
    &state.config.crypto.private_key,
    &state.config.server.origin,
    state.config.throttle.enabled,
    auth_capabilities,
  ))
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::auth::{AuthCapabilityReport, AuthMethodCapability, AuthMethodCode};
  use myoxus_contracts::effective_config::find_descriptor;
  use serde_json::json;

  fn auth_report(bootstrap_available: bool, usable_methods: &[AuthMethodCode]) -> AuthCapabilityReport {
    let methods = [
      AuthMethodCode::Password,
      AuthMethodCode::MagicLink,
      AuthMethodCode::Google,
      AuthMethodCode::Github,
      AuthMethodCode::Oidc,
      AuthMethodCode::Apple,
    ]
    .into_iter()
    .map(|method| AuthMethodCapability {
      method,
      supported: true,
      usable: usable_methods.contains(&method),
      reason_code: None,
    })
    .collect();
    AuthCapabilityReport {
      bootstrap_available,
      methods,
    }
  }

  #[test]
  fn bootstrap_does_not_emit_auth_method_blocker() {
    let status = evaluate_server_setup_status(
      false,
      "secure-test-key-with-at-least-32-chars",
      "https://workspace.example.test",
      true,
      auth_report(true, &[]),
    );

    assert!(status.operational_ready);
    assert!(status.findings.iter().any(|finding| finding.code == "SMTP_UNAVAILABLE"));
    assert!(
      !status
        .findings
        .iter()
        .any(|finding| finding.code == "AUTH_METHOD_UNAVAILABLE")
    );
  }

  #[test]
  fn initialized_server_without_usable_auth_is_not_operational() {
    let status = evaluate_server_setup_status(
      true,
      "secure-test-key-with-at-least-32-chars",
      "https://workspace.example.test",
      true,
      auth_report(false, &[]),
    );

    assert!(status.setup_completed);
    assert!(!status.operational_ready);
    assert!(status.findings.iter().any(|finding| {
      finding.code == "AUTH_METHOD_UNAVAILABLE" && finding.severity == ServerSetupFindingSeverity::Critical
    }));
  }

  #[test]
  fn setup_completion_never_suppresses_crypto_or_origin_findings() {
    let status = evaluate_server_setup_status(
      true,
      "myoxus-change-me-private-key",
      "http://127.0.0.1:3001",
      true,
      auth_report(false, &[AuthMethodCode::Password]),
    );

    assert!(status.setup_completed);
    assert!(!status.operational_ready);
    assert!(status.findings.iter().any(|finding| finding.code == "CRYPTO_UNSAFE"));
    assert!(
      status
        .findings
        .iter()
        .any(|finding| finding.code == "SERVER_ORIGIN_INVALID")
    );
  }

  #[test]
  fn password_only_server_is_operational_with_noncritical_smtp_warning() {
    let status = evaluate_server_setup_status(
      true,
      "secure-test-key-with-at-least-32-chars",
      "https://workspace.example.test",
      true,
      auth_report(false, &[AuthMethodCode::Password]),
    );

    assert!(status.operational_ready);
    assert_eq!(status.findings.len(), 1);
    assert_eq!(status.findings[0].code, "SMTP_UNAVAILABLE");
    assert_eq!(status.findings[0].severity, ServerSetupFindingSeverity::Warning);
  }

  #[test]
  fn external_origin_rejects_non_http_and_local_addresses() {
    for invalid in [
      "",
      "workspace.example.test",
      "ftp://workspace.example.test",
      "http://localhost:3001",
      "http://0.0.0.0:3001",
      "http://[::1]:3001",
    ] {
      assert!(
        !valid_external_origin(invalid),
        "{invalid} must not be an external origin"
      );
    }
    assert!(valid_external_origin("https://workspace.example.test"));
  }

  #[test]
  fn setup_completion_is_validated_but_not_operator_config_schema() {
    let valid = validate_update(UpdateAppConfigInput {
      module: "system".to_string(),
      key: "setupCompleted".to_string(),
      value: Some(serde_json::Value::Bool(true)),
    });
    assert!(
      valid.valid,
      "internal setup completion must use the audited config write path"
    );
    assert_eq!(find_descriptor("system.setupCompleted"), None);

    let invalid = validate_update(UpdateAppConfigInput {
      module: "system".to_string(),
      key: "setupCompleted".to_string(),
      value: Some(serde_json::Value::String("true".to_string())),
    });
    assert!(!invalid.valid, "non-boolean setup completion must be rejected");
  }

  #[test]
  fn database_reminder_config_contract_is_restart_required_and_bounded() {
    for (path, minimum, maximum) in [
      ("databases.max_reminders_per_user_per_cell", 1, 20),
      ("databases.max_reminder_offset_minutes", 0, 5_256_000),
    ] {
      let descriptor = find_descriptor(path).unwrap_or_else(|| panic!("missing descriptor for {path}"));
      let (module, key) = descriptor.module_and_key();
      assert!(descriptor.restart_required, "{path} is startup materialized");
      assert!(!descriptor.immediate_apply, "{path} must not claim live application");
      assert_eq!(descriptor.min_value, Some(minimum));
      assert_eq!(descriptor.max_value, Some(maximum));
      assert!(validate_registered_app_config_value(module, key, &json!(minimum)).is_none());
      assert!(validate_registered_app_config_value(module, key, &json!(maximum)).is_none());
      assert!(validate_registered_app_config_value(module, key, &json!(minimum - 1)).is_some());
      assert!(validate_registered_app_config_value(module, key, &json!(maximum + 1)).is_some());
    }
  }

  #[test]
  fn unregistered_branding_config_paths_are_rejected() {
    for (key, value) in [
      ("accentPrimary", serde_json::json!("#F00")),
      ("accentSecondary", serde_json::json!("#0A6DCA")),
      ("accentPrimaryDark", serde_json::json!("#1E96EB")),
      ("accentSecondaryDark", serde_json::json!("#123456")),
      ("logoUrl", serde_json::json!("/style/logo.svg")),
      ("productMarkUrl", serde_json::json!("/style/product.svg")),
    ] {
      assert_eq!(find_descriptor(&format!("branding.{key}")), None);
      let validation = validate_update(UpdateAppConfigInput {
        module: "branding".to_string(),
        key: key.to_string(),
        value: Some(value),
      });
      assert!(
        !validation.valid
          && validation
            .error
            .as_deref()
            .is_some_and(|message| message.contains("unknown config key")),
        "registry validation for branding.{key} must reject unknown paths: {:?}",
        validation.error
      );
    }
  }

  fn valid_oidc_provider_config() -> serde_json::Value {
    serde_json::json!({
      "clientId": "oidc-client",
      "clientSecret": "oidc-secret",
      "issuerUrl": "https://issuer.example.com",
      "authUrl": "https://issuer.example.com/auth",
      "tokenUrl": "https://issuer.example.com/token",
      "userinfoUrl": "https://issuer.example.com/userinfo",
      "jwksUrl": "https://issuer.example.com/jwks",
      "scopes": ["openid", "profile", "email"],
      "claims": {
        "subject": "sub",
        "email": "email",
        "emailVerified": "email_verified",
        "name": "name",
        "avatar": "picture",
        "groups": "groups",
        "groupsSource": "userinfo"
      },
      "groupMapping": {
        "enabled": true,
        "defaultRole": "member",
        "removeMissingOidcMemberships": true,
        "missingGroupsPolicy": "deny_login",
        "unknownGroups": "ignore",
        "mappings": [
          {
            "providerGroup": "finance/managers",
            "targetUnitId": "018f4df2-1111-7000-9000-000000000001",
            "role": "manager"
          }
        ]
      }
    })
  }

  #[test]
  fn oauth_oidc_provider_contract_accepts_full_shape() {
    let value = valid_oidc_provider_config();
    let err = validate_registered_app_config_value("oauth", "providers.oidc", &value);
    assert!(err.is_none(), "full OIDC provider config must be accepted: {err:?}");
  }

  #[test]
  fn oauth_oidc_provider_contract_rejects_legacy_scope_string() {
    let mut value = valid_oidc_provider_config();
    value["scopes"] = serde_json::json!("openid profile email");

    let err = validate_registered_app_config_value("oauth", "providers.oidc", &value);
    assert!(
      err
        .as_deref()
        .is_some_and(|message| message.contains("scopes must be an array")),
      "legacy scope strings must be rejected: {err:?}"
    );
  }

  #[test]
  fn oauth_oidc_provider_contract_rejects_invalid_group_policies() {
    let mut value = valid_oidc_provider_config();
    value["groupMapping"]["defaultRole"] = serde_json::json!("admin");

    let err = validate_registered_app_config_value("oauth", "providers.oidc", &value);
    assert!(
      err.as_deref().is_some_and(|message| message.contains("defaultRole")),
      "global/admin roles must not be accepted for OIDC group mapping: {err:?}"
    );

    let mut value = valid_oidc_provider_config();
    value["groupMapping"]["missingGroupsPolicy"] = serde_json::json!("skip");
    let err = validate_registered_app_config_value("oauth", "providers.oidc", &value);
    assert!(
      err
        .as_deref()
        .is_some_and(|message| message.contains("missingGroupsPolicy")),
      "unknown missing-groups policies must be rejected: {err:?}"
    );
  }

  #[test]
  fn pdf_export_verapdf_url_accepts_http_url() {
    let val = serde_json::json!("http://verapdf:8080");
    let err = validate_registered_app_config_value("pdf_export", "verapdf_validator_url", &val);
    assert!(err.is_none(), "valid veraPDF URL must be accepted: {err:?}");
  }

  #[test]
  fn pdf_export_verapdf_url_rejects_javascript_url() {
    let val = serde_json::json!("javascript:alert(1)");
    let err = validate_registered_app_config_value("pdf_export", "verapdf_validator_url", &val);
    assert!(err.is_some(), "unsafe veraPDF URL must be rejected");
  }

  #[test]
  fn pdf_export_verapdf_timeout_bounds() {
    let valid = validate_registered_app_config_value("pdf_export", "verapdf_timeout_seconds", &serde_json::json!(30));
    assert!(valid.is_none(), "30s timeout must be accepted: {valid:?}");
    let invalid = validate_registered_app_config_value("pdf_export", "verapdf_timeout_seconds", &serde_json::json!(0));
    assert!(invalid.is_some(), "0s timeout must be rejected");
  }

  #[test]
  fn validation_copilot_providers_rejects_nested_script_content() {
    let value = serde_json::json!({
      "openai": {
        "kind": "openai",
        "endpoint": "javascript:alert(1)"
      }
    });
    let error = validate_registered_app_config_value("copilot", "providers", &value);
    assert!(error.is_some(), "nested executable content must be rejected");
  }

  #[test]
  fn ca_bundle_updates_are_file_only_even_for_valid_relative_paths() {
    for (module, key) in [
      ("git_sync", "https_ca_bundle_path"),
      ("tls", "additional_ca_bundle_path"),
    ] {
      for value in [
        serde_json::json!("git-sync/company-ca.pem"),
        serde_json::json!("../company-ca.pem"),
        serde_json::json!(""),
      ] {
        assert!(
          validate_registered_app_config_value(module, key, &value).is_some(),
          "{module}.{key} must reject database writes"
        );
      }
    }
  }
}
