-- SPDX-License-Identifier: AGPL-3.0-or-later
ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK (event_type IN (
  'mention', 'invite', 'comment_reply', 'access_change', 'doc_updated',
  'workspace_doc_broadcast', 'workspace_content_published', 'history_captured', 'calendar_mail'
));

-- Provider imports do not advance the last authored scheduling projection.
CREATE TABLE calendar_mail_state (
  event_id uuid PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  fingerprint jsonb NOT NULL,
  event_snapshot jsonb NOT NULL,
  recipients jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Completed outcomes suppress Redis/outbox replays. SMTP and SQL cannot form
-- one atomic transaction; an interrupted successful send can be retried.
CREATE TABLE calendar_mail_receipts (
  intent_id uuid PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendar_reminder_mail_receipts (
  reminder_id uuid NOT NULL REFERENCES calendar_reminders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reminder_id, user_id)
);
