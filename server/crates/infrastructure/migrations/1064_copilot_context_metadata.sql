-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The application already owns context metadata; retain it across SQL reloads.
ALTER TABLE copilot_contexts ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Native deployed contexts use this exact name. Bind only a matching owned
-- session in the same workspace; unrelated named contexts remain unchanged.
UPDATE copilot_contexts AS context
SET metadata = jsonb_build_object('sessionId', session.id::text, 'name', 'session-context')
FROM copilot_sessions AS session
WHERE context.name = 'session-' || session.id::text
  AND context.user_id = session.user_id
  AND context.workspace_id IS NOT DISTINCT FROM session.workspace_id;
