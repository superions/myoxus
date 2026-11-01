// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GraphQLService } from "@myoxus/core/modules/server";
import {
  documentHistoryRevisionQuery,
  recoverDocMutation,
  restoreDocumentVersionMutation,
} from "@myoxus/graphql";

export type HistoryRestoreTarget =
  { snapshotId: string } | { versionId: string };

export interface PreparedHistoryRestore {
  target: HistoryRestoreTarget;
  expectedRevision: string;
}

/** Prepare before confirmation; never silently replace this revision on retry. */
export async function prepareHistoryRestore(
  graphql: GraphQLService,
  workspaceId: string,
  docId: string,
  synchronize: () => Promise<void>,
  target: HistoryRestoreTarget,
): Promise<PreparedHistoryRestore> {
  await synchronize();
  const data = await graphql.gql({
    query: documentHistoryRevisionQuery,
    variables: { workspaceId, docId },
  });
  return { target, expectedRevision: data.documentHistoryRevision };
}

/** Both history entry points use only server restore; no local Yjs undo/title
 * write can mask a failed transaction. A lost response refreshes reads without
 * automatically repeating the mutation against a newer revision. */
export async function restoreHistory(
  graphql: GraphQLService,
  workspaceId: string,
  docId: string,
  synchronize: () => Promise<void>,
  prepared: PreparedHistoryRestore,
  refresh: () => Promise<unknown>,
) {
  await synchronize();
  const refreshReads = () =>
    Promise.all([
      graphql.gql({
        query: documentHistoryRevisionQuery,
        variables: { workspaceId, docId },
      }),
      refresh(),
    ]);
  let version = null;
  try {
    if ("versionId" in prepared.target) {
      const data = await graphql.gql({
        query: restoreDocumentVersionMutation,
        variables: {
          id: prepared.target.versionId,
          expectedRevision: prepared.expectedRevision,
        },
      });
      version = data.restoreDocumentVersion;
    } else {
      await graphql.gql({
        query: recoverDocMutation,
        variables: {
          workspaceId,
          docId,
          snapshotId: prepared.target.snapshotId,
          expectedRevision: prepared.expectedRevision,
        },
      });
    }
  } catch (error) {
    try {
      await refreshReads();
    } catch (refreshError) {
      console.warn("History reads failed after an uncertain restore outcome", {
        docId,
        refreshError,
      });
    }
    throw error;
  }
  try {
    await refreshReads();
    return { version, refreshError: null };
  } catch (refreshError) {
    // Success is known. Expose stale reads separately; never repeat the restore.
    return { version, refreshError };
  }
}
