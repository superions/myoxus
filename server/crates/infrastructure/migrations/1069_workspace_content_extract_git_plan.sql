-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A hidden Extract target owns the preflight's immutable Git scope evidence.
-- Existing terminal receipts remain readable with no Git plan.
ALTER TABLE workspace_content_extract_targets
  ADD COLUMN git_sync_plan jsonb;
