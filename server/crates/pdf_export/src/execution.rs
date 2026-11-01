// SPDX-License-Identifier: AGPL-3.0-or-later
//! One compiler process per execution. The supervisor owns admission until the
//! child has stopped and been reaped, including when its async caller is dropped.
//! Requests and responses use bounded anonymous pipes, never document tempfiles.

use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
  Arc, LazyLock,
  atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, oneshot};

use crate::template_v2::CompileError;
use crate::{EdgelessSnapshotLimits, IrDocument, RenderError, RenderReport};

pub const DEFAULT_MEMORY_MB: u32 = 1024;
const STARTUP_MEMORY_FAILURE: &[u8] = b"pdf compiler memory budget unavailable at startup";

/// One server-owned resource snapshot per execution. Transport byte budgets are
/// derived from this memory setting; Linux RLIMIT_AS enforces memory separately.
#[derive(Debug, Clone, Copy)]
pub struct CompilerLimits {
  pub watchdog: Duration,
  pub max_memory_mb: u32,
}
impl Default for CompilerLimits {
  fn default() -> Self {
    Self {
      watchdog: Duration::from_secs(120),
      max_memory_mb: DEFAULT_MEMORY_MB,
    }
  }
}
impl CompilerLimits {
  fn memory_bytes(self) -> Result<u64, CompileError> {
    if self.max_memory_mb < 64 {
      return Err(CompileError::IoError(
        "compiler memory budget must be at least 64 MiB".into(),
      ));
    }
    Ok(u64::from(self.max_memory_mb) * 1024 * 1024)
  }
}
static CAPACITY: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));

#[derive(Serialize, Deserialize)]
pub(crate) enum CompilerRequest {
  Validate {
    files: HashMap<String, serde_bytes::ByteBuf>,
    manifest: PdfTemplateManifest,
    /// None keeps upload validation small; previews use representative localized content.
    preview_locale: Option<String>,
  },
  Render {
    doc: IrDocument,
    files: HashMap<String, serde_bytes::ByteBuf>,
    font_dirs: Vec<PathBuf>,
    max_pages: usize,
    snapshot_limits: EdgelessSnapshotLimits,
  },
}

#[derive(Serialize, Deserialize)]
pub(crate) enum CompilerResponse {
  Validation(Result<serde_bytes::ByteBuf, CompileError>),
  Render(Result<RenderReport, RenderError>),
}

pub(crate) fn binary_files(files: HashMap<String, Vec<u8>>) -> HashMap<String, serde_bytes::ByteBuf> {
  files.into_iter().map(|(name, bytes)| (name, bytes.into())).collect()
}

fn unpack_files(files: HashMap<String, serde_bytes::ByteBuf>) -> HashMap<String, Vec<u8>> {
  files
    .into_iter()
    .map(|(name, bytes)| (name, bytes.into_vec()))
    .collect()
}

/// Render through the same owner as upload validation and preview. The lease
/// keeps materialized fonts alive until execution has stopped and been reaped.
/// Transport failures retain the established renderer error class.
pub async fn render<L: Send + 'static>(
  doc: IrDocument,
  files: HashMap<String, Vec<u8>>,
  font_dirs: Vec<PathBuf>,
  max_pages: usize,
  snapshot_limits: EdgelessSnapshotLimits,
  limits: CompilerLimits,
  lease: L,
) -> Result<RenderReport, RenderError> {
  match execute(
    CompilerRequest::Render {
      doc,
      files: binary_files(files),
      font_dirs,
      max_pages,
      snapshot_limits,
    },
    limits,
    lease,
  )
  .await
  {
    Ok(CompilerResponse::Render(result)) => result,
    Err(CompileError::Timeout) => Err(RenderError::Timeout {
      secs: limits.watchdog.as_secs(),
    }),
    Err(CompileError::MemoryLimit) => Err(RenderError::MemoryLimit),
    _ => Err(RenderError::Compilation("compiler process transport failed".into())),
  }
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
  fn drop(&mut self) {
    self.0.store(true, Ordering::Release);
  }
}

struct OwnedChild(Option<Child>);
impl Drop for OwnedChild {
  fn drop(&mut self) {
    if let Some(child) = &mut self.0 {
      // The compiler does not launch subprocesses. kill + wait also handles
      // unwinding in the supervisor and prevents zombies during runtime shutdown.
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

fn io_error(_: impl std::fmt::Display) -> CompileError {
  // OS/protocol errors must not echo serialized input or compiler stderr.
  CompileError::IoError("compiler process transport failed".into())
}

fn executable() -> Result<PathBuf, CompileError> {
  let exe = std::env::current_exe().map_err(io_error)?;
  let mut dir = exe.parent().ok_or_else(|| io_error("missing executable directory"))?;
  // Cargo integration-test executables live in target/{profile}/deps; Cargo
  // builds this package's compiler binary alongside the consuming test targets.
  if dir.file_name().is_some_and(|name| name == "deps") {
    dir = dir.parent().ok_or_else(|| io_error("missing profile directory"))?;
  }
  Ok(dir.join("myoxus-pdf-compiler"))
}

/// Execute a request and retain a caller's admission lease until reaping.
/// Dropping this future signals the independent supervisor; it does not detach
/// the compiler or release the lease while compiler work continues.
pub(crate) async fn execute<L: Send + 'static>(
  request: CompilerRequest,
  limits: CompilerLimits,
  lease: L,
) -> Result<CompilerResponse, CompileError> {
  if !cfg!(all(target_os = "linux", target_pointer_width = "64")) {
    return Err(CompileError::IoError(
      "compiler memory isolation requires Linux 64-bit".into(),
    ));
  }
  let memory_bytes = limits.memory_bytes()?;
  let deadline = Instant::now()
    .checked_add(limits.watchdog)
    .ok_or_else(|| io_error("invalid deadline"))?;
  let capacity = tokio::time::timeout(limits.watchdog, CAPACITY.clone().acquire_owned())
    .await
    .map_err(|_| CompileError::Timeout)?
    .map_err(io_error)?;
  let cancelled = Arc::new(AtomicBool::new(false));
  let _cancel_on_drop = CancelOnDrop(cancelled.clone());
  let (sender, receiver) = oneshot::channel();
  std::thread::Builder::new()
    .name("pdf-compiler-owner".into())
    .spawn(move || {
      let result = supervise(request, deadline, cancelled, memory_bytes);
      // Drop both leases before reporting success/failure, but only after reaping.
      drop(lease);
      drop(capacity);
      let _ = sender.send(result);
    })
    .map_err(io_error)?;
  receiver.await.map_err(io_error)?
}

fn supervise(
  request: CompilerRequest,
  deadline: Instant,
  cancelled: Arc<AtomicBool>,
  memory_bytes: u64,
) -> Result<CompilerResponse, CompileError> {
  let mut command = Command::new(executable()?);
  // Only these private runtime controls reach the compiler. Effective product
  // configuration, font paths and document options travel in the typed request.
  command
    .env_clear()
    .env("MALLOC_ARENA_MAX", "2")
    .env("RAYON_NUM_THREADS", "8")
    .env("RUST_MIN_STACK", "2097152")
    .arg(memory_bytes.to_string())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(target_os = "linux")]
  {
    use std::os::unix::process::CommandExt;
    let parent = std::process::id();
    // SAFETY: only async-signal-safe syscalls are used between fork and exec.
    // PDEATHSIG also stops compiler work if the API itself is forcibly killed.
    unsafe {
      command.pre_exec(move || {
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() as u32 != parent {
          return Err(std::io::Error::last_os_error());
        }
        Ok(())
      });
    }
  }
  if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
    return Err(CompileError::Timeout);
  }
  let mut owned = OwnedChild(Some(command.spawn().map_err(|error| {
    if error.raw_os_error() == Some(libc::ENOMEM) {
      CompileError::MemoryLimit
    } else {
      io_error(error)
    }
  })?));
  let child = owned.0.as_mut().expect("owned compiler");
  let pid = child.id();
  tracing::debug!(pid, "pdf compiler started");
  let stdin = child.stdin.take().ok_or_else(|| io_error("missing stdin"))?;
  let stdout = child.stdout.take().ok_or_else(|| io_error("missing stdout"))?;
  let stderr = child.stderr.take().ok_or_else(|| io_error("missing stderr"))?;
  let pipe_failed = AtomicBool::new(false);
  let exhausted = AtomicBool::new(false);
  let result = std::thread::scope(|scope| {
    // Drop the child inside the scope before its implicit thread joins. This
    // also closes the pipes if thread creation fails or the supervisor unwinds.
    let mut owned = owned;
    let child = owned.0.as_mut().expect("owned compiler");
    let failure = &pipe_failed;
    let writer = std::thread::Builder::new()
      .name("pdf-compiler-input".into())
      .stack_size(16 * 1024 * 1024)
      .spawn_scoped(scope, move || {
        let mut sink = BoundedWriter {
          inner: BufWriter::new(stdin),
          remaining: memory_bytes,
        };
        let result = ciborium::ser::into_writer(&request, &mut sink)
          .map_err(io_error)
          .and_then(|_| sink.flush().map_err(io_error));
        if result.is_err() {
          failure.store(true, Ordering::Release);
        }
        result
      })
      .map_err(io_error)?;
    let reader = std::thread::Builder::new()
      .name("pdf-compiler-output".into())
      .spawn_scoped(scope, move || {
        let mut bytes = Vec::new();
        if stdout.take(memory_bytes + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > memory_bytes {
          failure.store(true, Ordering::Release);
          return Err(io_error("oversized compiler response"));
        }
        Ok(bytes)
      })
      .map_err(io_error)?;
    let memory_flag = &exhausted;
    let diagnostic_reader = std::thread::Builder::new()
      .name("pdf-compiler-diagnostics".into())
      .spawn_scoped(scope, move || {
        let result = drain_diagnostics(stderr, memory_flag);
        if result.is_err() {
          failure.store(true, Ordering::Release);
        }
        result
      })
      .map_err(io_error)?;
    let status = loop {
      if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
        break Err(CompileError::Timeout);
      }
      match child.try_wait() {
        Ok(Some(status)) => break Ok(status),
        Ok(None) => {}
        Err(error) => break Err(io_error(error)),
      }
      // A reached protocol cap must terminate the child rather than wait on a
      // pipe whose peer has already stopped reading/writing.
      if pipe_failed.load(Ordering::Acquire) {
        break Err(io_error("compiler pipe stopped"));
      }
      std::thread::sleep(Duration::from_millis(5));
    };
    // Always stop execution before joining pipe threads; otherwise unwinding or
    // transport failure could wait forever for a compiler holding a pipe open.
    if status.is_err() {
      let _ = child.kill();
      let _ = child.wait();
    }
    let write_result = writer.join().map_err(|_| io_error("compiler writer panicked"))?;
    let read_result = reader.join().map_err(|_| io_error("compiler reader panicked"))?;
    let diagnostic_result = diagnostic_reader
      .join()
      .map_err(|_| io_error("compiler diagnostics reader panicked"))?;
    // Deadline/cancellation retain priority. A closed stdin during allocator
    // abort must not hide the recognized memory failure behind a pipe error.
    if matches!(status, Err(CompileError::Timeout)) {
      return Err(CompileError::Timeout);
    }
    if exhausted.load(Ordering::Acquire) {
      return Err(CompileError::MemoryLimit);
    }
    let status = status?;
    diagnostic_result?;
    write_result?;
    if !status.success() {
      return Err(CompileError::PanickedDuringCompile("compiler process failed".into()));
    }
    let bytes = read_result?;
    ciborium::de::from_reader_with_recursion_limit(bytes.as_slice(), 4096).map_err(io_error)
  });
  tracing::debug!(pid, "pdf compiler reaped");
  result
}

// Drain stderr without retaining payloads or logging them. Only fixed allocator
// and startup-policy markers may classify a memory failure; SIGABRT alone does
// not distinguish exhaustion from an unrelated crash.
fn drain_diagnostics(mut source: impl Read, exhausted: &AtomicBool) -> Result<(), CompileError> {
  let mut chunk = [0u8; 4096];
  let mut line = [0u8; 128];
  let mut length = 0;
  let mut truncated = false;
  loop {
    let count = source.read(&mut chunk).map_err(io_error)?;
    for &byte in &chunk[..count] {
      if byte == b'\n' {
        if !truncated && memory_marker(&line[..length]) {
          exhausted.store(true, Ordering::Release);
        }
        length = 0;
        truncated = false;
      } else if length < line.len() {
        line[length] = byte;
        length += 1;
      } else {
        truncated = true;
      }
    }
    if count == 0 {
      if !truncated && memory_marker(&line[..length]) {
        exhausted.store(true, Ordering::Release);
      }
      return Ok(());
    }
  }
}

fn memory_marker(line: &[u8]) -> bool {
  line == STARTUP_MEMORY_FAILURE
    || line
      .strip_prefix(b"memory allocation of ")
      .and_then(|rest| rest.strip_suffix(b" bytes failed"))
      .is_some_and(|count| !count.is_empty() && count.iter().all(u8::is_ascii_digit))
}

/// Apply the hard address-space limit before reading any untrusted protocol
/// bytes. Applying it before exec would make low budgets kill the dynamic loader
/// without a classifiable allocator error. Trusted startup that already exceeds
/// the budget is rejected without starting document work.
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
fn initialize_memory_policy() -> Result<u64, std::io::Error> {
  let requested: u64 = std::env::args()
    .nth(1)
    .ok_or_else(|| std::io::Error::other("missing compiler budget"))?
    .parse()
    .map_err(std::io::Error::other)?;
  if requested < 64 * 1024 * 1024 {
    return Err(std::io::Error::other("invalid compiler budget"));
  }
  let mut inherited = libc::rlimit {
    rlim_cur: 0,
    rlim_max: 0,
  };
  let no_core = libc::rlimit {
    rlim_cur: 0,
    rlim_max: 0,
  };
  // SAFETY: these live rlimit pointers remain valid for the synchronous syscalls.
  // Lower inherited operator limits are retained; no privilege is needed.
  unsafe {
    if libc::getrlimit(libc::RLIMIT_AS, &mut inherited) != 0 || libc::setrlimit(libc::RLIMIT_CORE, &no_core) != 0 {
      return Err(std::io::Error::last_os_error());
    }
  }
  let bytes = requested.min(inherited.rlim_cur).min(inherited.rlim_max);
  // Initialize trusted worker stacks/allocator arenas before measuring startup.
  // Otherwise a low valid budget could fail thread creation during document work
  // and be misclassified as a generic compiler panic.
  rayon::ThreadPoolBuilder::new()
    .num_threads(8)
    .stack_size(2 * 1024 * 1024)
    .build_global()
    .map_err(std::io::Error::other)?;
  rayon::broadcast(|_| {
    let mut scratch = Vec::with_capacity(1);
    scratch.push(0u8);
    std::hint::black_box(scratch);
  });
  let statm = std::fs::read_to_string("/proc/self/statm")?;
  let pages: u64 = statm
    .split_ascii_whitespace()
    .next()
    .ok_or_else(|| std::io::Error::other("missing address-space size"))?
    .parse()
    .map_err(std::io::Error::other)?;
  // SAFETY: sysconf has no pointer arguments and queries a fixed system constant.
  let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
  let size = pages
    .checked_mul(u64::try_from(page_size).map_err(std::io::Error::other)?)
    .ok_or_else(|| std::io::Error::other("address-space overflow"))?;
  if size > bytes {
    let mut stderr = std::io::stderr();
    stderr.write_all(STARTUP_MEMORY_FAILURE)?;
    stderr.write_all(b"\n")?;
    return Err(std::io::Error::other("compiler startup exceeds memory budget"));
  }
  let limit = libc::rlimit {
    rlim_cur: bytes,
    rlim_max: bytes,
  };
  // SAFETY: the kernel reads this live limit synchronously and retains no pointer.
  if unsafe { libc::setrlimit(libc::RLIMIT_AS, &limit) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  Ok(bytes)
}

#[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
fn initialize_memory_policy() -> Result<u64, std::io::Error> {
  Err(std::io::Error::other("compiler memory isolation requires Linux 64-bit"))
}

struct BoundedWriter<W> {
  inner: W,
  remaining: u64,
}
impl<W: Write> Write for BoundedWriter<W> {
  fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
    if bytes.len() as u64 > self.remaining {
      return Err(std::io::Error::other("compiler protocol size limit"));
    }
    let written = self.inner.write(bytes)?;
    self.remaining -= written as u64;
    Ok(written)
  }
  fn flush(&mut self) -> std::io::Result<()> {
    self.inner.flush()
  }
}

/// Packaged compiler entry point; stdin/stdout are private bounded protocol pipes.
pub fn compiler_main() -> Result<(), std::io::Error> {
  let memory_bytes = initialize_memory_policy()?;
  let mut input = Vec::new();
  std::io::stdin().take(memory_bytes + 1).read_to_end(&mut input)?;
  if input.len() as u64 > memory_bytes {
    return Err(std::io::Error::other("compiler input limit"));
  }
  // The private codec uses byte strings rather than JSON number arrays. Its
  // recursion budget accommodates persisted IR nesting without JSON's 128-level
  // default; the enclosing byte limit still bounds input.
  let request: CompilerRequest =
    ciborium::de::from_reader_with_recursion_limit(input.as_slice(), 4096).map_err(std::io::Error::other)?;
  drop(input);
  let result = match request {
    CompilerRequest::Validate {
      files,
      manifest,
      preview_locale,
    } => CompilerResponse::Validation(
      std::panic::catch_unwind(|| {
        crate::template_v2::compile_validator::render_blocking(
          unpack_files(files),
          &manifest,
          preview_locale.as_deref(),
        )
      })
      .unwrap_or_else(|_| Err(CompileError::PanickedDuringCompile("compiler panicked".into())))
      .map(Into::into),
    ),
    CompilerRequest::Render {
      doc,
      files,
      font_dirs,
      max_pages,
      snapshot_limits,
    } => CompilerResponse::Render(
      std::panic::catch_unwind(|| {
        crate::render_to_pdf_v2_with_snapshot_limits(&doc, &unpack_files(files), &font_dirs, max_pages, snapshot_limits)
      })
      .unwrap_or_else(|_| Err(RenderError::Compilation("compiler panicked".into()))),
    ),
  };
  let mut output = BoundedWriter {
    inner: BufWriter::new(std::io::stdout()),
    remaining: memory_bytes,
  };
  ciborium::ser::into_writer(&result, &mut output).map_err(std::io::Error::other)?;
  output.flush()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn binary_protocol_preserves_public_json_assets_and_report() {
    let request = CompilerRequest::Render {
      doc: crate::template_v2::stub_doc::build_stub_doc(),
      files: HashMap::new(),
      font_dirs: vec![],
      max_pages: 500,
      snapshot_limits: EdgelessSnapshotLimits::default(),
    };
    let mut wire = Vec::new();
    ciborium::ser::into_writer(&request, &mut wire).unwrap();
    let _: CompilerRequest =
      ciborium::de::from_reader_with_recursion_limit(wire.as_slice(), 4096).expect("complete IR request roundtrip");
    let bytes = vec![255; 1024];
    let asset = crate::ir::AssetData {
      mime: "image/png".into(),
      bytes: bytes.clone(),
      filename: None,
    };
    let json = serde_json::to_value(&asset).expect("public asset JSON");
    assert_eq!(
      json["bytes"],
      serde_json::json!(bytes),
      "persisted IR retains number arrays"
    );
    let mut encoded = Vec::new();
    ciborium::ser::into_writer(&asset, &mut encoded).expect("private asset encoding");
    assert!(
      encoded.len() < 1100,
      "binary assets must not expand into number arrays in pipes"
    );
    let decoded: crate::ir::AssetData = ciborium::de::from_reader(encoded.as_slice()).expect("asset roundtrip");
    assert_eq!(decoded.bytes, bytes);
    let report = RenderReport {
      pdf_bytes: bytes,
      page_count: 3,
      unmapped_font_families: vec!["diagnostic family".into()],
    };
    encoded.clear();
    ciborium::ser::into_writer(&CompilerResponse::Render(Ok(report.clone())), &mut encoded).unwrap();
    let CompilerResponse::Render(Ok(decoded)) = ciborium::de::from_reader(encoded.as_slice()).unwrap() else {
      panic!("render report response")
    };
    assert_eq!(decoded.pdf_bytes, report.pdf_bytes);
    assert_eq!(decoded.page_count, report.page_count);
    assert_eq!(decoded.unmapped_font_families, report.unmapped_font_families);
  }
}
