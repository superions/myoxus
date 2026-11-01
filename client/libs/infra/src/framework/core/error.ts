/**
 * @file error.ts — @myoxus/infra (framework/core)
 *
 * DI-framework-specific error classes.
 *
 * All errors include a human-readable message and structured data (e.g.
 * the dependency stack or the offending identifier) so that debugging DI
 * configuration issues is straightforward.
 *
 * Consumers: `framework.ts`, `provider.ts` — thrown during component
 * registration, resolution, or creation.
 */

import { DEFAULT_VARIANT } from "./consts";
import type { IdentifierValue } from "./types";

/**
 * Thrown when the DI container detects that dynamic resolution (e.g. via
 * `getOptional`) has exceeded a safe call-depth limit, preventing a stack
 * overflow from unbounded recursion.
 */
export class RecursionLimitError extends Error {
  constructor() {
    super("Dynamic resolve recursion limit reached");
  }
}

/**
 * Thrown when the DI container detects a circular dependency between two or
 * more components during resolution.
 *
 * The `dependencyStack` shows the ordered chain of identifiers that led to
 * the cycle (e.g. `[A] -> [B] -> [A]`).
 */
export class CircularDependencyError extends Error {
  /** Ordered chain of identifiers that form the dependency cycle. */
  constructor(public readonly dependencyStack: IdentifierValue[]) {
    super(
      `A circular dependency was detected.\n` +
        stringifyDependencyStack(dependencyStack),
    );
  }
}

/**
 * Thrown when a requested component identifier is not registered in the
 * current provider or any of its parent providers.
 *
 * Check that the relevant `impl()` call is present in the framework
 * configuration and that the correct scope is active.
 */
export class ComponentNotFoundError extends Error {
  /** The identifier that could not be resolved. */
  constructor(public readonly identifier: IdentifierValue) {
    super(
      `Component ${stringifyIdentifier(identifier)} not found in container`,
    );
  }
}

/**
 * Thrown when a component's dependency cannot be resolved during instantiation.
 *
 * Includes the identifier of the component being created (`from`), the
 * missing dependency (`target`), and the full `dependencyStack` for context.
 */
export class MissingDependencyError extends Error {
  /** The component whose constructor triggered the missing-dependency error. */
  constructor(
    public readonly from: IdentifierValue,
    /** The identifier that could not be found. */
    public readonly target: IdentifierValue,
    /** The resolution chain that was active at the time of the error. */
    public readonly dependencyStack: IdentifierValue[],
  ) {
    super(
      `Missing dependency ${stringifyIdentifier(
        target,
      )} in creating ${stringifyIdentifier(
        from,
      )}.\n${stringifyDependencyStack(dependencyStack)}`,
    );
  }
}

/**
 * Thrown when an attempt is made to register the same identifier twice in the
 * same provider scope.
 *
 * Each `impl()` call for a given identifier+variant pair must be unique within
 * a scope.  Use a different variant string to register multiple implementations.
 */
export class DuplicateDefinitionError extends Error {
  /** The identifier that was already registered. */
  constructor(public readonly identifier: IdentifierValue) {
    super(`${stringifyIdentifier(identifier)} already exists`);
  }
}

/** @internal Formats an identifier as `[Name]` or `[Name](variant)`. */
function stringifyIdentifier(identifier: IdentifierValue) {
  return `[${identifier.identifierName}]${
    identifier.variant !== DEFAULT_VARIANT ? `(${identifier.variant})` : ""
  }`;
}

/** @internal Formats a dependency chain as `[A] -> [B] -> [C]`. */
function stringifyDependencyStack(dependencyStack: IdentifierValue[]) {
  return dependencyStack
    .map((identifier) => `${stringifyIdentifier(identifier)}`)
    .join(" -> ");
}
