// SPDX-License-Identifier: MIT

import type { BuildContext as EsbuildContext } from "esbuild";
import * as esbuild from "esbuild";

import { config } from "./common";
import { createBuildContext } from "./lib/build-context";
import {
  type ManagedProcess,
  startProcess,
  yarnInvocation,
} from "./lib/process";

const context = createBuildContext();
const watchMode = process.argv.includes("--watch");
const stderrFilterPatterns = [/ExtensionLoadWarning/];
let electronProcess: ManagedProcess | undefined;

async function spawnOrReloadElectron(): Promise<void> {
  if (watchMode) return;
  if (electronProcess) await electronProcess.stop("reload");

  const nodeOptions = process.env.NODE_OPTIONS?.replace(/--import=[^\s]*/, "");
  const yarn = yarnInvocation(context.repoRoot, [
    "exec",
    "electron",
    ".",
    "--inspect",
  ]);
  electronProcess = startProcess({
    ...yarn,
    cwd: context.electronDir,
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    stdio: "pipe",
  });
  electronProcess.child.stdout?.on("data", (data) => {
    const message = data.toString().trim();
    if (message) console.log(message);
  });
  electronProcess.child.stderr?.on("data", (data) => {
    const message = data.toString().trim();
    if (
      message &&
      !stderrFilterPatterns.some((pattern) => pattern.test(message))
    ) {
      console.error(message);
    }
  });
  void electronProcess.completion.catch((error) => console.error(error));
}

async function watchLayers(): Promise<EsbuildContext> {
  let initialBuild = false;
  let resolveInitial!: (value: EsbuildContext) => void;
  const initial = new Promise<EsbuildContext>((resolve) => {
    resolveInitial = resolve;
  });
  const common = config(context);
  const buildContext = await esbuild.context({
    ...common,
    plugins: [
      ...(common.plugins ?? []),
      {
        name: "electron-dev:reload-app-on-layers-change",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            if (initialBuild) await spawnOrReloadElectron();
            else {
              initialBuild = true;
              resolveInitial(buildContext);
            }
          });
        },
      },
    ],
  });
  await buildContext.watch();
  return initial;
}

const stop = () => {
  if (!electronProcess) {
    process.exit(0);
  }
  void electronProcess.stop("parent signal").finally(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await watchLayers();
if (watchMode) console.log("Watching for changes...");
else {
  console.log("Starting electron...");
  await spawnOrReloadElectron();
  console.log("Electron is started, watching for changes...");
}
