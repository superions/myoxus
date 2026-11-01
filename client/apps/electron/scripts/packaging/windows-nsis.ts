// SPDX-License-Identifier: AGPL-3.0-or-later

import { createBuildContext } from "../lib/build-context";
import { buildWindowsInstaller } from "../lib/windows-native-packager";
import {
  assertPackagingTarget,
  loadPackagingIdentity,
} from "../lib/packaging-config";
import {
  ensurePackagedApplication,
  packageWithNativeTools,
} from "../lib/packaging-runner";

const context = createBuildContext();
assertPackagingTarget(context);
if (context.platform !== "win32")
  throw new Error("NSIS packaging requires --platform win32");
const identity = await loadPackagingIdentity(context);
await ensurePackagedApplication(context);
const artifacts = await packageWithNativeTools({
  artifactExtensions: ["exe"],
  context,
  packageType: "nsis",
  target: "nsis",
  build: (input) => buildWindowsInstaller({ ...input, context, identity }),
});
process.stdout.write(`${artifacts.join("\n")}\n`);
