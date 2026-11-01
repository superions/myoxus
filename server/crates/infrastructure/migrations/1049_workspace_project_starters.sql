-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Optional Project setup extends the existing actor/request acceptance ledger.
-- Existing Empty allocations and their result identities are unchanged.
ALTER TABLE workspace_starter_applications
  DROP CONSTRAINT workspace_starter_applications_operation_check,
  DROP CONSTRAINT workspace_starter_applications_workspace_id_key,
  DROP CONSTRAINT workspace_starter_applications_name_check,
  ADD CONSTRAINT workspace_starter_applications_name_check CHECK (
    (operation='create_workspace' AND length(name) BETWEEN 1 AND 120)
    OR (operation='create_project' AND length(name)>0)),
  ADD CONSTRAINT workspace_starter_applications_operation_check
    CHECK (operation IN ('create_workspace','create_project')),
  ADD COLUMN project_plan jsonb,
  ADD COLUMN project_result_ids jsonb,
  ADD COLUMN project_admission jsonb,
  ADD COLUMN project_state text,
  ADD CONSTRAINT workspace_starter_applications_project_shape CHECK (
    (operation='create_workspace' AND project_plan IS NULL AND project_result_ids IS NULL
      AND project_admission IS NULL AND project_state IS NULL)
    OR
    (operation='create_project' AND project_plan IS NOT NULL AND project_result_ids IS NOT NULL
      AND project_admission IS NOT NULL AND project_state IS NOT NULL
      AND jsonb_typeof(project_plan)='object'
      AND jsonb_typeof(project_result_ids)='object' AND jsonb_typeof(project_admission)='object'
      AND project_state IN ('accepted','complete','stop_requested','stopped')
      AND octet_length(project_plan::text)<=4194304
      AND octet_length(project_result_ids::text)<=32768
      AND octet_length(project_admission::text)<=8192)
  );
CREATE UNIQUE INDEX workspace_starter_applications_created_workspace_unique
  ON workspace_starter_applications(workspace_id) WHERE operation='create_workspace';
