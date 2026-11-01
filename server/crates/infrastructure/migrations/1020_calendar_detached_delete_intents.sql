-- Detached Calendar delete intents must survive removal of their local event.
ALTER TABLE calendar_pending_writes
  ALTER COLUMN event_id DROP NOT NULL;

ALTER TABLE calendar_pending_writes
  ADD CONSTRAINT calendar_pending_writes_detached_delete_check CHECK (
    event_id IS NOT NULL
    OR (
      operation = 'delete'
      AND jsonb_typeof(payload) = 'object'
      AND payload ->> 'schemaVersion' = '1'
      AND coalesce(payload ->> 'sourceEventId', '') <> ''
      AND coalesce(payload ->> 'provider', '') <> ''
      AND coalesce(payload ->> 'accountId', '') <> ''
      AND coalesce(payload ->> 'calendarId', '') <> ''
      AND coalesce(payload ->> 'remoteHref', '') <> ''
      AND coalesce(payload ->> 'remoteUid', '') <> ''
      AND coalesce(payload ->> 'etag', '') <> ''
    )
  );
