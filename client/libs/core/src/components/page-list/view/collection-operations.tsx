// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  EditIcon,
  FilterIcon,
  OpenInNewIcon,
  PlusIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Menu,
  MenuItem,
  type MenuItemProps,
  MenuPanel,
  MenuSeparator,
  usePromptModal,
} from "@myoxus/ui-facade";
import {
  type PropsWithChildren,
  type ReactElement,
  useCallback,
  useMemo,
} from "react";

import {
  type Collection,
  CollectionService,
} from "../../../modules/collection";
import { IsFavoriteIcon } from "../../pure/icons";

type CollectionMenuEntry =
  | {
      kind: "action";
      icon: ReactElement;
      label: string;
      onSelect: () => void;
      type?: MenuItemProps["type"];
    }
  | {
      kind: "separator";
      key: string;
    };

export const CollectionOperations = ({
  collection,
  openRenameModal,
  onAddDocToCollection,
  children,
}: PropsWithChildren<{
  collection: Collection;
  openRenameModal?: () => void;
  onAddDocToCollection?: () => void;
}>) => {
  const t = useI18n();
  const { collectionService, workbenchService, workspaceDialogService } =
    useServices({
      CollectionService,
      WorkbenchService,
      WorkspaceDialogService,
    });
  const favAdapter = useService(CompatibleFavoriteItemsAdapter);
  const { openPromptModal } = usePromptModal();
  const workbench = workbenchService.workbench;

  const isFavorite = useLiveData(
    useMemo(
      () => favAdapter.isFavorite$(collection.id, "collection"),
      [collection.id, favAdapter],
    ),
  );

  const handleRename = useCallback(() => {
    if (openRenameModal) {
      openRenameModal();
      return;
    }
    openPromptModal({
      title: t["com.myoxus.editCollection.renameCollection"](),
      label: t["com.myoxus.editCollectionName.name"](),
      inputOptions: {
        placeholder: t["com.myoxus.editCollectionName.name.placeholder"](),
      },
      confirmText: t["com.myoxus.editCollection.save"](),
      cancelText: t["com.myoxus.editCollection.button.cancel"](),
      confirmButtonOptions: { variant: "primary" },
      onConfirm: (name) => {
        collectionService.updateCollection(collection.id, { name });
      },
    });
  }, [collection.id, collectionService, openPromptModal, openRenameModal, t]);

  const handleEditRules = useCallback(() => {
    track.collection.collection.$.editCollection();
    workspaceDialogService.open("collection-editor", {
      collectionId: collection.id,
    });
  }, [collection.id, workspaceDialogService]);

  const handleToggleFavorite = useCallback(() => {
    favAdapter.toggle(collection.id, "collection");
  }, [collection.id, favAdapter]);

  const handleOpenNewTab = useCallback(() => {
    workbench.openCollection(collection.id, { at: "new-tab" });
  }, [collection.id, workbench]);

  const handleOpenSplitView = useCallback(() => {
    workbench.openCollection(collection.id, { at: "tail" });
  }, [collection.id, workbench]);

  const entries = useMemo<CollectionMenuEntry[]>(() => {
    const list: CollectionMenuEntry[] = [
      {
        kind: "action",
        icon: <EditIcon />,
        label: t["com.myoxus.collection.menu.rename"](),
        onSelect: handleRename,
      },
      {
        kind: "action",
        icon: <FilterIcon />,
        label: t["com.myoxus.collection.menu.edit"](),
        onSelect: handleEditRules,
      },
    ];

    if (onAddDocToCollection) {
      list.push({
        kind: "action",
        icon: <PlusIcon />,
        label: t["New Page"](),
        onSelect: onAddDocToCollection,
      });
    }

    list.push(
      {
        kind: "action",
        icon: <IsFavoriteIcon favorite={isFavorite} />,
        label: isFavorite
          ? t["com.myoxus.favoritePageOperation.remove"]()
          : t["com.myoxus.favoritePageOperation.add"](),
        onSelect: handleToggleFavorite,
      },
      {
        kind: "action",
        icon: <OpenInNewIcon />,
        label: t["com.myoxus.workbench.tab.page-menu-open"](),
        onSelect: handleOpenNewTab,
      },
    );

    if (BUILD_CONFIG.isElectron) {
      list.push({
        kind: "action",
        icon: <SplitViewIcon />,
        label: t["com.myoxus.workbench.split-view.page-menu-open"](),
        onSelect: handleOpenSplitView,
      });
    }

    list.push(
      { kind: "separator", key: "divider" },
      {
        kind: "action",
        icon: <DeleteIcon />,
        label: t["Delete"](),
        type: "danger",
        onSelect: () => collectionService.deleteCollection(collection.id),
      },
    );

    return list;
  }, [
    collection.id,
    collectionService,
    handleEditRules,
    handleOpenNewTab,
    handleOpenSplitView,
    handleRename,
    handleToggleFavorite,
    isFavorite,
    onAddDocToCollection,
    t,
  ]);

  return (
    <Menu
      items={
        <MenuPanel>
          {entries.map((entry) =>
            entry.kind === "separator" ? (
              <MenuSeparator key={entry.key} />
            ) : (
              <MenuItem
                data-testid="collection-option"
                key={entry.label}
                type={entry.type}
                prefixIcon={entry.icon}
                onClick={entry.onSelect}
              >
                {entry.label}
              </MenuItem>
            ),
          )}
        </MenuPanel>
      }
    >
      {children}
    </Menu>
  );
};
