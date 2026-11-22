-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A stream, including a private or recoverably trashed leaf, belongs to its
-- physical storage workspace. Dirty coverage cannot authorize an unused read.
CREATE TABLE document_blob_usage (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 1,
  keys text[] NOT NULL DEFAULT '{}',
  dirty boolean NOT NULL DEFAULT true,
  available_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,doc_id)
);
CREATE INDEX document_blob_usage_due ON document_blob_usage(available_at,workspace_id,doc_id) WHERE dirty;
CREATE INDEX document_blob_usage_pending ON document_blob_usage(workspace_id) WHERE dirty;
CREATE INDEX document_blob_usage_keys ON document_blob_usage USING gin(keys) WHERE cardinality(keys)>0;

CREATE FUNCTION invalidate_document_blob_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO document_blob_usage(workspace_id,doc_id) VALUES(NEW.workspace_id,NEW.doc_id)
  ON CONFLICT(workspace_id,doc_id) DO UPDATE SET
    generation=document_blob_usage.generation+1, dirty=true, available_at=now();
  RETURN NEW;
END $$;
CREATE TRIGGER blob_usage_update AFTER INSERT OR UPDATE OF payload,workspace_id,doc_id ON doc_updates
  FOR EACH ROW EXECUTE FUNCTION invalidate_document_blob_usage();
CREATE TRIGGER blob_usage_snapshot AFTER INSERT OR UPDATE OF payload,workspace_id,doc_id ON doc_snapshots
  FOR EACH ROW EXECUTE FUNCTION invalidate_document_blob_usage();
INSERT INTO document_blob_usage(workspace_id,doc_id)
  SELECT workspace_id,doc_id FROM doc_snapshots UNION SELECT workspace_id,doc_id FROM doc_updates;
