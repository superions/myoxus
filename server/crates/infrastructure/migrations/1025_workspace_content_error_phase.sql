-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Legacy causes remain readable without inventing an execution phase.
ALTER TABLE workspace_content_operations
  ADD COLUMN error_phase text,
  ADD CONSTRAINT workspace_content_error_phase_valid
    CHECK (error_phase IS NULL OR (error_code IS NOT NULL AND error_phase ~ '^[a-z_]{1,64}$'));
