use lettre::{
  AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
  transport::smtp::{
    authentication::Credentials,
    client::{Certificate, Tls, TlsParameters},
    extension::ClientId,
  },
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmtpTransportMode {
  Plain,
  #[default]
  Starttls,
  ImplicitTls,
}

impl SmtpTransportMode {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Plain => "plain",
      Self::Starttls => "starttls",
      Self::ImplicitTls => "implicit_tls",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpTransportConfig {
  pub host: String,
  pub port: u16,
  /// Optional hostname sent in EHLO/HELO. `None` keeps lettre's safe default.
  pub name: Option<String>,
  pub username: Option<String>,
  pub password: Option<String>,
  pub transport: SmtpTransportMode,
  pub verify_certificate: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpFailurePhase {
  Configuration,
  Tcp,
  Banner,
  Ehlo,
  Starttls,
  TlsHandshake,
  Certificate,
  Authentication,
  Send,
}

impl SmtpFailurePhase {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Configuration => "configuration",
      Self::Tcp => "tcp",
      Self::Banner => "banner",
      Self::Ehlo => "ehlo",
      Self::Starttls => "starttls",
      Self::TlsHandshake => "tls_handshake",
      Self::Certificate => "certificate",
      Self::Authentication => "authentication",
      Self::Send => "send",
    }
  }
}

#[derive(Debug, Error)]
#[error("SMTP {phase} failed ({code})", phase = .phase.as_str())]
pub struct SmtpDeliveryError {
  pub phase: SmtpFailurePhase,
  pub code: &'static str,
}

impl SmtpDeliveryError {
  fn configuration(code: &'static str) -> Self {
    Self {
      phase: SmtpFailurePhase::Configuration,
      code,
    }
  }

  fn from_smtp(error: &lettre::transport::smtp::Error, config: &SmtpTransportConfig, sending: bool) -> Self {
    let status = error.status().map(|code| code.to_string());
    let phase = if matches!(status.as_deref(), Some("530" | "534" | "535" | "538")) {
      SmtpFailurePhase::Authentication
    } else if config.verify_certificate && contains_certificate_error(error) {
      SmtpFailurePhase::Certificate
    } else if error.is_tls() {
      if config.verify_certificate {
        SmtpFailurePhase::Certificate
      } else {
        SmtpFailurePhase::TlsHandshake
      }
    } else if error.is_response() {
      SmtpFailurePhase::Banner
    } else if error.is_client() {
      if config.transport == SmtpTransportMode::Starttls {
        SmtpFailurePhase::Starttls
      } else {
        SmtpFailurePhase::Ehlo
      }
    } else if sending {
      SmtpFailurePhase::Send
    } else {
      SmtpFailurePhase::Tcp
    };
    let code = match phase {
      SmtpFailurePhase::Configuration => "SMTP_CONFIGURATION_FAILED",
      SmtpFailurePhase::Tcp => "SMTP_TCP_FAILED",
      SmtpFailurePhase::Banner => "SMTP_BANNER_FAILED",
      SmtpFailurePhase::Ehlo => "SMTP_EHLO_FAILED",
      SmtpFailurePhase::Starttls => "SMTP_STARTTLS_REQUIRED",
      SmtpFailurePhase::TlsHandshake => "SMTP_TLS_HANDSHAKE_FAILED",
      SmtpFailurePhase::Certificate => "SMTP_CERTIFICATE_REJECTED",
      SmtpFailurePhase::Authentication => "SMTP_AUTHENTICATION_REJECTED",
      SmtpFailurePhase::Send => "SMTP_SEND_REJECTED",
    };
    Self { phase, code }
  }
}

fn contains_certificate_error(error: &(dyn std::error::Error + 'static)) -> bool {
  crate::tls::http_error::certificate_rejected(error)
}

#[derive(Debug)]
pub struct SmtpClient {
  config: SmtpTransportConfig,
  transport: AsyncSmtpTransport<Tokio1Executor>,
}

impl SmtpClient {
  pub fn new(
    config: SmtpTransportConfig,
    additional_ca: Option<&crate::tls::ValidatedCaBundle>,
  ) -> Result<Self, SmtpDeliveryError> {
    let roots = additional_ca
      .into_iter()
      .flat_map(|bundle| bundle.certificates())
      .map(|der| Certificate::from_der(der.clone()).map_err(|_| SmtpDeliveryError::configuration("SMTP_CA_INVALID")))
      .collect::<Result<Vec<_>, _>>()?;
    Self::new_with_roots(config, &roots)
  }

  fn new_with_roots(
    mut config: SmtpTransportConfig,
    root_certificates: &[Certificate],
  ) -> Result<Self, SmtpDeliveryError> {
    config.username = normalize_username(config.username);
    config.password = normalize_secret(config.password);
    validate_config(&config)?;
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(config.host.clone())
      .port(config.port)
      .tls(build_tls(&config, root_certificates)?);
    if let Some(name) = normalize_optional(&config.name) {
      builder = builder.hello_name(ClientId::Domain(name.to_string()));
    }
    if let (Some(username), Some(password)) = (&config.username, &config.password) {
      builder = builder.credentials(Credentials::new(username.clone(), password.clone()));
    }
    Ok(Self {
      config,
      transport: builder.build(),
    })
  }

  /// Establish the configured transport/authentication and check SMTP NOOP
  /// without sending a message. A negative NOOP is a failed connection test.
  pub async fn test_connection(&self) -> Result<(), SmtpDeliveryError> {
    let connected = self
      .transport
      .test_connection()
      .await
      .map_err(|error| SmtpDeliveryError::from_smtp(&error, &self.config, false))?;
    // lettre returns Ok(false) when NOOP fails; discarding the bool would make
    // a broken configured transport look healthy to every diagnostic caller.
    if !connected {
      return Err(SmtpDeliveryError {
        phase: SmtpFailurePhase::Tcp,
        code: "SMTP_CONNECTION_TEST_FAILED",
      });
    }
    Ok(())
  }

  pub async fn send(&self, message: Message) -> Result<(), SmtpDeliveryError> {
    self
      .transport
      .send(message)
      .await
      .map(|_| ())
      .map_err(|error| SmtpDeliveryError::from_smtp(&error, &self.config, true))
  }
}

fn normalize_optional(value: &Option<String>) -> Option<&str> {
  value.as_deref().map(str::trim).filter(|value| !value.is_empty())
}

fn normalize_username(value: Option<String>) -> Option<String> {
  value
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn normalize_secret(value: Option<String>) -> Option<String> {
  value.filter(|value| !value.trim().is_empty())
}

fn validate_config(config: &SmtpTransportConfig) -> Result<(), SmtpDeliveryError> {
  if config.host.trim().is_empty() || config.host.trim() != config.host {
    return Err(SmtpDeliveryError::configuration("SMTP_HOST_INVALID"));
  }
  if config.port == 0 {
    return Err(SmtpDeliveryError::configuration("SMTP_PORT_INVALID"));
  }
  let username = normalize_optional(&config.username);
  let password = normalize_optional(&config.password);
  if username.is_some() != password.is_some() {
    return Err(SmtpDeliveryError::configuration("SMTP_CREDENTIAL_PAIR_REQUIRED"));
  }
  Ok(())
}

fn build_tls(config: &SmtpTransportConfig, root_certificates: &[Certificate]) -> Result<Tls, SmtpDeliveryError> {
  if config.transport == SmtpTransportMode::Plain {
    return Ok(Tls::None);
  }
  let mut parameters =
    TlsParameters::builder(config.host.clone()).dangerous_accept_invalid_certs(!config.verify_certificate);
  for certificate in root_certificates {
    parameters = parameters.add_root_certificate(certificate.clone());
  }
  let parameters = parameters
    .build()
    .map_err(|_| SmtpDeliveryError::configuration("SMTP_TLS_CONFIGURATION_INVALID"))?;
  Ok(match config.transport {
    SmtpTransportMode::Plain => Tls::None,
    SmtpTransportMode::Starttls => Tls::Required(parameters),
    SmtpTransportMode::ImplicitTls => Tls::Wrapper(parameters),
  })
}

#[cfg(test)]
mod tests {
  use lettre::{Message, transport::smtp::client::Certificate};
  use myoxus_tests::smtp_fixture::{SmtpFixture, SmtpFixtureAuth, SmtpFixtureOptions};

  use super::*;

  fn config(
    fixture: &SmtpFixture,
    transport: SmtpTransportMode,
    verify_certificate: bool,
    authenticated: bool,
  ) -> SmtpTransportConfig {
    SmtpTransportConfig {
      host: fixture.host().to_string(),
      port: fixture.port(),
      name: None,
      username: authenticated.then(|| "fixture-user".to_string()),
      password: authenticated.then(|| "fixture-password".to_string()),
      transport,
      verify_certificate,
    }
  }

  fn message(subject: &str) -> Message {
    Message::builder()
      .from("sender@example.test".parse().expect("sender"))
      .to("recipient@example.test".parse().expect("recipient"))
      .subject(subject)
      .body("fixture body".to_string())
      .expect("fixture message")
  }

  fn trusted_client(config: SmtpTransportConfig, fixture: &SmtpFixture) -> SmtpClient {
    let root = Certificate::from_der(fixture.certificate_der().to_vec()).expect("fixture root certificate");
    SmtpClient::new_with_roots(config, &[root]).expect("trusted SMTP client")
  }

  #[tokio::test]
  async fn required_starttls_with_trusted_certificate_and_no_auth_delivers() {
    let fixture = SmtpFixture::start(SmtpFixtureOptions::starttls(SmtpFixtureAuth::None)).await;
    let client = trusted_client(config(&fixture, SmtpTransportMode::Starttls, true, false), &fixture);

    client.test_connection().await.expect("STARTTLS connection");
    client.send(message("STARTTLS")).await.expect("STARTTLS delivery");

    assert_eq!(fixture.auth_attempts().await, 0);
    assert_eq!(fixture.messages().await.len(), 1);
  }

  #[tokio::test]
  async fn implicit_tls_with_complete_authentication_delivers() {
    let fixture = SmtpFixture::start(SmtpFixtureOptions::implicit_tls(SmtpFixtureAuth::Accept)).await;
    let client = trusted_client(config(&fixture, SmtpTransportMode::ImplicitTls, true, true), &fixture);

    client
      .send(message("Implicit TLS"))
      .await
      .expect("implicit TLS delivery");

    assert_eq!(fixture.auth_attempts().await, 1);
    assert_eq!(fixture.messages().await.len(), 1);
  }

  #[tokio::test]
  async fn explicit_plain_transport_never_attempts_tls() {
    let fixture = SmtpFixture::start(SmtpFixtureOptions::plain(SmtpFixtureAuth::None)).await;
    let client =
      SmtpClient::new(config(&fixture, SmtpTransportMode::Plain, true, false), None).expect("plain SMTP client");

    client.send(message("Plain")).await.expect("plain SMTP delivery");

    assert_eq!(fixture.messages().await.len(), 1);
  }

  #[tokio::test]
  async fn required_starttls_rejects_server_without_capability() {
    let fixture = SmtpFixture::start(SmtpFixtureOptions {
      transport: myoxus_tests::smtp_fixture::SmtpFixtureTransport::Starttls,
      advertise_starttls: false,
      auth: SmtpFixtureAuth::None,
    })
    .await;
    let client = trusted_client(config(&fixture, SmtpTransportMode::Starttls, true, false), &fixture);

    let error = client.test_connection().await.expect_err("missing STARTTLS must fail");

    assert_eq!(error.phase, SmtpFailurePhase::Starttls);
    assert!(fixture.messages().await.is_empty());
  }

  #[tokio::test]
  async fn verified_tls_rejects_untrusted_certificate() {
    let fixture = SmtpFixture::start(SmtpFixtureOptions::implicit_tls(SmtpFixtureAuth::None)).await;
    let client =
      SmtpClient::new(config(&fixture, SmtpTransportMode::ImplicitTls, true, false), None).expect("SMTP client");

    let error = client
      .test_connection()
      .await
      .expect_err("untrusted certificate must fail");

    assert_eq!(error.phase, SmtpFailurePhase::Certificate);
  }

  #[tokio::test]
  async fn authentication_rejection_has_safe_phase_without_credentials() {
    let fixture = SmtpFixture::start(SmtpFixtureOptions::plain(SmtpFixtureAuth::Reject)).await;
    let client =
      SmtpClient::new(config(&fixture, SmtpTransportMode::Plain, true, true), None).expect("authenticated SMTP client");

    let error = client.send(message("Rejected")).await.expect_err("auth must fail");

    assert_eq!(error.phase, SmtpFailurePhase::Authentication);
    assert_eq!(
      error.to_string(),
      "SMTP authentication failed (SMTP_AUTHENTICATION_REJECTED)"
    );
    assert!(!error.to_string().contains("fixture-password"));
  }

  #[test]
  fn empty_credentials_normalize_to_no_auth_and_partial_pairs_fail() {
    let no_auth = SmtpTransportConfig {
      host: "localhost".to_string(),
      port: 25,
      name: None,
      username: Some(" ".to_string()),
      password: Some(String::new()),
      transport: SmtpTransportMode::Starttls,
      verify_certificate: true,
    };
    SmtpClient::new(no_auth, None).expect("empty credentials mean no authentication");

    let partial = SmtpTransportConfig {
      host: "localhost".to_string(),
      port: 25,
      name: None,
      username: Some("operator".to_string()),
      password: Some(String::new()),
      transport: SmtpTransportMode::Starttls,
      verify_certificate: true,
    };
    let error = SmtpClient::new(partial, None).expect_err("partial credentials must fail");
    assert_eq!(error.phase, SmtpFailurePhase::Configuration);
    assert_eq!(error.code, "SMTP_CREDENTIAL_PAIR_REQUIRED");
  }
}
