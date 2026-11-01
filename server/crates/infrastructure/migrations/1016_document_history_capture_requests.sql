-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE document_history_capture_request (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  request_fingerprint bytea NOT NULL,
  history_id bigint NOT NULL REFERENCES doc_histories(id) ON DELETE CASCADE,
  version_id uuid REFERENCES document_version(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, workspace_id, doc_id, request_key)
);

CREATE INDEX document_history_capture_request_created_idx
  ON document_history_capture_request (created_at, actor_id);
