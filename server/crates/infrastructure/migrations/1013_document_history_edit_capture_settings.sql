-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE document_versioning_workspace_settings
  ADD COLUMN edit_capture_enabled boolean,
  ADD COLUMN edit_capture_interval_ms bigint;

ALTER TABLE document_versioning_workspace_settings
  ADD CONSTRAINT document_versioning_workspace_settings_edit_capture_interval_check
  CHECK (
    edit_capture_interval_ms IS NULL
    OR edit_capture_interval_ms BETWEEN 1 AND 86400000
  );
