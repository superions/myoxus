-- SPDX-License-Identifier: AGPL-3.0-or-later
ALTER TABLE workspace_automation_runs ADD COLUMN task_handover_state jsonb;
-- Only contextual document runs have a starter parent. Keep that exact native
-- cascade while standalone confirmed runs retain the same request identity.
ALTER TABLE workspace_automation_runs
  DROP CONSTRAINT workspace_automation_runs_confirmed_receipt,
  ADD COLUMN confirmed_starter_operation text GENERATED ALWAYS AS (
    CASE WHEN origin_kind='confirmed_context_documents' THEN confirmed_operation ELSE NULL END
  ) STORED,
  ADD CONSTRAINT workspace_automation_runs_confirmed_receipt
    FOREIGN KEY(confirmed_actor_id,confirmed_starter_operation,confirmed_request_id)
    REFERENCES workspace_starter_applications(actor_id,operation,request_id) MATCH SIMPLE ON DELETE CASCADE;
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
    AND review_actor_id IS NULL AND task_handover_state IS NOT NULL));
