import { useLiveData, useService } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { type Doc, DocsService } from "../../doc";
import { type Editor, type EditorSelector, EditorsService } from "../../editor";
import { WorkspaceService } from "../../workspace";

export const useEditor = (
  pageId: string,
  preferMode?: DocMode,
  preferSelector?: EditorSelector,
  canLoad?: boolean,
) => {
  const currentWorkspace = useService(WorkspaceService).workspace;
  const docsService = useService(DocsService);
  const docRecordList = docsService.list;
  const [loading, setLoading] = useState(false);
  const docListReady = useLiveData(docRecordList.isReady$);
  // Server-created documents can enter the root Y.Doc after a peek has mounted.
  // Keep the record reactive so that the canonical DocsService.open() path binds
  // the new leaf document to CloudDocStorage as soon as its metadata arrives.
  const docRecord = useLiveData(docRecordList.doc$(pageId));
  const preferModeRef = useRef(preferMode);
  const preferSelectorRef = useRef(preferSelector);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (!docRecord) {
      // A reactive record can disappear after deletion or root revalidation.
      // Clear the previous leaf instead of retaining a stale editable preview.
      setDoc(null);
      setLoading(false);
      return;
    }
    let canceled = false;
    let release: () => void;
    setLoading(true);
    const loaded = docsService.loaded(pageId);
    if (loaded) {
      setDoc(loaded.doc);
      release = loaded.release;
      setLoading(false);
    } else if (canLoad) {
      requestIdleCallback(
        () => {
          if (canceled) {
            return;
          }
          const ref = docsService.open(pageId);
          if (!ref) {
            setLoading(false);
            return;
          }
          setDoc(ref.doc);
          release = ref.release;
          setLoading(false);
        },
        {
          timeout: 1000,
        },
      );
    }
    return () => {
      canceled = true;
      release?.();
      setLoading(false);
    };
  }, [canLoad, docRecord, docsService, pageId]);

  useLayoutEffect(() => {
    if (!doc) {
      return;
    }
    const editor = doc.scope.get(EditorsService).createEditor();
    editor.setMode(preferModeRef.current || doc.primaryMode$.value);
    editor.setSelector(preferSelectorRef.current);
    setEditor(editor);
    return () => {
      editor.dispose();
    };
  }, [doc]);

  // set sync engine priority target
  useEffect(() => {
    return currentWorkspace.engine.doc.addPriority(pageId, 10);
  }, [currentWorkspace, pageId]);

  return {
    doc,
    editor,
    workspace: currentWorkspace,
    loading: !docListReady || loading,
  };
};
