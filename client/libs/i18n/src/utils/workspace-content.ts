// SPDX-License-Identifier: AGPL-3.0-or-later

/** Translate server-authored causes by stable code, never raw exceptions. */
export function workspaceContentFailureKey(
  message: string | null | undefined,
  code?: string | null,
) {
  if (!code || code === "XWS_UNEXPECTED_VALIDATION") {
    switch (message) {
      case "workspace content Extract Blob":
        return "com.myoxus.workspace-content-operation.error.extract-blob-missing";
      case "workspace content Extract Blob is too large":
        return "com.myoxus.workspace-content-operation.error.extract-blob-size";
      case "workspace content Extract Blob staging manifest is incomplete":
        return "com.myoxus.workspace-content-operation.error.extract-stage-manifest";
      case "workspace content Extract document ACL identity is missing":
        return "com.myoxus.workspace-content-operation.error.extract-acl-identity";
      case "workspace content Extract membership snapshot is invalid":
        return "com.myoxus.workspace-content-operation.error.extract-membership";
      case "workspace content Extract preflight is not executable":
        return "com.myoxus.workspace-content-operation.error.extract-admission";
      case "workspace content Extract receipt":
        return "com.myoxus.workspace-content-operation.error.extract-receipt";
      case "workspace content Extract target receipt":
        return "com.myoxus.workspace-content-operation.error.extract-target-receipt";
      case "workspace content Extract staged Blob changed":
        return "com.myoxus.workspace-content-operation.error.extract-staged-blob";
      case "workspace content Extract source Blob changed before staging completed":
        return "com.myoxus.workspace-content-operation.error.extract-source-blob";
      case "workspace content Extract source folder is missing":
        return "com.myoxus.workspace-content-operation.error.extract-source-folder";
      case "workspace content Extract source workspace":
        return "com.myoxus.workspace-content-operation.error.extract-source-workspace";
      case "workspace content Move actor":
        return "com.myoxus.workspace-content-operation.error.move-actor";
      case "workspace content Move mapping boundary is invalid":
        return "com.myoxus.workspace-content-operation.error.move-mapping-boundary";
      case "workspace content Move mapping is invalid":
        return "com.myoxus.workspace-content-operation.error.move-mapping";
      case "workspace content Move recipient resource count is invalid":
        return "com.myoxus.workspace-content-operation.error.move-recipient-count";
      case "workspace content Move revision manifest is invalid":
        return "com.myoxus.workspace-content-operation.error.move-manifest";
      case "workspace content source document identity is invalid":
        return "com.myoxus.workspace-content-operation.error.source-document-key";
      case "workspace content Move Tag identity is invalid":
        return "com.myoxus.workspace-content-operation.error.tag-identity-format";
      case "workspace content Move Database identity is invalid":
        return "com.myoxus.workspace-content-operation.error.database-identity-format";
    }
  }
  // Detailed codes take precedence over old persisted category-only messages.
  switch (code) {
    case "XWS_GIT_SYNC_REMOTE_UNAVAILABLE":
      return "com.myoxus.workspace-content-operation.git.remote";
    case "XWS_GIT_SYNC_METADATA_CONFLICT":
      return "com.myoxus.workspace-content-operation.git.metadata-conflict";
    case "XWS_GIT_SYNC_METADATA_AUTH_DENIED":
      return "com.myoxus.workspace-content-operation.git.auth";
    case "XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING":
      return "com.myoxus.workspace-content-operation.git.outbound";
    case "XWS_GIT_SYNC_UNDO_PENDING":
      return "com.myoxus.workspace-content-operation.git.undo-pending";
    case "XWS_GIT_SYNC_UNDO_OWNERSHIP_CHANGED":
      return "com.myoxus.workspace-content-operation.git.undo-ownership";
    case "XWS_GIT_SYNC_UNDO_CONTENT_CHANGED":
      return "com.myoxus.workspace-content-operation.git.undo-content";
    case "XWS_GIT_SYNC_UNDO_TARGET_NOT_EMPTY":
      return "com.myoxus.workspace-content-operation.git.undo-target";
    case "XWS_GIT_SYNC_HANDOFF_UNAVAILABLE":
      return "com.myoxus.workspace-content-operation.git.unavailable";
    case "XWS_OPERATION_STATE_INVALID":
      return "com.myoxus.workspace-content-operation.error.operation-state-invalid";
    case "XWS_MOVE_DOCUMENT_METADATA_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-document-metadata-changed";
    case "XWS_MOVE_DOCUMENT_ACL_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-document-acl-changed";
    case "XWS_EXTRACT_OPERATION_REVISION_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-operation-revision-changed";
    case "XWS_EXTRACT_TARGET_REPLAY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-target-replay-changed";
    case "XWS_EXTRACT_TARGET_LIFECYCLE_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-target-lifecycle-changed";
    case "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-membership-snapshot-changed";
    case "XWS_EXTRACT_RECOVERY_TARGET_RECEIPT_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.extract-recovery-target-receipt-is-missing";
    case "XWS_PUBLISHED_EXTRACT_CANNOT_BE_COMPENSATED":
      return "com.myoxus.workspace-content-operation.error.published-extract-cannot-be-compensated";
    case "XWS_EXTRACT_RECOVERY_STATE_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-recovery-state-changed";
    case "XWS_EXTRACT_RECOVERY_TARGET_LIFECYCLE_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-recovery-target-lifecycle-changed";
    case "XWS_COPY_TARGET_POLICY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.copy-target-policy-changed";
    case "XWS_COPY_TARGET_PAGE_DIRECTORY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.copy-target-page-directory-changed";
    case "XWS_MOVE_REVISION_MANIFEST_REPLAY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-revision-manifest-replay-changed";
    case "XWS_MOVE_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW":
      return "com.myoxus.workspace-content-operation.error.move-tag-lineage-requires-a-fresh-preview";
    case "XWS_MOVE_REFERENCES_REQUIRE_A_FRESH_PREVIEW":
      return "com.myoxus.workspace-content-operation.error.move-references-require-a-fresh-preview";
    case "XWS_MOVE_OPERATION_REVISION_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-operation-revision-changed";
    case "XWS_MOVE_TAG_LINEAGE_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.move-tag-lineage-is-missing";
    case "XWS_MOVE_DATABASE_REVISION_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.move-database-revision-is-missing";
    case "XWS_MOVE_DATABASE_CHILD_OWNERSHIP_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-database-child-ownership-changed";
    case "XWS_MOVE_DOCUMENT_REVISION_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.move-document-revision-is-missing";
    case "XWS_MOVE_DOCUMENT_CLASSIFICATIONS_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-document-classifications-changed";
    case "XWS_MOVE_DOCUMENT_OWNERSHIP_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-document-ownership-changed";
    case "XWS_MOVE_DOCUMENT_CHILD_COUNT_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.move-document-child-count-is-missing";
    case "XWS_MOVE_DOCUMENT_CHILD_OWNERSHIP_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-document-child-ownership-changed";
    case "XWS_MOVE_REFERENCE_SOURCE_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-reference-source-changed";
    case "XWS_MOVE_REFERENCE_PLAN_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.move-reference-plan-is-missing";
    case "XWS_MOVE_TARGET_PAGE_DIRECTORY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-target-page-directory-changed";
    case "XWS_EXTRACT_TARGET_ACTIVATION_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-target-activation-changed";
    case "XWS_EXTRACT_TARGET_RECEIPT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-target-receipt-changed";
    case "XWS_EXTRACT_BLOB_STAGING_STATE_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-blob-staging-state-changed";
    case "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_IS_INVALID":
      return "com.myoxus.workspace-content-operation.error.extract-membership-snapshot-is-invalid";
    case "XWS_EXTRACT_RECIPIENT_SNAPSHOT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-recipient-snapshot-changed";
    case "XWS_MOVE_RECIPIENT_SNAPSHOT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-recipient-snapshot-changed";
    case "XWS_MOVE_MAPPING_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-mapping-changed";
    case "XWS_MOVE_PERSISTED_REVISION_MANIFEST_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-persisted-revision-manifest-changed";
    case "XWS_PREPARED_TAG_IDENTITY_WAS_RETIRED":
      return "com.myoxus.workspace-content-operation.error.prepared-tag-identity-was-retired";
    case "XWS_PREPARED_TAG_IS_NO_LONGER_REUSABLE":
      return "com.myoxus.workspace-content-operation.error.prepared-tag-is-no-longer-reusable";
    case "XWS_CONCURRENT_TAG_IDENTITY_IS_NOT_REUSABLE":
      return "com.myoxus.workspace-content-operation.error.concurrent-tag-identity-is-not-reusable";
    case "XWS_MOVED_TAG_CELL_DISAPPEARED":
      return "com.myoxus.workspace-content-operation.error.moved-tag-cell-disappeared";
    case "XWS_MOVED_TAG_TEMPLATE_DISAPPEARED":
      return "com.myoxus.workspace-content-operation.error.moved-tag-template-disappeared";
    case "XWS_MOVED_TAG_FILTER_DISAPPEARED":
      return "com.myoxus.workspace-content-operation.error.moved-tag-filter-disappeared";
    case "XWS_MOVED_TAG_PREDICATE_DISAPPEARED":
      return "com.myoxus.workspace-content-operation.error.moved-tag-predicate-disappeared";
    case "XWS_MOVED_TAG_FILTER_CONTAINER_CHANGED":
      return "com.myoxus.workspace-content-operation.error.moved-tag-filter-container-changed";
    case "XWS_OWNED_TAG_CLASSIFICATION_CHANGED":
      return "com.myoxus.workspace-content-operation.error.owned-tag-classification-changed";
    case "XWS_PLANNED_TAG_IDENTITY_WAS_RETIRED":
      return "com.myoxus.workspace-content-operation.error.planned-tag-identity-was-retired";
    case "XWS_PLANNED_TAG_IS_NO_LONGER_REUSABLE":
      return "com.myoxus.workspace-content-operation.error.planned-tag-is-no-longer-reusable";
    case "XWS_UNDO_HAS_NO_COMMITTED_ORIGIN_RECEIPT":
      return "com.myoxus.workspace-content-operation.error.undo-has-no-committed-origin-receipt";
    case "XWS_UNDO_ORIGIN_LINEAGE_HASH_CHANGED":
      return "com.myoxus.workspace-content-operation.error.undo-origin-lineage-hash-changed";
    case "XWS_UNDO_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW":
      return "com.myoxus.workspace-content-operation.error.undo-tag-lineage-requires-a-fresh-preview";
    case "XWS_UNDO_EXTRACT_HAS_NO_MATCHING_PUBLISHED_FOLDER_RECEIPT":
      return "com.myoxus.workspace-content-operation.error.undo-extract-has-no-matching-published-folder-receipt";
    case "XWS_MOVE_REVISION_CHANGED_DURING_PUBLICATION":
      return "com.myoxus.workspace-content-operation.error.move-revision-changed-during-publication";
    case "XWS_EXTRACT_TARGET_WORKSPACE_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.extract-target-workspace-is-missing";
    case "XWS_EXTRACT_TARGET_RECEIPT_IS_MISSING":
      return "com.myoxus.workspace-content-operation.error.extract-target-receipt-is-missing";
    case "XWS_EXTRACT_TARGET_LIFECYCLE_OWNERSHIP_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-target-lifecycle-ownership-changed";
    case "XWS_EXTRACT_TARGET_OWNERSHIP_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-target-ownership-changed";
    case "XWS_EXTRACT_TARGET_ROOT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.extract-target-root-changed";
    case "XWS_MOVE_TARGET_MISSING":
      return "com.myoxus.workspace-content-operation.error.move-target-missing";
    case "XWS_WORKSPACE_CONTENT_TARGET_MEMBERSHIP_CHANGED":
      return "com.myoxus.workspace-content-operation.error.workspace-content-target-membership-changed";
    case "XWS_PUBLICATION_SERIALIZATION_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.publication-serialization-conflict";
    case "XWS_PUBLICATION_DEADLOCK":
      return "com.myoxus.workspace-content-operation.error.publication-deadlock";
    case "XWS_DATABASE_EDIT_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.database-edit-conflict";
    case "XWS_DATABASE_IMPORT_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.database-import-conflict";
    case "XWS_MOVE_CONTENT_REVISION_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-content-revision-changed";
    case "XWS_MOVE_RELATED_ROWS_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-related-rows-changed";
    case "XWS_MOVE_WORKSPACE_ROOT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-workspace-root-changed";
    case "XWS_MOVE_HISTORY_REFERENCES_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-history-references-changed";
    case "XWS_MOVE_TAG_PLAN_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-tag-plan-changed";
    case "XWS_MOVE_DATABASE_CONTENT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-database-content-changed";
    case "XWS_MOVE_ORGANIZER_REFERENCES_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-organizer-references-changed";
    case "XWS_MOVE_BLOB_METADATA_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-blob-metadata-changed";
    case "XWS_MOVE_NATIVE_REFERENCE_PLAN_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-native-reference-plan-changed";
    case "XWS_MOVE_DOCUMENT_IDENTITY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-document-identity-changed";
    case "XWS_MOVE_WORKSPACE_POLICY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-workspace-policy-changed";
    case "XWS_MOVE_UNDO_FOLDER_CHANGED":
      return "com.myoxus.workspace-content-operation.error.move-undo-folder-changed";
    case "XWS_PREVIEW_CONFIRMATION_MISMATCH":
      return "com.myoxus.workspace-content-operation.error.preview-confirmation-mismatch";
    case "XWS_LINK_INTENT_WORKSPACE_CHANGED":
      return "com.myoxus.workspace-content-operation.error.link-intent-workspace-changed";
    case "XWS_LINK_ORGANIZER_CHANGED":
      return "com.myoxus.workspace-content-operation.error.link-organizer-changed";
    case "XWS_LINK_TARGET_UNAVAILABLE":
      return "com.myoxus.workspace-content-operation.error.link-target-unavailable";
    case "XWS_NATIVE_REFERENCE_SNAPSHOT_CHANGED":
      return "com.myoxus.workspace-content-operation.error.native-reference-snapshot-changed";
    case "XWS_NATIVE_REFERENCE_PLAN_MISSING":
      return "com.myoxus.workspace-content-operation.error.native-reference-plan-missing";
    case "XWS_NATIVE_REFERENCE_VERSION_UNSUPPORTED":
      return "com.myoxus.workspace-content-operation.error.native-reference-version-unsupported";
    case "XWS_TARGET_STORAGE_LIMIT":
      return "com.myoxus.workspace-content-operation.error.target-storage-limit";
    case "XWS_CANCELLATION_CLEANUP_REQUIRED":
      return "com.myoxus.workspace-content-operation.error.cancellation-cleanup";
    case "XWS_OPERATION_MISSING":
      return "com.myoxus.workspace-content-operation.error.operation-missing";
    case "XWS_STORAGE_UNAVAILABLE":
      return "com.myoxus.workspace-content-operation.error.storage-unavailable";
    case "XWS_DATABASE_UNAVAILABLE":
      return "com.myoxus.workspace-content-operation.error.database-unavailable";
    case "XWS_LINK_INTENT_MISSING":
      return "com.myoxus.workspace-content-operation.error.link-intent-missing";
    case "XWS_SELECTED_RESOURCE_UNSUPPORTED":
      return "com.myoxus.workspace-content-operation.error.selection-unsupported";
    case "XWS_BLOB_INTEGRITY_MISMATCH":
      return "com.myoxus.workspace-content-operation.error.blob-integrity";
    case "XWS_BLOB_SIZE_LIMIT":
      return "com.myoxus.workspace-content-operation.error.blob-size-limit";
    case "XWS_STAGING_MANIFEST_INVALID":
      return "com.myoxus.workspace-content-operation.error.staging-manifest";
    case "XWS_STAGING_REPLAY_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.staging-replay";
    case "XWS_DOCUMENT_SNAPSHOT_INVALID":
      return "com.myoxus.workspace-content-operation.error.document-snapshot";
    case "XWS_DOCUMENT_METADATA_INVALID":
      return "com.myoxus.workspace-content-operation.error.document-metadata";
    case "XWS_DATABASE_SNAPSHOT_INVALID":
      return "com.myoxus.workspace-content-operation.error.database-snapshot";
    case "XWS_DATABASE_IDENTITY_INVALID":
      return "com.myoxus.workspace-content-operation.error.database-identity-invalid";
    case "XWS_MAPPING_PLAN_INVALID":
      return "com.myoxus.workspace-content-operation.error.mapping-plan";
    case "XWS_SOURCE_TAG_INVALID":
      return "com.myoxus.workspace-content-operation.error.source-tag-invalid";
    case "XWS_TARGET_DEFINITION_CHANGED":
      return "com.myoxus.workspace-content-operation.error.target-definition-changed";
    case "XWS_TARGET_DEFINITION_MISSING":
      return "com.myoxus.workspace-content-operation.error.target-definition-missing";
    case "XWS_RELATION_TARGET_OUTSIDE_SELECTION":
      return "com.myoxus.workspace-content-operation.error.relation-outside-selection";
    case "XWS_RELATION_ROW_MISSING":
      return "com.myoxus.workspace-content-operation.error.relation-row-missing";
    case "XWS_RESOURCE_IDENTITY_AMBIGUOUS":
      return "com.myoxus.workspace-content-operation.error.resource-identity-ambiguous";
    case "XWS_OWNED_BLOB_MAPPING_MISSING":
      return "com.myoxus.workspace-content-operation.error.owned-blob-mapping";
    case "XWS_OWNED_DOCUMENT_MISSING":
      return "com.myoxus.workspace-content-operation.error.owned-document-missing";
    case "XWS_ENCODING_FAILED":
      return "com.myoxus.workspace-content-operation.error.encoding-failed";
    case "XWS_INVENTORY_INVALID":
      return "com.myoxus.workspace-content-operation.error.inventory-invalid";
    case "XWS_INVENTORY_LIMIT":
      return "com.myoxus.workspace-content-operation.error.inventory-limit";
    case "XWS_BLOB_MATERIALIZATION_FAILED":
      return "com.myoxus.workspace-content-operation.error.blob-materialization";
    case "XWS_BLOB_COMPENSATION_FAILED":
      return "com.myoxus.workspace-content-operation.error.blob-compensation";
    case "XWS_SOURCE_WORKSPACE_MISSING":
      return "com.myoxus.workspace-content-operation.error.source-workspace-missing";
    case "XWS_REQUEST_INVALID":
      return "com.myoxus.workspace-content-operation.error.request-invalid";

    case "XWS_PUBLICATION_KIND_INVALID":
      return "com.myoxus.workspace-content-operation.error.operation-kind";
    case "XWS_PUBLICATION_STATE_INVALID":
      return "com.myoxus.workspace-content-operation.error.operation-state";
    case "XWS_PUBLICATION_MAPPINGS_EMPTY":
      return "com.myoxus.workspace-content-operation.error.mapping-empty";
    case "XWS_EXTRACT_FOLDER_BINDING_INVALID":
      return "com.myoxus.workspace-content-operation.error.folder-binding";
    case "XWS_PUBLICATION_STAGING_UNEXPECTED":
      return "com.myoxus.workspace-content-operation.error.staging-unexpected";
    case "XWS_DIAGNOSTIC_INSTANCE_INVALID":
      return "com.myoxus.workspace-content-operation.error.diagnostic-identity";
    case "XWS_TARGET_WORKSPACE_MISSING":
      return "com.myoxus.workspace-content-operation.error.target-missing";
    case "XWS_DISTINCT_WORKSPACES_REQUIRED":
      return "com.myoxus.workspace-content-operation.error.distinct-workspaces";
    case "XWS_RECIPIENTS_EMPTY":
      return "com.myoxus.workspace-content-operation.error.recipients-empty";
    case "XWS_RECIPIENT_BINDING_INVALID":
      return "com.myoxus.workspace-content-operation.error.recipient-binding";
    case "XWS_RECIPIENT_COUNT_INVALID":
      return "com.myoxus.workspace-content-operation.error.recipient-count";
    case "XWS_RECIPIENT_KINDS_INVALID":
      return "com.myoxus.workspace-content-operation.error.recipient-kinds";
    case "XWS_RECIPIENT_REVISION_INVALID":
      return "com.myoxus.workspace-content-operation.error.recipient-revision";
    case "XWS_RECIPIENT_DUPLICATE":
      return "com.myoxus.workspace-content-operation.error.recipient-duplicate";
    case "XWS_RECIPIENT_ACTOR_MISSING":
      return "com.myoxus.workspace-content-operation.error.recipient-actor";
    case "XWS_RECIPIENT_REPLAY_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.recipient-replay";
    case "XWS_BLOB_STAGING_ENTRY_MISSING":
      return "com.myoxus.workspace-content-operation.error.blob-stage-missing";
    case "XWS_TARGET_BLOB_BYTES_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.blob-bytes-conflict";
    case "XWS_TARGET_BLOB_METADATA_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.blob-metadata-conflict";
    case "XWS_TARGET_DOCUMENT_KEY_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.document-identity-conflict";
    case "XWS_TAG_IDENTITY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.tag-identity";
    case "XWS_DATABASE_IDENTITY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.database-identity";
    case "XWS_COLLECTION_IDENTITY_CHANGED":
      return "com.myoxus.workspace-content-operation.error.collection-identity";
    case "XWS_RESOURCE_COUNT_INVALID":
      return "com.myoxus.workspace-content-operation.error.resource-count";
    case "XWS_PUBLICATION_TERMINAL_CONFLICT":
      return "com.myoxus.workspace-content-operation.error.terminal-conflict";
    case "XWS_SOURCE_DOCUMENT_MISSING":
      return "com.myoxus.workspace-content-operation.error.source-document";
    case "XWS_SOURCE_BLOB_MISSING":
      return "com.myoxus.workspace-content-operation.error.source-blob";
    case "XWS_SOURCE_TAG_MISSING":
      return "com.myoxus.workspace-content-operation.error.source-tag";
    case "XWS_SOURCE_DATABASE_MISSING":
      return "com.myoxus.workspace-content-operation.error.source-database";
    case "XWS_SOURCE_ROOT_MISSING":
      return "com.myoxus.workspace-content-operation.error.source-root";
    case "XWS_PUBLICATION_WORKSPACE_MISSING":
      return "com.myoxus.workspace-content-operation.error.publication-workspace";
    case "XWS_TAG_ASSIGNMENT_CONSTRAINT":
      return "com.myoxus.workspace-content-operation.error.tag-assignment";
    case "XWS_DATABASE_UNIQUE_CONSTRAINT":
      return "com.myoxus.workspace-content-operation.error.sql-unique";
    case "XWS_DATABASE_FOREIGN_KEY_CONSTRAINT":
      return "com.myoxus.workspace-content-operation.error.sql-reference";
    case "XWS_DATABASE_CHECK_CONSTRAINT":
      return "com.myoxus.workspace-content-operation.error.sql-consistency";
    case "XWS_DATABASE_NOT_NULL_CONSTRAINT":
      return "com.myoxus.workspace-content-operation.error.sql-required";
    case "XWS_ORGANIZER_DECODE":
      return "com.myoxus.workspace-content-operation.error.organizer-decode";
    case "XWS_ORGANIZER_MALFORMED_ROW":
      return "com.myoxus.workspace-content-operation.error.organizer-row";
    case "XWS_ORGANIZER_FOLDER_MISSING":
      return "com.myoxus.workspace-content-operation.error.organizer-folder";
    case "XWS_ORGANIZER_ENTRY_MISSING":
      return "com.myoxus.workspace-content-operation.error.organizer-entry";
    case "XWS_ORGANIZER_PARENT_MISSING":
      return "com.myoxus.workspace-content-operation.error.organizer-parent";
    case "XWS_ORGANIZER_CYCLE":
      return "com.myoxus.workspace-content-operation.error.organizer-cycle";
    case "XWS_ORGANIZER_DUPLICATE":
      return "com.myoxus.workspace-content-operation.error.organizer-duplicate";
    case "XWS_ORGANIZER_NAME_INVALID":
      return "com.myoxus.workspace-content-operation.error.organizer-name";
    case "XWS_ORGANIZER_LINK_TYPE_INVALID":
      return "com.myoxus.workspace-content-operation.error.organizer-link-type";
    case "XWS_ORGANIZER_TARGET_INVALID":
      return "com.myoxus.workspace-content-operation.error.organizer-target-id";
    case "XWS_ORGANIZER_WORKSPACE_TARGET_INVALID":
      return "com.myoxus.workspace-content-operation.error.organizer-workspace-target";
    case "XWS_ORGANIZER_ENTRY_AT_ROOT":
      return "com.myoxus.workspace-content-operation.error.organizer-root-entry";
    case "XWS_ORGANIZER_MUTATION_EMPTY":
      return "com.myoxus.workspace-content-operation.error.organizer-empty";
    case "XWS_ORGANIZER_ORDER_INVALID":
      return "com.myoxus.workspace-content-operation.error.organizer-order-key";
    case "XWS_ORGANIZER_REINDEX_REQUIRED":
      return "com.myoxus.workspace-content-operation.error.organizer-order";
    case "XWS_ORGANIZER_REVISION_STALE":
      return "com.myoxus.workspace-content-operation.error.organizer-stale";
    case "XWS_ORGANIZER_KEY_INVALID":
      return "com.myoxus.workspace-content-operation.error.organizer-key";
    case "XWS_COLLECTION_DECODE":
      return "com.myoxus.workspace-content-operation.error.collection-decode";
    case "XWS_WORKER_RETRY_EXHAUSTED":
      return "com.myoxus.workspace-content-operation.error.retry-exhausted";
    case "XWS_UNEXPECTED_VALIDATION":
      return "com.myoxus.workspace-content-operation.error.unexpected-validation";
    case "XWS_TRANSFER_FORBIDDEN":
      return "com.myoxus.workspace-content-operation.error.transfer-forbidden";
  }
  switch (message) {
    case "workspace content organizer order needs repair":
      return "com.myoxus.workspace-content-operation.error.organizer-order";
    case "workspace content organizer target is missing":
      return "com.myoxus.workspace-content-operation.error.organizer-target";
    case "workspace content organizer duplicate target":
      return "com.myoxus.workspace-content-operation.error.organizer-duplicate";
    case "workspace content organizer projection failed":
      return "com.myoxus.workspace-content-operation.error.organizer";
    case "workspace content collection projection failed":
      return "com.myoxus.workspace-content-operation.error.collections";
    case "workspace content recipient snapshot failed":
      return "com.myoxus.workspace-content-operation.error.recipients";
    case "workspace content blob staging failed":
      return "com.myoxus.workspace-content-operation.error.attachments";
    case "workspace content revision manifest failed":
      return "com.myoxus.workspace-content-operation.error.snapshot";
    case "workspace content publication failed":
      return "com.myoxus.workspace-content-operation.error.publication";
    case "workspace content Move target Document key conflicts":
      return "com.myoxus.workspace-content-operation.error.document-identity-conflict";
  }
  switch (code) {
    case "XWS_PREFLIGHT_STALE":
      return "com.myoxus.workspace-content-operation.error.preview-stale";
    case "XWS_WORKSPACE_NAME_CONFLICT":
      return "com.myoxus.workspace-content-operation.blocker.workspace-name";
    case "XWS_OWNERSHIP_UNSUPPORTED":
      return "com.myoxus.workspace-content-operation.blocker.ownership-unsupported";
    default:
      return undefined;
  }
}

export function workspaceContentStatusKey(status: string) {
  switch (status) {
    case "Draft":
      return "com.myoxus.workspace-content-operation.status.draft";
    case "Previewed":
      return "com.myoxus.workspace-content-operation.status.previewed";
    case "Queued":
      return "com.myoxus.workspace-content-operation.status.queued";
    case "Running":
      return "com.myoxus.common.status.in-progress";
    case "Succeeded":
      return "com.myoxus.common.status.completed";
    case "Failed":
      return "com.myoxus.workspace-content-operation.status.failed";
    case "Cancelled":
      return "com.myoxus.workspace-content-operation.status.cancelled";
    case "CleanupRequired":
      return "com.myoxus.workspace-content-operation.status.cleanup-required";
    default:
      return "com.myoxus.workspace-content-operation.status.unknown";
  }
}
