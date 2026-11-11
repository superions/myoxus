import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { type DocRecord, DocsService } from "@myoxus/core/modules/doc";
import { GraphQLService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  DeleteDocumentPermanentlyStatus,
  type DeleteDocumentsPermanentlyMutation,
  deleteDocumentsPermanentlyMutation,
  type EmptyWorkspaceTrashMutation,
  emptyWorkspaceTrashMutation,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { I18n } from "@myoxus/i18n";
import { notify } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { useNavigateHelper } from "../use-navigate-helper";

type PermanentDeletePayload =
  | DeleteDocumentsPermanentlyMutation["deleteDocumentsPermanently"]
  | EmptyWorkspaceTrashMutation["emptyWorkspaceTrash"];

const permanentDeleteSuccessStatuses = new Set([
  DeleteDocumentPermanentlyStatus.Deleted,
  DeleteDocumentPermanentlyStatus.AlreadyDeleted,
  DeleteDocumentPermanentlyStatus.NotFound,
  DeleteDocumentPermanentlyStatus.NotTrashed,
]);

export function isServerBackedWorkspace(workspace: { flavour: string }) {
  return workspace.flavour !== "local";
}

function permanentDeleteDocIdsByStatus(
  payload: PermanentDeletePayload,
  statuses: readonly DeleteDocumentPermanentlyStatus[],
) {
  const wanted = new Set(statuses);
  return payload.documents
    .filter((doc) => wanted.has(doc.status))
    .map((doc) => doc.clientDocId);
}

function assertPermanentDeleteSucceeded(payload: PermanentDeletePayload) {
  const failures = payload.documents.filter(
    (doc) => !permanentDeleteSuccessStatuses.has(doc.status),
  );
  if (failures.length === 0) {
    return;
  }
  throw new AggregateError(
    failures.map(
      (doc) =>
        new Error(
          `${doc.clientDocId}: ${doc.status}${doc.reason ? ` (${doc.reason})` : ""}`,
        ),
    ),
    `Failed to permanently delete ${failures.length} doc(s)`,
  );
}

function classifyPermanentDelete(payload: PermanentDeletePayload) {
  assertPermanentDeleteSucceeded(payload);
  return {
    deletedContentPageIds: permanentDeleteDocIdsByStatus(payload, [
      DeleteDocumentPermanentlyStatus.Deleted,
    ]),
    staleProjectionPageIds: permanentDeleteDocIdsByStatus(payload, [
      DeleteDocumentPermanentlyStatus.AlreadyDeleted,
      DeleteDocumentPermanentlyStatus.NotFound,
    ]),
    restoredPageIds: permanentDeleteDocIdsByStatus(payload, [
      DeleteDocumentPermanentlyStatus.NotTrashed,
    ]),
  };
}

type MoveToTrashTarget = string | DocRecord;

function isDocRecord(target: MoveToTrashTarget): target is DocRecord {
  return typeof target !== "string";
}

export function useDocumentOperations() {
  const workspace = useService(WorkspaceService).workspace;
  const { openPage } = useNavigateHelper();
  const docsService = useService(DocsService);
  const docRecordList = useService(DocsService).list;
  const graphqlService = useService(GraphQLService);

  const reconcileServerDelete = useCallback(
    async (classification: ReturnType<typeof classifyPermanentDelete>) => {
      const { deletedContentPageIds, staleProjectionPageIds, restoredPageIds } =
        classification;
      const removedPageIds = [
        ...deletedContentPageIds,
        ...staleProjectionPageIds,
      ];

      if (removedPageIds.length > 0 || restoredPageIds.length > 0) {
        await workspace.engine.doc.updateAndWaitForSaved(workspace.id, () => {
          if (removedPageIds.length > 0) {
            docsService.removeManyFromRootMeta(removedPageIds);
          }
          for (const pageId of restoredPageIds) {
            docRecordList.doc$(pageId).value?.restoreFromTrash();
          }
        });
      }
      // Server deletion is committed; await the local purge so failures remain
      // observable and cannot be mistaken for a completed client cleanup.
      await Promise.all(
        deletedContentPageIds.map((pageId) =>
          workspace.engine.doc.deleteDoc(pageId),
        ),
      );

      return { removedPageIds, restoredPageIds };
    },
    [docRecordList, docsService, workspace],
  );

  const moveToTrash = useCallback(
    async (target: MoveToTrashTarget) => {
      const docRecord = isDocRecord(target)
        ? target
        : docRecordList.docsMap$.value.get(target);
      const docId = isDocRecord(target) ? target.id : target;
      if (!docRecord) {
        throw new Error(`Cannot move missing document to trash: ${docId}`);
      }
      // Use the same root-meta transaction path as bulk list operations. The
      // All Docs and Trash projections subscribe to the DocsService store; using
      // the list-level writer for single-item deletes avoids a second mutation
      // path that can leave confirmation flows waiting on stale projections.
      await workspace.engine.doc.updateAndWaitForSaved(workspace.id, () => {
        docsService.moveManyToTrash([docId]);
      });
    },
    [docRecordList, docsService, workspace],
  );

  const moveManyToTrash = useCallback(
    async (targets: MoveToTrashTarget[]) => {
      const uniqueTargets = Array.from(
        new Map(
          targets.map((target) => {
            const docId = isDocRecord(target) ? target.id : target;
            return [docId, target] as const;
          }),
        ).values(),
      );
      const docRecords = uniqueTargets.map((target) => {
        const docRecord = isDocRecord(target)
          ? target
          : docRecordList.docsMap$.value.get(target);
        const docId = isDocRecord(target) ? target.id : target;
        if (!docRecord) {
          throw new Error(`Cannot move missing document to trash: ${docId}`);
        }
        return docRecord;
      });
      if (docRecords.length === 0) {
        return;
      }

      // One root-meta transaction keeps the bulk operation atomic for every
      // local subscriber and persists its exact Yjs update before returning.
      await workspace.engine.doc.updateAndWaitForSaved(workspace.id, () => {
        docsService.moveManyToTrash(
          docRecords.map((docRecord) => docRecord.id),
        );
      });
    },
    [docRecordList, docsService, workspace],
  );

  const restoreFromTrash = useCallback(
    (docId: string) => docsService.restoreFromTrash(docId),
    [docsService],
  );

  const permanentlyDeletePages = useCallback(
    async (pageIds: string[]) => {
      const uniquePageIds = Array.from(new Set(pageIds));
      if (uniquePageIds.length === 0) {
        return 0;
      }
      if (isServerBackedWorkspace(workspace)) {
        const response = await graphqlService.gql({
          query: deleteDocumentsPermanentlyMutation,
          variables: {
            input: {
              workspaceId: workspace.id,
              docIds: uniquePageIds,
            },
          },
        });
        const classification = classifyPermanentDelete(
          response.deleteDocumentsPermanently,
        );
        const reconciliation = await reconcileServerDelete(classification);
        return reconciliation.removedPageIds.length;
      }

      const deleteResults = await Promise.allSettled(
        uniquePageIds.map((pageId) => workspace.engine.doc.deleteDoc(pageId)),
      );

      const successfulPageIds: string[] = [];
      const deleteFailures: unknown[] = [];
      deleteResults.forEach((result, index) => {
        const pageId = uniquePageIds[index];
        if (!pageId) {
          return;
        }
        if (result.status === "fulfilled") {
          successfulPageIds.push(pageId);
        } else {
          deleteFailures.push(result.reason);
        }
      });

      if (successfulPageIds.length > 0) {
        await workspace.engine.doc.updateAndWaitForSaved(workspace.id, () => {
          for (const pageId of successfulPageIds) {
            workspace.docCollection.removeDoc(pageId);
          }
        });
      }

      if (deleteFailures.length > 0) {
        throw new AggregateError(
          deleteFailures,
          `Failed to permanently delete ${deleteFailures.length} doc(s)`,
        );
      }
      return successfulPageIds.length;
    },
    [graphqlService, reconcileServerDelete, workspace],
  );

  const emptyTrash = useCallback(
    async (clientVisiblePageIds: string[]) => {
      if (isServerBackedWorkspace(workspace)) {
        const uniqueClientVisiblePageIds = Array.from(
          new Set(clientVisiblePageIds),
        );
        const response = await graphqlService.gql({
          query: emptyWorkspaceTrashMutation,
          variables: {
            input: {
              workspaceId: workspace.id,
              clientVisibleDocIds: uniqueClientVisiblePageIds,
            },
          },
        });
        const classification = classifyPermanentDelete(
          response.emptyWorkspaceTrash,
        );
        const removedPageIds = [
          ...classification.deletedContentPageIds,
          ...classification.staleProjectionPageIds,
        ];
        const { restoredPageIds } = classification;
        const classifiedPageIds = new Set([
          ...removedPageIds,
          ...restoredPageIds,
        ]);
        const missingVisibleTrashIds = uniqueClientVisiblePageIds.filter(
          (pageId) => !classifiedPageIds.has(pageId),
        );
        if (missingVisibleTrashIds.length > 0) {
          throw new Error(
            `emptyWorkspaceTrash did not classify ${missingVisibleTrashIds.length} locally visible trash doc(s)`,
          );
        }
        const reconciliation = await reconcileServerDelete(classification);
        return (
          reconciliation.removedPageIds.length +
          reconciliation.restoredPageIds.length
        );
      }

      return permanentlyDeletePages(clientVisiblePageIds);
    },
    [graphqlService, permanentlyDeletePages, reconcileServerDelete, workspace],
  );

  const permanentlyDeletePage = useCallback(
    async (pageId: string) => {
      await permanentlyDeletePages([pageId]);
    },
    [permanentlyDeletePages],
  );

  const duplicate = useAsyncCallback(
    async (pageId: string, openPageAfterDuplication: boolean = true) => {
      try {
        const newPageId = await docsService.duplicate(pageId);
        openPageAfterDuplication &&
          openPage(workspace.docCollection.id, newPageId);
      } catch {
        // The service rejects and retains failed new copies in trash. Do not
        // navigate to a target ID whose content copy was never completed.
        notify.error(I18n.t("com.myoxus.common.operation-failed"), {
          position: "top-center",
        });
      }
    },
    [docsService, openPage, workspace.docCollection.id],
  );

  return {
    moveToTrash,
    moveManyToTrash,
    restoreFromTrash,
    permanentlyDeletePage,
    permanentlyDeletePages,
    emptyTrash,

    duplicate,
  };
}
