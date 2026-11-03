-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Consent lives only in the shared target, not on copied/imported metadata.
ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_target_shape;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master','document_review'),false)
  AND (target_json->>'kind'='calendar_master' OR workspace_id IS NOT NULL)
  AND (target_json->>'kind'<>'calendar_master' OR
    (next_nominal IS NULL AND next_due_at IS NULL AND next_admission_at IS NULL))
  AND (target_json->>'kind'<>'document_review' OR
    (rule_json IS NULL AND COALESCE(jsonb_typeof(target_json->'enabled')='boolean',false)
      AND target_json->>'document_id' IS NOT NULL
      AND target_json->>'confirmed_by' IS NOT NULL)));
CREATE UNIQUE INDEX scheduling_document_review_source
  ON scheduling_schedules((target_json->>'document_id'))
  WHERE target_json->>'kind'='document_review';

CREATE FUNCTION cancel_document_review_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE scheduling_schedules SET
    target_json=jsonb_set(target_json,'{enabled}','false'),
    lifecycle='ended',next_nominal=NULL,next_due_at=NULL,next_admission_at=NULL,
    blocked_reason='documentUnavailable',generation=generation+1,revision=revision+1,
    updated_at=clock_timestamp()
  WHERE target_json->>'kind'='document_review'
    AND target_json->>'document_id'=OLD.id::text
    AND (target_json->>'enabled')::boolean;
  RETURN NULL;
END $$;
CREATE TRIGGER document_review_consent_lifecycle
  AFTER UPDATE OF deleted_at,workspace_id ON docs
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
  EXECUTE FUNCTION cancel_document_review_consent();
CREATE TRIGGER document_review_consent_deleted AFTER DELETE ON docs
  FOR EACH ROW EXECUTE FUNCTION cancel_document_review_consent();
