/**
 * @file service.ts — @myoxus/infra (framework/core/components)
 *
 * Marker base class for singleton services in the DI framework.
 *
 * A `Service` is a long-lived, injectable component that provides
 * business logic or infrastructure capabilities to other components.
 * Each `Service` subclass is instantiated at most once per
 * {@link FrameworkProvider} scope.
 *
 * Usage: extend `Service` and register the class with the framework:
 * ```ts
 * class AuthService extends Service {
 *   signIn(email: string, password: string) { ... }
 * }
 * framework.impl(AuthService);
 * const auth = provider.get(AuthService);
 * ```
 *
 * Consumers: all application-layer services in `client/web` and `client/admin`.
 */

import { Component } from "./component";

/**
 * Base class for singleton, injectable application services.
 *
 * The `__isService` brand field is used by the DI container to enforce
 * lifecycle rules specific to services (e.g. single instantiation per scope).
 * The `__injectable` flag tells the container that this class can be auto-resolved
 * from a constructor injection context.
 */
export class Service extends Component {
  readonly __isService = true;
  readonly __injectable = true;
}
