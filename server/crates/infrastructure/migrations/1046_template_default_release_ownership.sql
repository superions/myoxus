-- Existing policy provenance is unknown and must remain operator-owned.
-- Only the atomic release catalog writer creates release-managed defaults;
-- explicit policy edits relinquish that ownership in the same native row.
ALTER TABLE template_default_policies
  ADD COLUMN release_managed boolean NOT NULL DEFAULT false;
