// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
  ...iconProps
}: QuickActionProps) {
  const enabled = useLiveData(useContext(DocExplorerContext).quickFavorite$);
  const favAdapter = useService(CompatibleFavoriteItemsAdapter);
  const isFavorite = useLiveData(favAdapter.isFavorite$(doc.id, "doc"));

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      event.stopPropagation();
      event.preventDefault();
      track.allDocs.list.docMenu.toggleFavorite();
      favAdapter.toggle(doc.id, "doc");
    },
    [doc.id, favAdapter, onClick],
  );

  if (!enabled) return null;

  return (
    <IconButton
      icon={<IsFavoriteIcon favorite={isFavorite} />}
      onClick={handleClick}
      data-testid="doc-list-operation-favorite"
      {...iconProps}
    />
  );
});

export const QuickTab = memo(function QuickTab({
  doc,
  onClick,
  ...iconProps
}: QuickActionProps) {
  const enabled = useLiveData(useContext(DocExplorerContext).quickTab$);
  const workbench = useService(WorkbenchService).workbench;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      event.stopPropagation();
      event.preventDefault();
      track.allDocs.list.doc.openDoc();
      track.allDocs.list.docMenu.openInNewTab();
      workbench.openDoc(doc.id, { at: "new-tab" });
    },
    [doc.id, onClick, workbench],
  );

  if (!enabled) return null;

  return (
    <IconButton onClick={handleClick} icon={<OpenInNewIcon />} {...iconProps} />
  );
});

export const QuickSplit = memo(function QuickSplit({
  doc,
  onClick,
  ...iconProps
}: QuickActionProps) {
  const enabled = useLiveData(useContext(DocExplorerContext).quickSplit$);
  const workbench = useService(WorkbenchService).workbench;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      event.stopPropagation();
      event.preventDefault();
      track.allDocs.list.doc.openDoc();
      track.allDocs.list.docMenu.openInSplitView();
      workbench.openDoc(doc.id, { at: "tail" });
    },
    [doc.id, onClick, workbench],
  );

  if (!enabled) return null;

  return (
    <IconButton onClick={handleClick} icon={<SplitViewIcon />} {...iconProps} />
  );
});

export const QuickDelete = memo(function QuickDelete({
  doc,
  onClick,
  ...iconProps
}: QuickActionProps) {
  const t = useI18n();
  const enabled = useLiveData(useContext(DocExplorerContext).quickTrash$);
  const guardService = useService(GuardService);
  const { openConfirmModal } = useConfirmModal();
  const { moveToTrash } = useDocumentOperations();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      event.stopPropagation();
      event.preventDefault();
      if (!doc) return;

      track.allDocs.list.docMenu.deleteDoc();
      openConfirmModal({
        title: t["com.myoxus.moveToTrash.confirmModal.title"](),
        description: t["com.myoxus.moveToTrash.confirmModal.description"]({
          title: doc.title$.value || t["Untitled"](),
        }),
        cancelText: t["com.myoxus.confirmModal.button.cancel"](),
        confirmText: t.Delete(),
        confirmButtonOptions: { variant: "error" },
        onConfirm: async () => {
          try {
            const allowed = await guardService.can("Doc_Trash", doc.id);
            if (!allowed) {
              notify({ title: t["com.myoxus.no-permission"]() });
              return;
            }
            await moveToTrash(doc);
          } catch (error) {
            console.error(error);
            const friendly = UserFriendlyError.fromAny(error);
            notify({
              title: t[`error.${friendly.name}`](friendly.data),
            });
          }
        },
      });
    },
    [doc, guardService, moveToTrash, onClick, openConfirmModal, t],
  );

  if (!enabled) return null;

  return (
    <IconButton
      onClick={handleClick}
      icon={<DeleteIcon />}
      variant="danger"
      data-testid="doc-list-operation-trash"
      {...iconProps}
    />
  );
});

export const QuickSelect = memo(function QuickSelect({
  doc,
  onClick,
  ...iconProps
}: QuickActionProps) {
  const t = useI18n();
  const context = useContext(DocExplorerContext);
  const enabled = useLiveData(context.quickSelect$);
  const selectedDocIds = useLiveData(context.selectedDocIds$);
  const selected = selectedDocIds.includes(doc.id);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      event.stopPropagation();
      event.preventDefault();
      context.selectMode$?.next(true);
      context.selectedDocIds$.next(
        selected
          ? selectedDocIds.filter((id) => id !== doc.id)
          : [...selectedDocIds, doc.id],
      );
    },
    [context, doc.id, onClick, selected, selectedDocIds],
  );

  if (!enabled) return null;

  const label = t["com.myoxus.all-docs.quick-action.select"]();

  return (
    <IconButton
      aria-label={label}
      onClick={handleClick}
      icon={
        <Checkbox
          aria-label={label}
          checked={selected}
          data-myoxus-ui-role="quick-action-passive-checkbox"
        />
      }
      {...iconProps}
    />
  );
});

export const QuickDeletePermanently = memo(function QuickDeletePermanently({
  doc,
  onClick,
  ...iconProps
}: QuickActionProps) {
  const t = useI18n();
  const enabled = useLiveData(
    useContext(DocExplorerContext).quickDeletePermanently$,
  );
  const guardService = useService(GuardService);
  const { permanentlyDeletePage } = useDocumentOperations();
  const { openConfirmModal } = useConfirmModal();

  const runDelete = useCallback(async () => {
    const allowed = await guardService.can("Doc_Delete", doc.id);
    if (!allowed) {
      notify({ title: t["com.myoxus.no-permission"]() });
      return;
    }
    // Keep the permission check and permanent-delete mutation in one awaited
    // promise chain so the confirm dialog stays pending until reconciliation.
    await permanentlyDeletePage(doc.id);
    notify({ title: t["com.myoxus.toastMessage.permanentlyDeleted"]() });
  }, [doc.id, guardService, permanentlyDeletePage, t]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      event.stopPropagation();
      event.preventDefault();
      openConfirmModal({
        title: `${t["com.myoxus.trashOperation.deletePermanently"]()}?`,
        description: t["com.myoxus.trashOperation.deleteDescription"](),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.trashOperation.delete"](),
        confirmButtonOptions: { variant: "error" },
        onConfirm: runDelete,
      });
    },
    [onClick, openConfirmModal, runDelete, t],
  );

  if (!enabled) return null;

  return (
    <IconButton
      data-testid="delete-page-button"
      onClick={handleClick}
      icon={<DeleteIcon />}
      variant="danger"
      {...iconProps}
    />
  );
});

export const QuickRestore = memo(function QuickRestore({
  doc,
  onClick,
  ...iconProps
}: QuickActionProps) {
  const t = useI18n();
  const enabled = useLiveData(useContext(DocExplorerContext).quickRestore$);
  const guardService = useService(GuardService);
  const { restoreFromTrash } = useDocumentOperations();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      event.stopPropagation();
      event.preventDefault();
      guardService
        .can("Doc_Delete", doc.id)
        .then(async (allowed) => {
          if (!allowed) {
            notify({ title: t["com.myoxus.no-permission"]() });
            return;
          }
          await restoreFromTrash(doc.id);
          notify({
            title: t["com.myoxus.toastMessage.restored"]({
              title: doc.title$.value || "Untitled",
            }),
          });
        })
        .catch((error) => {
          console.error(error);
        });
    },
    [doc.id, doc.title$, guardService, onClick, restoreFromTrash, t],
  );

  if (!enabled) return null;

  return (
    <IconButton
      data-testid="restore-page-button"
      onClick={handleClick}
      icon={<ArchiveRestoreIcon />}
      {...iconProps}
    />
  );
});
