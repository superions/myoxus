// SPDX-License-Identifier: AGPL-3.0-or-later

import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
import {
  databasesQuery,
  trashDatabaseMutation,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { notify, useConfirmModal } from "@myoxus/ui-facade";
import { useCallback, useContext, useEffect, useMemo } from "react";

import { parseWorkspacePageKey } from "../../../modules/workspace-pages/identity";
import { DatabasePagesService } from "../../../modules/workspace-pages/database-pages-service";
import { useMutateQueryResource, useMutation } from "../../hooks/use-mutation";
import { ListFloatingToolbar } from "../../page-list/components/list-floating-toolbar";
import { WorkspaceContentOperationSelectionMenu } from "../../workspace-content-operation/menu-items";
import { DocExplorerContext } from "../context";
import { WorkspacePagesExplorerContext } from "./context";

export function WorkspacePagesSelectionToolbar() {
  const t = useI18n();
  const explorer = useContext(DocExplorerContext);
  const pages = useContext(WorkspacePagesExplorerContext);
  const selectedKeys = useLiveData(explorer.selectedItemKeys$);
  const selectMode = useLiveData(explorer.selectMode$);
  const { moveManyToTrash } = useDocumentOperations();
  const trashDatabase = useMutation({ mutation: trashDatabaseMutation });
  const databasePagesService = useService(DatabasePagesService);
  const revalidate = useMutateQueryResource();
  const { openConfirmModal } = useConfirmModal();
  const selectedResources = useMemo(
    () =>
      selectedKeys
        .map(parseWorkspacePageKey)
        .filter((identity): identity is NonNullable<typeof identity> =>
          Boolean(identity),
        )
        .map((identity) => ({
          id: identity.id,
          kind:
            identity.kind === "database"
              ? WorkspaceContentResourceKindType.Database
              : WorkspaceContentResourceKindType.Document,
        })),
    [selectedKeys],
  );
  const selectedSummary = useMemo(() => {
    const documents = selectedResources.filter(
      (resource) => resource.kind === WorkspaceContentResourceKindType.Document,
    ).length;
    const databases = selectedResources.length - documents;
    return [
      databases
        ? t["com.myoxus.workspace-content-operation.review.resource-count"]({
            count: databases.toString(),
            kind: t["com.myoxus.workspace-content-operation.kind.database"](),
          })
        : null,
      documents
        ? t["com.myoxus.workspace-content-operation.review.resource-count"]({
            count: documents.toString(),
            kind: t["com.myoxus.workspace-content-operation.kind.document"](),
          })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }, [selectedResources, t]);

  const close = useCallback(() => {
    explorer.selectedItemKeys$.next([]);
    explorer.selectMode$?.next(false);
    explorer.prevCheckAnchorId$?.next(null);
  }, [explorer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const moveSelectedToTrash = useCallback(() => {
    if (!pages || selectedKeys.length === 0) return;
    const itemCount = t["com.myoxus.trashOperation.itemCount"]({
      count: selectedKeys.length.toString(),
    });
    openConfirmModal({
      title: t["com.myoxus.moveToTrash.title"](),
      description: t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: itemCount,
      }),
      cancelText: t["Cancel"](),
      confirmText: t["com.myoxus.moveToTrash.title"](),
      confirmButtonOptions: { variant: "error" },
      onConfirm: async () => {
        const identities = selectedKeys
          .map(parseWorkspacePageKey)
          .filter((identity): identity is NonNullable<typeof identity> =>
            Boolean(identity),
          );
        const documentIds = identities
          .filter((identity) => identity.kind === "document")
          .map((identity) => identity.id);
        const databaseRecords = identities
          .filter((identity) => identity.kind === "database")
          .map((identity) => pages.databasePages.get(`database:${identity.id}`))
          .filter((record): record is NonNullable<typeof record> =>
            Boolean(record),
          );
        const operations = [
          ...(documentIds.length > 0
            ? [
                {
                  keys: documentIds.map((id) => `document:${id}`),
                  run: () => moveManyToTrash(documentIds),
                },
              ]
            : []),
          ...databaseRecords.map((database) => ({
            keys: [database.key],
            run: () =>
              trashDatabase.trigger({
                input: {
                  databaseId: database.id,
                  expectedEditRevision: database.editRevision,
                  force: false,
                },
              }),
          })),
        ];
        const results = await Promise.allSettled(
          operations.map((operation) => operation.run()),
        );
        const failedKeys = results.flatMap((result, index) =>
          result.status === "rejected" ? (operations[index]?.keys ?? []) : [],
        );
        await revalidate(
          databasesQuery,
          (variables) => variables.workspaceId === pages.workspaceId,
        );
        databasePagesService.invalidate();
        if (failedKeys.length === 0) {
          close();
          return;
        }
        explorer.selectedItemKeys$.next(failedKeys);
        explorer.selectMode$?.next(true);
        notify.error({
          title: t["com.myoxus.database.selector.error-title"](),
        });
      },
    });
  }, [
    close,
    databasePagesService,
    explorer,
    moveManyToTrash,
    openConfirmModal,
    pages,
    revalidate,
    selectedKeys,
    t,
    trashDatabase,
  ]);

  return (
    <ListFloatingToolbar
      open={Boolean(selectMode && selectedKeys.length > 0)}
      actions={
        selectedResources.length > 0 ? (
          <WorkspaceContentOperationSelectionMenu
            selection={{
              type: "resources",
              resources: selectedResources,
            }}
          />
        ) : null
      }
      onDelete={moveSelectedToTrash}
      onClose={close}
      content={selectedSummary}
    />
  );
}
