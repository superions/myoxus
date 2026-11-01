/**
 * 404 / Not Found page.
 *
 * Handles two variants controlled by the `noPermission` prop:
 *
 * - **Not found** (`noPermission = false`): generic 404 page with a back
 *   button that navigates to the workspace index.
 * - **No permission / unauthenticated** (`noPermission = true`): shows either
 *   an inline sign-in panel (when not logged in to any server) or a
 *   "no permission" message with sign-out option (when logged in but lacking
 *   access). The current URL is passed as `redirectUrl` so the user is
 *   returned to the target page after signing in.
 *
 * Server scope: components are wrapped in the `FrameworkScope` of the first
 * server that has an active session so that account-aware UI can resolve
 * services correctly.
 *
 * The legacy PageNotFound sign-in variant is browser-oriented. Shared Workbench
 * status components below also serve Electron, including top-level recovery.
 */
import { getArtworkUrl } from "@myoxus/theme/artwork";
import { useSignOut } from "@myoxus/core/components/hooks/myoxus/use-sign-out";
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import {
  ViewBody,
  ViewHeader,
} from "@myoxus/core/modules/workbench/view/view-islands";
import {
  ViewIcon,
  ViewTitle,
} from "@myoxus/core/modules/workbench/view/view-meta";
import type { ViewIconName } from "@myoxus/core/modules/workbench/constants";
import { useI18n } from "@myoxus/i18n";
import { AlertTriangleIcon, LockIcon, PageIcon } from "@myoxus/icons/react";
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServiceOptional,
} from "@myoxus/infra";
import {
  Button,
  DialogFooterActions,
  EmptyState,
  ThemedImg,
  EmptyStateTitle,
  Loading,
  NoPermissionOrNotFound,
  NotFoundPage,
  PageContentRail,
  WorkbenchHeaderFrame,
  WorkbenchHeaderTitle,
  WorkbenchRouteHeader,
  WorkbenchRouteHeaderSlot,
  WorkbenchRouteRoot,
  WorkbenchRouteSurface,
} from "@myoxus/ui-facade";
import {
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
} from "react";
import { useRouteError } from "react-router";

import {
  RouteLogic,
  useNavigateHelper,
} from "../../../components/hooks/use-navigate-helper";
import { ServersService } from "../../../modules/server";
import { SignIn } from "../auth/sign-in";

// Keep the native shell's workspace/editor graph out of ordinary status consumers.
const ElectronAppContainer = lazy(() =>
  import("../../components/app-container").then(({ AppContainer }) => ({
    default: AppContainer,
  })),
);

type WorkbenchRouteStatusProps = {
  title: string;
  description?: string;
  icon: ReactNode;
  viewIcon: ViewIconName;
  actions?: ReactNode;
  status: "loading" | "not-found" | "access-denied" | "error";
};

const WorkbenchRouteStatusContent = ({
  title,
  description,
  icon,
  actions,
  status,
}: Omit<WorkbenchRouteStatusProps, "viewIcon">) => (
  <PageContentRail centerContent fill width="content">
    <EmptyState
      media={
        <ThemedImg
          fluid
          alt=""
          lightSrc={getArtworkUrl(
            status === "error"
              ? "server-error"
              : status === "access-denied"
                ? "access-denied"
                : status === "loading"
                  ? "loading"
                  : "not-found",
          )}
        />
      }
      title={<EmptyStateTitle icon={icon}>{title}</EmptyStateTitle>}
      description={description}
      cta={actions}
      data-testid={`workbench-route-${status}`}
    />
  </PageContentRail>
);

/** A terminal or transitional state rendered through the active View islands. */
export const WorkbenchRouteStatus = ({
  title,
  description,
  icon,
  viewIcon,
  actions,
  status,
}: WorkbenchRouteStatusProps) => {
  const viewService = useServiceOptional(ViewService);
  if (!viewService) {
    return (
      <WorkbenchRouteStatusShell
        title={title}
        description={description}
        icon={icon}
        actions={actions}
        status={status}
      />
    );
  }

  return (
    <>
      <ViewTitle title={title} />
      <ViewIcon icon={viewIcon} />
      <ViewHeader>
        <WorkbenchHeaderFrame
          title={<WorkbenchHeaderTitle>{title}</WorkbenchHeaderTitle>}
        />
      </ViewHeader>
      <ViewBody>
        <WorkbenchRouteStatusContent
          title={title}
          description={description}
          icon={icon}
          actions={actions}
          status={status}
        />
      </ViewBody>
    </>
  );
};

function WorkbenchRouteStatusShell({
  title,
  description,
  icon,
  actions,
  status,
}: Omit<WorkbenchRouteStatusProps, "viewIcon">) {
  const content = (
    <WorkbenchRouteRoot data-myoxus-ui-role={`workbench-route-${status}-shell`}>
      <WorkbenchRouteHeader>
        <WorkbenchRouteHeaderSlot>
          <WorkbenchHeaderFrame
            title={<WorkbenchHeaderTitle>{title}</WorkbenchHeaderTitle>}
          />
        </WorkbenchRouteHeaderSlot>
      </WorkbenchRouteHeader>
      <WorkbenchRouteSurface>
        <WorkbenchRouteStatusContent
          title={title}
          description={description}
          icon={icon}
          actions={actions}
          status={status}
        />
      </WorkbenchRouteSurface>
    </WorkbenchRouteRoot>
  );
  // Without a Workbench, Electron still needs its tab clearance and layout-ready signal.
  return BUILD_CONFIG.isElectron ? (
    <Suspense fallback={content}>
      <ElectronAppContainer>{content}</ElectronAppContainer>
    </Suspense>
  ) : (
    content
  );
}

export const WorkbenchRouteLoading = () => {
  const t = useI18n();
  return (
    <WorkbenchRouteStatus
      title={t["com.myoxus.loading"]()}
      description={t["com.myoxus.loading.description"]()}
      icon={<Loading />}
      viewIcon="doc"
      status="loading"
    />
  );
};

export const WorkbenchRouteHydrationFallback = () => {
  const t = useI18n();
  return (
    <WorkbenchRouteStatusShell
      title={t["com.myoxus.loading"]()}
      description={t["com.myoxus.loading.description"]()}
      icon={<Loading />}
      status="loading"
    />
  );
};

export const WorkbenchRouteNotFound = () => {
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();
  return (
    <WorkbenchRouteStatus
      title={t["com.myoxus.notFoundPage.title"]()}
      description={t["com.myoxus.workbench.route.not-found.description"]()}
      icon={<PageIcon />}
      viewIcon="doc"
      status="not-found"
      actions={
        <DialogFooterActions>
          <Button onClick={() => jumpToIndex(RouteLogic.REPLACE)}>
            {t["com.myoxus.notFoundPage.backButton"]()}
          </Button>
        </DialogFooterActions>
      }
    />
  );
};

export const WorkbenchRouteAccessDenied = () => {
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();
  return (
    <WorkbenchRouteStatus
      title={t["com.myoxus.no-permission"]()}
      description={t["com.myoxus.workbench.route.access-denied.description"]()}
      icon={<LockIcon />}
      viewIcon="doc"
      status="access-denied"
      actions={
        <DialogFooterActions>
          <Button onClick={() => jumpToIndex(RouteLogic.REPLACE)}>
            {t["com.myoxus.notFoundPage.backButton"]()}
          </Button>
        </DialogFooterActions>
      }
    />
  );
};

export const WorkbenchRouteError = () => {
  useRouteError();
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();
  return (
    <WorkbenchRouteStatusShell
      title={t["com.myoxus.workbench.route.error.title"]()}
      description={t["com.myoxus.workbench.route.error.description"]()}
      icon={<AlertTriangleIcon />}
      status="error"
      actions={
        <DialogFooterActions>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {t["Retry"]()}
          </Button>
          <Button onClick={() => jumpToIndex(RouteLogic.REPLACE)}>
            {t["com.myoxus.notFoundPage.backButton"]()}
          </Button>
        </DialogFooterActions>
      }
    />
  );
};

/**
 * Page not found / no permission component.
 *
 * Renders the appropriate error UI based on the user's authentication state
 * and the `noPermission` flag. Checks all configured servers for active
 * sessions so that multi-server setups are handled correctly.
 *
 * @param noPermission - When `true` shows the "no permission" variant with
 *   an optional inline sign-in panel. When `false` (default) shows the
 *   generic 404 page.
 *
 * @remarks Only for web; should not be used in Electron.
 */
export const PageNotFound = ({
  noPermission,
}: {
  noPermission?: boolean;
}): ReactElement => {
  const serversService = useService(ServersService);
  const serversWithAccount = useLiveData(serversService.serversWithAccount$);

  const desktopApi = useServiceOptional(DesktopApiService);

  // Check all servers for any logged in accounts to avoid showing sign-in page if user has an active session on any server
  const firstLogged = serversWithAccount.find(
    ({ account }) => account !== null,
  );
  const { jumpToIndex } = useNavigateHelper();
  const openSignOutModal = useSignOut();

  const handleBackButtonClick = useCallback(
    () => jumpToIndex(RouteLogic.REPLACE),
    [jumpToIndex],
  );

  useEffect(() => {
    desktopApi?.handler.ui.pingAppLayoutReady().catch(console.error);
  }, [desktopApi]);

  // not using workbench location or router location deliberately
  // strip the origin
  const currentUrl = window.location.href.replace(window.location.origin, "");

  return (
    <FrameworkScope scope={firstLogged?.server.scope}>
      {noPermission ? (
        <NoPermissionOrNotFound
          user={firstLogged?.account}
          onBack={handleBackButtonClick}
          onSignOut={openSignOutModal}
          signInComponent={<SignIn redirectUrl={currentUrl} />}
        />
      ) : (
        <NotFoundPage
          user={firstLogged?.account}
          onBack={handleBackButtonClick}
          onSignOut={openSignOutModal}
        />
      )}
    </FrameworkScope>
  );
};

export const Component = () => {
  return <WorkbenchRouteNotFound />;
};
