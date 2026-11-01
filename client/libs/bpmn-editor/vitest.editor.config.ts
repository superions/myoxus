// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    name: "bpmn-editor",
    environment: "node",
    include: ["client/libs/bpmn-editor/src/editor/**/*.spec.ts"],
  },
});
