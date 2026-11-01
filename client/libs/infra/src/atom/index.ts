/**
 * @file index.ts — @myoxus/infra (atom)
 *
 * Public entry-point for Jotai atom utilities in the `@myoxus/infra` package.
 *
 * Re-exports:
 *  - `./root-store`  — {@link getCurrentStore} for imperative atom access.
 *  - `./settings`    — device-only settings and their persisted atom.
 *
 * Consumers: `client/web`, `client/admin`, Electron renderer.
 */
export * from "./root-store";
export * from "./settings";
