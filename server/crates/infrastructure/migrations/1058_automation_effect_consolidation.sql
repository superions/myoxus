-- SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Unaccepted development runs and legacy non-effect rows have no executable
-- intent. Their existing cascades remove runtime/history rows, never user content.
DELETE FROM workspace_automation_runs WHERE accepted_json IS NULL;
DELETE FROM workspace_automation_actions
WHERE node_key IS NULL OR effect_key IS NULL
   OR input_fingerprint IS NULL OR reserved_id IS NULL;

ALTER TABLE workspace_automation_runs
  ALTER COLUMN accepted_json SET NOT NULL,
  DROP COLUMN definition_hash;

ALTER TABLE workspace_automation_actions
  DROP CONSTRAINT workspace_automation_actions_action_type_check,
  DROP CONSTRAINT workspace_automation_actions_status_check,
  DROP COLUMN action_type,
  DROP COLUMN error_code,
  DROP COLUMN error_message,
  DROP COLUMN started_at,
  DROP COLUMN finished_at,
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN node_key SET NOT NULL,
  ALTER COLUMN effect_key SET NOT NULL,
  ALTER COLUMN input_fingerprint SET NOT NULL,
  ALTER COLUMN reserved_id SET NOT NULL,
  ADD COLUMN webhook_delivery_json jsonb,
  ADD CONSTRAINT workspace_automation_actions_status_check
    CHECK (status IN ('running', 'succeeded'));

DROP INDEX workspace_automation_effect_identity;
CREATE UNIQUE INDEX workspace_automation_effect_identity
  ON workspace_automation_actions(run_id, node_key, effect_key);
DROP INDEX idx_workspace_automation_actions_run;

-- Outbound diagnostics now belong to the native effect; its action UUID is
-- still the delivery identity. Incoming Git-Sync delivery storage is unrelated.
DROP TABLE workspace_automation_webhook_deliveries;
