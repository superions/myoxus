// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Admin-specific bootstrap. Replaces @myoxus/core/bootstrap/browser so that
// the admin bundle does not pull in editor/desktop Core modules. Import order
// matters: env must be first, polyfills second, telemetry last.

// ── 1. Env constants + global environment object ─────────────────────────────
import "@myoxus/env/constant";

import { setupGlobal } from "@myoxus/env/global";

setupGlobal();

// ── 2. Webpack public path ────────────────────────────────────────────────────

declare let __webpack_public_path__: string;
__webpack_public_path__ = environment.publicPath;

// ── 3. Browser polyfills ─────────────────────────────────────────────────────
import "core-js/es/array/to-spliced";
import "core-js/es/array/to-reversed";
import "core-js/es/array/to-sorted";
import "core-js/es/set/union.js";
import "core-js/es/set/difference.js";
import "core-js/es/set/intersection.js";
import "core-js/es/set/is-subset-of.js";
import "core-js/modules/esnext.symbol.async-dispose";
import "core-js/modules/esnext.symbol.dispose";
import "core-js/proposals/iterator-helpers-stage-3";
import "core-js/features/promise/with-resolvers";

(function polyfillEventLoop() {
  globalThis.requestIdleCallback =
    globalThis.requestIdleCallback ||
    function (cb) {
      const start = Date.now();
      return setTimeout(function () {
        cb({
          didTimeout: false,
          timeRemaining: function () {
            return Math.max(0, 50 - (Date.now() - start));
          },
        });
      }, 1);
    };

  globalThis.cancelIdleCallback = globalThis.cancelIdleCallback || clearTimeout;
})();

// ── 4. Telemetry ─────────────────────────────────────────────────────────────
import { readCachedTelemetryPreference } from "@myoxus/infra";
import { sentry, tracker } from "@myoxus/track";

tracker.init();
sentry.init();

if (
  typeof localStorage !== "undefined" &&
  readCachedTelemetryPreference(localStorage) === false
) {
  sentry.disable();
  tracker.opt_out_tracking();
}
