// SPDX-License-Identifier: AGPL-3.0-or-later
//! Deterministic HTTPS fixture for GitLab token self-rotation.

#[allow(dead_code)]
#[path = "support/git_https_fixture.rs"]
mod git_https_fixture;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
  Arc, Mutex,
  atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use myoxus_application::git_sync::{
  EncryptedGitCredential, GitTokenCredential, GitTokenCredentialCodec, GitTokenRotationAdmission,
  GitTokenRotationConfiguration, GitTokenRotationProvider, GitTokenRotationProviderFailureKind,
  GitTokenRotationProviderKind, GitTokenRotationProviderRequest, GitTokenRotationService, GitTokenRotationState,
  GitTokenRotationStatus, GitTokenRotationStore, GitTokenRotationStoreError,
};
use myoxus_infrastructure::git_sync::{GitLabTokenRotationAdapter, GitSyncTokenCredentialCodec};
use myoxus_infrastructure::tls::ValidatedCaBundle;
use uuid::Uuid;

use git_https_fixture::TestAuthority;

struct AmbiguousCommitStore {
  admission: GitTokenRotationAdmission,
  status: Mutex<GitTokenRotationStatus>,
  installed: Mutex<Option<EncryptedGitCredential>>,
  install_calls: AtomicUsize,
}

impl AmbiguousCommitStore {
  fn new(admission: GitTokenRotationAdmission, now: DateTime<Utc>) -> Self {
    Self {
      status: Mutex::new(GitTokenRotationStatus {
        profile_id: admission.profile_id,
        provider: admission.provider,
        enabled: true,
        renew_before_days: 14,
        requested_lifetime_days: 90,
        state: GitTokenRotationState::Rotating,
        latest_attempt_id: Some(admission.attempt_id),
        admitted_credential_id: Some(admission.credential_id),
        current_credential_expires_at: Some(now + chrono::Duration::days(14)),
        last_attempt_at: Some(now),
        last_success_at: None,
        diagnosis: None,
        created_at: now,
        updated_at: now,
      }),
      admission,
      installed: Mutex::new(None),
      install_calls: AtomicUsize::new(0),
    }
  }

  fn transition(
    &self,
    attempt_id: Uuid,
    state: GitTokenRotationState,
    diagnosis: Option<&str>,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    let mut status = self.status.lock().expect("rotation status");
    if status.state != GitTokenRotationState::Rotating || status.latest_attempt_id != Some(attempt_id) {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    status.state = state;
    status.diagnosis = diagnosis.map(str::to_owned);
    status.updated_at = now;
    if state == GitTokenRotationState::Completed {
      status.last_success_at = Some(now);
    }
    Ok(status.clone())
  }
}

#[async_trait]
impl GitTokenRotationStore for AmbiguousCommitStore {
  async fn configure(
    &self,
    _profile_id: Uuid,
    _configuration: GitTokenRotationConfiguration,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    Err(GitTokenRotationStoreError::Conflict)
  }

  async fn status(&self, profile_id: Uuid) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationStoreError> {
    Ok((profile_id == self.admission.profile_id).then(|| self.status.lock().expect("rotation status").clone()))
  }

  async fn due_profile_ids(&self, _now: DateTime<Utc>, _limit: usize) -> Result<Vec<Uuid>, GitTokenRotationStoreError> {
    Ok(vec![self.admission.profile_id])
  }

  async fn admit(
    &self,
    _profile_id: Uuid,
    _now: DateTime<Utc>,
    _force: bool,
  ) -> Result<Option<GitTokenRotationAdmission>, GitTokenRotationStoreError> {
    Err(GitTokenRotationStoreError::Conflict)
  }

  async fn admitted(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
  ) -> Result<GitTokenRotationAdmission, GitTokenRotationStoreError> {
    let status = self.status.lock().expect("rotation status");
    if profile_id != self.admission.profile_id
      || attempt_id != self.admission.attempt_id
      || status.state != GitTokenRotationState::Rotating
    {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    Ok(self.admission.clone())
  }

  async fn record_pre_request_failure(
    &self,
    _profile_id: Uuid,
    attempt_id: Uuid,
    diagnosis: &str,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    self.transition(attempt_id, GitTokenRotationState::Failed, Some(diagnosis), now)
  }

  async fn record_manual_intervention(
    &self,
    _profile_id: Uuid,
    attempt_id: Uuid,
    diagnosis: &str,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    self.transition(
      attempt_id,
      GitTokenRotationState::ManualIntervention,
      Some(diagnosis),
      now,
    )
  }

  async fn install_replacement(
    &self,
    admission: &GitTokenRotationAdmission,
    replacement: &EncryptedGitCredential,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    assert_eq!(admission.attempt_id, self.admission.attempt_id);
    self.install_calls.fetch_add(1, Ordering::AcqRel);
    *self.installed.lock().expect("installed replacement") = Some(replacement.clone());
    self.transition(admission.attempt_id, GitTokenRotationState::Completed, None, now)?;
    Err(GitTokenRotationStoreError::Storage(
      "fixture lost commit acknowledgement".into(),
    ))
  }

  async fn completion_by_attempt(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
  ) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationStoreError> {
    let status = self.status.lock().expect("rotation status").clone();
    Ok(
      (profile_id == status.profile_id && attempt_id == status.latest_attempt_id.unwrap_or_default()).then_some(status),
    )
  }
}

#[derive(Clone)]
enum FixtureResponse {
  Static {
    status: &'static str,
    headers: Vec<(String, String)>,
    body: String,
  },
  CloseWithoutResponse,
}

#[derive(Debug)]
struct RecordedRequest {
  method: String,
  target: String,
  private_token_matches: bool,
  body: Vec<u8>,
}

struct RotationFixture {
  port: u16,
  stop: Arc<AtomicBool>,
  requests: Arc<Mutex<Vec<RecordedRequest>>>,
  thread: Option<JoinHandle<()>>,
}

impl RotationFixture {
  fn start(authority: &TestAuthority, expected_token: &str, response: FixtureResponse) -> Self {
    let acceptor = authority.tls_acceptor("localhost");
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind GitLab fixture");
    listener.set_nonblocking(true).expect("nonblocking GitLab fixture");
    let port = listener.local_addr().expect("GitLab fixture address").port();
    let stop = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let thread_stop = Arc::clone(&stop);
    let thread_requests = Arc::clone(&requests);
    let expected_token = expected_token.to_owned();
    let thread = std::thread::spawn(move || {
      while !thread_stop.load(Ordering::Acquire) {
        match listener.accept() {
          Ok((stream, _)) => {
            stream
              .set_read_timeout(Some(Duration::from_secs(5)))
              .expect("GitLab fixture read timeout");
            stream
              .set_write_timeout(Some(Duration::from_secs(5)))
              .expect("GitLab fixture write timeout");
            let Ok(mut stream) = acceptor.accept(stream) else {
              continue;
            };
            let request = read_request(&mut stream, &expected_token);
            thread_requests.lock().expect("GitLab fixture requests").push(request);
            match &response {
              FixtureResponse::Static { status, headers, body } => {
                let content_length = headers
                  .iter()
                  .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                  .map(|(_, value)| value.as_str())
                  .unwrap_or_else(|| "");
                let content_length = if content_length.is_empty() {
                  body.len().to_string()
                } else {
                  content_length.to_owned()
                };
                let mut response =
                  format!("HTTP/1.1 {status}\r\nContent-Length: {content_length}\r\nConnection: close\r\n");
                for (name, value) in headers {
                  if name.eq_ignore_ascii_case("content-length") {
                    continue;
                  }
                  response.push_str(&format!("{name}: {value}\r\n"));
                }
                response.push_str("\r\n");
                response.push_str(body);
                stream
                  .write_all(response.as_bytes())
                  .expect("write GitLab fixture response");
              }
              FixtureResponse::CloseWithoutResponse => {}
            }
          }
          Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            std::thread::sleep(Duration::from_millis(5));
          }
          Err(error) => panic!("GitLab fixture accept failed: {error}"),
        }
      }
    });
    Self {
      port,
      stop,
      requests,
      thread: Some(thread),
    }
  }

  fn repository_url(&self) -> String {
    format!("https://localhost:{}/group/sub/project.git", self.port)
  }

  fn endpoint_url(&self, path: &str) -> String {
    format!("https://localhost:{}{path}", self.port)
  }

  fn request_count(&self) -> usize {
    self.requests.lock().expect("GitLab fixture requests").len()
  }
}

impl Drop for RotationFixture {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::Release);
    let _ = TcpStream::connect(("127.0.0.1", self.port));
    if let Some(thread) = self.thread.take() {
      thread.join().expect("GitLab fixture thread");
    }
  }
}

fn read_request(stream: &mut openssl::ssl::SslStream<TcpStream>, expected_token: &str) -> RecordedRequest {
  let mut bytes = Vec::new();
  let header_end = loop {
    if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
      break position + 4;
    }
    let mut buffer = [0_u8; 4096];
    let read = stream.read(&mut buffer).expect("read GitLab fixture request");
    assert!(read > 0 && bytes.len() + read <= 64 * 1024, "bounded fixture request");
    bytes.extend_from_slice(&buffer[..read]);
  };
  let headers = std::str::from_utf8(&bytes[..header_end]).expect("UTF-8 fixture headers");
  let mut lines = headers.split("\r\n");
  let mut request_line = lines.next().expect("GitLab fixture request line").split_whitespace();
  let method = request_line.next().expect("request method").to_owned();
  let target = request_line.next().expect("request target").to_owned();
  let mut content_length = 0_usize;
  let mut private_token_matches = false;
  for line in lines.filter(|line| !line.is_empty()) {
    let (name, value) = line.split_once(':').expect("valid fixture header");
    if name.eq_ignore_ascii_case("content-length") {
      content_length = value.trim().parse().expect("fixture content length");
    } else if name.eq_ignore_ascii_case("private-token") {
      private_token_matches = value.trim() == expected_token;
    }
  }
  while bytes.len() < header_end + content_length {
    let mut buffer = [0_u8; 4096];
    let read = stream.read(&mut buffer).expect("read GitLab fixture body");
    assert!(
      read > 0 && bytes.len() + read <= 64 * 1024,
      "bounded fixture request body"
    );
    bytes.extend_from_slice(&buffer[..read]);
  }
  RecordedRequest {
    method,
    target,
    private_token_matches,
    body: bytes[header_end..header_end + content_length].to_vec(),
  }
}

fn bundle(authority: &TestAuthority) -> (tempfile::TempDir, ValidatedCaBundle) {
  let root = tempfile::tempdir().expect("GitLab CA root");
  let path = root.path().join("gitlab-ca.pem");
  std::fs::write(&path, authority.pem()).expect("write GitLab CA bundle");
  let bundle = myoxus_infrastructure::tls::load_bundle(root.path(), "gitlab-ca.pem")
    .expect("validate GitLab CA")
    .expect("configured bundle");
  (root, bundle)
}

fn request(repository_url: String) -> GitTokenRotationProviderRequest {
  GitTokenRotationProviderRequest {
    profile_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    repository_url,
    credential: GitTokenCredential {
      username: None,
      token: "current-project-token".into(),
    },
    requested_expires_at: Utc.with_ymd_and_hms(2035, 4, 15, 12, 0, 0).unwrap(),
  }
}

async fn build_admission(
  codec: &GitSyncTokenCredentialCodec,
  repository_url: String,
  now: DateTime<Utc>,
) -> GitTokenRotationAdmission {
  let credential = codec
    .encrypt_https_token(
      &GitTokenCredential {
        username: Some("gitlab-project-token".into()),
        token: "service-current-token".into(),
      },
      "project-token",
      now + chrono::Duration::days(14),
    )
    .await
    .expect("encrypt fixture credential");
  GitTokenRotationAdmission {
    profile_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    repository_url,
    provider: GitTokenRotationProviderKind::GitLab,
    attempt_id: Uuid::new_v4(),
    credential_id: Uuid::new_v4(),
    credential_label: credential.label,
    encrypted_credential: credential.ciphertext,
    requested_expires_at: Utc.with_ymd_and_hms(2035, 4, 15, 12, 0, 0).unwrap(),
  }
}

#[tokio::test]
async fn gitlab_self_rotation_is_one_strict_bounded_request_with_terminal_unknown_outcomes() {
  // This standalone integration binary does not execute the API/CLI startup
  // path that installs the shared rustls provider before creating reqwest.
  myoxus_infrastructure::tls::initialize_crypto_provider();
  let authority = TestAuthority::root("GitLab rotation test root");
  let (_bundle_root, ca_bundle) = bundle(&authority);
  let success = RotationFixture::start(
    &authority,
    "current-project-token",
    FixtureResponse::Static {
      status: "200 OK",
      headers: vec![("Content-Type".into(), "application/json".into())],
      body:
        r#"{"id":42,"scopes":["api"],"access_level":40,"token":"replacement-project-token","expires_at":"2035-04-15"}"#
          .into(),
    },
  );
  let adapter =
    GitLabTokenRotationAdapter::new(Duration::from_secs(5), Some(&ca_bundle)).expect("GitLab rotation adapter");
  let result = adapter
    .rotate(request(success.repository_url()))
    .await
    .expect("self-rotate project token");
  assert_eq!(result.replacement_token, "replacement-project-token");
  assert_eq!(result.expires_at, Utc.with_ymd_and_hms(2035, 4, 15, 0, 0, 0).unwrap());
  let requests = success.requests.lock().expect("success requests");
  assert_eq!(requests.len(), 1, "the adapter sends no probe or permission request");
  assert_eq!(requests[0].method, "POST");
  assert_eq!(
    requests[0].target,
    "/api/v4/projects/group%2Fsub%2Fproject/access_tokens/self/rotate"
  );
  assert!(requests[0].private_token_matches);
  assert_eq!(requests[0].body, b"expires_at=2035-04-15");
  drop(requests);

  let rejected = RotationFixture::start(
    &authority,
    "current-project-token",
    FixtureResponse::Static {
      status: "403 Forbidden",
      headers: Vec::new(),
      body: "provider detail must not escape".into(),
    },
  );
  let error = adapter
    .rotate(request(rejected.repository_url()))
    .await
    .expect_err("explicit rejection is terminal");
  assert_eq!(error.kind, GitTokenRotationProviderFailureKind::ManualIntervention);
  assert!(!error.diagnosis.contains("provider detail"));

  let unknown = RotationFixture::start(
    &authority,
    "current-project-token",
    FixtureResponse::CloseWithoutResponse,
  );
  let error = adapter
    .rotate(request(unknown.repository_url()))
    .await
    .expect_err("response loss is an unknown outcome");
  assert_eq!(error.kind, GitTokenRotationProviderFailureKind::ManualIntervention);

  let oversized = RotationFixture::start(
    &authority,
    "current-project-token",
    FixtureResponse::Static {
      status: "200 OK",
      headers: vec![("Content-Length".into(), (70 * 1024).to_string())],
      body: "{}".into(),
    },
  );
  let error = adapter
    .rotate(request(oversized.repository_url()))
    .await
    .expect_err("oversized success response is terminal");
  assert_eq!(error.kind, GitTokenRotationProviderFailureKind::ManualIntervention);

  let redirect_target = RotationFixture::start(
    &authority,
    "current-project-token",
    FixtureResponse::Static {
      status: "200 OK",
      headers: Vec::new(),
      body: "{}".into(),
    },
  );
  let redirect = RotationFixture::start(
    &authority,
    "current-project-token",
    FixtureResponse::Static {
      status: "302 Found",
      headers: vec![(
        "Location".into(),
        redirect_target.endpoint_url("/must-not-receive-token"),
      )],
      body: String::new(),
    },
  );
  let error = adapter
    .rotate(request(redirect.repository_url()))
    .await
    .expect_err("redirect is never followed");
  assert_eq!(error.kind, GitTokenRotationProviderFailureKind::ManualIntervention);
  assert_eq!(redirect.request_count(), 1);
  assert_eq!(
    redirect_target.request_count(),
    0,
    "redirect target must receive no request"
  );

  let untrusted = RotationFixture::start(
    &authority,
    "current-project-token",
    FixtureResponse::Static {
      status: "200 OK",
      headers: Vec::new(),
      body: "{}".into(),
    },
  );
  let system_roots_only =
    GitLabTokenRotationAdapter::new(Duration::from_secs(5), None).expect("system-roots-only adapter");
  let error = system_roots_only
    .rotate(request(untrusted.repository_url()))
    .await
    .expect_err("private fixture CA must not be trusted implicitly");
  assert_eq!(error.kind, GitTokenRotationProviderFailureKind::BeforeRequest);
  assert_eq!(
    untrusted.request_count(),
    0,
    "TLS failure occurs before HTTP transmission"
  );

  let service_success = RotationFixture::start(
    &authority,
    "service-current-token",
    FixtureResponse::Static {
      status: "200 OK",
      headers: vec![("Content-Type".into(), "application/json".into())],
      body: r#"{"token":"service-replacement-token","expires_at":"2035-04-15"}"#.into(),
    },
  );
  let now = Utc.with_ymd_and_hms(2035, 1, 1, 0, 0, 0).unwrap();
  let codec = Arc::new(GitSyncTokenCredentialCodec::new("rotation-service-fixture-key"));
  let admission = build_admission(codec.as_ref(), service_success.repository_url(), now).await;
  let store = Arc::new(AmbiguousCommitStore::new(admission.clone(), now));
  let service = GitTokenRotationService::new(store.clone(), codec.clone(), vec![Arc::new(adapter.clone())]);
  let completed = service
    .execute_attempt(admission.profile_id, admission.attempt_id, now)
    .await
    .expect("lost SQL acknowledgement is resolved by the durable completed state");
  assert_eq!(completed.state, GitTokenRotationState::Completed);
  assert_eq!(
    service_success.request_count(),
    1,
    "SQL ambiguity must not resend to GitLab"
  );
  assert_eq!(store.install_calls.load(Ordering::Acquire), 1);
  let installed = store
    .installed
    .lock()
    .expect("installed replacement")
    .clone()
    .expect("replacement was installed");
  let decoded = codec
    .decrypt_https_token(&installed.ciphertext)
    .await
    .expect("decrypt installed replacement");
  assert_eq!(decoded.username.as_deref(), Some("gitlab-project-token"));
  assert_eq!(decoded.token, "service-replacement-token");
  assert!(!format!("{installed:?}{completed:?}{admission:?}").contains("service-replacement-token"));

  let process_loss_admission = build_admission(codec.as_ref(), service_success.repository_url(), now).await;
  let process_loss_store = Arc::new(AmbiguousCommitStore::new(process_loss_admission.clone(), now));
  let process_loss_service = GitTokenRotationService::new(process_loss_store, codec, vec![Arc::new(adapter.clone())]);
  let process_loss = process_loss_service
    .mark_process_loss(
      process_loss_admission.profile_id,
      process_loss_admission.attempt_id,
      now + chrono::Duration::seconds(1),
    )
    .await
    .expect("redelivery closes the stale admitted attempt");
  assert_eq!(process_loss.state, GitTokenRotationState::ManualIntervention);
  assert_eq!(
    service_success.request_count(),
    1,
    "process-loss classification must not call the provider"
  );
}
