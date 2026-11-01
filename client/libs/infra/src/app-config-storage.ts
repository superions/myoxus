/**
 * @file app-config-storage.ts — @myoxus/infra
 *
 * Typed, pluggable configuration storage for application-level settings.
 *
 * `AppConfigStorage` extends the generic `Storage<T>` class with the
 * `AppConfigSchema` shape.  By default, data is kept in a module-level
 * in-memory map; callers can inject custom `get`/`set` implementations (e.g.
 * backed by `localStorage` or Electron's `nativePreferences`) at construction
 * time.
 *
 * Consumers: workspace / onboarding modules in `client/web` and `client/admin`.
 */

import { z } from "zod";

/** Zod schema defining the structure of persisted application configuration. */
export const appConfigSchema = z.object({
  /** whether to show onboarding first */
  onBoarding: z.boolean().optional().default(true),
});

export type AppConfigSchema = z.infer<typeof appConfigSchema>;
export const defaultAppConfig = appConfigSchema.parse({});

const _storage: Record<number, any> = {};
let _inMemoryId = 0;

interface StorageOptions<T> {
  /** default config */
  config: T;
  get?: () => T;
  set?: (data: T) => void;
}

/**
 * Storage for app configuration, stored in memory by default
 */
class Storage<T extends object> {
  private _cfg: T;
  private readonly _id = _inMemoryId++;
  private readonly _options;

  constructor(options: StorageOptions<T>) {
    this._options = {
      get: () => _storage[this._id],
      set: (data: T) => (_storage[this._id] = data),
      ...options,
    };
    this._cfg = this.get() ?? options.config;
  }

  /**
   * update entire config
   * @param data
   */
  set(data: T) {
    try {
      this._options.set(data);
    } catch (err) {
      console.error("failed to save config", err);
    }
    this._cfg = data;
  }

  get(): T;
  get<K extends keyof T>(key: K): T[K];
  /**
   * get config, if key is provided, return the value of the key
   * @param key
   * @returns
   */
  get(key?: keyof T): T | T[keyof T] {
    if (!key) {
      try {
        const cfg = this._options.get();
        if (!cfg) {
          this.set(this._options.config);
          return this._options.config;
        }
        return cfg;
      } catch {
        return this._cfg;
      }
    } else {
      const fullConfig = this.get();
      // TODO(@catsjuice): handle key not found, set default value
      // if (!(key in fullConfig)) {}
      return fullConfig[key];
    }
  }

  /**
   * update a key in config
   * @param key
   * @param value
   */
  patch(key: keyof T, value: any) {
    this.set({ ...this.get(), [key]: value });
  }

  get value(): T {
    return this.get();
  }
}

/**
 * Typed configuration storage for the core application settings.
 *
 * Instantiate with an optional `get`/`set` pair to back the store with a
 * persistent medium.  When omitted, data lives only in memory for the current
 * page session.
 *
 * @example
 * ```ts
 * const config = new AppConfigStorage({
 *   config: defaultAppConfig,
 *   get: () => JSON.parse(localStorage.getItem('app-config') ?? 'null'),
 *   set: v => localStorage.setItem('app-config', JSON.stringify(v)),
 * });
 * config.patch('onBoarding', false);
 * ```
 */
export class AppConfigStorage extends Storage<AppConfigSchema> {}
