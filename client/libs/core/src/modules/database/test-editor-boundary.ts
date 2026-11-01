// SPDX-License-Identifier: AGPL-3.0-or-later

import { vi } from "vitest";

// These UI fixtures supply Workspace/Docs doubles and never create a block
// store. Keep document creation/export bootstrap out of service-token imports,
// and fail if a fixture crosses that boundary. The token must stay identical
// for leaf and barrel consumers. task-reference-insertion.spec.ts retains real
// editor bootstrap, the manager and native document-store integration.
vi.mock("@myoxus/core/modules/doc/services/docs", () => ({
  DocsService: class DocsService {
    constructor() {
      throw new Error(
        "Database UI harness must supply its Docs service double",
      );
    }
  },
}));

vi.mock("@myoxus/core/editor/manager/store", () => ({
  getStoreManager: () => {
    throw new Error("Database UI harness cannot initialize a document store");
  },
}));
