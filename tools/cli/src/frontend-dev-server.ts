// SPDX-License-Identifier: AGPL-3.0-or-later

import { RspackDevServer } from "@rspack/dev-server";

/** Bundle configs put the HTML compiler first. MultiStats concatenates all
 * child hashes, while the window HMR runtime knows only its HTML compilation. */
export class FrontendDevServer extends RspackDevServer {
  private frontendHash: string | undefined;

  constructor(...args: ConstructorParameters<typeof RspackDevServer>) {
    super(...args);
    const compiler = args[1];
    const primary = "compilers" in compiler ? compiler.compilers[0] : compiler;
    // Capture before MultiCompiler's default-stage done hook publishes stats.
    primary?.hooks.done.tap(
      { name: "myoxus-frontend-hmr-hash", stage: -1 },
      (stats) => {
        this.frontendHash = stats.hash ?? undefined;
      },
    );
  }

  override sendMessage(
    ...[clients, type, data, params]: Parameters<RspackDevServer["sendMessage"]>
  ) {
    const payload = type === "hash" ? (this.frontendHash ?? data) : data;
    // Keep the native aggregate warnings/errors; only runtime identity changes.
    super.sendMessage(clients, type, payload, params);
  }
}
