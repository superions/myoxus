-- SPDX-License-Identifier: AGPL-3.0-or-later
WITH RECURSIVE matching AS (
  SELECT source_block_id, raw_target_doc_id, target_workspace_id, params_json, source_position,
         dense_rank() OVER (ORDER BY (source_position->>'navigationOrder')::bigint) AS block_number
  FROM document_graph_occurrences
  WHERE workspace_id = $1 AND source_doc_id = $2
    AND source_position ? 'navigationOrder'
    AND EXISTS (SELECT FROM docs WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND NOT blocked)
), limited AS MATERIALIZED (
  SELECT * FROM matching WHERE block_number > $5 AND block_number <= $3 + $5
), addresses(origin, raw_key, scope, key, depth) AS (
  SELECT DISTINCT target_workspace_id, raw_target_doc_id, target_workspace_id, raw_target_doc_id, 0
  FROM limited WHERE target_workspace_id IS NOT NULL
  UNION ALL
  SELECT a.origin, a.raw_key, r.target_workspace_id, r.target_id, a.depth + 1
  FROM addresses a JOIN workspace_content_operation_redirects r
    ON r.source_workspace_id = a.scope AND r.source_kind = 'document'
      AND r.source_id = a.key AND r.target_kind = 'document'
  -- The original address, including a trashed document, shadows a redirect.
  -- At subsequent hops the graph's resolver stops only at a live document.
  WHERE a.depth + 1 < $4 AND NOT EXISTS (
    SELECT FROM docs d WHERE d.workspace_id = a.scope AND d.external_id = a.key
      AND (a.depth = 0 OR d.deleted_at IS NULL)
  )
), resolved AS MATERIALIZED (
  SELECT a.origin, a.raw_key, d.workspace_id, d.id, d.external_id, d.title
  FROM addresses a JOIN docs d ON d.workspace_id = a.scope AND d.external_id = a.key
  WHERE d.deleted_at IS NULL AND NOT d.blocked AND d.id <> $2
)
SELECT l.source_block_id, r.workspace_id, r.id, r.external_id, r.title, l.params_json
FROM limited l LEFT JOIN resolved r ON r.origin = l.target_workspace_id AND r.raw_key = l.raw_target_doc_id
ORDER BY l.block_number, (l.source_position->>'start')::bigint, l.raw_target_doc_id
