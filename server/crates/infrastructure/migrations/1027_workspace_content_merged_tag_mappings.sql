-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Shared Tag classifications may converge; exclusive content remains bijective.
ALTER TABLE workspace_content_operation_mappings
  DROP CONSTRAINT workspace_content_operation_m_operation_id_target_workspace_key;
CREATE UNIQUE INDEX workspace_content_operation_exclusive_target_identity
  ON workspace_content_operation_mappings
    (operation_id, target_workspace_id, target_kind, target_id)
  WHERE target_kind <> 'tag';
