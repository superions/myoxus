/**
 * @file index.spec.ts — @myoxus/error
 *
 * Unit tests for {@link UserFriendlyError} construction and predicate methods.
 *
 * Covers:
 *  - Creating from a {@link GraphQLError} (server response path)
 *  - Creating from a generic Error, plain object, string, and null
 *  - `isNetworkError()`, `is(name)`, `isStatus(status)` predicates
 */
import { describe, expect, it } from "vitest";

import {
  GraphQLError,
  isDatabaseConflictErrorName,
  UserFriendlyError,
} from "..";

describe("user friendly error", () => {
  it("should create from graphql error", () => {
    const gqlError = new GraphQLError("test", {
      extensions: {
        status: 400,
        code: "BAD_REQUEST",
        type: "BAD_REQUEST",
        name: "BAD_REQUEST",
        message: "test",
      },
    });

    const error = UserFriendlyError.fromAny(gqlError);

    expect(error.name).toBe("BAD_REQUEST");
    expect(error.status).toBe(400);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.type).toBe("BAD_REQUEST");
    expect(error.message).toBe("test");
  });

  it("should preserve unstructured graphql error messages", () => {
    const gqlError = new GraphQLError("document not found");

    const error = UserFriendlyError.fromAny(gqlError);

    expect(error.message).toBe("document not found");
  });

  it("preserves machine-readable GraphQL extensions without a legacy envelope", () => {
    const latestState = JSON.stringify({
      kind: "row",
      editRevision: 3,
      title: "Remote title",
    });
    const gqlError = new GraphQLError("database row changed", {
      extensions: {
        code: "MIX_DATABASE_ROW_CONFLICT",
        type: "MIX_DATABASE_ROW_CONFLICT",
        name: "MIX_DATABASE_ROW_CONFLICT",
        latestState,
      },
    });

    const error = UserFriendlyError.fromAny(gqlError);

    expect(error).toMatchObject({
      status: 500,
      code: "MIX_DATABASE_ROW_CONFLICT",
      type: "MIX_DATABASE_ROW_CONFLICT",
      name: "MIX_DATABASE_ROW_CONFLICT",
      message: "database row changed",
    });
    expect(error.extensions).toMatchObject({
      code: "MIX_DATABASE_ROW_CONFLICT",
      latestState,
    });
    expect(error.isDatabaseConflict()).toBe(true);
  });

  it("classifies only the canonical stale-write error family", () => {
    expect(isDatabaseConflictErrorName("MIX_DATABASE_CELL_CONFLICT")).toBe(
      true,
    );
    expect(isDatabaseConflictErrorName("MIX_DATABASE_BULK_CONFLICT")).toBe(
      true,
    );
    expect(isDatabaseConflictErrorName("MIX_DATABASE_CONFLICT")).toBe(false);
    expect(isDatabaseConflictErrorName("BAD_REQUEST")).toBe(false);
  });

  it("should create from any error", () => {
    const error = UserFriendlyError.fromAny(new Error("test"));
    expect(error.message).toBe("test");
  });

  it("should create from object", () => {
    const error = UserFriendlyError.fromAny({
      name: "BAD_REQUEST",
      status: 400,
      code: "BAD_REQUEST",
      type: "BAD_REQUEST",
      message: "test",
    });

    expect(error.message).toBe("test");
  });

  it("should create from string", () => {
    const error = UserFriendlyError.fromAny("test error");
    expect(error.message).toBe("test error");
  });

  it("should create fallback error", () => {
    const error = UserFriendlyError.fromAny(null);

    expect(error.message).toBe(
      "Unhandled error raised. Please contact us for help.",
    );
  });

  it("should test network error", () => {
    const error = UserFriendlyError.fromAny({
      name: "NETWORK_ERROR",
      status: 500,
      code: "INTERNAL_SERVER_ERROR",
      type: "INTERNAL_SERVER_ERROR",
      message: "test",
    });

    expect(error.isNetworkError()).toBe(true);

    const error2 = UserFriendlyError.fromAny({
      name: "BAD_REQUEST",
      status: 400,
      code: "BAD_REQUEST",
      type: "BAD_REQUEST",
      message: "test",
    });

    expect(error2.isNetworkError()).toBe(false);
  });

  it("should test name", () => {
    const error = UserFriendlyError.fromAny({
      name: "BAD_REQUEST",
      status: 400,
      code: "BAD_REQUEST",
      type: "BAD_REQUEST",
      message: "test",
    });

    expect(error.is("BAD_REQUEST")).toBe(true);
  });

  it("should test status", () => {
    const error = UserFriendlyError.fromAny({
      name: "BAD_REQUEST",
      status: 400,
      code: "BAD_REQUEST",
      type: "BAD_REQUEST",
      message: "test",
    });

    expect(error.isStatus(400)).toBe(true);
  });
});
