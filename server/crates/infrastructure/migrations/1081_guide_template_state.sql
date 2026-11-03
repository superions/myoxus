-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Reuse the canonical native classification. Reader introductions are neither
-- ordinary inventory items nor reusable template sources.
ALTER TABLE document_template_state
  DROP CONSTRAINT document_template_state_state_check,
  ADD CONSTRAINT document_template_state_state_check
    CHECK (state IN ('none', 'seeded', 'managed', 'detached', 'retired', 'guide'));

INSERT INTO document_template_state(doc_id, state, source)
SELECT d.id,
  CASE WHEN revision.manifest_json ->> 'purpose' = 'guide'
    OR (revision.id IS NULL AND catalog.category = 'onboarding')
    THEN 'guide' ELSE 'managed' END,
  'workspace'
FROM workspace_template_instances instance
JOIN template_catalog_entries catalog ON catalog.id = instance.template_id
LEFT JOIN template_revisions revision ON revision.id = instance.revision_id
JOIN docs d ON d.workspace_id = instance.workspace_id
  AND (d.id = instance.workspace_doc_id OR
    (instance.workspace_doc_id IS NULL AND d.external_id = instance.workspace_doc_key))
WHERE NOT d.is_workspace_root
ON CONFLICT (doc_id) DO UPDATE SET state = EXCLUDED.state
WHERE EXCLUDED.state = 'guide' OR document_template_state.state = 'none';
