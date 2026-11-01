// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  helperEventChannelManifest,
  helperHandlerChannelManifest,
  mainEventChannelManifest,
  mainHandlerChannelManifest,
} from "@myoxus/desktop-api-contract";
import { describe, expect, test, vi } from "vitest";

import { createExposedMeta } from "../../src/shared/exposed-meta";

const mainMeta = createExposedMeta(
  mainHandlerChannelManifest,
  mainEventChannelManifest,
);

vi.mock("../../src/main/exposed", () => ({
  getExposedMeta: () => mainMeta,
}));

import { getRendererAdditionalArguments } from "../../src/main/renderer-arguments";

function parseArgument(arguments_: string[], name: string) {
  const prefix = `--${name}=`;
  const value = arguments_.find((argument) => argument.startsWith(prefix));
  if (!value) throw new Error(`Missing ${name}`);
  return JSON.parse(value.slice(prefix.length));
}

describe("renderer preload arguments", () => {
  test("provides the complete Main and Helper manifests to every window role", async () => {
    const expectedHelperMeta = createExposedMeta(
      helperHandlerChannelManifest,
      helperEventChannelManifest,
    );

    for (const role of [
      "onboarding",
      "main",
      "worker",
      "recording",
      "hidden-window",
    ]) {
      const arguments_ = await getRendererAdditionalArguments(role);
      expect(parseArgument(arguments_, "main-exposed-meta")).toEqual(mainMeta);
      expect(parseArgument(arguments_, "helper-exposed-meta")).toEqual(
        expectedHelperMeta,
      );
      expect(arguments_).toContain(`--window-name=${role}`);
    }
  });
});
