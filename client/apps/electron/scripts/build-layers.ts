// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import path from "node:path";

import * as esbuild from "esbuild";

import { config } from "./common";
import {
  createBuildContext,
  nativeBuildEnvironment,
} from "./lib/build-context";
import {
  assertBundledRuntime,
  assertDistLayout,
  replaceDirectoryAtomically,
} from "./lib/package-layout";
import { runProcess, yarnInvocation } from "./lib/process";

const context = createBuildContext();
const distDir = path.join(context.electronDir, "dist");
async function emptyDist(): Promise<void> {
  const prepared = `${distDir}.empty-${process.pid}`;
  await fs.rm(prepared, { recursive: true, force: true });
  await fs.mkdir(prepared, { recursive: true });
  await replaceDirectoryAtomically(prepared, distDir);
}

async function buildLayers(): Promise<void> {
  await emptyDist();
  const common = config(context);
  const define: Record<string, string> = {
    ...common.define,
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "development",
    ),
    "process.env.BUILD_TYPE": JSON.stringify(context.buildType),
  };
  if (process.env.BUILD_TYPE_OVERRIDE) {
    define["process.env.BUILD_TYPE_OVERRIDE"] = JSON.stringify(
      process.env.BUILD_TYPE_OVERRIDE,
    );
  }

  const result = await esbuild.build({ ...common, define, metafile: true });
  assertBundledRuntime(result.metafile);

  // Invoke the binding owner directly so Yarn cannot consume the copy target
  // while resolving the nested workspace script on a clean package runner.
  const yarn = yarnInvocation(context.repoRoot, [
    "run",
    "-T",
    "r",
    "./scripts/ensure-native-bindings.ts",
    "--build-missing",
    "--copy-to",
    distDir,
  ]);
  await runProcess({
    ...yarn,
    cwd: context.electronDir,
    env: nativeBuildEnvironment(context),
  });
  await assertDistLayout(distDir, context.repoRoot);

  if (process.env.METAFILE) {
    const reportDir = path.join(
      context.outDir,
      "sourcemaps",
      `${context.platform}-${context.arch}`,
    );
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, "esbuild-metafile.json"),
      `${JSON.stringify(result.metafile, null, 2)}\n`,
    );
  }
}

await buildLayers();
console.log("Electron runtime layers built");
