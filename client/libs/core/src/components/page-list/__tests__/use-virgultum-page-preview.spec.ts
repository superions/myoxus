// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * @vitest-environment happy-dom
 */
import "fake-indexeddb/auto";

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { renderHook } from "@testing-library/react";
import { type Store, Text } from "@virgultum/editor/store";
import { TestWorkspace } from "@virgultum/editor/store/test";
import { useAtomValue } from "jotai";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useVirgultumPagePreview } from "../use-virgultum-page-preview";

let workspace: TestWorkspace;
const storeExtensions = getStoreManager().config.init().value.get("store");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestIdleCallback"] });
  workspace = new TestWorkspace({ id: "preview-test" });
  workspace.meta.initialize();

  const store: Store = workspace
    .createDoc("page0")
    .getStore({ extensions: storeExtensions });
  store.load();
  const pageId = store.addBlock("myoxus:page", { title: new Text("") });
  const noteId = store.addBlock("myoxus:note", {}, pageId);
  store.addBlock("myoxus:paragraph", {}, noteId);
});

describe("useVirgultumPagePreview", () => {
  test("extracts and updates text previews as content blocks change", async () => {
    const page = workspace.getDoc("page0")?.getStore();
    if (!page) throw new Error("Expected page0 store");

    const noteId = page.getModelsByFlavour("myoxus:note")[0].id;
    const paragraphId = page.addBlock(
      "myoxus:paragraph",
      { text: new Text("Hello, world!") },
      noteId,
    );

    const hook = renderHook(() => useAtomValue(useVirgultumPagePreview(page)));
    expect(hook.result.current).toBe("Hello, world!");

    page.transact(() => {
      page.getModelById(paragraphId)!.text!.insert("Test", 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    hook.rerender();
    expect(hook.result.current).toBe("TestHello, world!");

    page.addBlock(
      "myoxus:paragraph",
      { text: new Text("First block!") },
      noteId,
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    hook.rerender();
    expect(hook.result.current).toBe("First block! TestHello, world!");
  });

  test("excludes edgeless surface blocks from text previews", () => {
    const page = workspace.getDoc("page0")?.getStore();
    if (!page) throw new Error("Expected page0 store");

    const pageBlock = page.getModelsByFlavour("myoxus:page")[0];
    const noteId = page.getModelsByFlavour("myoxus:note")[0].id;
    page.addBlock("myoxus:surface", {}, pageBlock.id);
    page.addBlock(
      "myoxus:paragraph",
      { text: new Text("Page body text") },
      noteId,
    );

    const hook = renderHook(() => useAtomValue(useVirgultumPagePreview(page)));
    expect(hook.result.current).toBe("Page body text");
  });
});
