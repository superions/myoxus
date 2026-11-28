// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { useActiveVirgultumEditor } from "@myoxus/core/components/hooks/use-virgultum-editor";
import { PageDetailEditor } from "@myoxus/core/components/page-detail-editor";
import { AppContainer } from "@myoxus/core/desktop/components/app-container";
import { EditorOutlineViewer } from "@myoxus/core/editor/outline-viewer/editor-outline-viewer";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import { type Doc, DocsService } from "@myoxus/core/modules/doc";
import {
  type Editor,
  type EditorSelector,
  EditorsService,
} from "@myoxus/core/modules/editor";
import { PeekViewManagerModal } from "@myoxus/core/modules/peek-view";
import { ServerService } from "@myoxus/core/modules/server";
import {
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import {
  type Workspace,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import {
  PublicShareEditorViewport,
  PublicSharePageMain,
  PublicSharePageRoot,
  Scrollable,
} from "@myoxus/ui-facade";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { type DocMode, DocModes } from "@virgultum/editor/model";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";

import { PageNotFound } from "../../404";
import { ShareFooter } from "./share-footer";
import { ShareHeader } from "./share-header";
import { SharePageBrandingFooter } from "./share-page-branding-footer";

function useSyncWorkbenchBasename(workspace: Workspace | null) {
  const location = useLocation();
  const basename = location.pathname.match(/\/workspace\/[^/]+/g)?.[0] ?? "/";

  useEffect(() => {
    if (workspace) {
      workspace.scope.get(WorkbenchService).workbench.updateBasename(basename);
    }
  }, [basename, workspace]);
}

function SharePageInner({
  workspaceId,
  docId,
  publishMode = "page",
  selector,
  isTemplate,
  templateName,
  templateSnapshotUrl,
}: {
  workspaceId: string;
  docId: string;
  publishMode?: DocMode;
  selector?: EditorSelector;
  isTemplate?: boolean;
  templateName?: string;
  templateSnapshotUrl?: string;
}) {
  const t = useI18n();
  const serverService = useService(ServerService);
  const workspacesService = useService(WorkspacesService);
  const { jumpToPageBlock, openPage } = useNavigateHelper();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [page, setPage] = useState<Doc | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [noPermission, setNoPermission] = useState(false);
  const [editorContainer, setActiveEditor] = useActiveVirgultumEditor();

  useEffect(() => {
    let cancelled = false;
    const storageOpts = {
      id: workspaceId,
      serverId: serverService.server.id,
      serverBaseUrl: serverService.server.baseUrl,
    };
    const opened = workspacesService.open(
      {
        metadata: { id: workspaceId, flavour: "myoxus-cloud" },
        isSharedMode: true,
      },
      {
        local: {
          doc: { name: "StaticCloudDocStorage", opts: storageOpts },
          blob: { name: "CloudBlobStorage", opts: storageOpts },
        },
        remotes: {},
      },
    );

    const sharedWorkspace = opened.workspace;
    setWorkspace(sharedWorkspace);

    sharedWorkspace.engine.doc
      .waitForDocLoaded(sharedWorkspace.id)
      .then(async () => {
        const docRef = sharedWorkspace.scope.get(DocsService).open(docId);
        if (!docRef) {
          throw new Error("Doc not available yet");
        }
        const { doc } = docRef;
        doc.virgultumDoc.load();
        doc.virgultumDoc.readonly = true;

        await sharedWorkspace.engine.doc.waitForDocLoaded(docId);
        if (!doc.virgultumDoc.root) {
          throw new Error("Doc is empty");
        }
        if (cancelled) {
          return;
        }
        setPage(doc);

        const nextEditor = doc.scope.get(EditorsService).createEditor();
        nextEditor.setMode(publishMode);
        if (selector) {
          nextEditor.setSelector(selector);
        }
        setEditor(nextEditor);
      })
      .catch(() => {
        // Collapse missing, unpublished and denied targets into one privacy-safe state.
        if (!cancelled) {
          setNoPermission(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    docId,
    publishMode,
    selector,
    serverService.server.baseUrl,
    serverService.server.id,
    workspaceId,
    workspacesService,
  ]);

  const pageTitle = useLiveData(page?.title$);
  useSyncWorkbenchBasename(workspace);

  const onEditorLoad = useCallback(
    (container: MyoxusEditorContainer) => {
      setActiveEditor(container);
      if (!editor) {
        return;
      }
      const unbind = editor.bindEditorContainer(container);
      const disposables = new DisposableGroup();
      const refNodeSlots =
        container.host?.std.getOptional(RefNodeSlotsProvider);
      if (refNodeSlots) {
        disposables.add(
          refNodeSlots.docLinkClicked.subscribe(
            ({ pageId, workspaceId: targetWorkspaceId, params }) => {
              if (params) {
                jumpToPageBlock(
                  targetWorkspaceId ?? workspaceId,
                  pageId,
                  params.mode,
                  params.blockIds,
                  params.elementIds,
                );
                return;
              }
              if (editor.doc.id === pageId) {
                return;
              }
              openPage(targetWorkspaceId ?? workspaceId, pageId);
            },
          ),
        );
      }
      return () => {
        disposables.dispose();
        unbind();
      };
    },
    [editor, jumpToPageBlock, openPage, setActiveEditor, workspaceId],
  );

  if (noPermission) {
    return <PageNotFound noPermission />;
  }
  if (!workspace || !page || !editor) {
    return null;
  }

  return (
    <FrameworkScope scope={workspace.scope}>
      <FrameworkScope scope={page.scope}>
        <FrameworkScope scope={editor.scope}>
          <ViewIcon icon={publishMode === "page" ? "doc" : "edgeless"} />
          <ViewTitle title={pageTitle ?? t["unnamed"]()} />
          <PublicSharePageRoot>
            <PublicSharePageMain>
              <ShareHeader
                pageId={page.id}
                publishMode={publishMode}
                isTemplate={isTemplate}
                templateName={templateName}
                snapshotUrl={templateSnapshotUrl}
              />
              <Scrollable.Root>
                <PublicShareEditorViewport>
                  <PageDetailEditor onLoad={onEditorLoad} readonly />
                  {publishMode === "page" && !BUILD_CONFIG.isElectron ? (
                    <ShareFooter />
                  ) : null}
                </PublicShareEditorViewport>
                <Scrollable.Scrollbar />
              </Scrollable.Root>
              <EditorOutlineViewer
                doc={page.virgultumDoc}
                editor={editorContainer?.host ?? null}
                show={publishMode === "page"}
              />
              {!BUILD_CONFIG.isElectron ? <SharePageBrandingFooter /> : null}
            </PublicSharePageMain>
          </PublicSharePageRoot>
          <PeekViewManagerModal />
        </FrameworkScope>
      </FrameworkScope>
    </FrameworkScope>
  );
}

export function SharePage({
  workspaceId,
  docId,
}: {
  workspaceId: string;
  docId: string;
}) {
  const location = useLocation();

  const { mode, selector, isTemplate, templateName, templateSnapshotUrl } =
    useMemo(() => {
      const params = new URLSearchParams(location.search);
      const rawMode = params.get("mode") as DocMode | null;
      const blockIds = params.get("blockIds")?.split(",").filter(Boolean);
      const elementIds = params.get("elementIds")?.split(",").filter(Boolean);

      return {
        mode: rawMode && DocModes.includes(rawMode) ? rawMode : null,
        selector: {
          blockIds,
          elementIds,
          refreshKey: params.get("refreshKey") || undefined,
        },
        isTemplate: params.has("isTemplate"),
        templateName: params.get("templateName") || "",
        templateSnapshotUrl: params.get("snapshotUrl") || "",
      };
    }, [location.search]);

  return (
    <AppContainer>
      <SharePageInner
        key={`${workspaceId}:${docId}`}
        workspaceId={workspaceId}
        docId={docId}
        publishMode={mode ?? undefined}
        selector={selector}
        isTemplate={isTemplate}
        templateName={templateName}
        templateSnapshotUrl={templateSnapshotUrl}
      />
    </AppContainer>
  );
}
