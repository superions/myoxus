// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard";
import { useRegisterVirgultumEditorCommands } from "@myoxus/core/components/hooks/myoxus/use-register-virgultum-editor-commands";
import { useDocumentViewContext } from "@myoxus/core/components/hooks/use-document-view-context";
import { NavigateContext } from "@myoxus/core/components/hooks/use-navigate-helper";
import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import { PageDetailEditor } from "@myoxus/core/components/page-detail-editor";
import { TrashPageFooter } from "@myoxus/core/components/pure/trash-page-footer";
import { TopTip } from "@myoxus/core/components/top-tip";
import { DocumentActivePeopleTool } from "@myoxus/core/modules/content-presence/document-active-people-tool";
import { DocService, DocsService } from "@myoxus/core/modules/doc";
import {
  HistoryNavigationProvider,
  useHistoryNavigation,
} from "@myoxus/core/modules/doc-versioning/history-navigation";
import { EditorService } from "@myoxus/core/modules/editor";
import { JournalService } from "@myoxus/core/modules/journal";
import { RecentWorkspaceItemsService } from "@myoxus/core/modules/quicksearch";
import {
  useIsActiveView,
  useWorkbenchSurfaceScrollViewport,
  ViewBody,
  ViewHeader,
  WorkbenchToolLayoutBinding,
} from "@myoxus/core/modules/workbench";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkspaceContentOperationService } from "@myoxus/core/modules/workspace-content-operation";
import { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import {
  DetailPageEditorFrame,
  DetailPageEditorViewport,
  DetailPageMainFrame,
} from "@myoxus/ui-facade";
import { lazy, Suspense, useContext, useEffect, useState } from "react";
import { useParams } from "react-router";

import {
  WorkbenchRouteAccessDenied,
  WorkbenchRouteLoading,
  WorkbenchRouteNotFound,
} from "../../404";
import { DetailPageHeader } from "./detail-page-header";
import { DetailPageWrapper } from "./detail-page-wrapper";
import { useDocumentEditorLifecycle } from "./document-editor-lifecycle";
import { AiChatSidecard } from "./sidecards/ai-chat/sidecard";
import { AnalyticsSidecard } from "./sidecards/analytics/sidecard";
import { CalendarSidecards } from "./sidecards/calendar-sidecards";
import { CommentsSidecard } from "./sidecards/comments/sidecard";
import { DocumentSidecards } from "./sidecards/document-sidecards";
import { FramesSidecard } from "./sidecards/frames/sidecard";
import { JournalConflictBlock } from "./sidecards/journal";

const HistoryView = lazy(async () => ({
  default: (await import("./history-view")).HistoryView,
}));

function DocumentRouteFailure({ pageId }: { pageId: string }) {
  const docsService = useService(DocsService);
  const docRecord = useLiveData(docsService.list.doc$(pageId));
  const canAccess = useGuard("Doc_Read", pageId);
  const workspace = useService(WorkspaceService).workspace;
  const operations = useService(WorkspaceContentOperationService);
  const location = useLiveData(useService(ViewService).view.location$);
  const navigate = useContext(NavigateContext);
  const [resolving, setResolving] = useState(
    !docRecord && workspace.flavour !== "local",
  );

  useEffect(() => {
    // Live or denied local records take precedence over moved-document redirects.
    if (docRecord || workspace.flavour === "local" || !navigate) {
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    void operations
      .resolveRedirect({
        workspaceId: workspace.id,
        resource: {
          kind: WorkspaceContentResourceKindType.Document,
          id: pageId,
        },
      })
      .then(
        (target) => {
          if (cancelled) {
            return;
          }
          if (
            target &&
            (target.workspaceId !== workspace.id || target.id !== pageId)
          ) {
            void navigate(
              `/workspace/${target.workspaceId}/${target.id}${location.search}${location.hash}`,
              { replace: true },
            );
          }
          setResolving(false);
        },
        () => {
          if (!cancelled) {
            setResolving(false);
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    docRecord,
    location.hash,
    location.search,
    navigate,
    operations,
    pageId,
    workspace,
  ]);

  if (resolving && !docRecord) {
    return <WorkbenchRouteLoading />;
  }
  return docRecord && canAccess === false ? (
    <WorkbenchRouteAccessDenied />
  ) : (
    <WorkbenchRouteNotFound />
  );
}

function DocumentEditorView() {
  const {
    editorService,
    docService,
    workspaceService,
    recentWorkspaceItemsService,
  } = useServices({
    EditorService,
    DocService,
    WorkspaceService,
    RecentWorkspaceItemsService,
  });
  const journalService = useService(JournalService);
  const t = useI18n();

  const editor = editorService.editor;
  const workspace = workspaceService.workspace;
  const doc = docService.doc;

  const mode = useLiveData(editor.mode$);
  const isInTrash = useLiveData(doc.meta$.map((meta) => meta.trash));
  const editorContainer = useLiveData(editor.editorContainer$);
  const journalDate = useLiveData(journalService.journalDate$(doc.id));
  const isJournal = Boolean(journalDate);

  const scrollViewportRef = useWorkbenchSurfaceScrollViewport();
  const isActiveView = useIsActiveView();
  const canEdit = useGuard("Doc_Update", doc.id);
  const readonly = !canEdit || isInTrash;

  useEffect(() => {
    if (!isInTrash) {
      recentWorkspaceItemsService.addRecentDoc(doc.id);
    }
  }, [doc.id, isInTrash, recentWorkspaceItemsService]);

  useDocumentViewContext({
    active: isActiveView,
    docId: doc.id,
    editorContainer,
    isInTrash,
    mode,
  });
  useRegisterVirgultumEditorCommands(editor, isActiveView);

  const onLoad = useDocumentEditorLifecycle({
    editor,
    isJournal,
    scrollViewportRef,
  });

  const [hasScrollTop, setHasScrollTop] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }
    const syncScrollTop = () => setHasScrollTop(viewport.scrollTop > 0);
    syncScrollTop();
    viewport.addEventListener("scroll", syncScrollTop, { passive: true });
    return () => viewport.removeEventListener("scroll", syncScrollTop);
  }, [scrollViewportRef]);

  return (
    <>
      <WorkbenchToolLayoutBinding
        workspaceId={workspace.id}
        viewFamily={
          isJournal
            ? "journal"
            : mode === "page"
              ? "document-page"
              : "document-edgeless"
        }
      />
      <ViewHeader>
        <DetailPageHeader
          page={doc.virgultumDoc}
          workspace={workspace}
          onDragging={setDragging}
        />
      </ViewHeader>
      <ViewBody>
        <DetailPageMainFrame
          dynamicTopBorder={BUILD_CONFIG.isElectron}
          editorMode={mode}
          hasScrollTop={hasScrollTop}
        >
          {isJournal && journalDate ? (
            <JournalConflictBlock date={journalDate} />
          ) : null}
          <MyoxusErrorBoundary key={doc.id}>
            <TopTip pageId={doc.id} workspace={workspace} />
            <DetailPageEditorFrame editorMode={mode}>
              <DetailPageEditorViewport
                dragging={dragging}
                editorMode={mode}
                pageModeContentBox={mode === "page"}
              >
                <PageDetailEditor onLoad={onLoad} readonly={readonly} />
              </DetailPageEditorViewport>
            </DetailPageEditorFrame>
          </MyoxusErrorBoundary>
          {isInTrash ? <TrashPageFooter /> : null}
        </DetailPageMainFrame>
      </ViewBody>

      <DocumentActivePeopleTool
        key={doc.id}
        awareness={doc.virgultumDoc.awarenessStore.awareness}
      />
      <AiChatSidecard editor={editorContainer} />
      {!isJournal ? (
        <DocumentSidecards
          docId={doc.id}
          docTitle={doc.virgultumDoc.meta?.title ?? t["Untitled"]()}
          editor={editorContainer?.host ?? null}
          mode={mode}
          readonly={Boolean(readonly)}
          workspaceId={workspace.id}
        />
      ) : null}
      <CalendarSidecards
        includeJournalActivity={isJournal}
        readonly={Boolean(readonly)}
      />
      <FramesSidecard
        editor={editorContainer?.host ?? null}
        isJournal={isJournal}
        mode={mode}
      />
      <CommentsSidecard workspaceFlavour={workspace.flavour} />
      <AnalyticsSidecard
        docId={doc.id}
        workspaceFlavour={workspace.flavour}
        workspaceId={workspace.id}
      />
    </>
  );
}

// Keep the live Doc/Editor scope mounted while toggling between the editable
// document view and URL-addressed readonly HistoryView.
function DocumentDetailContent() {
  const navigation = useHistoryNavigation();
  return navigation.state.open ? (
    <Suspense fallback={<WorkbenchRouteLoading />}>
      <HistoryView />
    </Suspense>
  ) : (
    <DocumentEditorView />
  );
}

function DocumentDetailView() {
  const doc = useService(DocService).doc;
  const workspace = useService(WorkspaceService).workspace;
  const view = useService(ViewService).view;

  return (
    <HistoryNavigationProvider key={`${workspace.id}:${doc.id}:${view.id}`}>
      <DocumentDetailContent />
    </HistoryNavigationProvider>
  );
}

export function Component() {
  const { pageId } = useParams();
  if (!pageId) {
    return null;
  }
  return (
    <DetailPageWrapper
      pageId={pageId}
      skeleton={<WorkbenchRouteLoading />}
      notFound={<DocumentRouteFailure pageId={pageId} />}
    >
      <DocumentDetailView />
    </DetailPageWrapper>
  );
}
