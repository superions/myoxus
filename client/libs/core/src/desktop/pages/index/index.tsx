/**
 * Application index / home page (`/`).
 *
 * Acts as a smart workspace redirector and handles first-launch setup:
 *
 * **Normal navigation flow**:
 * 1. Waits for the workspace list to finish loading.
 * 2. If `enableLocalWorkspace` is false and the user is not logged in,
 *    redirects to the sign-in page.
 * 3. If `?initCloud=true` is present (arrived from the "Try Cloud" marketing
 *    page), creates or opens the user's first cloud workspace.
 * 4. Otherwise opens the last-visited workspace (read from `localStorage`) or
 *    the first workspace in the list.
 *
 * **First-launch** (no workspaces at all, local workspaces enabled):
 * Calls `createFirstAppData` which creates a local workspace with a showcase
 * document and immediately navigates to it.
 *
 * While navigating or creating a workspace a loading fallback is shown to
 * prevent a flash of the empty workspace selector.
 *
 * After the layout is ready in Electron, `pingAppLayoutReady` is called to
 * unblock the native loading overlay.
 *
 * @param defaultIndexRoute - Sub-route to navigate to inside the workspace
 *   (defaults to `"home"` — the workspace dashboard).
 * @param children - Optional override for the "no workspaces" empty state.
 * @param fallback - Optional override for the loading skeleton.
 */
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { DefaultServerService } from "@myoxus/core/modules/server";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import {
  buildShowcaseWorkspace,
  createFirstAppData,
} from "@myoxus/core/utils/first-app-data";
import { ServerFeature } from "@myoxus/graphql";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
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

/**
 * index page
 *
 * query string:
 * - initCloud: boolean, if true, when user is logged in, create a cloud workspace
 */
export const Component = ({
  defaultIndexRoute = "home",
  children,
  fallback,
}: {
  defaultIndexRoute?: string;
  children?: ReactNode;
  fallback?: ReactNode;
}) => {
  // navigating and creating may be slow, to avoid flickering, we show workspace fallback
  const [navigating, setNavigating] = useState(true);
  const [creating, setCreating] = useState(false);
  const [workspaceSelectorOpen, setWorkspaceSelectorOpen] = useState(true);
  const authService = useService(AuthService);
  const dialogs = useLiveData(useService(GlobalDialogService).dialogs$);
  const defaultServerService = useService(DefaultServerService);

  const loggedIn = useLiveData(
    authService.session.status$.map((s) => s === "authenticated"),
  );
  const enableLocalWorkspace =
    useLiveData(
      defaultServerService.server.config$.selector(
        (c) =>
          canUseLocalWorkspaces() &&
          (c.features.includes(ServerFeature.LocalWorkspace) ||
            BUILD_CONFIG.isNative),
      ),
    ) ?? canUseLocalWorkspaces();

  const workspacesService = useService(WorkspacesService);
  const list = useLiveData(workspacesService.list.workspaces$);
  const listIsLoading = useLiveData(workspacesService.list.isRevalidating$);

  const { openPage, jumpToPage, jumpToSignIn } = useNavigateHelper();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const createOnceRef = useRef(false);
  const consumedRedirectRef = useRef<string | null>(null);

  const createCloudWorkspace = useCallback(() => {
    if (createOnceRef.current) return;
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
      .catch((err) => console.error("Failed to create cloud workspace", err));
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

    // Capture the one-shot route before workspace revalidation can outlive
    // its delivery cookie; keep it in the existing ref while the list loads.
    const redirectedWorkspacePath =
      consumedRedirectRef.current ?? consumeWorkspaceRedirectCookie();
    consumedRedirectRef.current = redirectedWorkspacePath;

    if (listIsLoading) {
      return;
    }

    if (!enableLocalWorkspace && !loggedIn) {
      localStorage.removeItem("last_workspace_id");
      jumpToSignIn(redirectedWorkspacePath ?? undefined, RouteLogic.REPLACE);
      return;
    }

    if (redirectedWorkspacePath) {
      // `/workspace/*` is redirected to `/` by nginx to keep the web storage
      // worker stable on hard reloads. The cookie is the one-shot handoff that
      // restores the original deep-link as SPA navigation.
      navigate(redirectedWorkspacePath, { replace: true });
      return;
    }

    // check is user logged in && has cloud workspace
    if (searchParams.get("initCloud") === "true") {
      if (loggedIn) {
        if (list.every((w) => w.flavour !== defaultServerService.server.id)) {
          createCloudWorkspace();
          return;
        }

        // open first cloud workspace
        const openWorkspace =
          list.find((w) => w.flavour === defaultServerService.server.id) ??
          list[0];
        openPage(openWorkspace.id, defaultIndexRoute);
      } else {
        return;
      }
    } else {
      if (list.length === 0) {
        setNavigating(false);
        return;
      }
      // open last workspace
      const lastId = localStorage.getItem("last_workspace_id");

      const openWorkspace = selectDefaultWorkspace(list, lastId);
      if (openWorkspace) {
        openPage(openWorkspace.id, defaultIndexRoute, RouteLogic.REPLACE);
      }
    }
  }, [
    enableLocalWorkspace,
    createCloudWorkspace,
    list,
    openPage,
    searchParams,
    jumpToSignIn,
    listIsLoading,
    loggedIn,
    navigating,
    navigate,
    defaultIndexRoute,
  ]);

  const desktopApi = useServiceOptional(DesktopApiService);

  useEffect(() => {
    desktopApi?.handler.ui.pingAppLayoutReady().catch(console.error);
  }, [desktopApi]);

  useEffect(() => {
    if (listIsLoading || list.length > 0 || !enableLocalWorkspace) {
      return;
    }

    createFirstAppData(workspacesService)
      .then((createdWorkspace) => {
        if (createdWorkspace) {
          if (createdWorkspace.defaultPageId) {
            jumpToPage(
              createdWorkspace.meta.id,
              createdWorkspace.defaultPageId,
            );
          } else {
            openPage(createdWorkspace.meta.id, "home");
          }
        }
      })
      .catch((err) => {
        console.error("Failed to create first app data", err);
      })
      .finally(() => {
        setCreating(false);
      });
  }, [
    jumpToPage,
    jumpToSignIn,
    openPage,
    workspacesService,
    loggedIn,
    listIsLoading,
    list,
    enableLocalWorkspace,
  ]);

  if (navigating || creating) {
    return fallback ?? <AppContainer fallback />;
  }

  // TODO(@eyhn): We need a no workspace page
  return (
    children ?? (
      <div
        style={{
          position: "fixed",
          left: "calc(50% - 150px)",
          top: "50%",
        }}
      >
        {/* Keep the visible opener mounted while a global dialog owns focus. */}
        <WorkspaceNavigator
          open={workspaceSelectorOpen && dialogs.length === 0}
          onOpenChange={setWorkspaceSelectorOpen}
        />
      </div>
    )
  );
};
