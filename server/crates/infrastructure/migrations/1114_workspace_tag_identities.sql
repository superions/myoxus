-- SPDX-License-Identifier: AGPL-3.0-or-later
LOCK TABLE workspace_tag_legacy_ids, workspace_tag_retired_ids IN SHARE MODE;

CREATE TABLE workspace_tag_identities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  tag_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (workspace_id, external_id),
  FOREIGN KEY (workspace_id, tag_id) REFERENCES workspace_tags(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workspace_tag_identities_state CHECK ((tag_id IS NULL) = (retired_at IS NOT NULL)),
  CONSTRAINT workspace_tag_identities_retired_id CHECK (retired_at IS NULL OR btrim(external_id) <> '')
);

CREATE INDEX workspace_tag_identities_tag_idx ON workspace_tag_identities(tag_id) WHERE tag_id IS NOT NULL;

-- The primary key rejects contradictory input atomically. Neither source wins silently.
INSERT INTO workspace_tag_identities (workspace_id, external_id, tag_id, created_at)
SELECT workspace_id, legacy_id, tag_id, created_at FROM workspace_tag_legacy_ids;

INSERT INTO workspace_tag_identities (workspace_id, external_id, created_at, retired_at)
SELECT workspace_id, retired_tag_id, retired_at, retired_at FROM workspace_tag_retired_ids;

DROP TABLE workspace_tag_legacy_ids, workspace_tag_retired_ids;
