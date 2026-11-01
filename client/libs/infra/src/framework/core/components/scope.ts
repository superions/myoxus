/**
 * @file scope.ts — @myoxus/infra (framework/core/components)
 *
 * Base class for hierarchical DI scopes in the Myoxus framework.
 *
 * A `Scope` is a component that owns a child {@link FrameworkProvider}.  When
 * a scope is created, the framework creates a new provider that inherits from
 * the parent and can override or add registrations.  This enables
 * hierarchical dependency trees, e.g.:
 *
 * ```
 * Root provider
 *   └── WorkspaceScope (one per open workspace)
 *         └── DocScope (one per open document)
 * ```
 *
 * `Scope` exposes shortcut getters for the most commonly-used provider methods
 * (`get`, `getAll`, `createEntity`, `createScope`, `emitEvent`, etc.) so
 * that sub-classes can call them without `this.framework.XXX`.
 *
 * Disposing a `Scope` disposes its child `framework` provider, recursively
 * tearing down all entities and services that were created inside it.
 *
 * Consumers: workspace, doc, and UI-layer scope definitions in `client/web`.
 *
 * @template Props - Initialisation parameters, passed as `this.props` from
 *   the parent's `createScope()` call.
 */

import { Component } from "./component";

/**
 * Base class for a DI scope that owns a child provider.
 *
 * See the file-level JSDoc for a conceptual overview.
 *
 * @template Props - Initialisation parameters specific to this scope type.
 */
export class Scope<Props = {}> extends Component<Props> {
  readonly __injectable = true;

  /** Shortcut to `this.framework.collection`. */
  get collection() {
    return this.framework.collection;
  }

  /** Shortcut to `this.framework.scope`. */
  get scope() {
    return this.framework.scope;
  }

  /** Shortcut to `this.framework.get` — resolves a singleton service or store. */
  get get() {
    return this.framework.get;
  }

  /** Shortcut to `this.framework.getAll` — resolves all variants of an identifier. */
  get getAll() {
    return this.framework.getAll;
  }

  /** Shortcut to `this.framework.getOptional` — resolves without throwing when absent. */
  get getOptional() {
    return this.framework.getOptional;
  }

  /** Shortcut to `this.framework.createEntity`. */
  get createEntity() {
    return this.framework.createEntity;
  }

  /** Shortcut to `this.framework.createScope`. */
  get createScope() {
    return this.framework.createScope;
  }

  /** Shortcut to `this.framework.emitEvent`. */
  get emitEvent() {
    return this.framework.emitEvent;
  }

  /**
   * Disposes this scope and its child provider, recursively tearing down all
   * components that were created inside this scope.
   */
  override dispose(): void {
    super.dispose();
    this.framework.dispose();
  }
}
