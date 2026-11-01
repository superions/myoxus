/**
 * Workspace page — the outermost route component for `/workspace/:workspaceId/*`.
 *
 * This file wires three concerns together:
 *
 * 1. **Workspace resolution** (`Component`):
 *    Reads the `:workspaceId` URL param, looks it up in `WorkspacesService`,
 *    and handles the three possible states:
 *    - Loading: shows `<AppContainer fallback />` while the list revalidates.
 *    - Not found: renders a share page if the URL looks like a doc link (the
 *      user may be viewing a public share), or falls back to a 404 page.
 *    - Found: delegates to `<WorkspacePage>` inside the appropriate server's
 *      `FrameworkScope`.
 *    Also manages global context values (`serverId`, `workspaceId`, flavour)
 *    and handles the Electron-only "add selfhosted server" deep-link flow.
 *
 * 2. **Workspace lifecycle** (`WorkspacePage`):
 *    Opens the workspace via `WorkspacesService.open`, waits for the root doc
 *    to be ready, then renders the full `<WorkspaceLayout><WorkbenchRoot /></WorkspaceLayout>`
 *    tree. Exposes debug helpers (`window.currentWorkspace`,
 *    `window.exportWorkspaceSnapshot`,
 *    global `Y`) on the browser window in development.
 *
 * 3. **DnD context** (`DNDContextProvider`):
 *    Provides the DnD service's `fromExternalData`/`toExternalData` adapters
 *    to the component tree so that Virgultum editors can accept external
 *    drag-and-drop payloads.
 *
 * Exported `Component` is the lazy route entry point consumed by the router.
 */
import { workbenchRoutes } from "@myoxus/core/desktop/workbench-router";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { DndService } from "@myoxus/core/modules/dnd/services";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { exportWorkspaceLabels } from "@myoxus/core/modules/tag/export";
import { OpenInAppGuard } from "@myoxus/core/modules/open-in-app";
import {
  DefaultServerService,
  ServersService,
} from "@myoxus/core/modules/server";
import {
  getMyoxusWorkspaceSchema,
  type Workspace,
  type WorkspaceMetadata,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import {
  FrameworkScope,
  reserveAutomaticRetry,
  useLiveData,
  useService,
  useServices,
} from "@myoxus/infra";
import { DNDContext } from "@myoxus/ui-facade";
import { ZipTransformer } from "@virgultum/editor/widgets/linked-doc";
import {
  type PropsWithChildren,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  matchPath,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router";
import * as _Y from "yjs";

import { MyoxusErrorBoundary } from "../../../components/myoxus/myoxus-error-boundary";
import { WorkbenchRoot } from "../../../modules/workbench";
import { AppContainer } from "../../components/app-container";
import { PageNotFound } from "../404";
import { WorkspaceLayout } from "./layouts/workspace-layout";
import { SharePage } from "./share/share-page";

declare global {
  /**
   * @internal debug only
   */
  // oxlint-disable-next-line no-var
  var currentWorkspace: Workspace | undefined;
  // oxlint-disable-next-line no-var
  var exportWorkspaceSnapshot: (docs?: string[]) => Promise<void>;
  // oxlint-disable-next-line no-var
  // oxlint-disable-next-line no-var
  var Y: typeof _Y;
  interface WindowEventMap {
    "myoxus:workspace:change": CustomEvent<{ id: string }>;
  }
}

globalThis.Y = _Y;

/**
 * Lazy route component for `/workspace/:workspaceId/*`.
 *
 * Resolves the target workspace from the URL, handles loading / not-found
 * states, and renders `<WorkspacePage>` once a matching workspace is found.
 * Falls back to a `<SharePage>` when the workspace is absent but the URL
 * pattern matches a doc reference (public share link scenario).
 */
export const Component = (): ReactElement => {
  const {
    workspacesService,
    globalDialogService,
    serversService,
    defaultServerService,
    globalContextService,
  } = useServices({
    WorkspacesService,
    GlobalDialogService,
    ServersService,
    DefaultServerService,
    GlobalContextService,
  });

  const params = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // check if we are in detail doc route, if so, maybe render share page
  const detailDocRoute = useMemo(() => {
    const match = matchPath(
      "/workspace/:workspaceId/:docId",
      location.pathname,
    );
    if (
      match &&
      match.params.docId &&
      match.params.workspaceId &&
      // TODO(eyhn): need a better way to check if it's a docId
      workbenchRoutes.find((route) =>
        matchPath(route.path, "/" + match.params.docId),
      )?.path === "/:pageId"
    ) {
      return {
        docId: match.params.docId,
        workspaceId: match.params.workspaceId,
      };
    } else {
      return null;
    }
  }, [location.pathname]);

  const [workspaceNotFound, setWorkspaceNotFound] = useState(false);
  const listLoading = useLiveData(workspacesService.list.isRevalidating$);
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const meta = useMemo(() => {
    return workspaces.find(({ id }) => id === params.workspaceId);
  }, [workspaces, params.workspaceId]);

  // if listLoading is false, we can show 404 page, otherwise we should show loading page.
  useEffect(() => {
    if (listLoading === false && meta === undefined) {
      setWorkspaceNotFound(true);
    }
    if (meta) {
      setWorkspaceNotFound(false);
    }
  }, [listLoading, meta, workspacesService]);

  // if workspace is not found, we should retry
  const retryTimesRef = useRef(3);
  useEffect(() => {
    if (params.workspaceId) {
      retryTimesRef.current = 3; // reset retry times
      workspacesService.list.revalidate();
    }
  }, [params.workspaceId, workspacesService]);
  useEffect(() => {
    if (listLoading === false && meta === undefined) {
      const timer = setTimeout(() => {
        if (retryTimesRef.current > 0 && reserveAutomaticRetry("livedata")) {
          workspacesService.list.revalidate();
          retryTimesRef.current--;
        }
      }, 5000);
      return () => clearTimeout(timer);
    }
    return;
  }, [listLoading, meta, workspaceNotFound, workspacesService]);

  // server search params
  const serverFromSearchParams = useLiveData(
    searchParams.has("server")
      ? serversService.serverByBaseUrl$(searchParams.get("server") as string)
      : undefined,
  );
  // server from workspace
  const serverFromWorkspace = useLiveData(
    meta?.flavour && meta.flavour !== "local"
      ? serversService.server$(meta?.flavour)
      : undefined,
  );
  const server = serverFromWorkspace ?? serverFromSearchParams;

  useEffect(() => {
    if (server) {
      if (!BUILD_CONFIG.isElectron) serversService.selectServer(server.id);
      globalContextService.globalContext.serverId.set(server.id);
      return () => {
        globalContextService.globalContext.serverId.set(
          defaultServerService.server$.value?.id ?? null,
        );
      };
    }
    return;
  }, [
    defaultServerService,
    serversService,
    globalContextService.globalContext.serverId,
    server,
  ]);

  // if server is not found, and we have server in search params, we should show add standalone dialog
  const needAddStandalone = server === undefined && searchParams.has("server");
  // use ref to avoid useEffect trigger twice
  const addStandaloneDialogOpened = useRef<boolean>(false);

  useEffect(() => {
    if (addStandaloneDialogOpened.current) {
      return;
    }
    addStandaloneDialogOpened.current = true;
    if (BUILD_CONFIG.isElectron && needAddStandalone) {
      globalDialogService.open("sign-in", {
        server: searchParams.get("server") as string,
      });
    }
    return;
  }, [
    globalDialogService,
    needAddStandalone,
    searchParams,
    serverFromSearchParams,
  ]);

  if (workspaceNotFound) {
    if (detailDocRoute) {
      return (
        <FrameworkScope scope={server?.scope}>
          <SharePage
            docId={detailDocRoute.docId}
            workspaceId={detailDocRoute.workspaceId}
          />
        </FrameworkScope>
      );
    }
    return (
      <FrameworkScope scope={server?.scope}>
        <PageNotFound noPermission />
      </FrameworkScope>
    );
  }
  if (!meta) {
    return <AppContainer fallback />;
  }

  return (
    <FrameworkScope scope={server?.scope}>
      <WorkspacePage meta={meta} />
    </FrameworkScope>
  );
};

/**
 * Provides drag-and-drop context values to the workspace tree.
 *
 * Reads `fromExternalData` and `toExternalData` adapters from `DndService` and
 * injects them via `DNDContext.Provider`. Both adapters are memoized to
 * prevent unnecessary re-renders in deeply nested editor components.
 */
const DNDContextProvider = ({ children }: PropsWithChildren) => {
  const dndService = useService(DndService);
  const contextValue = useMemo(() => {
    return {
      fromExternalData: dndService.fromExternalData,
      toExternalData: dndService.toExternalData,
    };
  }, [dndService.fromExternalData, dndService.toExternalData]);
  return (
    <DNDContext.Provider value={contextValue}>{children}</DNDContext.Provider>
  );
};

/**
 * Workspace instance component.
 *
 * Opens the workspace identified by `meta` via `WorkspacesService`, waits for
 * the root doc to become ready, then renders the full
 * workspace UI. While loading it preserves the stable shell. After the
 * workspace is available it registers debug helpers on `window` and keeps the
 * global context (`workspaceId`, `workspaceFlavour`) up to date.
 *
 * @param meta - Workspace metadata (id, flavour) used to open the workspace.
 */
const WorkspacePage = ({ meta }: { meta: WorkspaceMetadata }) => {
  const { workspacesService, globalContextService } = useServices({
    WorkspacesService,
    GlobalContextService,
  });

  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useLayoutEffect(() => {
    const ref = workspacesService.open({ metadata: meta });
    setWorkspace(ref.workspace);
    return () => {
      ref.dispose();
    };
  }, [meta, workspacesService]);

  const [isRootDocReady, setIsRootDocReady] = useState(false);

  useEffect(() => {
    setIsRootDocReady(false);
    if (!workspace) return;

    const abortController = new AbortController();
    void workspace.engine.doc
      .waitForDocReady(workspace.id, abortController.signal)
      .then(() => {
        if (!abortController.signal.aborted) setIsRootDocReady(true);
      })
      .catch((error) => {
        if (!abortController.signal.aborted) console.error(error);
      });

    return () => abortController.abort();
  }, [workspace]);

  useEffect(() => {
    if (workspace) {
      // for debug purpose
      window.currentWorkspace = workspace ?? undefined;
      window.dispatchEvent(
        new CustomEvent("myoxus:workspace:change", {
          detail: {
            id: workspace.id,
          },
        }),
      );
      window.exportWorkspaceSnapshot = async (docs?: string[]) => {
        const exported = Array.from(workspace.docCollection.docs.values())
          .filter((doc) => (docs ? docs.includes(doc.id) : true))
          .map((doc) => doc.getStore());
        await ZipTransformer.exportDocs(
          workspace.docCollection,
          getMyoxusWorkspaceSchema(),
          exported,
          await exportWorkspaceLabels(
            workspace,
            exported.map((doc) => doc.id),
          ),
        );
      };
      localStorage.setItem("last_workspace_id", workspace.id);
      globalContextService.globalContext.workspaceId.set(workspace.id);
      globalContextService.globalContext.workspaceFlavour.set(
        workspace.flavour,
      );
      return () => {
        window.currentWorkspace = undefined;
        globalContextService.globalContext.workspaceId.set(null);
        globalContextService.globalContext.workspaceFlavour.set(null);
      };
    }
    return;
  }, [globalContextService, workspace]);

  if (!workspace) {
    return null; // skip this, workspace will be set in layout effect
  }

  if (!isRootDocReady) {
    return (
      <FrameworkScope scope={workspace.scope}>
        <DNDContextProvider>
          <OpenInAppGuard>
            <AppContainer fallback />
          </OpenInAppGuard>
        </DNDContextProvider>
      </FrameworkScope>
    );
  }

  return (
    <FrameworkScope scope={workspace.scope}>
      <DNDContextProvider>
        <OpenInAppGuard>
          <MyoxusErrorBoundary height="100vh">
            <WorkspaceLayout>
              <WorkbenchRoot />
            </WorkspaceLayout>
          </MyoxusErrorBoundary>
        </OpenInAppGuard>
      </DNDContextProvider>
    </FrameworkScope>
  );
};
