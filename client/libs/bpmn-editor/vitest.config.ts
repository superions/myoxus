import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    name: "bpmn-source",
    environment: "node",
    include: ["client/libs/bpmn-editor/src/source.spec.ts"],
  },
});
