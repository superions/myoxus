// SPDX-License-Identifier: AGPL-3.0-or-later
//! Calendar-owned delivery of the existing authored scheduling intent.

use crate::auth::{AuthError, AuthResult, AuthStore, UserPreferenceDefaults};
use crate::ports::{MailPort, MailPresentation, MailTemplate, TemplateMail};
use crate::workspace::WorkspaceStore;
use myoxus_domain::entities::{CalendarEvent, MembershipStatus};
use myoxus_domain::repositories::{CalendarMailDeliveryGuard, CalendarMailDeliveryScope, CalendarRepository};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub type SchedulingEncoder = fn(&CalendarEvent, i32, bool, &str, &str) -> Result<String, &'static str>;
pub type MailboxNormalizer = fn(&str) -> Result<String, &'static str>;

/// Decoded deployed queue payload. Invalid input never reaches SMTP.
#[derive(Clone)]
pub struct CalendarSchedulingMailIntent {
  pub id: Uuid,
  pub event: CalendarEvent,
  pub template: MailTemplate,
  pub sequence: i32,
  pub to: String,
  pub user_id: Option<Uuid>,
  pub organizer_email: Option<String>,
  pub previous_starts_at: Value,
}

impl CalendarSchedulingMailIntent {
  pub fn from_payload(data: &Value) -> AuthResult<Self> {
    let id = data["intentId"]
      .as_str()
      .ok_or_else(|| permanent("Calendar intent ID missing"))?
      .parse()
      .map_err(|_| permanent("Invalid calendar intent ID"))?;
    let event =
      serde_json::from_value(data["event"].clone()).map_err(|_| permanent("Invalid calendar mail snapshot"))?;
    let template =
      serde_json::from_value(data["template"].clone()).map_err(|_| permanent("Invalid calendar mail template"))?;
    if !matches!(
      template,
      MailTemplate::CalendarInvitation | MailTemplate::CalendarUpdate | MailTemplate::CalendarCancellation
    ) {
      return Err(permanent("Invalid calendar scheduling template"));
    }
    let sequence = data["sequence"]
      .as_i64()
      .and_then(|value| value.try_into().ok())
      .filter(|value| *value >= 0)
      .ok_or_else(|| permanent("Invalid calendar scheduling sequence"))?;
    let to = data["to"]
      .as_str()
      .ok_or_else(|| permanent("Calendar recipient missing"))?
      .into();
    let user_id = data["userId"]
      .as_str()
      .map(|id| id.parse())
      .transpose()
      .map_err(|_| permanent("Invalid calendar recipient"))?;
    Ok(Self {
      id,
      event,
      template,
      sequence,
      to,
      user_id,
      organizer_email: data["organizerEmail"].as_str().map(str::to_owned),
      previous_starts_at: data["previousStartsAt"].clone(),
    })
  }
}

#[derive(Clone)]
pub struct CalendarSchedulingMailDispatcher {
  calendar: Arc<dyn CalendarRepository>,
  auth: Arc<dyn AuthStore>,
  workspace: Arc<dyn WorkspaceStore>,
  mailer: Arc<dyn MailPort>,
  notification_emails_enabled: bool,
  sender: String,
  mail_defaults: UserPreferenceDefaults,
  encode_scheduling: SchedulingEncoder,
  normalize_mailbox: MailboxNormalizer,
}

impl CalendarSchedulingMailDispatcher {
  pub fn new(
    calendar: Arc<dyn CalendarRepository>,
    auth: Arc<dyn AuthStore>,
    workspace: Arc<dyn WorkspaceStore>,
    mailer: Arc<dyn MailPort>,
    notification_emails_enabled: bool,
    sender: String,
    encode_scheduling: SchedulingEncoder,
    normalize_mailbox: MailboxNormalizer,
  ) -> Self {
    Self {
      calendar,
      auth,
      workspace,
      mailer,
      notification_emails_enabled,
      sender,
      mail_defaults: UserPreferenceDefaults::default(),
      encode_scheduling,
      normalize_mailbox,
    }
  }

  pub fn with_mail_defaults(mut self, defaults: UserPreferenceDefaults) -> Self {
    self.mail_defaults = defaults;
    self
  }

  /// The session guard serializes one intent without spanning SMTP with a SQL
  /// transaction. A crash after SMTP succeeds but before its receipt is written
  /// can still cause redelivery; receipts cannot promise exactly-once SMTP.
  #[tracing::instrument(skip_all)]
  pub async fn dispatch(&self, intent: &CalendarSchedulingMailIntent) -> AuthResult<()> {
    let mut guard = self
      .calendar
      .acquire_mail_delivery_guard(intent.id)
      .await
      .map_err(|_| retry("Calendar mail receipt lock failed"))?;
    let result = self.dispatch_guarded(intent, &mut *guard).await;
    let release = guard
      .release()
      .await
      .map_err(|_| retry("Calendar mail receipt unlock failed"));
    match (result, release) {
      (Ok(()), Ok(())) => Ok(()),
      (Err(error), _) | (Ok(()), Err(error)) => Err(error),
    }
  }

  async fn dispatch_guarded(
    &self,
    intent: &CalendarSchedulingMailIntent,
    guard: &mut dyn CalendarMailDeliveryGuard,
  ) -> AuthResult<()> {
    if guard
      .completed()
      .await
      .map_err(|_| retry("Calendar mail receipt read failed"))?
    {
      return Ok(());
    }
    let event = &intent.event;
    let template = intent.template;
    let sequence = intent.sequence;
    let original_email = intent.to.as_str();
    let auth = &self.auth;
    let user = if let Some(id) = intent.user_id {
      auth.get_user_by_id(id).await
    } else {
      auth.get_user_by_email(original_email).await
    }
    .map_err(|_| retry("Calendar recipient lookup failed"))?;
    let mut presentation = MailPresentation::from_defaults(&self.mail_defaults, None);
    let mut allowed = self.notification_emails_enabled;
    if intent.user_id.is_some() && user.is_none() {
      allowed = false;
    }
    if let Some(user) = &user {
      let preferences = auth
        .get_user_preferences(user.id)
        .await
        .map_err(|_| retry("Calendar mail preferences unavailable"))?;
      let preferences = preferences.values.resolve(&self.mail_defaults);
      presentation = MailPresentation::from_preferences(&preferences, None);
      allowed &= !user.disabled && preferences.receive_invitation_email;
      if event.all_members
        && let Some(workspace) = event.workspace_id
      {
        allowed &= self
          .workspace
          .get_member(workspace, user.id)
          .await
          .map_err(|_| retry("Calendar mail access unavailable"))?
          .is_some_and(|member| member.status == MembershipStatus::Accepted);
      }
    }
    let current = self
      .calendar
      .get_calendar_event(event.id)
      .await
      .map_err(|_| retry("Calendar event lookup failed"))?;
    if template != MailTemplate::CalendarCancellation {
      allowed &= current.as_ref().is_some_and(|current| {
        current.all_members
          || current.participants.iter().any(|participant| {
            participant.email.eq_ignore_ascii_case(original_email)
              || user.as_ref().is_some_and(|user| participant.user_id == Some(user.id))
          })
      });
    }
    // A later mutation of another occurrence must not erase this delivery.
    // Supersede only the same recipient and recurrence scope, including queued
    // cancellations superseded by a subsequent invitation.
    let superseded = guard
      .superseded(&CalendarMailDeliveryScope {
        uid: event.remote_event_id.clone().unwrap_or_else(|| event.id.to_string()),
        recipient: original_email.into(),
        recurrence_id: event.payload["recurrenceId"].as_str().map(str::to_owned),
        sequence,
      })
      .await
      .map_err(|_| retry("Calendar sequence unavailable"))?;
    allowed &= !superseded;
    if let Some(workspace) = event.workspace_id {
      allowed &= self
        .workspace
        .get_workspace(workspace)
        .await
        .map_err(|_| retry("Calendar workspace unavailable"))?
        .is_some_and(|workspace| workspace.deleted_at.is_none());
    }
    if allowed {
      let to = user.as_ref().map(|user| user.email.as_str()).unwrap_or(original_email);
      let organizer = intent
        .organizer_email
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&self.sender);
      let organizer = (self.normalize_mailbox)(organizer).map_err(permanent)?;
      let actor = auth
        .get_user_by_email(&organizer)
        .await
        .map_err(|_| retry("Calendar organizer unavailable"))?
        .and_then(|user| user.name)
        .unwrap_or_default();
      let url = if let Some(workspace) = event.workspace_id {
        if let Some(user) = &user {
          if self
            .workspace
            .get_member(workspace, user.id)
            .await
            .map_err(|_| retry("Calendar action access unavailable"))?
            .is_some_and(|member| member.status == MembershipStatus::Accepted)
          {
            format!("/workspace/{workspace}/journals")
          } else {
            String::new()
          }
        } else {
          String::new()
        }
      } else {
        String::new()
      };
      let mut mail = TemplateMail::new(
        to,
        template,
        presentation,
        json!({"event_title":event.title,"starts_at":event.starts_at.to_rfc3339(),
      "ends_at":event.ends_at.to_rfc3339(),"previous_starts_at":intent.previous_starts_at,"location":event.payload["location"],
      "actor":actor,"url":url,"all_day":event.all_day}),
      );
      mail.calendar_attachment = Some(
        (self.encode_scheduling)(
          &event,
          sequence,
          template == MailTemplate::CalendarCancellation,
          to,
          &organizer,
        )
        .map_err(permanent)?,
      );
      self
        .mailer
        .send_template(mail)
        .await
        .map_err(|_| retry("Calendar mail SMTP delivery failed"))?;
    }
    guard
      .complete()
      .await
      .map_err(|_| retry("Calendar mail receipt write failed"))?;
    Ok(())
  }
}

fn permanent(message: &str) -> AuthError {
  AuthError::InvalidInput(message.into())
}
fn retry(message: &str) -> AuthError {
  AuthError::Storage(message.into())
}
