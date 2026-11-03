-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_target_shape;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master','document_review','calendar_reminder','database_reminder'),false)
  AND (target_json->>'kind' IN ('calendar_master','calendar_reminder') OR workspace_id IS NOT NULL)
  AND (target_json->>'kind'<>'calendar_master' OR
    (next_nominal IS NULL AND next_due_at IS NULL AND next_admission_at IS NULL))
  AND (target_json->>'kind'<>'document_review' OR
    (rule_json IS NULL AND COALESCE(jsonb_typeof(target_json->'enabled')='boolean',false)
      AND target_json->>'document_id' IS NOT NULL AND target_json->>'confirmed_by' IS NOT NULL))
  AND (target_json->>'kind'<>'calendar_reminder' OR
    (rule_json IS NULL AND target_json->>'definition_id' IS NOT NULL AND target_json->>'event_id' IS NOT NULL))
  AND (target_json->>'kind'<>'database_reminder' OR
    (rule_json IS NULL AND target_json->>'reminder_id' IS NOT NULL)));

-- Pending legacy claims keep their generation/trigger and remain replayable by
-- already queued native notification envelopes. Exclusive old-process tokens
-- lose their meaning under the mandatory all-instance stop: shared SQL/outbox
-- admission recovers that same pending generation without an expiry sweep.
INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,
  lifecycle,generation,revision,next_nominal,next_due_at,next_admission_at)
SELECT r.id,r.workspace_id,r.user_id,'UTC',
  jsonb_build_object('kind','database_reminder','reminder_id',r.id),
  CASE WHEN r.status IN('scheduled','claimed') THEN 'active' ELSE 'ended' END,
  r.schedule_revision,r.schedule_revision,
  jsonb_build_object('kind','local_date_time','value',to_char(r.trigger_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')),
  r.trigger_at,r.trigger_at
FROM database_row_reminders r;

-- The native public status/fired/cancelled facts stay native. Existing API
-- triggerAt/scheduleRevision project next_due_at/generation from the shared
-- owner; an ended one-shot retains those immutable facts for queued/history reads.
ALTER TABLE database_row_reminders DROP CONSTRAINT database_row_reminders_check;
DROP INDEX idx_database_row_reminders_due;
DROP INDEX idx_database_row_reminders_expired_claim;
DROP INDEX idx_database_row_reminders_owner_target;
ALTER TABLE database_row_reminders
  DROP COLUMN trigger_at,
  DROP COLUMN schedule_revision,
  DROP COLUMN claim_token,
  DROP COLUMN claim_expires_at,
  DROP COLUMN claim_attempts;
CREATE INDEX idx_database_row_reminders_owner_target
  ON database_row_reminders(user_id,database_id,row_id,field_id);

ALTER TABLE database_row_reminders ADD CONSTRAINT database_reminder_shared_owner
  FOREIGN KEY(id) REFERENCES scheduling_schedules(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION remove_database_reminder_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM scheduling_schedules WHERE id=OLD.id AND target_json->>'kind'='database_reminder';
  RETURN NULL;
END $$;
CREATE TRIGGER database_reminder_deleted AFTER DELETE ON database_row_reminders
  FOR EACH ROW EXECUTE FUNCTION remove_database_reminder_schedule();

-- The old claim batch/timer have no remaining executor. Shared admission uses
-- its existing global scan/time budget and restart-bound cadence.
DELETE FROM app_configs WHERE id IN (
  'worker.polling.database_reminder_interval_ms','databases.reminder_batch_size');

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','calendar_reminder_due',
  'database_reminder_due','database_task_notification','workspace_automation_trigger',
  'workspace_automation_signal','task_recurrence_due'));
