-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Pending windows are their own durable intent and disappear on completion.
CREATE TABLE document_change_batches (
  id uuid PRIMARY KEY,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  last_changed_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL CHECK (due_at > started_at),
  first_sequence bigint NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  sealed_at timestamptz
);
CREATE UNIQUE INDEX document_change_batches_active_doc
  ON document_change_batches(doc_id) WHERE sealed_at IS NULL;
CREATE INDEX document_change_batches_due ON document_change_batches(due_at, id);

CREATE TABLE document_change_batch_actors (
  batch_id uuid NOT NULL REFERENCES document_change_batches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_sequence bigint NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  PRIMARY KEY (batch_id, user_id)
);
