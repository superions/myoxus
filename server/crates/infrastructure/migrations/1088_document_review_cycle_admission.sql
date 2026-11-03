-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Manual Reviews retain no slot association. Automatic Reviews join the same
-- native Run and existing shared receipt; no second Review model is introduced.
ALTER TABLE workspace_automation_runs DROP CONSTRAINT workspace_automation_scheduling_origin;
ALTER TABLE workspace_automation_runs ADD CONSTRAINT workspace_automation_scheduling_origin CHECK (
  (origin_kind='recurring_task' AND scheduling_occurrence_id IS NOT NULL
    AND accepted_json->'recurringTask' IS NOT NULL)
  OR (origin_kind='document_review' AND
    ((scheduling_occurrence_id IS NULL AND accepted_json#>>'{documentReview,plan,sourceMetadataDeadline}' IS NULL)
      OR (scheduling_occurrence_id IS NOT NULL AND accepted_json#>>'{documentReview,plan,sourceMetadataDeadline}' IS NOT NULL)))
  OR (origin_kind NOT IN ('recurring_task','document_review') AND scheduling_occurrence_id IS NULL));
