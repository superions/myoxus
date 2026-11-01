import { expect, type Page } from "@playwright/test";
import type { MyoxusReference } from "@virgultum/editor/inlines/reference";
import type { EmbedSyncedDocBlockProps } from "@virgultum/editor/model";

import {
  createNote,
  createShapeElement,
  getAllSortedIds,
  getIds,
  getSelectedBound,
  getSelectedIds,
  isIntersected,
  switchEditorMode,
} from "../utils/actions/edgeless";
import { pressBackspace, pressEscape } from "../utils/actions/keyboard.js";
import { enterPlaygroundRoom, waitNextFrame } from "../utils/actions/misc";
import { test } from "../utils/playwright";
import { initEmbedSyncedDocState } from "./utils";

test.describe("Embed synced doc in edgeless mode", () => {
  test.beforeEach(async ({ page }) => {
    // These internal toolbar actions must also work on HTTP, where the OS
    // Clipboard API is unavailable. No test here copies via that API.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
    });
    await enterPlaygroundRoom(page);
  });

  test("new edgeless embed synced doc should fit in height", async ({
    page,
  }) => {
    const [_, embedDocId] = await initEmbedSyncedDocState(page, [
      { title: "Root Doc", content: "hello root doc" },
      { title: "Page 1", content: "1\n2\n3\n4\n5\n6\n7" },
    ]);
    await switchEditorMode(page);

    const paragraphHeight = (
      await page
        .locator("myoxus-embed-synced-doc-block myoxus-paragraph")
        .boundingBox()
    )?.height;
    if (!paragraphHeight) {
      test.fail();
      return;
    }

    const createEmbedDocWithHeight = async (height: number) => {
      await page.evaluate(
        ({ embedDocId, height }) => {
          const std = window.editor.std;
          const surface = std.store.getModelsByFlavour("myoxus:surface")[0];
          std.store.addBlock(
            "myoxus:embed-synced-doc",
            {
              pageId: embedDocId,
              xywh: `[0,100,370,${height}]`,
            } satisfies Partial<EmbedSyncedDocBlockProps>,
            surface.id,
          );
        },
        { embedDocId, height },
      );
      await waitNextFrame(page);
    };

    const embedSyncedBlockInNote = page.locator(
      "myoxus-embed-edgeless-synced-doc-block",
    );

    {
      const initHeight = paragraphHeight - 50;
      await createEmbedDocWithHeight(initHeight);
      const embedSyncedBoxInNote = await embedSyncedBlockInNote.boundingBox();
      expect(embedSyncedBoxInNote?.height).toBeGreaterThan(initHeight);
    }

    await embedSyncedBlockInNote.click();
    await pressBackspace(page);

    {
      const initHeight = paragraphHeight + 50;
      await createEmbedDocWithHeight(initHeight);
      const embedSyncedBoxInNote = await embedSyncedBlockInNote.boundingBox();
      expect(embedSyncedBoxInNote?.height).toBeLessThan(initHeight);
    }
  });

  test.describe("edgeless element toolbar", () => {
    test.beforeEach(async ({ page }) => {
      await initEmbedSyncedDocState(page, [
        { title: "Root Doc", content: "hello root doc" },
        { title: "Page 1", content: "hello page 1", inEdgeless: true },
      ]);

      await switchEditorMode(page);

      const edgelessEmbedSyncedBlock = page.locator(
        "myoxus-embed-edgeless-synced-doc-block",
      );
      await edgelessEmbedSyncedBlock.click();
    });

    const getDocIds = async (page: Page) => {
      return page.evaluate(() => {
        return [...window.collection.docs.keys()];
      });
    };

    const locateToolbar = (page: Page) => {
      return page.getByTestId("selection-toolbar");
    };

    test('should insert embed-synced-doc into page when click "Insert into page" button', async ({
      page,
    }) => {
      const embedSyncedBlock = page.locator("myoxus-embed-synced-doc-block");
      const edgelessEmbedSyncedBlock = page.locator(
        "myoxus-embed-edgeless-synced-doc-block",
      );

      const toolbar = locateToolbar(page);
      const insertButton = toolbar.getByLabel("Insert to page");
      await insertButton.click();

      await expect(
        edgelessEmbedSyncedBlock,
        "the edgeless embed synced doc should be remained after click insert button",
      ).toBeVisible();

      await switchEditorMode(page);
      await expect(embedSyncedBlock).toBeVisible();
    });

    test('should render a reference node and all content of embed-synced-doc after click "Duplicate as note" button', async ({
      page,
    }) => {
      // switch doc
      const switchDoc = async () =>
        page.evaluate(() => {
          for (const [id, doc] of window.collection.docs.entries()) {
            if (id !== window.doc.id) {
              window.editor.doc = doc.getStore();
              window.doc = window.editor.doc;
              break;
            }
          }
        });
      await switchDoc();

      const toolbar = locateToolbar(page);

      const noteId = await createNote(page, [0, 100], "hello note");
      await pressEscape(page, 3);
      // This journey owns duplication of visible source content, not changing
      // the source Note's display mode through another toolbar.
      const source = await page.evaluate((noteId) => {
        window.doc.updateBlock(noteId, {
          displayMode:
            window.$virgultum.editorModel.NoteDisplayMode.DocAndEdgeless,
        });
        const paragraph = window.doc.getBlock(noteId)!.model.children[0];
        const nestedId = window.doc.addBlock(
          "myoxus:list",
          {
            type: "bulleted",
            text: new window.$virgultum.store.Text("nested detail"),
          },
          paragraph.id,
        );
        return { docId: window.doc.id, paragraphId: paragraph.id, nestedId };
      }, noteId);

      await switchDoc();

      const edgelessEmbedSyncedBlock = page.locator(
        "myoxus-embed-edgeless-synced-doc-block",
      );
      await edgelessEmbedSyncedBlock.click();
      await toolbar.getByLabel("Duplicate as note").click();

      const edgelessNotes = page.locator("myoxus-edgeless-note");
      await expect(edgelessNotes).toHaveCount(2);
      await expect(edgelessNotes.last()).toBeVisible();

      const blocks = edgelessNotes.last().locator("[data-block-id]");
      await expect(blocks).toHaveCount(4);
      const reference = blocks.nth(0).locator("myoxus-reference");
      const paragraph1 = blocks.nth(1).locator('[data-v-text="true"]');
      const paragraph2 = blocks.nth(2).locator('[data-v-text="true"]').first();
      await expect(blocks.nth(3)).toContainText("nested detail");
      const copiedIds = await blocks.evaluateAll((blocks) =>
        blocks.map((block) => block.getAttribute("data-block-id")),
      );
      expect(copiedIds).not.toContain(source.paragraphId);
      expect(copiedIds).not.toContain(source.nestedId);
      expect(
        await page.evaluate(({ docId, nestedId }) => {
          const store = window.collection.getDoc(docId)!.getStore();
          return {
            parent: store.getParent(nestedId)?.id,
            text: store.getBlock(nestedId)?.model.text?.toString(),
          };
        }, source),
      ).toEqual({ parent: source.paragraphId, text: "nested detail" });
      const refInfo = await reference.evaluate((reference: MyoxusReference) => {
        return reference.delta.attributes?.reference;
      });

      expect(refInfo).toEqual({
        type: "LinkedPage",
        pageId: (await getDocIds(page))[1],
      });
      await expect(paragraph1).toHaveText("hello page 1");
      await expect(paragraph2).toHaveText("hello note");
    });

    test("should be selected and not overlay with the embed-synced-doc after duplicating as note", async ({
      page,
    }) => {
      const prevIds = await getIds(page);

      const embedDocBound = await getSelectedBound(page);

      const toolbar = locateToolbar(page);
      await toolbar.getByLabel("Duplicate as note").click();

      const edgelessNotes = page.locator("myoxus-edgeless-note");
      await expect(edgelessNotes).toHaveCount(2);
      expect(await getSelectedIds(page)).toHaveLength(1);
      expect(prevIds).not.toContain((await getSelectedIds(page))[0]);
      await expect(edgelessNotes.last()).toBeVisible();

      const noteBound = await getSelectedBound(page);
      expect(isIntersected(embedDocBound, noteBound)).toBe(false);
    });

    test("edgeless note duplicated from embed-synced-doc should be above other elements", async ({
      page,
    }) => {
      await createShapeElement(page, [0, 0], [100, 100]);
      await pressEscape(page);
      await page.locator("myoxus-embed-edgeless-synced-doc-block").click();
      const toolbar = locateToolbar(page);
      await toolbar.getByLabel("Duplicate as note").click();

      const edgelessNotes = page.locator("myoxus-edgeless-note");
      await expect(edgelessNotes).toHaveCount(2);
      const duplicatedNoteId = (await getSelectedIds(page))[0];
      const sortedIds = await getAllSortedIds(page);
      //
      expect(sortedIds[sortedIds.length - 1]).toBe(duplicatedNoteId);
    });
  });
});
