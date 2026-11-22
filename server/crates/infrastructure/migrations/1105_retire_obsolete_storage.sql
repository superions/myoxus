-- key_hash already has a UNIQUE btree used by API key lookup.
DROP INDEX idx_api_keys_key_hash;
DROP TABLE brand_identity_cutover_findings;

-- These legacy owners have no product writer or reader. Refuse to discard a
-- nonstandard installation's original branding or version-artifact references.
DO $$ BEGIN
  IF EXISTS (SELECT FROM branding_assets) OR EXISTS (SELECT FROM branding_profiles)
     OR EXISTS (SELECT FROM document_version_artifact) THEN
    RAISE EXCEPTION 'Resolve retained legacy branding or document version artifact references before retiring their tables';
  END IF;
END $$;
DROP TABLE branding_assets, branding_profiles, document_version_artifact;
-- Local Copilot prototypes. Retrieval and indexing use copilot_embeddings.
DROP TABLE ai_workspace_file_embeddings, ai_workspace_doc_embeddings, ai_workspace_ignored_docs;
