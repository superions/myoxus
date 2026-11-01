/**
 * @file consts.ts — @myoxus/infra (framework/core)
 *
 * Shared constants for the Myoxus DI framework.
 *
 * Consumers: all files within `framework/core/`.
 */

import type { ComponentVariant } from "./types";

/**
 * The default variant name used when no explicit variant is supplied to
 * {@link createIdentifier}.  Components registered without a variant are
 * stored under this key.
 */
export const DEFAULT_VARIANT: ComponentVariant = "default";

/**
 * The scope stack for the root-level provider (an empty array, indicating no
 * active named scopes).  Used when constructing the top-level framework.
 */
export const ROOT_SCOPE = [];

/**
 * Symbol key used to store the array of {@link SubComponent} registrations
 * on a class constructor.  Set via the `@component` decorator or equivalent.
 *
 * @internal
 */
export const SUB_COMPONENTS = Symbol("subComponents");
