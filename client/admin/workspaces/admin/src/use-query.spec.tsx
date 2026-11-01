/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  swrMock: vi.fn(),
  swrInfiniteMock: vi.fn(),
  gqlFetcherMock: vi.fn(),
}));

vi.mock("@myoxus/graphql", () => ({
  gqlFetcherFactory: () => mocks.gqlFetcherMock,
}));

vi.mock("swr", () => ({
  default: (...args: unknown[]) => mocks.swrMock(...args),
}));

vi.mock("swr/infinite", () => ({
  default: (...args: unknown[]) => mocks.swrInfiniteMock(...args),
}));

import { useQuery } from "./use-query";

const query = {
  id: "adminRuntimeContractQuery",
  op: "query",
  query: "query adminRuntimeContract { admin { serverInfo { version } } }",
} as const;

function QueryProbe() {
  useQuery({ query, variables: undefined });
  return null;
}

function VariablesQueryProbe() {
  useQuery({ query, variables: { workspaceId: "workspace-a" } as never });
  return null;
}

describe("admin useQuery contract", () => {
  beforeEach(() => {
    mocks.swrMock.mockReset();
    mocks.swrInfiniteMock.mockReset();
    mocks.gqlFetcherMock.mockReset();
    mocks.swrMock.mockReturnValue({ data: undefined });
    mocks.swrInfiniteMock.mockReturnValue({ data: undefined, size: 0 });
    mocks.gqlFetcherMock.mockResolvedValue({ admin: {} });
  });

  afterEach(() => cleanup());

  test("keeps the GraphQL fetcher wired to the original query options", async () => {
    render(<QueryProbe />);

    const fetcher = mocks.swrMock.mock.calls[0][1] as () => Promise<unknown>;
    await fetcher();

    expect(mocks.gqlFetcherMock).toHaveBeenCalledWith({
      query,
      variables: undefined,
    });
  });

  test("keeps variables addressable in the cache key for selective revalidation", () => {
    render(<VariablesQueryProbe />);

    expect(mocks.swrMock.mock.calls[0][0]).toEqual([
      "admin-graphql",
      query.id,
      { workspaceId: "workspace-a" },
    ]);
  });
});
