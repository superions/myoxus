-- SPDX-License-Identifier: AGPL-3.0-or-later

LOCK TABLE git_sync_bindings, git_sync_file_bindings, git_sync_conflicts,
    git_sync_file_conflicts IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER trg_git_sync_document_path_owner ON git_sync_bindings;
DROP TRIGGER trg_git_sync_file_path_owner ON git_sync_file_bindings;
DROP FUNCTION sync_git_sync_document_path_owner(), sync_git_sync_file_path_owner();
DROP TABLE git_sync_path_owners;

ALTER TABLE git_sync_conflicts DROP CONSTRAINT git_sync_conflicts_binding_id_fkey;
ALTER TABLE git_sync_file_conflicts DROP CONSTRAINT git_sync_file_conflicts_binding_id_fkey;

ALTER TABLE git_sync_bindings
    ALTER COLUMN doc_id DROP NOT NULL,
    ALTER COLUMN sync_id DROP NOT NULL,
    DROP CONSTRAINT git_sync_bindings_pkey,
    ADD COLUMN blob_key text,
    ADD COLUMN mime_type text,
    ADD COLUMN file_size bigint;

-- Existing document and file IDs belong to independent namespaces.
ALTER TABLE git_sync_bindings
    ADD COLUMN binding_kind text GENERATED ALWAYS AS
        (CASE WHEN blob_key IS NULL THEN 'document' ELSE 'file' END) STORED,
    ADD PRIMARY KEY (id, binding_kind),
    ADD CONSTRAINT git_sync_binding_shape CHECK (
        (blob_key IS NULL AND doc_id IS NOT NULL AND sync_id IS NOT NULL
         AND mime_type IS NULL AND file_size IS NULL)
        OR
        (blob_key IS NOT NULL AND doc_id IS NULL AND sync_id IS NULL
         AND mime_type IS NOT NULL AND file_size IS NOT NULL AND content_hash IS NOT NULL
         AND last_commit_oid IS NULL AND structure_hash IS NULL AND baseline_content_hash IS NULL)
    ),
    ADD FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

INSERT INTO git_sync_bindings
    (id, profile_id, workspace_id, blob_key, repo_path, content_hash,
     mime_type, file_size, tombstone, created_at, updated_at)
SELECT id, profile_id, workspace_id, blob_key, repo_path, content_hash,
       mime_type, file_size, tombstoned, created_at, updated_at
FROM git_sync_file_bindings;

DROP TABLE git_sync_file_bindings;
DROP INDEX idx_git_sync_bindings_profile_active;
CREATE UNIQUE INDEX git_sync_active_path ON git_sync_bindings(profile_id, repo_path) WHERE NOT tombstone;
-- A retired file is revived by path, even after a document temporarily owned it.
CREATE UNIQUE INDEX git_sync_file_path ON git_sync_bindings(profile_id, repo_path) WHERE binding_kind = 'file';
CREATE INDEX git_sync_bindings_workspace ON git_sync_bindings(workspace_id);

ALTER TABLE git_sync_conflicts
    ADD COLUMN binding_kind text NOT NULL DEFAULT 'document' CHECK (binding_kind = 'document'),
    ADD FOREIGN KEY (binding_id, binding_kind) REFERENCES git_sync_bindings(id, binding_kind) ON DELETE CASCADE;
ALTER TABLE git_sync_file_conflicts
    ADD COLUMN binding_kind text NOT NULL DEFAULT 'file' CHECK (binding_kind = 'file'),
    ADD FOREIGN KEY (binding_id, binding_kind) REFERENCES git_sync_bindings(id, binding_kind) ON DELETE SET NULL (binding_id);

CREATE VIEW git_sync_document_bindings AS
SELECT id, binding_kind, profile_id, workspace_id, doc_id, sync_id, repo_path, last_commit_oid,
       content_hash, structure_hash, tombstone, created_at, updated_at, baseline_content_hash,
       baseline_commit_oid, baseline_myoxus_updated_at, baseline_captured_at
FROM git_sync_bindings WHERE binding_kind = 'document' WITH LOCAL CHECK OPTION;

CREATE VIEW git_sync_file_bindings AS
SELECT id, binding_kind, profile_id, workspace_id, blob_key, repo_path, content_hash,
       mime_type, file_size, tombstone AS tombstoned, created_at, updated_at
FROM git_sync_bindings WHERE binding_kind = 'file' WITH LOCAL CHECK OPTION;
ALTER VIEW git_sync_file_bindings ALTER COLUMN mime_type SET DEFAULT 'application/octet-stream';
ALTER VIEW git_sync_file_bindings ALTER COLUMN file_size SET DEFAULT 0;
