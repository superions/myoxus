// SPDX-License-Identifier: AGPL-3.0-or-later
//! The single OpenAI-compatible multipart speech transport.

pub mod input;
pub mod results;

use async_trait::async_trait;
use myoxus_application::transcription::{
  ProviderError, TranscriptionConnectionCheck, TranscriptionResponse, TranscriptionSegment, TranscriptionTransport,
};
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use tracing::{error, info, instrument};

pub struct OpenAiTranscriptionTransport {
  client: Client,
  api_key: String,
  endpoint: String,
  id: String,
}

impl OpenAiTranscriptionTransport {
  pub fn new(
    endpoint: String,
    api_key: Option<String>,
    timeout: Duration,
    additional_ca: Option<&crate::tls::ValidatedCaBundle>,
  ) -> Result<Self, ProviderError> {
    validate_endpoint(&endpoint).map_err(|error| ProviderError::InvalidRequest(error.into()))?;
    let client = crate::tls::build_http_client(
      Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none()),
      additional_ca,
    )
    .map_err(|error| ProviderError::Unavailable(error.to_string()))?;
    Ok(Self {
      id: "transcription".into(),
      client,
      endpoint: endpoint.trim_end_matches('/').to_string(),
      api_key: api_key.unwrap_or_default(),
    })
  }

  async fn read_response(&self, mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, ProviderError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
      let error = error.without_url();
      error!(provider = %self.id, error = %error, "failed to read transcription response");
      ProviderError::Upstream(error.to_string())
    })? {
      if chunk.len() > limit.saturating_sub(body.len()) {
        return Err(ProviderError::Upstream(
          "speech response exceeds the configured limit".into(),
        ));
      }
      body.extend_from_slice(&chunk);
    }
    Ok(body)
  }
}

fn status_error(code: u16) -> ProviderError {
  let message = format!("HTTP {code}");
  match code {
    400 | 413 | 415 | 422 => ProviderError::InvalidRequest(message),
    401 | 403 => ProviderError::Unavailable(message),
    408 | 504 => ProviderError::Timeout(message),
    429 => ProviderError::RateLimited(message),
    _ => ProviderError::Upstream(message),
  }
}

/// Admin-configured internal HTTP services are allowed. Reject embedded secrets,
/// query parameters and fragments rather than forwarding them to appended routes.
pub fn validate_endpoint(endpoint: &str) -> Result<(), &'static str> {
  if endpoint.len() > 4096 || endpoint.trim() != endpoint || endpoint.chars().any(char::is_control) {
    return Err("must be a bounded HTTP(S) base URL without whitespace or control characters");
  }
  let url = reqwest::Url::parse(endpoint).map_err(|_| "must be a valid HTTP(S) base URL")?;
  if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
    return Err("must be a valid HTTP(S) base URL");
  }
  if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
    return Err("must not contain credentials, query parameters or a fragment; use the protected API key field");
  }
  if url.path().trim_end_matches('/').ends_with("/audio/transcriptions") {
    return Err("must be a base URL; /audio/transcriptions is appended by the server");
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// OpenAI-compatible speech response (private)
// ---------------------------------------------------------------------------

/// Response from `POST /audio/transcriptions` with `response_format=verbose_json`.
#[derive(Deserialize)]
struct OpenAiTranscriptionResponse {
  text: String,
  #[serde(default)]
  language: Option<String>,
  #[serde(default)]
  duration: Option<f64>,
  #[serde(default)]
  segments: Vec<OpenAiSegment>,
}

#[derive(Deserialize)]
struct OpenAiSegment {
  text: String,
  #[serde(default)]
  start: Option<f64>,
  #[serde(default)]
  end: Option<f64>,
  #[serde(default)]
  speaker: Option<String>,
}

impl OpenAiTranscriptionResponse {
  fn into_result(self) -> Result<TranscriptionResponse, ProviderError> {
    let valid_time = |time: Option<f64>| time.is_none_or(|value| value.is_finite() && value >= 0.0);
    if !valid_time(self.duration)
      || self.segments.iter().any(|segment| {
        !valid_time(segment.start)
          || !valid_time(segment.end)
          || matches!((segment.start, segment.end), (Some(start), Some(end)) if end < start)
      })
    {
      return Err(ProviderError::Upstream("invalid response timing".into()));
    }
    let mut segments: Vec<_> = self
      .segments
      .into_iter()
      .map(|segment| TranscriptionSegment {
        text: segment.text,
        start_seconds: segment.start,
        end_seconds: segment.end,
        speaker: segment.speaker.filter(|value| !value.trim().is_empty()),
      })
      .collect();
    // Timed responses are ordered by playback position; preserve provider order
    // when timing is absent instead of assigning invented positions.
    if segments.iter().all(|segment| segment.start_seconds.is_some()) {
      segments.sort_by(|a, b| a.start_seconds.unwrap().total_cmp(&b.start_seconds.unwrap()));
    }
    Ok(TranscriptionResponse {
      text: self.text,
      language: self.language,
      duration_seconds: self.duration,
      segments,
    })
  }
}

#[async_trait]
impl TranscriptionTransport for OpenAiTranscriptionTransport {
  fn provider_id(&self) -> &str {
    &self.id
  }

  #[instrument(skip_all, fields(provider = %self.id))]
  async fn check_connection(
    &self,
    model: &str,
    max_response_bytes: usize,
  ) -> Result<TranscriptionConnectionCheck, ProviderError> {
    let mut request = self.client.get(format!("{}/models", self.endpoint));
    if !self.api_key.is_empty() {
      request = request.bearer_auth(&self.api_key);
    }
    let response = request.send().await.map_err(|error| {
      // Reqwest's standard source chain retains the actual TLS cause. Remove
      // its URL before formatting; the GET has no audio or request body.
      let error = error.without_url();
      if error.is_timeout() {
        ProviderError::Timeout(format!("{error:?}"))
      } else {
        ProviderError::Unavailable(format!("{error:?}"))
      }
    })?;
    let status = response.status();
    if matches!(status.as_u16(), 404 | 405) {
      return Ok(TranscriptionConnectionCheck {
        catalog_supported: false,
        model_listed: None,
      });
    }
    if !status.is_success() {
      // A provider may echo credentials in its error body. The status is enough.
      return Err(status_error(status.as_u16()));
    }
    let body = self.read_response(response, max_response_bytes).await?;
    let catalog: serde_json::Value =
      serde_json::from_slice(&body).map_err(|_| ProviderError::Upstream("invalid models response format".into()))?;
    // Only the normal OpenAI list shape establishes catalog membership. It
    // still does not establish speech capability, availability or model loading.
    let model_listed = if catalog["object"] == "list" {
      catalog["data"]
        .as_array()
        .filter(|items| items.iter().all(|item| item["id"].is_string()))
        .map(|items| items.iter().any(|item| item["id"] == model))
    } else {
      None
    };
    Ok(TranscriptionConnectionCheck {
      catalog_supported: true,
      model_listed,
    })
  }
  #[instrument(skip_all, fields(provider = %self.id, %model, audio_bytes = audio_data.len()))]
  async fn transcribe(
    &self,
    audio_data: &[u8],
    format: &str,
    model: &str,
    language: Option<&str>,
    max_response_bytes: usize,
  ) -> Result<TranscriptionResponse, ProviderError> {
    if audio_data.is_empty() {
      return Err(ProviderError::InvalidRequest("audio_data is empty".to_string()));
    }

    if model.trim().is_empty() {
      return Err(ProviderError::InvalidRequest("model is required".into()));
    }
    let effective_model = model;

    // Map common format hints to file extensions for the multipart filename.
    let format_lower = format.to_lowercase();
    let extension = match format_lower.as_str() {
      "mp3" | "audio/mpeg" => "mp3",
      "wav" | "audio/wav" | "audio/x-wav" => "wav",
      "flac" | "audio/flac" => "flac",
      "ogg" | "audio/ogg" => "ogg",
      "webm" | "audio/webm" => "webm",
      "mp4" | "audio/mp4" | "m4a" | "audio/x-m4a" => "m4a",
      other => {
        // If it looks like a MIME type with a slash, extract the subtype.
        if let Some((_prefix, suffix)) = other.split_once('/') {
          suffix
        } else {
          other
        }
      }
    };

    let filename = format!("audio.{extension}");
    let url = format!("{}/audio/transcriptions", self.endpoint);

    let start = std::time::Instant::now();

    // Build the multipart form inside the retry closure because
    // reqwest::multipart::Form is not Clone — each attempt needs a fresh form.
    // mime_str("application/octet-stream") is infallible, so .expect() is safe.
    let audio_bytes = audio_data.to_vec();
    let filename_clone = filename.clone();
    let model_str = effective_model.to_string();

    let http_response = crate::http_retry::retry_reqwest("openai::transcribe", 3, || {
      let audio_bytes = audio_bytes.clone();
      let filename = filename_clone.clone();
      let model_str = model_str.clone();
      let url = url.clone();
      async move {
        let file_part = reqwest::multipart::Part::bytes(audio_bytes)
          .file_name(filename)
          .mime_str("application/octet-stream")
          .expect("application/octet-stream is a valid MIME type");
        let mut form = reqwest::multipart::Form::new()
          .part("file", file_part)
          .text("model", model_str)
          .text("response_format", "verbose_json");
        if let Some(language) = language.filter(|value| !value.trim().is_empty()) {
          form = form.text("language", language.to_string());
        }
        let mut request = self.client.post(&url);
        if !self.api_key.is_empty() {
          request = request.bearer_auth(&self.api_key);
        }
        request
          .multipart(form)
          .send()
          .await
          .map_err(reqwest::Error::without_url)
      }
    })
    .await
    .map_err(|e| {
      error!(provider = %self.id, error = %e, "transcription request failed");
      if e.is_timeout() {
        ProviderError::Timeout(e.to_string())
      } else {
        ProviderError::Unavailable(e.to_string())
      }
    })?;

    let status = http_response.status();
    let status_code = status.as_u16();

    if !status.is_success() {
      // Do not read error bodies: services may echo audio, transcript or credentials.
      error!(provider = %self.id, status_code, "transcription service returned an HTTP error");
      return Err(status_error(status_code));
    }

    let body = self.read_response(http_response, max_response_bytes).await?;
    let transcription: OpenAiTranscriptionResponse =
      serde_json::from_slice(&body).map_err(|_| ProviderError::Upstream("invalid response format".into()))?;
    let response = transcription.into_result()?;

    info!(
      provider = %self.id,
      model = %effective_model,
      text_len = response.text.len(),
      "transcription completed"
    );
    tracing::info!(
      provider = %self.id,
      model = %effective_model,
      latency_ms = %start.elapsed().as_millis(),
      "speech request completed"
    );

    Ok(response)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // Small HTTP fixtures inspect the actual multipart consumer. These exercise
  // transport contracts only; they do not stand in for real-audio recognition.
  async fn fixture(status: &str, headers: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let response = format!(
      "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
      body.len()
    );
    let task = tokio::spawn(async move {
      tokio::time::timeout(Duration::from_secs(5), async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
          let mut buffer = [0; 4096];
          let read = stream.read(&mut buffer).await.unwrap();
          assert!(read > 0);
          request.extend_from_slice(&buffer[..read]);
          let text = String::from_utf8_lossy(&request);
          if let Some(end) = text.find("\r\n\r\n") {
            let length: usize = text[..end]
              .lines()
              .find_map(|line| line.to_lowercase().strip_prefix("content-length: ").map(str::to_string))
              .unwrap_or_else(|| "0".to_string())
              .parse()
              .unwrap();
            if request.len() >= end + 4 + length {
              break;
            }
          }
          assert!(request.len() < 16384);
        }
        stream.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(request).unwrap()
      })
      .await
      .expect("bounded HTTP fixture")
    });
    (endpoint, task)
  }

  #[tokio::test]
  async fn connection_check_preserves_the_standard_tls_cause_without_destination_or_key() {
    let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let mut acceptor = openssl::ssl::SslAcceptor::mozilla_intermediate_v5(openssl::ssl::SslMethod::tls()).unwrap();
    acceptor
      .set_certificate(&openssl::x509::X509::from_der(&certificate.serialize_der().unwrap()).unwrap())
      .unwrap();
    acceptor
      .set_private_key(
        &openssl::pkey::PKey::private_key_from_pem(certificate.serialize_private_key_pem().as_bytes()).unwrap(),
      )
      .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("https://localhost:{}/v1", listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
      let (stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
      tokio::task::spawn_blocking(move || {
        let stream = stream.into_std().unwrap();
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
        // The client must reject the untrusted certificate before sending HTTP.
        assert!(acceptor.build().accept(stream).is_err());
      })
      .await
      .unwrap();
    });
    let transport = OpenAiTranscriptionTransport::new(
      endpoint.clone(),
      Some("protected-test-key".into()),
      Duration::from_secs(2),
      None,
    )
    .unwrap();
    let error = transport.check_connection("model", 1024).await.unwrap_err().to_string();
    server.await.unwrap();
    assert!(
      error.contains("InvalidCertificate") && error.contains("UnknownIssuer"),
      "{error}"
    );
    assert!(!error.contains(&endpoint));
    assert!(!error.contains("protected-test-key"));
    assert!(!error.contains("HTTP 401"));
    assert!(!error.contains("deadline exceeded"));
  }

  #[tokio::test]
  async fn error_bodies_and_invalid_json_are_not_exposed_and_responses_are_bounded() {
    for (status, body, limit, expected) in [
      ("401 Unauthorized", "protected-provider-body", 1024, "HTTP 401"),
      ("200 OK", "protected-invalid-json", 1024, "invalid response format"),
      (
        "200 OK",
        r#"{"text":"protected-long-transcript"}"#,
        8,
        "speech response exceeds the configured limit",
      ),
    ] {
      let (endpoint, task) = fixture(status, "", body).await;
      let transport = OpenAiTranscriptionTransport::new(
        endpoint.clone(),
        Some("protected-key".into()),
        Duration::from_secs(2),
        None,
      )
      .unwrap();
      let error = transport
        .transcribe(b"test-audio", "wav", "model", None, limit)
        .await
        .unwrap_err()
        .to_string();
      task.await.unwrap();
      assert!(error.contains(expected), "{error}");
      assert!(!error.contains("protected"));
      assert!(!error.contains(&endpoint));
    }
  }

  #[tokio::test]
  async fn request_failures_strip_the_destination_before_standard_retry_logging() {
    let (endpoint, task) = fixture("invalid-status", "", "").await;
    let transport = OpenAiTranscriptionTransport::new(
      endpoint.clone(),
      Some("protected-key".into()),
      Duration::from_secs(2),
      None,
    )
    .unwrap();
    let error = transport
      .transcribe(b"test-audio", "wav", "model", None, 1024)
      .await
      .unwrap_err()
      .to_string();
    task.await.unwrap();
    assert!(!error.contains(&endpoint));
    assert!(!error.contains("127.0.0.1"));
    assert!(!error.contains("protected"));
  }

  #[tokio::test]
  async fn redirect_never_forwards_the_protected_key() {
    let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let headers = format!("Location: http://{}/stolen\r\n", destination.local_addr().unwrap());
    let (endpoint, task) = fixture("307 Temporary Redirect", &headers, "protected-provider-body").await;
    let transport =
      OpenAiTranscriptionTransport::new(endpoint, Some("protected-key".into()), Duration::from_secs(2), None).unwrap();
    let error = transport
      .transcribe(b"test-audio", "wav", "model", None, 1024)
      .await
      .unwrap_err();
    task.await.unwrap();
    assert!(error.to_string().contains("HTTP 307"));
    assert!(
      tokio::time::timeout(Duration::from_millis(50), destination.accept())
        .await
        .is_err()
    );
  }

  // ── Transcription response deserialization tests ────────────────────────

  #[test]
  fn transcription_response_deserializes_verbose_json() {
    let json = r#"{
      "task": "transcribe",
      "language": "english",
      "duration": 12.34,
      "text": "Hello, this is a test transcription."
    }"#;
    let response: OpenAiTranscriptionResponse = serde_json::from_str(json).expect("deserialize");
    assert_eq!(response.text, "Hello, this is a test transcription.");
    assert_eq!(response.language.as_deref(), Some("english"));
    assert!((response.duration.unwrap() - 12.34).abs() < f64::EPSILON);
  }

  #[test]
  fn transcription_response_deserializes_minimal_json() {
    let json = r#"{"text": "Just the text."}"#;
    let response: OpenAiTranscriptionResponse = serde_json::from_str(json).expect("deserialize");
    assert_eq!(response.text, "Just the text.");
    assert!(response.language.is_none());
    assert!(response.duration.is_none());
  }

  #[test]
  fn transcription_response_deserializes_with_extra_fields() {
    // Unknown speakers must not discard timed segment text.
    let json = r#"{
      "task": "transcribe",
      "language": "de",
      "duration": 5.0,
      "text": "Hallo Welt",
      "segments": [{"id": 0, "start": 0.0, "end": 5.0, "text": "Hallo Welt"}]
    }"#;
    let response: OpenAiTranscriptionResponse = serde_json::from_str(json).expect("deserialize");
    assert_eq!(response.text, "Hallo Welt");
    assert_eq!(response.language.as_deref(), Some("de"));
  }
}
