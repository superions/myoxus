/** @vitest-environment happy-dom */
import { AdminWorkspaceSort, WorkspaceTypeFilter } from "@myoxus/graphql";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const useQueryMock = vi.fn();

vi.mock("@myoxus/admin/use-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

import { useWorkspaceList } from "./use-workspace-list";

describe("useWorkspaceList", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockImplementation((request: { query?: { id?: string } }) => {
      if (request?.query?.id === "adminWorkspacesListQuery") {
        return {
          data: { admin: { adminWorkspaces: [], adminWorkspacesCount: 0 } },
          isValidating: false,
        };
      }

      return {
        data: undefined,
        isValidating: false,
      };
    });
  });

  test("resets pageIndex to 0 when filter changes", async () => {
    const { result, rerender } = renderHook(
      ({ keyword }: { keyword?: string }) => useWorkspaceList({ keyword }),
      { initialProps: { keyword: "" } },
    );

    act(() => {
      result.current.setPagination({ pageIndex: 2, pageSize: 10 });
    });
    expect(result.current.pagination.pageIndex).toBe(2);

    rerender({ keyword: "team" });
    await act(async () => {});

    expect(result.current.pagination.pageIndex).toBe(0);
  });

  test("builds query variables from filters", () => {
    renderHook(() =>
      useWorkspaceList({
        keyword: "acme",
        features: ["copilot" as any, "indexer" as any],
        orderBy: AdminWorkspaceSort.CreatedAt,
        flags: {
          public: true,
          enableAi: false,
          enableSharing: true,
        },
      }),
    );

    const listCall = useQueryMock.mock.calls[0];
    expect(listCall).toBeDefined();

    const filter = (
      listCall[0] as { variables: { filter: Record<string, any> } }
    ).variables.filter;

    expect(filter.first).toBe(10);
    expect(filter.skip).toBe(0);
    expect(filter.keyword).toBe("acme");
    expect(filter.features).toEqual(["copilot", "indexer"]);
    expect(filter.orderBy).toBe(AdminWorkspaceSort.CreatedAt);
    expect(filter.public).toBe(true);
    expect(filter.enableAi).toBe(false);
    expect(filter.enableSharing).toBe(true);
    expect(filter.enableUrlPreview).toBeUndefined();
    expect(filter.enableDocEmbedding).toBeUndefined();
    expect(filter.workspaceType).toBeUndefined();
    expect(filter.isPersonal).toBeUndefined();
    expect(filter.gitSyncEnabled).toBeUndefined();
    expect(filter.gitSyncLastStatus).toBeUndefined();
  });

  test("typeFilter shared selects OU-owned workspaces", () => {
    renderHook(() => useWorkspaceList({ typeFilter: "shared" }));
    const filter = (useQueryMock.mock.calls[0][0] as any).variables.filter;
    expect(filter.workspaceType).toBe(WorkspaceTypeFilter.Shared);
    expect(filter.isPersonal).toBeUndefined();
  });

  test("typeFilter personal selects the canonical userspace", () => {
    renderHook(() => useWorkspaceList({ typeFilter: "personal" }));
    const filter = (useQueryMock.mock.calls[0][0] as any).variables.filter;
    expect(filter.workspaceType).toBe(WorkspaceTypeFilter.Personal);
  });

  test("typeFilter user-owned excludes the personal userspace", () => {
    renderHook(() => useWorkspaceList({ typeFilter: "user-owned" }));
    const filter = (useQueryMock.mock.calls[0][0] as any).variables.filter;
    expect(filter.workspaceType).toBe(WorkspaceTypeFilter.UserOwned);
  });

  test("typeFilter all sends no type constraints", () => {
    renderHook(() => useWorkspaceList({ typeFilter: "all" }));
    const filter = (useQueryMock.mock.calls[0][0] as any).variables.filter;
    expect(filter.workspaceType).toBeUndefined();
    expect(filter.isPersonal).toBeUndefined();
  });

  test("gitSyncFilter enabled sets gitSyncEnabled=true", () => {
    renderHook(() => useWorkspaceList({ gitSyncFilter: "enabled" }));
    const filter = (useQueryMock.mock.calls[0][0] as any).variables.filter;
    expect(filter.gitSyncEnabled).toBe(true);
    expect(filter.gitSyncLastStatus).toBeUndefined();
  });

  test("gitSyncFilter status maps to gitSyncLastStatus enum values", () => {
    renderHook(() => useWorkspaceList({ gitSyncFilter: "failed" }));
    let filter = (useQueryMock.mock.calls[0][0] as any).variables.filter;
    expect(filter.gitSyncLastStatus).toBe("Failed");
    expect(filter.gitSyncEnabled).toBeUndefined();

    useQueryMock.mockClear();
    renderHook(() => useWorkspaceList({ gitSyncFilter: "running" }));
    filter = (useQueryMock.mock.calls[0][0] as any).variables.filter;
    expect(filter.gitSyncLastStatus).toBe("Running");
  });

  test("returns defaults when query data is missing", () => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: undefined,
      isValidating: false,
    });

    const { result } = renderHook(() => useWorkspaceList());
    expect(result.current.workspaces).toEqual([]);
    expect(result.current.workspacesCount).toBe(0);
    expect(result.current.loading).toBe(true);
  });

  test("marks loading when the query is validating", () => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: { admin: { adminWorkspaces: [], adminWorkspacesCount: 0 } },
      isValidating: true,
    });

    const { result } = renderHook(() => useWorkspaceList());
    expect(result.current.loading).toBe(true);
  });
});
