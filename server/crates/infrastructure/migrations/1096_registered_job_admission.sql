-- SPDX-License-Identifier: AGPL-3.0-or-later
ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_target_shape;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master','document_review','calendar_reminder','database_reminder','git_cron','git_polling','git_rotation','registered_job'),false)
  AND (target_json->>'kind' IN ('calendar_master','calendar_reminder','registered_job') OR workspace_id IS NOT NULL)
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
      AND (lifecycle<>'active' OR next_due_at IS NOT NULL)))
  AND (target_json->>'kind'<>'git_rotation' OR
    (rule_json IS NULL AND COALESCE(target_json->>'credential_id'=id::text,false)
      AND target_json->>'source_fingerprint' IS NOT NULL
      AND (lifecycle<>'active' OR next_due_at IS NOT NULL)))
  AND (target_json->>'kind'<>'registered_job' OR
    (workspace_id IS NULL AND actor_id IS NULL AND admission_zone='UTC'
      AND target_json->>'job' IS NOT NULL
      AND ((rule_json IS NULL AND lifecycle='ended') OR
        (COALESCE(rule_json->>'kind'='registered_worker',false)
          AND COALESCE(jsonb_typeof(rule_json#>'{definition,enabled}')='boolean',false)
          AND (lifecycle<>'active' OR (COALESCE((rule_json#>>'{definition,enabled}')::boolean,false) AND next_due_at IS NOT NULL)))))));

ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_rule_zone;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_rule_zone CHECK (
  rule_json IS NULL
  OR ((rule_json->>'kind') IS NOT DISTINCT FROM 'fixed'
    AND (rule_json#>>'{rule,zone}') IS NOT DISTINCT FROM admission_zone)
  OR ((rule_json->>'kind') IS NOT DISTINCT FROM 'after_completion'
    AND (target_json->>'kind') IS NOT DISTINCT FROM 'recurring_task')
  OR ((rule_json->>'kind') IS NOT DISTINCT FROM 'imported_calendar'
    AND (target_json->>'kind') IS NOT DISTINCT FROM 'calendar_master'
    AND (rule_json->>'zone') IS NOT DISTINCT FROM admission_zone)
  OR ((rule_json->>'kind') IS NOT DISTINCT FROM 'registered_worker'
    AND target_json->>'kind'='registered_job' AND admission_zone='UTC'));

CREATE INDEX scheduling_due_receipt ON scheduling_occurrences(schedule_id,nominal_due_at);
ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','calendar_reminder_due',
  'database_reminder_due','git_cron_due','git_polling_due','git_rotation_due','registered_job_due',
  'database_task_notification','workspace_automation_trigger','workspace_automation_signal','task_recurrence_due'));
