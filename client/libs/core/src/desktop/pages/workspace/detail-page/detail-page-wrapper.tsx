/**
 * DetailPageWrapper — loading and scope setup layer for document detail views.
 *
 * Shared between the desktop and mobile detail page components. Handles:
 * - Loading the doc record from `DocsService`.
 * - Waiting for the doc list to be ready before showing a "not found" state.
 * - Creating an `Editor` instance bound to the current workbench `View`.
 * - Elevating the sync engine priority for the active page so it loads faster.
 * - Setting the doc to read-only when it is in trash.
 * - Wrapping children in the correct `FrameworkScope` chain so that
 *   `DocService` and `EditorService` resolve to the right instances.
 *
 * Registration recovery and unavailable states are handled here before the
 * desktop or mobile document view is exposed.
 */
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

/**
 * Hook that opens a document and creates an editor instance for the given page.
 *
 * Uses `useLayoutEffect` to open the doc synchronously before paint, ensuring
 * the editor is ready when children first render. Cleans up (releases the doc
 * and disposes the editor) when the `pageId` changes or the component unmounts.
 *
 * @param pageId - The document identifier to load.
 * @returns `doc` — the loaded `Doc` instance (null while loading),
 *          `editor` — the created `Editor` (null while loading),
 *          `docListReady` — whether the workspace doc list has been synced,
 *          `docContentMissing` — whether a stale metadata entry points to a
 *          synced document without editor root content.
 */
const useLoadDoc = (pageId: string) => {
  const currentWorkspace = useService(WorkspaceService).workspace;
  const docsService = useService(DocsService);
  const docRecordList = docsService.list;
  const docListReady = useLiveData(docRecordList.isReady$);
  const docRecord = useLiveData(docRecordList.doc$(pageId));
  const viewService = useService(ViewService);

  const [doc, setDoc] = useState<Doc | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [docContentMissing, setDocContentMissing] = useState(false);
  const [pageRegistration, setPageRegistration] =
    useState<PageRegistrationState | null>();
  useEffect(() => {
    const subscription = currentWorkspace.engine.doc
      .docState$(pageId)
      .subscribe((state) => setPageRegistration(state.pageRegistration));
    return () => subscription.unsubscribe();
  }, [currentWorkspace, pageId]);

  useLayoutEffect(() => {
    setDocContentMissing(false);
    if (!docRecord) {
      setDoc(null);
      setEditor(null);
      return;
    }
    const ref = docsService.open(pageId);
    if (!ref) return;
    const { doc, release } = ref;
    setDoc(doc);
    const editor = doc.scope.get(EditorsService).createEditor();
    const unbind = editor.bindWorkbenchView(viewService.view);
    setEditor(editor);
    return () => {
      unbind();
      editor.dispose();
      release();
    };
  }, [docRecord, docsService, pageId, viewService.view]);

  // set sync engine priority target
  useEffect(() => {
    if (!docRecord) {
      return;
    }

    return currentWorkspace.engine.doc.addPriority(pageId, 10);
  }, [currentWorkspace, docRecord, pageId]);

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

    // The remote peer can acknowledge its reconciliation before DocFrontend
    // has loaded the resulting local record into this Y.Doc. Classifying the
    // rootless interval from waitForSynced() alone therefore turns a valid
    // cross-client create into a permanent 404. The combined state is terminal
    // only after the frontend load completed and either the server explicitly
    // reported absence or the loaded payload remained empty.
    //
    // `state.ready` is the authoritative signal that the YDoc has been
    // populated: any window between `synced=true` and `ready=true` is a
    // legitimate pending apply-job, not an empty document, so it must NOT be
    // treated as content-missing.
    const subscription = currentWorkspace.engine.doc
      .docState$(pageId)
      .subscribe((state) => {
        if (doc.virgultumDoc.root || state.ready) {
          setDocContentMissing(false);
          return;
        }
        // Only after the load completed AND no apply/save job is queued AND
        // the server explicitly reported absence does the document become a
        // real 404. `!state.ready` alone is not enough — the ready flag is
        // gated by DocFrontend.apply and lags `synced` by one tick.
        if (state.loaded && !state.updating && state.remoteMissing) {
          setDocContentMissing(true);
        }
      });

    return () => {
      subscription.unsubscribe();
    };
  }, [currentWorkspace, doc, pageId]);

  return {
    doc,
    editor,
    docListReady,
    docContentMissing,
    pageRegistration,
  };
};

/**
 * A common wrapper for detail page for both mobile and desktop page.
 * It only contains the logic for page loading, context setup, but not the page content.
 */
export const DetailPageWrapper = ({
  pageId,
  children,
  skeleton,
  notFound,
}: PropsWithChildren<{
  pageId: string;
  skeleton: ReactNode;
  notFound: ReactNode;
}>) => {
  const t = useI18n();
  const { doc, editor, docListReady, docContentMissing, pageRegistration } =
    useLoadDoc(pageId);
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
  if (pageRegistration === "pending") return skeleton;
  if (pageRegistration === "deleted") return notFound;
  // if sync engine has been synced and the page is null, show 404 page.
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
};

const DetailPagePermissionGate = ({
  pageId,
  children,
  skeleton,
  notFound,
}: PropsWithChildren<{
  pageId: string;
  skeleton: ReactNode;
  notFound: ReactNode;
}>) => {
  const canAccess = useGuard("Doc_Read", pageId);

  if (canAccess === undefined) {
    return skeleton;
  }
  if (!canAccess) {
    return notFound;
  }

  return children;
};
