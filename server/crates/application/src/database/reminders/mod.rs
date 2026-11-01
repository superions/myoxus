// SPDX-License-Identifier: AGPL-3.0-or-later
//! Personal reminder commands and native dispatch admission.
use super::*;
use std::time::Instant;

#[derive(Clone)]
pub struct DatabaseReminderService {
  pub(super) schema_repo: Arc<dyn DatabaseDefinitionRepository>,
  pub(super) row_repo: Arc<dyn DatabaseEditingRepository>,
  pub(super) reminder_repo: Arc<dyn DatabaseReminderRepository>,
  pub(super) permission: Arc<PermissionService>,
  pub(super) limits: DatabaseLimits,
  pub(super) effects: DatabaseMutationEffects,
  pub(super) job_queue: DatabaseCapability<Arc<dyn DatabaseJobEnqueuer>>,
}

impl DatabaseReminderService {
  /// Derive the durable UTC trigger for a personal Database Row reminder.
  /// Timed values use their stored instant. All-day values intentionally use
  /// 09:00 in the Cell's IANA timezone rather than inventing a midnight event.
  pub(crate) fn database_row_reminder_trigger_at(
    value: &DatabaseDateTimeValue,
    offset_minutes: i64,
  ) -> DatabaseResult<DateTime<Utc>> {
    database_row_reminder_trigger_at(value, offset_minutes)
      .map_err(|message| DatabaseServiceError::new(ERR_REMINDER_INVALID, message))
  }

  pub(super) async fn database_row_reminder_reschedules(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: &DatabaseDateTimeValue,
  ) -> DatabaseResult<Vec<DatabaseRowReminderReschedule>> {
    self
      .reminder_repo
      .list_live_database_row_reminders_for_cell(row_id, field_id)
      .await?
      .into_iter()
      .map(|reminder| {
        Ok(DatabaseRowReminderReschedule {
          reminder_id: reminder.id,
          expected_schedule_revision: reminder.schedule_revision,
          trigger_at: Self::database_row_reminder_trigger_at(value, reminder.offset_minutes)?,
        })
      })
      .collect()
  }

  async fn database_row_reminder_target(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> DatabaseResult<(DatabaseRecord, DatabaseRowRecord, DatabaseDateTimeValue)> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let row = self
      .row_repo
      .get_row(row_id)
      .await?
      .filter(|row| row.row.database_id == database_id && row.row.deleted_at.is_none())
      .ok_or_else(|| DatabaseServiceError::new(ERR_REMINDER_INVALID, "database reminder Row is invalid"))?;
    let field = record
      .fields
      .iter()
      .find(|field| field.id == field_id && field.field_type == DatabaseFieldType::DateTime)
      .ok_or_else(|| DatabaseServiceError::new(ERR_REMINDER_INVALID, "database reminder field is invalid"))?;
    let DatabaseFieldConfig::DateTime(config) = &field.config else {
      return Err(DatabaseServiceError::new(
        ERR_REMINDER_INVALID,
        "database reminder field config is invalid",
      ));
    };
    if !config.allow_reminders {
      return Err(DatabaseServiceError::new(
        ERR_REMINDER_DISABLED,
        "personal reminders are disabled for this field",
      ));
    }
    let value = row
      .cells
      .iter()
      .find(|cell| cell.field_id == field_id)
      .and_then(|cell| match &cell.value {
        DatabaseCellValueData::DateTime(value) => Some(value.clone()),
        _ => None,
      })
      .ok_or_else(|| DatabaseServiceError::new(ERR_REMINDER_INVALID, "database reminder requires a date"))?;
    Ok((record, row, value))
  }
  #[instrument(skip(self), fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, field_id = %field_id, offset_minutes))]
  pub async fn set_database_row_reminder(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    offset_minutes: i64,
  ) -> DatabaseResult<DatabaseRowReminder> {
    if offset_minutes > self.limits.max_reminder_offset_minutes {
      return Err(DatabaseServiceError::new(
        ERR_REMINDER_LIMIT,
        "database reminder offset exceeds the configured limit",
      ));
    }
    let (record, row, value) = self
      .database_row_reminder_target(actor, database_id, row_id, field_id)
      .await?;
    if record.database.profile_kind == DatabaseProfileKind::Project && row.row.row_kind == DatabaseRowKind::Task {
      let status_field = record
        .field_roles
        .iter()
        .find(|role| role.role_key == "task.status" && role.row_kind_scope.as_deref() == Some("task"))
        .and_then(|role| {
          record
            .fields
            .iter()
            .find(|field| field.id == role.field_id && field.field_type == DatabaseFieldType::Status)
        });
      let open = status_field.is_some_and(|field| {
        let DatabaseFieldConfig::Status(config) = &field.config else {
          return false;
        };
        let value = row
          .cells
          .iter()
          .find(|cell| cell.field_id == field.id)
          .map(|cell| &cell.value);
        database_task_status_allows_reminders(config, value)
      });
      if !open {
        return Err(DatabaseServiceError::new(
          ERR_REMINDER_INVALID,
          "database reminder Task is not open",
        ));
      }
    }
    let trigger_at = Self::database_row_reminder_trigger_at(&value, offset_minutes)?;
    if trigger_at <= Utc::now() {
      return Err(DatabaseServiceError::new(
        ERR_REMINDER_PAST,
        "database reminder trigger must be in the future",
      ));
    }
    let existing = self
      .reminder_repo
      .list_database_row_reminders(database_id, row_id, field_id, actor)
      .await?;
    if existing
      .iter()
      .all(|reminder| reminder.offset_minutes != offset_minutes)
      && existing.len() >= self.limits.max_reminders_per_user_per_cell
    {
      return Err(DatabaseServiceError::new(
        ERR_REMINDER_LIMIT,
        "database reminder count exceeds the configured limit",
      ));
    }
    let now = Utc::now();
    let reminder = self
      .reminder_repo
      .upsert_database_row_reminder(DatabaseRowReminder {
        id: Uuid::new_v4(),
        workspace_id: record.database.workspace_id,
        database_id,
        row_id,
        field_id,
        user_id: actor,
        offset_minutes,
        trigger_at,
        status: DatabaseRowReminderStatus::Scheduled,
        schedule_revision: 1,
        claim_token: None,
        claim_expires_at: None,
        claim_attempts: 0,
        fired_at: None,
        cancelled_at: None,
        created_at: now,
        updated_at: now,
      })
      .await?;
    self
      .effects
      .record_audit(
        "database.row.reminder.set",
        AuditCategory::Database,
        Some(AuditTarget::entity("database_row", row_id, Some(row.row.title))),
        actor,
        None,
        Some(serde_json::json!({
          "reminderId": reminder.id,
          "fieldId": field_id,
          "offsetMinutes": offset_minutes,
          "triggerAt": trigger_at,
        })),
      )
      .await;
    info!(
      reminder_id = %reminder.id,
      workspace_id = %reminder.workspace_id,
      database_id = %reminder.database_id,
      row_id = %reminder.row_id,
      field_id = %reminder.field_id,
      user_id = %reminder.user_id,
      trigger_at = %reminder.trigger_at,
      "database row reminder set"
    );
    Ok(reminder)
  }

  pub async fn list_database_row_reminders(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> DatabaseResult<Vec<DatabaseRowReminder>> {
    self
      .database_row_reminder_target(actor, database_id, row_id, field_id)
      .await?;
    self
      .reminder_repo
      .list_database_row_reminders(database_id, row_id, field_id, actor)
      .await
      .map_err(Into::into)
  }

  #[instrument(skip(self), fields(actor_id = %actor, database_id = %database_id, reminder_id = %reminder_id))]
  pub async fn delete_database_row_reminder(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    reminder_id: Uuid,
  ) -> DatabaseResult<()> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if !self
      .reminder_repo
      .cancel_database_row_reminder(database_id, reminder_id, actor, Utc::now())
      .await?
    {
      return Err(DatabaseServiceError::new(
        ERR_REMINDER_NOT_FOUND,
        "database reminder not found",
      ));
    }
    self
      .effects
      .record_audit(
        "database.row.reminder.delete",
        AuditCategory::Database,
        Some(AuditTarget::entity(
          "database",
          database_id,
          Some(record.database.title),
        )),
        actor,
        Some(serde_json::json!({ "reminderId": reminder_id })),
        None,
      )
      .await;
    info!(
      reminder_id = %reminder_id,
      database_id = %database_id,
      user_id = %actor,
      "database row reminder deleted"
    );
    Ok(())
  }

  fn database_row_reminder_display_payload(dispatch: &DatabaseRowReminderDispatch) -> serde_json::Value {
    serde_json::json!({
      "workspaceId": dispatch.reminder.workspace_id,
      "databaseId": dispatch.reminder.database_id,
      "rowId": dispatch.reminder.row_id,
      "rowTitle": dispatch.row_title,
      "fieldId": dispatch.reminder.field_id,
      "fieldName": dispatch.field_name,
      "scheduledFor": dispatch.scheduled_for,
      "triggerAt": dispatch.reminder.trigger_at,
      "offsetMinutes": dispatch.reminder.offset_minutes,
    })
  }

  /// Claim due reminders and enqueue the existing notification queue. The
  /// notification worker performs a second generation/ACL check immediately
  /// before persistence, closing the race with a later Cell edit or deletion.
  #[instrument(skip(self), fields(limit))]
  pub async fn fire_due_database_row_reminders(
    &self,
    limit: i64,
  ) -> DatabaseResult<DatabaseRowReminderDispatchOutcome> {
    let started_at = Instant::now();
    let now = Utc::now();
    let released_expired = self
      .reminder_repo
      .release_expired_database_row_reminder_claims(now)
      .await?;
    let claims = self
      .reminder_repo
      .claim_due_database_row_reminders(
        now,
        now + Duration::minutes(5),
        limit.clamp(1, self.limits.reminder_batch_size),
      )
      .await?;
    let mut outcome = DatabaseRowReminderDispatchOutcome {
      claimed_count: claims.len(),
      ..Default::default()
    };
    let queue = self.job_queue.as_ref().cloned().ok_or_else(|| {
      DatabaseServiceError::new(ERR_STORAGE, "database reminder notification queue is not configured")
    })?;
    for reminder in claims {
      let Some(claim_token) = reminder.claim_token else {
        outcome.failed_count += 1;
        continue;
      };
      let dispatch = self
        .reminder_repo
        .get_database_row_reminder_dispatch(
          reminder.id,
          reminder.schedule_revision,
          reminder.trigger_at,
          reminder.user_id,
        )
        .await?;
      let Some(dispatch) = dispatch else {
        if self
          .reminder_repo
          .cancel_database_row_reminder_generation(reminder.id, reminder.schedule_revision, now)
          .await?
        {
          outcome.cancelled_count += 1;
        }
        info!(
          reminder_id = %reminder.id,
          workspace_id = %reminder.workspace_id,
          database_id = %reminder.database_id,
          row_id = %reminder.row_id,
          field_id = %reminder.field_id,
          user_id = %reminder.user_id,
          trigger_at = %reminder.trigger_at,
          reason = "target_unavailable",
          "database reminder dispatch cancelled"
        );
        continue;
      };
      let envelope = DatabaseRowReminderDispatchEnvelope {
        reminder_id: reminder.id,
        workspace_id: reminder.workspace_id,
        database_id: reminder.database_id,
        row_id: reminder.row_id,
        field_id: reminder.field_id,
        schedule_revision: reminder.schedule_revision,
        trigger_at: reminder.trigger_at,
        user_id: reminder.user_id,
      };
      let payload = serde_json::json!({
        "userId": reminder.user_id,
        "notificationType": "database_row_reminder",
        "level": "default",
        "idempotencyKey": format!(
          "database.row.reminder:{}:{}",
          reminder.id,
          reminder.trigger_at.timestamp()
        ),
        "dispatch": envelope,
        "payload": Self::database_row_reminder_display_payload(&dispatch),
      });
      if let Err(error) = queue
        .enqueue("notification", "notification.sendDatabaseRowReminder", payload, 0)
        .await
      {
        self
          .reminder_repo
          .release_database_row_reminder_claim(reminder.id, reminder.schedule_revision, claim_token)
          .await?;
        outcome.failed_count += 1;
        warn!(
          reminder_id = %reminder.id,
          workspace_id = %reminder.workspace_id,
          database_id = %reminder.database_id,
          row_id = %reminder.row_id,
          field_id = %reminder.field_id,
          user_id = %reminder.user_id,
          trigger_at = %reminder.trigger_at,
          error_code = ERR_STORAGE,
          error = %error,
          "database reminder notification enqueue failed"
        );
        continue;
      }
      if self
        .reminder_repo
        .mark_database_row_reminder_enqueued(reminder.id, reminder.schedule_revision, claim_token, Utc::now())
        .await?
      {
        outcome.enqueued_count += 1;
        self
          .effects
          .record_audit(
            "database.row.reminder.fire",
            AuditCategory::Database,
            Some(AuditTarget::entity(
              "database_row",
              reminder.row_id,
              Some(dispatch.row_title.clone()),
            )),
            reminder.user_id,
            None,
            Some(serde_json::json!({
              "reminderId": reminder.id,
              "fieldId": reminder.field_id,
              "triggerAt": reminder.trigger_at,
              "scheduleRevision": reminder.schedule_revision,
            })),
          )
          .await;
        info!(
          reminder_id = %reminder.id,
          workspace_id = %reminder.workspace_id,
          database_id = %reminder.database_id,
          row_id = %reminder.row_id,
          field_id = %reminder.field_id,
          user_id = %reminder.user_id,
          trigger_at = %reminder.trigger_at,
          "database reminder notification enqueued"
        );
      }
    }
    info!(
      claimed_count = outcome.claimed_count,
      enqueued_count = outcome.enqueued_count,
      fired_count = outcome.enqueued_count,
      cancelled_count = outcome.cancelled_count,
      failed_count = outcome.failed_count,
      released_expired,
      duration_ms = started_at.elapsed().as_millis() as u64,
      "database reminder dispatch batch complete"
    );
    Ok(outcome)
  }

  pub async fn validate_database_row_reminder_dispatch(
    &self,
    envelope: &DatabaseRowReminderDispatchEnvelope,
  ) -> DatabaseResult<Option<serde_json::Value>> {
    let dispatch = self
      .reminder_repo
      .get_database_row_reminder_dispatch(
        envelope.reminder_id,
        envelope.schedule_revision,
        envelope.trigger_at,
        envelope.user_id,
      )
      .await?
      .filter(|dispatch| {
        dispatch.reminder.workspace_id == envelope.workspace_id
          && dispatch.reminder.database_id == envelope.database_id
          && dispatch.reminder.row_id == envelope.row_id
          && dispatch.reminder.field_id == envelope.field_id
      });
    if dispatch.is_none() {
      self
        .reminder_repo
        .cancel_database_row_reminder_generation(envelope.reminder_id, envelope.schedule_revision, Utc::now())
        .await?;
    }
    Ok(dispatch.as_ref().map(Self::database_row_reminder_display_payload))
  }
}
