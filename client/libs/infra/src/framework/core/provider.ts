/**
 * @file provider.ts — @myoxus/infra (framework/core)
 *
 * The runtime resolution layer of the Myoxus DI framework.
 *
 * Key classes:
 *
 * - {@link FrameworkProvider}    — abstract public API for resolving components.
 *   Exposes `get`, `getAll`, `getOptional`, `createEntity`, `createScope`,
 *   and `emitEvent`.
 * - {@link BasicFrameworkProvider} — concrete implementation that owns a
 *   {@link ComponentCachePool} and delegates resolution to a {@link Resolver}.
 * - {@link ComponentCachePool}   — LRU-style singleton cache keyed by
 *   identifier name + variant; disposed together with the provider.
 * - {@link Resolver}             — internal class used during a single resolution
 *   call to track the dependency stack and detect cycles.
 *
 * Consumers: {@link Framework} (creates providers via `provider()`), and
 * indirectly every call to `provider.get(...)` or `provider.createEntity(...)`.
 */

import type { Component } from "./components/component";
import type { Entity } from "./components/entity";
import type { Scope } from "./components/scope";
import { withContext } from "./constructor-context";
import {
  CircularDependencyError,
  ComponentNotFoundError,
  MissingDependencyError,
  RecursionLimitError,
} from "./error";
import { EventBus, type FrameworkEvent } from "./event";
import type { Framework } from "./framework";
import { parseIdentifier } from "./identifier";
import type {
  ComponentVariant,
  FrameworkScopeStack,
  GeneralIdentifier,
  IdentifierValue,
} from "./types";

/**
 * Options controlling how a component is resolved from the container.
 */
export interface ResolveOptions {
  /**
   * When `true`, only the current scope is searched; the resolution does NOT
   * walk up to parent providers.  Used for sub-components and entity creation.
   */
  sameScope?: boolean;
  /**
   * When `true`, returns `undefined` instead of throwing
   * {@link ComponentNotFoundError} if the component is not registered.
   */
  optional?: boolean;
  /**
   * When `true`, bypasses the singleton cache and creates a fresh instance.
   * Used by {@link FrameworkProvider.createEntity} which must return a new
   * instance on every call.
   */
  noCache?: boolean;
  /**
   * Props forwarded to the component constructor (for entities and scopes).
   * Available as `this.props` inside the component.
   */
  props?: any;
}

/**
 * Abstract public API for resolving components from the DI container.
 *
 * Application code should depend on `FrameworkProvider` rather than the
 * concrete `BasicFrameworkProvider` so that tests can substitute a different
 * implementation.
 *
 * Obtain an instance from `framework.provider()` or via `this.framework`
 * inside any {@link Component} subclass.
 */
export abstract class FrameworkProvider {
  /** The {@link Framework} that owns this provider's registrations. */
  abstract collection: Framework;
  /** The ordered list of scope names active in this provider. */
  abstract scope: FrameworkScopeStack;
  /** Low-level resolution (bypasses type-safe wrappers). @internal */
  abstract getRaw(identifier: IdentifierValue, options?: ResolveOptions): any;
  /** Low-level multi-resolution (bypasses type-safe wrappers). @internal */
  abstract getAllRaw(
    identifier: IdentifierValue,
    options?: ResolveOptions,
  ): Map<ComponentVariant, any>;
  /** Disposes this provider and all cached component instances. */
  abstract dispose(): void;
  /** The event bus for the scope owned by this provider. */
  abstract eventBus: EventBus;

  /**
   * Resolves a singleton component by identifier.
   *
   * @throws {@link ComponentNotFoundError} if not registered.
   * @throws {@link CircularDependencyError} if a circular dependency is detected.
   */
  get = <T>(identifier: GeneralIdentifier<T>, options?: ResolveOptions): T => {
    return this.getRaw(parseIdentifier(identifier), {
      ...options,
      optional: false,
    });
  };

  /**
   * Resolves all registered variants of an identifier as a `Map<variant, T>`.
   *
   * Useful when multiple implementations are registered for the same interface
   * using different variant strings.
   */
  getAll = <T>(
    identifier: GeneralIdentifier<T>,
    options?: ResolveOptions,
  ): Map<ComponentVariant, T> => {
    return this.getAllRaw(parseIdentifier(identifier), {
      ...options,
    });
  };

  /**
   * Resolves a component by identifier, returning `undefined` when not registered.
   *
   * Use this instead of {@link get} when the dependency is optional and the
   * calling code has a sensible fallback.
   */
  getOptional = <T>(
    identifier: GeneralIdentifier<T>,
    options?: ResolveOptions,
  ): T | undefined => {
    return this.getRaw(parseIdentifier(identifier), {
      ...options,
      optional: true,
    });
  };

  /**
   * Creates a new entity instance with the given `props`.
   *
   * Unlike `get`, this always creates a **fresh** instance — entities are not
   * cached as singletons.  The entity's constructor receives `props` via
   * `this.props`.
   *
   * @param identifier - The entity class or identifier token.
   * @param props      - Initialisation parameters; required when `Props` is
   *   not an empty record, omitted otherwise.
   */
  createEntity = <
    T extends Entity<any>,
    Props extends (T extends Component<infer P> ? P : never),
  >(
    identifier: GeneralIdentifier<T>,
    ...[props]: Props extends Record<string, never> ? [] : [Props]
  ): T => {
    return this.getRaw(parseIdentifier(identifier), {
      noCache: true,
      sameScope: true,
      props,
    });
  };

  /**
   * Creates a child scope component, extending the provider hierarchy.
   *
   * The new scope's `framework` provider inherits all registrations from the
   * current scope plus any scope-specific overrides defined for `root`.
   *
   * @param root  - The scope class or identifier token.
   * @param props - Initialisation parameters for the scope.
   */
  createScope = <
    T extends Scope<any>,
    Props extends (T extends Component<infer P> ? P : never),
  >(
    root: GeneralIdentifier<T>,
    ...[props]: Props extends Record<string, never> ? [] : [Props]
  ): T => {
    const newProvider = this.collection.provider(
      [...this.scope, parseIdentifier(root).identifierName],
      this,
    );
    return newProvider.getRaw(parseIdentifier(root), {
      sameScope: true,
      props,
    });
  };

  /**
   * Emits a typed event on this provider's {@link EventBus}.
   *
   * All handlers registered on this bus and its ancestors receive the event.
   *
   * @param event   - The typed event descriptor created with {@link createEvent}.
   * @param payload - The event payload.
   */
  emitEvent = <T>(event: FrameworkEvent<T>, payload: T) => {
    this.eventBus.emit(event, payload);
  };

  [Symbol.dispose]() {
    this.dispose();
  }
}

export class ComponentCachePool {
  cache: Map<string, Map<ComponentVariant, any>> = new Map();

  getOrInsert(identifier: IdentifierValue, insert: () => any) {
    const cache = this.cache.get(identifier.identifierName) ?? new Map();
    if (!cache.has(identifier.variant)) {
      cache.set(identifier.variant, insert());
    }
    const cached = cache.get(identifier.variant);
    this.cache.set(identifier.identifierName, cache);
    return cached;
  }

  dispose() {
    for (const t of this.cache.values()) {
      for (const i of t.values()) {
        if (typeof i === "object" && typeof i[Symbol.dispose] === "function") {
          try {
            i[Symbol.dispose]();
          } catch (err) {
            // make a uncaught exception
            setTimeout(() => {
              throw err;
            }, 0);
          }
        }
      }
    }
    this.cache.clear();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

class Resolver extends FrameworkProvider {
  constructor(
    public readonly provider: BasicFrameworkProvider,
    public readonly depth = 0,
    public readonly stack: IdentifierValue[] = [],
  ) {
    super();
  }

  scope = this.provider.scope;
  collection = this.provider.collection;
  eventBus = this.provider.eventBus;

  getRaw(
    identifier: IdentifierValue,
    {
      sameScope = false,
      optional = false,
      noCache = false,
      props,
    }: ResolveOptions = {},
  ) {
    const factory = this.provider.collection.getFactory(
      identifier,
      this.provider.scope,
    );
    if (!factory) {
      if (this.provider.parent && !sameScope) {
        return this.provider.parent.getRaw(identifier, {
          sameScope: sameScope,
          optional,
          noCache,
          props,
        });
      }

      if (optional) {
        return undefined;
      }
      throw new ComponentNotFoundError(identifier);
    }

    const runFactory = () => {
      const nextResolver = this.track(identifier);
      try {
        return withContext(() => factory(nextResolver), {
          provider: this.provider,
          props,
        });
      } catch (err) {
        if (err instanceof ComponentNotFoundError) {
          throw new MissingDependencyError(
            identifier,
            err.identifier,
            this.stack,
          );
        }
        throw err;
      }
    };

    if (noCache) {
      return runFactory();
    }

    return this.provider.cache.getOrInsert(identifier, runFactory);
  }

  getAllRaw(
    identifier: IdentifierValue,
    { sameScope = false, noCache, props }: ResolveOptions = {},
  ): Map<ComponentVariant, any> {
    const vars = this.provider.collection.getFactoryAll(
      identifier,
      this.provider.scope,
    );

    if (vars === undefined) {
      if (this.provider.parent && !sameScope) {
        return this.provider.parent.getAllRaw(identifier);
      }

      return new Map();
    }

    const result = new Map<ComponentVariant, any>();

    for (const [variant, factory] of vars) {
      const runFactory = () => {
        const nextResolver = this.track(identifier);
        try {
          return withContext(() => factory(nextResolver), {
            provider: this.provider,
            props,
          });
        } catch (err) {
          if (err instanceof ComponentNotFoundError) {
            throw new MissingDependencyError(
              identifier,
              err.identifier,
              this.stack,
            );
          }
          throw err;
        }
      };
      let service;
      if (noCache) {
        service = runFactory();
      } else {
        service = this.provider.cache.getOrInsert(
          {
            identifierName: identifier.identifierName,
            variant,
          },
          runFactory,
        );
      }
      result.set(variant, service);
    }

    return result;
  }

  track(identifier: IdentifierValue): Resolver {
    const depth = this.depth + 1;
    if (depth >= 100) {
      throw new RecursionLimitError();
    }
    const circular = this.stack.find(
      (i) =>
        i.identifierName === identifier.identifierName &&
        i.variant === identifier.variant,
    );
    if (circular) {
      throw new CircularDependencyError([...this.stack, identifier]);
    }

    return new Resolver(this.provider, depth, [...this.stack, identifier]);
  }

  override dispose(): void {}
}

export class BasicFrameworkProvider extends FrameworkProvider {
  public readonly cache = new ComponentCachePool();
  public readonly collection: Framework;
  public readonly eventBus: EventBus;

  disposed = false;

  constructor(
    collection: Framework,
    public readonly scope: string[],
    public readonly parent: FrameworkProvider | null,
  ) {
    super();
    this.collection = collection;
    this.eventBus = new EventBus(this, this.parent?.eventBus);
  }

  getRaw(identifier: IdentifierValue, options?: ResolveOptions) {
    const resolver = new Resolver(this);
    return resolver.getRaw(identifier, options);
  }

  getAllRaw(
    identifier: IdentifierValue,
    options?: ResolveOptions,
  ): Map<ComponentVariant, any> {
    const resolver = new Resolver(this);
    return resolver.getAllRaw(identifier, options);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cache.dispose();
    this.eventBus.dispose();
  }
}

export class FrameworkStackProvider extends FrameworkProvider {
  public readonly stack: FrameworkProvider[];
  public readonly collection: Framework;
  public readonly eventBus: EventBus;

  constructor(providers: FrameworkProvider[]) {
    if (providers.length === 0) {
      throw new Error("FrameworkStackProvider must have at least one provider");
    }
    super();
    this.stack = [...providers];

    // use the collection and eventBus from the first provider
    this.collection = this.stack[0].collection;
    this.eventBus = this.stack[0].eventBus;
  }

  get scope(): FrameworkScopeStack {
    return this.stack[0]?.scope || [];
  }

  getRaw(identifier: IdentifierValue, options?: ResolveOptions): any {
    for (const provider of this.stack) {
      const service = provider.getRaw(identifier, {
        ...options,
        optional: true,
      });
      if (service) {
        return service;
      }
    }

    if (options?.optional) {
      return undefined;
    }

    throw new ComponentNotFoundError(identifier);
  }

  getAllRaw(
    identifier: IdentifierValue,
    options?: ResolveOptions,
  ): Map<ComponentVariant, any> {
    for (const provider of this.stack) {
      const components = provider.getAllRaw(identifier, options);
      if (components.size > 0) {
        return components;
      }
    }

    return new Map();
  }

  dispose(): void {
    // No need to handle the disposal of providers in the stack, as they are passed in externally
  }
}
