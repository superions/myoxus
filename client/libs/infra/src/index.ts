/**
 * @file index.ts — @myoxus/infra
 *
 * Public entry-point for the shared infrastructure layer used by `client/admin`
 * and `client/web`.
 *
 * Sub-modules:
 *  - `app-config-storage` — typed, pluggable configuration storage
 *  - `atom`               — Jotai atoms and the root store
 *  - `framework`          — dependency-injection framework (Framework, Service,
 *                           Store, Entity, Scope) + React bindings
 *  - `livedata`           — reactive state (LiveData), RxJS operators, React hook
 *  - `media`              — media query / breakpoint utilities
 *  - `orm`                — lightweight ORM layer for workspace data
 *  - `storage`            — generic key-value storage abstractions
 *  - `utils`              — shared utility functions
 */
export * from "./app-config-storage";
export * from "./account-preference-cache";
export * from "./atom";
export * from "./framework";
export * from "./livedata";
export * from "./media";
export * from "./orm";
export * from "./storage";
export * from "./utils";
