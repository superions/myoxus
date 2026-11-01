-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Component facts extend the existing allocation receipt; native document
-- progress and all action ACKs keep their current owners.
ALTER TABLE workspace_starter_applications
  ADD COLUMN setup_plan jsonb CHECK(setup_plan IS NULL OR (jsonb_typeof(setup_plan)='object' AND octet_length(setup_plan::text)<=4194304)),
  ADD COLUMN setup_result_ids jsonb,
  ADD COLUMN setup_progress jsonb,
  DROP CONSTRAINT workspace_starter_applications_project_shape;
ALTER TABLE workspace_starter_applications ADD CONSTRAINT workspace_starter_applications_setup_shape CHECK (
  (operation='create_workspace' AND workspace_plan IS NOT NULL
    AND workspace_plan->'setup' IS NOT NULL AND jsonb_typeof(workspace_plan->'setup')='object'
    AND setup_result_ids IS NOT NULL AND jsonb_typeof(setup_result_ids)='array'
    AND octet_length(setup_result_ids::text)<=32768
    AND setup_progress IS NOT NULL AND jsonb_typeof(setup_progress)='object'
    AND octet_length(setup_progress::text)<=131072)
  OR (setup_plan IS NULL AND setup_result_ids IS NULL AND setup_progress IS NULL)
);
ALTER TABLE workspace_starter_applications ADD CONSTRAINT workspace_starter_applications_project_shape CHECK(
    (operation='create_workspace' AND (workspace_plan->'project') IS NULL AND (workspace_plan->'setup') IS NULL
      AND project_plan IS NULL AND project_result_ids IS NULL AND project_admission IS NULL
      AND project_state IS NULL AND project_progress IS NULL)
    OR
    ((operation IN ('create_project','prepare_documents') OR (operation='create_workspace' AND workspace_plan IS NOT NULL
        AND jsonb_typeof(workspace_plan->'project')='object'))
      AND (project_plan IS NOT NULL OR operation='create_workspace')
      AND (project_plan IS NULL OR (jsonb_typeof(project_plan)='object' AND octet_length(project_plan::text)<=4194304))
      AND project_result_ids IS NOT NULL AND jsonb_typeof(project_result_ids)='object'
      AND octet_length(project_result_ids::text)<=32768
      AND project_admission IS NOT NULL AND jsonb_typeof(project_admission)='object'
      AND octet_length(project_admission::text)<=8192
      AND project_state IS NOT NULL AND project_state IN ('accepted','complete','stop_requested','stopped')
      AND project_progress IS NOT NULL AND jsonb_typeof(project_progress)='object'
      AND octet_length(project_progress::text)<=131072)    OR
    (operation='create_workspace' AND workspace_plan IS NOT NULL
      AND workspace_plan->'setup' IS NOT NULL AND jsonb_typeof(workspace_plan->'setup')='object'
      AND workspace_plan->'project' IS NULL AND project_plan IS NULL AND project_admission IS NULL
      AND setup_result_ids IS NOT NULL AND jsonb_typeof(setup_result_ids)='array'
      AND octet_length(setup_result_ids::text)<=32768
      AND setup_progress IS NOT NULL AND jsonb_typeof(setup_progress)='object'
      AND octet_length(setup_progress::text)<=131072
      AND project_result_ids IS NOT NULL AND jsonb_typeof(project_result_ids)='object'
      AND project_progress IS NOT NULL AND jsonb_typeof(project_progress)='object'
      AND octet_length(project_progress::text)<=131072
      AND project_state IS NOT NULL AND project_state IN ('accepted','complete','stop_requested','stopped')
      AND automation_run_id IS NOT NULL)
  );

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
    AND review_actor_id IS NULL AND task_handover_state IS NULL)
  OR (origin_kind='workspace_setup' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='create_workspace'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL
    AND review_actor_id IS NULL AND task_handover_state IS NULL));
-- Setup runs, like contextual documents, refer to their actual starter parent.
ALTER TABLE workspace_automation_runs
  DROP CONSTRAINT workspace_automation_runs_confirmed_receipt,
  DROP COLUMN confirmed_starter_operation,
  ADD COLUMN confirmed_starter_operation text GENERATED ALWAYS AS (
    CASE WHEN origin_kind IN ('confirmed_context_documents','workspace_setup') THEN confirmed_operation ELSE NULL END
  ) STORED,
  ADD CONSTRAINT workspace_automation_runs_confirmed_receipt
    FOREIGN KEY(confirmed_actor_id,confirmed_starter_operation,confirmed_request_id)
    REFERENCES workspace_starter_applications(actor_id,operation,request_id) MATCH SIMPLE ON DELETE CASCADE;
