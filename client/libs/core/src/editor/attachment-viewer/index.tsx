import {
  ViewBody,
  ViewHeader,
} from "@myoxus/core/modules/workbench/view/view-islands";
import { AttachmentViewerContainer } from "@myoxus/ui-facade";

import { AttachmentFallback, AttachmentPreviewErrorBoundary } from "./error";
import { PDFViewer } from "./pdf/pdf-viewer";
import type { AttachmentViewerBaseProps, AttachmentViewerProps } from "./types";
import { buildAttachmentProps } from "./utils";
import { AttachmentWorkbenchHeader, Titlebar } from "./viewer";

// Peek view
export const AttachmentViewer = ({ model }: AttachmentViewerProps) => {
  const props = buildAttachmentProps(model);

  return (
    <AttachmentViewerContainer>
      <Titlebar {...props} />
      <AttachmentViewerInner {...props} />
    </AttachmentViewerContainer>
  );
};

// Split view or standalone page
export const AttachmentViewerView = ({ model }: AttachmentViewerProps) => {
  const props = buildAttachmentProps(model);

  return (
    <>
      <ViewHeader>
        <AttachmentWorkbenchHeader {...props} />
      </ViewHeader>
      <ViewBody>
        <AttachmentViewerInner {...props} />
      </ViewBody>
    </>
  );
};

const AttachmentViewerInner = (props: AttachmentViewerBaseProps) => {
  const isPDF = props.model.props.type.endsWith("pdf");

  if (isPDF) {
    return (
      <AttachmentPreviewErrorBoundary>
        <PDFViewer {...props} />
      </AttachmentPreviewErrorBoundary>
    );
  }

  return <AttachmentFallback {...props} />;
};
