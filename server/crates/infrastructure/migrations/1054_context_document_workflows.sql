-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A confirmed request shares the existing native Run/effect history. Retained
-- Rule accepted_json and its hashes are deliberately not rewritten.
ALTER TABLE workspace_automation_runs
  ALTER COLUMN automation_id DROP NOT NULL,
  ALTER COLUMN trigger_type DROP NOT NULL,
  ALTER COLUMN trigger_event_json DROP NOT NULL,
  ADD COLUMN origin_kind text NOT NULL DEFAULT 'rule',
  ADD COLUMN confirmed_actor_id uuid,
  ADD COLUMN confirmed_operation text,
  ADD COLUMN confirmed_request_id uuid,
  ADD CONSTRAINT workspace_automation_runs_origin_shape CHECK (
    (origin_kind='rule' AND automation_id IS NOT NULL AND trigger_type IS NOT NULL
      AND trigger_event_json IS NOT NULL AND confirmed_actor_id IS NULL
      AND confirmed_operation IS NULL AND confirmed_request_id IS NULL)
    OR
    (origin_kind='confirmed_context_documents' AND automation_id IS NULL AND trigger_type IS NULL
      AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
      AND confirmed_operation IS NOT NULL AND confirmed_operation='prepare_documents'
      AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL)),
  ADD CONSTRAINT workspace_automation_runs_confirmed_receipt
    FOREIGN KEY(confirmed_actor_id,confirmed_operation,confirmed_request_id)
    REFERENCES workspace_starter_applications(actor_id,operation,request_id) ON DELETE CASCADE,
  ADD CONSTRAINT workspace_automation_runs_confirmed_unique
    UNIQUE(confirmed_actor_id,confirmed_operation,confirmed_request_id);
-- Keep the accepted identity even if a native Workspace purge removes the Run.
-- The same request can then report unavailable, never allocate a replacement.
ALTER TABLE workspace_starter_applications ADD COLUMN automation_run_id uuid;
