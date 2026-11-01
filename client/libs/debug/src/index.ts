/**
 * @file index.ts — @myoxus/debug
 *
 * Thin wrapper around the `debug` npm package that adds log-level semantics
 * (debug / info / warn / error) and automatic activation via URL query param.
 *
 * Activation rules (applied at module load time in browser environments):
 *  - `?debug` in the URL  → stores flag in `sessionStorage` and enables all namespaces
 *  - `BUILD_CONFIG.debug` → enables all namespaces except `micromark`
 *  - Otherwise, debug logging is suppressed by default (respects `localStorage.debug`)
 *
 * Consumers: all packages in `client/libs` and the GraphQL fetcher.
 */

import debug from "debug";
type LogLevel = "debug" | "info" | "warn" | "error";

const SESSION_KEY = "myoxus:debug";
const buildConfig = (
  globalThis as typeof globalThis & { BUILD_CONFIG?: { debug?: boolean } }
).BUILD_CONFIG;

if (typeof window !== "undefined") {
  const getSessionValue = (key: string) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const setSessionValue = (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // ignore if storage is not accessible (e.g., sandboxed renderer)
    }
  };

  // enable debug logs if the URL search string contains `debug`
  // e.g. http://localhost:3000/?debug
  if (window.location.search.includes("debug")) {
    // enable debug logs for the current session
    // since the query string may be removed by the browser after navigations,
    // we need to store the debug flag in sessionStorage
    setSessionValue(SESSION_KEY, "true");
  }
  if (getSessionValue(SESSION_KEY) === "true") {
    // enable all debug logs by default
    debug.enable("*");
    console.warn("Debug logs enabled");
  }
  if (buildConfig?.debug) {
    debug.enable("*,-micromark");
    console.warn("Debug logs enabled");
  }
}

/**
 * Structured logger built on top of the `debug` library.
 *
 * Each instance is scoped to a namespace string (e.g. `'GraphQL'` or
 * `'workspace:sync'`), which is displayed as a prefix in console output and
 * can be used with the standard `localStorage.debug` filter.
 *
 * @example
 * ```ts
 * const logger = new DebugLogger('my-module');
 * logger.info('connected');
 * logger.warn('slow response', { ms: 1200 });
 *
 * // Create a child logger with a sub-namespace:
 * const child = logger.namespace('sub');
 * child.debug('detail');
 * ```
 */
export class DebugLogger {
  private readonly _debug: debug.Debugger;

  constructor(namespace: string) {
    this._debug = debug(namespace);
  }

  /** Enables or disables this logger instance independently of the global filter. */
  set enabled(enabled: boolean) {
    this._debug.enabled = enabled;
  }

  /** Returns whether this logger is currently active. */
  get enabled() {
    return this._debug.enabled;
  }

  /** Emits a `[DEBUG]` level message. Active only when debug logging is enabled. */
  debug(message: string, ...args: any[]) {
    this.log("debug", message, ...args);
  }

  /** Emits an `[INFO]` level message. */
  info(message: string, ...args: any[]) {
    this.log("info", message, ...args);
  }

  /** Emits a `[WARN]` level message. */
  warn(message: string, ...args: any[]) {
    this.log("warn", message, ...args);
  }

  /** Emits an `[ERROR]` level message. */
  error(message: string, ...args: any[]) {
    this.log("error", message, ...args);
  }

  /**
   * Low-level log method — routes the message to the appropriate
   * `console` method based on `level`.
   *
   * @param level   - One of `'debug' | 'info' | 'warn' | 'error'`.
   * @param message - Log message string.
   * @param args    - Additional values to include in the log output.
   */
  log(level: LogLevel, message: string, ...args: any[]) {
    this._debug.log = console[level].bind(console);
    this._debug(`[${level.toUpperCase()}] ${message}`, ...args);
  }

  /**
   * Returns a new `DebugLogger` with `extra` appended to the current namespace,
   * separated by a colon (e.g. `'parent:extra'`).
   */
  namespace(extra: string) {
    const currentNamespace = this._debug.namespace;
    return new DebugLogger(`${currentNamespace}:${extra}`);
  }
}
