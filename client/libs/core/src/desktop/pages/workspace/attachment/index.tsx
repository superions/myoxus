/**
 * Attachment viewer page — renders a single attachment block in a full-page
 * viewer rather than inline within the document editor.
 *
 * ### Route
 * Matched by `/:workspaceId/:pageId/attachment/:attachmentId` in the router.
 * URL params are extracted by `Component` and passed down to `AttachmentPage`.
 *
 * ### Loading flow (`useLoadAttachment`)
 * 1. Opens the parent document with `DocsService.open`, which increments its
 *    reference count.
 * 2. Triggers a `virgultumDoc.load()` if the doc is not yet ready, and calls
 *    `doc.addPriorityLoad(10)` to ensure the sync layer prioritises this doc.
 * 3. Waits for `doc.waitForSyncReady()`, then locates the `AttachmentBlockModel`
 *    by `attachmentId`.
 * 4. On unmount the doc is released (`release()`) and the priority load is
 *    removed (`dispose()`), keeping ref-counts balanced.
 *
 * Uses `useLayoutEffect` (rather than `useEffect`) to start the load
 * synchronously before the browser paints, minimising the time the skeleton
 * is visible.
 *
 * ### Render states
 * - Loading  → `<Loading>` skeleton shimmer
 * - Loaded   → `<AttachmentViewerView>` wrapped in the doc's `FrameworkScope`
 * - Not found → `<WorkbenchRouteNotFound>` (doc/attachment missing)
 * - Bad route → `<WorkbenchRouteNotFound>` (params absent from URL)
 */
import { AttachmentViewerView } from "@myoxus/core/editor/attachment-viewer";
import { type Doc, DocsService } from "@myoxus/core/modules/doc";
import { useI18n } from "@myoxus/i18n";
import { AlertTriangleIcon } from "@myoxus/icons/react";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import { Button, DialogFooterActions } from "@myoxus/ui-facade";
import { type AttachmentBlockModel } from "@virgultum/editor/model";
import {
  type ReactElement,
  useCallback,
  useLayoutEffect,
  useState,
} from "react";
import { useParams } from "react-router";

import { ViewIcon, ViewTitle } from "../../../../modules/workbench";
import {
  WorkbenchRouteLoading,
  WorkbenchRouteNotFound,
  WorkbenchRouteStatus,
} from "../../404";

type AttachmentPageProps = {
  pageId: string;
  attachmentId: string;
};

const useLoadAttachment = (pageId: string, attachmentId: string) => {
  const [status, setStatus] = useState<
    "loading" | "ready" | "not-found" | "error"
  >("loading");
  const [attempt, setAttempt] = useState(0);
  const docsService = useService(DocsService);
  const docListReady = useLiveData(docsService.list.isReady$);
  const docRecord = useLiveData(docsService.list.doc$(pageId));
  const [doc, setDoc] = useState<Doc | null>(null);
  const [model, setModel] = useState<AttachmentBlockModel | null>(null);

  useLayoutEffect(() => {
    setStatus("loading");
    setDoc(null);
    setModel(null);

    if (!docListReady) {
      return;
    }
    if (!docRecord) {
      setStatus("not-found");
      return;
    }

    const ref = docsService.open(pageId);
    if (!ref) {
      setStatus("not-found");
      return;
    }
    const { doc, release } = ref;
    let disposed = false;

    setDoc(doc);

    if (!doc.virgultumDoc.ready) {
      doc.virgultumDoc.load();
    }
    const dispose = doc.addPriorityLoad(10);

    doc
      .waitForSyncReady()
      .then(() => {
        if (disposed) return;
        const model =
          doc.virgultumDoc.getModelById<AttachmentBlockModel>(attachmentId);
        setModel(model);
        setStatus(model ? "ready" : "not-found");
      })
      .catch(() => {
        if (!disposed) setStatus("error");
      });

    return () => {
      disposed = true;
      release();
      dispose();
    };
  }, [attempt, attachmentId, docListReady, docRecord, docsService, pageId]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { doc, model, retry, status };
};

export const AttachmentPage = ({
  pageId,
  attachmentId,
}: AttachmentPageProps): ReactElement => {
  const t = useI18n();
  const { doc, model, retry, status } = useLoadAttachment(pageId, attachmentId);

  if (status === "loading") {
    return <WorkbenchRouteLoading />;
  }

  if (status === "ready" && doc && model) {
    return (
      <FrameworkScope scope={doc.scope}>
        <ViewTitle title={model.props.name} />
        <ViewIcon
          icon={model.props.type.endsWith("pdf") ? "pdf" : "attachment"}
        />
        <AttachmentViewerView model={model} />
      </FrameworkScope>
    );
  }

  if (status === "error") {
    return (
      <WorkbenchRouteStatus
        title={t["com.myoxus.workbench.route.error.title"]()}
        description={t["com.myoxus.workbench.route.error.description"]()}
        icon={<AlertTriangleIcon />}
        viewIcon="attachment"
        status="error"
        actions={
          <DialogFooterActions>
            <Button onClick={retry}>{t["Retry"]()}</Button>
          </DialogFooterActions>
        }
      />
    );
  }

  return <WorkbenchRouteNotFound />;
};

export const Component = () => {
  const { pageId, attachmentId } = useParams();

  if (pageId && attachmentId) {
    return <AttachmentPage pageId={pageId} attachmentId={attachmentId} />;
  }

  return <WorkbenchRouteNotFound />;
};
