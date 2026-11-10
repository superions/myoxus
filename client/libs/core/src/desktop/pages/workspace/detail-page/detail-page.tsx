/**
 * The document route retains its live Doc/Editor scope while switching between
 * the editable document and readonly URL-addressed history. Each subview mounts
 * its own Workbench islands; only document mode binds editing commands and tools.
 */
import { DocumentActivePeopleTool } from "@myoxus/core/modules/content-presence/document-active-people-tool";
import { NavigateContext } from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkspaceContentOperationService } from "@myoxus/core/modules/workspace-content-operation";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import { useGuard } from "@myoxus/core/components/guard";
import { useRegisterVirgultumEditorCommands } from "@myoxus/core/components/hooks/myoxus/use-register-virgultum-editor-commands";
import { useDocumentViewContext } from "@myoxus/core/components/hooks/use-document-view-context";
import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import {
  HistoryNavigationProvider,
  useHistoryNavigation,
} from "@myoxus/core/modules/doc-versioning/history-navigation";
import { HistoryView } from "./history-view";
import { PageDetailEditor } from "@myoxus/core/components/page-detail-editor";
import { TrashPageFooter } from "@myoxus/core/components/pure/trash-page-footer";
import { TopTip } from "@myoxus/core/components/top-tip";
import { DocService, DocsService } from "@myoxus/core/modules/doc";
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
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import {
  DetailPageEditorFrame,
  DetailPageEditorViewport,
  DetailPageMainFrame,
} from "@myoxus/ui-facade";
import { useContext, useEffect, useState } from "react";
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

const DocumentRouteFailure = ({ pageId }: { pageId: string }) => {
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
    // Live/denied local documents outrank redirects, including a reused route key.
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
        (address) => {
          if (cancelled) return;
          if (
            address &&
            (address.workspaceId !== workspace.id || address.id !== pageId)
          ) {
            void navigate(
              `/workspace/${address.workspaceId}/${address.id}${location.search}${location.hash}`,
              { replace: true },
            );
          }
          setResolving(false);
        },
        () => {
          if (!cancelled) setResolving(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    docRecord,
    workspace,
    pageId,
    operations,
    navigate,
    location.search,
    location.hash,
  ]);

  if (resolving && !docRecord) return <WorkbenchRouteLoading />;
  return docRecord && canAccess === false ? (
    <WorkbenchRouteAccessDenied />
  ) : (
    <WorkbenchRouteNotFound />
  );
};

/**
 * Core document editor component.
 *
 * Reads all necessary services from the DI context (workbench, view, editor,
 * doc, workspace, global context) and renders the full editor UI with all
 * contextual sidecards.
 *
 * This component assumes it is mounted inside a `FrameworkScope` that contains
 * valid `EditorService` and `DocService` instances (set up by
 * `<DetailPageWrapper>`).
 */
const DocumentEditorView = () => {
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
  const editor = editorService.editor;
  const workspace = workspaceService.workspace;
  const doc = docService.doc;
  const t = useI18n();

  const mode = useLiveData(editor.mode$);
  const isInTrash = useLiveData(doc.meta$.map((meta) => meta.trash));
  const editorContainer = useLiveData(editor.editorContainer$);

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

  const journalService = useService(JournalService);
  const journalDate = useLiveData(journalService.journalDate$(doc.id));
  const isJournal = Boolean(journalDate);
  const onLoad = useDocumentEditorLifecycle({
    editor,
    isJournal,
    scrollViewportRef,
  });

  const [hasScrollTop, setHasScrollTop] = useState(false);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const handleScroll = () => setHasScrollTop(viewport.scrollTop > 0);
    handleScroll();
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [scrollViewportRef]);

  const [dragging, setDragging] = useState(false);

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
          {/* Add a key to force rerender when page changed, to avoid error boundary persisting. */}
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
};

/** The live Doc/Editor scope survives; only the current editing renderer is replaced. */
const DocumentDetailContent = () => {
  const navigation = useHistoryNavigation();
  return navigation.state.open ? <HistoryView /> : <DocumentEditorView />;
};
const DocumentDetailView = () => {
  const doc = useService(DocService).doc;
  const workspace = useService(WorkspaceService).workspace;
  const view = useService(ViewService).view;
  return (
    <HistoryNavigationProvider key={`${workspace.id}:${doc.id}:${view.id}`}>
      <DocumentDetailContent />
    </HistoryNavigationProvider>
  );
};

/**
 * Lazy route entry point for the document detail page.
 *
 * Reads `:pageId` from the URL, checks
 * whether the current user has `Doc_Read` permission, and renders either the
 * document wrapped in `<DetailPageWrapper>` or appropriate fallback UIs
 * (skeleton while loading, 404 when not found / no access).
 */
export const Component = () => {
  const params = useParams();

  const pageId = params.pageId;
  return pageId ? (
    <DetailPageWrapper
      pageId={pageId}
      skeleton={<WorkbenchRouteLoading />}
      notFound={<DocumentRouteFailure pageId={pageId} />}
    >
      <DocumentDetailView />
    </DetailPageWrapper>
  ) : null;
};
