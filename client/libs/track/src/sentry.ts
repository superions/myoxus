/**
 * @file sentry.ts — @myoxus/track
 *
 * Sentry error-tracking integration for the Myoxus frontend.
 *
 * Exports a `sentry` singleton with `init`, `enable`, and `disable` methods.
 * Initialisation is skipped when `globalThis.SENTRY_RELEASE` is already set
 * (e.g. in environments that pre-configure Sentry externally).
 *
 * The integration includes `reactRouterV7BrowserTracingIntegration` for
 * automatic React Router v7 route change instrumentation.
 *
 * Consumers: application boot sequences in `client/admin` and `client/web`.
 *
 * @example
 * ```ts
 * sentry.init();          // called once at app boot
 * sentry.enable();        // called when the user opts in
 * sentry.disable();       // called when the user opts out
 * ```
 */

import * as Sentry from "@sentry/react";
import { useEffect } from "react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router";

/**
 * Factory that creates the `sentry` singleton.
 *
 * Using a factory pattern ensures that `client` is private to this closure
 * and cannot be mutated from outside.
 */
function createSentry() {
  let client: Sentry.BrowserClient | undefined;
  const wrapped = {
    /**
     * Initialises the Sentry SDK.
     *
     * Called once at application boot.  A no-op when `globalThis.SENTRY_RELEASE`
     * is already set, which indicates that Sentry was configured externally
     * (e.g. via a CDN snippet on a self-hosted deployment).
     *
     * Configures the React Router v6 browser tracing integration automatically
     * so that route changes are captured as Sentry performance transactions.
     */
    init() {
      if (!globalThis.SENTRY_RELEASE) {
        // https://docs.sentry.io/platforms/javascript/guides/react/#configure
        client = Sentry.init({
          dsn: BUILD_CONFIG.SENTRY_DSN,
          debug: BUILD_CONFIG.debug ?? false,
          environment: BUILD_CONFIG.appBuildType,
          integrations: [
            Sentry.reactRouterV7BrowserTracingIntegration({
              useEffect,
              useLocation,
              useNavigationType,
              createRoutesFromChildren,
              matchRoutes,
            }),
          ],
        }) as Sentry.BrowserClient;

        Sentry.setTags({
          distribution: BUILD_CONFIG.distribution,
          appVersion: BUILD_CONFIG.appVersion,
          editorVersion: BUILD_CONFIG.editorVersion,
        });
      }
    },
    /**
     * Enables Sentry event reporting.
     *
     * Called when the user opts in to error tracking.  Has no effect if
     * `init()` has not been called.
     */
    enable() {
      if (client) {
        client.getOptions().enabled = true;
      }
    },
    /**
     * Disables Sentry event reporting without tearing down the client.
     *
     * Called when the user opts out of error tracking.  Errors are silently
     * dropped until `enable()` is called again.
     */
    disable() {
      if (client) {
        client.getOptions().enabled = false;
      }
    },
  };

  return wrapped;
}

export const sentry = createSentry();
