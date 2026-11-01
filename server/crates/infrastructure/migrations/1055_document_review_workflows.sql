-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Review acceptance and its business decision remain on the existing native Run.
ALTER TABLE workspace_automation_runs
  ADD COLUMN review_actor_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN review_request_id uuid,
  ADD COLUMN review_task_id uuid,
  ADD COLUMN review_follow_up_id uuid,
  ADD COLUMN review_wait_id text,
  ADD COLUMN review_deadline_at timestamptz,
  ADD COLUMN review_outcome_json jsonb,
  ADD COLUMN review_invalid_reason text,
  ADD COLUMN review_expired_at timestamptz,
  ADD CONSTRAINT workspace_automation_review_request UNIQUE(review_actor_id,workspace_id,review_request_id);
ALTER TABLE workspace_automation_runs DROP CONSTRAINT workspace_automation_runs_origin_shape;
ALTER TABLE workspace_automation_runs ADD CONSTRAINT workspace_automation_runs_origin_shape CHECK (
  (origin_kind='rule' AND automation_id IS NOT NULL AND trigger_type IS NOT NULL
    AND trigger_event_json IS NOT NULL AND confirmed_actor_id IS NULL
    AND confirmed_operation IS NULL AND confirmed_request_id IS NULL AND review_actor_id IS NULL)
  OR (origin_kind='confirmed_context_documents' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='prepare_documents'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL AND review_actor_id IS NULL)
  OR (origin_kind='document_review' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NULL
    AND confirmed_operation IS NULL AND confirmed_request_id IS NULL
    AND review_actor_id IS NOT NULL AND review_request_id IS NOT NULL
    AND review_task_id IS NOT NULL AND review_follow_up_id IS NOT NULL
    AND review_wait_id IS NOT NULL AND length(review_wait_id)>0
    AND review_deadline_at IS NOT NULL AND accepted_json IS NOT NULL));
CREATE INDEX workspace_automation_review_task ON workspace_automation_runs(workspace_id,review_task_id)
  WHERE origin_kind='document_review';
-- Retain consumed signal identities in the same engine buffer for idempotent
-- redelivery after a lost outbox ACK. Native acceptance time is not arrival time.
ALTER TABLE sayiir_workflow_events
  ADD COLUMN event_id uuid,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN consumed_at timestamptz;
CREATE UNIQUE INDEX sayiir_workflow_event_identity ON sayiir_workflow_events(instance_id,event_id)
  WHERE event_id IS NOT NULL;
-- The existing engine scheduler selects buffered events for this exact parked
-- wait; unrelated early/consumed signals cannot fill its bounded ready batch.
ALTER TABLE sayiir_workflow_snapshots ADD COLUMN signal_name text;
