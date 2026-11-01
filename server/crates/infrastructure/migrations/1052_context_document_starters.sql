-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Contextual document actions share the existing actor/operation/request ledger.
ALTER TABLE workspace_starter_applications
  DROP CONSTRAINT workspace_starter_applications_operation_check,
  DROP CONSTRAINT workspace_starter_applications_name_check,
  ADD CONSTRAINT workspace_starter_applications_operation_check CHECK(operation IN ('create_workspace','create_project','prepare_documents')),
  ADD CONSTRAINT workspace_starter_applications_name_check CHECK(
    (operation='create_workspace' AND length(name) BETWEEN 1 AND 120)
    OR (operation IN ('create_project','prepare_documents') AND length(name)>0)),
  DROP CONSTRAINT workspace_starter_applications_project_shape,
  ADD CONSTRAINT workspace_starter_applications_project_shape CHECK(
    (operation='create_workspace' AND (workspace_plan->'project') IS NULL
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
      AND octet_length(project_progress::text)<=131072)
  ),
  ADD CONSTRAINT workspace_starter_applications_context_documents_check CHECK(
    operation <> 'prepare_documents' OR (
      workspace_plan IS NULL AND project_plan->'target' IS NOT NULL
      AND jsonb_typeof(project_plan->'target')='object'
      AND project_plan->'documents' IS NOT NULL AND jsonb_typeof(project_plan->'documents')='array'
      AND jsonb_array_length(project_plan->'documents') BETWEEN 1 AND 64
      AND project_progress->'projectCreated' IS NOT NULL AND project_progress->'projectCreated'='false'::jsonb
    ));
