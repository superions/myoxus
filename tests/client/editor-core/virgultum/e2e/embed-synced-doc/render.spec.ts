import { expect } from "@playwright/test";

import { enterPlaygroundRoom } from "../utils/actions";
import { test } from "../utils/playwright";
import { initEmbedSyncedDocState } from "./utils";

test.describe("embed-synced-doc render", () => {
  test.beforeEach(async ({ page }) => {
    await enterPlaygroundRoom(page);
  });

  test("nested embed synced doc should be rendered as card when depth >=1", async ({
    page,
  }) => {
    await initEmbedSyncedDocState(
      page,
      [
        { title: "Root", content: "Hello from Root" },
        { title: "Doc 2", content: "Hello from Doc 2" },
        { title: "Doc 3", content: "Hello from Doc 3" },
      ],
      { chain: true },
    );

    expect(await page.locator("myoxus-embed-synced-doc-block").count()).toBe(2);
    expect(await page.locator("myoxus-paragraph").count()).toBe(2);
    expect(await page.locator("myoxus-embed-synced-doc-card").count()).toBe(1);
    expect(await page.locator("editor-host").count()).toBe(2);
  });

  test("page-mode embed synced doc hides edgeless-only notes", async ({
    page,
  }) => {
    const [, embedDocId] = await initEmbedSyncedDocState(page, [
      { title: "Root", content: "root content" },
      { title: "Doc 2", content: "visible content" },
    ]);

    await page.evaluate((embedDocId) => {
      const { collection, $virgultum } = window;
      const Text = $virgultum.store.Text;
      const { NoteDisplayMode } = $virgultum.editorModel;
      const store = collection.getDoc(embedDocId)!.getStore();
      const rootId = store.root!.id;
      const hiddenNoteId = store.addBlock(
        "myoxus:note",
        {
          displayMode: NoteDisplayMode.EdgelessOnly,
        },
        rootId,
      );
      store.addBlock(
        "myoxus:paragraph",
        {
          text: new Text("hidden content"),
        },
        hiddenNoteId,
      );
    }, embedDocId);

    const embedBlock = page.locator("myoxus-embed-synced-doc-block").first();
    await expect(embedBlock.getByText("visible content")).toBeVisible();
    await expect(embedBlock.getByText("hidden content")).toHaveCount(0);
  });
});
