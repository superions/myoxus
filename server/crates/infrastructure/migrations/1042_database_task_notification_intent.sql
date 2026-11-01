-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK (event_type IN (
  'mention', 'invite', 'comment_reply', 'access_change', 'doc_updated',
  'workspace_doc_broadcast', 'workspace_content_published', 'history_captured', 'calendar_mail',
  'database_task_notification'
));
