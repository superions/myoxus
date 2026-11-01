// SPDX-License-Identifier: AGPL-3.0-or-later

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
  Arc,
  atomic::{AtomicBool, AtomicU32, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine;
use openssl::asn1::{Asn1Integer, Asn1Time};
use openssl::bn::BigNum;
use openssl::ec::{EcGroup, EcKey};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{PKey, Private};
use openssl::ssl::{SslAcceptor, SslMethod};
use openssl::x509::extension::{
  AuthorityKeyIdentifier, BasicConstraints, ExtendedKeyUsage, KeyUsage, SubjectAlternativeName, SubjectKeyIdentifier,
};
use openssl::x509::{X509, X509Builder, X509Name, X509NameBuilder};
use tempfile::TempDir;

static SERIAL: AtomicU32 = AtomicU32::new(1);

pub struct TestAuthority {
  certificate: X509,
  key: PKey<Private>,
}

impl TestAuthority {
  pub fn root(common_name: &str) -> Self {
    let key = generate_key();
    let name = certificate_name(common_name);
    let certificate = build_ca_certificate(&name, &key, &name, &key);
    Self { certificate, key }
  }

  pub fn intermediate(&self, common_name: &str) -> Self {
    let key = generate_key();
    let name = certificate_name(common_name);
    let certificate = build_ca_certificate(&name, &key, self.certificate.subject_name(), &self.key);
    Self { certificate, key }
  }

  pub fn pem(&self) -> Vec<u8> {
    self.certificate.to_pem().expect("serialize test CA")
  }

  pub fn server_certificate(&self, dns_name: &str, expired: bool) -> (X509, PKey<Private>) {
    let key = generate_key();
    let name = certificate_name(dns_name);
    let mut certificate = X509Builder::new().expect("server certificate builder");
    set_common_certificate_fields(&mut certificate, &name, &key, self.certificate.subject_name(), expired);
    certificate
      .append_extension(
        BasicConstraints::new()
          .critical()
          .build()
          .expect("server basic constraints"),
      )
      .expect("append server basic constraints");
    certificate
      .append_extension(
        KeyUsage::new()
          .critical()
          .digital_signature()
          .key_encipherment()
          .build()
          .expect("server key usage"),
      )
      .expect("append server key usage");
    certificate
      .append_extension(
        ExtendedKeyUsage::new()
          .server_auth()
          .build()
          .expect("server extended key usage"),
      )
      .expect("append server extended key usage");
    let context = certificate.x509v3_context(Some(&self.certificate), None);
    let mut subject_alt_name = SubjectAlternativeName::new();
    if dns_name.parse::<std::net::IpAddr>().is_ok() {
      subject_alt_name.ip(dns_name);
    } else {
      subject_alt_name.dns(dns_name);
    }
    certificate
      .append_extension(
        subject_alt_name
          .build(&context)
          .expect("server subject alternative name"),
      )
      .expect("append server subject alternative name");
    let context = certificate.x509v3_context(Some(&self.certificate), None);
    certificate
      .append_extension(
        AuthorityKeyIdentifier::new()
          .keyid(true)
          .issuer(true)
          .build(&context)
          .expect("server authority key identifier"),
      )
      .expect("append server authority key identifier");
    certificate
      .sign(&self.key, MessageDigest::sha256())
      .expect("sign server certificate");
    (certificate.build(), key)
  }

  pub fn tls_acceptor(&self, dns_name: &str) -> SslAcceptor {
    let (certificate, key) = self.server_certificate(dns_name, false);
    let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls()).expect("TLS acceptor");
    acceptor.set_private_key(&key).expect("TLS private key");
    acceptor.set_certificate(&certificate).expect("TLS certificate");
    acceptor.check_private_key().expect("TLS key matches certificate");
    acceptor.build()
  }
}

pub struct GitHttpsFixture {
  _root: TempDir,
  url: String,
  stop: Arc<AtomicBool>,
  port: u16,
  credentialed_requests: Arc<AtomicU32>,
  thread: Option<JoinHandle<()>>,
}

#[derive(Clone)]
enum GitHttpsResponse {
  Backend { expected_authorization: Option<String> },
  Redirect { target_base: String },
}

impl GitHttpsFixture {
  pub fn start(issuer: &TestAuthority, dns_name: &str, expired: bool, extra_chain: Option<&TestAuthority>) -> Self {
    Self::start_internal(
      issuer,
      dns_name,
      "localhost",
      expired,
      extra_chain,
      GitHttpsResponse::Backend {
        expected_authorization: None,
      },
    )
  }

  pub fn start_authenticated(issuer: &TestAuthority, host: &str, username: &str, password: &str) -> Self {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
    Self::start_internal(
      issuer,
      host,
      host,
      false,
      None,
      GitHttpsResponse::Backend {
        expected_authorization: Some(format!("Basic {encoded}")),
      },
    )
  }

  pub fn start_redirect(issuer: &TestAuthority, target_base: &str) -> Self {
    Self::start_internal(
      issuer,
      "localhost",
      "localhost",
      false,
      None,
      GitHttpsResponse::Redirect {
        target_base: target_base.to_string(),
      },
    )
  }

  fn start_internal(
    issuer: &TestAuthority,
    dns_name: &str,
    url_host: &str,
    expired: bool,
    extra_chain: Option<&TestAuthority>,
    response: GitHttpsResponse,
  ) -> Self {
    let root = tempfile::tempdir().expect("HTTPS Git fixture root");
    let bare = root.path().join("repo.git");
    init_bare_repository(&bare);
    let (certificate, key) = issuer.server_certificate(dns_name, expired);
    assert!(
      certificate.verify(&issuer.key).expect("verify fixture leaf signature"),
      "fixture leaf signature must match its issuer"
    );
    assert_eq!(
      issuer.certificate.issued(&certificate),
      openssl::x509::X509VerifyResult::OK,
      "fixture issuer must be accepted as a CA for its leaf"
    );
    let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls()).expect("TLS acceptor");
    acceptor.set_private_key(&key).expect("TLS private key");
    acceptor.set_certificate(&certificate).expect("TLS certificate");
    if let Some(intermediate) = extra_chain {
      acceptor
        .add_extra_chain_cert(intermediate.certificate.clone())
        .expect("TLS intermediate chain");
    }
    acceptor.check_private_key().expect("TLS key matches certificate");
    let acceptor = acceptor.build();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind HTTPS Git fixture");
    listener.set_nonblocking(true).expect("nonblocking HTTPS fixture");
    let port = listener.local_addr().expect("HTTPS fixture address").port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let credentialed_requests = Arc::new(AtomicU32::new(0));
    let credentialed_requests_for_thread = Arc::clone(&credentialed_requests);
    let project_root = root.path().to_path_buf();
    let thread = std::thread::spawn(move || {
      serve_git_https(
        listener,
        acceptor,
        project_root,
        response,
        credentialed_requests_for_thread,
        stop_for_thread,
      )
    });
    Self {
      _root: root,
      url: format!("https://{url_host}:{port}/repo.git"),
      stop,
      port,
      credentialed_requests,
      thread: Some(thread),
    }
  }

  pub fn url(&self) -> &str {
    &self.url
  }

  pub fn credentialed_requests(&self) -> u32 {
    self.credentialed_requests.load(Ordering::Acquire)
  }
}

impl Drop for GitHttpsFixture {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::Release);
    let _ = TcpStream::connect(("127.0.0.1", self.port));
    if let Some(thread) = self.thread.take() {
      thread.join().expect("HTTPS Git fixture thread");
    }
  }
}

fn generate_key() -> PKey<Private> {
  let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).expect("test EC curve");
  PKey::from_ec_key(EcKey::generate(&group).expect("test EC key")).expect("test private key")
}

fn certificate_name(common_name: &str) -> X509Name {
  let mut name = X509NameBuilder::new().expect("certificate name");
  name.append_entry_by_text("CN", common_name).expect("certificate CN");
  name.build()
}

fn next_serial() -> Asn1Integer {
  Asn1Integer::from_bn(&BigNum::from_u32(SERIAL.fetch_add(1, Ordering::Relaxed)).expect("certificate serial"))
    .expect("ASN.1 certificate serial")
}

fn set_common_certificate_fields(
  certificate: &mut X509Builder,
  subject: &X509Name,
  key: &PKey<Private>,
  issuer: &openssl::x509::X509NameRef,
  expired: bool,
) {
  certificate.set_version(2).expect("certificate version");
  certificate
    .set_serial_number(&next_serial())
    .expect("certificate serial");
  certificate.set_subject_name(subject).expect("certificate subject");
  certificate.set_issuer_name(issuer).expect("certificate issuer");
  certificate.set_pubkey(key).expect("certificate public key");
  let now = chrono::Utc::now().timestamp();
  let not_before = if expired { now - 7200 } else { now - 60 };
  let not_after = if expired { now - 3600 } else { now + 3600 };
  certificate
    .set_not_before(
      Asn1Time::from_unix(not_before)
        .expect("certificate not-before")
        .as_ref(),
    )
    .expect("set certificate not-before");
  certificate
    .set_not_after(Asn1Time::from_unix(not_after).expect("certificate not-after").as_ref())
    .expect("set certificate not-after");
}

fn build_ca_certificate(
  subject: &X509Name,
  key: &PKey<Private>,
  issuer: &openssl::x509::X509NameRef,
  issuer_key: &PKey<Private>,
) -> X509 {
  let mut certificate = X509Builder::new().expect("CA certificate builder");
  set_common_certificate_fields(&mut certificate, subject, key, issuer, false);
  certificate
    .append_extension(
      BasicConstraints::new()
        .critical()
        .ca()
        .build()
        .expect("CA basic constraints"),
    )
    .expect("append CA basic constraints");
  certificate
    .append_extension(
      KeyUsage::new()
        .critical()
        .key_cert_sign()
        .crl_sign()
        .build()
        .expect("CA key usage"),
    )
    .expect("append CA key usage");
  let context = certificate.x509v3_context(None, None);
  certificate
    .append_extension(
      SubjectKeyIdentifier::new()
        .build(&context)
        .expect("CA subject key identifier"),
    )
    .expect("append CA subject key identifier");
  certificate
    .sign(issuer_key, MessageDigest::sha256())
    .expect("sign CA certificate");
  certificate.build()
}

fn init_bare_repository(bare: &Path) {
  let seed = tempfile::tempdir().expect("Git seed repository");
  git(seed.path(), &["init", "--initial-branch=main"]);
  git(seed.path(), &["config", "user.email", "git-https-fixture@example.test"]);
  git(seed.path(), &["config", "user.name", "Git HTTPS fixture"]);
  std::fs::write(seed.path().join("README.md"), "# HTTPS Git fixture\n").expect("seed fixture file");
  git(seed.path(), &["add", "."]);
  git(seed.path(), &["commit", "-m", "Initial fixture"]);
  let bare_text = bare.to_str().expect("UTF-8 fixture path");
  git(seed.path(), &["init", "--bare", "--initial-branch=main", bare_text]);
  git(bare, &["config", "http.receivepack", "true"]);
  git(seed.path(), &["remote", "add", "origin", bare_text]);
  git(seed.path(), &["push", "origin", "main"]);
}

fn git(directory: &Path, arguments: &[&str]) {
  let output = Command::new("git")
    .args(arguments)
    .current_dir(directory)
    .env("GIT_TERMINAL_PROMPT", "0")
    .output()
    .expect("run fixture git");
  assert!(
    output.status.success(),
    "git {} failed in {}: {}",
    arguments.join(" "),
    directory.display(),
    String::from_utf8_lossy(&output.stderr)
  );
}

fn serve_git_https(
  listener: TcpListener,
  acceptor: SslAcceptor,
  project_root: PathBuf,
  response: GitHttpsResponse,
  credentialed_requests: Arc<AtomicU32>,
  stop: Arc<AtomicBool>,
) {
  while !stop.load(Ordering::Acquire) {
    match listener.accept() {
      Ok((stream, _)) => {
        stream
          .set_read_timeout(Some(Duration::from_secs(10)))
          .expect("HTTPS fixture read timeout");
        stream
          .set_write_timeout(Some(Duration::from_secs(10)))
          .expect("HTTPS fixture write timeout");
        let Ok(mut stream) = acceptor.accept(stream) else {
          continue;
        };
        if let Err(error) = handle_git_http_request(&mut stream, &project_root, &response, &credentialed_requests) {
          let body = format!("Git HTTPS fixture error: {error}");
          let response = format!(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
          );
          let _ = stream.write_all(response.as_bytes());
        }
      }
      Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
        std::thread::sleep(Duration::from_millis(5));
      }
      Err(error) => panic!("HTTPS Git fixture accept failed: {error}"),
    }
  }
}

fn handle_git_http_request(
  stream: &mut openssl::ssl::SslStream<TcpStream>,
  project_root: &Path,
  response: &GitHttpsResponse,
  credentialed_requests: &AtomicU32,
) -> Result<(), String> {
  let mut request = Vec::new();
  let header_end = loop {
    if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
      break position + 4;
    }
    let mut buffer = [0_u8; 8192];
    let read = stream
      .read(&mut buffer)
      .map_err(|error| format!("read request: {error}"))?;
    if read == 0 || request.len() + read > 16 * 1024 * 1024 {
      return Err("invalid or oversized HTTP request".to_string());
    }
    request.extend_from_slice(&buffer[..read]);
  };
  let (method, target, content_type, content_length, chunked, authorization) = {
    let headers = std::str::from_utf8(&request[..header_end]).map_err(|_| "request headers are not UTF-8")?;
    let mut lines = headers.split("\r\n");
    let request_line = lines.next().ok_or("missing request line")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().ok_or("missing request method")?.to_string();
    let target = request_parts.next().ok_or("missing request target")?.to_string();
    let mut content_type = String::new();
    let mut content_length = 0_usize;
    let mut chunked = false;
    let mut authorization = None;
    for line in lines.filter(|line| !line.is_empty()) {
      let Some((name, value)) = line.split_once(':') else {
        return Err("malformed request header".to_string());
      };
      if name.eq_ignore_ascii_case("content-type") {
        content_type = value.trim().to_string();
      } else if name.eq_ignore_ascii_case("content-length") {
        content_length = value
          .trim()
          .parse()
          .map_err(|_| "invalid request content length".to_string())?;
      } else if name.eq_ignore_ascii_case("transfer-encoding") {
        chunked = value
          .split(',')
          .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
      } else if name.eq_ignore_ascii_case("authorization") {
        authorization = Some(value.trim().to_string());
      }
    }
    (method, target, content_type, content_length, chunked, authorization)
  };
  let body = if chunked {
    loop {
      if let Some(body) = decode_chunked_body(&request[header_end..])? {
        break body;
      }
      let mut buffer = [0_u8; 8192];
      let read = stream
        .read(&mut buffer)
        .map_err(|error| format!("read chunked request body: {error}"))?;
      if read == 0 {
        return Err("truncated chunked request body".to_string());
      }
      request.extend_from_slice(&buffer[..read]);
    }
  } else {
    while request.len() < header_end + content_length {
      let mut buffer = [0_u8; 8192];
      let read = stream
        .read(&mut buffer)
        .map_err(|error| format!("read request body: {error}"))?;
      if read == 0 {
        return Err("truncated request body".to_string());
      }
      request.extend_from_slice(&buffer[..read]);
    }
    request[header_end..header_end + content_length].to_vec()
  };
  if authorization.is_some() {
    credentialed_requests.fetch_add(1, Ordering::AcqRel);
  }
  match response {
    GitHttpsResponse::Redirect { target_base } => {
      let suffix = target.strip_prefix("/repo.git").unwrap_or(target.as_str());
      let location = format!("{target_base}{suffix}");
      write!(
        stream,
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      )
      .map_err(|error| format!("write redirect response: {error}"))?;
      return stream
        .flush()
        .map_err(|error| format!("flush redirect response: {error}"));
    }
    GitHttpsResponse::Backend {
      expected_authorization: Some(expected),
    } if authorization.as_deref() != Some(expected.as_str()) => {
      write!(
        stream,
        "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Git HTTPS fixture\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      )
      .map_err(|error| format!("write authentication challenge: {error}"))?;
      return stream
        .flush()
        .map_err(|error| format!("flush authentication challenge: {error}"));
    }
    GitHttpsResponse::Backend { .. } => {}
  }
  let content_length = body.len();
  let (path, query) = target.split_once('?').unwrap_or((&target, ""));
  let mut child = Command::new("git")
    .arg("http-backend")
    .env("GIT_PROJECT_ROOT", project_root)
    .env("GIT_HTTP_EXPORT_ALL", "1")
    .env("REQUEST_METHOD", &method)
    .env("PATH_INFO", path)
    .env("QUERY_STRING", query)
    .env("CONTENT_TYPE", &content_type)
    .env("CONTENT_LENGTH", content_length.to_string())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| format!("start git http-backend: {error}"))?;
  child
    .stdin
    .as_mut()
    .ok_or("git http-backend stdin unavailable")?
    .write_all(&body)
    .map_err(|error| format!("write git http-backend request: {error}"))?;
  let output = child
    .wait_with_output()
    .map_err(|error| format!("wait for git http-backend: {error}"))?;
  if !output.status.success() {
    return Err(format!(
      "git http-backend failed: {}",
      String::from_utf8_lossy(&output.stderr)
    ));
  }
  let cgi_header_end = output
    .stdout
    .windows(4)
    .position(|window| window == b"\r\n\r\n")
    .map(|position| position + 4)
    .ok_or("git http-backend returned no header boundary")?;
  let cgi_headers = std::str::from_utf8(&output.stdout[..cgi_header_end]).map_err(|_| "CGI headers are not UTF-8")?;
  let mut status = "200 OK";
  let mut forwarded = String::new();
  for line in cgi_headers.split("\r\n").filter(|line| !line.is_empty()) {
    if let Some(value) = line.strip_prefix("Status: ") {
      status = value;
    } else if !line.to_ascii_lowercase().starts_with("content-length:") {
      forwarded.push_str(line);
      forwarded.push_str("\r\n");
    }
  }
  let body = &output.stdout[cgi_header_end..];
  write!(
    stream,
    "HTTP/1.1 {status}\r\n{forwarded}Content-Length: {}\r\nConnection: close\r\n\r\n",
    body.len()
  )
  .map_err(|error| format!("write response headers: {error}"))?;
  stream
    .write_all(body)
    .map_err(|error| format!("write response body: {error}"))?;
  stream.flush().map_err(|error| format!("flush response: {error}"))
}

fn decode_chunked_body(encoded: &[u8]) -> Result<Option<Vec<u8>>, String> {
  let mut cursor = 0_usize;
  let mut decoded = Vec::new();
  loop {
    let Some(line_end) = encoded[cursor..]
      .windows(2)
      .position(|window| window == b"\r\n")
      .map(|position| cursor + position)
    else {
      return Ok(None);
    };
    let size_text =
      std::str::from_utf8(&encoded[cursor..line_end]).map_err(|_| "chunk size is not ASCII".to_string())?;
    let size = usize::from_str_radix(size_text.split(';').next().unwrap_or_default().trim(), 16)
      .map_err(|_| "invalid chunk size".to_string())?;
    cursor = line_end + 2;
    if size == 0 {
      return if encoded.len() >= cursor + 2 {
        Ok(Some(decoded))
      } else {
        Ok(None)
      };
    }
    if encoded.len() < cursor + size + 2 {
      return Ok(None);
    }
    decoded.extend_from_slice(&encoded[cursor..cursor + size]);
    cursor += size;
    if &encoded[cursor..cursor + 2] != b"\r\n" {
      return Err("chunk payload is not CRLF-terminated".to_string());
    }
    cursor += 2;
  }
}
