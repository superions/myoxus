-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Delivery supersession is scoped by stable ICS UID, recipient and occurrence.
-- Retain efficient lookup after intent processing and event deletion.
CREATE INDEX idx_calendar_mail_scope_sequence ON outbox_events (
  (COALESCE(payload->'event'->>'remote_event_id', payload->'event'->>'id')),
  (lower(payload->>'to')),
  (payload->'event'->'payload'->>'recurrenceId'),
  ((payload->>'sequence')::bigint)
) WHERE event_type = 'calendar_mail';
