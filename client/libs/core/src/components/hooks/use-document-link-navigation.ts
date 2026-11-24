// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { isNewTabTrigger } from "@myoxus/core/utils";
import { useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { nanoid } from "nanoid";
import type { DocLinkClickedEvent } from "@virgultum/editor/inlines/reference";
import type { DocEmbedProvider } from "@virgultum/core/services";
import { useCallback } from "react";

export function useDocumentLinkNavigation() {
  const workbench = useService(WorkbenchService).workbench;
  const { jumpToPageBlock } = useNavigateHelper();
  const peekView = useService(PeekViewService).peekView;

  return useCallback(
    (
      {
        pageId,
        workspaceId,
        params,
        event,
        openMode,
      }: Omit<DocLinkClickedEvent, "host">,
      currentWorkspaceId: string,
      inWorkspace: NonNullable<DocEmbedProvider["inWorkspace"]>,
    ) => {
      if (workspaceId !== undefined && workspaceId !== currentWorkspaceId) {
        const target = inWorkspace(workspaceId);
        if (!target) return;
        void target.access
          .canRead(pageId)
          .then((readable) => {
            if (readable)
              jumpToPageBlock(
                workspaceId,
                pageId,
                params?.mode,
                params?.blockIds,
                params?.elementIds,
              );
          })
          .catch(console.error)
          .finally(() => target.dispose());
        return;
      }
      openMode ??=
        event && isNewTabTrigger(event)
          ? "open-in-new-tab"
          : "open-in-active-view";

      if (openMode === "open-in-new-view") {
        track.doc.editor.toolbar.openInSplitView();
      } else if (openMode === "open-in-center-peek") {
        track.doc.editor.toolbar.openInPeekView();
      } else if (openMode === "open-in-new-tab") {
        track.doc.editor.toolbar.openInNewTab();
      }

      if (openMode !== "open-in-center-peek") {
        const at = (() => {
          if (openMode === "open-in-active-view") {
            return "active";
          }
          if (openMode === "open-in-new-view") {
            return BUILD_CONFIG.isElectron ? "tail" : "new-tab";
          }
          if (openMode === "open-in-new-tab") {
            return "new-tab";
          }
          return "active";
        })();
        workbench.openDoc(
          {
            docId: pageId,
            mode: params?.mode,
            blockIds: params?.blockIds,
            elementIds: params?.elementIds,
            refreshKey: nanoid(),
          },
          {
            at,
            show: true,
          },
        );
      } else {
        peekView
          .open({
            docRef: {
              docId: pageId,
            },
            ...params,
          })
          .catch(console.error);
      }
    },
    [jumpToPageBlock, peekView, workbench],
  );
}
