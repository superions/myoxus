// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  DuplicateIcon,
  InformationIcon,
  MoreVerticalIcon,
  OpenInNewIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  IconButton,
  type IconButtonProps,
  Menu,
  MenuItem,
  type MenuProps,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useContext } from "react";

import { useDocumentOperations } from "../../hooks/myoxus/use-document-operations";
import { IsFavoriteIcon } from "../../pure/icons";
import { WorkspaceContentOperationMenuItems } from "../../workspace-content-operation/menu-items";
import { DocExplorerContext } from "../context";

interface DocMenuActionProps {
  docId: string;
}

const ToggleFavoriteItem = ({ docId }: DocMenuActionProps) => {
  const t = useI18n();
  const favAdapter = useService(CompatibleFavoriteItemsAdapter);
  const isFavorite = useLiveData(favAdapter.isFavorite$(docId, "doc"));

  const handleToggle = useCallback(() => {
    favAdapter.toggle(docId, "doc");
    track.allDocs.list.docMenu.toggleFavorite();
  }, [docId, favAdapter]);

  return (
    <MenuItem
      prefixIcon={<IsFavoriteIcon favorite={isFavorite} />}
      onClick={handleToggle}
      data-testid="doc-list-operation-favorite"
    >
      {isFavorite
        ? t["com.myoxus.favoritePageOperation.remove"]()
        : t["com.myoxus.favoritePageOperation.add"]()}
    </MenuItem>
  );
};

const DocInfo = ({ docId }: DocMenuActionProps) => {
  const t = useI18n();
  const workspaceDialogService = useService(WorkspaceDialogService);

  const handleOpenInfo = useCallback(() => {
    if (!docId) return;
    track.allDocs.list.docMenu.openDocInfo();
    workspaceDialogService.open("doc-info", { docId });
  }, [docId, workspaceDialogService]);

  return (
    <MenuItem
      onClick={handleOpenInfo}
      prefixIcon={<InformationIcon />}
      data-testid="doc-list-operation-info"
    >
      {t["com.myoxus.page-properties.page-info.view"]()}
    </MenuItem>
  );
};

const OpenInNewTabItem = ({ docId }: DocMenuActionProps) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;

  const handleOpen = useCallback(() => {
    track.allDocs.list.doc.openDoc();
    track.allDocs.list.docMenu.openInNewTab();
    workbench.openDoc(docId, { at: "new-tab" });
  }, [docId, workbench]);

  return (
    <MenuItem onClick={handleOpen} prefixIcon={<OpenInNewIcon />}>
      {t["com.myoxus.workbench.tab.page-menu-open"]()}
    </MenuItem>
  );
};

const OpenInSplitViewItem = ({ docId }: DocMenuActionProps) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;

  const handleOpen = useCallback(() => {
    track.allDocs.list.doc.openDoc();
    track.allDocs.list.docMenu.openInSplitView();
    workbench.openDoc(docId, { at: "tail" });
  }, [docId, workbench]);

  return (
    <MenuItem onClick={handleOpen} prefixIcon={<SplitViewIcon />}>
      {t["com.myoxus.workbench.split-view.page-menu-open"]()}
    </MenuItem>
  );
};

const DuplicateItem = ({ docId }: DocMenuActionProps) => {
  const t = useI18n();
  const { duplicate } = useDocumentOperations();

  const handleDuplicate = useCallback(() => {
    duplicate(docId, false);
    track.allDocs.list.docMenu.createDoc({ control: "duplicate" });
  }, [docId, duplicate]);

  return (
    <MenuItem prefixIcon={<DuplicateIcon />} onSelect={handleDuplicate}>
      {t["com.myoxus.header.option.duplicate"]()}
    </MenuItem>
  );
};

const MoveToTrashItem = ({ docId }: DocMenuActionProps) => {
  const t = useI18n();
  const doc = useLiveData(useService(DocsService).list.doc$(docId));
  const { openConfirmModal } = useConfirmModal();
  const { moveToTrash } = useDocumentOperations();
  const canTrash = useGuard("Doc_Trash", docId);

  const handleTrash = useCallback(() => {
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
        await moveToTrash(doc);
      },
    });
  }, [doc, moveToTrash, openConfirmModal, t]);

  return (
    <MenuItem
      prefixIcon={<DeleteIcon />}
      data-testid="doc-list-operation-trash"
      onClick={handleTrash}
      disabled={!canTrash}
    >
      {t["com.myoxus.moveToTrash.title"]()}
    </MenuItem>
  );
};

export const MoreMenuContent = (props: DocMenuActionProps) => (
  <>
    <ToggleFavoriteItem {...props} />
    <DocInfo {...props} />
    <OpenInNewTabItem {...props} />
    {BUILD_CONFIG.isElectron ? <OpenInSplitViewItem {...props} /> : null}
    <DuplicateItem {...props} />
    <WorkspaceContentOperationMenuItems
      selection={{
        type: "resources",
        resources: [
          {
            id: props.docId,
            kind: WorkspaceContentResourceKindType.Document,
          },
        ],
      }}
    />
    <MoveToTrashItem {...props} />
  </>
);

export const MoreMenu = ({
  docId,
  children,
  contentOptions,
  ...menuProps
}: Omit<MenuProps, "items"> & { docId: string }) => (
  <Menu
    items={<MoreMenuContent docId={docId} />}
    contentOptions={{
      ...contentOptions,
      onClick: (event) => {
        event.stopPropagation();
        contentOptions?.onClick?.(event);
      },
    }}
    {...menuProps}
  >
    {children}
  </Menu>
);

export const MoreMenuButton = ({
  docId,
  iconProps,
  ...menuProps
}: Omit<MenuProps, "items" | "children"> & {
  docId: string;
  iconProps?: IconButtonProps;
}) => {
  const showMoreOperation = useLiveData(
    useContext(DocExplorerContext).showMoreOperation$,
  );
  const { onClick: iconOnClick, ...safeIconProps } = iconProps ?? {};

  const handleTriggerClick = useCallback<
    NonNullable<IconButtonProps["onClick"]>
  >(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      iconOnClick?.(event);
    },
    [iconOnClick],
  );

  if (!showMoreOperation) {
    return null;
  }

  return (
    <MoreMenu docId={docId} {...menuProps}>
      <IconButton
        data-testid="doc-list-operation-button"
        icon={<MoreVerticalIcon />}
        {...safeIconProps}
        onClick={handleTriggerClick}
      />
    </MoreMenu>
  );
};
