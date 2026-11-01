// SPDX-License-Identifier: AGPL-3.0-or-later

import { createBuildContext } from "../lib/build-context";
import { buildDesktopArchives } from "../lib/archive-native-packager";
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
if (context.platform === "linux")
  throw new Error("Desktop archives require macOS or Windows");
const identity = await loadPackagingIdentity(context);
await ensurePackagedApplication(context);
const artifacts = await packageWithNativeTools({
  artifactExtensions: context.platform === "darwin" ? ["dmg", "zip"] : ["zip"],
  context,
  target: `desktop-${context.platform}-${context.arch}`,
  build: (input) => buildDesktopArchives({ ...input, context, identity }),
});
process.stdout.write(`${artifacts.join("\n")}\n`);
