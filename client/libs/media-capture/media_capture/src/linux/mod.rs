// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Linux system-audio capture for Wayland desktops. The inner media-capture
// crate retains its MIT license because it contains the upstream native
// implementation; the Myoxus-specific NAPI wrapper remains AGPL licensed.

//! Linux system-audio capture through the PulseAudio client API.
//!
//! On modern Wayland desktops the audio server is commonly PipeWire with its
//! PulseAudio compatibility service. Connecting to the default monitor source
//! therefore captures the audio rendered by the desktop without depending on
//! an X11 screen or window. The backend deliberately exposes global capture
//! only: Linux does not have a stable, portable equivalent of the macOS
//! per-application tap used by the other native backends.

use std::{
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  },
  thread::JoinHandle,
};

use libpulse::{
  def::BufferAttr,
  sample::{Format, Spec},
  stream::Direction,
};
use libpulse_simple::Simple;
use napi::{
  Error, Status,
  bindgen_prelude::{Buffer, Float32Array, Result},
  threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

const DEFAULT_MONITOR_SOURCE: &str = "@DEFAULT_MONITOR@";
const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: u8 = 1;
const CAPTURE_FRAMES: usize = 960;

fn capture_spec() -> Spec {
  Spec {
    format: Format::FLOAT32NE,
    channels: TARGET_CHANNELS,
    rate: TARGET_SAMPLE_RATE,
  }
}

fn capture_buffer_attr() -> BufferAttr {
  BufferAttr {
    maxlength: u32::MAX,
    tlength: u32::MAX,
    prebuf: u32::MAX,
    minreq: u32::MAX,
    // Twenty milliseconds keeps stop latency bounded while avoiding a
    // callback for every small server-side fragment.
    fragsize: (CAPTURE_FRAMES * std::mem::size_of::<f32>()) as u32,
  }
}

fn pulse_error(operation: &str, error: impl std::fmt::Debug) -> Error {
  Error::new(
    Status::GenericFailure,
    format!("Linux system-audio {operation} failed: {error:?}"),
  )
}

fn connect_capture() -> Result<Simple> {
  let spec = capture_spec();
  if !spec.is_valid() {
    return Err(Error::new(
      Status::InvalidArg,
      "Linux system-audio capture produced an invalid PulseAudio sample specification",
    ));
  }

  Simple::new(
    None,
    "Myoxus",
    Direction::Record,
    Some(DEFAULT_MONITOR_SOURCE),
    "Myoxus system audio",
    &spec,
    None,
    Some(&capture_buffer_attr()),
  )
  .map_err(|error| pulse_error("connection", error))
}

fn decode_float32_native(bytes: &[u8]) -> Vec<f32> {
  bytes
    .chunks_exact(std::mem::size_of::<f32>())
    .map(|chunk| {
      let value = f32::from_ne_bytes(chunk.try_into().expect("chunks_exact guarantees size"));
      if value.is_finite() { value.clamp(-1.0, 1.0) } else { 0.0 }
    })
    .collect()
}

#[napi]
#[derive(Clone)]
pub struct ApplicationInfo {
  pub process_id: i32,
  pub name: String,
  pub object_id: u32,
}

#[napi]
impl ApplicationInfo {
  #[napi(constructor)]
  pub fn new(process_id: i32, name: String, object_id: u32) -> Self {
    Self {
      process_id,
      name,
      object_id,
    }
  }

  #[napi(getter)]
  pub fn process_group_id(&self) -> i32 {
    self.process_id
  }

  #[napi(getter)]
  pub fn bundle_identifier(&self) -> String {
    String::new()
  }

  #[napi(getter)]
  pub fn icon(&self) -> Buffer {
    Buffer::from(Vec::<u8>::new())
  }
}

#[napi]
pub struct ApplicationListChangedSubscriber {
  _callback: Arc<ThreadsafeFunction<(), ()>>,
}

#[napi]
impl ApplicationListChangedSubscriber {
  #[napi]
  pub fn unsubscribe(&self) {}
}

#[napi]
pub struct ApplicationStateChangedSubscriber {
  _callback: Arc<ThreadsafeFunction<(), ()>>,
}

#[napi]
impl ApplicationStateChangedSubscriber {
  #[napi]
  pub fn unsubscribe(&self) {}
}

/// A global system-audio recording session.
///
/// The PulseAudio simple API blocks while a fragment is being filled. The
/// backend intentionally requests a bounded twenty-millisecond fragment so
/// `stop()` has bounded latency while the audio server is healthy, including
/// when the desktop is currently silent. A server-side disconnect exits the
/// read loop with an error and is also joined by `stop()`.
#[napi]
pub struct AudioCaptureSession {
  stopped: Arc<AtomicBool>,
  worker: Option<JoinHandle<()>>,
}

#[napi]
impl AudioCaptureSession {
  #[napi(getter)]
  pub fn get_sample_rate(&self) -> f64 {
    TARGET_SAMPLE_RATE as f64
  }

  #[napi(getter)]
  pub fn get_channels(&self) -> u32 {
    TARGET_CHANNELS as u32
  }

  #[napi(getter)]
  pub fn get_actual_sample_rate(&self) -> f64 {
    TARGET_SAMPLE_RATE as f64
  }

  #[napi]
  pub fn stop(&mut self) -> Result<()> {
    if self.stopped.swap(true, Ordering::SeqCst) {
      return Ok(());
    }

    if let Some(worker) = self.worker.take() {
      worker
        .join()
        .map_err(|_| Error::new(Status::GenericFailure, "Linux system-audio worker panicked"))?;
    }
    Ok(())
  }
}

impl Drop for AudioCaptureSession {
  fn drop(&mut self) {
    let _ = self.stop();
  }
}

#[napi]
pub struct ShareableContent {}

#[napi]
impl ShareableContent {
  #[napi(constructor)]
  pub fn new() -> Result<Self> {
    probe_system_audio()?;
    Ok(Self {})
  }

  #[napi]
  pub fn is_system_audio_available() -> bool {
    probe_system_audio().is_ok()
  }

  #[napi]
  pub fn applications() -> Result<Vec<ApplicationInfo>> {
    Ok(Vec::new())
  }

  #[napi]
  pub fn application_with_process_id(_process_id: u32) -> Option<ApplicationInfo> {
    None
  }

  #[napi]
  pub fn is_using_microphone(_process_id: u32) -> Result<bool> {
    Ok(false)
  }

  #[napi]
  pub fn on_application_list_changed(callback: ThreadsafeFunction<(), ()>) -> Result<ApplicationListChangedSubscriber> {
    Ok(ApplicationListChangedSubscriber {
      _callback: Arc::new(callback),
    })
  }

  #[napi]
  pub fn on_app_state_changed(
    _app: &ApplicationInfo,
    callback: ThreadsafeFunction<(), ()>,
  ) -> Result<ApplicationStateChangedSubscriber> {
    Ok(ApplicationStateChangedSubscriber {
      _callback: Arc::new(callback),
    })
  }

  #[napi]
  pub fn tap_audio(
    _process_id: u32,
    _audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
  ) -> Result<AudioCaptureSession> {
    Err(Error::new(
      Status::GenericFailure,
      "Per-application audio capture is not available on Linux Wayland; use global system audio",
    ))
  }

  #[napi]
  pub fn tap_global_audio(
    _excluded_processes: Option<Vec<&ApplicationInfo>>,
    audio_stream_callback: ThreadsafeFunction<Float32Array, ()>,
  ) -> Result<AudioCaptureSession> {
    start_recording(audio_stream_callback)
  }
}

fn probe_system_audio() -> Result<()> {
  let _capture = connect_capture()?;
  Ok(())
}

fn start_recording(audio_stream_callback: ThreadsafeFunction<Float32Array, ()>) -> Result<AudioCaptureSession> {
  let capture = connect_capture()?;
  let stopped = Arc::new(AtomicBool::new(false));
  let stopped_worker = Arc::clone(&stopped);

  let worker = std::thread::Builder::new()
    .name("myoxus-linux-system-audio".to_string())
    .spawn(move || {
      let mut bytes = vec![0_u8; CAPTURE_FRAMES * TARGET_CHANNELS as usize * std::mem::size_of::<f32>()];

      while !stopped_worker.load(Ordering::SeqCst) {
        match capture.read(&mut bytes) {
          Ok(()) => {
            if stopped_worker.load(Ordering::SeqCst) {
              break;
            }
            let samples = decode_float32_native(&bytes);
            if !samples.is_empty() {
              let _ = audio_stream_callback.call(Ok(samples.into()), ThreadsafeFunctionCallMode::NonBlocking);
            }
          }
          Err(error) => {
            if !stopped_worker.load(Ordering::SeqCst) {
              let _ =
                audio_stream_callback.call(Err(pulse_error("read", error)), ThreadsafeFunctionCallMode::NonBlocking);
              stopped_worker.store(true, Ordering::SeqCst);
            }
            break;
          }
        }
      }
    })
    .map_err(|error| {
      Error::new(
        Status::GenericFailure,
        format!("start Linux system-audio worker: {error}"),
      )
    })?;

  Ok(AudioCaptureSession {
    stopped,
    worker: Some(worker),
  })
}

#[cfg(test)]
mod tests {
  use super::{CAPTURE_FRAMES, TARGET_SAMPLE_RATE, capture_buffer_attr, capture_spec, decode_float32_native};

  #[test]
  fn capture_spec_is_valid_and_uses_transcription_rate() {
    let spec = capture_spec();
    assert!(spec.is_valid());
    assert_eq!(spec.rate, TARGET_SAMPLE_RATE);
    assert_eq!(spec.channels, 1);
  }

  #[test]
  fn capture_buffer_is_bounded_to_twenty_milliseconds() {
    let attr = capture_buffer_attr();
    assert_eq!(attr.fragsize as usize, CAPTURE_FRAMES * std::mem::size_of::<f32>());
  }

  #[test]
  fn decode_float32_native_clamps_invalid_samples() {
    let bytes = [0.25_f32.to_ne_bytes(), 3.0_f32.to_ne_bytes(), f32::NAN.to_ne_bytes()].concat();

    assert_eq!(decode_float32_native(&bytes), vec![0.25, 1.0, 0.0]);
  }
}
