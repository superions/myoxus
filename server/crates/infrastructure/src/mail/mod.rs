//! Mail adapters: SMTP production adapter, in-memory test adapter, and a
//! no-op log adapter.
//!
//! [`SmtpMailAdapter`] renders Tera HTML templates and delivers via SMTP.
//! [`TestMailAdapter`] captures sent mail for test assertions.
//! [`LogMailAdapter`] logs delivery metadata and discards all mail (useful in dev).

use async_trait::async_trait;
use myoxus_application::ports::{MailPort, PortError, PortResult, TemplateMail};
use std::sync::{Arc, Mutex};

use tracing::{info, instrument};

#[cfg(test)]
mod catalog_tests;
mod mime;
mod render;
mod smtp;
mod templates;
pub use templates::{MAIL_LANGUAGES, MailTemplateRenderer, RenderedMail};

pub use smtp::{SmtpClient, SmtpDeliveryError, SmtpFailurePhase, SmtpTransportConfig, SmtpTransportMode};

/// SMTP connection and template configuration.
#[derive(Clone)]
pub struct MailConfig {
  /// Hostname of the SMTP relay.
  pub smtp_host: String,
  /// SMTP port (e.g. 587 for STARTTLS, 465 for SMTPS).
  pub smtp_port: u16,
  /// Optional hostname announced to the SMTP relay via EHLO/HELO.
  pub smtp_name: Option<String>,
  /// Optional SMTP authentication username.
  pub smtp_user: Option<String>,
  /// Optional SMTP authentication password.
  pub smtp_pass: Option<String>,
  /// Explicit SMTP wire transport. The port never changes this selection.
  pub smtp_transport: SmtpTransportMode,
  /// Whether the SMTP server certificate must chain to a trusted root.
  pub smtp_verify_certificate: bool,
  /// Optional SMTP endpoint used only for exact recipient-domain matches.
  pub fallback_smtp: Option<FallbackMailConfig>,
  /// Lowercase recipient domains routed through `fallback_smtp`.
  pub fallback_domains: Vec<String>,
  /// Sender address used in the `From:` header.
  pub from_email: String,
  /// Root of the localized HTML catalog, shared layout and inline assets.
  pub template_dir: String,
}

#[derive(Clone)]
pub struct FallbackMailConfig {
  pub smtp: SmtpTransportConfig,
  pub from_email: String,
}

impl MailConfig {
  fn primary_smtp_config(&self) -> SmtpTransportConfig {
    SmtpTransportConfig {
      host: self.smtp_host.trim().to_string(),
      port: self.smtp_port,
      name: self.smtp_name.clone(),
      username: self.smtp_user.clone(),
      password: self.smtp_pass.clone(),
      transport: self.smtp_transport,
      verify_certificate: self.smtp_verify_certificate,
    }
  }

  fn endpoint_for(&self, recipient: &str) -> (SmtpTransportConfig, &str) {
    let domain = recipient
      .rsplit_once('@')
      .map(|(_, domain)| domain.trim_end_matches('.').to_ascii_lowercase());
    let use_fallback = domain.is_some_and(|domain| {
      self
        .fallback_domains
        .iter()
        .any(|configured| configured.trim_end_matches('.').eq_ignore_ascii_case(&domain))
    });
    if use_fallback && let Some(fallback) = &self.fallback_smtp {
      return (fallback.smtp.clone(), &fallback.from_email);
    }
    (self.primary_smtp_config(), &self.from_email)
  }
}

/// Production sender. Authentication and notification mail use the same localized renderer.
#[derive(Clone)]
pub struct SmtpMailAdapter {
  config: MailConfig,
  renderer: Arc<MailTemplateRenderer>,
  additional_ca: Option<crate::tls::ValidatedCaBundle>,
  server_origin: String,
  default_locale: String,
}

impl SmtpMailAdapter {
  pub fn new(config: MailConfig, additional_ca: Option<crate::tls::ValidatedCaBundle>) -> Result<Self, PortError> {
    let renderer = Arc::new(MailTemplateRenderer::new(&config.template_dir)?);
    Ok(Self::with_renderer(config, additional_ca, renderer))
  }

  /// Share the startup catalog while allowing an SMTP test to select another endpoint.
  /// This constructor never reloads files behind restart-required configuration.
  pub fn with_renderer(
    config: MailConfig,
    additional_ca: Option<crate::tls::ValidatedCaBundle>,
    renderer: Arc<MailTemplateRenderer>,
  ) -> Self {
    Self {
      config,
      renderer,
      additional_ca,
      server_origin: String::new(),
      default_locale: "en".into(),
    }
  }

  pub fn with_rendering_config(mut self, origin: String, default_locale: String) -> Self {
    self.server_origin = origin.trim_end_matches('/').into();
    self.default_locale = default_locale;
    self
  }

  pub async fn render_mail(&self, mail: &TemplateMail) -> PortResult<RenderedMail> {
    render::render_mail(&self.renderer, mail, &self.server_origin, &self.default_locale)
  }

  pub async fn message(&self, mail: &TemplateMail) -> PortResult<lettre::Message> {
    let rendered = self.render_mail(mail).await?;
    let (_, from) = self.config.endpoint_for(&mail.to);
    mime::message(mail, rendered, from, &self.renderer.assets)
  }
}

#[async_trait]
impl MailPort for SmtpMailAdapter {
  #[instrument(skip_all)]
  async fn send_template(&self, mail: TemplateMail) -> PortResult<()> {
    let message = self.message(&mail).await?;
    let (config, _) = self.config.endpoint_for(&mail.to);
    let client =
      SmtpClient::new(config, self.additional_ca.as_ref()).map_err(|error| PortError::Transport(error.to_string()))?;
    client
      .send(message)
      .await
      .map_err(|error| PortError::Transport(error.to_string()))?;
    info!(template = mail.template.name(), "email delivered via smtp");
    Ok(())
  }
}

#[derive(Debug, Clone)]
pub struct SentMail {
  pub to: String,
  pub subject: String,
  pub body: String,
}

/// Captures catalog HTML through the same complete preparation as production SMTP.
#[derive(Clone)]
pub struct TestMailAdapter {
  pub sent_mails: Arc<Mutex<Vec<SentMail>>>,
  renderer: Arc<MailTemplateRenderer>,
  server_origin: String,
  default_locale: String,
}

impl Default for TestMailAdapter {
  fn default() -> Self {
    Self::new_with_templates(concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail"))
      .expect("stock test mail catalog")
  }
}

impl TestMailAdapter {
  pub fn new_with_templates(directory: &str) -> PortResult<Self> {
    Ok(Self {
      sent_mails: Arc::new(Mutex::new(Vec::new())),
      renderer: Arc::new(MailTemplateRenderer::new(directory)?),
      server_origin: "https://myoxus.example.test".into(),
      default_locale: "en".into(),
    })
  }

  pub fn with_rendering_config(mut self, origin: String, default_locale: String) -> Self {
    self.server_origin = origin.trim_end_matches('/').into();
    self.default_locale = default_locale;
    self
  }
}

#[async_trait]
impl MailPort for TestMailAdapter {
  async fn send_template(&self, mail: TemplateMail) -> PortResult<()> {
    let rendered = render::render_mail(&self.renderer, &mail, &self.server_origin, &self.default_locale)?;
    self.sent_mails.lock().expect("test mail lock").push(SentMail {
      to: mail.to,
      subject: rendered.subject,
      body: rendered.html,
    });
    Ok(())
  }
}

/// A [`MailPort`] that logs non-secret delivery metadata and discards email.
///
/// Authentication links, one-time codes, and message bodies are intentionally
/// inaccessible to its events in every build profile.
#[derive(Debug, Clone, Default)]
pub struct LogMailAdapter;

#[async_trait]
impl MailPort for LogMailAdapter {
  #[instrument(skip_all)]
  async fn send_template(&self, mail: TemplateMail) -> PortResult<()> {
    info!(
      template = mail.template.name(),
      "email suppressed because smtp is disabled"
    );
    Ok(())
  }
}

#[cfg(test)]
mod log_mail_tests {
  use super::*;
  use myoxus_application::ports::MailTemplate;
  use std::io::{self, Write};
  use std::sync::{Arc, Mutex};
  use tracing::instrument::WithSubscriber as _;

  #[derive(Clone, Default)]
  struct LogCapture(Arc<Mutex<Vec<u8>>>);

  impl Write for LogCapture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
      self.0.lock().expect("capture log lock").extend_from_slice(bytes);
      Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
      Ok(())
    }
  }

  impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for LogCapture {
    type Writer = Self;

    fn make_writer(&'writer self) -> Self::Writer {
      self.clone()
    }
  }

  struct LegacyEscapeHatchGuard(String);

  impl Drop for LegacyEscapeHatchGuard {
    fn drop(&mut self) {
      // SAFETY: this test is the only repository owner of the removed variable,
      // and the guard restores the process environment before assertions panic.
      unsafe { std::env::remove_var(&self.0) };
    }
  }

  fn legacy_escape_hatch_name() -> String {
    ["MYOXUS", "LOG", "MAIL", "LINKS"].join("_")
  }

  #[tokio::test]
  async fn authentication_secrets_never_reach_log_mail_events() {
    // SAFETY: access to this removed, test-only variable is confined to this
    // test and cannot race with production code because no reader remains.
    let legacy_escape_hatch = legacy_escape_hatch_name();
    unsafe { std::env::set_var(&legacy_escape_hatch, "1") };
    let _guard = LegacyEscapeHatchGuard(legacy_escape_hatch);
    let capture = LogCapture::default();
    let subscriber = tracing_subscriber::fmt()
      .without_time()
      .with_ansi(false)
      .with_max_level(tracing::Level::TRACE)
      .with_writer(capture.clone())
      .finish();
    let adapter = LogMailAdapter;

    async {
      for (template, url, otp) in [
        (
          MailTemplate::SignIn,
          "https://auth.example.test/MAGIC-LINK-SECRET",
          "OTP-SECRET-8675309",
        ),
        (
          MailTemplate::VerifyEmail,
          "https://auth.example.test/VERIFY-LINK-SECRET",
          "",
        ),
        (
          MailTemplate::PasswordReset,
          "https://auth.example.test/RESET-LINK-SECRET",
          "",
        ),
        (
          MailTemplate::ChangeEmail,
          "https://auth.example.test/CHANGE-EMAIL-SECRET",
          "",
        ),
      ] {
        adapter
          .send_template(TemplateMail::new(
            "auth-recipient@example.test",
            template,
            myoxus_application::ports::MailPresentation::default(),
            serde_json::json!({"url":url,"otp":otp}),
          ))
          .await
          .expect("log prepared auth delivery");
      }
    }
    .with_subscriber(subscriber)
    .await;

    let output = String::from_utf8(capture.0.lock().expect("capture log lock").clone()).expect("UTF-8 logs");
    for secret in [
      "MAGIC-LINK-SECRET",
      "OTP-SECRET-8675309",
      "VERIFY-LINK-SECRET",
      "RESET-LINK-SECRET",
      "CHANGE-EMAIL-SECRET",
    ] {
      assert!(
        !output.contains(secret),
        "authentication secret leaked into logs: {secret}"
      );
    }
    assert!(output.contains("sign-in"));
    assert!(output.contains("verify-email"));
    assert!(output.contains("password-reset"));
    assert!(output.contains("change-email"));
  }
}

#[cfg(test)]
mod delivery_tests {
  use super::*;
  use chrono::Utc;
  use myoxus_application::auth::{
    AuthStore, AuthUser, InMemoryAuthStore, UserPreferenceDefaults, UserPreferencesPatch,
  };
  use myoxus_application::notification::mail::NotificationMailProjector;
  use myoxus_application::ports::MailTemplate;
  use serde_json::Value;
  use serde_json::json;
  use uuid::Uuid;

  fn test_config() -> MailConfig {
    MailConfig {
      smtp_host: String::new(),
      smtp_port: 587,
      smtp_name: None,
      smtp_user: None,
      smtp_pass: None,
      smtp_transport: SmtpTransportMode::Starttls,
      smtp_verify_certificate: true,
      fallback_smtp: None,
      fallback_domains: Vec::new(),
      from_email: "notifications@example.test".to_string(),
      template_dir: concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail").into(),
    }
  }

  fn payload() -> Value {
    json!({
      "workspaceId": "workspace-1",
      "databaseId": "database-1",
      "rowId": "row-1",
      "rowTitle": "Release",
      "fieldName": "Due",
      "scheduledFor": "2026-07-11T09:30:00Z",
      "triggerAt": "2026-07-11T09:00:00Z",
      "offsetMinutes": 30
    })
  }

  #[test]
  fn fallback_routing_uses_exact_case_insensitive_recipient_domains() {
    let mut config = test_config();
    config.fallback_domains = vec!["Fallback.Example.".to_string()];
    config.fallback_smtp = Some(FallbackMailConfig {
      smtp: SmtpTransportConfig {
        host: "fallback-smtp.example".to_string(),
        port: 465,
        name: None,
        username: None,
        password: None,
        transport: SmtpTransportMode::ImplicitTls,
        verify_certificate: true,
      },
      from_email: "fallback@example.test".to_string(),
    });

    let (fallback, sender) = config.endpoint_for("user@fallback.example");
    assert_eq!(fallback.host, "fallback-smtp.example");
    assert_eq!(fallback.transport, SmtpTransportMode::ImplicitTls);
    assert_eq!(sender, "fallback@example.test");

    let (primary, sender) = config.endpoint_for("user@sub.fallback.example");
    assert_eq!(primary.host, "");
    assert_eq!(sender, "notifications@example.test");
  }

  #[tokio::test]
  async fn database_reminder_mail_resolves_user_locale_timezone_and_delivery_mode() {
    let store = Arc::new(InMemoryAuthStore::default());
    let user_id = Uuid::new_v4();
    store.insert_user(AuthUser {
      id: user_id,
      email: "recipient@example.test".into(),
      name: Some("Recipient".into()),
      avatar_url: None,
      password_hash: None,
      is_admin: false,
      disabled: false,
      email_verified_at: Some(Utc::now()),
      registered: true,
    });
    let projector = NotificationMailProjector::new(store.clone()).with_mail_defaults(UserPreferenceDefaults {
      locale: "de".into(),
      ..Default::default()
    });
    let adapter = SmtpMailAdapter::new(test_config(), None)
      .unwrap()
      .with_rendering_config("https://myoxus.example/".into(), "de".into());
    let capture = TestMailAdapter::default().with_rendering_config("https://myoxus.example/".into(), "de".into());
    let mut payload = payload();
    payload["workspaceId"] = json!(Uuid::new_v4());
    payload["databaseId"] = json!(Uuid::new_v4());
    payload["rowId"] = json!(Uuid::new_v4());
    for (locale, fragment) in [
      ("en-US", "Reminder"),
      ("de-DE", "Erinnerung"),
      ("fr-FR", "Rappel"),
      ("es-ES", "Recordatorio"),
      ("it-IT", "Promemoria"),
      ("nl-NL", "Erinnerung"),
    ] {
      store
        .patch_user_preferences(
          user_id,
          UserPreferencesPatch {
            locale: Some(Some(locale.into())),
            timezone: Some(Some("Europe/Berlin".into())),
            time_format: Some(Some("24-hour".into())),
            ..Default::default()
          },
        )
        .await
        .unwrap();
      let mail = projector
        .project(user_id, "database_row_reminder", &payload)
        .await
        .unwrap()
        .unwrap();
      let rendered = adapter.render_mail(&mail).await.unwrap();
      capture
        .send_template(mail)
        .await
        .expect("test capture uses production preparation");
      let captured = capture.sent_mails.lock().expect("capture lock");
      let captured = captured.last().expect("captured mail");
      assert_eq!(captured.subject, rendered.subject);
      assert_eq!(captured.body, rendered.html);
      assert!(rendered.subject.contains(fragment), "{locale}: {}", rendered.subject);
      assert!(rendered.text.contains("11:30 CEST"));
      assert!(rendered.text.contains("?rowId="));
      assert!(!rendered.text.contains("triggerAt"));
      assert!(!rendered.text.contains("offsetMinutes"));
    }
    store
      .patch_user_preferences(
        user_id,
        UserPreferencesPatch {
          locale: Some(Some("en".into())),
          timezone: Some(Some("America/New_York".into())),
          date_format: Some(Some("year-month-day".into())),
          time_format: Some(Some("12-hour".into())),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    let mail = projector
      .project(user_id, "database_row_reminder", &payload)
      .await
      .unwrap()
      .unwrap();
    assert!(
      adapter
        .render_mail(&mail)
        .await
        .unwrap()
        .text
        .contains("2026-07-11 05:30 AM EDT")
    );
    payload["scheduledFor"] = json!("not-a-date");
    assert!(
      projector
        .project(user_id, "database_row_reminder", &payload)
        .await
        .is_err()
    );
  }
}
