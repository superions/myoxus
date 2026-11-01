//! Notification-queue consumption for personal Database Row reminders.

use myoxus_application::database::{DatabaseReminderService, DatabaseRowReminderDispatchEnvelope};
use myoxus_application::notification::NotificationService;
use myoxus_domain::entities::Notification;
use myoxus_worker::JobError;
use serde_json::Value;

/// Validate an internal Reminder dispatch immediately before persistence.
///
/// Keeping the generation/access check and NotificationService handoff in one
/// function prevents a queued job from publishing stale Row metadata after a
/// DateTime edit, Task completion, target deletion or membership change. The
/// Redis envelope is never persisted; `validate_database_row_reminder_dispatch` returns the
/// bounded display/navigation payload.
#[tracing::instrument(skip_all)]
pub async fn dispatch_database_row_reminder_notification(
  notification_service: &NotificationService,
  adapter: Option<&crate::websocket::redis_adapter::RedisWsAdapter>,
  reminder_service: Option<&DatabaseReminderService>,
  data: &Value,
) -> Result<Option<Notification>, JobError> {
  let envelope: DatabaseRowReminderDispatchEnvelope =
    serde_json::from_value(data.get("dispatch").cloned().unwrap_or_default())
      .map_err(|_| JobError::Permanent("invalid database reminder dispatch envelope".into()))?;
  let Some(reminder_service) = reminder_service else {
    return Err(JobError::Retryable(
      "database reminder service is not configured".to_string(),
    ));
  };
  let Some(payload) = reminder_service
    .validate_database_row_reminder_dispatch(&envelope)
    .await
    .map_err(|_| JobError::Retryable("database reminder eligibility lookup failed".into()))?
  else {
    tracing::info!(
      reminder_id = %envelope.reminder_id,
      workspace_id = %envelope.workspace_id,
      database_id = %envelope.database_id,
      row_id = %envelope.row_id,
      field_id = %envelope.field_id,
      user_id = %envelope.user_id,
      schedule_revision = envelope.schedule_revision,
      trigger_at = %envelope.trigger_at,
      reason = "generation_target_or_task_state_changed",
      "database_reminder_stale_dispatch"
    );
    return Ok(None);
  };

  let notification = notification_service
    .create_notification(
      envelope.user_id,
      "database_row_reminder".to_string(),
      Some("default".to_string()),
      data["idempotencyKey"].as_str().map(str::to_string),
      payload,
    )
    .await
    .map_err(|_| JobError::Retryable("database reminder notification persistence failed".into()))?;
  crate::websocket::publish_user_notification(
    adapter,
    envelope.user_id,
    "notification_new",
    serde_json::json!({
      "notificationId": notification.id,
      "notificationType": notification.notification_type,
      "payload": notification.payload,
    }),
  )
  .await;
  Ok(Some(notification))
}
