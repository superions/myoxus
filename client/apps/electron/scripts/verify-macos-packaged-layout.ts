// SPDX-License-Identifier: AGPL-3.0-or-later
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPackagedLayout } from "./lib/package-layout";

const app = path.resolve(process.argv[2] ?? "");
if (!app.endsWith(".app"))
  throw new Error("An unpacked .app bundle is required");
await assertPackagedLayout({
  checkoutRoot: path.resolve(
    fileURLToPath(new URL("../../../../", import.meta.url)),
  ),
  packagedPath: path.dirname(app),
  productName: path.basename(app, ".app"),
  targetPlatform: "darwin",
});
console.log(
  "Relocated ASAR, provenance, licenses and native binding layout verified",
);
