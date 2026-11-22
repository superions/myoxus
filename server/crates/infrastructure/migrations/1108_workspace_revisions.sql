-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE workspace_document_metadata_epoch RENAME TO workspace_revisions;
ALTER TABLE workspace_revisions RENAME CONSTRAINT workspace_document_metadata_epoch_pkey1 TO workspace_revisions_pkey;
ALTER TABLE workspace_revisions RENAME CONSTRAINT workspace_document_metadata_epoch_revision_check TO workspace_revisions_revision_check;
ALTER TABLE workspace_revisions RENAME CONSTRAINT workspace_document_metadata_epoch_updated_by_fkey TO workspace_revisions_updated_by_fkey;
ALTER TABLE workspace_revisions RENAME CONSTRAINT workspace_document_metadata_epoch_workspace_id_fkey1 TO workspace_revisions_workspace_id_fkey;
ALTER TABLE workspace_revisions DROP CONSTRAINT workspace_document_metadata_epoch_name_check,
  ADD CHECK (epoch_name IN ('defaults','document_index','database_page_inventory'));
CREATE OR REPLACE FUNCTION public.bump_workspace_document_metadata_epoch(p_workspace_id uuid, p_epoch_name text, p_actor_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    next_revision BIGINT;
BEGIN
    INSERT INTO workspace_revisions (workspace_id, epoch_name, revision, updated_by, updated_at)
    VALUES (p_workspace_id, p_epoch_name, 1, p_actor_id, now())
    ON CONFLICT (workspace_id, epoch_name) DO UPDATE
      SET revision = workspace_revisions.revision + 1,
          updated_by = p_actor_id,
          updated_at = now()
    RETURNING revision INTO next_revision;
    RETURN next_revision;
END;
$$;
INSERT INTO workspace_revisions(workspace_id,epoch_name,revision,updated_at)
SELECT workspace_id,'document_index',revision,updated_at FROM workspace_document_metadata_index_revision;
CREATE OR REPLACE FUNCTION bump_workspace_document_metadata_index_revision(p_workspace_id uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT bump_workspace_document_metadata_epoch(p_workspace_id,'document_index')
  WHERE EXISTS (SELECT FROM workspaces WHERE id=p_workspace_id)
$$;
DROP TABLE workspace_document_metadata_index_revision;
INSERT INTO workspace_revisions(workspace_id,epoch_name,revision,updated_at)
SELECT workspace_id,'database_page_inventory',revision,updated_at FROM workspace_database_page_inventory_revision;
CREATE OR REPLACE FUNCTION bump_workspace_database_page_inventory_revision(p_workspace_id uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT bump_workspace_document_metadata_epoch(p_workspace_id,'database_page_inventory')
  WHERE EXISTS (SELECT FROM workspaces WHERE id=p_workspace_id)
$$;
DROP TABLE workspace_database_page_inventory_revision;
