// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  helperEventChannelManifest,
  helperHandlerChannelManifest,
} from "@myoxus/desktop-api-contract";

import { createExposedMeta, parseExposedMeta } from "../shared/exposed-meta";

function getHelperExposedMeta() {
  return parseExposedMeta(
    createExposedMeta(helperHandlerChannelManifest, helperEventChannelManifest),
    helperHandlerChannelManifest,
    helperEventChannelManifest,
    "helper exposed metadata",
  );
}

/**
 * Every document using preload.js receives the same complete bridge surface.
 * Helper runtime maps are independently checked against these manifests in the
 * UtilityProcess before it exposes them.
 */
export async function getRendererAdditionalArguments(windowName: string) {
  const { getExposedMeta } = await import("./exposed");
  return [
    `--main-exposed-meta=${JSON.stringify(getExposedMeta())}`,
    `--helper-exposed-meta=${JSON.stringify(getHelperExposedMeta())}`,
    `--window-name=${windowName}`,
  ];
}
