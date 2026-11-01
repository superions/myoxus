// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { LiveData } from "@myoxus/infra";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DocsService } from "../../doc";
import { WorkspaceService } from "../../workspace";
import { useEditor } from "./utils";

const mocks = vi.hoisted(() => ({
  docsService: null as unknown,
  workspace: null as unknown,
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useService: (service: unknown) => {
      if (service === DocsService) return mocks.docsService;
      if (service === WorkspaceService) return mocks.workspace;
      throw new Error("Unexpected service requested by useEditor test");
    },
  };
});

describe("useEditor", () => {
  beforeEach(() => {
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("opens a server-created document when its root metadata arrives after mount", async () => {
    const record$ = new LiveData<object | undefined>(undefined);
    const editor = {
      dispose: vi.fn(),
      setMode: vi.fn(),
      setSelector: vi.fn(),
    };
    const doc = {
      primaryMode$: new LiveData("page"),
      scope: { get: () => ({ createEditor: () => editor }) },
    };
    const release = vi.fn();
    const open = vi.fn(() => ({ doc, release }));

    mocks.docsService = {
      list: {
        doc$: () => record$,
        isReady$: new LiveData(true),
      },
      loaded: vi.fn(() => null),
      open,
    };
    mocks.workspace = {
      workspace: {
        engine: { doc: { addPriority: vi.fn(() => vi.fn()) } },
      },
    };

    const { result } = renderHook(() =>
      useEditor("server-created-doc", undefined, undefined, true),
    );
    expect(result.current.doc).toBeNull();
    expect(open).not.toHaveBeenCalled();

    act(() => record$.next({ id: "server-created-doc" }));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("server-created-doc"),
    );
    expect(result.current.doc).toBe(doc);

    act(() => record$.next(undefined));

    await waitFor(() => expect(result.current.doc).toBeNull());
    expect(release).toHaveBeenCalledOnce();
  });
});
