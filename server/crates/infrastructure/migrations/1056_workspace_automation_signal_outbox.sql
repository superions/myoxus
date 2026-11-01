-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Native review decisions and invalidations commit correlated signal intents
-- in the existing outbox before the runtime dispatcher acknowledges delivery.
ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK (event_type IN (
  'mention', 'invite', 'comment_reply', 'access_change', 'doc_updated',
  'workspace_doc_broadcast', 'workspace_content_published', 'history_captured', 'calendar_mail',
  'database_task_notification', 'workspace_automation_trigger', 'workspace_automation_signal'
));
