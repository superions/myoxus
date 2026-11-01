/**
 * Electron-specific global storage configuration.
 *
 * Registers DI bindings for the storage abstractions used by modules that need
 * to persist data across app restarts. In Electron, storage is backed by the
 * native Electron API (via `DesktopApiService`) rather than the browser
 * IndexedDB/localStorage fallbacks used in the web build.
 *
 * Bindings:
 * - `GlobalCache`   → `ElectronGlobalCache` (non-persistent, in-memory-like)
 * - `GlobalState`   → `ElectronGlobalState` (persistent, survives restarts)
 * - `CacheStorage`  → `IDBGlobalState` (IndexedDB, used for storage metadata)
 *
 * Call this function in the Electron renderer bootstrap before creating the
 * framework provider.
 *
 * @param framework - The DI framework instance to configure.
 */
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import {
  CacheStorage,
  GlobalCache,
  GlobalState,
} from "@myoxus/core/modules/storage";
import {
  ElectronGlobalCache,
  ElectronGlobalState,
} from "@myoxus/core/modules/storage/impls/electron";
import { IDBGlobalState } from "@myoxus/core/modules/storage/impls/storage";
import type { Framework } from "@myoxus/infra";

/**
 * Configures Electron-backed storage implementations in the DI container.
 *
 * Must be called during Electron renderer bootstrap after the framework is
 * created but before `framework.provider()` is called.
 *
 * @param framework - The application DI framework instance.
 */
export function configureElectronStateStorageImpls(framework: Framework) {
  framework.impl(GlobalCache, ElectronGlobalCache, [DesktopApiService]);
  framework.impl(GlobalState, ElectronGlobalState, [DesktopApiService]);
  framework.impl(CacheStorage, IDBGlobalState);
}
