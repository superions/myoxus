-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE scheduling_schedules ADD COLUMN pending_due_at timestamptz;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_pending_due_target
  CHECK (target_json->>'kind'='git_cron' OR pending_due_at IS NULL);
ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_target_shape;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master','document_review','calendar_reminder','database_reminder','git_cron'),false)
  AND (target_json->>'kind' IN ('calendar_master','calendar_reminder') OR workspace_id IS NOT NULL)
  AND (target_json->>'kind'<>'calendar_master' OR
    (next_nominal IS NULL AND next_due_at IS NULL AND next_admission_at IS NULL))
  AND (target_json->>'kind'<>'document_review' OR
    (rule_json IS NULL AND COALESCE(jsonb_typeof(target_json->'enabled')='boolean',false)
      AND target_json->>'document_id' IS NOT NULL AND target_json->>'confirmed_by' IS NOT NULL))
  AND (target_json->>'kind'<>'calendar_reminder' OR
    (rule_json IS NULL AND target_json->>'definition_id' IS NOT NULL AND target_json->>'event_id' IS NOT NULL))
  AND (target_json->>'kind'<>'database_reminder' OR
    (rule_json IS NULL AND target_json->>'reminder_id' IS NOT NULL))
  AND (target_json->>'kind'<>'git_cron' OR
    (rule_json IS NULL AND target_json->>'profile_id' IS NOT NULL
      AND (lifecycle<>'active' OR next_due_at IS NOT NULL))));

-- UTC slots, including the two distinct fall-back instants, retain identity.
-- Native Runs still own source/slot uniqueness; transfer does not enqueue them.
INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,
  lifecycle,next_nominal,next_due_at,next_admission_at,pending_due_at)
SELECT p.id,p.workspace_id,p.owner_id,COALESCE(p.cron_timezone,'UTC'),
  jsonb_build_object('kind','git_cron','profile_id',p.id),
  CASE WHEN p.enabled AND p.trigger_mode='Cron' THEN 'active' ELSE 'ended' END,
  CASE WHEN p.cron_next_scheduled_at IS NULL THEN NULL ELSE
    jsonb_build_object('kind','local_date_time','value',to_char(p.cron_next_scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')) END,
  p.cron_next_scheduled_at,
  CASE WHEN p.cron_next_scheduled_at IS NULL THEN NULL ELSE
    LEAST(p.cron_next_scheduled_at,COALESCE(p.cron_pending_misfire_scheduled_for,p.cron_next_scheduled_at)) END,
  p.cron_pending_misfire_scheduled_for
FROM git_sync_profiles p WHERE p.trigger_mode='Cron' OR EXISTS(
  SELECT 1 FROM git_sync_runs r WHERE r.profile_id=p.id AND r.trigger_source='Cron' AND r.scheduled_for IS NOT NULL);

-- Already accepted slots retain the stable native Run identity. No second Run
-- store or alternate receiver format is introduced. Active/failed/recovered
-- native Runs keep their own lifecycle and scheduled-slot uniqueness.
INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id)
SELECT r.id,r.profile_id,
  jsonb_build_object('kind','local_date_time','value',
    to_char(r.scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||
    CASE WHEN to_char(r.scheduled_for AT TIME ZONE 'UTC','US')='000000' THEN ''
      WHEN right(to_char(r.scheduled_for AT TIME ZONE 'UTC','US'),3)='000' THEN '.'||left(to_char(r.scheduled_for AT TIME ZONE 'UTC','US'),3)
      ELSE '.'||to_char(r.scheduled_for AT TIME ZONE 'UTC','US') END),
  r.scheduled_for,1,r.id
FROM git_sync_runs r WHERE r.trigger_source='Cron' AND r.scheduled_for IS NOT NULL;

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','calendar_reminder_due',
  'database_reminder_due','git_cron_due','database_task_notification','workspace_automation_trigger',
  'workspace_automation_signal','task_recurrence_due'));
INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
SELECT r.id,'git_cron',r.profile_id::text,'git_cron_due',
  jsonb_build_object('scheduleId',r.profile_id,'generation',1,'runId',r.id)
FROM git_sync_runs r WHERE r.trigger_source='Cron' AND r.scheduled_for IS NOT NULL AND r.status='Pending';

DROP INDEX git_sync_profiles_cron_due_idx;
ALTER TABLE git_sync_profiles DROP CONSTRAINT git_sync_profiles_cron_contract;
ALTER TABLE git_sync_profiles DROP COLUMN cron_next_scheduled_at,
  DROP COLUMN cron_pending_misfire_scheduled_for;
ALTER TABLE git_sync_profiles ADD CONSTRAINT git_sync_profiles_cron_definition CHECK (
  (trigger_mode='Cron' AND cron_expression IS NOT NULL AND length(trim(cron_expression))>0
    AND cron_timezone IS NOT NULL AND length(trim(cron_timezone))>0
    AND cron_misfire_policy IN('Skip','RunOnce'))
  OR (trigger_mode<>'Cron' AND cron_expression IS NULL AND cron_timezone IS NULL AND cron_misfire_policy IS NULL));

CREATE FUNCTION remove_git_cron_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM scheduling_schedules WHERE id=OLD.id AND target_json->>'kind'='git_cron';
  RETURN NULL;
END $$;
CREATE TRIGGER git_cron_profile_deleted AFTER DELETE ON git_sync_profiles
  FOR EACH ROW EXECUTE FUNCTION remove_git_cron_schedule();

-- The generic Git tick still owns polling/rotation and existing pending-run
-- recovery until their explicit later cutovers; do not retire that tick here.
