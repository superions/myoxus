// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import {
  type FolderNode,
  OrganizeService,
} from "@myoxus/core/modules/organize";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import {
  canonicalPublicWorkspaceUrl,
  WorkspaceShareSettingService,
} from "@myoxus/core/modules/share-setting";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { GlobeIcon, HomeIcon, PlusIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  type DropTargetDropEvent,
  type DropTargetOptions,
  InlineLink,
  MenuItem,
  notify,
  SidebarNavSectionHeading,
  Tooltip,
  VisuallyHidden,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StructureTreeFolderNode } from "../../nodes/folder";
import { StructureTreeNode, StructureTreeRoot } from "../../tree";
import type { StructureTreeNodeIcon } from "../../tree/node";
import type { NodeOperation } from "../../tree/types";
import {
  organizeChildrenDropEffect,
  organizeEmptyDropEffect,
  organizeEmptyRootCanDrop,
} from "./dnd";

const WorkspaceRootIcon: StructureTreeNodeIcon = ({ className }) => (
  <HomeIcon className={className} />
);
const noopCollapse = () => {};

export const StructureTreeOrganizeTree = ({
  currentDocId,
}: {
  chrome?: "folders";
  currentDocId?: string;
}) => {
  const t = useI18n();
  const navigate = useNavigateHelper();
  const {
    organizeService,
    structureTreeStateService,
    workspaceService,
    workspaceServerService,
    workspaceShareSettingService,
  } = useServices({
    OrganizeService,
    StructureTreeStateService,
    WorkspaceService,
    WorkspaceServerService,
    WorkspaceShareSettingService,
  });

  const rootPath = useMemo(() => ["organize"], []);
  const collapsed = useLiveData(structureTreeStateService.collapsed$(rootPath));
  const [newFolderId, setNewFolderId] = useState<string | null>(null);

  const publiclyAccessible = useLiveData(
    workspaceShareSettingService.sharePreview.publiclyAccessible$,
  );
  const publicationLoading = useLiveData(
    workspaceShareSettingService.sharePreview.isLoading$,
  );
  const publicationError = useLiveData(
    workspaceShareSettingService.sharePreview.error$,
  );

  const publicWorkspaceUrl = useMemo(() => {
    const baseUrl = workspaceServerService.server?.baseUrl;
    if (
      !baseUrl ||
      publicationLoading ||
      publicationError !== null ||
      publiclyAccessible !== true
    ) {
      return null;
    }
    return canonicalPublicWorkspaceUrl({
      baseUrl,
      workspaceId: workspaceService.workspace.id,
    });
  }, [
    publicationError,
    publicationLoading,
    publiclyAccessible,
    workspaceServerService.server?.baseUrl,
    workspaceService.workspace.id,
  ]);

  const folderTree = organizeService.folderTree;
  const rootFolder = folderTree.rootFolder;
  const folders = useLiveData(rootFolder.sortedChildren$);

  const activeDocFolderPath = useMemo(
    () => (currentDocId ? folderTree.folderPathForLinkedDoc(currentDocId) : []),
    [currentDocId, folderTree],
  );

  useEffect(() => {
    activeDocFolderPath.reduce<string[]>((acc, folderId) => {
      const next = [...acc, `folder-${folderId}`];
      structureTreeStateService.setCollapsed(next, false);
      return next;
    }, rootPath);
  }, [activeDocFolderPath, rootPath, structureTreeStateService]);

  useEffect(() => {
    if (collapsed) setNewFolderId(null);
  }, [collapsed]);

  const handleCreateFolder = useCallback(() => {
    const createdId = rootFolder.createFolder(
      "New Folder",
      rootFolder.indexAt("before"),
    );
    track.$.navigationPanel.organize.createOrganizeItem({ type: "folder" });
    setNewFolderId(createdId);
    structureTreeStateService.setCollapsed(rootPath, false);
    return createdId;
  }, [rootFolder, rootPath, structureTreeStateService]);

  const rootOperations = useMemo<NodeOperation[]>(() => {
    const list: NodeOperation[] = [
      {
        index: 0,
        view: (
          <MenuItem prefixIcon={<PlusIcon />} onClick={handleCreateFolder}>
            {t["com.myoxus.rootAppSidebar.organize.empty.new-folders-button"]()}
          </MenuItem>
        ),
      },
    ];

    if (publicWorkspaceUrl) {
      const label = t["com.myoxus.workspace-overview.public-status.globe"]();
      list.push({
        index: -1,
        inline: true,
        alwaysVisible: true,
        view: (
          <Tooltip content={label}>
            <InlineLink
              data-testid="workspace-public-root-link"
              href={publicWorkspaceUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              prefix={<GlobeIcon aria-hidden="true" />}
            >
              <VisuallyHidden>{label}</VisuallyHidden>
            </InlineLink>
          </Tooltip>
        ),
      });
    }

    return list;
  }, [handleCreateFolder, publicWorkspaceUrl, t]);

  const handleChildDrop = useCallback(
    (event: DropTargetDropEvent<MyoxusDNDData>, targetNode?: FolderNode) => {
      if (!targetNode?.id) return;
      const instruction = event.treeInstruction?.type;
      if (instruction !== "reorder-above" && instruction !== "reorder-below") {
        return;
      }

      const placement = instruction === "reorder-below" ? "after" : "before";
      if (event.source.data.entity?.type === "folder") {
        rootFolder.moveHere(
          event.source.data.entity.id,
          rootFolder.indexAt(placement, targetNode.id),
        );
        track.$.navigationPanel.organize.moveOrganizeItem({ type: "folder" });
      } else {
        notify({
          title: t["com.myoxus.rootAppSidebar.organize.root-folder-only"](),
        });
      }
    },
    [rootFolder, t],
  );

  const handleRootDrop = useCallback(
    (event: DropTargetDropEvent<MyoxusDNDData>) => {
      const entity = event.source.data.entity;
      if (!entity) return;

      if (entity.type === "folder") {
        rootFolder.moveHere(entity.id, rootFolder.indexAt("before"));
        track.$.navigationPanel.organize.moveOrganizeItem({ type: "folder" });
        return;
      }

      if (
        entity.type !== "database" &&
        entity.type !== "doc" &&
        entity.type !== "tag" &&
        entity.type !== "collection"
      ) {
        return;
      }

      const createdId = handleCreateFolder();
      setNewFolderId(null);
      const createdFolder = folderTree.folderNode$(createdId).value;
      createdFolder?.createLink(
        entity.type,
        entity.id,
        createdFolder.indexAt("after"),
      );
    },
    [folderTree, handleCreateFolder, rootFolder],
  );

  const allowFolderDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) => args.source.data.entity?.type === "folder",
    [],
  );

  return (
    <>
      <SidebarNavSectionHeading>
        {t["com.myoxus.sidebar.hierarchy.folders"]()}
      </SidebarNavSectionHeading>
      <StructureTreeRoot density="compact">
        <StructureTreeNode
          icon={WorkspaceRootIcon}
          name={
            workspaceService.workspace.meta.name ||
            t["com.myoxus.rootAppSidebar.workspaces"]()
          }
          collapsed={false}
          setCollapsed={noopCollapse}
          collapsible={false}
          reorderable={false}
          onClick={() =>
            navigate.jumpToWorkspaceOverview(workspaceService.workspace.id)
          }
          operations={rootOperations}
          canDrop={organizeEmptyRootCanDrop}
          dndData={{
            draggable: {},
            dropTarget: { at: "structure-tree:organize:root" },
          }}
          dropEffect={organizeEmptyDropEffect}
          onDrop={handleRootDrop}
        >
          {folders.map((child) => (
            <StructureTreeFolderNode
              key={child.id}
              nodeId={child.id as string}
              defaultRenaming={child.id === newFolderId}
              onDrop={handleChildDrop}
              dropEffect={organizeChildrenDropEffect}
              canDrop={allowFolderDrop}
              location={{
                at: "structure-tree:organize:folder-node",
                nodeId: child.id as string,
              }}
              parentPath={rootPath}
            />
          ))}
        </StructureTreeNode>
      </StructureTreeRoot>
    </>
  );
};
