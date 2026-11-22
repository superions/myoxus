-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Qualified references may protect bytes in a different physical workspace.
UPDATE document_blob_usage SET dirty=true, generation=generation+1, available_at=now() WHERE NOT dirty;
