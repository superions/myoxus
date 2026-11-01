/**
 * @file lazy.ts — @myoxus/routes
 *
 * Utility for code-splitting route components using React's `lazy` API.
 *
 * Wraps `React.lazy` to handle both default exports and single named exports,
 * and automatically wraps the result in a `<Suspense>` boundary so that
 * call-sites do not need to add one manually.
 */

import React, {
  type ComponentProps,
  type ComponentType,
  lazy as reactLazy,
  Suspense,
} from "react";

/**
 * Creates a lazily-loaded route component wrapped in a `<Suspense>` boundary.
 *
 * The `factory` function must return a module with a `default` export, the
 * route-module convention `Component` export, or a single named export.  The
 * explicit `Component` path keeps admin/web route modules deterministic even
 * when they also export helper constants for tests or sub-routes.
 *
 * @param factory  - A dynamic `import()` call that resolves to the component module.
 * @param fallback - Optional React node rendered while the module is loading.
 *
 * @example
 * ```tsx
 * const DashboardPage = lazy(() => import('./dashboard'));
 * // <DashboardPage /> renders a Suspense boundary automatically
 * ```
 */
export function lazy<T extends ComponentType<any>>(
  factory: () => Promise<Record<any, T>>,
  fallback?: React.ReactNode,
) {
  const LazyComponent = reactLazy(() =>
    factory().then((mod) => resolveLazyRouteModule(mod)),
  );

  return function LazyRoute(props: ComponentProps<T>) {
    return React.createElement(
      Suspense,
      {
        fallback,
      },
      React.createElement(LazyComponent, props),
    );
  };
}

export function resolveLazyRouteModule<T extends ComponentType<any>>(
  mod: Record<PropertyKey, T>,
): { default: T } {
  if ("default" in mod) {
    return { default: mod.default };
  }

  if ("Component" in mod) {
    return { default: mod.Component };
  }

  const components = Object.values(mod);
  if (components.length > 1) {
    console.warn("Lazy loaded module has more than one export");
  }

  return {
    default: components[0],
  };
}
