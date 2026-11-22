-- Move only binary streams belonging to private documents. Deletion of a
-- former team container must never cascade into the private journal.
CREATE TEMP TABLE private_storage_moves ON COMMIT DROP AS
SELECT d.id AS doc_id, w.id AS destination
FROM docs d
LEFT JOIN workspaces w ON w.owner_user_id = d.userspace_owner_id
  AND w.is_personal_workspace AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
WHERE d.userspace_owner_id IS NOT NULL AND (
  EXISTS (SELECT FROM doc_updates u WHERE u.doc_id=d.id AND u.workspace_id IS DISTINCT FROM w.id)
  OR EXISTS (SELECT FROM doc_snapshots s WHERE s.doc_id=d.id AND s.workspace_id IS DISTINCT FROM w.id)
  OR EXISTS (SELECT FROM doc_histories h WHERE h.doc_id=d.id AND h.workspace_id IS DISTINCT FROM w.id)
);
DO $$ BEGIN
  IF EXISTS (SELECT FROM private_storage_moves WHERE destination IS NULL) THEN
    RAISE EXCEPTION 'Provision the missing personal workspace for users with persisted private documents before retrying';
  END IF;
END $$;

CREATE TEMP TABLE private_snapshot_spaces ON COMMIT DROP AS
SELECT s.workspace_id FROM doc_snapshots s JOIN private_storage_moves m USING (doc_id)
UNION SELECT m.destination FROM private_storage_moves m JOIN doc_snapshots s USING (doc_id);
UPDATE doc_updates s SET workspace_id=m.destination FROM private_storage_moves m WHERE s.doc_id=m.doc_id AND s.workspace_id<>m.destination;
UPDATE doc_histories s SET workspace_id=m.destination FROM private_storage_moves m WHERE s.doc_id=m.doc_id AND s.workspace_id<>m.destination;
UPDATE doc_snapshots s SET workspace_id=m.destination FROM private_storage_moves m WHERE s.doc_id=m.doc_id AND s.workspace_id<>m.destination;
INSERT INTO workspace_storage_stats(workspace_id,snapshot_size)
SELECT p.workspace_id, COALESCE(SUM(length(s.payload)),0)
FROM private_snapshot_spaces p LEFT JOIN doc_snapshots s USING (workspace_id) GROUP BY p.workspace_id
ON CONFLICT(workspace_id) DO UPDATE SET snapshot_size=excluded.snapshot_size, updated_at=now();
