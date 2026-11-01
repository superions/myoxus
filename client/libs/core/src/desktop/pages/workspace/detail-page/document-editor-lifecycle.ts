import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { DocEmbedProvider } from "@virgultum/editor/shared/services";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import type { Editor } from "@myoxus/core/modules/editor";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { isNewTabTrigger } from "@myoxus/core/utils";
import { useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { focusBlockEnd } from "@virgultum/editor/shared/commands";
import { getLastNoteBlock } from "@virgultum/editor/shared/utils";
import { nanoid } from "nanoid";
import { type RefObject, useCallback } from "react";

/**
 * Owns the editor-container binding and the editor-host interactions that live
 * for exactly one mounted document editor.
 */
export function useDocumentEditorLifecycle({
  editor,
  isJournal,
  scrollViewportRef,
}: {
  editor: Editor;
  isJournal: boolean;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
}) {
  const workbench = useService(WorkbenchService).workbench;
  const { jumpToPageBlock } = useNavigateHelper();
  const peekView = useService(PeekViewService).peekView;

  return useCallback(
    (editorContainer: MyoxusEditorContainer) => {
      const std = editorContainer.std;
      const disposable = new DisposableGroup();

      if (isJournal) {
        const rafId = requestAnimationFrame(() => {
          try {
            if (!editorContainer.isConnected) return;
            const note = getLastNoteBlock(editorContainer.page);
            if (note) {
              const lastBlock = note.lastChild();
              if (lastBlock) {
                const focusBlock = std.view.getBlock(lastBlock.id) ?? undefined;
                std.command.exec(focusBlockEnd, { focusBlock, force: true });
                return;
              }
            }
            std.command.exec(focusBlockEnd, { force: true });
          } catch (error) {
            console.error("Failed to focus journal body", error);
          }
        });
        disposable.add(() => cancelAnimationFrame(rafId));
      }

      const refNodeSlots = std.getOptional(RefNodeSlotsProvider);
      if (refNodeSlots) {
        disposable.add(
          refNodeSlots.docLinkClicked.subscribe(
            ({ pageId, workspaceId, params, openMode, event, host }) => {
              if (host !== editorContainer.host) {
                return;
              }
              if (
                workspaceId !== undefined &&
                workspaceId !== std.workspace.id
              ) {
                const target = std
                  .getOptional(DocEmbedProvider)
                  ?.inWorkspace?.(workspaceId);
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
          ),
        );
      }

      const unbind = editor.bindEditorContainer(
        editorContainer,
        editorContainer.docTitle,
        scrollViewportRef.current,
      );

      return () => {
        unbind();
        disposable.dispose();
      };
    },
    [
      editor,
      isJournal,
      jumpToPageBlock,
      peekView,
      scrollViewportRef,
      workbench,
    ],
  );
}
