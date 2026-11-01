//! Deterministic local SMTP fixture shared by mail infrastructure and API tests.
//!
//! The fixture exercises actual TCP and TLS protocol transitions. It does not
//! accept external connections, persist messages, or use operator data.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rcgen::generate_simple_self_signed;
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::{
  io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
  net::{TcpListener, TcpStream},
  sync::{Mutex, mpsc, oneshot},
  task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpFixtureTransport {
  Plain,
  Starttls,
  ImplicitTls,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpFixtureAuth {
  None,
  Accept,
  Reject,
}

#[derive(Clone, Copy, Debug)]
pub struct SmtpFixtureOptions {
  pub transport: SmtpFixtureTransport,
  pub advertise_starttls: bool,
  pub auth: SmtpFixtureAuth,
}

impl SmtpFixtureOptions {
  pub const fn plain(auth: SmtpFixtureAuth) -> Self {
    Self {
      transport: SmtpFixtureTransport::Plain,
      advertise_starttls: false,
      auth,
    }
  }

  pub const fn starttls(auth: SmtpFixtureAuth) -> Self {
    Self {
      transport: SmtpFixtureTransport::Starttls,
      advertise_starttls: true,
      auth,
    }
  }

  pub const fn implicit_tls(auth: SmtpFixtureAuth) -> Self {
    Self {
      transport: SmtpFixtureTransport::ImplicitTls,
      advertise_starttls: false,
      auth,
    }
  }
}

struct DeliveryControl {
  paused: AtomicBool,
  reached: mpsc::UnboundedSender<oneshot::Sender<bool>>,
}

pub struct SmtpFixture {
  port: u16,
  certificate_der: Vec<u8>,
  messages: Arc<Mutex<Vec<String>>>,
  auth_attempts: Arc<Mutex<usize>>,
  task: JoinHandle<()>,
  delivery_control: Arc<DeliveryControl>,
  paused_deliveries: Mutex<mpsc::UnboundedReceiver<oneshot::Sender<bool>>>,
}

impl SmtpFixture {
  pub async fn start(options: SmtpFixtureOptions) -> Self {
    // The server standardises TLS consumers on Ring. Installing the provider
    // explicitly keeps this standalone fixture deterministic even when no API
    // bootstrap has run in the test process. A prior Ring installation by
    // another fixture in the same process is an expected no-op.
    drop(rustls::crypto::ring::default_provider().install_default());
    let certificate =
      generate_simple_self_signed(vec!["localhost".to_string()]).expect("generate local SMTP fixture certificate");
    let certificate_der = certificate
      .serialize_der()
      .expect("serialize local SMTP fixture certificate");
    let private_key_der = certificate.serialize_private_key_der();
    let tls_config = ServerConfig::builder()
      .with_no_client_auth()
      .with_single_cert(
        vec![CertificateDer::from(certificate_der.clone())],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(private_key_der)),
      )
      .expect("build local SMTP fixture TLS config");
    let acceptor = TlsAcceptor::from(Arc::new(tls_config));
    let listener = TcpListener::bind(("127.0.0.1", 0))
      .await
      .expect("bind local SMTP fixture");
    let port = listener.local_addr().expect("SMTP fixture address").port();
    let messages = Arc::new(Mutex::new(Vec::new()));
    let auth_attempts = Arc::new(Mutex::new(0));
    let (reached, paused_deliveries) = mpsc::unbounded_channel();
    let delivery_control = Arc::new(DeliveryControl {
      paused: AtomicBool::new(false),
      reached,
    });
    let task_delivery_control = delivery_control.clone();
    let task_messages = messages.clone();
    let task_auth_attempts = auth_attempts.clone();
    let task = tokio::spawn(async move {
      // Aborting the listener drops this set and cancels every session, including
      // sessions paused before SMTP acceptance by a lifecycle test.
      let mut sessions = tokio::task::JoinSet::new();
      loop {
        let Ok((socket, _)) = listener.accept().await else {
          break;
        };
        let acceptor = acceptor.clone();
        let messages = task_messages.clone();
        let auth_attempts = task_auth_attempts.clone();
        let delivery_control = task_delivery_control.clone();
        sessions.spawn(async move {
          let result = match options.transport {
            SmtpFixtureTransport::ImplicitTls => match acceptor.accept(socket).await {
              Ok(stream) => smtp_session(stream, options.auth, messages, auth_attempts, delivery_control).await,
              Err(_) => Ok(()),
            },
            SmtpFixtureTransport::Starttls => {
              starttls_session(socket, acceptor, options, messages, auth_attempts, delivery_control).await
            }
            SmtpFixtureTransport::Plain => {
              smtp_session(socket, options.auth, messages, auth_attempts, delivery_control).await
            }
          };
          let _ = result;
        });
      }
    });

    Self {
      port,
      certificate_der,
      messages,
      auth_attempts,
      task,
      delivery_control,
      paused_deliveries: Mutex::new(paused_deliveries),
    }
  }

  /// Pause each DATA acceptance until the consuming test accepts/rejects it.
  pub fn pause_deliveries(&self) {
    self.delivery_control.paused.store(true, Ordering::SeqCst);
  }

  /// The DATA body is already captured; true accepts it with 250, false rejects
  /// it with 550. Its final SMTP response is still pending. Dropping
  /// this sender abandons that session; fixture drop also cancels paused sessions.
  pub async fn next_paused_delivery(&self) -> oneshot::Sender<bool> {
    self
      .paused_deliveries
      .lock()
      .await
      .recv()
      .await
      .expect("SMTP listener owns pause channel")
  }

  pub const fn host(&self) -> &'static str {
    "localhost"
  }

  pub fn port(&self) -> u16 {
    self.port
  }

  pub fn certificate_der(&self) -> &[u8] {
    &self.certificate_der
  }

  /// Captured DATA attempts, including bodies later rejected or interrupted.
  /// SMTP acceptance and persisted receipts, not this count, prove completion.
  pub async fn messages(&self) -> Vec<String> {
    self.messages.lock().await.clone()
  }

  pub async fn auth_attempts(&self) -> usize {
    *self.auth_attempts.lock().await
  }
}

impl Drop for SmtpFixture {
  fn drop(&mut self) {
    self.task.abort();
  }
}

async fn starttls_session(
  socket: TcpStream,
  acceptor: TlsAcceptor,
  options: SmtpFixtureOptions,
  messages: Arc<Mutex<Vec<String>>>,
  auth_attempts: Arc<Mutex<usize>>,
  delivery_control: Arc<DeliveryControl>,
) -> std::io::Result<()> {
  let mut reader = BufReader::new(socket);
  reader
    .get_mut()
    .write_all(b"220 localhost ESMTP Myoxus fixture\r\n")
    .await?;
  expect_ehlo(&mut reader).await?;
  write_capabilities(reader.get_mut(), options.auth, options.advertise_starttls).await?;
  let mut command = String::new();
  if reader.read_line(&mut command).await? == 0 {
    return Ok(());
  }
  if !command.trim_end().eq_ignore_ascii_case("STARTTLS") {
    return Ok(());
  }
  reader.get_mut().write_all(b"220 Ready to start TLS\r\n").await?;
  let socket = reader.into_inner();
  let stream = match acceptor.accept(socket).await {
    Ok(stream) => stream,
    Err(_) => return Ok(()),
  };
  smtp_session_after_banner(stream, options.auth, messages, auth_attempts, delivery_control).await
}

async fn smtp_session<S>(
  mut stream: S,
  auth: SmtpFixtureAuth,
  messages: Arc<Mutex<Vec<String>>>,
  auth_attempts: Arc<Mutex<usize>>,
  delivery_control: Arc<DeliveryControl>,
) -> std::io::Result<()>
where
  S: AsyncRead + AsyncWrite + Unpin,
{
  stream.write_all(b"220 localhost ESMTP Myoxus fixture\r\n").await?;
  smtp_session_after_banner(stream, auth, messages, auth_attempts, delivery_control).await
}

async fn smtp_session_after_banner<S>(
  stream: S,
  auth: SmtpFixtureAuth,
  messages: Arc<Mutex<Vec<String>>>,
  auth_attempts: Arc<Mutex<usize>>,
  delivery_control: Arc<DeliveryControl>,
) -> std::io::Result<()>
where
  S: AsyncRead + AsyncWrite + Unpin,
{
  let mut reader = BufReader::new(stream);
  expect_ehlo(&mut reader).await?;
  write_capabilities(reader.get_mut(), auth, false).await?;
  command_loop(&mut reader, auth, messages, auth_attempts, delivery_control).await
}

async fn expect_ehlo<R>(reader: &mut R) -> std::io::Result<()>
where
  R: AsyncBufRead + Unpin,
{
  let mut line = String::new();
  if reader.read_line(&mut line).await? == 0 || !(line.starts_with("EHLO ") || line.starts_with("HELO ")) {
    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "expected EHLO"));
  }
  Ok(())
}

async fn write_capabilities<W>(writer: &mut W, auth: SmtpFixtureAuth, advertise_starttls: bool) -> std::io::Result<()>
where
  W: AsyncWrite + Unpin,
{
  writer.write_all(b"250-localhost\r\n").await?;
  if advertise_starttls {
    writer.write_all(b"250-STARTTLS\r\n").await?;
  }
  if auth != SmtpFixtureAuth::None {
    writer.write_all(b"250-AUTH PLAIN LOGIN\r\n").await?;
  }
  writer.write_all(b"250 SIZE 1048576\r\n").await
}

async fn command_loop<S>(
  reader: &mut BufReader<S>,
  auth: SmtpFixtureAuth,
  messages: Arc<Mutex<Vec<String>>>,
  auth_attempts: Arc<Mutex<usize>>,
  delivery_control: Arc<DeliveryControl>,
) -> std::io::Result<()>
where
  S: AsyncRead + AsyncWrite + Unpin,
{
  let mut authenticated = auth == SmtpFixtureAuth::None;
  loop {
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
      return Ok(());
    }
    let command = line.trim_end();
    let upper = command.to_ascii_uppercase();
    if upper.starts_with("AUTH ") {
      *auth_attempts.lock().await += 1;
      if auth == SmtpFixtureAuth::Reject {
        reader
          .get_mut()
          .write_all(b"535 5.7.8 Authentication credentials invalid\r\n")
          .await?;
      } else if upper == "AUTH LOGIN" {
        reader.get_mut().write_all(b"334 VXNlcm5hbWU6\r\n").await?;
        let mut username = String::new();
        reader.read_line(&mut username).await?;
        reader.get_mut().write_all(b"334 UGFzc3dvcmQ6\r\n").await?;
        let mut password = String::new();
        reader.read_line(&mut password).await?;
        authenticated = true;
        reader
          .get_mut()
          .write_all(b"235 2.7.0 Authentication successful\r\n")
          .await?;
      } else {
        authenticated = true;
        reader
          .get_mut()
          .write_all(b"235 2.7.0 Authentication successful\r\n")
          .await?;
      }
    } else if upper.starts_with("MAIL FROM:") {
      let response = if authenticated {
        b"250 2.1.0 Sender accepted\r\n".as_slice()
      } else {
        b"530 5.7.0 Authentication required\r\n".as_slice()
      };
      reader.get_mut().write_all(response).await?;
    } else if upper.starts_with("RCPT TO:") {
      reader.get_mut().write_all(b"250 2.1.5 Recipient accepted\r\n").await?;
    } else if upper == "DATA" {
      reader
        .get_mut()
        .write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n")
        .await?;
      let mut message = String::new();
      loop {
        let mut data_line = String::new();
        if reader.read_line(&mut data_line).await? == 0 || data_line == ".\r\n" {
          break;
        }
        message.push_str(&data_line);
      }
      messages.lock().await.push(message);
      let accepted = if delivery_control.paused.load(Ordering::SeqCst) {
        let (resume, decision) = oneshot::channel();
        if delivery_control.reached.send(resume).is_err() {
          return Ok(());
        }
        match decision.await {
          Ok(accepted) => accepted,
          Err(_) => return Ok(()),
        }
      } else {
        true
      };
      let response = if accepted {
        b"250 2.0.0 Queued\r\n".as_slice()
      } else {
        b"550 5.0.0 Fixture delivery rejected\r\n".as_slice()
      };
      reader.get_mut().write_all(response).await?;
    } else if upper == "NOOP" {
      reader.get_mut().write_all(b"250 2.0.0 OK\r\n").await?;
    } else if upper == "QUIT" {
      reader.get_mut().write_all(b"221 2.0.0 Bye\r\n").await?;
      return Ok(());
    } else {
      reader
        .get_mut()
        .write_all(b"500 5.5.2 Command unrecognized\r\n")
        .await?;
    }
  }
}
