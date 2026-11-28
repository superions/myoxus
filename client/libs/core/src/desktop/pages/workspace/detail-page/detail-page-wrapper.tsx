// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard";
import { PageRegistrationRecovery } from "@myoxus/core/components/page-registration-recovery";
import { type Doc, DocsService } from "@myoxus/core/modules/doc";
import { type Editor, EditorsService } from "@myoxus/core/modules/editor";
import { ViewBody, ViewTitle } from "@myoxus/core/modules/workbench";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import type { PageRegistrationState } from "@myoxus/storage";
import { Stack } from "@myoxus/ui-facade";
import {
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";

function useLoadDocument(pageId: string) {
  const workspace = useService(WorkspaceService).workspace;
  const docsService = useService(DocsService);
  const viewService = useService(ViewService);

  const docListReady = useLiveData(docsService.list.isReady$);
  const docRecord = useLiveData(docsService.list.doc$(pageId));

  const [doc, setDoc] = useState<Doc | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [docContentMissing, setDocContentMissing] = useState(false);
  const [pageRegistration, setPageRegistration] = useState<
    PageRegistrationState | null | undefined
  >();

  useEffect(() => {
    const subscription = workspace.engine.doc
      .docState$(pageId)
      .subscribe((state) => setPageRegistration(state.pageRegistration));
    return () => subscription.unsubscribe();
  }, [pageId, workspace]);

  useLayoutEffect(() => {
    setDocContentMissing(false);
    if (!docRecord) {
      setDoc(null);
      setEditor(null);
      return;
    }
    const opened = docsService.open(pageId);
    if (!opened) {
      return;
    }
    const { doc: loadedDoc, release } = opened;
    setDoc(loadedDoc);
    const createdEditor = loadedDoc.scope.get(EditorsService).createEditor();
    const unbind = createdEditor.bindWorkbenchView(viewService.view);
    setEditor(createdEditor);

    return () => {
      unbind();
      createdEditor.dispose();
      release();
    };
  }, [docRecord, docsService, pageId, viewService.view]);

  useEffect(() => {
    if (!docRecord) {
      return;
    }
    return workspace.engine.doc.addPriority(pageId, 10);
  }, [docRecord, pageId, workspace]);

  const isInTrash = useLiveData(doc?.meta$.map((meta) => meta.trash));
  useEffect(() => {
    if (doc && isInTrash) {
      doc.virgultumDoc.readonly = true;
    }
  }, [doc, isInTrash]);

  useEffect(() => {
    if (!doc || doc.virgultumDoc.root) {
      setDocContentMissing(false);
      return;
    }

    // Classify a rootless document as missing only after DocFrontend has
    // finished loading with no pending apply/save job AND the server reported
    // absence; `state.ready` lags `synced` while local apply jobs settle.
    const subscription = workspace.engine.doc
      .docState$(pageId)
      .subscribe((state) => {
        if (doc.virgultumDoc.root || state.ready) {
          setDocContentMissing(false);
          return;
        }
        if (state.loaded && !state.updating && state.remoteMissing) {
          setDocContentMissing(true);
        }
      });
    return () => subscription.unsubscribe();
  }, [doc, pageId, workspace]);

  return {
    doc,
    editor,
    docListReady,
    docContentMissing,
    pageRegistration,
  };
}

function DetailPagePermissionGate({
  pageId,
  children,
  skeleton,
  notFound,
}: PropsWithChildren<{
  pageId: string;
  skeleton: ReactNode;
  notFound: ReactNode;
}>) {
  const canAccess = useGuard("Doc_Read", pageId);
  if (canAccess === undefined) {
    return skeleton;
  }
  if (!canAccess) {
    return notFound;
  }
  return children;
}

export function DetailPageWrapper({
  pageId,
  children,
  skeleton,
  notFound,
}: PropsWithChildren<{
  pageId: string;
  skeleton: ReactNode;
  notFound: ReactNode;
}>) {
  const t = useI18n();
  const { doc, editor, docListReady, docContentMissing, pageRegistration } =
    useLoadDocument(pageId);

  if (
    pageRegistration === "unresolved" ||
    (pageRegistration === "legacy" && !doc)
  ) {
    return (
      <>
        <ViewTitle title={t["com.myoxus.doc.recovery.title"]()} />
        <ViewBody>
          <Stack>
            <PageRegistrationRecovery docId={pageId} />
          </Stack>
        </ViewBody>
      </>
    );
  }
  if (pageRegistration === "pending") {
    return skeleton;
  }
  if (pageRegistration === "deleted") {
    return notFound;
  }
  if (docListReady && (!doc || docContentMissing)) {
    return notFound;
  }
  if (!doc || !editor) {
    return skeleton;
  }

  return (
    <DetailPagePermissionGate
      pageId={pageId}
      skeleton={skeleton}
      notFound={notFound}
    >
      <FrameworkScope scope={doc.scope}>
        <FrameworkScope scope={editor.scope}>{children}</FrameworkScope>
      </FrameworkScope>
    </DetailPagePermissionGate>
  );
}
