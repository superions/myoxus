-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Existing unanchored messages stay readable; only a claimed last pair is bound.
CREATE UNIQUE INDEX copilot_response_anchor_unique
  ON copilot_messages (session_id, (token_usage->>'responseTo'))
  WHERE role = 'assistant' AND token_usage->>'responseTo' IS NOT NULL;
CREATE UNIQUE INDEX copilot_submission_request_unique
  ON copilot_messages (session_id, (token_usage->>'inputRequestId'))
  WHERE role = 'user' AND token_usage->>'inputRequestId' IS NOT NULL;
CREATE UNIQUE INDEX copilot_generation_request_unique
  ON copilot_messages (session_id, (token_usage->>'requestId'))
  WHERE role = 'assistant' AND token_usage->>'requestId' IS NOT NULL;
