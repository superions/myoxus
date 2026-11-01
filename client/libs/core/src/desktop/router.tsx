/**
 * Desktop / browser router configuration.
 *
 * Defines the top-level React Router v7 route tree used by both the web app
 * (`client/web`) and the Electron renderer. All routes are lazily loaded via
 * dynamic `import()` to keep the initial bundle small.
 *
 * Key concepts:
 * - `RootRouter` — thin wrapper that injects the router's navigate function
 *   into `NavigateContext` so
 *   imperative navigation helpers work outside of React Router's own context.
 * - `topLevelRoutes` — the full route manifest. Routes that share a webpack
 *   chunk are co-annotated with `webpackChunkName` magic comments (auth pages).
 * - `router` — the singleton browser router instance; wraps
 *   `createBrowserRouter` with Sentry instrumentation when a Sentry release is
 *   detected, otherwise falls back to the plain React Router implementation.
 */
import { wrapCreateBrowserRouterV7 } from "@sentry/react";
import {
  createBrowserRouter as reactRouterCreateBrowserRouter,
  redirect,
  type RouteObject,
  useNavigate,
} from "react-router";

import { NavigateContext } from "../components/hooks/use-navigate-helper";
import { MyoxusErrorComponent } from "../components/myoxus/myoxus-error-boundary/myoxus-error-fallback";
import { loadWorkspaceFeatures } from "../modules/workspace-feature-loader";
import { AppContainer } from "./components/app-container";
import { RootWrapper } from "./pages/root";
import {
  CATCH_ALL_ROUTE_PATH,
  getWorkspaceDocPath,
  NOT_FOUND_ROUTE_PATH,
  SHARE_ROUTE_PATH,
  WORKSPACE_ROUTE_PATH,
} from "./route-paths";

/**
 * Top-level router wrapper component.
 *
 * Places the active router's `navigate` function into
 * `NavigateContext` so that imperative navigation helpers (`useNavigateHelper`)
 * can be called from anywhere in the tree. Because this component is itself a
 * route element, `useNavigate` is available on its first render; delaying the
 * provider would turn valid hard navigations into a blank first paint.
 */
export function RootRouter() {
  const navigate = useNavigate();

  return (
    <NavigateContext.Provider value={navigate}>
      <RootWrapper />
    </NavigateContext.Provider>
  );
}

/**
 * Full application route manifest.
 *
 * Every entry that sets `lazy` is code-split: the module is only fetched when
 * the user first navigates to that path. Auth-related routes share a single
 * webpack chunk (`auth`) to avoid extra round-trips during the sign-in flow.
 *
 * Notable entries:
 * - `/`                    — workspace index / home page
 * - `/workspace/:id/*`     — main workspace shell (loads workspace pages)
 * - `/share/:id/:pageId`   — legacy share URL, redirected to canonical path
 * - `/auth/:authType`      — polymorphic auth page (sign-up, change-password…)
 * - `/sign-In`             — dedicated sign-in page
 * - `/redirect-proxy`      — server-side CSP-safe redirect target
 * - `/template/preview`    — redirects to the doc preview with template params
 * - `/try-cloud`           — marketing entry point, redirects to sign-in
 */
export const topLevelRoutes = [
  {
    element: <RootRouter />,
    errorElement: <MyoxusErrorComponent />,
    // React Router v7 requires a HydrateFallback on the root route; without it
    // async resolution of the lazy child routes during initial hydration leaves
    // the screen blank. Mirrors the v6 `fallbackElement={<AppContainer fallback />}`.
    hydrateFallbackElement: <AppContainer fallback />,
    children: [
      {
        path: "/",
        lazy: () => import("./pages/index"),
      },
      {
        path: WORKSPACE_ROUTE_PATH,
        lazy: async () => {
          const [, route] = await Promise.all([
            loadWorkspaceFeatures(),
            import("./pages/workspace/index"),
          ]);
          return route;
        },
      },
      {
        path: SHARE_ROUTE_PATH,
        loader: ({ params }) => {
          return redirect(
            getWorkspaceDocPath(params.workspaceId ?? "", params.pageId ?? ""),
          );
        },
      },
      {
        path: NOT_FOUND_ROUTE_PATH,
        lazy: () => import("./pages/404"),
      },
      {
        path: "/expired",
        lazy: () => import("./pages/expired"),
      },
      {
        path: "/invite/:inviteId",
        lazy: () => import("./pages/invite"),
      },
      {
        path: "/onboarding",
        lazy: () => import("./pages/onboarding"),
      },
      {
        path: "/redirect-proxy",
        lazy: () => import("./pages/redirect"),
      },
      {
        path: "/try-cloud",
        loader: () => {
          return redirect(
            `/sign-in?redirect_uri=${encodeURIComponent("/?initCloud=true")}`,
          );
        },
      },
      {
        path: "/template/import",
        lazy: () => import("./pages/import-template"),
      },
      {
        path: "/template/preview",
        loader: ({ request }) => {
          const url = new URL(request.url);
          const workspaceId = url.searchParams.get("workspaceId");
          const docId = url.searchParams.get("docId");
          const templateName = url.searchParams.get("name");
          const templateMode = url.searchParams.get("mode");
          const snapshotUrl = url.searchParams.get("snapshotUrl");

          return redirect(
            `/workspace/${workspaceId}/${docId}?${new URLSearchParams({
              isTemplate: "true",
              templateName: templateName ?? "",
              snapshotUrl: snapshotUrl ?? "",
              mode: templateMode ?? "page",
            }).toString()}`,
          );
        },
      },
      {
        path: "/auth/:authType",
        lazy: () => import(/* webpackChunkName: "auth" */ "./pages/auth/auth"),
      },
      {
        path: "/sign-In",
        lazy: () =>
          import(/* webpackChunkName: "auth" */ "./pages/auth/sign-in"),
      },
      {
        path: "/magic-link",
        lazy: () =>
          import(/* webpackChunkName: "auth" */ "./pages/auth/magic-link"),
      },
      {
        path: "/oauth/login",
        lazy: () =>
          import(/* webpackChunkName: "auth" */ "./pages/auth/oauth-login"),
      },
      {
        path: "/oauth/callback",
        lazy: () =>
          import(/* webpackChunkName: "auth" */ "./pages/auth/oauth-callback"),
      },
      // deprecated, keep for old client compatibility
      // TODO(@forehalo): remove
      {
        path: "/desktop-signin",
        lazy: () =>
          import(/* webpackChunkName: "auth" */ "./pages/auth/oauth-login"),
      },
      // deprecated, keep for old client compatibility
      // use '/sign-in'
      // TODO(@forehalo): remove
      {
        path: "/signIn",
        lazy: () =>
          import(/* webpackChunkName: "auth" */ "./pages/auth/sign-in"),
      },
      {
        path: "/open-app/:action",
        lazy: () => import("./pages/open-app"),
      },
      {
        path: CATCH_ALL_ROUTE_PATH,
        lazy: () => import("./pages/404"),
      },
    ],
  },
] satisfies [RouteObject, ...RouteObject[]];

/**
 * Sentry-instrumented `createBrowserRouter` factory.
 *
 * When `window.SENTRY_RELEASE` is set (production builds) this wraps the
 * router to automatically create Sentry performance transactions for each
 * navigation. In development the plain React Router implementation is used
 * to avoid unnecessary overhead.
 */
const createBrowserRouter = wrapCreateBrowserRouterV7(
  reactRouterCreateBrowserRouter,
);

/**
 * Singleton browser router instance consumed by the `<RouterProvider>` in
 * `app.tsx`. The `basename` is read from the build-time `environment.subPath`
 * so the app can be hosted at a sub-path (e.g. `/affine/`).
 */
export const router = (
  window.SENTRY_RELEASE ? createBrowserRouter : reactRouterCreateBrowserRouter
)(topLevelRoutes, {
  basename: environment.subPath,
});
