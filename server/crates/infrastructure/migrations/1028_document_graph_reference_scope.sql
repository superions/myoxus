-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Unqualified shipped occurrences belong to their containing workspace.
ALTER TABLE document_graph_occurrences ADD COLUMN target_workspace_id uuid;
ALTER TABLE document_graph_occurrences ADD COLUMN source_position jsonb NOT NULL DEFAULT 'null'::jsonb;
UPDATE document_graph_occurrences SET target_workspace_id = workspace_id;
DROP INDEX ux_document_graph_occurrence_identity;
CREATE UNIQUE INDEX ux_document_graph_occurrence_identity ON document_graph_occurrences
  (workspace_id, source_doc_id, source_block_id, target_workspace_id, raw_target_doc_id, link_kind, params_key)
  NULLS NOT DISTINCT;
-- Existing derived-index refresh rebuilds typed positions from canonical snapshots.
UPDATE document_graph_index_state SET stale_state = 'stale' WHERE stale_state = 'current';

ALTER TABLE database_document_references ADD COLUMN target_workspace_id uuid;
UPDATE database_document_references SET target_workspace_id = workspace_id;
