// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import type { GraphQLQuery } from "@myoxus/graphql";
import { type PropsWithChildren } from "react";
import { SWRConfig, unstable_serialize } from "swr";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useMutateQueryResource } from "./use-mutation";

const mutateMock = vi.fn();
const cacheMode = vi.hoisted(() => ({ real: false }));

vi.mock("swr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("swr")>();
  return {
    ...actual,
    useSWRConfig: () =>
      cacheMode.real ? actual.useSWRConfig() : { mutate: mutateMock },
  };
});

function query(id: string): GraphQLQuery {
  return { id } as GraphQLQuery;
}

describe("useMutateQueryResource", () => {
  beforeEach(() => {
    mutateMock.mockReset();
    cacheMode.real = false;
  });

  test("clears an unmounted replaced bundle without discarding other templates", async () => {
    cacheMode.real = true;
    const selected = ["admin-graphql", "preview", { templateId: "tpl-1" }];
    const other = ["admin-graphql", "preview", { templateId: "tpl-2" }];
    const cache = new Map([
      [unstable_serialize(selected), { _k: selected, data: "old PDF" }],
      [unstable_serialize(other), { _k: other, data: "other PDF" }],
    ]);
    const wrapper = ({ children }: PropsWithChildren) => (
      <SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig>
    );
    const { result, unmount } = renderHook(() => useMutateQueryResource(), {
      wrapper,
    });
    await result.current(
      query("preview"),
      (vars: { templateId?: string } | undefined) =>
        vars?.templateId === "tpl-1",
      { clearCachedData: true },
    );
    expect(cache.get(unstable_serialize(selected))?.data).toBeUndefined();
    expect(cache.get(unstable_serialize(other))?.data).toBe("other PDF");
    unmount();
  });

  test("revalidates only SWR cache entries for the requested GraphQL query", async () => {
    const { result } = renderHook(() => useMutateQueryResource());

    await result.current(query("adminWorkspacesList"));

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const predicate = mutateMock.mock.calls[0]?.[0] as (
      key: unknown,
    ) => boolean;
    expect(
      predicate(["admin-graphql", "adminWorkspacesList", { first: 20 }]),
    ).toBe(true);
    expect(
      predicate(["admin-graphql", "adminWorkspace", { id: "workspace-a" }]),
    ).toBe(false);
    expect(predicate(["cloud", "adminWorkspacesList", { first: 20 }])).toBe(
      false,
    );
    expect(predicate("adminWorkspacesList")).toBe(false);
  });

  test("narrows revalidation with the caller supplied variable filter", async () => {
    const { result } = renderHook(() => useMutateQueryResource());

    await result.current(
      query("adminWorkspace"),
      (vars: { id?: string } | undefined) => vars?.id === "workspace-a",
    );

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const predicate = mutateMock.mock.calls[0]?.[0] as (
      key: unknown,
    ) => boolean;
    expect(
      predicate(["admin-graphql", "adminWorkspace", { id: "workspace-a" }]),
    ).toBe(true);
    expect(
      predicate(["admin-graphql", "adminWorkspace", { id: "workspace-b" }]),
    ).toBe(false);
  });
});
