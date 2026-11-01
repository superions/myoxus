-- Authorship does not identify who selected a revision as current: local CLI
-- imports and server-authored revisions can both be published by an operator.
-- Preserve all unknown existing publications; only the release batch writer
-- marks its own publication, and ordinary publication clears that provenance.
ALTER TABLE template_revisions
  ADD COLUMN release_managed_publication boolean NOT NULL DEFAULT false;
