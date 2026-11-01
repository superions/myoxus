import { describe, expect, test } from "vitest";

import { shouldUseRemoteBacklinkIndexer } from "./doc-backlinks";

describe("backlink indexer selection", () => {
  test("keeps cloud workspaces on the local block index when battery saving is disabled", () => {
    expect(shouldUseRemoteBacklinkIndexer(false, "cloud")).toBe(false);
  });

  test("uses the remote index only for cloud workspaces with battery saving enabled", () => {
    expect(shouldUseRemoteBacklinkIndexer(true, "cloud")).toBe(true);
    expect(shouldUseRemoteBacklinkIndexer(true, "local")).toBe(false);
  });
});
