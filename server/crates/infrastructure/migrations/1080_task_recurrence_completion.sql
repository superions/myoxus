-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One rule model; installed fixed definitions move forward without a fallback.
ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_schedules_check;
UPDATE scheduling_schedules SET rule_json=jsonb_build_object('kind','fixed','rule',rule_json)
  WHERE rule_json IS NOT NULL;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_rule_zone CHECK (
  rule_json IS NULL OR (
    ((rule_json->>'kind') IS NOT DISTINCT FROM 'fixed'
      AND (rule_json#>>'{rule,zone}') IS NOT DISTINCT FROM admission_zone)
    OR (rule_json->>'kind') IS NOT DISTINCT FROM 'after_completion'));
ALTER TABLE scheduling_schedules ADD COLUMN next_cause_member_id uuid;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_cause_shape CHECK (
  (next_cause_member_id IS NULL AND (next_nominal IS NULL OR (rule_json->>'kind') IS DISTINCT FROM 'after_completion'))
  OR (next_cause_member_id IS NOT NULL AND next_nominal IS NOT NULL
    AND (rule_json->>'kind') IS NOT DISTINCT FROM 'after_completion'));

-- A relative initial member may have no Due and is not a fabricated timed slot.
ALTER TABLE task_recurrence_members ADD COLUMN id uuid;
UPDATE task_recurrence_members SET id=occurrence_id;
ALTER TABLE task_recurrence_members ALTER COLUMN id SET NOT NULL;
ALTER TABLE task_recurrence_members DROP CONSTRAINT task_recurrence_members_pkey;
ALTER TABLE task_recurrence_members ADD PRIMARY KEY(id);
ALTER TABLE task_recurrence_members ADD UNIQUE(occurrence_id);
ALTER TABLE task_recurrence_members ALTER COLUMN occurrence_id DROP NOT NULL;
ALTER TABLE task_recurrence_members
  ADD COLUMN advanced_at timestamptz,
  ADD COLUMN advance_kind text CHECK(advance_kind IN ('complete','skip')),
  ADD COLUMN successor_occurrence_id uuid,
  ADD CONSTRAINT task_recurrence_advancement_shape CHECK (
    (advanced_at IS NULL AND advance_kind IS NULL AND successor_occurrence_id IS NULL)
    OR (advanced_at IS NOT NULL AND advance_kind IS NOT NULL));
ALTER TABLE task_recurrence_series ADD COLUMN current_member_id uuid
  REFERENCES task_recurrence_members(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- Two early completions on one civil day legitimately have the same next Due.
ALTER TABLE scheduling_occurrences DROP CONSTRAINT scheduling_occurrences_schedule_id_nominal_json_key;
ALTER TABLE scheduling_occurrences ADD COLUMN cause_member_id uuid;
CREATE UNIQUE INDEX scheduling_fixed_slot ON scheduling_occurrences(schedule_id,nominal_json)
  WHERE cause_member_id IS NULL;
CREATE UNIQUE INDEX scheduling_completion_slot ON scheduling_occurrences(schedule_id,cause_member_id)
  WHERE cause_member_id IS NOT NULL;

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','database_task_notification',
  'workspace_automation_trigger','workspace_automation_signal','task_recurrence_due'));
