// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { DefaultServerService } from "@myoxus/core/modules/server";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import {
  buildShowcaseWorkspace,
  createFirstAppData,
} from "@myoxus/core/utils/first-app-data";
import { ServerFeature } from "@myoxus/graphql";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import { Center } from "@myoxus/ui-facade";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  RouteLogic,
  useNavigateHelper,
} from "../../../components/hooks/use-navigate-helper";
import { WorkspaceNavigator } from "../../../components/workspace-selector";
import { AuthService } from "../../../modules/server";
import { AppContainer } from "../../components/app-container";
import { selectDefaultWorkspace } from "./model";
import { consumeWorkspaceRedirectCookie } from "./redirect-cookie";

export function Component({
  defaultIndexRoute = "home",
  children,
  fallback,
}: {
  defaultIndexRoute?: string;
  children?: ReactNode;
  fallback?: ReactNode;
}) {
  const [navigating, setNavigating] = useState(true);
  const [creating, setCreating] = useState(false);
  const [workspaceSelectorOpen, setWorkspaceSelectorOpen] = useState(true);

  const authService = useService(AuthService);
  const dialogs = useLiveData(useService(GlobalDialogService).dialogs$);
  const defaultServerService = useService(DefaultServerService);
  const workspacesService = useService(WorkspacesService);
  const desktopApi = useServiceOptional(DesktopApiService);

  const loggedIn = useLiveData(
    authService.session.status$.map((status) => status === "authenticated"),
  );
  const enableLocalWorkspace =
    useLiveData(
      defaultServerService.server.config$.selector(
        (config) =>
          canUseLocalWorkspaces() &&
          (config.features.includes(ServerFeature.LocalWorkspace) ||
            BUILD_CONFIG.isNative),
      ),
    ) ?? canUseLocalWorkspaces();

  const list = useLiveData(workspacesService.list.workspaces$);
  const listIsLoading = useLiveData(workspacesService.list.isRevalidating$);

  const { openPage, jumpToPage, jumpToSignIn } = useNavigateHelper();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const createOnceRef = useRef(false);
  const consumedRedirectRef = useRef<string | null>(null);

  const createCloudWorkspace = useCallback(() => {
    if (createOnceRef.current) {
      return;
    }
    createOnceRef.current = true;
    buildShowcaseWorkspace(
      workspacesService,
      defaultServerService.server.id,
      defaultServerService.server.config$.value.serverName,
    )
      .then(({ meta, defaultDocId }) => {
        if (defaultDocId) {
          jumpToPage(meta.id, defaultDocId);
        } else {
          openPage(meta.id, defaultIndexRoute);
        }
      })
      .catch((error) =>
        console.error("Failed to create cloud workspace", error),
      );
  }, [
    defaultIndexRoute,
    defaultServerService,
    jumpToPage,
    openPage,
    workspacesService,
  ]);

  useLayoutEffect(() => {
    if (!navigating) {
      return;
    }

    // Consume the one-shot nginx redirect cookie before async list revalidation
    // can race against its lifetime, keeping the parsed path in a ref.
    const redirectedPath =
      consumedRedirectRef.current ?? consumeWorkspaceRedirectCookie();
    consumedRedirectRef.current = redirectedPath;

    if (listIsLoading) {
      return;
    }

    if (!enableLocalWorkspace && !loggedIn) {
      localStorage.removeItem("last_workspace_id");
      jumpToSignIn(redirectedPath ?? undefined, RouteLogic.REPLACE);
      return;
    }

    if (redirectedPath) {
      navigate(redirectedPath, { replace: true });
      return;
    }

    if (searchParams.get("initCloud") === "true") {
      if (!loggedIn) {
        return;
      }
      const serverId = defaultServerService.server.id;
      if (list.every((workspace) => workspace.flavour !== serverId)) {
        createCloudWorkspace();
        return;
      }
      const target =
        list.find((workspace) => workspace.flavour === serverId) ?? list[0];
      openPage(target.id, defaultIndexRoute);
      return;
    }

    if (list.length === 0) {
      setNavigating(false);
      return;
    }

    const lastId = localStorage.getItem("last_workspace_id");
    const targetWorkspace = selectDefaultWorkspace(list, lastId);
    if (targetWorkspace) {
      openPage(targetWorkspace.id, defaultIndexRoute, RouteLogic.REPLACE);
    }
  }, [
    createCloudWorkspace,
    defaultIndexRoute,
    defaultServerService.server.id,
    enableLocalWorkspace,
    jumpToSignIn,
    list,
    listIsLoading,
    loggedIn,
    navigate,
    navigating,
    openPage,
    searchParams,
  ]);

  useEffect(() => {
    desktopApi?.handler.ui.pingAppLayoutReady().catch(console.error);
  }, [desktopApi]);

  useEffect(() => {
    if (listIsLoading || list.length > 0 || !enableLocalWorkspace) {
      return;
    }
    createFirstAppData(workspacesService)
      .then((created) => {
        if (!created) {
          return;
        }
        if (created.defaultPageId) {
          jumpToPage(created.meta.id, created.defaultPageId);
        } else {
          openPage(created.meta.id, "home");
        }
      })
      .catch((error) => {
        console.error("Failed to create first app data", error);
      })
      .finally(() => {
        setCreating(false);
      });
  }, [
    enableLocalWorkspace,
    jumpToPage,
    list,
    listIsLoading,
    openPage,
    workspacesService,
  ]);

  if (navigating || creating) {
    return fallback ?? <AppContainer fallback />;
  }

  return (
    children ?? (
      <Center h="100vh">
        {/* Keep the visible opener mounted while a global dialog owns focus. */}
        <WorkspaceNavigator
          open={workspaceSelectorOpen && dialogs.length === 0}
          onOpenChange={setWorkspaceSelectorOpen}
        />
      </Center>
    )
  );
}
