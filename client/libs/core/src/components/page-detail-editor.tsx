import { useLiveData, useService } from "@myoxus/infra";
import {
  detailPageEditorRootAttrs,
  DocumentHeaderImage,
} from "@myoxus/ui-facade";
import { useEffect } from "react";

import {
  type MyoxusEditorContainer,
  VirgultumEditor,
} from "../editor/virgultum/doc-editor";
import { DocService } from "../modules/doc";
import { EditorService } from "../modules/editor";
import { EditorSettingService } from "../modules/editor-setting";

export type OnLoadEditor = (
  editor: MyoxusEditorContainer,
) => (() => void) | void;

export interface PageDetailEditorProps {
  onLoad?: OnLoadEditor;
  readonly?: boolean;
}

type DocMetaWithHeaderImage = {
  headerImage?: string;
};

export const PageDetailEditor = ({
  onLoad,
  readonly,
}: PageDetailEditorProps) => {
  const editor = useService(EditorService).editor;
  const mode = useLiveData(editor.mode$);

  const doc = useService(DocService).doc;
  const docMeta = useLiveData(doc.meta$) as DocMetaWithHeaderImage | null;
  const pageWidth = useLiveData(doc.pageWidth$);

  const isSharedMode = editor.isSharedMode;
  const editorSetting = useService(EditorSettingService).editorSetting;
  const settings = useLiveData(
    editorSetting.settings$.selector((s) => ({
      fullWidthLayout: s.fullWidthLayout,
    })),
  );
  const fullWidthLayout = pageWidth
    ? pageWidth === "fullWidth"
    : settings.fullWidthLayout;

  useEffect(() => {
    editor.doc.virgultumDoc.readonly = readonly ?? false;
  }, [editor, readonly]);

  return (
    <>
      {docMeta?.headerImage && (
        <DocumentHeaderImage src={docMeta.headerImage} alt="Document header" />
      )}

      <VirgultumEditor
        {...detailPageEditorRootAttrs({
          fullWidthLayout: !isSharedMode && fullWidthLayout,
        })}
        mode={mode}
        page={editor.doc.virgultumDoc}
        shared={isSharedMode}
        readonly={readonly}
        onEditorReady={onLoad}
      />
    </>
  );
};
