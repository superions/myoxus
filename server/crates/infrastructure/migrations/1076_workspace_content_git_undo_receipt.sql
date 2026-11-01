-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The original Extract receipt owns forward and counter-Move Git work. The
-- existing pending/prepared fields and queue are reused, not duplicated.
ALTER TABLE workspace_content_operation_requests ADD COLUMN git_sync_undo_plan jsonb;
ALTER TABLE workspace_content_extract_targets
  ADD COLUMN git_sync_undo_operation_id uuid REFERENCES workspace_content_operations(id) ON DELETE RESTRICT,
  ADD COLUMN git_sync_undo_plan jsonb,
  ADD CONSTRAINT workspace_content_git_undo_receipt_consistent CHECK (
    (git_sync_undo_operation_id IS NULL) = (git_sync_undo_plan IS NULL)
  );
CREATE UNIQUE INDEX workspace_content_git_undo_operation
  ON workspace_content_extract_targets(git_sync_undo_operation_id)
  WHERE git_sync_undo_operation_id IS NOT NULL;
