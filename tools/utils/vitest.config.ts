import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "tools-utils",
    environment: "node",
    include: ["tools/utils/src/**/*.spec.ts"],
  },
});
