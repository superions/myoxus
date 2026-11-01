/**
 * @file global.ts — @myoxus/env
 *
 * Initialises the global `environment` object that is read throughout the
 * application to detect the current platform, browser, and deployment context.
 *
 * Call {@link setupGlobal} exactly once at application boot (before any
 * component renders).  Subsequent calls are no-ops thanks to the
 * `$MYOXUS_SETUP` guard.
 *
 * After setup, `globalThis.environment` contains flags such as `isMobile`,
 * `isSafari`, `isSelfHosted`, `publicPath`, and `subPath`.  Any flag can be
 * overridden at runtime by embedding `<meta name="env:<flag>" content="...">` tags
 * in the HTML document (used by the server to inject deployment-specific values).
 */

import { UaHelper } from "./ua-helper.js";

declare global {
  /**
   * Process-local guard for bootstrapping `globalThis.environment`.
   *
   * The flag lives on `globalThis` because the environment package is imported
   * by multiple entry points; keeping the guard global prevents double
   * initialisation without requiring a shared module singleton across bundles.
   */
  var $MYOXUS_SETUP: boolean | undefined;
}

/**
 * Initialises `globalThis.environment` with UA-derived platform flags and any
 * `<meta name="env:*">` overrides baked into the HTML document.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function setupGlobal() {
  if (globalThis.$MYOXUS_SETUP) {
    return;
  }

  let environment: Environment = {
    isLinux: false,
    isMacOs: false,
    isSafari: false,
    isWindows: false,
    isFireFox: false,
    isChrome: false,
    isIOS: false,
    isPwa: false,
    isMobile: false,
    isSelfHosted: false,
    // publicPath is the root of assets files
    publicPath: "/",
    // subPath is the path to access the affine service
    subPath: "",
  };

  if (globalThis.navigator) {
    const uaHelper = new UaHelper(globalThis.navigator);

    environment = {
      ...environment,
      isMobile: uaHelper.isMobile,
      isLinux: uaHelper.isLinux,
      isMacOs: uaHelper.isMacOs,
      isSafari: uaHelper.isSafari,
      isWindows: uaHelper.isWindows,
      isFireFox: uaHelper.isFireFox,
      isChrome: uaHelper.isChrome,
      isIOS: uaHelper.isIOS,
      isPwa: uaHelper.isStandalone,
    };
    // Chrome on iOS is still Safari
    if (environment.isChrome && !environment.isIOS) {
      environment = {
        ...environment,
        isSafari: false,
        isFireFox: false,
        isChrome: true,
        chromeVersion: uaHelper.getChromeVersion(),
      };
    }
  }

  applyEnvironmentOverrides(environment);

  globalThis.environment = environment;
  globalThis.$MYOXUS_SETUP = true;
}

/**
 * Reads `<meta name="env:*">` tags from the document and applies the values
 * as overrides on the given `environment` object.
 *
 * This allows server-rendered HTML to inject deployment-specific configuration
 * (e.g. `isSelfHosted`, `publicPath`, `subPath`) without a separate JS bundle
 * or API call.
 *
 * String-typed flags are written as-is; all other types are parsed as JSON.
 * Unknown flag names (not present in the environment object) are silently
 * ignored to prevent prototype-pollution.
 *
 * @internal Only called by {@link setupGlobal}.
 */
function applyEnvironmentOverrides(environment: Environment) {
  if (typeof document === "undefined") {
    return;
  }

  const metaTags = document.querySelectorAll("meta");

  metaTags.forEach((meta) => {
    if (!meta.name.startsWith("env:")) {
      return;
    }

    const name = meta.name.substring(4);

    // all environments should have default value
    // so ignore non-defined overrides
    if (name in environment) {
      // @ts-expect-error safe
      environment[name] =
        // @ts-expect-error safe
        typeof environment[name] === "string"
          ? meta.content
          : JSON.parse(meta.content);
    }
  });
}
