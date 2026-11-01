// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type TestDragSource = {
  data: {
    entity?: { type: "database" | "doc"; id: string };
    from?: {
      at: "all-docs:list";
      groupId?: string;
    };
    selection?: { type: "doc"; ids: string[] };
  };
};

type CapturedDropTarget = {
  canDrop?: (input: { source: TestDragSource }) => boolean;
  data: { at: string; tagId: string };
  dropEffect?: "copy" | "link" | "move";
  onDrop?: (input: { source: TestDragSource }) => Promise<void> | void;
};

type TestLiveData<T> = { value: T };

type TestTag = {
  archived$: TestLiveData<boolean>;
  id: string;
  tag: ReturnType<typeof vi.fn>;
};

const harness = vi.hoisted(() => ({
  assignTag: vi.fn(async (_docId: string) => undefined),
  clearPageTags: vi.fn(async (_docId: string) => [] as string[]),
  docsService: null as unknown as {
    list: {
      docsMap$: TestLiveData<Map<string, { tagIds$: TestLiveData<string[]> }>>;
    };
  },
  dropTargets: [] as CapturedDropTarget[],
  reportError: vi.fn(),
  tagService: null as unknown as {
    tagList: {
      catalogState$: TestLiveData<{
        error: null;
        status: "ready";
        tags: Array<{ id: string }>;
      }>;
      clearPageTags: ReturnType<typeof vi.fn>;
      movePageTag: ReturnType<typeof vi.fn>;
      tagByTagId$: (tagId: string) => TestLiveData<TestTag | undefined>;
    };
  },
  trackDrop: vi.fn(),
  trackTag: vi.fn(),
  movePageTag: vi.fn(
    async (
      _docId: string,
      _sourceTagId: string | null,
      targetTagId: string,
    ) => [targetTagId],
  ),
}));

vi.mock("@myoxus/core/components/explorer/explorer-items-view", async () => {
  const { createElement, forwardRef } = await import("react");
  return {
    ExplorerListGroupFrame: forwardRef<
      HTMLElement,
      { children?: ReactNode; groupId?: string }
    >(({ children, groupId }, ref) =>
      createElement(
        "section",
        { ref, "data-group-id": String(groupId) },
        children,
      ),
    ),
  };
});

vi.mock("@myoxus/core/components/tags", () => ({
  useWorkspaceTagCommands: () => ({ reportError: harness.reportError }),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const infra = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...infra,
    useLiveData: (stream: TestLiveData<unknown> | null) => stream?.value,
    useService: (service: { name?: string }) => {
      if (service.name === "TagService") return harness.tagService;
      if (service.name === "DocsService") return harness.docsService;
      throw new Error(`Unexpected service: ${service.name ?? "unknown"}`);
    },
  };
});

vi.mock("@myoxus/track", () => ({
  track: {
    $: {
      navigationPanel: {
        tags: {
          drop: harness.trackDrop,
          tagDoc: harness.trackTag,
        },
      },
    },
  },
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const facade = await importOriginal<typeof import("@myoxus/ui-facade")>();
  return {
    ...facade,
    useDropTarget: (factory: () => CapturedDropTarget) => {
      harness.dropTargets.push(factory());
      return {
        draggedOver: false,
        dropTargetRef: () => undefined,
      };
    },
  };
});

import { AllContentTagGroupFrame } from "./tag-scope";

const live = <T,>(value: T): TestLiveData<T> => ({ value });

const source = (
  entityId: string,
  selectionIds?: string[],
  sourceTagGroupId?: string,
): TestDragSource => ({
  data: {
    entity: { type: "doc", id: entityId },
    from:
      sourceTagGroupId === undefined
        ? { at: "all-docs:list" }
        : {
            at: "all-docs:list",
            groupId: sourceTagGroupId,
          },
    selection: selectionIds ? { type: "doc", ids: selectionIds } : undefined,
  },
});

beforeEach(() => {
  const redTag: TestTag = {
    archived$: live(false),
    id: "tag-red",
    tag: harness.assignTag,
  };
  harness.docsService = {
    list: {
      docsMap$: live(
        new Map([
          ["doc-a", { tagIds$: live(["tag-blue"]) }],
          ["doc-b", { tagIds$: live([]) }],
          ["doc-c", { tagIds$: live(["tag-red"]) }],
        ]),
      ),
    },
  };
  harness.tagService = {
    tagList: {
      catalogState$: live({
        error: null,
        status: "ready",
        tags: [{ id: redTag.id }],
      }),
      clearPageTags: harness.clearPageTags,
      movePageTag: harness.movePageTag,
      tagByTagId$: (tagId) => live(tagId === redTag.id ? redTag : undefined),
    },
  };
});

afterEach(() => {
  cleanup();
  harness.assignTag.mockClear();
  harness.clearPageTags.mockClear();
  harness.dropTargets.length = 0;
  harness.reportError.mockClear();
  harness.trackDrop.mockClear();
  harness.trackTag.mockClear();
  harness.movePageTag.mockClear();
});

describe("AllContentTagGroupFrame drag and drop", () => {
  test("moves from the source group and clears every tag through the untagged target", async () => {
    const named = render(
      <AllContentTagGroupFrame groupId="tag-red">
        Tagged documents
      </AllContentTagGroupFrame>,
    );
    const namedTarget = harness.dropTargets.find(
      (target) => target.data.tagId === "tag-red",
    );
    expect(namedTarget?.dropEffect).toBe("move");
    expect(
      namedTarget?.canDrop?.({
        source: source("doc-a", ["doc-a", "doc-c", "doc-a"], "tag-blue"),
      }),
    ).toBe(true);
    expect(
      namedTarget?.canDrop?.({ source: source("doc-c", undefined, "tag-red") }),
    ).toBe(false);

    await namedTarget?.onDrop?.({
      source: source("doc-a", ["doc-a", "doc-c", "doc-a"], "tag-blue"),
    });

    expect(harness.assignTag).not.toHaveBeenCalled();
    expect(harness.movePageTag).toHaveBeenCalledTimes(1);
    expect(harness.movePageTag).toHaveBeenCalledWith(
      "doc-a",
      "tag-blue",
      "tag-red",
    );

    await namedTarget?.onDrop?.({
      source: source("doc-b", undefined, ""),
    });
    expect(harness.movePageTag).toHaveBeenLastCalledWith(
      "doc-b",
      null,
      "tag-red",
    );

    named.unmount();
    render(
      <AllContentTagGroupFrame groupId="">
        Untagged documents
      </AllContentTagGroupFrame>,
    );
    const untaggedTarget = harness.dropTargets.find(
      (target) => target.data.tagId === "",
    );
    expect(untaggedTarget?.dropEffect).toBe("move");
    expect(untaggedTarget?.canDrop?.({ source: source("doc-b") })).toBe(false);
    expect(
      untaggedTarget?.canDrop?.({
        source: source("doc-a", ["doc-a", "doc-b", "doc-a"]),
      }),
    ).toBe(true);

    await untaggedTarget?.onDrop?.({
      source: source("doc-a", ["doc-a", "doc-b", "doc-a"], "tag-blue"),
    });

    expect(harness.clearPageTags).toHaveBeenCalledTimes(1);
    expect(harness.clearPageTags).toHaveBeenCalledWith("doc-a");
    expect(harness.reportError).not.toHaveBeenCalled();
    expect(harness.trackTag).toHaveBeenCalledTimes(3);
    expect(harness.trackDrop).toHaveBeenCalledTimes(3);
  });
});
