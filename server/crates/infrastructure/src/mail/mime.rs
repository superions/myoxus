// SPDX-License-Identifier: AGPL-3.0-or-later
//! Lettre MIME assembly for the existing catalog and scheduling attachment.

use lettre::message::{Attachment, MultiPart, SinglePart};
use myoxus_application::ports::{MailTemplate, PortError, PortResult, TemplateMail};

use super::RenderedMail;
use super::templates::InlineMailAsset;

/// HTML and plain text share inline assets; ICS remains an outer attachment.
pub(super) fn message(
  mail: &TemplateMail,
  rendered: RenderedMail,
  from: &str,
  assets: &[InlineMailAsset],
) -> PortResult<lettre::Message> {
  let builder = lettre::Message::builder()
    .from(
      from
        .parse()
        .map_err(|_| PortError::InvalidInput("Invalid mail sender".into()))?,
    )
    .to(
      mail
        .to
        .parse()
        .map_err(|_| PortError::InvalidInput("Invalid mail recipient".into()))?,
    )
    .subject(rendered.subject);
  let mut related = MultiPart::related().multipart(
    MultiPart::alternative()
      .singlepart(SinglePart::plain(rendered.text))
      .singlepart(SinglePart::html(rendered.html)),
  );
  for asset in assets {
    related = related.singlepart(Attachment::new_inline(asset.id.into()).body(
      asset.bytes.clone(),
      asset.content_type.parse().expect("constant asset MIME type"),
    ));
  }
  let multipart = if let Some(ics) = &mail.calendar_attachment {
    let method = if mail.template == MailTemplate::CalendarCancellation {
      "CANCEL"
    } else {
      "REQUEST"
    };
    MultiPart::mixed().multipart(related).singlepart(
      Attachment::new("event.ics".into()).body(
        ics.clone(),
        format!("text/calendar; charset=utf-8; method={method}")
          .parse()
          .expect("constant calendar MIME type"),
      ),
    )
  } else {
    related
  };
  builder
    .multipart(multipart)
    .map_err(|_| PortError::Transport("Mail MIME construction failed".into()))
}
