-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Existing history remains readable; only the newest decision stays actionable.
WITH ranked AS (
  SELECT id,row_number() OVER(PARTITION BY profile_id,doc_id ORDER BY created_at DESC,id DESC) AS position
  FROM git_sync_conflicts WHERE resolution='Open'
)
UPDATE git_sync_conflicts SET resolution='Dismissed',resolved_at=COALESCE(resolved_at,now())
WHERE id IN(SELECT id FROM ranked WHERE position>1);

WITH ranked AS (
  SELECT id,row_number() OVER(PARTITION BY profile_id,repo_path ORDER BY created_at DESC,id DESC) AS position
  FROM git_sync_file_conflicts WHERE resolution='Open'
)
UPDATE git_sync_file_conflicts SET resolution='Dismissed',resolved_at=COALESCE(resolved_at,now())
WHERE id IN(SELECT id FROM ranked WHERE position>1);

CREATE UNIQUE INDEX git_sync_open_document_conflict ON git_sync_conflicts(profile_id,doc_id) WHERE resolution='Open';
CREATE UNIQUE INDEX git_sync_open_file_conflict ON git_sync_file_conflicts(profile_id,repo_path) WHERE resolution='Open';
