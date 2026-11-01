import { describe, expect, test, vi } from "vitest";

import { createDevServerConfigFromEnv } from "./bundle-shared";

describe("createDevServerConfigFromEnv", () => {
  test("keeps frontend state by using HMR instead of full-page reloads", () => {
    const config = createDevServerConfigFromEnv();

    expect(config.hot).toBe(true);
    expect(config.liveReload).toBe(false);
  });
});

const { messages } = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock("@rspack/dev-server", () => ({
  RspackDevServer: class {
    sendMessage(...args: unknown[]) {
      messages(...args);
    }
  },
}));
import { FrontendDevServer } from "./frontend-dev-server";

test("frontend HMR publishes the primary compiler hash without losing aggregate diagnostics", () => {
  let done: ((stats: { hash: string }) => void) | undefined;
  const tap = vi.fn((_options, callback) => {
    done = callback;
  });
  const compiler = { compilers: [{ hooks: { done: { tap } } }] };
  const server = new FrontendDevServer({}, compiler as never);
  expect(tap.mock.calls[0][0].stage).toBe(-1);
  done!({ hash: "html-runtime" });
  const clients: never[] = [];
  server.sendMessage(clients, "hash", "html-runtimeworker-runtime");
  expect(messages).toHaveBeenLastCalledWith(
    clients,
    "hash",
    "html-runtime",
    undefined,
  );
  const errors = ["worker compile failed"];
  server.sendMessage(clients, "errors", errors);
  expect(messages).toHaveBeenLastCalledWith(
    clients,
    "errors",
    errors,
    undefined,
  );
});
