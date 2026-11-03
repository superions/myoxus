-- SPDX-License-Identifier: AGPL-3.0-or-later
ALTER TABLE scheduling_schedules ADD COLUMN interval_seconds bigint,
  ADD COLUMN activity_at timestamptz;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_interval_shape CHECK (
  (target_json->>'kind'='git_polling' AND
    (lifecycle<>'active' OR COALESCE(interval_seconds>0,false)))
  OR (target_json->>'kind'<>'git_polling' AND interval_seconds IS NULL AND activity_at IS NULL));
ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_target_shape;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master','document_review','calendar_reminder','database_reminder','git_cron','git_polling'),false)
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
  AND (target_json->>'kind' NOT IN('git_cron','git_polling') OR
    (rule_json IS NULL AND target_json->>'profile_id' IS NOT NULL
      AND (lifecycle<>'active' OR next_due_at IS NOT NULL))));
CREATE UNIQUE INDEX git_polling_schedule_source ON scheduling_schedules((target_json->>'profile_id'))
  WHERE target_json->>'kind'='git_polling';

WITH sources AS (
  SELECT p.*,a.activity,
    CASE WHEN p.enabled THEN COALESCE(a.activity+make_interval(secs=>p.polling_interval_secs::double precision),now()) END AS due
  FROM git_sync_profiles p LEFT JOIN LATERAL (
    SELECT max(GREATEST(started_at,COALESCE(finished_at,started_at))) AS activity
    FROM git_sync_runs WHERE profile_id=p.id
  ) a ON true WHERE p.trigger_mode='Polling'
)
INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,lifecycle,
  next_nominal,next_due_at,next_admission_at,interval_seconds,activity_at)
SELECT gen_random_uuid(),workspace_id,owner_id,'UTC',jsonb_build_object('kind','git_polling','profile_id',id),
  CASE WHEN enabled THEN 'active' ELSE 'ended' END,
  CASE WHEN due IS NOT NULL THEN jsonb_build_object('kind','local_date_time','value',to_char(due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')) END,
  due,due,polling_interval_secs,activity FROM sources;

-- Run mutations lock their native rows, then update only the current schedule
-- tuple. Do not acquire profile locks here: lifecycle writes use profile->Run
-- order. The projected interval is refreshed under profile->schedule locks by
-- native definition writes. UPDATE reevaluates the current interval after any
-- wait, so an old Run snapshot cannot restore an edited interval or lifecycle.
CREATE FUNCTION reanchor_git_polling_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE activity timestamptz:=GREATEST(NEW.started_at,COALESCE(NEW.finished_at,NEW.started_at));
BEGIN
  UPDATE scheduling_schedules SET activity_at=GREATEST(activity_at,activity),
    next_due_at=CASE WHEN lifecycle='active' THEN
      GREATEST(activity_at,activity)+make_interval(secs=>interval_seconds::double precision) ELSE next_due_at END,
    next_admission_at=CASE WHEN lifecycle='active' THEN
      GREATEST(activity_at,activity)+make_interval(secs=>interval_seconds::double precision) ELSE next_admission_at END,
    next_nominal=CASE WHEN lifecycle='active' THEN jsonb_build_object('kind','local_date_time','value',
      to_char((GREATEST(activity_at,activity)+make_interval(secs=>interval_seconds::double precision)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')) ELSE next_nominal END,
    revision=revision+1,blocked_reason=NULL,updated_at=clock_timestamp()
  WHERE target_json->>'kind'='git_polling' AND target_json->>'profile_id'=NEW.profile_id::text
    AND (activity_at IS NULL OR activity>activity_at);
  RETURN NULL;
END $$;
CREATE TRIGGER git_polling_run_activity AFTER INSERT OR UPDATE OF started_at,finished_at ON git_sync_runs
  FOR EACH ROW EXECUTE FUNCTION reanchor_git_polling_activity();

CREATE FUNCTION remove_git_polling_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM scheduling_schedules WHERE target_json->>'kind'='git_polling' AND target_json->>'profile_id'=OLD.id::text;
  RETURN NULL;
END $$;
CREATE TRIGGER git_polling_profile_deleted AFTER DELETE ON git_sync_profiles
  FOR EACH ROW EXECUTE FUNCTION remove_git_polling_schedule();

INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id)
SELECT r.id,s.id,jsonb_build_object('kind','local_date_time','value',to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')),
  r.started_at,1,r.id
FROM git_sync_runs r JOIN scheduling_schedules s ON s.target_json->>'kind'='git_polling'
  AND s.target_json->>'profile_id'=r.profile_id::text
WHERE r.trigger_source='Polling' AND r.status IN('Pending','Running');
ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','calendar_reminder_due',
  'database_reminder_due','git_cron_due','git_polling_due','database_task_notification','workspace_automation_trigger',
  'workspace_automation_signal','task_recurrence_due'));
INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
SELECT r.id,'git_polling',r.profile_id::text,'git_polling_due',
  jsonb_build_object('scheduleId',s.id,'generation',1,'runId',r.id)
FROM git_sync_runs r JOIN scheduling_schedules s ON s.target_json->>'kind'='git_polling'
  AND s.target_json->>'profile_id'=r.profile_id::text
WHERE r.trigger_source='Polling' AND r.status='Pending';
