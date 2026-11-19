ALTER TABLE workspace_content_operation_link_intents
    DROP CONSTRAINT workspace_content_operation_link_intents_target_kind_check,
    ADD CONSTRAINT workspace_content_operation_link_intents_target_kind_check
        CHECK (target_kind IN ('document', 'database', 'collection', 'tag', 'folder'));
