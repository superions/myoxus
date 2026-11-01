// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `view.ts` - legacy entry point for view extensions.
 *
 * As of P-VIRG-ARCH-C-01, the list of internal view
 * extensions is owned by `manifest-registry.ts` and exposed
 * via `getInternalViewExtensions()`. This file re-exports
 * the same function for backwards compatibility with
 * existing Myoxus and Virgultum callers.
 *
 * The returned array is byte-for-byte identical to the
 * pre-C-01 list (see
 * `manifest-consistency.unit.spec.ts`).
 */

export { getInternalViewExtensions } from "./manifest-registry";
