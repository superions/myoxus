// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { AttachmentViewerView } from "@myoxus/core/editor/attachment-viewer";
import { type Doc, DocsService } from "@myoxus/core/modules/doc";
import { useI18n } from "@myoxus/i18n";
import { AlertTriangleIcon } from "@myoxus/icons/react";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import { Button, DialogFooterActions } from "@myoxus/ui-facade";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
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

type AttachmentLoadStatus = "loading" | "ready" | "not-found" | "error";

function useLoadAttachment(pageId: string, attachmentId: string) {
  const [status, setStatus] = useState<AttachmentLoadStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [model, setModel] = useState<AttachmentBlockModel | null>(null);

  const docsService = useService(DocsService);
  const docListReady = useLiveData(docsService.list.isReady$);
  const docRecord = useLiveData(docsService.list.doc$(pageId));

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

    const opened = docsService.open(pageId);
    if (!opened) {
      setStatus("not-found");
      return;
    }

    const { doc: loadedDoc, release } = opened;
    let disposed = false;
    setDoc(loadedDoc);

    if (!loadedDoc.virgultumDoc.ready) {
      loadedDoc.virgultumDoc.load();
    }
    const disposePriority = loadedDoc.addPriorityLoad(10);

    loadedDoc
      .waitForSyncReady()
      .then(() => {
        if (disposed) {
          return;
        }
        const block =
          loadedDoc.virgultumDoc.getModelById<AttachmentBlockModel>(
            attachmentId,
          );
        setModel(block);
        setStatus(block ? "ready" : "not-found");
      })
      .catch(() => {
        if (!disposed) {
          setStatus("error");
        }
      });

    return () => {
      disposed = true;
      release();
      disposePriority();
    };
  }, [attempt, attachmentId, docListReady, docRecord, docsService, pageId]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { doc, model, retry, status };
}

export function AttachmentPage({
  pageId,
  attachmentId,
}: {
  pageId: string;
  attachmentId: string;
}): ReactElement {
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
}

export function Component() {
  const { pageId, attachmentId } = useParams();
  if (!pageId || !attachmentId) {
    return <WorkbenchRouteNotFound />;
  }
  return <AttachmentPage pageId={pageId} attachmentId={attachmentId} />;
}
