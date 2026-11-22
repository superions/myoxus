-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One statement snapshot for the readiness fence, the total and the page.
WITH coverage AS (
  -- An unprojected document can contain a qualified reference to another workspace.
  SELECT NOT EXISTS(SELECT FROM document_blob_usage WHERE dirty) AS ready
), candidates AS MATERIALIZED (
  SELECT b.* FROM blobs b JOIN workspaces w ON w.id=b.workspace_id
  WHERE (SELECT ready FROM coverage) AND b.workspace_id=$1 AND b.deleted_at IS NULL AND b.status='completed'
    AND b.key IS DISTINCT FROM w.avatar_key AND ($4::text[] IS NULL OR b.key=ANY($4))
    AND NOT EXISTS(SELECT FROM document_blob_usage u WHERE cardinality(u.keys)>0 AND u.keys @> ARRAY[$1::uuid::text || '/' || b.key])
    AND NOT EXISTS(SELECT FROM public_asset_manifest a WHERE a.workspace_id=$1 AND a.blob_key=b.key)
    AND NOT EXISTS(SELECT FROM git_sync_file_bindings g WHERE g.workspace_id=$1 AND NOT g.tombstoned AND g.blob_key=b.key)
    AND NOT EXISTS(SELECT FROM comment_attachments a WHERE a.workspace_id=$1 AND a.storage_key=b.key)
    AND NOT EXISTS(SELECT FROM copilot_messages m JOIN copilot_sessions s ON s.id=m.session_id
      WHERE s.workspace_id=$1 AND m.content->'__attachmentRefs' @> jsonb_build_array(jsonb_build_object('blobKey',b.key)))
    AND NOT EXISTS(SELECT FROM copilot_context_items i JOIN copilot_contexts c ON c.id=i.context_id
      WHERE c.workspace_id=$1 AND i.item_type='file' AND (i.item_ref=b.key OR i.metadata->>'blobId'=b.key))
    AND NOT EXISTS(SELECT FROM workspace_database_cell_values c JOIN workspace_databases d ON d.id=c.database_id
      WHERE d.workspace_id=$1 AND c.value_json @> jsonb_build_object('files', jsonb_build_array(jsonb_build_object('blobKey',b.key))))
    AND NOT EXISTS(SELECT FROM workspace_database_row_templates t, LATERAL jsonb_each(t.initial_cell_values_json) v
      WHERE t.workspace_id=$1 AND v.value @> jsonb_build_object('files', jsonb_build_array(jsonb_build_object('blobKey',b.key))))
), page AS (SELECT * FROM candidates ORDER BY created_at DESC,key LIMIT $2 OFFSET $3)
SELECT coverage.ready,(SELECT count(*) FROM candidates) AS total,page.*
FROM coverage LEFT JOIN page ON true ORDER BY page.created_at DESC,page.key
