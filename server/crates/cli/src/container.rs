// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native OCI bootstrap and loopback probe, independent of DB/config loading.

use std::{ffi::OsString, io::Write, path::Path, process::Command, time::Duration};

use anyhow::{Context, bail};
use clap::Subcommand;
use myoxus_contracts::runtime_config::{SecretFileErrorKind, read_secret_bytes};

#[derive(Subcommand)]
pub enum ContainerCommand {
  /// Materialize protected container secrets, then replace this process.
  Start {
    #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
    command: Vec<OsString>,
  },
  /// Probe loopback HTTP without loading secrets, TLS settings or PostgreSQL.
  Health {
    /// Probe /ready instead of the default liveness-only /health endpoint.
    #[arg(long)]
    ready: bool,
  },
}

pub async fn run(command: &ContainerCommand) -> anyhow::Result<()> {
  match command {
    ContainerCommand::Start { command } => start(command),
    ContainerCommand::Health { ready } => health(*ready).await,
  }
}

fn environment_path(name: &str, default: &str) -> std::path::PathBuf {
  std::env::var_os(name)
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| default.into())
    .into()
}

fn identifier(name: &str, default: &str) -> anyhow::Result<String> {
  let value = std::env::var_os(name)
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| default.into());
  let Some(value) = value.to_str() else {
    bail!("{name} contains unsupported characters");
  };
  anyhow::ensure!(
    value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)),
    "{name} contains unsupported characters"
  );
  Ok(value.to_owned())
}

fn password(path: &Path) -> anyhow::Result<Vec<u8>> {
  read_secret_bytes(path, "POSTGRES_PASSWORD_FILE").map_err(|error| {
    let reason = match error.kind() {
      SecretFileErrorKind::Missing => "is missing",
      SecretFileErrorKind::NotRegularFile => "is not a regular file",
      SecretFileErrorKind::TooLarge => "exceeds 64 KiB",
      SecretFileErrorKind::Empty => "is empty",
      SecretFileErrorKind::ContainsNul => "contains a NUL byte",
      _ => "could not be read",
    };
    anyhow::anyhow!("postgres password secret {reason}")
  })
}

fn encoded_password(bytes: &[u8]) -> String {
  use std::fmt::Write;
  bytes
    .iter()
    .fold(String::with_capacity(bytes.len() * 3), |mut encoded, byte| {
      write!(encoded, "%{byte:02x}").expect("writing to a String");
      encoded
    })
}

#[cfg(unix)]
fn start(command: &[OsString]) -> anyhow::Result<()> {
  use std::os::unix::fs::PermissionsExt;
  use std::os::unix::process::CommandExt;

  let host = identifier("POSTGRES_HOST", "postgres")?;
  let port = identifier("POSTGRES_PORT", "5432")?;
  let user = identifier("POSTGRES_USER", "myoxus")?;
  let database = identifier("POSTGRES_DB", "myoxus")?;
  let bytes = password(&environment_path(
    "POSTGRES_PASSWORD_FILE",
    "/run/secrets/postgres_password",
  ))?;
  let url = format!(
    "postgres://{user}:{}@{host}:{port}/{database}",
    encoded_password(&bytes)
  );

  // SAFETY: umask takes no pointers. This dedicated bootstrap path starts no
  // file-writing work concurrently; 077 preserves the old entrypoint's mask
  // for this process and, importantly, the exec'd server and its children.
  unsafe { libc::umask(0o077) };

  // NamedTempFile is created mode 0600. Same-directory persist replaces the old
  // URL atomically without following its symlink or exposing partial bytes.
  let mut file = tempfile::NamedTempFile::new_in("/run/myoxus")
    .map_err(|_| anyhow::anyhow!("could not create protected database URL file"))?;
  file
    .as_file()
    .set_permissions(std::fs::Permissions::from_mode(0o600))
    .map_err(|_| anyhow::anyhow!("could not protect database URL file"))?;
  file
    .write_all(url.as_bytes())
    .map_err(|_| anyhow::anyhow!("could not write protected database URL file"))?;
  file
    .persist("/run/myoxus/database-url")
    .map_err(|_| anyhow::anyhow!("could not replace protected database URL file"))?;

  anyhow::ensure!(
    environment_path("MYOXUS__CRYPTO__PRIVATE_KEY_FILE", "/run/secrets/crypto_private_key").is_file(),
    "crypto private-key secret is not a regular file"
  );
  let (program, args) = command.split_first().context("container start requires a command")?;
  // exec, not spawn/wait: the server remains PID 1 and receives Docker signals.
  let error = Command::new(program).args(args).exec();
  bail!("could not execute container command ({})", error.kind())
}

#[cfg(not(unix))]
fn start(_command: &[OsString]) -> anyhow::Result<()> {
  bail!("container start requires Unix")
}

async fn health(ready: bool) -> anyhow::Result<()> {
  let port = std::env::var("MYOXUS__SERVER__PORT").unwrap_or_else(|_| "3001".into());
  let port: u16 = port.parse().context("invalid container HTTP port")?;
  probe(port, ready).await
}

async fn probe(port: u16, ready: bool) -> anyhow::Result<()> {
  let endpoint = if ready { "ready" } else { "health" };
  // Ignore proxy environment variables and additional trust files for this
  // loopback-only HTTP probe. Readiness must never be folded into liveness.
  let client = reqwest::Client::builder()
    .no_proxy()
    .tls_certs_only([])
    .redirect(reqwest::redirect::Policy::none())
    .timeout(Duration::from_secs(4))
    .build()
    .context("could not initialize container HTTP probe")?;
  let mut response = client
    .get(format!("http://127.0.0.1:{port}/{endpoint}"))
    .send()
    .await
    .map_err(|_| anyhow::anyhow!("container HTTP probe could not reach /{endpoint}"))?;
  // Match the previous curl -f contract, including successful redirects without
  // following them; startup-check JSON is not an additional health gate.
  anyhow::ensure!(
    response.status().as_u16() < 400,
    "container /{endpoint} returned {}",
    response.status()
  );
  while response
    .chunk()
    .await
    .map_err(|_| anyhow::anyhow!("container /{endpoint} response was incomplete"))?
    .is_some()
  {}
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::io::{AsyncReadExt, AsyncWriteExt};

  #[tokio::test]
  async fn liveness_does_not_require_readiness_or_a_json_contract() {
    myoxus_infrastructure::tls::initialize_crypto_provider();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
      for (path, status) in [("health", "200 OK"), ("ready", "503 Service Unavailable")] {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        let length = stream.read(&mut request).await.unwrap();
        assert!(String::from_utf8_lossy(&request[..length]).starts_with(&format!("GET /{path} ")));
        stream
          .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").as_bytes())
          .await
          .unwrap();
      }
    });
    probe(port, false)
      .await
      .expect("liveness remains independent of startup checks");
    assert!(probe(port, true).await.is_err());
    server.await.unwrap();
  }
}
