-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Historical receipts keep their original normalization and are never rewritten.
ALTER TABLE mcp_idempotency_keys
  ADD COLUMN document_payload_format SMALLINT NOT NULL DEFAULT 0
  CHECK (document_payload_format IN (0, 1));
