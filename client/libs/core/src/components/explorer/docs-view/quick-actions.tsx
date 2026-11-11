import type { DocRecord } from "@myoxus/core/modules/doc";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import {
  ArchiveRestoreIcon,
  DeleteIcon,
  OpenInNewIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Checkbox,
  IconButton,
  type IconButtonProps,
  notify,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { memo, useCallback, useContext } from "react";

import { useDocumentOperations } from "../../hooks/myoxus/use-document-operations";
import { IsFavoriteIcon } from "../../pure/icons";
import { DocExplorerContext } from "../context";

export interface QuickActionProps extends IconButtonProps {
  doc: DocRecord;
}

export const QuickFavorite = memo(function QuickFavorite({
  doc,
  onClick,
  ...iconButtonProps
}: QuickActionProps) {
  const contextValue = useContext(DocExplorerContext);
  const quickFavorite = useLiveData(contextValue.quickFavorite$);

  const favAdapter = useService(CompatibleFavoriteItemsAdapter);
  const favourite = useLiveData(favAdapter.isFavorite$(doc.id, "doc"));

  const toggleFavorite = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      e.stopPropagation();
      e.preventDefault();
      track.allDocs.list.docMenu.toggleFavorite();
      favAdapter.toggle(doc.id, "doc");
    },
    [doc.id, favAdapter, onClick],
  );

  if (!quickFavorite) {
    return null;
  }

  return (
    <IconButton
      icon={<IsFavoriteIcon favorite={favourite} />}
      onClick={toggleFavorite}
      data-testid="doc-list-operation-favorite"
      {...iconButtonProps}
    />
  );
});

export const QuickTab = memo(function QuickTab({
  doc,
  onClick,
  ...iconButtonProps
}: QuickActionProps) {
  const contextValue = useContext(DocExplorerContext);
  const quickTab = useLiveData(contextValue.quickTab$);
  const workbench = useService(WorkbenchService).workbench;
  const onOpenInNewTab = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      e.stopPropagation();
      e.preventDefault();
      track.allDocs.list.doc.openDoc();
      track.allDocs.list.docMenu.openInNewTab();
      workbench.openDoc(doc.id, { at: "new-tab" });
    },
    [doc.id, onClick, workbench],
  );

  if (!quickTab) {
    return null;
  }

  return (
    <IconButton
      onClick={onOpenInNewTab}
      icon={<OpenInNewIcon />}
      {...iconButtonProps}
    />
  );
});

export const QuickSplit = memo(function QuickSplit({
  doc,
  onClick,
  ...iconButtonProps
}: QuickActionProps) {
  const contextValue = useContext(DocExplorerContext);
  const quickSplit = useLiveData(contextValue.quickSplit$);
  const workbench = useService(WorkbenchService).workbench;

  const onOpenInSplitView = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      e.stopPropagation();
      e.preventDefault();
      track.allDocs.list.doc.openDoc();
      track.allDocs.list.docMenu.openInSplitView();
      workbench.openDoc(doc.id, { at: "tail" });
    },
    [doc.id, onClick, workbench],
  );

  if (!quickSplit) {
    return null;
  }

  return (
    <IconButton
      onClick={onOpenInSplitView}
      icon={<SplitViewIcon />}
      {...iconButtonProps}
    />
  );
});

export const QuickDelete = memo(function QuickDelete({
  doc,
  onClick,
  ...iconButtonProps
}: QuickActionProps) {
  const t = useI18n();
  const { openConfirmModal } = useConfirmModal();
  const contextValue = useContext(DocExplorerContext);
  const guardService = useService(GuardService);
  const quickTrash = useLiveData(contextValue.quickTrash$);
  const { moveToTrash } = useDocumentOperations();

  const onMoveToTrash = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      e.stopPropagation();
      e.preventDefault();
      if (!doc) {
        return;
      }

      track.allDocs.list.docMenu.deleteDoc();
      openConfirmModal({
        title: t["com.myoxus.moveToTrash.confirmModal.title"](),
        description: t["com.myoxus.moveToTrash.confirmModal.description"]({
          title: doc.title$.value || t["Untitled"](),
        }),
        cancelText: t["com.myoxus.confirmModal.button.cancel"](),
        confirmText: t.Delete(),
        confirmButtonOptions: {
          variant: "error",
        },
        onConfirm: async () => {
          try {
            const canTrash = await guardService.can("Doc_Trash", doc.id);
            if (!canTrash) {
              notify({ title: t["com.myoxus.no-permission"]() });
              return;
            }
            await moveToTrash(doc);
          } catch (error) {
            console.error(error);
            const userFriendlyError = UserFriendlyError.fromAny(error);
            notify({
              title: t[`error.${userFriendlyError.name}`](
                userFriendlyError.data,
              ),
            });
          }
        },
      });
    },
    [doc, guardService, moveToTrash, onClick, openConfirmModal, t],
  );

  if (!quickTrash) {
    return null;
  }

  return (
    <IconButton
      onClick={onMoveToTrash}
      icon={<DeleteIcon />}
      variant="danger"
      data-testid="doc-list-operation-trash"
      {...iconButtonProps}
    />
  );
});

export const QuickSelect = memo(function QuickSelect({
  doc,
  onClick,
  ...iconButtonProps
}: QuickActionProps) {
  const t = useI18n();
  const contextValue = useContext(DocExplorerContext);
  const quickSelect = useLiveData(contextValue.quickSelect$);
  const selectedDocIds = useLiveData(contextValue.selectedDocIds$);

  const selected = selectedDocIds.includes(doc.id);

  const onChange = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      contextValue.selectMode$?.next(true);
      onClick?.(e);
      e.stopPropagation();
      e.preventDefault();
      contextValue.selectMode$?.next(true);
      contextValue.selectedDocIds$?.next(
        selected
          ? selectedDocIds.filter((id) => id !== doc.id)
          : [...selectedDocIds, doc.id],
      );
    },
    [contextValue, doc.id, onClick, selected, selectedDocIds],
  );

  if (!quickSelect) {
    return null;
  }

  return (
    <IconButton
      aria-label={t["com.myoxus.all-docs.quick-action.select"]()}
      onClick={onChange}
      icon={
        <Checkbox
          aria-label={t["com.myoxus.all-docs.quick-action.select"]()}
          checked={selected}
          data-myoxus-ui-role="quick-action-passive-checkbox"
        />
      }
      {...iconButtonProps}
    />
  );
});

export const QuickDeletePermanently = memo(function QuickDeletePermanently({
  doc,
  onClick,
  ...iconButtonProps
}: QuickActionProps) {
  const t = useI18n();
  const guardService = useService(GuardService);
  const contextValue = useContext(DocExplorerContext);
  const { permanentlyDeletePage } = useDocumentOperations();
  const quickDeletePermanently = useLiveData(
    contextValue.quickDeletePermanently$,
  );
  const { openConfirmModal } = useConfirmModal();

  const handleDeletePermanently = useCallback(async () => {
    const can = await guardService.can("Doc_Delete", doc.id);
    if (!can) {
      notify({ title: t["com.myoxus.no-permission"]() });
      return;
    }

    // The confirm dialog awaits this callback. Keep the permission check and
    // acknowledged permanent-delete mutation in the same promise chain so the
    // trash row cannot be rechecked before local root-meta reconciliation ran.
    await permanentlyDeletePage(doc.id);
    notify({ title: t["com.myoxus.toastMessage.permanentlyDeleted"]() });
  }, [doc.id, guardService, permanentlyDeletePage, t]);

  const handleConfirmDeletePermanently = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      e.stopPropagation();
      e.preventDefault();
      openConfirmModal({
        title: `${t["com.myoxus.trashOperation.deletePermanently"]()}?`,
        description: t["com.myoxus.trashOperation.deleteDescription"](),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.trashOperation.delete"](),
        confirmButtonOptions: {
          variant: "error",
        },
        onConfirm: handleDeletePermanently,
      });
    },
    [handleDeletePermanently, onClick, openConfirmModal, t],
  );

  if (!quickDeletePermanently) {
    return null;
  }

  return (
    <IconButton
      data-testid="delete-page-button"
      onClick={handleConfirmDeletePermanently}
      icon={<DeleteIcon />}
      variant="danger"
      {...iconButtonProps}
    />
  );
});

export const QuickRestore = memo(function QuickRestore({
  doc,
  onClick,
  ...iconButtonProps
}: QuickActionProps) {
  const t = useI18n();
  const contextValue = useContext(DocExplorerContext);
  const quickRestore = useLiveData(contextValue.quickRestore$);
  const { restoreFromTrash } = useDocumentOperations();
  const guardService = useService(GuardService);

  const handleRestore = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      e.stopPropagation();
      e.preventDefault();
      guardService
        .can("Doc_Delete", doc.id)
        .then(async (can) => {
          if (can) {
            await restoreFromTrash(doc.id);
            notify({
              title: t["com.myoxus.toastMessage.restored"]({
                title: doc.title$.value || "Untitled",
              }),
            });
          } else {
            notify({ title: t["com.myoxus.no-permission"]() });
          }
        })
        .catch((e) => {
          console.error(e);
        });
    },
    [doc.id, doc.title$, guardService, onClick, restoreFromTrash, t],
  );

  if (!quickRestore) {
    return null;
  }

  return (
    <IconButton
      data-testid="restore-page-button"
      onClick={handleRestore}
      icon={<ArchiveRestoreIcon />}
      {...iconButtonProps}
    />
  );
});
