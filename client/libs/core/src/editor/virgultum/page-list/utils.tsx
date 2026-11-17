import { DocsService } from "@myoxus/core/modules/doc";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useServices } from "@myoxus/infra";
import { type DocMode } from "@virgultum/editor/model";
import type { Workspace } from "@virgultum/editor/store";
import { useCallback, useMemo } from "react";

export const usePageHelper = (_docCollection: Workspace) => {
  const { docsService, workbenchService } = useServices({
    DocsService,
    WorkbenchService,
  });
  const workbench = workbenchService.workbench;

  const createPageAndOpen = useCallback(
    (
      mode?: DocMode,
      options: {
        at?: "new-tab" | "tail" | "active";
        show?: boolean;
      } = {
        at: "active",
        show: true,
      },
    ) => {
      const page = docsService.createDoc({ primaryMode: mode });

      if (options.show !== false) {
        workbench.openDoc(mode ? { docId: page.id, mode } : page.id, {
          at: options.at,
          show: options.show,
        });
      }
      return page;
    },
    [docsService, workbench],
  );

  const createEdgelessAndOpen = useCallback(
    (
      options: {
        at?: "new-tab" | "tail" | "active";
        show?: boolean;
      } = {
        at: "active",
        show: true,
      },
    ) => {
      return createPageAndOpen("edgeless", options);
    },
    [createPageAndOpen],
  );

  return useMemo(() => {
    return {
      createPage: (
        mode?: DocMode,
        options?: {
          at?: "new-tab" | "tail" | "active";
          show?: boolean;
        },
      ) => createPageAndOpen(mode, options),
      createEdgeless: createEdgelessAndOpen,
    };
  }, [createEdgelessAndOpen, createPageAndOpen]);
};
