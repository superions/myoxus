-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A prepared OID survives a lost push acknowledgement; hashes bind only the
-- external metadata bytes, not a second content-publication state machine.
ALTER TABLE workspace_content_extract_targets
  ADD COLUMN git_sync_prepared_oid text,
  ADD COLUMN git_sync_prepared_hashes jsonb;
