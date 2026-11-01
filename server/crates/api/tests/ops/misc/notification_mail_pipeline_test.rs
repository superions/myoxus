//! Integration tests for the Notification→Mail pipeline (P73-B-05).
//!
//! Tests verify three things:
//! 1. `MailPort` (via `TestMailAdapter`) captures sends with correct subject/recipient.
//! 2. Tera templates render without error and embed the expected variable values.
//! 3. `NotificationService::create_notification` dispatches the shared mail port when
//!    `notification_emails_enabled` is `true`.
//!
//! Template and spy cases are service-free. The delivery-policy case uses
//! isolated PostgreSQL preferences and a local SMTP fixture.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use myoxus_application::auth::{AuthUser, InMemoryAuthStore};
use myoxus_application::notification::mail::NotificationMailProjector;
use myoxus_application::notification::{InMemoryNotificationStore, NotificationService};
use myoxus_application::ports::{MailPort, MailTemplate, PortError, PortResult, TemplateMail};
use myoxus_infrastructure::mail::TestMailAdapter;
use serde_json::json;
use uuid::Uuid;

// ─── Spy MailPort ────────────────────────────────────────────────

/// Captures the prepared mail supplied by the notification consumer.
#[derive(Default)]
struct SpyMailPort {
  calls: Mutex<Vec<TemplateMail>>,
}

#[async_trait]
impl MailPort for SpyMailPort {
  async fn send_template(&self, mail: TemplateMail) -> PortResult<()> {
    let mut calls = self
      .calls
      .lock()
      .map_err(|_| PortError::Transport("spy lock poisoned".into()))?;
    calls.push(mail);
    Ok(())
  }
}

fn test_projector(user_id: Uuid) -> NotificationMailProjector {
  let auth = Arc::new(InMemoryAuthStore::default());
  auth.insert_user(AuthUser {
    id: user_id,
    email: "recipient@example.test".into(),
    name: None,
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  NotificationMailProjector::new(auth)
}

// ─── MailPort (TestMailAdapter) tests ─────────────────────────────────────────

/// INV-MAIL-01: prepared comment-mention stores mail with correct recipient and subject.
#[tokio::test]
async fn inv_mail01_comment_mention_captured_with_correct_subject() {
  use myoxus_application::ports::MailPort;
  let adapter = TestMailAdapter::default();

  adapter
    .send_template(TemplateMail::new(
      "alice@example.test",
      MailTemplate::CommentMention,
      myoxus_application::ports::MailPresentation::default(),
      json!({"actor":"Bobby", "document_title":"Design Doc", "url":"https://example.test/doc/1"}),
    ))
    .await
    .expect("prepared comment-mention");

  let mails = adapter.sent_mails.lock().expect("spy lock");
  assert_eq!(mails.len(), 1, "exactly one mail captured");
  assert_eq!(mails[0].to, "alice@example.test");
  assert!(
    mails[0].subject.contains("Bobby"),
    "subject must include sender name: {:?}",
    mails[0].subject
  );
  assert!(
    mails[0].subject.contains("Design Doc"),
    "subject must include doc title: {:?}",
    mails[0].subject
  );
}

/// INV-MAIL-02: prepared doc-shared stores mail with correct recipient and subject.
#[tokio::test]
async fn inv_mail02_doc_shared_captured_with_correct_subject() {
  use myoxus_application::ports::MailPort;
  let adapter = TestMailAdapter::default();

  adapter
    .send_template(TemplateMail::new(
      "bob@example.test",
      MailTemplate::DocShared,
      myoxus_application::ports::MailPresentation::default(),
      json!({"actor":"Alice", "document_title":"Project Brief", "url":"https://example.test/doc/2"}),
    ))
    .await
    .expect("prepared doc-shared");

  let mails = adapter.sent_mails.lock().expect("spy lock");
  assert_eq!(mails.len(), 1, "exactly one mail captured");
  assert_eq!(mails[0].to, "bob@example.test");
  assert!(
    mails[0].subject.contains("Alice"),
    "subject must include sender name: {:?}",
    mails[0].subject
  );
  assert!(
    mails[0].subject.contains("Project Brief"),
    "subject must include doc title: {:?}",
    mails[0].subject
  );
}

// ─── Template rendering tests ─────────────────────────────────────────────────
//
// These service-free cases exercise the renderer shared by SMTP and test mail
// adapters. The preference case below additionally proves real SMTP delivery.

fn load_mail_tera() -> myoxus_infrastructure::mail::MailTemplateRenderer {
  let template_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail");
  myoxus_infrastructure::mail::MailTemplateRenderer::new(template_dir).expect("mail templates must load")
}

/// INV-MAIL-04: comment-mention template renders with placeholder values substituted.
#[test]
fn inv_mail04_comment_mention_template_renders_variables() {
  let tera = load_mail_tera();
  let body = tera.render(myoxus_application::ports::MailTemplate::CommentMention, "en", &serde_json::json!({
    "actor":"Bobby","document_title":"Design Doc","url":"https://myoxus.test/doc/99","otp":"","email":"recipient@example.test"
  })).expect("comment-mention.html must render").html;

  assert!(body.contains("Bobby"), "body must contain mentioned_by: {body}");
  assert!(body.contains("Design Doc"), "body must contain doc_title: {body}");
  assert!(
    body.contains("href=\"https:&#x2F;&#x2F;myoxus.test&#x2F;doc&#x2F;99\""),
    "body must link to the escaped document URL: {body}"
  );
}

/// INV-MAIL-05: doc-shared template renders with placeholder values substituted.
#[test]
fn inv_mail05_doc_shared_template_renders_variables() {
  let tera = load_mail_tera();
  let body = tera.render(myoxus_application::ports::MailTemplate::DocShared, "en", &serde_json::json!({
    "actor":"Alice","document_title":"Q1 Roadmap","url":"https://myoxus.test/doc/42","otp":"","email":"recipient@example.test"
  })).expect("doc-shared.html must render").html;

  assert!(body.contains("Alice"), "body must contain shared_by: {body}");
  assert!(body.contains("Q1 Roadmap"), "body must contain doc_title: {body}");
  assert!(
    body.contains("href=\"https:&#x2F;&#x2F;myoxus.test&#x2F;doc&#x2F;42\""),
    "body must link to the escaped document URL: {body}"
  );
}

// ─── NotificationService→MailPort dispatch tests ─────────────────────────────

/// INV-NOTIF-01: create_notification dispatches shared mail port when emails are enabled.
#[tokio::test]
async fn inv_notif01_create_notification_calls_email_port_when_enabled() {
  let store = Arc::new(InMemoryNotificationStore::default());
  let spy = Arc::new(SpyMailPort::default());
  let user_id = Uuid::new_v4();
  let service = NotificationService::new_with_email(store, spy.clone(), test_projector(user_id), true);
  service
    .create_notification(
      user_id,
      "mention".to_string(),
      Some("default".to_string()),
      None,
      json!({"doc_title": "Test Doc"}),
    )
    .await
    .expect("create_notification");

  let calls = spy.calls.lock().expect("spy lock");
  assert_eq!(calls.len(), 1, "shared mail port must be called once");
  assert_eq!(
    calls[0].to, "recipient@example.test",
    "current account is the recipient"
  );
  assert_eq!(calls[0].template, MailTemplate::CommentMention);
}

/// INV-NOTIF-02: create_notification does NOT dispatch shared mail port when disabled.
#[tokio::test]
async fn inv_notif02_create_notification_skips_email_port_when_disabled() {
  let store = Arc::new(InMemoryNotificationStore::default());
  let spy = Arc::new(SpyMailPort::default());
  let user_id = Uuid::new_v4();
  let service = NotificationService::new_with_email(store, spy.clone(), test_projector(user_id), false);
  service
    .create_notification(
      user_id,
      "mention".to_string(),
      Some("default".to_string()),
      None,
      json!({"doc_title": "Test Doc"}),
    )
    .await
    .expect("create_notification");

  let calls = spy.calls.lock().expect("spy lock");
  assert_eq!(calls.len(), 0, "shared mail port must NOT be called when disabled");
}

/// INV-NOTIF-03: raw payload copy is not treated as authoritative mail content.
#[tokio::test]
async fn inv_notif03_notification_payload_is_projected_for_mail() {
  let store = Arc::new(InMemoryNotificationStore::default());
  let spy = Arc::new(SpyMailPort::default());
  let user_id = Uuid::new_v4();
  let service = NotificationService::new_with_email(store, spy.clone(), test_projector(user_id), true);
  let payload = json!({"doc_title": "Annual Report", "workspace_id": "abc-123"});
  service
    .create_notification(
      user_id,
      "doc_shared".to_string(),
      Some("default".to_string()),
      None,
      payload.clone(),
    )
    .await
    .expect("create_notification");

  let calls = spy.calls.lock().expect("spy lock");
  assert_eq!(calls.len(), 1);
  assert_eq!(calls[0].template, MailTemplate::DocShared);
  assert_eq!(
    calls[0].context,
    json!({"url":"/"}),
    "untrusted queued names are not mail copy"
  );
}

/// INV-NOTIF-04: idempotent create_notification dispatches email only once per unique key.
#[tokio::test]
async fn inv_notif04_idempotent_notification_dispatches_email_once() {
  let store = Arc::new(InMemoryNotificationStore::default());
  let spy = Arc::new(SpyMailPort::default());
  let user_id = Uuid::new_v4();
  let service = NotificationService::new_with_email(store, spy.clone(), test_projector(user_id), true);
  let key = Some("idem-key-test".to_string());

  service
    .create_notification(user_id, "mention".to_string(), None, key.clone(), json!({}))
    .await
    .expect("first create");

  // Second call with same idempotency key — store returns the existing row,
  // and must not start another email delivery.
  service
    .create_notification(user_id, "mention".to_string(), None, key, json!({}))
    .await
    .expect("second create (idempotent)");

  let calls = spy.calls.lock().expect("spy lock");
  assert_eq!(calls.len(), 1, "a replay must not dispatch another email");
}

/// Real PostgreSQL preferences and SMTP prove delivery-time opt-out independently
/// of Inbox persistence, category overlap, and idempotent replays.
#[tokio::test]
async fn notification_email_categories_use_current_saved_preferences() {
  use futures_util::FutureExt;
  use myoxus_application::auth::{AuthStore, UserPreferencesPatch};
  use myoxus_infrastructure::{
    auth::SqlxAuthStore,
    mail::SmtpTransportMode,
    mail::{MailConfig, SmtpMailAdapter},
    notification::SqlxNotificationRepository,
  };
  use myoxus_tests::smtp_fixture::{SmtpFixture, SmtpFixtureAuth, SmtpFixtureOptions};
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "notification_email_policy", false).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let auth = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
    let sink = SmtpFixture::start(SmtpFixtureOptions::plain(SmtpFixtureAuth::None)).await;
    let adapter = Arc::new(
      SmtpMailAdapter::new(
        MailConfig {
          smtp_host: sink.host().into(),
          smtp_port: sink.port(),
          smtp_name: None,
          smtp_user: None,
          smtp_pass: None,
          smtp_transport: SmtpTransportMode::Plain,
          smtp_verify_certificate: true,
          fallback_smtp: None,
          fallback_domains: vec![],
          from_email: "notifications@example.test".into(),
          template_dir: concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail").into(),
        },
        None,
      )
      .expect("SMTP sender")
      .with_rendering_config("http://localhost".into(), "en".into()),
    );
    let service = NotificationService::new_with_email(
      Arc::new(SqlxNotificationRepository::new(pool.clone())),
      adapter,
      NotificationMailProjector::new(auth.clone()),
      true,
    );
    let kinds = [
      "workspace_invitation",
      "invitation",
      "mention",
      "comment_mention",
      "comment",
      "comment_reply",
    ];
    for (index, kind) in kinds.iter().enumerate() {
      let key = format!("email-policy:{user_id}:default:{index}");
      let row = service
        .create_notification(user_id, (*kind).into(), None, Some(key.clone()), json!({}))
        .await
        .expect("default delivery");
      let replay = service
        .create_notification(user_id, (*kind).into(), None, Some(key), json!({}))
        .await
        .expect("idempotent replay");
      assert_eq!(row.id, replay.id);
    }
    assert_eq!(
      sink.messages().await.len(),
      kinds.len(),
      "defaults deliver once per unique row"
    );
    auth
      .patch_user_preferences(
        user_id,
        UserPreferencesPatch {
          receive_invitation_email: Some(Some(false)),
          receive_mention_email: Some(Some(false)),
          receive_comment_email: Some(Some(false)),
          ..Default::default()
        },
      )
      .await
      .expect("save opt-outs");
    for kind in kinds {
      service
        .create_notification(user_id, kind.into(), None, None, json!({}))
        .await
        .expect("Inbox survives opt-out");
    }
    assert_eq!(
      sink.messages().await.len(),
      kinds.len(),
      "all opted-out categories are suppressed"
    );
    auth
      .patch_user_preferences(
        user_id,
        UserPreferencesPatch {
          receive_mention_email: Some(Some(true)),
          ..Default::default()
        },
      )
      .await
      .expect("enable only mentions");
    service
      .create_notification(user_id, "comment_mention".into(), None, None, json!({}))
      .await
      .expect("mention wins over comment opt-out");
    assert_eq!(sink.messages().await.len(), kinds.len() + 1);
    // Corrupt stored preference data simulates a failed preference read. It must
    // never become implicit permission to send, while persistence still succeeds.
    sqlx::query(
      "UPDATE user_preferences SET values = '{\"receiveMentionEmail\":\"invalid\"}'::jsonb WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("simulate invalid persisted preferences");
    service
      .create_notification(user_id, "mention".into(), None, None, json!({}))
      .await
      .expect("Inbox survives preference failure");
    assert_eq!(sink.messages().await.len(), kinds.len() + 1);
    assert_eq!(
      service.unread_count(user_id).await.expect("Inbox count"),
      (kinds.len() * 2 + 2) as i64
    );
  })
  .catch_unwind()
  .await;
  crate::helpers::cleanup_users(&pool, &[user_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// Only durable Task payloads require the Database projector. Unmarked Generic
/// assignment mail retains its deployed presentation, even with that port wired.
#[tokio::test]
async fn task_assignment_mail_reauthorizes_current_target_without_changing_generic_copy() {
  use crate::helpers;
  use futures_util::FutureExt;
  use std::panic::AssertUnwindSafe;
  let spy = Arc::new(SpyMailPort::default());
  let (app, pool, auth, state) = helpers::setup_app_with_task_notification_mail(spy.clone()).await;
  let (owner, session) = helpers::seed_user(&pool, &auth, "task-mail-owner").await;
  let (recipient, _) = helpers::seed_user(&pool, &auth, "task-mail-recipient").await;
  let body = AssertUnwindSafe(async {
    async fn mutation(app: &axum::Router, session: Uuid, query: &str, input: serde_json::Value) -> serde_json::Value {
      let response = helpers::gql(app, session, json!({"query":query,"variables":{"i":input}})).await;
      assert!(response.get("errors").is_none(), "{response}");
      response["data"].clone()
    }
    let workspace = helpers::create_workspace(&pool, owner).await;
    helpers::add_workspace_member(&pool, workspace, recipient).await;
    let project=mutation(&app,session,"mutation($i:CreateProjectInput!){createProject(input:$i){database{id}fieldRoles{roleKey fieldId}}}",
        json!({"workspaceId":workspace,"title":"Mail authorization","structurePreset":"TasksOnly","priorityPreset":"ThreeStep","complexityPreset":"ThreeStep"})).await;
    let database = &project["createProject"]["database"]["id"];
    let assignees = &project["createProject"]["fieldRoles"]
      .as_array()
      .unwrap()
      .iter()
      .find(|role| role["roleKey"] == "task.assignees")
      .unwrap()["fieldId"];
    let row=mutation(&app,session,"mutation($i:CreateDatabaseRowInput!){createDatabaseRow(input:$i){row{id}}}",
        json!({"databaseId":database,"title":"Current Task title","cells":[{"fieldId":assignees,"value":{"users":[recipient]}}]})).await;
    let row = &row["createDatabaseRow"]["row"]["id"];
    let payload = json!({"workspaceId":workspace,"databaseId":database,"rowId":row,"taskNotificationEventId":Uuid::new_v4(),
        "rowTitle":"HISTORICAL PRIVATE TITLE","fieldName":"HISTORICAL PRIVATE FIELD"});
    state
      .notification()
      .dispatch_notification_email(recipient, "database.row.assigned", &payload)
      .await;
    {
      let calls = spy.calls.lock().unwrap();
      assert_eq!(calls.len(), 1);
      assert_eq!(calls[0].context["row_title"], "Current Task title");
      assert!(!calls[0].context.to_string().contains("HISTORICAL PRIVATE"));
    }
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
      .bind(workspace)
      .bind(recipient)
      .execute(&pool)
      .await
      .unwrap();
    state
      .notification()
      .dispatch_notification_email(recipient, "database.row.assigned", &payload)
      .await;
    assert_eq!(
      spy.calls.lock().unwrap().len(),
      1,
      "actual mail execution rechecks the current Task grant"
    );
    helpers::add_workspace_member(&pool, workspace, recipient).await;
    let generic = mutation(
      &app,
      session,
      "mutation($i:CreateDatabaseInput!){createDatabase(input:$i){database{id}}}",
      json!({"workspaceId":workspace,"title":"Generic mail"}),
    )
    .await;
    let generic = &generic["createDatabase"]["database"]["id"];
    let generic_row = mutation(
      &app,
      session,
      "mutation($i:CreateDatabaseRowInput!){createDatabaseRow(input:$i){row{id}}}",
      json!({"databaseId":generic,"title":"Current Generic title"}),
    )
    .await;
    state
      .notification()
      .dispatch_notification_email(
        recipient,
        "database.row.assigned",
        &json!({"workspaceId":workspace,"databaseId":generic,"rowId":generic_row["createDatabaseRow"]["row"]["id"],
          "rowTitle":"Generic event title","fieldName":"Generic people"}),
      )
      .await;
    let calls = spy.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].context["row_title"], "Generic event title");
    assert_eq!(calls[1].context["field_name"], "Generic people");
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[recipient, owner]).await;
  if let Err(error) = body {
    std::panic::resume_unwind(error);
  }

  let user = Uuid::new_v4();
  let missing_port = Arc::new(SpyMailPort::default());
  let service = NotificationService::new_with_email(
    Arc::new(InMemoryNotificationStore::default()),
    missing_port.clone(),
    test_projector(user),
    true,
  );
  service.dispatch_notification_email(user,"database.row.assigned",
    &json!({"workspaceId":Uuid::new_v4(),"databaseId":Uuid::new_v4(),"rowId":Uuid::new_v4(),"taskNotificationEventId":Uuid::new_v4(),
      "rowTitle":"MUST NOT FALL BACK","fieldName":"MUST NOT FALL BACK"})).await;
  assert!(missing_port.calls.lock().unwrap().is_empty());
}
