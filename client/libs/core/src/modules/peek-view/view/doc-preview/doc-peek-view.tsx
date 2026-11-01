import type { PeekViewEntity } from "../../entities/peek-view";
import { WorkspaceService, WorkspacesService } from "../../../workspace";
import { useState } from "react";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { useGuard } from "@myoxus/core/components/guard";
import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import { PageNotFound } from "@myoxus/core/desktop/pages/404";
import {
  type AIChatParams,
  AIProvider,
} from "@myoxus/core/editor/ai/provider/ai-provider";
import { EditorOutlineViewer } from "@myoxus/core/editor/outline-viewer";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import { EditorService } from "@myoxus/core/modules/editor";
import { DebugLogger } from "@myoxus/debug";
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServices,
} from "@myoxus/infra";
import {
  detailPageEditorRootAttrs,
  DetailPageEditorViewport,
  PageDetailLoading,
  Scrollable,
} from "@myoxus/ui-facade";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import { Bound } from "@virgultum/editor/global/gfx";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { lazy, Suspense, useCallback, useEffect } from "react";
import type { Subscription } from "rxjs";

import { WorkbenchService } from "../../../workbench/services/workbench";
import type { DocReferenceInfo } from "../../entities/peek-view";
import { PeekViewService } from "../../services/peek-view";
import { useEditor } from "../utils";
import { DocReadingPreview } from "./doc-reading-preview";

const logger = new DebugLogger("doc-peek-view");

// Lazy load VirgultumEditor to break circular dependency
const VirgultumEditor = lazy(() =>
  import("@myoxus/core/editor/virgultum/doc-editor").then((module) => ({
    default: module.VirgultumEditor,
  })),
);

function fitViewport(
  editor: MyoxusEditorContainer,
  xywh?: `[${number},${number},${number},${number}]`,
) {
  try {
    if (!editor.host) {
      throw new Error("editor host is not ready");
    }

    const gfx = editor.host.std.get(GfxControllerIdentifier);
    const viewport = gfx.viewport;
    viewport.onResize();

    if (xywh) {
      const newViewport = {
        xywh: xywh,
        padding: [60, 20, 20, 20] as [number, number, number, number],
      };
      viewport.setViewportByBound(
        Bound.deserialize(newViewport.xywh),
        newViewport.padding,
        false,
      );
    } else {
      gfx.fitToScreen({
        smooth: false,
      });
    }
  } catch (e) {
    logger.warn("failed to fitViewPort", e);
  }
}

function DocPeekPreviewEditor({
  onEditorReady,
  xywh,
  ownerPeekView,
}: {
  ownerPeekView: PeekViewEntity;
  onEditorReady?: (editor: MyoxusEditorContainer) => (() => void) | void;
  xywh?: `[${number},${number},${number},${number}]`;
}) {
  const { editorService } = useServices({
    EditorService,
  });
  const editor = editorService.editor;
  const doc = editor.doc;
  const workspace = editor.doc.workspace;
  const mode = useLiveData(editor.mode$);
  const workbench = useService(WorkbenchService).workbench;
  const peekView = ownerPeekView;
  const { jumpToPageBlock } = useNavigateHelper();
  const editorElement = useLiveData(editor.editorContainer$);

  const isInTrash = useLiveData(doc.record.trash$);

  const handleOnEditorReady = useCallback(
    (editorContainer: MyoxusEditorContainer) => {
      const disposableGroup = new DisposableGroup();
      const refNodeSlots =
        editorContainer.std.getOptional(RefNodeSlotsProvider);
      if (refNodeSlots) {
        // Document-link routing is optional, but editor binding and external
        // ready callbacks must work for every valid Virgultum page editor.
        disposableGroup.add(
          refNodeSlots.docLinkClicked.subscribe((options) => {
            if (options.host !== editorContainer.host) {
              return;
            }
            peekView
              .open({
                docRef: {
                  docId: options.pageId,
                  workspaceId:
                    options.workspaceId ?? editorContainer.std.workspace.id,
                },
                ...options.params,
              })
              .catch(console.error);
          }),
        );
      }

      const unbind = editor.bindEditorContainer(editorContainer);

      if (mode === "edgeless") {
        fitViewport(editorContainer, xywh);
      }

      const disposeExternalReady = onEditorReady?.(editorContainer);

      return () => {
        disposeExternalReady?.();
        unbind();
        disposableGroup.dispose();
      };
    },
    [editor, mode, onEditorReady, peekView, xywh],
  );

  useEffect(() => {
    const disposables: Subscription[] = [];
    const openHandler = (params: AIChatParams | null) => {
      if (!params) {
        return;
      }
      if (doc) {
        workbench.openDoc(doc.id);
        peekView.close();
        // Chat-panel opening is already handled by the document detail view.
      }
    };
    disposables.push(
      AIProvider.slots.requestOpenWithChat.subscribe(openHandler),
    );
    disposables.push(
      AIProvider.slots.requestSendWithChat.subscribe(openHandler),
    );
    return () => disposables.forEach((d) => d.unsubscribe());
  }, [doc, peekView, workbench, workspace.id]);

  const openOutlinePanel = useCallback(() => {
    jumpToPageBlock(workspace.id, doc.id, mode);
    peekView.close();
  }, [doc, peekView, jumpToPageBlock, workspace.id, mode]);

  const canEdit = useGuard("Doc_Update", doc.id);

  const readonly = !canEdit || isInTrash;

  return (
    <MyoxusErrorBoundary>
      <Scrollable.Root>
        <DetailPageEditorViewport
          editorMode={mode}
          pageModeContentBox={mode === "page"}
        >
          <Suspense fallback={<PageDetailLoading />}>
            <VirgultumEditor
              {...detailPageEditorRootAttrs()}
              mode={mode}
              page={doc.virgultumDoc}
              readonly={readonly}
              onEditorReady={handleOnEditorReady}
            />
          </Suspense>
        </DetailPageEditorViewport>
        <Scrollable.Scrollbar />
      </Scrollable.Root>
      {!BUILD_CONFIG.isMobileEdition && !BUILD_CONFIG.isMobileWeb ? (
        <EditorOutlineViewer
          editor={editorElement?.host ?? null}
          show={mode === "page"}
          openOutlinePanel={openOutlinePanel}
        />
      ) : null}
    </MyoxusErrorBoundary>
  );
}

function ScopedDocPeekPreview({
  docRef,
  animating,
  onEditorReady,
  ownerPeekView,
}: {
  docRef: DocReferenceInfo;
  ownerPeekView: PeekViewEntity;
  animating?: boolean;
  /** Runs after the shared Virgultum editor has mounted and bound its host. */
  onEditorReady?: (editor: MyoxusEditorContainer) => (() => void) | void;
}) {
  const { docId, blockIds, elementIds, mode, xywh } = docRef;
  const { doc, editor, loading } = useEditor(
    docId,
    mode,
    {
      blockIds,
      elementIds,
    },
    !animating,
  );

  const canAccess = useGuard("Doc_Read", docId);

  // if sync engine has been synced and the page is null, show 404 page.
  if (!doc || !editor || !canAccess) {
    return loading || canAccess === undefined ? (
      <PageDetailLoading key="current-page-is-null" />
    ) : (
      <PageNotFound noPermission />
    );
  }

  return (
    <FrameworkScope scope={doc.scope}>
      <FrameworkScope scope={editor.scope}>
        <DocPeekPreviewEditor
          xywh={xywh}
          onEditorReady={onEditorReady}
          ownerPeekView={ownerPeekView}
        />
      </FrameworkScope>
    </FrameworkScope>
  );
}

/** Use the existing workspace pool before any editor/guard lookup. */
export function DocPeekPreview(props: {
  docRef: DocReferenceInfo;
  reading?: boolean;
  attempt?: number;
  animating?: boolean;
  onEditorReady?: (editor: MyoxusEditorContainer) => (() => void) | void;
}) {
  const workspace = useService(WorkspaceService).workspace;
  const ownerPeekView = useService(PeekViewService).peekView;
  const workspaces = useService(WorkspacesService);
  const targetId = props.docRef.workspaceId;
  const foreign = targetId !== undefined && targetId !== workspace.id;
  const [opened, setOpened] =
    useState<ReturnType<WorkspacesService["openByWorkspaceId"]>>();
  useEffect(() => {
    if (!foreign) {
      setOpened(undefined);
      return;
    }
    const reference = workspaces.openByWorkspaceId(targetId);
    setOpened(reference);
    return () => reference?.dispose();
  }, [foreign, targetId, workspaces]);
  const preview = props.reading ? (
    <DocReadingPreview
      docId={props.docRef.docId}
      attempt={props.attempt ?? 0}
    />
  ) : (
    <ScopedDocPeekPreview {...props} ownerPeekView={ownerPeekView} />
  );
  if (!foreign) return preview;
  if (!opened || opened.workspace.id !== targetId)
    return <PageNotFound noPermission />;
  return (
    <FrameworkScope scope={opened.workspace.scope}>{preview}</FrameworkScope>
  );
}
