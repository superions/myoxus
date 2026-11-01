// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["loaded.spec.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["json"],
      reportsDirectory: process.env.MYOXUS_VITEST4_COVERAGE_DIR,
    },
  },
});
