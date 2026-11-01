// SPDX-License-Identifier: AGPL-3.0-or-later

import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
import { Trans, useI18n } from "@myoxus/i18n";
import { useLiveData } from "@myoxus/infra";
import { PlaceholderText, useConfirmModal } from "@myoxus/ui-facade";
import { useCallback, useContext, useEffect } from "react";

import { ListFloatingToolbar } from "../page-list/components/list-floating-toolbar";
import { DocExplorerContext } from "./context";

type DeleteCallbacks = {
  onFinished?: () => void;
  onAbort?: () => void;
  onError?: (error: Error) => void;
};

export function ExplorerSelectionToolbar({
  disableDelete = false,
  disableToolbar = false,
  onDelete,
  onRestore,
}: {
  disableDelete?: boolean;
  disableToolbar?: boolean;
  onDelete?: (
    ids: string[],
    callbacks?: DeleteCallbacks,
  ) => void | Promise<void>;
  onRestore?: (ids: string[]) => void;
}) {
  const t = useI18n();
  const contextValue = useContext(DocExplorerContext);
  const { moveManyToTrash } = useDocumentOperations();
  const { openConfirmModal } = useConfirmModal();
  const selectMode = useLiveData(contextValue.selectMode$);
  const selectedDocIds = useLiveData(contextValue.selectedDocIds$);

  const close = useCallback(() => {
    contextValue.selectMode$?.next(false);
    contextValue.selectedDocIds$.next([]);
    contextValue.prevCheckAnchorId$?.next(null);
  }, [contextValue]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const deleteSelected = useCallback(() => {
    if (disableDelete) {
      close();
      return;
    }
    if (selectedDocIds.length === 0) {
      return;
    }
    if (onDelete) {
      onDelete(contextValue.selectedDocIds$.value, { onFinished: close });
      return;
    }

    openConfirmModal({
      title: t["com.myoxus.moveToTrash.confirmModal.title.multiple"]({
        number: selectedDocIds.length.toString(),
      }),
      description: t[
        "com.myoxus.moveToTrash.confirmModal.description.multiple"
      ]({ number: selectedDocIds.length.toString() }),
      cancelText: t["com.myoxus.confirmModal.button.cancel"](),
      confirmText: t.Delete(),
      confirmButtonOptions: { variant: "error" },
      onConfirm: async () => {
        await moveManyToTrash(contextValue.selectedDocIds$.value);
        close();
      },
    });
  }, [
    close,
    contextValue.selectedDocIds$,
    disableDelete,
    moveManyToTrash,
    onDelete,
    openConfirmModal,
    selectedDocIds.length,
    t,
  ]);

  const restoreSelected = useCallback(() => {
    onRestore?.(contextValue.selectedDocIds$.value);
    close();
  }, [close, contextValue.selectedDocIds$, onRestore]);

  if (disableToolbar) {
    return null;
  }

  return (
    <ListFloatingToolbar
      open={!!selectMode}
      onDelete={disableDelete ? undefined : deleteSelected}
      onRestore={onRestore ? restoreSelected : undefined}
      onClose={close}
      content={
        <Trans
          i18nKey="com.myoxus.page.toolbar.selected"
          count={selectedDocIds.length}
        >
          <PlaceholderText>
            {{ count: selectedDocIds.length } as any}
          </PlaceholderText>
          selected
        </Trans>
      }
    />
  );
}
