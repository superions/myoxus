import {
  type AsyncMemento,
  createIdentifier,
  type Memento,
} from "@myoxus/infra";

/**
 * A memento object that stores the entire application state.
 *
 * State is persisted, even the application is closed.
 */
export interface GlobalState extends Memento {
  /** Existing native snapshot gate; Web synchronous storage is already ready. */
  readonly ready?: Promise<void>;
  /** Durable ACK for native actions that must not start after an optimistic write. */
  setConfirmed?<T>(key: string, value: T | undefined): Promise<void>;
  /** Confirmed Main snapshot read; preload readiness alone swallows init errors. */
  getConfirmed?<T>(key: string): Promise<T | undefined>;
}

/** Ordinary Memento writes keep their existing optimistic contract. These few
 * native creation actions require the Desktop main-process flush first. */
export async function writeGlobalStateConfirmed<T>(
  state: GlobalState,
  key: string,
  value: T | undefined,
): Promise<void> {
  await state.ready;
  if (state.setConfirmed) {
    await state.setConfirmed(key, value);
    return;
  }
  if (BUILD_CONFIG.isElectron)
    throw new Error("Confirmed native global storage is unavailable");
  if (value === undefined) state.del(key);
  else state.set(key, value);
}

export async function readGlobalStateConfirmed<T>(
  state: GlobalState,
  key: string,
): Promise<T | undefined> {
  await state.ready;
  if (state.getConfirmed) return state.getConfirmed<T>(key);
  if (BUILD_CONFIG.isElectron)
    throw new Error("Confirmed native global storage is unavailable");
  return state.get<T>(key);
}

export const GlobalState = createIdentifier<GlobalState>("GlobalState");

/**
 * A memento object that stores the entire application cache.
 *
 * Cache may be deleted from time to time, business logic should not rely on cache.
 */
export interface GlobalCache extends Memento {}
export const GlobalCache = createIdentifier<GlobalCache>("GlobalCache");

/**
 * A memento object that stores session state.
 *
 * Session state is not persisted, it will be cleared when the application is closed. (thinking about sessionStorage)
 */
export interface GlobalSessionState extends Memento {}
export const GlobalSessionState =
  createIdentifier<GlobalSessionState>("GlobalSessionState");

export interface CacheStorage extends AsyncMemento {}

export const CacheStorage = createIdentifier<CacheStorage>("CacheStorage");
