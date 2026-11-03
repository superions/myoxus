-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Sources without RRULE can still contain an unsupported recurrence set. Keep
-- their payload and installed instances unchanged, with explicit readback.
WITH candidates AS (
  SELECT e.id,gen_random_uuid() schedule_id,e.workspace_id,a.user_id,
    CASE WHEN EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=e.payload->>'originalTimezone')
      THEN e.payload->>'originalTimezone' ELSE 'UTC' END zone
  FROM calendar_events e LEFT JOIN calendar_accounts a ON a.id=e.account_id
  WHERE e.recurrence_schedule_id IS NULL AND e.recurrence_parent_id IS NULL
    AND NULLIF(e.payload->>'recurrenceId','') IS NULL
    AND NULLIF(e.payload->>'recurringEventId','') IS NULL
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.payload->'sourceRecurrence')='array'
        THEN e.payload->'sourceRecurrence' ELSE '[]'::jsonb END) line
      WHERE upper(split_part(split_part(line,':',1),';',1)) IN ('RRULE','RDATE','EXRULE'))
), inserted AS (
  INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,rule_json,blocked_reason)
  SELECT schedule_id,workspace_id,user_id,zone,
    jsonb_build_object('kind','calendar_master','event_id',id),NULL,'unsupportedCalendarRule'
  FROM candidates RETURNING id,target_json
)
UPDATE calendar_events e SET recurrence_schedule_id=i.id
FROM inserted i WHERE e.id=(i.target_json->>'event_id')::uuid;

-- Already-bound RRULE sources must not conceal unsupported set extensions.
UPDATE scheduling_schedules s SET blocked_reason='unsupportedCalendarRule',
  revision=revision+1,generation=generation+1,updated_at=now()
FROM calendar_events e
WHERE e.recurrence_schedule_id=s.id AND s.rule_json->>'kind'='imported_calendar'
  AND s.blocked_reason IS DISTINCT FROM 'unsupportedCalendarRule'
  AND (
    EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.payload->'sourceRecurrence')='array'
      THEN e.payload->'sourceRecurrence' ELSE '[]'::jsonb END) line
      WHERE upper(split_part(split_part(line,':',1),';',1)) IN ('RDATE','EXRULE'))
    OR 1 < (SELECT count(*) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.payload->'sourceRecurrence')='array'
      THEN e.payload->'sourceRecurrence' ELSE '[]'::jsonb END) line
      WHERE upper(split_part(line,':',1))='RRULE'));
