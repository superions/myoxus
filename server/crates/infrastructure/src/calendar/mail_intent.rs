// SPDX-License-Identifier: AGPL-3.0-or-later
//! Scheduling intent shares the authored event transaction, including deletion.

use super::*;
use serde_json::json;

use myoxus_domain::calendar_scheduling::{
  CalendarSchedulingFacts, CalendarSchedulingRecipient, CalendarSchedulingState, plan_scheduling, scheduling_eligible,
  scheduling_organizer,
};

fn map_state(row: &sqlx::postgres::PgRow) -> CalendarSchedulingState {
  CalendarSchedulingState {
    sequence: row.get("sequence"),
    fingerprint: row.get("fingerprint"),
    event_snapshot: row.get("event_snapshot"),
    recipients: row.get("recipients"),
  }
}

pub(super) async fn load_event(
  tx: &mut sqlx::Transaction<'_, Postgres>,
  id: Uuid,
) -> RepoResult<Option<CalendarEvent>> {
  // Reminder admission owns master→detached-event lock order. Native child
  // edits join the same order before holding their own event row lock.
  let parent: Option<Uuid> = sqlx::query_scalar("SELECT recurrence_parent_id FROM calendar_events WHERE id=$1")
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?
    .flatten();
  if let Some(parent) = parent {
    sqlx::query("SELECT id FROM calendar_events WHERE id=$1 FOR UPDATE")
      .bind(parent)
      .fetch_one(&mut **tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
  }
  let row = sqlx::query("SELECT *, origin::text AS origin FROM calendar_events WHERE id = $1 FOR UPDATE")
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
  let Some(row) = row else { return Ok(None) };
  let mut event = SqlxCalendarRepository::map_event_base(row);
  let participants = sqlx::query("SELECT * FROM calendar_event_participants WHERE event_id = $1 ORDER BY email, id")
    .bind(id)
    .fetch_all(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
  event.participants = participants
    .into_iter()
    .map(|row| CalendarEventParticipant {
      id: row.get("id"),
      event_id: id,
      user_id: row.get("user_id"),
      email: row.get("email"),
      display_name: row.get("display_name"),
      response_status: row.get("response_status"),
      is_organizer: row.get("is_organizer"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
    .collect();
  event.reminders = super::reminders::definitions_in(&mut **tx, id).await?;
  Ok(Some(event))
}

/// Row locks serialize sequence changes. Detached cancellation payloads retain
/// the UID, recipients and projection after event/FK rows disappear.
pub(super) async fn enqueue(
  tx: &mut sqlx::Transaction<'_, Postgres>,
  event: &CalendarEvent,
  kind: &str,
  instance_start: Option<DateTime<Utc>>,
) -> RepoResult<()> {
  let mut event = event.clone();
  super::projection::attach_timing_in(tx, &mut event).await?;
  let event = &event;
  let previous = sqlx::query("SELECT * FROM calendar_mail_state WHERE event_id = $1 FOR UPDATE")
    .bind(event.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
  let parent = if let Some(parent_id) = event.recurrence_parent_id {
    sqlx::query("SELECT * FROM calendar_mail_state WHERE event_id = $1 FOR UPDATE")
      .bind(parent_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?
  } else {
    None
  };
  if !scheduling_eligible(event, kind, previous.is_some()) {
    return Ok(());
  }
  let fallback_organizer = if event.participants.iter().any(|participant| participant.is_organizer) {
    String::new()
  } else {
    sqlx::query_scalar::<_, String>(
      "SELECT users.email FROM users WHERE users.id = COALESCE(\
      (SELECT user_id FROM calendar_accounts WHERE id = $1), (SELECT owner_user_id FROM workspaces WHERE id = $2))",
    )
    .bind(event.account_id)
    .bind(event.workspace_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?
    .unwrap_or_default()
  };
  let account_owner_email: Option<String> = if event.origin == CalendarEventOrigin::External {
    sqlx::query_scalar("SELECT u.email FROM calendar_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=$1")
      .bind(event.account_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?
  } else {
    None
  };
  let Some(organizer_email) = scheduling_organizer(event, fallback_organizer, account_owner_email.as_deref()) else {
    return Ok(());
  };
  let mut workspace_members = Vec::new();
  if event.all_members
    && let Some(workspace) = event.workspace_id
  {
    let members = sqlx::query(
      "SELECT users.id, users.email FROM workspace_memberships m JOIN users ON users.id = m.user_id \
      WHERE m.workspace_id = $1 AND m.status = 'Accepted' AND users.status = 'active' ORDER BY users.id",
    )
    .bind(workspace)
    .fetch_all(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
    workspace_members = members
      .into_iter()
      .map(|member| CalendarSchedulingRecipient {
        email: member.get("email"),
        user_id: Some(member.get("id")),
      })
      .collect();
  }
  let previous = previous.as_ref().map(map_state);
  let parent = parent.as_ref().map(map_state);
  let Some(plan) = plan_scheduling(CalendarSchedulingFacts {
    event,
    kind,
    instance_start,
    previous: previous.as_ref(),
    parent: parent.as_ref(),
    organizer_email,
    workspace_members,
  })?
  else {
    return Ok(());
  };
  for intent in plan.intents {
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'calendar',$2,'calendar_mail',$3)")
      .bind(Uuid::new_v4()).bind(event.id.to_string()).bind(intent).execute(&mut **tx).await
      .map_err(SqlxCalendarRepository::map_db_err)?;
  }
  // Whole-event cancellation is followed by FK deletion; instance cancellation
  // retains the master sequence and its complete recipient set.
  sqlx::query(
    "INSERT INTO calendar_mail_state(event_id,sequence,fingerprint,event_snapshot,recipients) VALUES ($1,$2,$3,$4,$5) \
    ON CONFLICT(event_id) DO UPDATE SET sequence=EXCLUDED.sequence,fingerprint=EXCLUDED.fingerprint,\
    event_snapshot=EXCLUDED.event_snapshot,recipients=EXCLUDED.recipients,updated_at=now()",
  )
  .bind(event.id)
  .bind(plan.sequence)
  .bind(plan.fingerprint)
  .bind(
    serde_json::to_value(plan.state_snapshot)
      .map_err(|_| RepositoryError::Storage("Calendar mail projection failed".into()))?,
  )
  .bind(json!(plan.recipients))
  .execute(&mut **tx)
  .await
  .map_err(SqlxCalendarRepository::map_db_err)?;
  if let Some(parent_id) = event.recurrence_parent_id {
    sqlx::query("UPDATE calendar_mail_state SET sequence=$2,updated_at=now() WHERE event_id=$1")
      .bind(parent_id)
      .bind(plan.sequence)
      .execute(&mut **tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
  }
  Ok(())
}
