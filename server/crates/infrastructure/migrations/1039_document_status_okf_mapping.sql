-- SPDX-License-Identifier: AGPL-3.0-or-later
ALTER TABLE document_status_value
  ADD COLUMN okf_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (okf_status IN ('draft', 'stable', 'deprecated'));

UPDATE document_status_value SET okf_status = 'stable' WHERE id IN (
  '3ca4f1d5-0aa3-4efd-bee0-cdefe321f30a',
  'd6bb710f-d58e-45d5-abc6-5718ec8cb16b',
  'f7f29cfe-68f2-4e07-a315-38755ce1bac4',
  '6d0a5fc4-2e42-417e-a1b3-ed13f6298450'
);
UPDATE document_status_value SET okf_status = 'deprecated' WHERE id IN (
  'd349f307-8798-42e6-bcd4-6d49f7a321b6',
  'fe07b6f6-eb4b-4bdb-b92e-948bffe6c5af',
  '84b353af-cebc-44bd-b0ce-b59e7dffde03',
  '54532737-b096-4afa-911f-20a9e74d6d04',
  'ce2fd22b-eb80-4580-95a8-664722d4db4a',
  'b86cd7d8-a79e-4f5f-b280-0a4513d9b2a5'
);
