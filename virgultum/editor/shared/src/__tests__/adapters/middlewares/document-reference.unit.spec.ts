import type { BlockSnapshot, DocSnapshot } from "@virgultum/store";
import { expect, it } from "vitest";

import {
  prepareMarkdownExportSnapshots,
  markdownDocumentReferences,
  configureMarkdownReferenceMetas,
  configuredDocumentReferenceTitle,
  prepareQualifiedNativeExportSnapshot,
} from "../../../adapters/middlewares/document-reference";

it("prepares wide valid documents without a second block-count limit, while rejecting cycles and excessive depth", async () => {
  const block = (id: string): BlockSnapshot => ({
    type: "block",
    id,
    flavour: "myoxus:paragraph",
    props: { text: { delta: [{ insert: id }] } },
    children: [],
  });
  const root = block("root");
  root.flavour = "myoxus:page";
  root.children = Array.from({ length: 10_001 }, (_, i) => block(`item-${i}`));
  const snapshot: DocSnapshot = {
    type: "page",
    meta: { id: "wide", title: "Wide document", createDate: 0, tags: [] },
    blocks: root,
  };
  const captured = new Map([[snapshot.meta.id, snapshot]]);
  const titles = new Map([[snapshot.meta.id, snapshot.meta.title]]);
  const prepared = await prepareMarkdownExportSnapshots(captured, titles);
  expect(prepared.snapshots.get("wide")!.blocks.children).toHaveLength(10_001);
  expect(prepared.nativeTargets.get("wide")!.at(-1)?.blockId).toBe(
    "item-10000",
  );
  expect(prepared.snapshots.get("wide")).not.toBe(snapshot);

  root.children = [root];
  await expect(
    prepareMarkdownExportSnapshots(captured, titles),
  ).rejects.toThrow("tree limits");
  root.children = [];
  let parent = root;
  for (let i = 0; i < 101; i++) {
    const child = block(`nested-${i}`);
    parent.children = [child];
    parent = child;
  }
  await expect(
    prepareMarkdownExportSnapshots(captured, titles),
  ).rejects.toThrow("tree limits");
});

it("keeps qualified document/citation addresses separate from same-key local references and literals", async () => {
  const root: BlockSnapshot = {
    type: "block",
    id: "body",
    flavour: "myoxus:paragraph",
    children: [],
    props: {
      text: {
        delta: [
          {
            insert: "local",
            attributes: {
              reference: { type: "LinkedPage", pageId: "same-key" },
            },
          },
          {
            insert: "foreign",
            attributes: {
              reference: {
                type: "LinkedPage",
                pageId: "same-key",
                workspaceId: "foreign",
              },
            },
          },
          {
            insert: "citation",
            attributes: {
              footnote: {
                reference: {
                  type: "doc",
                  docId: "same-key",
                  workspaceId: "foreign",
                },
              },
            },
          },
          {
            insert: "same-key",
            attributes: { link: "https://example.test/same-key" },
          },
        ],
      },
    },
  };
  const qualified: string[][] = [];
  const local = markdownDocumentReferences(root, "source", (id, workspace) =>
    qualified.push([workspace, id]),
  );
  expect([...local.keys()]).toEqual(["same-key"]);
  // Canonical resolution receives the containing workspace for local addresses too.
  expect(qualified).toEqual([
    ["source", "same-key"],
    ["foreign", "same-key"],
    ["foreign", "same-key"],
  ]);
  const configs = new Map<string, string>();
  configureMarkdownReferenceMetas(configs, [
    { id: "same-key", title: "Local" },
    { id: "same-key", workspaceId: "foreign", title: "Foreign" },
  ]);
  expect(configuredDocumentReferenceTitle(configs, "same-key")).toBe("Local");
  expect(configuredDocumentReferenceTitle(configs, "same-key", "foreign")).toBe(
    "Foreign",
  );
  expect(
    configuredDocumentReferenceTitle(configs, "same-key", "denied"),
  ).toBeUndefined();
  const snapshot: DocSnapshot = {
    type: "page",
    meta: { id: "source", title: "Source", createDate: 0, tags: [] },
    blocks: root,
  };
  const exported = await prepareQualifiedNativeExportSnapshot(snapshot, {
    id: "actual-body-workspace",
  } as never);
  expect(
    (
      exported.blocks.props.text as {
        delta: { attributes?: { reference?: { workspaceId?: string } } }[];
      }
    ).delta[0].attributes?.reference?.workspaceId,
  ).toBe("actual-body-workspace");
  expect(JSON.stringify(snapshot)).not.toContain("actual-body-workspace");
  expect(JSON.stringify(exported)).toContain("https://example.test/same-key");
});
