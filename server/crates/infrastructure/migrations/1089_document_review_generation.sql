-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Preserve the native generated generation fence for both closed Run owners.
-- Recompute from immutable accepted inputs; old Task values and manual Reviews
-- retain their existing values. No automatic Review could pass the old fence.
DROP INDEX workspace_automation_scheduling_generation;
ALTER TABLE workspace_automation_runs DROP CONSTRAINT scheduling_run_generation;
ALTER TABLE workspace_automation_runs DROP COLUMN scheduling_generation;
ALTER TABLE workspace_automation_runs ADD COLUMN scheduling_generation bigint
  GENERATED ALWAYS AS (CASE
    WHEN origin_kind='recurring_task' THEN (accepted_json#>>'{recurringTask,generation}')::bigint
    WHEN origin_kind='document_review' THEN (accepted_json#>>'{documentReview,schedulingGeneration}')::bigint
  END) STORED;
ALTER TABLE workspace_automation_runs ADD CONSTRAINT scheduling_run_generation CHECK (
  (scheduling_occurrence_id IS NULL AND scheduling_generation IS NULL)
  OR (scheduling_occurrence_id IS NOT NULL AND scheduling_generation IS NOT NULL AND scheduling_generation>0));
CREATE UNIQUE INDEX workspace_automation_scheduling_generation
  ON workspace_automation_runs(scheduling_occurrence_id,scheduling_generation)
  WHERE scheduling_occurrence_id IS NOT NULL;
