-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Snapshot row-template content is already a typed Database contract. Persist
-- its owned clone without replacing a shared workspace template instance.
ALTER TABLE workspace_database_row_templates
  ADD COLUMN content_document_id uuid;
-- Keep a missing owned address unavailable after permanent Doc deletion; a
-- nullable FK would erase the distinction and reactivate the registry fallback.
-- Publication and the guarded reader enforce the actual workspace boundary.
CREATE INDEX workspace_database_row_templates_content_document
  ON workspace_database_row_templates(content_document_id)
  WHERE content_document_id IS NOT NULL;
