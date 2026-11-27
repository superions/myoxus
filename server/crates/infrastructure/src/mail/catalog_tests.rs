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
          "scheduled_label":"2026-10-12T08:30:00Z","key_name":"mcp:prod <script>alert(5)</script>",
          "key_scopes":["read:workspaces","write:docs","<script>alert(6)</script>"],
          "created_at":"2026-10-12T08:00:00Z","expires_at":"2026-11-12T08:00:00Z",
          "url":"https://myoxus.example.test/action?a=1&b=2","otp":"123456"
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

#[tokio::test]
async fn upgraded_catalog_tolerates_preserved_copy_json_without_mcp_key_fields() {
  let temp = tempfile::tempdir().expect("temp mail catalog");
  let stock = std::path::Path::new(STOCK);
  std::fs::copy(stock.join("_layout.html"), temp.path().join("_layout.html")).expect("copy layout");
  std::fs::create_dir_all(temp.path().join("assets")).expect("assets dir");
  for asset in [
    "product-mark.png",
    "inter-regular-latin.woff2",
    "inter-regular-latin-ext.woff2",
  ] {
    std::fs::copy(stock.join("assets").join(asset), temp.path().join("assets").join(asset)).expect("copy asset");
  }
  for language in MAIL_LANGUAGES {
    let dst = temp.path().join(language);
    std::fs::create_dir_all(&dst).expect("lang dir");
    let mut copy: serde_json::Value =
      serde_json::from_str(&std::fs::read_to_string(stock.join(language).join("_copy.json")).expect("read copy"))
        .expect("parse copy");
    let obj = copy.as_object_mut().expect("copy object");
    obj.remove("keyFallback");
    obj.remove("noExpiration");
    std::fs::write(dst.join("_copy.json"), serde_json::to_string_pretty(&copy).unwrap()).expect("write legacy copy");
    for template in MailTemplate::ALL {
      let file = format!("{}.html", template.name());
      std::fs::copy(stock.join(language).join(&file), dst.join(&file)).expect("copy template");
    }
  }

  let adapter = sender(temp.path().to_str().expect("utf8 path"));
  let mut mail = TemplateMail::new(
    "owner@example.test",
    MailTemplate::McpApiKeyCreated,
    myoxus_application::ports::MailPresentation::default(),
    json!({ "key_name": "", "key_scopes": ["read:docs"], "created_at": "2026-11-27T14:15:00Z", "expires_at": "" }),
  );
  mail.presentation.locale = "de-DE".into();
  let rendered = adapter
    .render_mail(&mail)
    .await
    .expect("upgraded catalog renders with localized defaults");
  assert!(rendered.subject.contains("MCP-API-Key"));
  assert!(rendered.text.contains("Kein Ablaufdatum"));
}
