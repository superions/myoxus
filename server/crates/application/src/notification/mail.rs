// SPDX-License-Identifier: AGPL-3.0-or-later
//! Delivery-time projection of notification IDs into localized mail context.

use std::sync::Arc;

use serde_json::{Value, json};
use uuid::Uuid;

use super::NotificationEmailCategory;
use crate::auth::{AuthResult, AuthStore, UserPreferenceDefaults};
use crate::doc::DocService;
use crate::permission::PermissionService;
use crate::ports::{MailPresentation, MailTemplate, TemplateMail};
use crate::workspace::WorkspaceService;
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_domain::permission::DocAction;

#[derive(Clone)]
pub struct NotificationMailProjector {
  auth: Arc<dyn AuthStore>,
  mail_defaults: UserPreferenceDefaults,
  services: Option<(WorkspaceService, DocService, Arc<PermissionService>)>,
  database: Option<(
    Arc<dyn myoxus_domain::database::DatabaseEditingRepository>,
    Arc<dyn myoxus_domain::database::DatabaseDefinitionRepository>,
  )>,
}

impl NotificationMailProjector {
  pub fn new(auth: Arc<dyn AuthStore>) -> Self {
    Self {
      auth,
      mail_defaults: UserPreferenceDefaults::default(),
      services: None,
      database: None,
    }
  }

  pub fn with_mail_defaults(mut self, defaults: UserPreferenceDefaults) -> Self {
    self.mail_defaults = defaults;
    self
  }

  pub fn with_services(
    mut self,
    workspace: WorkspaceService,
    doc: DocService,
    permission: Arc<PermissionService>,
  ) -> Self {
    self.services = Some((workspace, doc, permission));
    self
  }

  /// Resolve database mail/intent IDs against current canonical scope and role
  /// Cells. A queued display payload is never authority for a Project Task.
  #[tracing::instrument(skip_all)]
  pub async fn current_database_target(
    &self,
    recipient: Uuid,
    workspace_id: Uuid,
    database_id: Uuid,
    row_id: Uuid,
    changed: bool,
    task_only: bool,
  ) -> AuthResult<Option<(String, String)>> {
    use crate::permission::{AccessController, WorkspaceResource};
    use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldType, DatabaseProfileKind, DatabaseRowKind};
    use myoxus_domain::permission::WorkspaceAction;
    let Some((workspace, _, permission)) = &self.services else {
      return Ok(None);
    };
    let Some((rows, schema)) = &self.database else {
      return Ok(None);
    };
    if workspace
      .get_workspace(workspace_id)
      .await?
      .is_none_or(|workspace| workspace.deleted_at.is_some())
      || workspace
        .get_member(workspace_id, recipient)
        .await?
        .is_none_or(|member| member.status != MembershipStatus::Accepted)
      || !permission
        .can(
          &WorkspaceResource {
            user_id: recipient,
            workspace_id,
          },
          WorkspaceAction::Read,
        )
        .await
    {
      return Ok(None);
    }
    let Some(record) = schema
      .get_database(database_id)
      .await
      .map_err(|_| crate::auth::AuthError::Storage("database notification target lookup failed".into()))?
    else {
      return Ok(None);
    };
    if record.database.workspace_id != workspace_id || record.database.deleted_at.is_some() {
      return Ok(None);
    }
    let row = match rows.get_row(row_id).await {
      Ok(Some(row)) => row,
      Ok(None) | Err(myoxus_domain::repositories::RepositoryError::Validation(_)) => return Ok(None),
      Err(_) => {
        return Err(crate::auth::AuthError::Storage(
          "database notification Row lookup failed".into(),
        ));
      }
    };
    if row.row.database_id != database_id || row.row.deleted_at.is_some() {
      return Ok(None);
    }
    if record.database.profile_kind == DatabaseProfileKind::Project {
      if row.row.row_kind != DatabaseRowKind::Task {
        return Ok(None);
      }
      let field = |key: &str| {
        record
          .field_roles
          .iter()
          .find(|role| {
            role.role_key == key
              && role.row_kind_scope.as_deref() == Some("task")
              && record
                .fields
                .iter()
                .any(|field| field.id == role.field_id && field.field_type == DatabaseFieldType::Users)
              && (key != "task.watchers"
                || !record.field_roles.iter().any(|other| {
                  other.field_id == role.field_id
                    && other.row_kind_scope.as_deref() == Some("task")
                    && other.role_key != "task.watchers"
                }))
          })
          .map(|role| role.field_id)
      };
      let assignees = field("task.assignees");
      let watchers = field("task.watchers");
      let contains = |field| {
        row.cells.iter().any(|cell| {
          Some(cell.field_id) == field
            && matches!(&cell.value,DatabaseCellValueData::Users(users) if users.contains(&recipient))
        })
      };
      if !contains(assignees) && (!changed || !contains(watchers)) {
        return Ok(None);
      }
      let field_name = record
        .fields
        .iter()
        .find(|field| Some(field.id) == assignees)
        .map(|field| field.name.clone())
        .unwrap_or_default();
      // Recheck the movable owning Database after reading the Row/roles.
      let current = schema
        .get_database(database_id)
        .await
        .map_err(|_| crate::auth::AuthError::Storage("database notification owner recheck failed".into()))?;
      if current
        .is_none_or(|current| current.database.workspace_id != workspace_id || current.database.deleted_at.is_some())
      {
        return Ok(None);
      }
      return Ok(Some((row.row.title, field_name)));
    }
    if task_only {
      return Ok(None);
    }
    Ok(Some((row.row.title, String::new())))
  }

  pub fn with_database_repository(
    mut self,
    rows: Arc<dyn myoxus_domain::database::DatabaseEditingRepository>,
    schema: Arc<dyn myoxus_domain::database::DatabaseDefinitionRepository>,
  ) -> Self {
    self.database = Some((rows, schema));
    self
  }

  /// Category opt-outs govern optional notification mail only. A failed lookup
  /// suppresses mail; the caller has already persisted the Inbox notification.
  #[tracing::instrument(skip_all)]
  pub async fn prepare(&self, recipient: Uuid, kind: &str, payload: &Value) -> AuthResult<Option<TemplateMail>> {
    let record = self.auth.get_user_preferences(recipient).await?;
    let preferences = record.values.resolve(&self.mail_defaults);
    if !NotificationEmailCategory::from_notification_type(kind).enabled(&preferences) {
      return Ok(None);
    }
    self
      .project_with_presentation(
        recipient,
        kind,
        payload,
        MailPresentation::from_preferences(&preferences, None),
      )
      .await
  }

  /// Queued names and URLs are not authority for document/workspace messages.
  /// Removed members receive only the workspace access-change notice; readable
  /// document content requires a fresh permission check immediately before SMTP.
  #[tracing::instrument(skip_all)]
  pub async fn project(&self, recipient: Uuid, kind: &str, payload: &Value) -> AuthResult<Option<TemplateMail>> {
    let preferences = self
      .auth
      .get_user_preferences(recipient)
      .await?
      .values
      .resolve(&self.mail_defaults);
    self
      .project_with_presentation(
        recipient,
        kind,
        payload,
        MailPresentation::from_preferences(&preferences, None),
      )
      .await
  }

  async fn project_with_presentation(
    &self,
    recipient: Uuid,
    kind: &str,
    payload: &Value,
    presentation: MailPresentation,
  ) -> AuthResult<Option<TemplateMail>> {
    let Some(user) = self.auth.get_user_by_id(recipient).await?.filter(|user| !user.disabled) else {
      return Ok(None);
    };
    let template = match kind {
      "invite" | "invitation" | "workspace_invitation" => MailTemplate::WorkspaceInvitation,
      "invitation_accepted" => MailTemplate::InvitationAccepted,
      "invitation_review_request" => MailTemplate::InvitationReviewRequest,
      "invitation_review_approved" => MailTemplate::InvitationReviewApproved,
      "invitation_review_declined" => MailTemplate::InvitationReviewDeclined,
      "member_added" => MailTemplate::MemberAdded,
      "member_removed" => MailTemplate::MemberRemoved,
      "role_changed" => MailTemplate::RoleChanged,
      "mention" | "doc_mention" | "document_mention" | "comment_mention" => MailTemplate::CommentMention,
      "comment" | "comment_reply" => MailTemplate::CommentReply,
      "doc_shared" | "doc-shared" => MailTemplate::DocShared,
      "database.row.assigned" | "database_row_assigned" => MailTemplate::DatabaseRowAssigned,
      "database_row_reminder" => MailTemplate::DatabaseRowReminder,
      "calendar_reminder" => MailTemplate::CalendarReminder,
      _ => MailTemplate::GeneralNotification,
    };
    let mut context = json!({"url":"/"});
    let actor = [
      "actorUserId",
      "createdByUserId",
      "authorId",
      "addedByUserId",
      "acceptedByUserId",
      "inviterUserId",
      "inviterId",
    ]
    .iter()
    .find_map(|key| uuid(payload, key));
    if let Some(actor) = actor.and_then(|id| (id != recipient).then_some(id))
      && let Some(actor) = self.auth.get_user_by_id(actor).await?
    {
      context["actor"] = json!(actor.name);
    }
    if let Some((workspace, doc, permission)) = &self.services {
      if let Some(workspace_id) = uuid(payload, "workspaceId") {
        let Some(space) = workspace
          .get_workspace(workspace_id)
          .await?
          .filter(|space| space.deleted_at.is_none())
        else {
          return Ok(None);
        };
        let member = workspace.get_member(workspace_id, recipient).await?;
        let active = member
          .as_ref()
          .is_some_and(|member| member.status == MembershipStatus::Accepted);
        let valid = match template {
          MailTemplate::WorkspaceInvitation => member
            .as_ref()
            .is_some_and(|member| member.status == MembershipStatus::Pending),
          MailTemplate::InvitationReviewRequest => {
            active
              && member
                .as_ref()
                .is_some_and(|member| member.role >= WorkspaceRole::Admin)
          }
          MailTemplate::MemberRemoved | MailTemplate::InvitationReviewDeclined => !active,
          MailTemplate::CommentMention | MailTemplate::CommentReply | MailTemplate::DocShared => true,
          _ => active,
        };
        if !valid {
          return Ok(None);
        }
        if template == MailTemplate::InvitationReviewRequest {
          let Some(applicant) = uuid(payload, "reviewUserId") else {
            return Ok(None);
          };
          if workspace
            .get_member(workspace_id, applicant)
            .await?
            .is_none_or(|member| member.status != MembershipStatus::UnderReview)
          {
            return Ok(None);
          }
        }
        if template == MailTemplate::RoleChanged
          && let Some(expected) = payload["role"].as_str()
          && member
            .as_ref()
            .is_none_or(|member| format!("{:?}", member.role) != expected)
        {
          return Ok(None);
        }
        context["workspace_name"] = json!(space.name);
        let invite_id = member.as_ref().map(|member| member.invite_id);
        if let Some(member) = member {
          context["role"] = json!(format!("{:?}", member.role));
        }
        context["url"] = json!(format!("/workspace/{workspace_id}/inbox"));
        if matches!(
          template,
          MailTemplate::MemberRemoved | MailTemplate::InvitationReviewDeclined
        ) {
          context["url"] = json!("/");
        }
        if template == MailTemplate::WorkspaceInvitation
          && let Some(invite) = invite_id
        {
          context["url"] = json!(format!("/invite/{invite}"));
        }
        if let Some(doc_id) = uuid(payload, "docId") {
          let Some(document) = doc
            .get_metadata(doc_id)
            .await?
            .filter(|doc| !doc.blocked && doc.deleted_at.is_none() && doc.workspace_id == Some(workspace_id))
          else {
            return Ok(None);
          };
          if !permission
            .get_effective_doc_role(recipient, workspace_id, doc_id)
            .await?
            .can(DocAction::Read)
          {
            return Ok(None);
          }
          context["document_title"] = json!(document.title);
          // URL path segments are encoded independently, including arbitrary external document keys.
          context["url"] = json!(format!(
            "/workspace/{workspace_id}/{}",
            url_segment(&document.external_id)
          ));
        }
      } else if matches!(
        template,
        MailTemplate::CommentMention | MailTemplate::CommentReply | MailTemplate::DocShared
      ) {
        return Ok(None);
      }
    }
    if matches!(
      template,
      MailTemplate::DatabaseRowAssigned | MailTemplate::DatabaseRowReminder
    ) {
      let Some(workspace) = uuid(payload, "workspaceId") else {
        return Ok(None);
      };
      let Some(database) = uuid(payload, "databaseId") else {
        return Ok(None);
      };
      let Some(row) = uuid(payload, "rowId") else {
        return Ok(None);
      };
      if template == MailTemplate::DatabaseRowAssigned && payload.get("taskNotificationEventId").is_some() {
        if self.database.is_none() {
          return Ok(None);
        }
        let Some((title, field)) = self
          .current_database_target(recipient, workspace, database, row, false, true)
          .await?
        else {
          return Ok(None);
        };
        context["row_title"] = json!(title);
        context["field_name"] = json!(field);
      } else {
        for key in ["rowTitle", "fieldName"] {
          if payload[key].as_str().is_none() {
            return Err(crate::auth::AuthError::InvalidInput(format!(
              "Missing database mail field: {key}"
            )));
          }
        }
        if template == MailTemplate::DatabaseRowReminder {
          chrono::DateTime::parse_from_rfc3339(payload["scheduledFor"].as_str().unwrap_or_default())
            .map_err(|_| crate::auth::AuthError::InvalidInput("Invalid database mail scheduledFor".into()))?;
        }
        context["row_title"] = payload["rowTitle"].clone();
        context["field_name"] = payload["fieldName"].clone();
      }
      context["scheduled_label"] = payload["scheduledFor"].clone();
      context["url"] = json!(format!("/workspace/{workspace}/databases/{database}?rowId={row}"));
    }
    if template == MailTemplate::CalendarReminder {
      context["event_title"] = payload["event_title"].clone();
      context["starts_at"] = payload["starts_at"].clone();
      context["all_day"] = payload["all_day"].clone();
      if let Some(workspace) = uuid(payload, "workspaceId") {
        context["url"] = json!(format!("/workspace/{workspace}/journals"));
      }
    }
    Ok(Some(TemplateMail::new(&user.email, template, presentation, context)))
  }
}

fn uuid(value: &Value, key: &str) -> Option<Uuid> {
  value.get(key)?.as_str()?.parse().ok()
}

fn url_segment(value: &str) -> String {
  value
    .bytes()
    .map(|byte| {
      if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
        (byte as char).to_string()
      } else {
        format!("%{byte:02X}")
      }
    })
    .collect()
}
