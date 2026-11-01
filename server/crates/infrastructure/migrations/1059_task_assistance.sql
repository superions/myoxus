-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A personal opt-in is an existing Rule, not another subscription/receipt store.
ALTER TABLE workspace_automations
  ADD COLUMN personal_config jsonb,
  ADD COLUMN execution_revision bigint NOT NULL DEFAULT 1 CHECK (execution_revision > 0);
ALTER TABLE workspace_automation_runs
  ADD COLUMN task_correction_outcome_json jsonb,
  ADD COLUMN task_maintenance_invalid_reason text;
ALTER TABLE workspace_automation_runs DROP CONSTRAINT workspace_automation_runs_origin_shape;
ALTER TABLE workspace_automation_runs ADD CONSTRAINT workspace_automation_runs_origin_shape CHECK (
  (origin_kind='rule' AND automation_id IS NOT NULL AND trigger_type IS NOT NULL
    AND trigger_event_json IS NOT NULL AND confirmed_actor_id IS NULL
    AND confirmed_operation IS NULL AND confirmed_request_id IS NULL AND review_actor_id IS NULL AND task_handover_state IS NULL)
  OR (origin_kind='confirmed_context_documents' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='prepare_documents'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL AND review_actor_id IS NULL AND task_handover_state IS NULL)
  OR (origin_kind='document_review' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NULL
    AND confirmed_operation IS NULL AND confirmed_request_id IS NULL
    AND review_actor_id IS NOT NULL AND review_request_id IS NOT NULL
    AND review_task_id IS NOT NULL AND review_follow_up_id IS NOT NULL
    AND review_wait_id IS NOT NULL AND length(review_wait_id)>0
    AND review_deadline_at IS NOT NULL AND accepted_json IS NOT NULL AND task_handover_state IS NULL)
  OR (origin_kind='task_handover' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='task_handover'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL
    AND review_actor_id IS NULL AND task_handover_state IS NOT NULL)
  OR (origin_kind='task_maintenance' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='task_maintenance'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL
    AND review_actor_id IS NULL AND task_handover_state IS NULL));

CREATE UNIQUE INDEX workspace_automation_personal_target
  ON workspace_automations(workspace_id,(personal_config->>'actorId'),(personal_config->>'databaseId'),trigger_type)
  WHERE personal_config IS NOT NULL;
