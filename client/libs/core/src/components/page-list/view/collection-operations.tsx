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
  const {
    collectionService: service,
    workbenchService,
    workspaceDialogService,
  } = useServices({
    CollectionService,
    WorkbenchService,
    WorkspaceDialogService,
  });
  const workbench = workbenchService.workbench;
  const t = useI18n();
  const { openPromptModal } = usePromptModal();

  const showEditName = useCallback(() => {
    // use openRenameModal if it is in the sidebar collection list
    if (openRenameModal) {
      return openRenameModal();
    }
    openPromptModal({
      title: t["com.myoxus.editCollection.renameCollection"](),
      label: t["com.myoxus.editCollectionName.name"](),
      inputOptions: {
        placeholder: t["com.myoxus.editCollectionName.name.placeholder"](),
      },
      confirmText: t["com.myoxus.editCollection.save"](),
      cancelText: t["com.myoxus.editCollection.button.cancel"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      onConfirm(name) {
        service.updateCollection(collection.id, {
          name,
        });
      },
    });
  }, [openRenameModal, openPromptModal, t, service, collection]);

  const showEdit = useCallback(() => {
    track.collection.collection.$.editCollection();
    workspaceDialogService.open("collection-editor", {
      collectionId: collection.id,
    });
  }, [workspaceDialogService, collection.id]);

  const openCollectionSplitView = useCallback(() => {
    workbench.openCollection(collection.id, { at: "tail" });
  }, [collection.id, workbench]);

  const openCollectionNewTab = useCallback(() => {
    workbench.openCollection(collection.id, { at: "new-tab" });
  }, [collection.id, workbench]);

  const favAdapter = useService(CompatibleFavoriteItemsAdapter);

  const onToggleFavoritePage = useCallback(() => {
    favAdapter.toggle(collection.id, "collection");
  }, [favAdapter, collection.id]);

  const favorite = useLiveData(
    useMemo(
      () => favAdapter.isFavorite$(collection.id, "collection"),
      [collection.id, favAdapter],
    ),
  );

  const actions = useMemo<
    Array<
      | {
          icon: ReactElement;
          name: string;
          click: () => void;
          type?: MenuItemProps["type"];
          element?: undefined;
        }
      | {
          element: ReactElement;
        }
    >
  >(
    () => [
      {
        icon: <EditIcon />,
        name: t["com.myoxus.collection.menu.rename"](),
        click: showEditName,
      },
      {
        icon: <FilterIcon />,
        name: t["com.myoxus.collection.menu.edit"](),
        click: showEdit,
      },
      ...(onAddDocToCollection
        ? [
            {
              icon: <PlusIcon />,
              name: t["New Page"](),
              click: onAddDocToCollection,
            },
          ]
        : []),
      {
        icon: <IsFavoriteIcon favorite={favorite} />,
        name: favorite
          ? t["com.myoxus.favoritePageOperation.remove"]()
          : t["com.myoxus.favoritePageOperation.add"](),
        click: onToggleFavoritePage,
      },
      {
        icon: <OpenInNewIcon />,
        name: t["com.myoxus.workbench.tab.page-menu-open"](),
        click: openCollectionNewTab,
      },
      ...(BUILD_CONFIG.isElectron
        ? [
            {
              icon: <SplitViewIcon />,
              name: t["com.myoxus.workbench.split-view.page-menu-open"](),
              click: openCollectionSplitView,
            },
          ]
        : []),
      {
        element: <MenuSeparator key="divider" />,
      },
      {
        icon: <DeleteIcon />,
        name: t["Delete"](),
        click: () => {
          service.deleteCollection(collection.id);
        },
        type: "danger",
      },
    ],
    [
      t,
      showEditName,
      showEdit,
      onAddDocToCollection,
      favorite,
      onToggleFavoritePage,
      openCollectionNewTab,
      openCollectionSplitView,
      service,
      collection.id,
    ],
  );
  return (
    <Menu
      items={
        <MenuPanel>
          {actions.map((action) => {
            if (action.element) {
              return action.element;
            }
            return (
              <MenuItem
                data-testid="collection-option"
                key={action.name}
                type={action.type}
                prefixIcon={action.icon}
                onClick={action.click}
              >
                {action.name}
              </MenuItem>
            );
          })}
        </MenuPanel>
      }
    >
      {children}
    </Menu>
  );
};
