-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Component acknowledgements belong to the existing accepted Project request.
ALTER TABLE workspace_starter_applications ADD COLUMN project_progress jsonb;
UPDATE workspace_starter_applications
SET project_progress=jsonb_build_object(
  'folderReady',project_state='complete' AND project_result_ids->>'folderId' IS NOT NULL,'projectCreated',project_state='complete',
  'documents','{}'::jsonb,'placementComplete',project_state='complete')
WHERE operation='create_project';
ALTER TABLE workspace_starter_applications ADD CONSTRAINT workspace_starter_applications_project_progress_check CHECK (
  (operation='create_workspace' AND project_progress IS NULL)
  OR (operation='create_project' AND project_progress IS NOT NULL
    AND jsonb_typeof(project_progress)='object'
    AND octet_length(project_progress::text)<=131072)
);
