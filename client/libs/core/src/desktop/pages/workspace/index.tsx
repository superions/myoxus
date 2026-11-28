// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { workbenchRoutes } from "@myoxus/core/desktop/workbench-router";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { DndService } from "@myoxus/core/modules/dnd/services";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { OpenInAppGuard } from "@myoxus/core/modules/open-in-app";
import {
  DefaultServerService,
  ServersService,
} from "@myoxus/core/modules/server";
import { exportWorkspaceLabels } from "@myoxus/core/modules/tag/export";
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
import {
  lazy,
  type PropsWithChildren,
  type ReactElement,
  Suspense,
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

const SharePage = lazy(async () => ({
  default: (await import("./share/share-page")).SharePage,
}));

declare global {
  // oxlint-disable-next-line no-var
  var currentWorkspace: Workspace | undefined;
  // oxlint-disable-next-line no-var
  var exportWorkspaceSnapshot: (docs?: string[]) => Promise<void>;
  // oxlint-disable-next-line no-var
  var Y: typeof _Y;
  interface WindowEventMap {
    "myoxus:workspace:change": CustomEvent<{ id: string }>;
  }
}

globalThis.Y = _Y;

function DNDContextProvider({ children }: PropsWithChildren) {
  const dndService = useService(DndService);
  const value = useMemo(
    () => ({
      fromExternalData: dndService.fromExternalData,
      toExternalData: dndService.toExternalData,
    }),
    [dndService.fromExternalData, dndService.toExternalData],
  );
  return <DNDContext.Provider value={value}>{children}</DNDContext.Provider>;
}

function WorkspacePage({ meta }: { meta: WorkspaceMetadata }) {
  const { workspacesService, globalContextService } = useServices({
    WorkspacesService,
    GlobalContextService,
  });

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [isRootDocReady, setIsRootDocReady] = useState(false);

  useLayoutEffect(() => {
    const opened = workspacesService.open({ metadata: meta });
    setWorkspace(opened.workspace);
    return () => opened.dispose();
  }, [meta, workspacesService]);

  useEffect(() => {
    setIsRootDocReady(false);
    if (!workspace) {
      return;
    }
    const controller = new AbortController();
    void workspace.engine.doc
      .waitForDocReady(workspace.id, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          setIsRootDocReady(true);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error(error);
        }
      });
    return () => controller.abort();
  }, [workspace]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    window.currentWorkspace = workspace;
    window.dispatchEvent(
      new CustomEvent("myoxus:workspace:change", {
        detail: { id: workspace.id },
      }),
    );
    window.exportWorkspaceSnapshot = async (docs?: string[]) => {
      const exported = Array.from(workspace.docCollection.docs.values())
        .filter((doc) => (docs ? docs.includes(doc.id) : true))
        .map((doc) => doc.getStore());
      const { ZipTransformer } = await import("@virgultum/editor/interchange");
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
    globalContextService.globalContext.workspaceFlavour.set(workspace.flavour);

    return () => {
      window.currentWorkspace = undefined;
      globalContextService.globalContext.workspaceId.set(null);
      globalContextService.globalContext.workspaceFlavour.set(null);
    };
  }, [globalContextService, workspace]);

  if (!workspace) {
    return null;
  }

  return (
    <FrameworkScope scope={workspace.scope}>
      <DNDContextProvider>
        <OpenInAppGuard>
          {isRootDocReady ? (
            <MyoxusErrorBoundary height="100vh">
              <WorkspaceLayout>
                <WorkbenchRoot />
              </WorkspaceLayout>
            </MyoxusErrorBoundary>
          ) : (
            <AppContainer fallback />
          )}
        </OpenInAppGuard>
      </DNDContextProvider>
    </FrameworkScope>
  );
}

export function Component(): ReactElement {
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

  const detailDocRoute = useMemo(() => {
    const match = matchPath(
      "/workspace/:workspaceId/:docId",
      location.pathname,
    );
    if (
      match?.params.docId &&
      match.params.workspaceId &&
      workbenchRoutes.find((route) =>
        matchPath(route.path, `/${match.params.docId}`),
      )?.path === "/:pageId"
    ) {
      return {
        docId: match.params.docId,
        workspaceId: match.params.workspaceId,
      };
    }
    return null;
  }, [location.pathname]);

  const [workspaceNotFound, setWorkspaceNotFound] = useState(false);
  const listLoading = useLiveData(workspacesService.list.isRevalidating$);
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const meta = useMemo(
    () => workspaces.find(({ id }) => id === params.workspaceId),
    [params.workspaceId, workspaces],
  );

  useEffect(() => {
    if (listLoading === false && meta === undefined) {
      setWorkspaceNotFound(true);
    } else if (meta) {
      setWorkspaceNotFound(false);
    }
  }, [listLoading, meta]);

  const retriesRemainingRef = useRef(3);
  useEffect(() => {
    if (params.workspaceId) {
      retriesRemainingRef.current = 3;
      workspacesService.list.revalidate();
    }
  }, [params.workspaceId, workspacesService]);

  useEffect(() => {
    if (listLoading !== false || meta !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      if (
        retriesRemainingRef.current > 0 &&
        reserveAutomaticRetry("livedata")
      ) {
        workspacesService.list.revalidate();
        retriesRemainingRef.current -= 1;
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [listLoading, meta, workspaceNotFound, workspacesService]);

  const serverParam = searchParams.get("server");
  const serverFromSearchParams = useLiveData(
    serverParam ? serversService.serverByBaseUrl$(serverParam) : undefined,
  );
  const serverFromWorkspace = useLiveData(
    meta?.flavour && meta.flavour !== "local"
      ? serversService.server$(meta.flavour)
      : undefined,
  );
  const server = serverFromWorkspace ?? serverFromSearchParams;

  useEffect(() => {
    if (!server) {
      return;
    }
    if (!BUILD_CONFIG.isElectron) {
      serversService.selectServer(server.id);
    }
    globalContextService.globalContext.serverId.set(server.id);
    return () => {
      globalContextService.globalContext.serverId.set(
        defaultServerService.server$.value?.id ?? null,
      );
    };
  }, [
    defaultServerService,
    globalContextService.globalContext.serverId,
    server,
    serversService,
  ]);

  const addStandaloneOpenedRef = useRef(false);
  useEffect(() => {
    if (addStandaloneOpenedRef.current) {
      return;
    }
    addStandaloneOpenedRef.current = true;
    if (BUILD_CONFIG.isElectron && server === undefined && serverParam) {
      globalDialogService.open("sign-in", { server: serverParam });
    }
  }, [globalDialogService, server, serverParam]);

  if (workspaceNotFound) {
    if (detailDocRoute) {
      return (
        <FrameworkScope scope={server?.scope}>
          <Suspense>
            <SharePage
              docId={detailDocRoute.docId}
              workspaceId={detailDocRoute.workspaceId}
            />
          </Suspense>
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
}
