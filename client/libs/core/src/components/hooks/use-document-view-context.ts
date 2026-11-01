import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { useService } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";
import { useEffect } from "react";

import { useActiveVirgultumEditor } from "./use-virgultum-editor";

/**
 * Projects the active document view into the shared editor and command
 * contexts. Desktop Workbench views opt in only while active; Mobile owns one
 * document view at a time and therefore remains active for its full lifetime.
 */
export function useDocumentViewContext({
  active,
  docId,
  editorContainer,
  isInTrash,
  mode,
}: {
  active: boolean;
  docId: string;
  editorContainer: MyoxusEditorContainer | null;
  isInTrash: boolean | undefined;
  mode: DocMode;
}) {
  const globalContext = useService(GlobalContextService).globalContext;
  const [, setActiveVirgultumEditor] = useActiveVirgultumEditor();

  useEffect(() => {
    if (active) {
      setActiveVirgultumEditor(editorContainer);
      return () => {
        // A departing view must not clear an editor claimed by its successor.
        setActiveVirgultumEditor((current) =>
          current === editorContainer ? null : current,
        );
      };
    }
    return undefined;
  }, [active, editorContainer, setActiveVirgultumEditor]);

  useEffect(() => {
    if (!active) {
      return;
    }

    globalContext.docId.set(docId);
    globalContext.docMode.set(mode);
    globalContext.isDoc.set(true);
    globalContext.isTrashDoc.set(Boolean(isInTrash));

    return () => {
      globalContext.docId.set(null);
      globalContext.docMode.set(null);
      globalContext.isDoc.set(false);
      globalContext.isTrashDoc.set(null);
    };
  }, [active, docId, globalContext, isInTrash, mode]);
}
