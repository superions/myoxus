/**
 * Regression guard: adminFlush* mutations must be exported.
 *
 * These three mutations are generated from `graphql/admin/cache-flush.gql`.
 * If the .gql file is deleted, renamed, or the codegen is skipped, the
 * exports become `undefined` and the admin-frontend fails to build with
 * opaque webpack ESModulesLinkingErrors. This test catches that regression
 * at the library level instead.
 */
import { describe, expect, it } from "vitest";

import {
  adminFlushAllDocCachesMutation,
  adminFlushDocMetadataCacheMutation,
  adminFlushDocMetadataProjectionCacheMutation,
  adminFlushDocSnapshotCacheMutation,
} from "../graphql";

describe("admin flush-cache mutations", () => {
  it("adminFlushDocSnapshotCacheMutation is a well-formed mutation descriptor", () => {
    expect(adminFlushDocSnapshotCacheMutation).toMatchObject({
      id: "adminFlushDocSnapshotCacheMutation",
      op: "adminFlushDocSnapshotCache",
    });
    expect(adminFlushDocSnapshotCacheMutation.query).toContain(
      "mutation adminFlushDocSnapshotCache",
    );
  });

  it("adminFlushDocMetadataCacheMutation is a well-formed mutation descriptor", () => {
    expect(adminFlushDocMetadataCacheMutation).toMatchObject({
      id: "adminFlushDocMetadataCacheMutation",
      op: "adminFlushDocMetadataCache",
    });
    expect(adminFlushDocMetadataCacheMutation.query).toContain(
      "mutation adminFlushDocMetadataCache",
    );
  });

  it("adminFlushDocMetadataProjectionCacheMutation is a well-formed mutation descriptor", () => {
    expect(adminFlushDocMetadataProjectionCacheMutation).toMatchObject({
      id: "adminFlushDocMetadataProjectionCacheMutation",
      op: "adminFlushDocMetadataProjectionCache",
    });
    expect(adminFlushDocMetadataProjectionCacheMutation.query).toContain(
      "mutation adminFlushDocMetadataProjectionCache",
    );
  });

  it("adminFlushAllDocCachesMutation is a well-formed mutation descriptor", () => {
    expect(adminFlushAllDocCachesMutation).toMatchObject({
      id: "adminFlushAllDocCachesMutation",
      op: "adminFlushAllDocCaches",
    });
    expect(adminFlushAllDocCachesMutation.query).toContain(
      "mutation adminFlushAllDocCaches",
    );
  });
});
