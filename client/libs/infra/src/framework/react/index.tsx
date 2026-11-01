/**
 * @file index.tsx — React bindings for the @myoxus/infra DI framework
 *
 * Provides React hooks and components that expose the DI container to the
 * component tree via Context.
 *
 * Components:
 *  - {@link FrameworkRoot}  — Mount at the app root to inject a FrameworkProvider.
 *  - {@link FrameworkScope} — Mount around a subtree to push a narrower Scope.
 *
 * Hooks:
 *  - {@link useFramework}       — Access the raw {@link FrameworkProvider}.
 *  - {@link useService}         — Resolve a single service by identifier.
 *  - {@link useServices}        — Resolve multiple services at once (auto-camelCase keys).
 *  - {@link useServiceOptional} — Resolve a service that may not be registered.
 *
 * All hooks must be called inside a {@link FrameworkRoot} subtree.
 */

import React, { useContext, useMemo } from "react";

import {
  Framework,
  type FrameworkProvider,
  FrameworkStackProvider,
  type Scope,
  type Service,
} from "../core";
import type { GeneralIdentifier, IdentifierType, Type } from "../core/types";

export const FrameworkProviderContext = React.createContext<FrameworkProvider>(
  Framework.EMPTY.provider(),
);

/** Returns the current {@link FrameworkProvider} from context. */
export function useFramework(): FrameworkProvider {
  return useContext(FrameworkProviderContext); // never null, because the default value
}

/**
 * Resolves a single DI service by identifier from the current framework scope.
 *
 * @param identifier - The service class or typed {@link Identifier} to look up.
 * @throws If the service is not registered in the active scope stack.
 */
export function useService<T>(identifier: GeneralIdentifier<T>): T {
  return useContext(FrameworkProviderContext).get(identifier);
}

/**
 * Hook to get services from the current framework stack.
 *
 * Automatically converts the service name to camelCase.
 *
 * @example
 * ```ts
 * const { authService, userService } = useServices({ AuthService, UserService });
 * ```
 */
export function useServices<
  const T extends { [key in string]: GeneralIdentifier<Service> },
>(
  identifiers: T,
): keyof T extends string
  ? { [key in Uncapitalize<keyof T>]: IdentifierType<T[Capitalize<key>]> }
  : never {
  const provider = useContext(FrameworkProviderContext);

  const services: any = {};

  for (const [key, value] of Object.entries(identifiers)) {
    services[key.charAt(0).toLowerCase() + key.slice(1)] = provider.get(value);
  }

  return services;
}

/**
 * Resolves a service that may or may not be registered.
 *
 * Returns `undefined` when the service is absent rather than throwing.
 * Useful for optional feature integrations that vary by build configuration.
 */
export function useServiceOptional<T extends Service>(
  identifier: Type<T>,
): T | undefined {
  return useContext(FrameworkProviderContext).getOptional(identifier);
}

/**
 * Root context provider that makes a {@link FrameworkProvider} available to the
 * entire component subtree.
 *
 * Place this at the top of the React tree (typically in `App.tsx`) before any
 * component that calls {@link useService} or {@link useServices}.
 *
 * @param framework - The provider created via `framework.provider()`.
 */
export const FrameworkRoot = ({
  framework,
  children,
}: React.PropsWithChildren<{ framework: FrameworkProvider }>) => {
  return (
    <FrameworkProviderContext.Provider value={framework}>
      {children}
    </FrameworkProviderContext.Provider>
  );
};

/**
 * Narrows the DI scope for a component subtree.
 *
 * When `scope` is provided, services resolved inside this boundary will first
 * be looked up in the scope's own framework, then fall back to the parent
 * provider.  This implements the "scope stack" pattern used for per-workspace
 * or per-entity contexts.
 *
 * When `scope` is `undefined`, this component is a transparent pass-through.
 */
export const FrameworkScope = ({
  scope,
  children,
}: React.PropsWithChildren<{ scope?: Scope }>) => {
  const provider = useContext(FrameworkProviderContext);

  const nextStack = useMemo(() => {
    if (!scope) return provider;
    // make sure the stack order is inside to outside
    return new FrameworkStackProvider([scope.framework, provider]);
  }, [scope, provider]);

  return (
    <FrameworkProviderContext.Provider value={nextStack}>
      {children}
    </FrameworkProviderContext.Provider>
  );
};
