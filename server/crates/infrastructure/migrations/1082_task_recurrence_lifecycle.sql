-- SPDX-License-Identifier: AGPL-3.0-or-later
ALTER TABLE scheduling_schedules ADD COLUMN paused_at timestamptz;
UPDATE scheduling_schedules SET paused_at=updated_at WHERE lifecycle='paused';
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_pause_shape CHECK (
  (lifecycle='paused' AND paused_at IS NOT NULL) OR (lifecycle<>'paused' AND paused_at IS NULL));

-- A new explicit generation can replace only unacknowledged work. Retain the
-- previous frozen Run/history; the occurrence points at its current dispatch.
DROP INDEX workspace_automation_scheduling_occurrence;
ALTER TABLE workspace_automation_runs ADD COLUMN scheduling_generation bigint
  GENERATED ALWAYS AS (CASE WHEN origin_kind='recurring_task'
    THEN (accepted_json#>>'{recurringTask,generation}')::bigint END) STORED;
ALTER TABLE workspace_automation_runs ADD CONSTRAINT scheduling_run_generation CHECK (
  (scheduling_occurrence_id IS NULL AND scheduling_generation IS NULL)
  OR (scheduling_occurrence_id IS NOT NULL AND scheduling_generation IS NOT NULL AND scheduling_generation>0));
CREATE UNIQUE INDEX workspace_automation_scheduling_generation
  ON workspace_automation_runs(scheduling_occurrence_id,scheduling_generation)
  WHERE scheduling_occurrence_id IS NOT NULL;

-- The first Complete is immutable; a deferred successor can be anchored at a
-- later explicit Resume without changing that historical completion timestamp.
ALTER TABLE task_recurrence_members ADD COLUMN successor_reference_at timestamptz;
UPDATE task_recurrence_members SET successor_reference_at=advanced_at WHERE successor_occurrence_id IS NOT NULL;
ALTER TABLE task_recurrence_members ADD CONSTRAINT task_recurrence_reference_shape CHECK (
  (successor_occurrence_id IS NULL AND successor_reference_at IS NULL)
  OR (successor_occurrence_id IS NOT NULL AND successor_reference_at IS NOT NULL));

ALTER TABLE task_recurrence_series ADD COLUMN effective_after_member_id uuid
  REFERENCES task_recurrence_members(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
