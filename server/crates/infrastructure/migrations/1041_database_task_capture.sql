-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Capture receipts deliberately have no Row/Database/Doc FK: purge cannot reopen admission.
CREATE TABLE database_task_capture_receipts (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  database_id uuid NOT NULL,
  row_id uuid NOT NULL,
  edit_revision bigint NOT NULL,
  source_json jsonb NOT NULL,
  PRIMARY KEY (actor_id, workspace_id, request_id)
);
CREATE TABLE database_row_source_links (
  row_id uuid PRIMARY KEY REFERENCES workspace_database_rows(id) ON DELETE CASCADE,
  source_workspace_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  source_external_id text NOT NULL,
  block_id text,
  selection_anchor text
);
ALTER TABLE database_document_references DROP CONSTRAINT database_document_references_reference_kind_check;
ALTER TABLE database_document_references DROP CONSTRAINT database_document_references_shape;
ALTER TABLE database_document_references ADD CONSTRAINT database_document_references_reference_kind_check
  CHECK (reference_kind IN ('row_content_document', 'document_link_field', 'task_source'));
ALTER TABLE database_document_references ADD CONSTRAINT database_document_references_shape
  CHECK ((reference_kind IN ('row_content_document', 'task_source') AND field_id IS NULL)
    OR (reference_kind = 'document_link_field' AND field_id IS NOT NULL));
CREATE UNIQUE INDEX database_document_references_task_source_unique
  ON database_document_references(row_id) WHERE reference_kind = 'task_source';
