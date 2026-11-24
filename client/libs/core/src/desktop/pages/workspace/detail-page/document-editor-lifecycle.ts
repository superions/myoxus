import { useDocumentLinkNavigation } from "@myoxus/core/components/hooks/use-document-link-navigation";
import { DocEmbedProvider } from "@virgultum/editor/shared/services";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import type { Editor } from "@myoxus/core/modules/editor";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { focusBlockEnd } from "@virgultum/editor/shared/commands";
import { getLastNoteBlock } from "@virgultum/editor/shared/utils";
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
  const navigate = useDocumentLinkNavigation();

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
          refNodeSlots.docLinkClicked.subscribe((event) => {
            if (event.host !== editorContainer.host) return;
            navigate(event, std.workspace.id, (id) =>
              std.getOptional(DocEmbedProvider)?.inWorkspace?.(id),
            );
          }),
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
    [editor, isJournal, navigate, scrollViewportRef],
  );
}
