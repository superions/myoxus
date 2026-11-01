import { WorkbenchService } from "@myoxus/core/modules/workbench";
import type { FrameworkProvider } from "@myoxus/infra";
import { SidebarExtension } from "@virgultum/editor/shared/services";

import { isWorkbenchToolId } from "../../../modules/workbench/entities/tool-layout";

export function patchSideBarService(framework: FrameworkProvider) {
  const { workbench } = framework.get(WorkbenchService);

  return SidebarExtension({
    open: (tabId?: string) => {
      workbench.openContextPanel();
      if (tabId && isWorkbenchToolId(tabId)) {
        workbench.activeView$.value.showTool(tabId);
      }
    },
    close: () => {
      workbench.closeContextPanel();
    },
    getTabIds: () => {
      return workbench.activeView$.value.contextSurfaces$.value.map(
        (surface) => surface.id,
      );
    },
  });
}
