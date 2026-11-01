// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import type { Workspace } from "@myoxus/core/modules/workspace";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, useState, type PropsWithChildren } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Doc } from "yjs";
import { workspaceOverviewSettingsQuery } from "@myoxus/graphql";

import { useWorkspaceOverviewRead } from "./read";

afterEach(cleanup);

import {
  countWorkspaceDescriptionCodepoints,
  MAX_WORKSPACE_DESCRIPTION_CODEPOINTS,
  normalizeWorkspaceDescription,
} from "./description";

describe("workspace overview description contract", () => {
  test("normalizes CRLF while preserving markup-looking plain text", () => {
    expect(
      normalizeWorkspaceDescription("First\r\n<script>literal</script>\rLast"),
    ).toBe("First\n<script>literal</script>\rLast");
  });

  test("counts Unicode code points rather than UTF-16 code units", () => {
    const maximum = "😀".repeat(MAX_WORKSPACE_DESCRIPTION_CODEPOINTS);
    expect(countWorkspaceDescriptionCodepoints(maximum)).toBe(2_000);
    expect(countWorkspaceDescriptionCodepoints(`${maximum}😀`)).toBe(2_001);
    expect(maximum.length).toBe(4_000);
  });
});

test("Organizer and metadata changes reset pages after native ACK; late reads cannot replace another folder", async () => {
  const folders = new Doc({ guid: "db$folders" });
  const root = new Doc({ guid: "workspace" });
  let acknowledge: (() => void) | undefined;
  let pendingSync = Promise.resolve();
  const waitForSynced = vi.fn(
    async (_id?: string, _signal?: AbortSignal) => pendingSync,
  );
  let remoteName = "Original";
  let readable = true;
  let finishOldRead: ((value: unknown) => void) | undefined;
  let deferOldRead = false;
  const response = (id: string | null, name: string) => ({
    workspace: { overview: { folder: { id, name } } },
  });
  const overviewGql = vi.fn(
    async ({ variables }: { variables: { folderId: string | null } }) => {
      if (deferOldRead && variables.folderId === "first")
        return new Promise((resolve) => {
          finishOldRead = resolve;
        });
      return readable
        ? response(variables.folderId, remoteName)
        : { workspace: null };
    },
  );
  const gql = vi.fn(
    ({
      query,
      variables,
    }: {
      query: { id: string };
      variables: { folderId: string | null };
    }) =>
      query.id === workspaceOverviewSettingsQuery.id
        ? Promise.resolve({
            workspace: {
              overviewSettings: {
                revision: 0,
                registerPresentation: null,
                folders: [],
              },
            },
          })
        : overviewGql({ variables }),
  );
  const resetPage = vi.fn();
  const server = {
    id: "server",
    baseUrl: "https://example.test",
    gql,
  } as unknown as WorkspaceServerService["server"];
  const workspace = {
    id: "workspace",
    engine: { doc: { waitForSynced } },
    rootYDoc: root,
  } as unknown as Workspace;
  const cache = new Map();
  const { result, rerender, unmount } = renderHook(
    ({ folderId, generation }: { folderId: string; generation: number }) => {
      const [offset, setOffset] = useState(50);
      return useWorkspaceOverviewRead({
        server,
        accountId: "owner",
        workspace,
        folders,
        folderId,
        offset,
        metadataGeneration: generation,
        tagRevision: 0,
        visibilityKey: "authenticated",
        onResetPage: () => {
          resetPage();
          setOffset(0);
        },
      });
    },
    {
      initialProps: { folderId: "first", generation: 0 },
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(
          SWRConfig,
          { value: { provider: () => cache } },
          children,
        ),
    },
  );
  try {
    await waitFor(() =>
      expect(result.current.data?.workspace?.overview.folder?.name).toBe(
        "Original",
      ),
    );
    pendingSync = new Promise((resolve) => {
      acknowledge = resolve;
    });
    act(() => {
      folders.getMap("folder").set("name", "Renamed");
    });
    await waitFor(() =>
      expect(result.current.isLoading || result.current.isValidating).toBe(
        true,
      ),
    );
    expect(overviewGql).toHaveBeenCalledTimes(1);
    expect(waitForSynced).toHaveBeenCalledWith(
      "db$folders",
      expect.any(AbortSignal),
    );
    remoteName = "Renamed";
    deferOldRead = true;
    await act(async () => {
      acknowledge!();
    });
    await waitFor(() => expect(overviewGql).toHaveBeenCalledTimes(2));
    rerender({ folderId: "second", generation: 0 });
    await waitFor(() =>
      expect(result.current.data?.workspace?.overview.folder?.id).toBe(
        "second",
      ),
    );
    await act(async () => {
      finishOldRead!(response("first", "Old response"));
    });
    expect(result.current.data?.workspace?.overview.folder?.id).toBe("second");
    expect(result.current.data?.workspace?.overview.folder?.name).toBe(
      "Renamed",
    );
    expect(resetPage).toHaveBeenCalledTimes(1);
    remoteName = "Current metadata";
    rerender({ folderId: "second", generation: 1 });
    await waitFor(() =>
      expect(result.current.data?.workspace?.overview.folder?.name).toBe(
        "Current metadata",
      ),
    );
    readable = false;
    rerender({ folderId: "second", generation: 2 });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.data?.workspace).toBeNull();
  } finally {
    unmount();
    folders.destroy();
    root.destroy();
  }
});
