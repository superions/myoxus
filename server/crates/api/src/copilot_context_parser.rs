// SPDX-License-Identifier: AGPL-3.0-or-later
//! Narrow doc_pipeline process adapter. Untrusted PDF parsing must not outlive
//! its queue lease or leave an uncancelable blocking thread in the API process.

use bytes::Bytes;
use myoxus_application::{
  auth::{AuthError, AuthResult},
  copilot::context_ingest::{ContextFileParser, ContextIngestionLimits, ParsedContextFile},
};
use std::{path::PathBuf, process::Stdio};

pub const PARSE_ARGUMENT: &str = "--copilot-context-parse";

pub struct SubprocessContextParser {
  pub executable: PathBuf,
}

fn failed() -> AuthError {
  AuthError::InvalidInput("context file parsing failed".into())
}

#[async_trait::async_trait]
impl ContextFileParser for SubprocessContextParser {
  #[tracing::instrument(skip_all)]
  async fn parse(&self, bytes: Bytes, mime: &str, limits: ContextIngestionLimits) -> AuthResult<ParsedContextFile> {
    if bytes.len() as u64 > limits.max_input_bytes {
      return Err(failed());
    }
    let temp = tempfile::tempdir().map_err(|_| failed())?;
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    tokio::fs::write(&input, &bytes).await.map_err(|_| failed())?;
    let mut child = tokio::process::Command::new(&self.executable)
      .arg(PARSE_ARGUMENT)
      .arg(&input)
      .arg(&output)
      .arg(mime)
      .arg(limits.max_input_bytes.to_string())
      .arg(limits.max_output_bytes.to_string())
      .arg(limits.timeout_ms.to_string())
      .env_clear()
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .kill_on_drop(true)
      .spawn()
      .map_err(|_| failed())?;
    let status = match tokio::time::timeout(std::time::Duration::from_millis(limits.timeout_ms), child.wait()).await {
      Ok(status) => status.map_err(|_| failed())?,
      Err(_) => {
        let _ = child.start_kill();
        child.wait().await.map_err(|_| failed())?;
        return Err(failed());
      }
    };
    if !status.success()
      || tokio::fs::metadata(&output).await.map_err(|_| failed())?.len() > limits.max_output_bytes as u64
    {
      return Err(failed());
    }
    let encoded = tokio::fs::read(&output).await.map_err(|_| failed())?;
    serde_json::from_slice(&encoded).map_err(|_| failed())
  }
}

/// Runs before configuration, database, credentials or tracing are initialized.
/// Paths belong to the parent's private temporary directory, never an upload name.
pub fn parse_child() -> Result<(), Box<dyn std::error::Error>> {
  use std::io::Read;
  let args = std::env::args().skip(2).collect::<Vec<_>>();
  if args.len() != 6 {
    return Err("invalid parser invocation".into());
  }
  let max_input: u64 = args[3].parse()?;
  let max_output: usize = args[4].parse()?;
  let timeout_ms: u64 = args[5].parse()?;
  constrain_child(max_input, max_output, timeout_ms)?;
  let mut data = Vec::new();
  std::fs::File::open(&args[0])?
    .take(max_input.saturating_add(1))
    .read_to_end(&mut data)?;
  if data.is_empty() || data.len() as u64 > max_input {
    return Err("invalid parser input size".into());
  }
  let (mime, name) = match args[2].as_str() {
    "application/pdf" => ("application/pdf", "context.pdf"),
    "text/plain" => ("text/plain", "context.txt"),
    "text/csv" => ("text/plain", "context.csv"),
    _ => return Err("unsupported parser input".into()),
  };
  let parser = myoxus_doc_pipeline::DefaultDocumentParser::new(Default::default());
  let parsed = parser.parse(&data, mime, name).map_err(|_| "context parsing failed")?;
  if parsed.text.trim().is_empty() || parsed.text.len() > max_output {
    return Err("invalid parser output size".into());
  }
  let result = ParsedContextFile {
    text: parsed.text,
    chunk_count: parsed.chunks.len().max(1),
  };
  let encoded = serde_json::to_vec(&result)?;
  if encoded.len() > max_output {
    return Err("parser output exceeds limit".into());
  }
  std::fs::write(&args[1], encoded)?;
  Ok(())
}

#[cfg(target_os = "linux")]
fn constrain_child(max_input: u64, max_output: usize, timeout_ms: u64) -> std::io::Result<()> {
  // This technical envelope is derived from the existing input/output limits;
  // it is not another product quota. Preserve stricter inherited host limits.
  let memory = max_input
    .saturating_add(max_output as u64)
    .saturating_mul(8)
    .saturating_add(128 * 1024 * 1024);
  for (resource, budget) in [
    (libc::RLIMIT_AS, memory),
    (libc::RLIMIT_FSIZE, max_output as u64),
    (libc::RLIMIT_CPU, timeout_ms.div_ceil(1000).saturating_add(1)),
    (libc::RLIMIT_CORE, 0),
  ] {
    let mut inherited = libc::rlimit {
      rlim_cur: 0,
      rlim_max: 0,
    };
    // SAFETY: the synchronous syscalls read/write live rlimit values only;
    // limits are lowered in the isolated child before parsing any user bytes.
    unsafe {
      if libc::getrlimit(resource, &mut inherited) != 0 {
        return Err(std::io::Error::last_os_error());
      }
      let limit = libc::rlimit {
        rlim_cur: budget.min(inherited.rlim_cur).min(inherited.rlim_max),
        rlim_max: inherited.rlim_max,
      };
      if libc::setrlimit(resource, &limit) != 0 {
        return Err(std::io::Error::last_os_error());
      }
    }
  }
  Ok(())
}

#[cfg(not(target_os = "linux"))]
fn constrain_child(_: u64, _: usize, _: u64) -> std::io::Result<()> {
  Err(std::io::Error::other(
    "context parser resource isolation requires Linux",
  ))
}
