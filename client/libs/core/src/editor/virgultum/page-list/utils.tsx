import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { DocsService } from "@myoxus/core/modules/doc";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { useServices } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { type DocMode } from "@virgultum/editor/model";
import type { Workspace } from "@virgultum/editor/store";
import { useCallback, useMemo } from "react";

export const usePageHelper = (docCollection: Workspace) => {
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

  const importFileAndOpen = useMemo(
    () => async () => {
      const { showImportModal } =
        await import("@virgultum/editor/widgets/linked-doc");
      const { promise, resolve, reject } =
        Promise.withResolvers<
          Parameters<
            NonNullable<Parameters<typeof showImportModal>[0]["onSuccess"]>
          >[1]
        >();
      const onSuccess = (
        pageIds: string[],
        options: { isWorkspaceFile: boolean; importedCount: number },
      ) => {
        resolve(options);
        notify({
          title: `Successfully imported ${options.importedCount} Page${
            options.importedCount > 1 ? "s" : ""
          }.`,
        });
        if (options.isWorkspaceFile) {
          workbench.openAll();
          return;
        }

        if (pageIds.length === 0) {
          return;
        }
        const pageId = pageIds[0];
        workbench.openDoc(pageId);
      };
      showImportModal({
        collection: docCollection,
        schema: getMyoxusWorkspaceSchema(),
        extensions: getStoreManager().config.init().value.get("store"),
        onSuccess,
        onFail: (message) => {
          reject(new Error(message));
        },
      });
      return await promise;
    },
    [docCollection, workbench],
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
      importFile: importFileAndOpen,
    };
  }, [createEdgelessAndOpen, createPageAndOpen, importFileAndOpen]);
};
