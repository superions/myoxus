-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Responsible is a canonical list fact; reuse the existing workspace index epoch.
CREATE TRIGGER trg_docs_document_metadata_index_responsible
AFTER UPDATE OF responsible_user_id ON docs
FOR EACH ROW
WHEN (OLD.responsible_user_id IS DISTINCT FROM NEW.responsible_user_id)
EXECUTE FUNCTION document_metadata_index_touch_docs();
