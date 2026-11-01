import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import type { FolderNode } from "@myoxus/core/modules/organize";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useServices } from "@myoxus/infra";
import { useCallback } from "react";

export const useCreatePageInFolder = () => {
  const { workspaceService, workbenchService } = useServices({
    WorkspaceService,
    WorkbenchService,
  });
  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  return useCallback(
    (folder: FolderNode) => {
      const page = createPage(undefined, { show: false });
      folder.createLink("doc", page.id, folder.indexAt("before"));
      workbenchService.workbench.openDoc(page.id);
      return page;
    },
    [createPage, workbenchService.workbench],
  );
};
