-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE workspaces
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD CONSTRAINT workspaces_description_length
    CHECK (char_length(description) <= 2000);
