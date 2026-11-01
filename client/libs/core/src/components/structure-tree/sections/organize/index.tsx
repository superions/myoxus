import {
  type FolderNode,
  OrganizeService,
} from "@myoxus/core/modules/organize";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import {
  canonicalPublicWorkspaceUrl,
  WorkspaceShareSettingService,
} from "@myoxus/core/modules/share-setting";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import {
  AddOrganizeIcon,
  GlobeIcon,
  HomeIcon,
  PlusIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  type DropTargetDropEvent,
  type DropTargetOptions,
  MenuItem,
  InlineLink,
  notify,
  SidebarNavSection,
  SidebarNavSectionHeading,
  SidebarNavSectionLabel,
  StructureTreeActionButton,
  Tooltip,
  VisuallyHidden,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeDocNode } from "../../nodes/doc";
import { StructureTreeFolderNode } from "../../nodes/folder";
import { StructureTreeNode, StructureTreeRoot } from "../../tree";
import type { StructureTreeNodeIcon } from "../../tree/node";
import type { NodeOperation } from "../../tree/types";
import {
  organizeChildrenDropEffect,
  organizeEmptyDropEffect,
  organizeEmptyRootCanDrop,
} from "./dnd";
import { RootEmpty } from "./empty";

const StructureTreeHomeIcon: StructureTreeNodeIcon = ({ className }) => (
  <HomeIcon className={className} />
);
const keepStructureTreeRootOpen = () => {};

export const StructureTreeOrganizeTree = ({
  chrome = "section",
  currentDocId,
}: {
  chrome?: "section" | "plain" | "folders";
  currentDocId?: string;
}) => {
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
  const navigate = useNavigateHelper();
  const path = useMemo(() => ["organize"], []);
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const [newFolderId, setNewFolderId] = useState<string | null>(null);
  const t = useI18n();
  const publiclyAccessible = useLiveData(
    workspaceShareSettingService.sharePreview.publiclyAccessible$,
  );
  const publicationLoading = useLiveData(
    workspaceShareSettingService.sharePreview.isLoading$,
  );
  const publicationError = useLiveData(
    workspaceShareSettingService.sharePreview.error$,
  );
  const workspacePublicUrl = useMemo(() => {
    const baseUrl = workspaceServerService.server?.baseUrl;
    // Revalidation retains the last value; only a confirmed result exposes the link.
    return baseUrl &&
      !publicationLoading &&
      publicationError === null &&
      publiclyAccessible === true
      ? canonicalPublicWorkspaceUrl({
          baseUrl,
          workspaceId: workspaceService.workspace.id,
        })
      : null;
  }, [
    publiclyAccessible,
    publicationLoading,
    publicationError,
    workspaceServerService.server?.baseUrl,
    workspaceService.workspace.id,
  ]);

  const folderTree = organizeService.folderTree;
  const rootFolder = folderTree.rootFolder;

  const folders = useLiveData(rootFolder.sortedChildren$);
  const isLoading = useLiveData(folderTree.isLoading$);
  const currentDocFolderPath = useMemo(
    () => (currentDocId ? folderTree.folderPathForLinkedDoc(currentDocId) : []),
    [currentDocId, folderTree],
  );

  useEffect(() => {
    currentDocFolderPath.reduce<string[]>((parentPath, folderId) => {
      const nextPath = [...parentPath, `folder-${folderId}`];
      structureTreeStateService.setCollapsed(nextPath, false);
      return nextPath;
    }, path);
  }, [currentDocFolderPath, structureTreeStateService, path]);

  const handleCreateFolder = useCallback(() => {
    const newFolderId = rootFolder.createFolder(
      "New Folder",
      rootFolder.indexAt("before"),
    );
    track.$.navigationPanel.organize.createOrganizeItem({ type: "folder" });
    setNewFolderId(newFolderId);
    structureTreeStateService.setCollapsed(path, false);
    return newFolderId;
  }, [structureTreeStateService, path, rootFolder]);

  const rootOperations = useMemo(() => {
    const operations: NodeOperation[] = [
      {
        index: 0,
        view: (
          <MenuItem prefixIcon={<PlusIcon />} onClick={handleCreateFolder}>
            {t["com.myoxus.rootAppSidebar.organize.empty.new-folders-button"]()}
          </MenuItem>
        ),
      },
    ];
    if (workspacePublicUrl) {
      const label = t["com.myoxus.workspace-overview.public-status.globe"]();
      operations.push({
        index: -1,
        inline: true,
        alwaysVisible: true,
        view: (
          <Tooltip content={label}>
            <InlineLink
              data-testid="workspace-public-root-link"
              href={workspacePublicUrl}
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
    return operations;
  }, [handleCreateFolder, t, workspacePublicUrl]);

  const handleOnChildrenDrop = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>, node?: FolderNode) => {
      if (!node || !node.id) {
        return; // never happens
      }
      if (
        data.treeInstruction?.type === "reorder-above" ||
        data.treeInstruction?.type === "reorder-below"
      ) {
        const at =
          data.treeInstruction?.type === "reorder-below" ? "after" : "before";
        if (data.source.data.entity?.type === "folder") {
          rootFolder.moveHere(
            data.source.data.entity.id,
            rootFolder.indexAt(at, node.id),
          );
          track.$.navigationPanel.organize.moveOrganizeItem({ type: "folder" });
        } else {
          notify({
            title: t["com.myoxus.rootAppSidebar.organize.root-folder-only"](),
          });
        }
      } else {
        return; // not supported
      }
    },
    [rootFolder, t],
  );

  const createFolderAndDrop = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      const entity = data.source.data.entity;
      if (!entity) return;
      const { type, id } = entity;
      // A folder is already a container. Root drops reparent that identity;
      // only resource shortcuts need a newly created containing folder.
      if (type === "folder") {
        rootFolder.moveHere(id, rootFolder.indexAt("before"));
        track.$.navigationPanel.organize.moveOrganizeItem({ type: "folder" });
        return;
      }
      if (
        type !== "database" &&
        type !== "doc" &&
        type !== "tag" &&
        type !== "collection"
      ) {
        return;
      }

      const newFolderId = handleCreateFolder();
      setNewFolderId(null);
      const newFolder$ = folderTree.folderNode$(newFolderId);

      const folder = newFolder$.value;
      if (!folder) return;
      folder.createLink(type, id, folder.indexAt("after"));
    },
    [folderTree, handleCreateFolder, rootFolder],
  );

  const handleChildrenCanDrop = useMemo<
    DropTargetOptions<MyoxusDNDData>["canDrop"]
  >(() => (args) => args.source.data.entity?.type === "folder", []);

  useEffect(() => {
    if (collapsed) setNewFolderId(null); // reset new folder id to clear the renaming state
  }, [collapsed]);

  const folderNodes = folders.map((child) => (
    <StructureTreeFolderNode
      key={child.id}
      nodeId={child.id as string}
      defaultRenaming={child.id === newFolderId}
      onDrop={handleOnChildrenDrop}
      dropEffect={organizeChildrenDropEffect}
      canDrop={handleChildrenCanDrop}
      location={{
        at: "structure-tree:organize:folder-node",
        nodeId: child.id as string,
      }}
      parentPath={path}
    />
  ));

  const foldersTree = (
    <StructureTreeRoot
      placeholder={
        <RootEmpty
          onClickCreate={handleCreateFolder}
          isLoading={isLoading}
          onDrop={createFolderAndDrop}
        />
      }
    >
      {folderNodes}
    </StructureTreeRoot>
  );

  if (chrome === "plain") {
    // The context panel uses the same folder data/actions as the main
    // navigation, but separates the active document from the folder root so the
    // empty state describes folders only, not the complete hierarchy panel.
    return (
      <>
        {currentDocId ? (
          <SidebarNavSection data-myoxus-ui-role="context-organization-current-document-section">
            <SidebarNavSectionLabel>
              {t["com.myoxus.sidebar.hierarchy.current-document"]()}
            </SidebarNavSectionLabel>
            <StructureTreeRoot data-myoxus-ui-role="context-organization-current-document-tree">
              <StructureTreeDocNode
                docId={currentDocId}
                reorderable={false}
                location={{
                  at: "doc-detail:header",
                  docId: currentDocId,
                }}
                parentPath={["organize", "current-doc"]}
              />
            </StructureTreeRoot>
          </SidebarNavSection>
        ) : null}
        {/* Keep the context folder section on the same header primitive as
            Collections and Tags; mixing labels and section headers regresses the
            horizontal rhythm and invites local CSS fixes. */}
        <CollapsibleSection
          path={path}
          title={t["com.myoxus.sidebar.hierarchy.folders"]()}
          testId="context-organization-folder-section"
          actions={
            <StructureTreeActionButton
              data-testid="structure-tree-bar-add-folder-button"
              onClick={handleCreateFolder}
              tooltip={t[
                "com.myoxus.rootAppSidebar.explorer.organize-section-add-tooltip"
              ]()}
            >
              <AddOrganizeIcon />
            </StructureTreeActionButton>
          }
        >
          {foldersTree}
        </CollapsibleSection>
      </>
    );
  }

  if (chrome === "folders") {
    return (
      <>
        <SidebarNavSectionHeading>
          {t["com.myoxus.sidebar.hierarchy.folders"]()}
        </SidebarNavSectionHeading>
        <StructureTreeRoot>
          <StructureTreeNode
            icon={StructureTreeHomeIcon}
            name={
              workspaceService.workspace.meta.name ||
              t["com.myoxus.rootAppSidebar.workspaces"]()
            }
            collapsed={false}
            setCollapsed={keepStructureTreeRootOpen}
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
            onDrop={createFolderAndDrop}
          >
            {folderNodes}
          </StructureTreeNode>
        </StructureTreeRoot>
      </>
    );
  }

  return (
    <CollapsibleSection
      path={path}
      title={t["com.myoxus.rootAppSidebar.organize"]()}
      actions={
        <StructureTreeActionButton
          data-testid="structure-tree-bar-add-organize-button"
          onClick={handleCreateFolder}
          tooltip={t[
            "com.myoxus.rootAppSidebar.explorer.organize-section-add-tooltip"
          ]()}
        >
          <AddOrganizeIcon />
        </StructureTreeActionButton>
      }
    >
      {foldersTree}
    </CollapsibleSection>
  );
};

export const StructureTreeOrganize = () => {
  return <StructureTreeOrganizeTree />;
};
