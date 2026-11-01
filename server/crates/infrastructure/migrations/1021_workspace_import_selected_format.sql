-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE workspace_imports
  ADD COLUMN selected_format text NOT NULL DEFAULT 'auto',
  ADD CONSTRAINT workspace_imports_selected_format_check
    CHECK (selected_format IN ('auto', 'obsidian_zip'));
