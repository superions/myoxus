// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useSignOut } from "@myoxus/core/components/hooks/myoxus/use-sign-out";
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import type { ViewIconName } from "@myoxus/core/modules/workbench/constants";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import {
  ViewBody,
  ViewHeader,
} from "@myoxus/core/modules/workbench/view/view-islands";
import {
  ViewIcon,
  ViewTitle,
} from "@myoxus/core/modules/workbench/view/view-meta";
import { useI18n } from "@myoxus/i18n";
import { AlertTriangleIcon, LockIcon, PageIcon } from "@myoxus/icons/react";
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServiceOptional,
} from "@myoxus/infra";
import { getArtworkUrl } from "@myoxus/theme/artwork";
import {
  Button,
  DialogFooterActions,
  EmptyState,
  EmptyStateTitle,
  Loading,
  NoPermissionOrNotFound,
  NotFoundPage,
  PageContentRail,
  ThemedImg,
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

const ElectronAppContainer = lazy(async () => ({
  default: (await import("../../components/app-container")).AppContainer,
}));

type RouteStatusKind = "loading" | "not-found" | "access-denied" | "error";

const STATUS_ARTWORK = {
  error: "server-error",
  "access-denied": "access-denied",
  loading: "loading",
  "not-found": "not-found",
} as const;

export interface WorkbenchRouteStatusProps {
  title: string;
  description?: string;
  icon: ReactNode;
  viewIcon: ViewIconName;
  actions?: ReactNode;
  status: RouteStatusKind;
}

function StatusBody({
  title,
  description,
  icon,
  actions,
  status,
}: Omit<WorkbenchRouteStatusProps, "viewIcon">) {
  return (
    <PageContentRail centerContent fill width="content">
      <EmptyState
        media={
          <ThemedImg
            fluid
            alt=""
            lightSrc={getArtworkUrl(STATUS_ARTWORK[status])}
          />
        }
        title={<EmptyStateTitle icon={icon}>{title}</EmptyStateTitle>}
        description={description}
        cta={actions}
        data-testid={`workbench-route-${status}`}
      />
    </PageContentRail>
  );
}

function StatusStandaloneShell({
  title,
  description,
  icon,
  actions,
  status,
}: Omit<WorkbenchRouteStatusProps, "viewIcon">) {
  const shell = (
    <WorkbenchRouteRoot data-myoxus-ui-role={`workbench-route-${status}-shell`}>
      <WorkbenchRouteHeader>
        <WorkbenchRouteHeaderSlot>
          <WorkbenchHeaderFrame
            title={<WorkbenchHeaderTitle>{title}</WorkbenchHeaderTitle>}
          />
        </WorkbenchRouteHeaderSlot>
      </WorkbenchRouteHeader>
      <WorkbenchRouteSurface>
        <StatusBody
          title={title}
          description={description}
          icon={icon}
          actions={actions}
          status={status}
        />
      </WorkbenchRouteSurface>
    </WorkbenchRouteRoot>
  );

  // Outside a Workbench, Electron still requires AppContainer for tab clearance
  // and the layout-ready signal.
  return BUILD_CONFIG.isElectron ? (
    <Suspense fallback={shell}>
      <ElectronAppContainer>{shell}</ElectronAppContainer>
    </Suspense>
  ) : (
    shell
  );
}

export function WorkbenchRouteStatus({
  title,
  description,
  icon,
  viewIcon,
  actions,
  status,
}: WorkbenchRouteStatusProps) {
  const viewService = useServiceOptional(ViewService);
  if (!viewService) {
    return (
      <StatusStandaloneShell
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
        <StatusBody
          title={title}
          description={description}
          icon={icon}
          actions={actions}
          status={status}
        />
      </ViewBody>
    </>
  );
}

export function WorkbenchRouteLoading() {
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
}

export function WorkbenchRouteHydrationFallback() {
  const t = useI18n();
  return (
    <StatusStandaloneShell
      title={t["com.myoxus.loading"]()}
      description={t["com.myoxus.loading.description"]()}
      icon={<Loading />}
      status="loading"
    />
  );
}

export function WorkbenchRouteNotFound() {
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
}

export function WorkbenchRouteAccessDenied() {
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
}

export function WorkbenchRouteError() {
  useRouteError();
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();
  return (
    <StatusStandaloneShell
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
}

export function PageNotFound({
  noPermission,
}: {
  noPermission?: boolean;
}): ReactElement {
  const serversService = useService(ServersService);
  const serversWithAccount = useLiveData(serversService.serversWithAccount$);
  const desktopApi = useServiceOptional(DesktopApiService);
  const { jumpToIndex } = useNavigateHelper();
  const openSignOutModal = useSignOut();

  const firstLogged = serversWithAccount.find(
    ({ account }) => account !== null,
  );
  const handleBack = useCallback(
    () => jumpToIndex(RouteLogic.REPLACE),
    [jumpToIndex],
  );

  useEffect(() => {
    desktopApi?.handler.ui.pingAppLayoutReady().catch(console.error);
  }, [desktopApi]);

  const currentUrl = window.location.href.replace(window.location.origin, "");

  return (
    <FrameworkScope scope={firstLogged?.server.scope}>
      {noPermission ? (
        <NoPermissionOrNotFound
          user={firstLogged?.account}
          onBack={handleBack}
          onSignOut={openSignOutModal}
          signInComponent={<SignIn redirectUrl={currentUrl} />}
        />
      ) : (
        <NotFoundPage
          user={firstLogged?.account}
          onBack={handleBack}
          onSignOut={openSignOutModal}
        />
      )}
    </FrameworkScope>
  );
}

export function Component() {
  return <WorkbenchRouteNotFound />;
}
