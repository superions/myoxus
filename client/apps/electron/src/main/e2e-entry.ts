// SPDX-License-Identifier: AGPL-3.0-or-later

import { app } from "electron";

const remoteDebuggingArgument = process.argv.indexOf(
  "--remote-debugging-port=0",
);
if (remoteDebuggingArgument > 0) {
  process.argv.splice(1, remoteDebuggingArgument);
}

const originalWhenReady = app.whenReady();
const originalEmit = app.emit.bind(app);
let readyEventArguments: unknown[] | undefined;

app.emit = ((event: string, ...args: unknown[]) => {
  if (event === "ready") {
    readyEventArguments = args;
    return app.listenerCount("ready") > 0;
  }
  return originalEmit(event, ...args);
}) as typeof app.emit;

let ready = false;
let markReady: (() => void) | undefined;
const controlledReady = new Promise<void>((resolve) => {
  markReady = resolve;
});

app.isReady = () => ready;
app.whenReady = () => controlledReady;

Object.assign(globalThis, {
  __playwright_run: async () => {
    await originalWhenReady;
    ready = true;
    markReady?.();
    originalEmit("ready", ...(readyEventArguments ?? []));
  },
});

void import("./index");
