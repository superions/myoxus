/**
 * @file types.ts — @myoxus/infra (framework/core)
 *
 * Core type definitions for the Myoxus dependency-injection framework.
 *
 * The framework uses an identifier-based IoC container inspired by InversifyJS.
 * The key types here are:
 *
 * - {@link Identifier}       — a typed token used to look up implementations.
 * - {@link IdentifierValue}  — the runtime shape of an identifier (name + variant).
 * - {@link ComponentFactory} — a factory function that creates an instance using
 *                              the container's {@link FrameworkProvider}.
 * - {@link TypesToDeps}      — maps a tuple of value types to their corresponding
 *                              identifiers, used for constructor-injection typing.
 *
 * Consumers: all files in `framework/core/` and modules that use the framework.
 */

import type { FrameworkProvider } from "./provider";

/**
 * An abstract constructor type.  Used to accept class constructors as
 * identifiers without requiring a concrete (non-abstract) class.
 */
export type Type<T = any> = abstract new (...args: any) => T;

/**
 * A factory function that creates a component instance given a
 * {@link FrameworkProvider} to resolve dependencies from.
 */
export type ComponentFactory<T = any> = (provider: FrameworkProvider) => T;

/**
 * A string discriminator used to distinguish multiple registrations of the
 * same {@link Identifier}.  For example, `'local'` and `'session'` for a
 * `Storage` identifier.
 */
export type ComponentVariant = string;

/**
 * The ordered list of scope names active at a particular point in the
 * provider hierarchy.  Used internally to determine which registrations
 * are visible to a given provider.
 */
export type FrameworkScopeStack = string[];

/**
 * The serialisable (runtime) value of an identifier — name plus variant.
 * Used as the key in the DI container's internal maps.
 */
export type IdentifierValue = {
  /** Globally unique name for this identifier (typically the interface name). */
  identifierName: string;
  /** Variant discriminator, defaults to the constant `DEFAULT_VARIANT`. */
  variant: ComponentVariant;
};

/**
 * Either a typed {@link Identifier} token or a class constructor.
 * Accepted wherever an identifier is needed, to allow both styles:
 * ```ts
 * provider.get(MyService);           // via constructor
 * provider.get(createIdentifier<MyService>('MyService')); // via token
 * ```
 */
export type GeneralIdentifier<T = any> = Identifier<T> | Type<T>;

/**
 * A typed identifier token used to look up implementations in the DI container.
 *
 * The phantom `__TYPE__` field carries the type of the resolved value at the
 * TypeScript level without any runtime overhead.
 *
 * Create identifiers with {@link createIdentifier} rather than constructing
 * this shape manually.
 */
export type Identifier<T> = {
  /** Globally unique name (matches the registered interface / service name). */
  identifierName: string;
  /** Variant discriminator for multi-registration scenarios. */
  variant: ComponentVariant;
  /** Phantom type field — carries `T` at compile time; never present at runtime. */
  __TYPE__: T;
};

/**
 * Extracts the resolved value type from an {@link Identifier} or constructor.
 *
 * - `IdentifierType<Identifier<Foo>>` → `Foo`
 * - `IdentifierType<typeof FooClass>` → `FooClass` (instance type)
 */
export type IdentifierType<T> =
  T extends Identifier<infer R> ? R : T extends Type<infer R> ? R : never;

/**
 * Maps a tuple of value types to their corresponding identifier types.
 *
 * Used to type the `deps` parameter of component definitions, ensuring
 * that each dependency is expressed as either a {@link GeneralIdentifier}
 * for a scalar value or a single-element tuple `[GeneralIdentifier<I>]`
 * for array dependencies.
 */
export type TypesToDeps<T> = {
  [index in keyof T]:
    | GeneralIdentifier<T[index]>
    | (T[index] extends (infer I)[] ? [GeneralIdentifier<I>] : never);
};

/**
 * A registered sub-component entry in a scope or entity.
 *
 * Pairs an {@link Identifier} token with the {@link ComponentFactory} that
 * produces instances of it.
 */
export type SubComponent = {
  /** The identifier under which this sub-component is registered. */
  identifier: Identifier<any>;
  /** The factory that creates an instance of this sub-component. */
  factory: ComponentFactory;
};
