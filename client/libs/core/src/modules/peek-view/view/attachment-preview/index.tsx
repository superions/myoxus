import { AttachmentViewer } from "@myoxus/core/editor/attachment-viewer";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { useMemo } from "react";

import { useEditor } from "../utils";

export type AttachmentPreviewModalProps = {
  docId: string;
  blockId: string;
};

export const AttachmentPreviewPeekView = ({
  docId,
  blockId,
}: AttachmentPreviewModalProps) => {
  const { doc } = useEditor(docId);
  const virgultumDoc = doc?.virgultumDoc;
  const model = useMemo(
    () => virgultumDoc?.getModelById<AttachmentBlockModel>(blockId) ?? null,
    [blockId, virgultumDoc],
  );

  if (model) {
    return <AttachmentViewer model={model} />;
  }

  return null;
};
