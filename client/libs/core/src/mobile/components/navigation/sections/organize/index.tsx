import { StructureTreeRoot } from "@myoxus/core/components/structure-tree";
import { OrganizeService } from "@myoxus/core/modules/organize";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { useI18n } from "@myoxus/i18n";
import { AddOrganizeIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import track from "@myoxus/track";
import { Skeleton } from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { AddItemPlaceholder } from "../../layouts/add-item-placeholder";
import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeFolderNode } from "../../nodes/folder";
import { FolderCreateTip, FolderRenameDialog } from "../../nodes/folder/dialog";

export const StructureTreeOrganize = () => {
  const { organizeService, structureTreeStateService } = useServices({
    OrganizeService,
    StructureTreeStateService,
  });
  const path = useMemo(() => ["organize"], []);
  const [openNewFolderDialog, setOpenNewFolderDialog] = useState(false);

  const t = useI18n();

  const folderTree = organizeService.folderTree;
  const rootFolder = folderTree.rootFolder;

  const folders = useLiveData(rootFolder.sortedChildren$);
  const isLoading = useLiveData(folderTree.isLoading$);

  const handleCreateFolder = useCallback(
    (name: string) => {
      const newFolderId = rootFolder.createFolder(
        name,
        rootFolder.indexAt("before"),
      );
      track.$.navigationPanel.organize.createOrganizeItem({ type: "folder" });
      structureTreeStateService.setCollapsed(path, false);
      return newFolderId;
    },
    [structureTreeStateService, path, rootFolder],
  );

  return (
    <CollapsibleSection
      path={path}
      title={t["com.myoxus.rootAppSidebar.organize"]()}
    >
      {/* TODO(@CatsJuice): Organize loading UI */}
      <StructureTreeRoot placeholder={isLoading ? <Skeleton /> : null}>
        {folders.map((child) => (
          <StructureTreeFolderNode
            key={child.id}
            nodeId={child.id as string}
            parentPath={path}
          />
        ))}
        <AddItemPlaceholder
          icon={<AddOrganizeIcon />}
          data-testid="structure-tree-bar-add-organize-button"
          label={t["com.myoxus.rootAppSidebar.organize.add-folder"]()}
          onClick={() => setOpenNewFolderDialog(true)}
        />
      </StructureTreeRoot>
      <FolderRenameDialog
        open={openNewFolderDialog}
        onConfirm={handleCreateFolder}
        onOpenChange={setOpenNewFolderDialog}
        descRenderer={FolderCreateTip}
      />
    </CollapsibleSection>
  );
};
