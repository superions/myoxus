-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Lifecycle evidence deliberately survives deletion of docs and its CRDT data.
CREATE TABLE page_registration_evidence (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  doc_id UUID NOT NULL,
  creation_intent TEXT,
  state TEXT NOT NULL CHECK (state IN ('legacy', 'unresolved', 'pending', 'registered', 'deleted')),
  PRIMARY KEY (workspace_id, external_id),
  UNIQUE (workspace_id, doc_id)
);

-- Existing identity is evidence; an invented creation event is not.
INSERT INTO page_registration_evidence (workspace_id, external_id, doc_id, state)
SELECT workspace_id, external_id, id, 'legacy'
FROM docs
WHERE workspace_id IS NOT NULL AND external_id IS NOT NULL
  AND id <> workspace_id AND NOT is_workspace_root
  AND external_id NOT LIKE 'db$%' AND external_id NOT LIKE 'userdata$%';
