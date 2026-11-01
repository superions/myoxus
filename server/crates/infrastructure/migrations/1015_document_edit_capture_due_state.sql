-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE document_edit_capture_state (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  dirty_revision bigint NOT NULL CHECK (dirty_revision >= 0),
  first_pending_at timestamptz,
  due_at timestamptz,
  last_captured_revision bigint CHECK (last_captured_revision IS NULL OR last_captured_revision >= 0),
  last_captured_content_hash bytea,
  last_capture_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at timestamptz,
  configured_enabled boolean,
  configured_interval_ms bigint CHECK (
    configured_interval_ms IS NULL
    OR configured_interval_ms BETWEEN 900000 AND 86400000
  ),
  lifecycle_active boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, doc_id)
);

CREATE INDEX document_edit_capture_state_due_idx
  ON document_edit_capture_state (due_at, workspace_id, doc_id)
  WHERE due_at IS NOT NULL;

CREATE TABLE document_edit_capture_runtime (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_poll_at timestamptz NOT NULL
);
