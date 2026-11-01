import { Guard } from "@myoxus/core/components/guard";
import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import { WorkspaceTagsMenuEditor } from "@myoxus/core/components/tags";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { DocsService } from "@myoxus/core/modules/doc";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { GuardService } from "@myoxus/core/modules/permissions";
import { TagService } from "@myoxus/core/modules/tag";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  DuplicateIcon,
  InformationIcon,
  LinkedPageIcon,
  OpenInNewIcon,
  PlusIcon,
  SplitViewIcon,
  TagsIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  notify,
  StructureTreeActionButton,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { WorkspaceContentOperationMenuItems } from "../../../workspace-content-operation/menu-items";
import type { NodeOperation } from "../../tree/types";

const StructureTreeDocTagsOperation = ({ docId }: { docId: string }) => {
  const t = useI18n();
  const tagService = useService(TagService);
  const assignmentState = useLiveData(
    tagService.tagList.assignmentState$(docId),
  );
  const selectedTagIds = useLiveData(
    useMemo(
      () => tagService.tagList.tagIdsByPageId$(docId),
      [docId, tagService.tagList],
    ),
  );
  const commit = useCallback(
    (nextIds: string[]) => tagService.tagList.setPageTags(docId, nextIds),
    [docId, tagService.tagList],
  );

  return (
    <Guard docId={docId} permission="Doc_Update">
      {(canEdit) => (
        <MenuSub
          items={
            <WorkspaceTagsMenuEditor
              commit={commit}
              assignmentState={assignmentState}
              selectedTags={selectedTagIds}
              tagMode="inline-tag"
            />
          }
          subContentOptions={{ panelWidth: "large" }}
          triggerOptions={{
            "data-testid": "structure-tree-doc-add-tags",
            disabled: !canEdit,
            prefixIcon: <TagsIcon />,
          }}
        >
          {t["com.myoxus.rootAppSidebar.organize.folder.add-tags"]()}
        </MenuSub>
      )}
    </Guard>
  );
};

export const useStructureTreeDocNodeOperations = (
  docId: string,
  options: {
    openInfoModal: () => void;
    openNodeCollapsed: () => void;
    showLinkedDocuments: boolean;
  },
): NodeOperation[] => {
  const t = useI18n();
  const {
    workbenchService,
    workspaceService,
    docsService,
    compatibleFavoriteItemsAdapter,
    guardService,
  } = useServices({
    DocsService,
    WorkbenchService,
    WorkspaceService,
    CompatibleFavoriteItemsAdapter,
    GuardService,
  });
  const { openConfirmModal } = useConfirmModal();

  const [addLinkedPageLoading, setAddLinkedPageLoading] = useState(false);
  const docRecord = useLiveData(docsService.list.doc$(docId));
  const { showLinkedDocuments } = options;

  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  const favorite = useLiveData(
    useMemo(() => {
      return compatibleFavoriteItemsAdapter.isFavorite$(docId, "doc");
    }, [docId, compatibleFavoriteItemsAdapter]),
  );

  const { duplicate, moveToTrash } = useDocumentOperations();
  const handleDuplicate = useCallback(() => {
    duplicate(docId, true);
    track.$.navigationPanel.docs.createDoc();
  }, [docId, duplicate]);
  const handleOpenInfoModal = useCallback(() => {
    track.$.docInfoPanel.$.open();
    options.openInfoModal();
  }, [options]);

  const handleMoveToTrash = useCallback(() => {
    if (!docRecord) {
      return;
    }
    openConfirmModal({
      title: t["com.myoxus.moveToTrash.title"](),
      description: t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: docRecord.title$.value,
      }),
      confirmText: t["com.myoxus.moveToTrash.confirmModal.confirm"](),
      cancelText: t["com.myoxus.moveToTrash.confirmModal.cancel"](),
      confirmButtonOptions: {
        variant: "error",
      },
      async onConfirm() {
        await moveToTrash(docRecord);
        track.$.navigationPanel.docs.deleteDoc({
          control: "button",
        });
        notify({ title: t["com.myoxus.toastMessage.movedTrash"]() });
      },
    });
  }, [docRecord, moveToTrash, openConfirmModal, t]);

  const handleOpenInNewTab = useCallback(() => {
    workbenchService.workbench.openDoc(docId, {
      at: "new-tab",
    });
    track.$.navigationPanel.docs.openDoc();
    track.$.navigationPanel.organize.openInNewTab({
      type: "doc",
    });
  }, [docId, workbenchService]);

  const handleOpenInSplitView = useCallback(() => {
    workbenchService.workbench.openDoc(docId, {
      at: "beside",
    });
    track.$.navigationPanel.docs.openDoc();
    track.$.navigationPanel.organize.openInSplitView({
      type: "doc",
    });
  }, [docId, workbenchService.workbench]);

  const handleAddLinkedPage = useAsyncCallback(async () => {
    setAddLinkedPageLoading(true);
    try {
      const canEdit = await guardService.can("Doc_Update", docId);
      if (!canEdit) {
        notify({ title: t["com.myoxus.no-permission"]() });
        return;
      }
      const newDoc = createPage();
      // TODO: handle timeout & error
      await docsService.addLinkedDoc(docId, newDoc.id);
      track.$.navigationPanel.docs.createDoc({ control: "linkDoc" });
      track.$.navigationPanel.docs.linkDoc({ control: "createDoc" });
      options.openNodeCollapsed();
    } finally {
      setAddLinkedPageLoading(false);
    }
  }, [createPage, guardService, docId, docsService, options, t]);

  const handleToggleFavoriteDoc = useCallback(() => {
    compatibleFavoriteItemsAdapter.toggle(docId, "doc");
    track.$.navigationPanel.organize.toggleFavorite({
      type: "doc",
    });
  }, [docId, compatibleFavoriteItemsAdapter]);

  return useMemo(
    () => [
      ...(showLinkedDocuments
        ? [
            {
              index: 0,
              inline: true,
              view: (
                <StructureTreeActionButton
                  icon={<PlusIcon />}
                  tooltip={t[
                    "com.myoxus.rootAppSidebar.explorer.doc-add-tooltip"
                  ]()}
                  onClick={handleAddLinkedPage}
                  loading={addLinkedPageLoading}
                  disabled={addLinkedPageLoading}
                />
              ),
            },
            {
              index: 99,
              view: (
                <Guard docId={docId} permission="Doc_Update">
                  {(canEdit) => (
                    <MenuItem
                      prefixIcon={<LinkedPageIcon />}
                      onClick={handleAddLinkedPage}
                      disabled={!canEdit}
                    >
                      {t["com.myoxus.page-operation.add-linked-page"]()}
                    </MenuItem>
                  )}
                </Guard>
              ),
            },
          ]
        : []),
      {
        index: 50,
        view: (
          <MenuItem
            prefixIcon={<InformationIcon />}
            onClick={handleOpenInfoModal}
          >
            {t["com.myoxus.page-properties.page-info.view"]()}
          </MenuItem>
        ),
      },
      {
        index: 75,
        view: <StructureTreeDocTagsOperation docId={docId} />,
      },
      {
        index: 99,
        view: (
          <MenuItem prefixIcon={<DuplicateIcon />} onClick={handleDuplicate}>
            {t["com.myoxus.header.option.duplicate"]()}
          </MenuItem>
        ),
      },
      {
        index: 99,
        view: (
          <MenuItem prefixIcon={<OpenInNewIcon />} onClick={handleOpenInNewTab}>
            {t["com.myoxus.workbench.tab.page-menu-open"]()}
          </MenuItem>
        ),
      },
      ...(BUILD_CONFIG.isElectron
        ? [
            {
              index: 100,
              view: (
                <MenuItem
                  prefixIcon={<SplitViewIcon />}
                  onClick={handleOpenInSplitView}
                >
                  {t["com.myoxus.workbench.split-view.page-menu-open"]()}
                </MenuItem>
              ),
            },
          ]
        : []),
      {
        index: 199,
        view: (
          <MenuItem
            prefixIcon={<IsFavoriteIcon favorite={favorite} />}
            onClick={handleToggleFavoriteDoc}
          >
            {favorite
              ? t["com.myoxus.favoritePageOperation.remove"]()
              : t["com.myoxus.favoritePageOperation.add"]()}
          </MenuItem>
        ),
      },
      {
        index: 500,
        view: (
          <WorkspaceContentOperationMenuItems
            selection={{
              type: "resources",
              resources: [
                {
                  id: docId,
                  kind: WorkspaceContentResourceKindType.Document,
                },
              ],
            }}
          />
        ),
      },
      {
        index: 9999,
        view: <MenuSeparator key="menu-separator" />,
      },
      {
        index: 10000,
        view: (
          <Guard docId={docId} permission="Doc_Trash">
            {(canMoveToTrash) => (
              <MenuItem
                type={"danger"}
                prefixIcon={<DeleteIcon />}
                onClick={handleMoveToTrash}
                disabled={!canMoveToTrash}
              >
                {t["com.myoxus.moveToTrash.title"]()}
              </MenuItem>
            )}
          </Guard>
        ),
      },
    ],
    [
      addLinkedPageLoading,
      showLinkedDocuments,
      docId,
      favorite,
      handleAddLinkedPage,
      handleDuplicate,
      handleMoveToTrash,
      handleOpenInNewTab,
      handleOpenInSplitView,
      handleOpenInfoModal,
      handleToggleFavoriteDoc,
      t,
    ],
  );
};
