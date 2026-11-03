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
      AND target_json->>'job' IS NOT NULL AND rule_json IS NULL AND lifecycle='ended')));

-- Legacy numeric queue IDs are dispatch references, not new UUID queue jobs.
-- Multiple already-started/retrying deliveries for one slot must all survive;
-- only unstarted duplicate copies are removed by the stopped-owner importer.
ALTER TABLE scheduling_occurrences ADD COLUMN native_job_id text
  CHECK(native_job_id IS NULL OR length(native_job_id) BETWEEN 1 AND 256);
CREATE UNIQUE INDEX scheduling_native_worker_job ON scheduling_occurrences(schedule_id,native_job_id)
  WHERE native_job_id IS NOT NULL;
