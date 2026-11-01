-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Workspace ownership can change while immutable snapshots retain their
-- original reference context. Legacy origin cannot be reconstructed by time.
ALTER TABLE doc_histories ADD COLUMN reference_workspace_id uuid;
