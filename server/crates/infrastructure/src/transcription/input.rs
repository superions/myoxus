// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded container/timeline inspection for the existing encoded audio formats.

use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;
use myoxus_application::transcription::{
  ProviderError,
  input::{AudioInputInfo, AudioInputInspector, AudioInputWork},
};
use symphonia::core::{
  common::Limit,
  formats::{FormatOptions, TrackType, probe::Hint},
  io::{MediaSource, MediaSourceStream},
  meta::MetadataOptions,
};
use tracing::instrument;

pub struct EncodedAudioInspector;

struct DeadlineSource {
  data: Cursor<Bytes>,
  deadline: Instant,
}

impl DeadlineSource {
  fn check(&self) -> io::Result<()> {
    if Instant::now() >= self.deadline {
      Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "audio inspection deadline exceeded",
      ))
    } else {
      Ok(())
    }
  }
}
impl Read for DeadlineSource {
  fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
    self.check()?;
    self.data.read(target)
  }
}
impl Seek for DeadlineSource {
  fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
    self.check()?;
    self.data.seek(position)
  }
}
impl MediaSource for DeadlineSource {
  fn is_seekable(&self) -> bool {
    true
  }
  fn byte_len(&self) -> Option<u64> {
    Some(self.data.get_ref().len() as u64)
  }
}

fn invalid() -> ProviderError {
  ProviderError::InvalidRequest("audio is empty, invalid or unsupported".into())
}

fn container(audio: &[u8]) -> Result<(&'static str, &'static str), ProviderError> {
  if audio.starts_with(b"RIFF") && audio.get(8..12) == Some(b"WAVE") {
    Ok(("wav", "audio/wav"))
  } else if audio.get(4..8) == Some(b"ftyp") {
    Ok(("mp4", "audio/mp4"))
  } else if audio.starts_with(b"OggS") {
    Ok(("ogg", "audio/ogg"))
  } else if audio.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
    Ok(("webm", "audio/webm"))
  } else if audio.starts_with(b"fLaC") {
    Ok(("flac", "audio/flac"))
  } else if audio.starts_with(b"ID3") || (audio.len() >= 2 && audio[0] == 0xff && audio[1] & 0xe0 == 0xe0) {
    Ok(("mp3", "audio/mpeg"))
  } else {
    Err(invalid())
  }
}

fn inspect(audio: Bytes, max_duration_seconds: u64, deadline: Instant) -> Result<AudioInputInfo, ProviderError> {
  let (extension, mime) = container(&audio)?;
  let source = DeadlineSource {
    data: Cursor::new(audio),
    deadline,
  };
  let stream = MediaSourceStream::new(Box::new(source), Default::default());
  let mut hint = Hint::new();
  hint.with_extension(extension);
  // Speech consumes no embedded artwork or display tags. Keep parser metadata
  // allocations small independently of the permitted encoded audio size.
  let metadata = MetadataOptions::default()
    .limit_tag_bytes(Limit::Maximum(4096))
    .limit_visual_bytes(Limit::Maximum(0));
  let mut reader = symphonia::default::get_probe()
    .probe(&hint, stream, FormatOptions::default(), metadata)
    .map_err(|_| invalid())?;
  let track = reader.default_track(TrackType::Audio).ok_or_else(invalid)?;
  let track_id = track.id;
  let time_base = track.time_base.ok_or_else(invalid)?;
  let start = time_base.calc_time(track.start_ts).ok_or_else(invalid)?.as_secs_f64();
  let mut duration = track
    .duration
    .map(|value| time_base.calc_duration(value).ok_or_else(invalid))
    .transpose()?
    .map(|value| value.as_secs_f64())
    .unwrap_or(0.0);
  let mut packets = 0_u64;
  while let Some(packet) = reader.next_packet().map_err(|_| invalid())? {
    if Instant::now() >= deadline {
      return Err(ProviderError::Timeout("audio inspection deadline exceeded".into()));
    }
    if packet.track_id != track_id {
      continue;
    }
    let position = time_base.calc_time(packet.pts).ok_or_else(invalid)?.as_secs_f64() - start;
    let length = time_base.calc_duration(packet.dur).ok_or_else(invalid)?.as_secs_f64();
    duration = duration.max(position + length);
    packets += u64::from(!packet.data.is_empty());
    if !duration.is_finite() || duration > max_duration_seconds as f64 {
      return Err(ProviderError::InvalidRequest(
        "audio duration exceeds the configured limit".into(),
      ));
    }
  }
  if packets == 0 || !duration.is_finite() || duration <= 0.0 {
    return Err(invalid());
  }
  Ok(AudioInputInfo {
    format: extension.into(),
    mime: mime.into(),
    duration_seconds: duration,
  })
}

#[async_trait]
impl AudioInputInspector for EncodedAudioInspector {
  #[instrument(skip_all)]
  async fn inspect(&self, audio: Bytes, work: AudioInputWork) -> Result<AudioInputInfo, ProviderError> {
    // The permit remains in this closure until the parser stops; dropping its
    // awaiting request cannot admit more work while this task is still running.
    tokio::task::spawn_blocking(move || {
      let result = inspect(audio, work.max_duration_seconds, work.deadline);
      drop(work);
      result
    })
    .await
    .map_err(|_| invalid())?
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Duration;

  struct NoTransport;
  #[async_trait]
  impl myoxus_application::transcription::TranscriptionTransport for NoTransport {
    fn provider_id(&self) -> &str {
      "inspection-test"
    }
  }
  fn work(max_duration_seconds: u64, deadline: Instant) -> AudioInputWork {
    use myoxus_application::transcription::{TranscriptionExecutionConfig, TranscriptionService};
    let service = TranscriptionService::new(
      true,
      TranscriptionExecutionConfig {
        source: "http://inspection-test/v1".into(),
        model: "inspection-test".into(),
        language: None,
        request_timeout_ms: 2000,
        max_input_bytes: 100000,
        max_response_bytes: 1000,
        max_duration_seconds,
        max_concurrency: 1,
      },
      std::sync::Arc::new(NoTransport),
      std::sync::Arc::default(),
    );
    let mut admission = service.admit_job(None).unwrap();
    admission.deadline = deadline;
    admission.input_work()
  }
  fn wav(seconds: u32) -> Bytes {
    let size = seconds * 8000 * 2;
    let mut audio = Vec::new();
    audio.extend_from_slice(b"RIFF");
    audio.extend_from_slice(&(36 + size).to_le_bytes());
    audio.extend_from_slice(b"WAVEfmt ");
    audio.extend_from_slice(&16_u32.to_le_bytes());
    audio.extend_from_slice(&1_u16.to_le_bytes());
    audio.extend_from_slice(&1_u16.to_le_bytes());
    audio.extend_from_slice(&8000_u32.to_le_bytes());
    audio.extend_from_slice(&16000_u32.to_le_bytes());
    audio.extend_from_slice(&2_u16.to_le_bytes());
    audio.extend_from_slice(&16_u16.to_le_bytes());
    audio.extend_from_slice(b"data");
    audio.extend_from_slice(&size.to_le_bytes());
    audio.resize(44 + size as usize, 0);
    audio.into()
  }

  #[tokio::test]
  async fn reads_actual_timeline_and_rejects_long_empty_or_invalid_audio() {
    let deadline = Instant::now() + Duration::from_secs(2);
    let info = EncodedAudioInspector.inspect(wav(2), work(2, deadline)).await.unwrap();
    assert_eq!(info.format, "wav");
    assert_eq!(info.mime, "audio/wav");
    assert!((info.duration_seconds - 2.0).abs() < 0.001);
    assert!(EncodedAudioInspector.inspect(wav(2), work(1, deadline)).await.is_err());
    assert!(EncodedAudioInspector.inspect(wav(0), work(2, deadline)).await.is_err());
    assert!(
      EncodedAudioInspector
        .inspect(Bytes::from_static(b"RIFFbroken audio"), work(2, deadline))
        .await
        .is_err()
    );
    assert!(
      EncodedAudioInspector
        .inspect(Bytes::new(), work(2, deadline))
        .await
        .is_err()
    );
  }

  #[tokio::test]
  async fn expired_deadline_cannot_enter_unbounded_parser_work() {
    assert!(
      EncodedAudioInspector
        .inspect(wav(1), work(2, Instant::now() - Duration::from_secs(1)))
        .await
        .is_err()
    );
  }
}
