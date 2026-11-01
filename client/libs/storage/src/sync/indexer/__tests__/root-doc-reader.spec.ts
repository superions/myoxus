// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment node
 */

import { describe, expect, test } from "vitest";
import { Array as YArray, Doc as YDoc, Map as YMap, Text as YText } from "yjs";

import { readAllBlocksForIndexer } from "../root-doc-reader";

function createBlock(
  blocks: YMap<YMap<unknown>>,
  id: string,
  flavour: string,
  children: string[] = [],
) {
  const block = new YMap<unknown>();
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  const childIds = new YArray<string>();
  childIds.push(children);
  block.set("sys:children", childIds);
  blocks.set(id, block);
  return block;
}

describe("storage indexer reader boundary", () => {
  test("loads and crawls document blocks without DOM globals", async () => {
    expect(globalThis.document).toBeUndefined();

    const rootYDoc = new YDoc({ guid: "workspace" });
    const pages = new YArray<YMap<unknown>>();
    const targetPage = new YMap<unknown>();
    targetPage.set("id", "target-doc");
    targetPage.set("title", "Target document");
    pages.push([targetPage]);
    rootYDoc.getMap("meta").set("pages", pages);

    const ydoc = new YDoc({ guid: "source-doc" });
    const blocks = ydoc.getMap<YMap<unknown>>("blocks");
    const page = createBlock(blocks, "page", "myoxus:page", ["note"]);
    page.set("prop:title", new YText("Source document"));
    const note = createBlock(blocks, "note", "myoxus:note", [
      "paragraph",
      "bpmn",
    ]);
    note.set("prop:displayMode", "page");
    const paragraph = createBlock(blocks, "paragraph", "myoxus:paragraph");
    const text = new YText();
    paragraph.set("prop:text", text);
    text.insert(0, "See ");
    text.insert(4, "target", {
      reference: {
        pageId: "target-doc",
        type: "LinkedPage",
      },
    });
    const bpmn = createBlock(blocks, "bpmn", "myoxus:bpmn");
    bpmn.set("prop:title", new YText("Procurement <script>"));
    bpmn.set("prop:sourceHeads", {
      head: "<definitions>private-process-source</definitions>",
    });
    bpmn.set("prop:preview", "<svg onload='private-preview-code()'/>");

    const result = await readAllBlocksForIndexer({
      ydoc,
      rootYDoc,
      spaceId: "workspace",
      maxSummaryLength: 1000,
    });

    expect(result?.summary).toBe("See target");
    expect(result?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "paragraph",
          markdownPreview: expect.stringContaining(
            "[target](/workspace/workspace/target-doc)",
          ),
          refDocId: ["target-doc"],
        }),
      ]),
    );
    expect(
      result?.blocks.find((block) => block.blockId === "bpmn")?.content,
    ).toBe("BPMN: Procurement <script>");
    const indexed = result?.blocks.map(({ content, markdownPreview }) => ({
      content,
      markdownPreview,
    }));
    expect(
      indexed?.find((block) => block.markdownPreview?.includes("BPMN:"))
        ?.markdownPreview,
    ).toContain("` BPMN: Procurement <script> `");
    expect(JSON.stringify(indexed)).not.toMatch(
      /private-process-source|private-preview-code|<definitions|<svg/,
    );
    ydoc.destroy();
    rootYDoc.destroy();
  });
});
