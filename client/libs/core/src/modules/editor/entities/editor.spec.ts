// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { LiveData } from "@myoxus/infra";
import type { DocMode, ReferenceParams } from "@virgultum/editor/model";
import { describe, expect, test, vi } from "vitest";

import { Editor, ensureEdgelessSurface } from "./editor";

const createDoc = ({
  hasRoot = true,
  hasSurface = false,
  readonly = false,
}: {
  hasRoot?: boolean;
  hasSurface?: boolean;
  readonly?: boolean;
}) => {
  let surface = hasSurface;
  const addBlock = vi.fn(() => {
    surface = true;
    return "surface-id";
  });

  return {
    doc: {
      getBlocksByFlavour: vi.fn(() => (surface ? [{ id: "surface-id" }] : [])),
      root: hasRoot ? { id: "root-id" } : null,
      readonly,
      addBlock,
    },
    addBlock,
  };
};

describe("ensureEdgelessSurface", () => {
  test("adds the canonical surface to a writable Page-only document", () => {
    const { doc, addBlock } = createDoc({});

    expect(ensureEdgelessSurface(doc as never)).toBe(true);
    expect(addBlock).toHaveBeenCalledWith("myoxus:surface", {}, "root-id");
  });

  test("does not duplicate an existing surface", () => {
    const { doc, addBlock } = createDoc({ hasSurface: true });

    expect(ensureEdgelessSurface(doc as never)).toBe(true);
    expect(addBlock).not.toHaveBeenCalled();
  });

  test.each([
    { hasRoot: false, readonly: false },
    { hasRoot: true, readonly: true },
  ])("keeps an unrepairable document out of Edgeless", (options) => {
    const { doc, addBlock } = createDoc(options);

    expect(ensureEdgelessSurface(doc as never)).toBe(false);
    expect(addBlock).not.toHaveBeenCalled();
  });
});

test("a route without a mode follows late metadata while an explicit Page choice remains authoritative", async () => {
  const route = new LiveData<ReferenceParams>({});
  const primaryMode = new LiveData<DocMode>("page");
  const mode = new LiveData<DocMode>("page");
  const harness = {
    workbenchView: null,
    scrollPosition: { page: null, edgeless: null },
    doc: { primaryMode$: primaryMode },
    mode$: mode,
    selector$: new LiveData(undefined),
    setMode: (value: DocMode) => {
      mode.next(value);
      return true;
    },
    setSelector: vi.fn(),
  };
  const unbind = Editor.prototype.bindWorkbenchView.call(
    harness as never,
    {
      getScrollPosition: () => null,
      queryString$: () => route,
      updateQueryString: vi.fn(),
    } as never,
  );
  try {
    primaryMode.next("edgeless");
    await vi.waitFor(() => expect(mode.value).toBe("edgeless"));
    expect(route.value).toEqual({});
    route.next({ mode: "page" });
    await vi.waitFor(() => expect(mode.value).toBe("page"));
    primaryMode.next("page");
    primaryMode.next("edgeless");
    expect(mode.value).toBe("page");
  } finally {
    unbind();
  }
});

test("a deferred source render cannot clear or select over a newer check location", async () => {
  let finishRender!: () => void;
  const updateComplete = new Promise<void>((resolve) => {
    finishRender = resolve;
  });
  const origin = document.createElement("div");
  document.body.append(origin);
  const title = document.createElement("div");
  const richText = document.createElement("rich-text");
  const inline = {
    focusEnd: vi.fn(),
    waitForUpdate: vi.fn(async () => {}),
    syncInlineRange: vi.fn(),
    setInlineRange: vi.fn(),
  };
  Object.assign(richText, { inlineEditor: inline });
  title.append(richText);
  origin.append(title);
  const old = {
    result: { sourceDocId: "source", isCurrent: vi.fn(() => false) },
    diagnostic: { kind: "title", blockId: "page", start: 0, length: 9 },
  };
  const current = {
    result: { sourceDocId: "source", isCurrent: vi.fn(() => true) },
    diagnostic: { kind: "title", blockId: "page", start: 12, length: 17 },
  };
  // Both requests enter the same asynchronous native renderer. The first
  // capture becomes stale while the newer capture is waiting for that render.
  old.result.isCurrent.mockReturnValue(true);
  const checks = { location$: new LiveData<typeof current | null>(old) };
  const harness = {
    editorContainer$: new LiveData(null),
    doc: { id: "source" },
    mode$: new LiveData("page"),
    scrollPosition: { page: null, edgeless: null },
    focusAt$: new LiveData(null),
    framework: { getOptional: () => checks },
    isPresenting$: new LiveData(false),
  };
  const unbind = Editor.prototype.bindEditorContainer.call(
    harness as never,
    {
      origin,
      updateComplete,
      host: { std: { get: () => undefined } },
    } as never,
    title as never,
  );
  try {
    old.result.isCurrent.mockReturnValue(false);
    checks.location$.setValue(current);
    finishRender();
    await vi.waitFor(() =>
      expect(inline.setInlineRange).toHaveBeenCalledOnce(),
    );
    expect(inline.syncInlineRange).toHaveBeenCalledExactlyOnceWith({
      index: 12,
      length: 17,
    });
    expect(inline.setInlineRange).toHaveBeenCalledExactlyOnceWith({
      index: 12,
      length: 17,
    });
    expect(checks.location$.value).toBeNull();
  } finally {
    unbind();
    origin.remove();
  }
});
