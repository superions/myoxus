// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Finite server-owned mail catalog. Names also identify operator-editable HTML files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MailTemplate {
  PasswordReset,
  SetPassword,
  VerifyEmail,
  ChangeEmail,
  SignIn,
  Welcome,
  WorkspaceInvitation,
  InvitationAccepted,
  InvitationReviewRequest,
  InvitationReviewApproved,
  InvitationReviewDeclined,
  MemberAdded,
  MemberRemoved,
  RoleChanged,
  CommentMention,
  CommentReply,
  DocShared,
  DatabaseRowAssigned,
  DatabaseRowReminder,
  CalendarReminder,
  CalendarInvitation,
  CalendarUpdate,
  CalendarCancellation,
  SmtpTest,
  GeneralNotification,
}

impl MailTemplate {
  pub const ALL: [Self; 25] = [
    Self::PasswordReset,
    Self::SetPassword,
    Self::VerifyEmail,
    Self::ChangeEmail,
    Self::SignIn,
    Self::Welcome,
    Self::WorkspaceInvitation,
    Self::InvitationAccepted,
    Self::InvitationReviewRequest,
    Self::InvitationReviewApproved,
    Self::InvitationReviewDeclined,
    Self::MemberAdded,
    Self::MemberRemoved,
    Self::RoleChanged,
    Self::CommentMention,
    Self::CommentReply,
    Self::DocShared,
    Self::DatabaseRowAssigned,
    Self::DatabaseRowReminder,
    Self::CalendarReminder,
    Self::CalendarInvitation,
    Self::CalendarUpdate,
    Self::CalendarCancellation,
    Self::SmtpTest,
    Self::GeneralNotification,
  ];

  pub fn name(self) -> &'static str {
    match self {
      Self::PasswordReset => "password-reset",
      Self::SetPassword => "set-password",
      Self::VerifyEmail => "verify-email",
      Self::ChangeEmail => "change-email",
      Self::SignIn => "sign-in",
      Self::Welcome => "welcome",
      Self::WorkspaceInvitation => "workspace-invitation",
      Self::InvitationAccepted => "invitation-accepted",
      Self::InvitationReviewRequest => "invitation-review-request",
      Self::InvitationReviewApproved => "invitation-review-approved",
      Self::InvitationReviewDeclined => "invitation-review-declined",
      Self::MemberAdded => "member-added",
      Self::MemberRemoved => "member-removed",
      Self::RoleChanged => "role-changed",
      Self::CommentMention => "comment-mention",
      Self::CommentReply => "comment-reply",
      Self::DocShared => "doc-shared",
      Self::DatabaseRowAssigned => "database-row-assigned",
      Self::DatabaseRowReminder => "database-row-reminder",
      Self::CalendarReminder => "calendar-reminder",
      Self::CalendarInvitation => "calendar-invitation",
      Self::CalendarUpdate => "calendar-update",
      Self::CalendarCancellation => "calendar-cancellation",
      Self::SmtpTest => "smtp-test",
      Self::GeneralNotification => "general-notification",
    }
  }
}

/// The recipient's effective presentation, prepared by the owning use case.
/// Explicit locale takes precedence; timezone/date/time always remain recipient-owned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailPresentation {
  pub locale: String,
  pub timezone: String,
  pub date_format: String,
  pub time_format: String,
}

impl MailPresentation {
  pub fn from_preferences(preferences: &crate::auth::EffectiveUserPreferences, locale: Option<&str>) -> Self {
    Self {
      locale: locale.unwrap_or(&preferences.locale).into(),
      timezone: preferences.timezone.clone(),
      date_format: preferences.date_format.clone(),
      time_format: preferences.time_format.clone(),
    }
  }

  /// Unknown external recipients use the existing mail defaults, without a lookup.
  pub fn from_defaults(defaults: &crate::auth::UserPreferenceDefaults, locale: Option<&str>) -> Self {
    Self::from_preferences(&crate::auth::UserPreferences::default().resolve(defaults), locale)
  }
}

impl Default for MailPresentation {
  fn default() -> Self {
    Self::from_defaults(&crate::auth::UserPreferenceDefaults::default(), None)
  }
}

/// Prepared feature projection. The sender receives neither identity services
/// nor unprojected business events and does not resolve recipient preferences.
#[derive(Debug, Clone)]
pub struct TemplateMail {
  pub to: String,
  pub template: MailTemplate,
  pub presentation: MailPresentation,
  pub context: Value,
  pub calendar_attachment: Option<String>,
}

impl TemplateMail {
  pub fn new(to: &str, template: MailTemplate, presentation: MailPresentation, context: Value) -> Self {
    Self {
      to: to.into(),
      template,
      presentation,
      context,
      calendar_attachment: None,
    }
  }
}
