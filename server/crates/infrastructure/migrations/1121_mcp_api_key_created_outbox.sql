-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Admit durable MCP API-key creation notification intents in the shared outbox.
ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','calendar_reminder_due',
  'database_reminder_due','git_cron_due','git_polling_due','git_rotation_due','registered_job_due',
  'database_task_notification','workspace_automation_trigger','workspace_automation_signal',
  'task_recurrence_due','mcp_api_key_created'));
