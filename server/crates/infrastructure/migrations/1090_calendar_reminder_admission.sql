-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Settings retain native definition IDs; the old rows/recipient receipts become
-- the first delivery of that definition, not newly replayed notifications.
CREATE TABLE calendar_reminder_definitions (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  channel text NOT NULL,
  minutes_before integer NOT NULL,
  first_instance_start timestamptz NOT NULL,
  scheduled_for timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX calendar_reminder_definitions_event ON calendar_reminder_definitions(event_id,id);
INSERT INTO calendar_reminder_definitions
  (id,event_id,channel,minutes_before,first_instance_start,scheduled_for,created_at,updated_at)
SELECT r.id,r.event_id,r.channel,r.minutes_before,e.starts_at,r.scheduled_for,r.created_at,r.updated_at
FROM calendar_reminders r JOIN calendar_events e ON e.id=r.event_id;
ALTER TABLE calendar_reminders ADD COLUMN definition_id uuid REFERENCES calendar_reminder_definitions(id) ON DELETE CASCADE;
ALTER TABLE calendar_reminders ADD COLUMN instance_start timestamptz;
ALTER TABLE calendar_reminders ADD COLUMN occurrence_start timestamptz;
ALTER TABLE calendar_reminders ADD COLUMN occurrence_end timestamptz;
ALTER TABLE calendar_reminders ADD COLUMN occurrence_all_day boolean NOT NULL DEFAULT false;
ALTER TABLE calendar_reminders ADD COLUMN override_title text;
ALTER TABLE calendar_reminders ADD COLUMN imported_delivery boolean NOT NULL DEFAULT false;
ALTER TABLE calendar_reminders ADD COLUMN scheduling_generation bigint NOT NULL DEFAULT 1 CHECK(scheduling_generation>0);
UPDATE calendar_reminders r SET definition_id=r.id,instance_start=d.first_instance_start,imported_delivery=true,
  occurrence_start=e.starts_at,
  occurrence_end=e.ends_at,
  occurrence_all_day=COALESCE((e.payload->>'allDay')='true',false)
FROM calendar_reminder_definitions d JOIN calendar_events e ON e.id=d.event_id WHERE d.id=r.id;
ALTER TABLE calendar_reminders ALTER COLUMN definition_id SET NOT NULL;
ALTER TABLE calendar_reminders ALTER COLUMN instance_start SET NOT NULL;
ALTER TABLE calendar_reminders ALTER COLUMN occurrence_start SET NOT NULL;
ALTER TABLE calendar_reminders ALTER COLUMN occurrence_end SET NOT NULL;
CREATE UNIQUE INDEX calendar_reminder_original_slot ON calendar_reminders(definition_id,instance_start);

ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_target_shape;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master','document_review','calendar_reminder'),false)
  AND (target_json->>'kind' IN ('calendar_master','calendar_reminder') OR workspace_id IS NOT NULL)
  AND (target_json->>'kind'<>'calendar_master' OR
    (next_nominal IS NULL AND next_due_at IS NULL AND next_admission_at IS NULL))
  AND (target_json->>'kind'<>'document_review' OR
    (rule_json IS NULL AND COALESCE(jsonb_typeof(target_json->'enabled')='boolean',false)
      AND target_json->>'document_id' IS NOT NULL AND target_json->>'confirmed_by' IS NOT NULL))
  AND (target_json->>'kind'<>'calendar_reminder' OR
    (rule_json IS NULL AND target_json->>'definition_id' IS NOT NULL AND target_json->>'event_id' IS NOT NULL)));

INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,
  next_nominal,next_due_at,next_admission_at)
SELECT d.id,e.workspace_id,a.user_id,'UTC',
  jsonb_build_object('kind','calendar_reminder','definition_id',d.id,'event_id',e.id),
  jsonb_build_object('kind','local_date_time','value',to_char(d.first_instance_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')),
  d.first_instance_start,d.scheduled_for
FROM calendar_reminder_definitions d JOIN calendar_events e ON e.id=d.event_id
LEFT JOIN calendar_accounts a ON a.id=e.account_id;

-- Deleting a native definition atomically cancels its pending shared cursor.
-- Delivered native receipts retain the normal event/definition cascade policy.
CREATE FUNCTION remove_calendar_reminder_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM scheduling_schedules WHERE id=OLD.id AND target_json->>'kind'='calendar_reminder';
  RETURN NULL;
END $$;
CREATE TRIGGER calendar_reminder_definition_deleted AFTER DELETE ON calendar_reminder_definitions
  FOR EACH ROW EXECUTE FUNCTION remove_calendar_reminder_schedule();

-- The due sweep no longer owns timing; remove only its persisted override.
DELETE FROM app_configs WHERE id='worker.polling.calendar_reminder_interval_ms';

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','calendar_reminder_due','database_task_notification',
  'workspace_automation_trigger','workspace_automation_signal','task_recurrence_due'));
