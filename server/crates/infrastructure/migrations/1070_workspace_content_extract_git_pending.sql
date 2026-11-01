-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Git completion is separate from the already published content operation.
-- Old Extract receipts have no Git work and remain readable without conversion.
ALTER TABLE workspace_content_extract_targets
  ADD COLUMN git_sync_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN git_sync_error_code text,
  ADD COLUMN git_sync_retry_exhausted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT workspace_content_extract_git_pending_consistent CHECK (
    (NOT git_sync_pending AND git_sync_error_code IS NULL AND NOT git_sync_retry_exhausted)
    OR (git_sync_pending AND git_sync_plan IS NOT NULL)
  );

CREATE INDEX workspace_content_extract_pending_git_idx
  ON workspace_content_extract_targets(operation_id)
  WHERE git_sync_pending AND NOT git_sync_retry_exhausted;
