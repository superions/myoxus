// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared preparation of already projected mail; no identity or delivery policy.

use chrono::DateTime;
use chrono_tz::Tz;
use myoxus_application::ports::{MailTemplate, PortError, PortResult, TemplateMail};
use serde_json::Value;

use super::{MailTemplateRenderer, RenderedMail};

/// Production and test capture must format the same role, dates and links.
pub(super) fn render_mail(
  renderer: &MailTemplateRenderer,
  mail: &TemplateMail,
  origin: &str,
  default_locale: &str,
) -> PortResult<RenderedMail> {
  let presentation = &mail.presentation;
  let language = MailTemplateRenderer::language(Some(&presentation.locale), default_locale);
  let mut data = complete_mail_context(mail, origin)?;
  data["role_name"] = Value::String(renderer.role_name(language, data["role"].as_str().unwrap_or_default()));
  for key in ["starts_at", "ends_at", "previous_starts_at", "scheduled_label"] {
    if let Some(value) = data[key].as_str() {
      data[key] = Value::String(format_mail_time(
        value,
        language,
        Some(presentation.timezone.as_str()),
        Some(presentation.date_format.as_str()),
        Some(presentation.time_format.as_str()),
        data["all_day"].as_bool().unwrap_or(false),
      ));
    }
  }
  renderer.render(mail.template, language, &data)
}

fn complete_mail_context(mail: &TemplateMail, origin: &str) -> PortResult<Value> {
  let mut context = serde_json::json!({"email":mail.to,"url":"","otp":"","actor":"","workspace_name":"",
    "role":"","role_name":"","document_title":"","row_title":"","field_name":"","scheduled_label":"",
    "event_title":"","starts_at":"","ends_at":"","previous_starts_at":"","location":"","summary":"","all_day":false,
    "doc_title":"","doc_url":"","mentioned_by":"","shared_by":"","is_signup":mail.template == MailTemplate::Welcome});
  let fields = mail
    .context
    .as_object()
    .ok_or_else(|| PortError::InvalidInput("Mail context must be an object".into()))?;
  for (key, value) in fields {
    if context.get(key).is_some() {
      context[key] = value.clone();
    }
  }
  let route = context["url"]
    .as_str()
    .ok_or_else(|| PortError::InvalidInput("Mail URL must be text".into()))?;
  let url = if route.starts_with('/') && !route.starts_with("//") {
    format!("{origin}{route}")
  } else {
    route.into()
  };
  if !url.is_empty()
    && ((!url.starts_with("https://") && !url.starts_with("http://")) || url.chars().any(char::is_control))
  {
    return Err(PortError::InvalidInput(
      "Mail URL must be an absolute HTTP(S) link".into(),
    ));
  }
  context["url"] = Value::String(url);
  context["doc_title"] = context["document_title"].clone();
  context["doc_url"] = context["url"].clone();
  context["mentioned_by"] = context["actor"].clone();
  context["shared_by"] = context["actor"].clone();
  Ok(context)
}

pub(super) fn format_mail_time(
  value: &str,
  language: &str,
  timezone: Option<&str>,
  date_format: Option<&str>,
  time_format: Option<&str>,
  all_day: bool,
) -> String {
  let Ok(time) = DateTime::parse_from_rfc3339(value) else {
    return value.into();
  };
  let zone = timezone
    .and_then(|value| value.parse::<Tz>().ok())
    .unwrap_or(chrono_tz::UTC);
  let date = match date_format {
    Some("day-month-year") => "%d.%m.%Y",
    Some("month-day-year") => "%m/%d/%Y",
    Some("year-month-day") => "%Y-%m-%d",
    _ if language == "en" => "%m/%d/%Y",
    _ if language == "de" => "%d.%m.%Y",
    _ => "%d/%m/%Y",
  };
  let clock = match time_format {
    Some("12-hour") => "%I:%M %p",
    Some("24-hour") => "%H:%M",
    _ if language == "en" => "%I:%M %p",
    _ => "%H:%M",
  };
  if all_day {
    return time.date_naive().format(date).to_string();
  }
  time
    .with_timezone(&zone)
    .format(&format!("{date} {clock} %Z"))
    .to_string()
}
