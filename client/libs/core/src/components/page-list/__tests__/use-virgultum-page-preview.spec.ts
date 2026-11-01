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

let docCollection: TestWorkspace;

const extensions = getStoreManager().config.init().value.get("store");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["requestIdleCallback"] });
  docCollection = new TestWorkspace({ id: "test" });
  docCollection.meta.initialize();
  const initPage = async (page: Store) => {
    page.load();
    expect(page).not.toBeNull();
    const pageBlockId = page.addBlock("myoxus:page", {
      title: new Text(""),
    });
    const frameId = page.addBlock("myoxus:note", {}, pageBlockId);
    page.addBlock("myoxus:paragraph", {}, frameId);
  };
  const store = docCollection.createDoc("page0").getStore({ extensions });
  await initPage(store);
});

describe("useVirgultumPagePreview", () => {
  test("basic", async () => {
    const page = docCollection.getDoc("page0")?.getStore();
    if (!page) {
      throw new Error("Page not found");
    }
    const id = page.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("Hello, world!"),
      },
      page.getModelsByFlavour("myoxus:note")[0].id,
    );
    const hook = renderHook(() => useAtomValue(useVirgultumPagePreview(page)));
    expect(hook.result.current).toBe("Hello, world!");
    page.transact(() => {
      page.getModelById(id)!.text!.insert("Test", 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    hook.rerender();
    expect(hook.result.current).toBe("TestHello, world!");

    // Insert before
    page.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("First block!"),
      },
      page.getModelsByFlavour("myoxus:note")[0].id,
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    hook.rerender();
    expect(hook.result.current).toBe("First block! TestHello, world!");
  });

  test("ignores edgeless surface content when deriving page text previews", async () => {
    const page = docCollection.getDoc("page0")?.getStore();
    if (!page) {
      throw new Error("Page not found");
    }

    const pageBlock = page.getModelsByFlavour("myoxus:page")[0];
    page.addBlock("myoxus:surface", {}, pageBlock.id);
    page.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("Page body text"),
      },
      page.getModelsByFlavour("myoxus:note")[0].id,
    );

    const hook = renderHook(() => useAtomValue(useVirgultumPagePreview(page)));

    expect(hook.result.current).toBe("Page body text");
  });
});
