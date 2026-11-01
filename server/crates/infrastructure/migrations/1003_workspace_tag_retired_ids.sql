-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Prevent stale root-Yjs metadata from resurrecting permanently deleted Tags.

CREATE TABLE workspace_tag_retired_ids (
  workspace_id uuid NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  retired_tag_id text NOT NULL,
  retired_at timestamptz NOT NULL,

  PRIMARY KEY (workspace_id, retired_tag_id),
  CONSTRAINT workspace_tag_retired_ids_not_blank
    CHECK (length(btrim(retired_tag_id)) > 0)
);
