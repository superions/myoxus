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

interface DocOperationProps {
  docId: string;
}

/**
 * Favorite Operation
 */
const ToggleFavorite = ({ docId }: DocOperationProps) => {
  const t = useI18n();
  const favAdapter = useService(CompatibleFavoriteItemsAdapter);
  const favourite = useLiveData(favAdapter.isFavorite$(docId, "doc"));

  const toggleFavorite = useCallback(() => {
    favAdapter.toggle(docId, "doc");
    track.allDocs.list.docMenu.toggleFavorite();
  }, [docId, favAdapter]);

  return (
    <MenuItem
      prefixIcon={<IsFavoriteIcon favorite={favourite} />}
      onClick={toggleFavorite}
      data-testid="doc-list-operation-favorite"
    >
      {favourite
        ? t["com.myoxus.favoritePageOperation.remove"]()
        : t["com.myoxus.favoritePageOperation.add"]()}
    </MenuItem>
  );
};

/**
 * Doc Info Operation
 */
const DocInfo = ({ docId }: DocOperationProps) => {
  const t = useI18n();
  const workspaceDialogService = useService(WorkspaceDialogService);

  const onOpenInfoModal = useCallback(() => {
    if (docId) {
      track.allDocs.list.docMenu.openDocInfo();
      workspaceDialogService.open("doc-info", { docId });
    }
  }, [docId, workspaceDialogService]);

  return (
    <MenuItem
      onClick={onOpenInfoModal}
      prefixIcon={<InformationIcon />}
      data-testid="doc-list-operation-info"
    >
      {t["com.myoxus.page-properties.page-info.view"]()}
    </MenuItem>
  );
};

/**
 * Open in New Tab Operation
 */
const NewTab = ({ docId }: DocOperationProps) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const onOpenInNewTab = useCallback(() => {
    track.allDocs.list.doc.openDoc();
    track.allDocs.list.docMenu.openInNewTab();
    workbench.openDoc(docId, { at: "new-tab" });
  }, [docId, workbench]);

  return (
    <MenuItem onClick={onOpenInNewTab} prefixIcon={<OpenInNewIcon />}>
      {t["com.myoxus.workbench.tab.page-menu-open"]()}
    </MenuItem>
  );
};

/**
 * Open in Split View Operation
 */
const SplitView = ({ docId }: DocOperationProps) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;

  const onOpenInSplitView = useCallback(() => {
    track.allDocs.list.doc.openDoc();
    track.allDocs.list.docMenu.openInSplitView();
    workbench.openDoc(docId, { at: "tail" });
  }, [docId, workbench]);

  return (
    <MenuItem onClick={onOpenInSplitView} prefixIcon={<SplitViewIcon />}>
      {t["com.myoxus.workbench.split-view.page-menu-open"]()}
    </MenuItem>
  );
};

/**
 * Duplicate Operation
 */
const Duplicate = ({ docId }: DocOperationProps) => {
  const { duplicate } = useDocumentOperations();
  const t = useI18n();

  const onDuplicate = useCallback(() => {
    duplicate(docId, false);
    track.allDocs.list.docMenu.createDoc({
      control: "duplicate",
    });
  }, [docId, duplicate]);

  return (
    <MenuItem prefixIcon={<DuplicateIcon />} onSelect={onDuplicate}>
      {t["com.myoxus.header.option.duplicate"]()}
    </MenuItem>
  );
};

/**
 * Move to Trash Operation
 */
const MoveToTrash = ({ docId }: DocOperationProps) => {
  const t = useI18n();
  const docsService = useService(DocsService);
  const { openConfirmModal } = useConfirmModal();
  const doc = useLiveData(docsService.list.doc$(docId));
  const { moveToTrash } = useDocumentOperations();

  // The list index primes only the capability rendered on every row. Load the
  // remaining permissions when this lazy menu is actually opened.
  const canTrash = useGuard("Doc_Trash", docId);

  const onMoveToTrash = useCallback(() => {
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
        await moveToTrash(doc);
      },
    });
  }, [doc, moveToTrash, openConfirmModal, t]);

  return (
    <MenuItem
      prefixIcon={<DeleteIcon />}
      data-testid="doc-list-operation-trash"
      onClick={onMoveToTrash}
      disabled={!canTrash}
    >
      {t["com.myoxus.moveToTrash.title"]()}
    </MenuItem>
  );
};

export const MoreMenuContent = (props: DocOperationProps) => {
  return (
    <>
      <ToggleFavorite {...props} />
      <DocInfo {...props} />
      <NewTab {...props} />
      {BUILD_CONFIG.isElectron ? <SplitView {...props} /> : null}
      <Duplicate {...props} />
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
      <MoveToTrash {...props} />
    </>
  );
};

export const MoreMenu = ({
  docId,
  children,
  contentOptions,
  ...menuProps
}: Omit<MenuProps, "items"> & { docId: string }) => {
  return (
    <Menu
      items={<MoreMenuContent docId={docId} />}
      contentOptions={{
        ...contentOptions,
        onClick: (e) => {
          // prevent external click events from being triggered
          e.stopPropagation();
          contentOptions?.onClick?.(e);
        },
      }}
      {...menuProps}
    >
      {children}
    </Menu>
  );
};

export const MoreMenuButton = ({
  docId,
  iconProps,
  ...menuProps
}: Omit<MenuProps, "items" | "children"> & {
  docId: string;
  iconProps?: IconButtonProps;
}) => {
  const contextValue = useContext(DocExplorerContext);
  const showMoreOperation = useLiveData(contextValue.showMoreOperation$);
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
