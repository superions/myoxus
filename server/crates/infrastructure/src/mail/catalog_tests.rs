// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use myoxus_application::ports::MailTemplate;
use serde_json::json;

fn sender(directory: &str) -> SmtpMailAdapter {
  SmtpMailAdapter::new(
    MailConfig {
      smtp_host: "127.0.0.1".into(),
      smtp_port: 1025,
      smtp_name: None,
      smtp_user: None,
      smtp_pass: None,
      smtp_transport: SmtpTransportMode::Plain,
      smtp_verify_certificate: true,
      fallback_smtp: None,
      fallback_domains: vec![],
      from_email: "Myoxus <noreply@example.test>".into(),
      template_dir: directory.into(),
    },
    None,
  )
  .expect("valid catalog")
}
const STOCK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail");

#[tokio::test]
async fn complete_catalog_renders_escaped_html_text_and_mime_in_five_languages() {
  let sender = sender(STOCK);
  for language in MAIL_LANGUAGES {
    for template in MailTemplate::ALL {
      let mut mail = TemplateMail::new(
        "reader@example.test",
        template,
        myoxus_application::ports::MailPresentation::default(),
        json!({
          "actor":"Alice <script>alert(1)</script>","workspace_name":"Research & Development",
          "document_title":"Design <script>alert(2)</script>","row_title":"Release <Beta>",
          "field_name":"Owner","role":"Admin","summary":"Maintenance <script>alert(3)</script>",
          "event_title":"Review <script>alert(4)</script>","starts_at":"2026-10-12T09:00:00Z",
          "ends_at":"2026-10-12T10:00:00Z","previous_starts_at":"2026-10-11T09:00:00Z",
          "scheduled_label":"2026-10-12T08:30:00Z","url":"https://myoxus.example.test/action?a=1&b=2","otp":"123456"
        }),
      );
      mail.presentation.locale = format!("{language}-TEST");
      let rendered = sender.render_mail(&mail).await.expect("every catalog entry renders");
      assert!(!rendered.subject.is_empty(), "{language}/{}", template.name());
      assert!(!rendered.text.is_empty());
      assert!(rendered.html.contains(&format!("lang=\"{language}\"")));
      assert!(rendered.html.contains("Inter"));
      assert!(!rendered.html.contains("<script>"), "untrusted input escaped");
      assert!(!rendered.text.contains("<html"), "plain alternative is readable");
      assert!(rendered.text.contains("https://myoxus.example.test/action?a=1&b=2"));
      let mime = String::from_utf8(sender.message(&mail).await.expect("MIME").formatted()).expect("UTF8 MIME");
      for part in [
        "multipart/related",
        "multipart/alternative",
        "text/plain",
        "text/html",
        "Content-ID: <myoxus-mark>",
      ] {
        assert!(mime.contains(part), "{language}/{} missing {part}", template.name());
      }
    }
  }
}
