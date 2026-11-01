import type {
  DocumentVersionFieldsFragment,
  DocumentVersioningOverviewQuery,
  DocumentVersionDiffQuery,
  DocumentMetadataValidationFieldsFragment,
} from "@myoxus/graphql";

export {
  documentVersioningOverviewQuery,
  createDocumentVersionMutation,
  captureDocumentHistoryMutation,
  nameDocumentHistoryStateMutation,
  updateDocumentVersionMutation,
  pinDocumentVersionMutation,
  unpinDocumentVersionMutation,
  restoreDocumentVersionMutation,
  documentVersionDiffQuery,
} from "@myoxus/graphql";

export type DocumentVersion = DocumentVersionFieldsFragment;
export type DocumentVersioningOverviewResponse =
  DocumentVersioningOverviewQuery;
export type DocumentVersionDiff =
  DocumentVersionDiffQuery["documentVersionDiff"];
export type DocumentVersionBlockDiff =
  DocumentVersionDiff["blockDiffs"][number];
export type DocumentVersionTextDiff = DocumentVersionDiff["textDiffs"][number];
export type DocumentVersionBlockDiffKind = DocumentVersionBlockDiff["kind"];

// View state composes generated contracts rather than maintaining a second wire
// schema. Snapshot IDs remain strings throughout this projection.
export interface DocumentVersionMetadataSnapshot {
  state: {
    currentVersionId: string | null;
    dirtySinceCurrentVersion: boolean;
    versionDisplayMode: string;
    lastVersionedAt: string | null;
  } | null;
  version: DocumentVersion | null;
  validation: DocumentMetadataValidationFieldsFragment;
}
