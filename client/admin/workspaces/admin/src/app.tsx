// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getOrCreateI18n, I18nextProvider } from "@myoxus/i18n";
import { lazy, ROUTES } from "@myoxus/routes";
import { Center, Loading } from "@myoxus/ui-facade";
import { withSentryReactRouterV7Routing } from "@sentry/react";
import type { ReactElement } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes as RouterRoutes,
  useLocation,
  useParams,
} from "react-router";
import { SWRConfig } from "swr";

import {
  AdminSessionInvalidationBridge,
  useAdminSessionSnapshot,
} from "./admin-session";
import {
  AppErrorBoundary,
  PageErrorBoundary,
} from "./components/error-boundary";
import { ThemeProvider } from "./components/theme-provider";
import { NoAdminAccess } from "./modules/auth/no-admin-access";
import { buildAdminSignInUrl } from "./modules/auth/redirect";
import { SharedSignInRedirect } from "./modules/auth/shared-sign-in-redirect";
import { BrandingAccentThemeSync } from "./modules/branding/accent-theme";
import {
  AdminBootstrapLocaleSync,
  AdminLocaleSync,
} from "./modules/branding/admin-locale-sync";
import { isAdmin, useCurrentUser, useServerConfig } from "./modules/common";
import { Layout } from "./modules/layout";

const pageLoading = (
  <Center data-myoxus-ui-role="admin-page-loading">
    <Loading />
  </Center>
);

const SetupPage = lazy(() => import("./modules/setup"));
const ConfigWizardPage = lazy(
  () => import("./modules/config-wizard"),
  pageLoading,
);
const SecurityPage = lazy(() => import("./modules/security"), pageLoading);
const DashboardPage = lazy(() => import("./modules/dashboard"), pageLoading);
const WorkspacesPage = lazy(() => import("./modules/workspaces"), pageLoading);
const QueuePage = lazy(() => import("./modules/queue"), pageLoading);
const GitSyncPage = lazy(() => import("./modules/git-sync"), pageLoading);
const TemplatesPage = lazy(() => import("./modules/templates"), pageLoading);
const DocumentsPage = lazy(() => import("./modules/documents"), pageLoading);
const PdfExportPage = lazy(() => import("./modules/pdf-export"), pageLoading);
const AiPage = lazy(() => import("./modules/ai"), pageLoading);
const SystemPage = lazy(() => import("./modules/system"), pageLoading);
const AuthPage = lazy(() => import("./modules/auth"));
const OrganizationPage = lazy(
  () => import("./modules/organization"),
  pageLoading,
);
const DesignPage = lazy(() => import("./modules/design"), pageLoading);
const TypographyPage = lazy(() => import("./modules/typography"), pageLoading);
const StoragePage = lazy(() => import("./modules/storage"), pageLoading);
const PerformancePage = lazy(
  () => import("./modules/performance"),
  pageLoading,
);
const AuditLogPage = lazy(() => import("./modules/audit-log"), pageLoading);

const Routes = window.SENTRY_RELEASE
  ? withSentryReactRouterV7Routing(RouterRoutes)
  : RouterRoutes;

type AdminRoute = { path: string; element: ReactElement };

const authenticatedPages: AdminRoute[] = [
  { path: ROUTES.admin.dashboard, element: <DashboardPage /> },
  { path: ROUTES.admin.security, element: <SecurityPage /> },
  { path: ROUTES.admin.workspaces, element: <WorkspacesPage /> },
  { path: `${ROUTES.admin.queue}/*`, element: <QueuePage /> },
  { path: ROUTES.admin.gitSync, element: <GitSyncPage /> },
  { path: ROUTES.admin.templates, element: <TemplatesPage /> },
  { path: ROUTES.admin.documents, element: <DocumentsPage /> },
  { path: ROUTES.admin.pdfExport, element: <PdfExportPage /> },
  { path: ROUTES.admin.organization.index, element: <OrganizationPage /> },
  {
    path: ROUTES.admin.organization.organigram,
    element: <OrganizationPage defaultTab="organigram" />,
  },
  { path: ROUTES.admin.design, element: <DesignPage /> },
  { path: ROUTES.admin.typography, element: <TypographyPage /> },
  { path: ROUTES.admin.storage, element: <StoragePage /> },
  { path: ROUTES.admin.performance, element: <PerformancePage /> },
  { path: ROUTES.admin.ai, element: <AiPage /> },
  { path: ROUTES.admin.auditLog, element: <AuditLogPage /> },
  { path: ROUTES.admin.system, element: <SystemPage /> },
];

const compatibilityRedirects: AdminRoute[] = [
  {
    path: "/adminfrontend/accounts",
    element: (
      <Navigate to={`${ROUTES.admin.organization.index}?tab=members`} replace />
    ),
  },
  {
    path: "/adminfrontend/logging",
    element: <Navigate to={`${ROUTES.admin.system}?tab=logging`} replace />,
  },
  {
    path: "/adminfrontend/orphaned-workspaces",
    element: <Navigate to={`${ROUTES.admin.storage}?tab=orphaned`} replace />,
  },
  {
    path: ROUTES.admin.configChanges,
    element: <Navigate to={ROUTES.admin.auditLog} replace />,
  },
  {
    path: "/adminfrontend/about",
    element: <Navigate to={ROUTES.admin.system} replace />,
  },
];

function AuthenticatedAdmin({ fullscreen = false }: { fullscreen?: boolean }) {
  const user = useCurrentUser();
  const session = useAdminSessionSnapshot();
  const location = useLocation();

  // Session invalidation clears private SWR data. It must win over the
  // resulting undefined user, otherwise logout gets stuck on the loader.
  if (session.invalidated || user === null) {
    const returnPath = `${location.pathname}${location.search}${location.hash}`;
    return <SharedSignInRedirect to={buildAdminSignInUrl(returnPath)} />;
  }
  if (user === undefined) return pageLoading;
  if (!isAdmin(user)) return <NoAdminAccess />;

  const page = (
    <PageErrorBoundary key={location.pathname}>
      <Outlet />
    </PageErrorBoundary>
  );

  return (
    <>
      <BrandingAccentThemeSync />
      <AdminLocaleSync />
      {fullscreen ? page : <Layout>{page}</Layout>}
    </>
  );
}

function InitializedAdmin() {
  const config = useServerConfig();
  const location = useLocation();

  if (!config) return pageLoading;
  if (!config.initialized && location.pathname !== ROUTES.admin.setup) {
    return <Navigate to={ROUTES.admin.setup} replace />;
  }
  if (/^\/adminfrontend\/?$/.test(location.pathname)) {
    return <Navigate to={ROUTES.admin.dashboard} replace />;
  }
  return <Outlet />;
}

function OrganizationUnitPage() {
  const { id } = useParams<{ id: string }>();
  return <OrganizationPage defaultTab="units" focusUnitId={id ?? null} />;
}

const i18n = getOrCreateI18n();

export function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AppErrorBoundary>
          <SWRConfig value={{ revalidateOnFocus: false }}>
            <AdminSessionInvalidationBridge />
            <BrowserRouter basename={environment.subPath}>
              <AdminBootstrapLocaleSync />
              <Routes>
                <Route path={ROUTES.admin.index} element={<InitializedAdmin />}>
                  <Route path={ROUTES.admin.auth} element={<AuthPage />} />
                  <Route path={ROUTES.admin.setup} element={<SetupPage />} />
                  {/* Wizard writes require the same session/feature guard as
                      normal Admin routes, without their navigation shell. */}
                  <Route element={<AuthenticatedAdmin fullscreen />}>
                    <Route
                      path={ROUTES.admin.configWizard}
                      element={<ConfigWizardPage />}
                    />
                  </Route>
                  <Route element={<AuthenticatedAdmin />}>
                    {authenticatedPages.map((route) => (
                      <Route key={route.path} {...route} />
                    ))}
                    <Route
                      path={ROUTES.admin.organization.unit}
                      element={<OrganizationUnitPage />}
                    />
                    {compatibilityRedirects.map((route) => (
                      <Route key={route.path} {...route} />
                    ))}
                  </Route>
                </Route>
              </Routes>
            </BrowserRouter>
          </SWRConfig>
        </AppErrorBoundary>
      </ThemeProvider>
    </I18nextProvider>
  );
}
