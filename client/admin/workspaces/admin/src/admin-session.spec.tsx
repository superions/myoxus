/**
 * @vitest-environment happy-dom
 */
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { adminServerConfigQuery } from "@myoxus/graphql";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mutateMock = vi.fn();

vi.mock("swr", () => ({
  useSWRConfig: () => ({ mutate: mutateMock }),
}));

import {
  AdminSessionInvalidationBridge,
  invalidateAdminSession,
  resetAdminSessionInvalidation,
} from "./admin-session";

describe("AdminSessionInvalidationBridge", () => {
  beforeEach(() => {
    mutateMock.mockReset();
    resetAdminSessionInvalidation();
  });

  afterEach(() => {
    cleanup();
    resetAdminSessionInvalidation();
  });

  test("clears only Admin GraphQL SWR cache keys on auth invalidation", async () => {
    render(<AdminSessionInvalidationBridge />);

    await act(async () => {
      invalidateAdminSession({
        reason: "graphql-unauthorized",
        channel: "graphql",
        operationName: "AdminSessionProbe",
        source: "/graphql",
        status: 200,
      });
    });

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));
    const [predicate, value, options] = mutateMock.mock.calls[0] as [
      (key: unknown) => boolean,
      unknown,
      { revalidate?: boolean },
    ];

    expect(predicate(["admin-graphql", "AdminDashboard", undefined])).toBe(
      true,
    );
    expect(
      predicate(["admin-graphql", adminServerConfigQuery.id, undefined]),
    ).toBe(false);
    expect(predicate(["cloud", "AdminDashboard", undefined])).toBe(false);
    expect(predicate(["local", "AdminDashboard", undefined])).toBe(false);
    expect(predicate("cloud")).toBe(false);
    expect(value).toBeUndefined();
    expect(options).toEqual({ revalidate: false });
  });
});
