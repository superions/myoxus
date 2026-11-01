-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Queue metadata is optional for historical/unconfigured runs and is never a
-- second execution fence. Existing run status and retry ownership are preserved.
ALTER TABLE workspace_automation_runs ADD COLUMN job_id text;
COMMENT ON COLUMN workspace_automation_runs.job_id IS
  'Last known queue job identity; NULL when unavailable. Not a delivery fence.';
