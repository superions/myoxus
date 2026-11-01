-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Optional Workspace Project setup shares the allocation's original ledger row.
ALTER TABLE workspace_starter_applications
  ADD COLUMN workspace_plan jsonb,
  DROP CONSTRAINT workspace_starter_applications_project_shape,
  DROP CONSTRAINT workspace_starter_applications_project_progress_check,
  ADD CONSTRAINT workspace_starter_applications_workspace_plan_check CHECK (
    workspace_plan IS NULL OR (operation='create_workspace'
      AND jsonb_typeof(workspace_plan)='object' AND octet_length(workspace_plan::text)<=4194304)),
  ADD CONSTRAINT workspace_starter_applications_project_shape CHECK (
    (operation='create_workspace' AND (workspace_plan->'project') IS NULL
      AND project_plan IS NULL AND project_result_ids IS NULL AND project_admission IS NULL
      AND project_state IS NULL AND project_progress IS NULL)
    OR
    ((operation='create_project' OR (operation='create_workspace' AND workspace_plan IS NOT NULL
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
  );
