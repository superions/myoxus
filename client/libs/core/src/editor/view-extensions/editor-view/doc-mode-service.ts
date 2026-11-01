import type { DocService, DocsService } from "@myoxus/core/modules/doc";
import type { EditorService } from "@myoxus/core/modules/editor";
import type { DocMode } from "@virgultum/editor/model";
import {
  DocModeExtension,
  type DocModeProvider,
} from "@virgultum/editor/shared/services";
import type { ExtensionType } from "@virgultum/editor/store";

export function patchDocModeService(
  docService: DocService,
  docsService: DocsService,
  editorService: EditorService,
): ExtensionType {
  const DEFAULT_MODE = "page";
  class MyoxusDocModeService implements DocModeProvider {
    setEditorMode = (mode: DocMode) => {
      editorService.editor.setMode(mode);
    };
    getEditorMode = () => {
      return editorService.editor.mode$.value;
    };
    setPrimaryMode = (mode: DocMode, id?: string) => {
      if (id) {
        docsService.list.setPrimaryMode(id, mode);
      } else {
        docService.doc.setPrimaryMode(mode);
      }
    };
    getPrimaryMode = (id?: string) => {
      const mode = id
        ? docsService.list.getPrimaryMode(id)
        : docService.doc.getPrimaryMode();
      return (mode || DEFAULT_MODE) as DocMode;
    };
    togglePrimaryMode = (id?: string) => {
      const mode = id
        ? docsService.list.togglePrimaryMode(id)
        : docService.doc.togglePrimaryMode();
      return (mode || DEFAULT_MODE) as DocMode;
    };
    onPrimaryModeChange = (handler: (mode: DocMode) => void, id?: string) => {
      const mode$ = id
        ? docsService.list.primaryMode$(id)
        : docService.doc.primaryMode$;
      const sub = mode$.subscribe((m) =>
        handler((m || DEFAULT_MODE) as DocMode),
      );
      return sub;
    };
  }

  const docModeExtension = DocModeExtension(new MyoxusDocModeService());

  return docModeExtension;
}
