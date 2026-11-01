// SPDX-License-Identifier: AGPL-3.0-or-later
//! Connection-only SMTP diagnostics using the existing transport policy.

use myoxus_api::config::MailConfig;
use myoxus_infrastructure::{
  mail::{SmtpClient, SmtpTransportConfig},
  tls::ValidatedCaBundle,
};

use super::{DOCTOR_CHECK_TIMEOUT, DoctorRow, DoctorStatus, Instant};

pub(super) async fn inspect(additional_ca: Option<&ValidatedCaBundle>) -> DoctorRow {
  let started = Instant::now();
  let deadline = tokio::time::Instant::now() + DOCTOR_CHECK_TIMEOUT;
  // Mail settings are restart-owned. The canonical startup source stack,
  // including its runtime mirror, is the effective CLI snapshot; unmirrored DB
  // candidates must not silently become a different SMTP configuration here.
  let configuration = tokio::time::timeout_at(
    deadline,
    tokio::task::spawn_blocking(|| {
      myoxus_contracts::runtime_config::load_server_config_sources()?
        .config
        .get::<MailConfig>("mail")
    }),
  )
  .await;
  let configuration = match configuration {
    Ok(Ok(Ok(configuration))) => configuration,
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error.to_string(),
        Ok(Err(_)) => "SMTP configuration task panicked or was cancelled".into(),
        Err(_) => "SMTP configuration exceeded 5 seconds".into(),
        _ => unreachable!(),
      };
      return DoctorRow::new("smtp.connection", DoctorStatus::Fail, started, detail);
    }
  };
  let Some(host) = configuration.smtp_host.filter(|host| !host.trim().is_empty()) else {
    return DoctorRow::new(
      "smtp.connection",
      DoctorStatus::Skip,
      started,
      "SMTP is not configured in the CLI startup snapshot; no connection or message sent",
    );
  };
  let target = format!(
    "host={host:?} port={} transport={} verify_certificate={}",
    configuration.smtp_port,
    configuration.smtp_transport.as_str(),
    configuration.smtp_verify_certificate
  );
  let additional_ca = additional_ca.cloned();
  let client = tokio::time::timeout_at(
    deadline,
    tokio::task::spawn_blocking(move || {
      SmtpClient::new(
        SmtpTransportConfig {
          host,
          port: configuration.smtp_port,
          name: configuration.smtp_name,
          username: configuration.smtp_user,
          password: configuration.smtp_pass,
          transport: configuration.smtp_transport,
          verify_certificate: configuration.smtp_verify_certificate,
        },
        additional_ca.as_ref(),
      )
    }),
  )
  .await;
  let client = match client {
    Ok(Ok(Ok(client))) => client,
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error.to_string(),
        Ok(Err(_)) => "SMTP client task panicked or was cancelled".into(),
        Err(_) => "SMTP client construction exceeded 5 seconds".into(),
        _ => unreachable!(),
      };
      return DoctorRow::new(
        "smtp.connection",
        DoctorStatus::Fail,
        started,
        format!("{target}; {detail}"),
      );
    }
  };
  let (status, detail) = match tokio::time::timeout_at(deadline, client.test_connection()).await {
    Ok(Ok(())) => (
      DoctorStatus::Pass,
      format!(
        "{target}; connection/authentication/NOOP succeeded; no message sent; not running API capability evidence"
      ),
    ),
    Ok(Err(error)) => (DoctorStatus::Fail, format!("{target}; {error}")),
    Err(_) => (
      DoctorStatus::Fail,
      format!("{target}; SMTP connection check exceeded 5 seconds"),
    ),
  };
  DoctorRow::new("smtp.connection", status, started, detail)
}
