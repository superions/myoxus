-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Calendar view definitions have no admission cursor and cannot create Runs.
ALTER TABLE scheduling_schedules ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_schedules_target_json_check;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master'),false)
  AND (target_json->>'kind'<>'recurring_task' OR workspace_id IS NOT NULL)
  AND (target_json->>'kind'<>'calendar_master' OR
    (next_nominal IS NULL AND next_due_at IS NULL AND next_admission_at IS NULL)));
ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_rule_zone;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_rule_zone CHECK (
  rule_json IS NULL
  OR ((rule_json->>'kind') IS NOT DISTINCT FROM 'fixed'
    AND (rule_json#>>'{rule,zone}') IS NOT DISTINCT FROM admission_zone)
  OR ((rule_json->>'kind') IS NOT DISTINCT FROM 'after_completion'
    AND (target_json->>'kind') IS NOT DISTINCT FROM 'recurring_task')
  OR ((rule_json->>'kind') IS NOT DISTINCT FROM 'imported_calendar'
    AND (target_json->>'kind') IS NOT DISTINCT FROM 'calendar_master'
    AND (rule_json->>'zone') IS NOT DISTINCT FROM admission_zone));
ALTER TABLE calendar_events ADD COLUMN recurrence_schedule_id uuid UNIQUE
  REFERENCES scheduling_schedules(id) ON DELETE SET NULL;

-- Provider-less historical wall times were UTC. A documented source TZID is
-- retained; malformed/oversized source stays on the event, visibly unsupported.
WITH candidates AS (
  SELECT e.id,gen_random_uuid() schedule_id,e.workspace_id,a.user_id,
    CASE WHEN EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=e.payload->>'originalTimezone')
      THEN e.payload->>'originalTimezone' ELSE 'UTC' END zone,
    e.starts_at,COALESCE((e.payload->>'allDay')='true',false) all_day,e.payload->>'rrule' rrule,
    CASE WHEN octet_length(e.payload->>'rrule')>8192 THEN 'unsupportedCalendarRule'
      WHEN NULLIF(e.payload->>'originalTimezone','') IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM pg_timezone_names z WHERE z.name=e.payload->>'originalTimezone')
      THEN 'invalidCalendarZone' END blocked
  FROM calendar_events e LEFT JOIN calendar_accounts a ON a.id=e.account_id
  WHERE e.recurrence_parent_id IS NULL AND NULLIF(e.payload->>'recurrenceId','') IS NULL
    AND NULLIF(e.payload->>'recurringEventId','') IS NULL AND NULLIF(e.payload->>'rrule','') IS NOT NULL
), inserted AS (
  INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,rule_json,blocked_reason)
  SELECT schedule_id,workspace_id,user_id,zone,
    jsonb_build_object('kind','calendar_master','event_id',id),
    CASE WHEN blocked IS NULL THEN jsonb_build_object('kind','imported_calendar','rrule',rrule,
      'starts_at',to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'all_day',all_day,'zone',zone) END,blocked FROM candidates
  RETURNING id,target_json
)
UPDATE calendar_events e SET recurrence_schedule_id=i.id
FROM inserted i WHERE e.id=(i.target_json->>'event_id')::uuid;

CREATE FUNCTION delete_calendar_timing_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM scheduling_schedules WHERE id=OLD.recurrence_schedule_id;
  RETURN OLD;
END $$;
CREATE TRIGGER calendar_timing_definition_deleted AFTER DELETE ON calendar_events
  FOR EACH ROW WHEN (OLD.recurrence_schedule_id IS NOT NULL)
  EXECUTE FUNCTION delete_calendar_timing_definition();
