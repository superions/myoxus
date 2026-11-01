/**
 * @file component.ts — @myoxus/infra (framework/core/components)
 *
 * Base class for all DI-framework-managed components.
 *
 * Every concrete component type ({@link Service}, {@link Store},
 * {@link Entity}, {@link Scope}) extends this class.  The constructor reads
 * the ambient {@link CONSTRUCTOR_CONTEXT} which is set by the DI container
 * just before instantiation, injecting the provider and props.
 *
 * Consumers: all framework-registered services, stores, entities, and scopes
 * in `client/web` and `client/admin`.
 */

import { CONSTRUCTOR_CONTEXT } from "../constructor-context";
import type { FrameworkProvider } from "../provider";

/**
 * Base class for all components managed by the Myoxus DI framework.
 *
 * Subclasses gain access to:
 * - `this.framework` — the {@link FrameworkProvider} they were created in,
 *   allowing them to resolve further dependencies or create child entities.
 * - `this.props` — the `Props` value passed when the component was instantiated
 *   (relevant for {@link Entity} and {@link Scope} instances).
 * - `this.eventBus` — the shared event bus for cross-component communication.
 * - `this.disposables` — an array to register cleanup functions; called in
 *   {@link dispose}.
 *
 * **Construction contract**: components must be constructed by the DI container
 * (via `provider.get()` or `provider.createEntity()`).  Calling `new MyService()`
 * directly without the container context will throw.
 *
 * @template Props - Optional record of initialisation parameters for entities
 *   and scopes.  Services and stores typically use the default `{}`.
 */
export class Component<Props = {}> {
  /** The provider that created this component instance. */
  readonly framework: FrameworkProvider;

  /**
   * The props passed to this component at creation time.
   * Always `{}` for {@link Service} and {@link Store} instances.
   */
  readonly props: Props;

  /**
   * Cleanup functions to run when this component is disposed.
   * Push teardown logic here (e.g. unsubscribe, close connections) rather
   * than overriding `dispose()`.
   */
  protected readonly disposables: (() => void)[] = [];

  /** Shortcut to the shared event bus provided by `this.framework`. */
  get eventBus() {
    return this.framework.eventBus;
  }

  constructor() {
    if (!CONSTRUCTOR_CONTEXT.current.provider) {
      throw new Error("Component must be created in the context of a provider");
    }
    this.framework = CONSTRUCTOR_CONTEXT.current.provider;
    this.props = CONSTRUCTOR_CONTEXT.current.props;
    CONSTRUCTOR_CONTEXT.current = {};
  }

  /**
   * Runs all registered {@link disposables} and cleans up the component.
   *
   * Override in subclasses only when additional teardown beyond `disposables`
   * is needed.  Always call `super.dispose()` when overriding.
   */
  dispose() {
    this.disposables.forEach((dispose) => dispose());
  }

  /**
   * Implements the TC39 `[Symbol.dispose]` protocol, making components
   * compatible with `using` declarations in TypeScript 5.2+.
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}
