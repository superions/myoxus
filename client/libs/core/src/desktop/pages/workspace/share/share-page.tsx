/**
 * Share page — read-only document viewer for publicly shared docs.
 *
 * Rendered when the workspace identified by the URL is not found in the
 * current user's workspace list but the URL matches a doc path. This covers
 * two scenarios:
 * - An unauthenticated visitor following a public share link.
 * - A workspace member opening a deep-link before their workspace list has
 *   fully loaded (in that case the workspace page replaces this once the list
 *   resolves).
 *
 * The component creates a temporary workspace in `isSharedMode` mode using
 * `StaticCloudDocStorage` (read-only, no writes) and `CloudBlobStorage`.
 * The root doc is loaded first, then the target doc is opened and set to
 * read-only before being rendered with `<PageDetailEditor>`.
 *
 * URL search parameters:
 * - `mode`         — forces a specific `DocMode` (`page` | `edgeless`).
 * - `blockIds`     — comma-separated block IDs to highlight/focus.
 * - `elementIds`   — comma-separated edgeless element IDs.
 * - `refreshKey`   — opaque cache-busting key forwarded to the editor selector.
 * - `isTemplate`   — presence of this param enables the template import UI.
 * - `templateName` — display name of the template.
 * - `snapshotUrl`  — URL to the template snapshot ZIP file.
 *
 * Exports:
 * - `SharePage` — the outer shell that parses URL params and wraps the inner
 *    content in `<AppContainer>`.
 * - `SharePageInner` — the workspace + doc lifecycle component (internal).
 */
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { useActiveVirgultumEditor } from "@myoxus/core/components/hooks/use-virgultum-editor";
import { PageDetailEditor } from "@myoxus/core/components/page-detail-editor";
import { AppContainer } from "@myoxus/core/desktop/components/app-container";
import { EditorOutlineViewer } from "@myoxus/core/editor/outline-viewer";
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
import { uniReactRoot } from "@myoxus/lit-react";
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

/**
 * Syncs the workbench basename with the URL pathname.
 *
 * On the share page the workbench is used inside a temporary workspace, so its
 * basename must be kept in sync with the current URL to allow in-doc link
 * navigation to resolve correctly. This hook reads the `/workspace/:id` prefix
 * from `location.pathname` and calls `workbench.updateBasename` whenever the
 * workspace or location changes.
 *
 * @param workspace - The temporary shared workspace, or null while loading.
 */
const useUpdateBasename = (workspace: Workspace | null) => {
  const location = useLocation();
  const basename = location.pathname.match(/\/workspace\/[^/]+/g)?.[0] ?? "/";
  useEffect(() => {
    if (workspace) {
      const workbench = workspace.scope.get(WorkbenchService).workbench;
      workbench.updateBasename(basename);
    }
  }, [basename, workspace]);
};

/**
 * Public share page shell.
 *
 * Parses view-related URL search parameters (`mode`, `blockIds`, `elementIds`,
 * `refreshKey`, `isTemplate`, `templateName`, `snapshotUrl`) and delegates to
 * `<SharePageInner>` which handles the workspace/doc lifecycle. The `key` prop
 * forces a full remount when workspace or doc changes to avoid stale state from
 * a previous share URL being carried over.
 *
 * @param workspaceId - Workspace ID extracted from the URL by the parent route.
 * @param docId       - Document ID extracted from the URL by the parent route.
 */
export const SharePage = ({
  workspaceId,
  docId,
}: {
  workspaceId: string;
  docId: string;
}) => {
  const location = useLocation();

  const { mode, selector, isTemplate, templateName, templateSnapshotUrl } =
    useMemo(() => {
      const searchParams = new URLSearchParams(location.search);
      const queryStringMode = searchParams.get("mode") as DocMode | null;
      const blockIds = searchParams
        .get("blockIds")
        ?.split(",")
        .filter((v) => v.length);
      const elementIds = searchParams
        .get("elementIds")
        ?.split(",")
        .filter((v) => v.length);

      return {
        mode:
          queryStringMode && DocModes.includes(queryStringMode)
            ? queryStringMode
            : null,
        selector: {
          blockIds,
          elementIds,
          refreshKey: searchParams.get("refreshKey") || undefined,
        },
        isTemplate: searchParams.has("isTemplate"),
        templateName: searchParams.get("templateName") || "",
        templateSnapshotUrl: searchParams.get("snapshotUrl") || "",
      };
    }, [location.search]);

  return (
    <AppContainer>
      <SharePageInner
        workspaceId={workspaceId}
        docId={docId}
        key={workspaceId + ":" + docId}
        publishMode={mode ?? undefined}
        selector={selector}
        isTemplate={isTemplate}
        templateName={templateName}
        templateSnapshotUrl={templateSnapshotUrl}
      />
    </AppContainer>
  );
};

const SharePageInner = ({
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
}) => {
  const serverService = useService(ServerService);
  const workspacesService = useService(WorkspacesService);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [page, setPage] = useState<Doc | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [noPermission, setNoPermission] = useState(false);
  const [editorContainer, setActiveVirgultumEditor] =
    useActiveVirgultumEditor();

  useEffect(() => {
    // create a workspace for share page
    const { workspace } = workspacesService.open(
      {
        metadata: {
          id: workspaceId,
          flavour: "myoxus-cloud",
        },
        isSharedMode: true,
      },
      {
        local: {
          doc: {
            name: "StaticCloudDocStorage",
            opts: {
              id: workspaceId,
              serverId: serverService.server.id,
              serverBaseUrl: serverService.server.baseUrl,
            },
          },
          blob: {
            name: "CloudBlobStorage",
            opts: {
              id: workspaceId,
              serverId: serverService.server.id,
              serverBaseUrl: serverService.server.baseUrl,
            },
          },
        },
        remotes: {},
      },
    );

    setWorkspace(workspace);

    workspace.engine.doc
      .waitForDocLoaded(workspace.id)
      .then(async () => {
        const docRef = workspace.scope.get(DocsService).open(docId);
        if (!docRef) throw new Error("Doc not available yet");
        const { doc } = docRef;
        doc.virgultumDoc.load();
        doc.virgultumDoc.readonly = true;

        await workspace.engine.doc.waitForDocLoaded(docId);

        if (!doc.virgultumDoc.root) {
          throw new Error("Doc is empty");
        }

        setPage(doc);

        const editor = doc.scope.get(EditorsService).createEditor();
        editor.setMode(publishMode);

        if (selector) {
          editor.setSelector(selector);
        }

        setEditor(editor);
      })
      .catch(() => {
        // Public and cross-workspace deep links deliberately collapse missing,
        // unpublished and denied documents into the same privacy-safe state.
        // Those expected outcomes must not surface as browser errors.
        setNoPermission(true);
      });
  }, [
    docId,
    workspaceId,
    workspacesService,
    publishMode,
    selector,
    serverService.server.baseUrl,
    serverService.server.id,
  ]);

  const t = useI18n();
  const pageTitle = useLiveData(page?.title$);
  const { jumpToPageBlock, openPage } = useNavigateHelper();
  useUpdateBasename(workspace);

  const onEditorLoad = useCallback(
    (editorContainer: MyoxusEditorContainer) => {
      setActiveVirgultumEditor(editorContainer);
      if (!editor) {
        return;
      }
      const unbind = editor.bindEditorContainer(editorContainer);

      const disposable = new DisposableGroup();
      const refNodeSlots =
        editorContainer.host?.std.getOptional(RefNodeSlotsProvider);
      if (refNodeSlots) {
        disposable.add(
          refNodeSlots.docLinkClicked.subscribe(
            ({ pageId, workspaceId: targetWorkspaceId, params }) => {
              if (params) {
                const { mode, blockIds, elementIds } = params;
                jumpToPageBlock(
                  targetWorkspaceId ?? workspaceId,
                  pageId,
                  mode,
                  blockIds,
                  elementIds,
                );
                return;
              }

              if (editor.doc.id === pageId) {
                return;
              }

              return openPage(targetWorkspaceId ?? workspaceId, pageId);
            },
          ),
        );
      }

      return () => {
        unbind();
      };
    },
    [editor, setActiveVirgultumEditor, jumpToPageBlock, openPage, workspaceId],
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
                editor={editorContainer?.host ?? null}
                show={publishMode === "page"}
              />
              {!BUILD_CONFIG.isElectron && <SharePageBrandingFooter />}
            </PublicSharePageMain>
          </PublicSharePageRoot>
          <PeekViewManagerModal />
          <uniReactRoot.Root />
        </FrameworkScope>
      </FrameworkScope>
    </FrameworkScope>
  );
};
