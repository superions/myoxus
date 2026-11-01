import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/s3-compat/src/**/*.spec.ts"],
    name: "tools-s3-compat",
  },
});
