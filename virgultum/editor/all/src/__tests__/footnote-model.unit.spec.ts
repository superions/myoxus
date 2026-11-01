// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FootNoteSchema } from "@virgultum/model";
import {
  MarkdownAdapter,
  normalizeFootnoteLabel,
  HtmlAdapter,
  PlainTextAdapter,
  MixTextAdapter,
  ClipboardAdapter,
} from "@virgultum/shared/adapters";
import {
  Slice,
  Text,
  wrapFakeNote,
  type BlockSnapshot,
} from "@virgultum/store";
import { BlockStdScope, TextSelection, type EditorHost } from "@virgultum/std";
import {
  insertLocalFootnote,
  renameLocalFootnote,
  navigateLocalFootnote,
  returnFromLocalFootnote,
  canReturnLocalFootnote,
  localFootnoteCaret,
  localFootnotePresentation,
  setLocalFootnotePlacement,
} from "@virgultum/shared/commands";
import { testStoreExtensions } from "./utils/store";
import type {
  FootnoteDefinitionBlockModel,
  ParagraphBlockModel,
  TableBlockModel,
} from "@virgultum/model";
import { describe, expect, test, vi } from "vitest";
import numberingFixture from "../../../../../build/fixtures/contracts/footnote-numbering.json";
import fixtures from "../../../../../build/fixtures/contracts/footnotes.json";
import { createJob } from "./utils/create-job";
import { getProvider } from "./utils/get-provider";

type Delta = {
  insert: string;
  attributes?: {
    footnote?: { label: string; definitionId?: string; reference?: unknown };
    [key: string]: unknown;
  };
};
const flatten = (blocks: BlockSnapshot[]): BlockSnapshot[] =>
  blocks.flatMap((block) => [block, ...flatten(block.children)]);
const markers = (snapshot: BlockSnapshot) =>
  flatten([snapshot]).flatMap((block) =>
    ((block.props.text as { delta?: Delta[] })?.delta ?? []).flatMap((part) =>
      part.attributes?.footnote ? [part.attributes.footnote] : [],
    ),
  );
const definitions = (snapshot: BlockSnapshot) =>
  flatten([snapshot]).filter(
    (block) => block.flavour === "myoxus:footnote-definition",
  );
const text = (block: BlockSnapshot) =>
  ((block.props.text as { delta?: Delta[] })?.delta ?? [])
    .map((part) => part.insert)
    .join("");

function assertLocalTargets(snapshot: BlockSnapshot) {
  const local = new Map(
    definitions(snapshot).map((block) => [block.id, block]),
  );
  for (const marker of markers(snapshot)) {
    expect(FootNoteSchema.safeParse(marker).success).toBe(true);
    if (marker.definitionId) {
      expect(local.get(marker.definitionId)).toBeDefined();
      expect(normalizeFootnoteLabel(marker.label)).toBe(
        normalizeFootnoteLabel(
          String(local.get(marker.definitionId)!.props.label),
        ),
      );
    }
  }
}

describe("parent-local native footnotes", () => {
  test.each(
    fixtures.filter(({ name }) => name !== "case-normalized duplicate"),
  )("shared Rust/client admission: $name", async (fixture) => {
    const job = createJob();
    const create = vi.spyOn(job.docCRUD, "create");
    const remove = vi.spyOn(job.docCRUD, "delete");
    const adapter = new MarkdownAdapter(job, getProvider());
    try {
      if (fixture.error) {
        await expect(
          adapter.toDocSnapshot({ file: fixture.source }),
        ).rejects.toThrow(fixture.error);
        expect(create).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        return;
      }
      const doc = await adapter.toDoc({ file: fixture.source });
      expect(doc).toBeDefined();
      expect(create).toHaveBeenCalledTimes(1);
      expect(doc!.workspace.meta.docMetas.map((meta) => meta.id)).toEqual([
        doc!.id,
      ]);
      expect(remove).not.toHaveBeenCalled();
      const snapshot = job.docToSnapshot(doc!)!;
      expect(snapshot).toBeDefined();
      expect(
        definitions(snapshot.blocks).map((block) => block.props.label),
      ).toEqual(fixture.labels);
      expect(markers(snapshot.blocks)).toHaveLength(fixture.markers!);
      assertLocalTargets(snapshot.blocks);
      expect(adapter.importDiagnostics.unreferencedFootnotes ?? 0).toBe(
        fixture.unreferenced,
      );
      const exported = await adapter.fromDocSnapshot({ snapshot });
      expect(adapter.exportDiagnostics.unreferencedFootnotes ?? 0).toBe(
        fixture.unreferenced,
      );
      for (const label of fixture.labels!)
        expect(exported.file.split(`[^${label}]:`)).toHaveLength(2);
      const again = await adapter.toBlockSnapshot({ file: exported.file });
      assertLocalTargets(again);
      expect(definitions(again).map((block) => block.props.label)).toEqual(
        fixture.labels,
      );
      expect(markers(again)).toHaveLength(fixture.markers!);
      expect((await adapter.fromBlockSnapshot({ snapshot: again })).file).toBe(
        exported.file,
      );
      if (fixture.name.startsWith("forward")) {
        const refs = markers(snapshot.blocks);
        expect(refs[0].definitionId).toBe(refs[1].definitionId);
        expect(definitions(snapshot.blocks)[0].children.map(text)).toEqual([
          "First body.",
          "Second paragraph.",
        ]);
      }
      if (fixture.name.startsWith("code and")) {
        expect(exported.file).toContain("`[^missing]`");
        expect(exported.file).toContain("[^missing]: not a definition");
      }
    } finally {
      job[Symbol.dispose]();
    }
  });

  test("HTML and plain reading keep complete bodies and accessible repeated navigation", async () => {
    const job = createJob();
    const provider = getProvider();
    try {
      const source = readFileSync(
        resolve(
          "build/fixtures/markdown/obsidian-vault/Structured footnotes.md",
        ),
        "utf8",
      );
      const bytes = readFileSync(
        resolve("build/fixtures/markdown/obsidian-vault/media/pixel.svg"),
      );
      job.assetsManager
        .getAssets()
        .set(
          "reading-pixel",
          new File([bytes], "pixel.svg", { type: "image/svg+xml" }),
        );
      job.assetsManager
        .getPathBlobIdMap()
        .set("media/pixel.svg", "reading-pixel");
      await job.assetsManager.writeToBlob("reading-pixel");
      const markdown = new MarkdownAdapter(job, provider);
      const snapshot = (await markdown.toDocSnapshot({
        file: source,
        assets: job.assetsManager,
      }))!;
      const html = new HtmlAdapter(job, provider);
      const output = await html.fromDocSnapshot({
        snapshot,
        assets: job.assetsManager,
      });
      expect(output.file).toContain('charset="utf-8"');
      const dom = new DOMParser().parseFromString(output.file, "text/html");
      expect(dom.querySelectorAll('[role="doc-footnote"]')).toHaveLength(2);
      expect(dom.querySelectorAll('[role="doc-noteref"]')).toHaveLength(3);
      expect(dom.querySelectorAll('[role="doc-backlink"]')).toHaveLength(3);
      const native = [...dom.querySelectorAll('[role="doc-footnote"]')];
      expect(native[0].querySelectorAll("td,th")).toHaveLength(6);
      expect(native[0].querySelector("ol")?.getAttribute("start")).toBe("3");
      expect(native[0].querySelectorAll('input[type="checkbox"]')).toHaveLength(
        2,
      );
      const markerIds = [
        ...dom.querySelectorAll("sup[data-myoxus-footnote-definition-id]"),
      ].map((n) => n.id);
      expect(new Set(markerIds).size).toBe(3);
      for (const link of dom.querySelectorAll(
        '[role="doc-noteref"], [role="doc-backlink"]',
      ))
        expect(
          dom.getElementById(link.getAttribute("href")!.slice(1)),
        ).not.toBeNull();
      job.assetsManager
        .getPathBlobIdMap()
        .set(dom.querySelector("img")!.getAttribute("src")!, "reading-pixel");
      const restored = (await html.toDocSnapshot({
        file: output.file,
        assets: job.assetsManager,
      }))!;
      assertLocalTargets(restored.blocks);
      expect(
        definitions(restored.blocks)[0].children.map((b) => b.flavour),
      ).toEqual(definitions(snapshot.blocks)[0].children.map((b) => b.flavour));
      expect(definitions(restored.blocks)[0].children).toHaveLength(8);
      const plain = await new PlainTextAdapter(job, provider).fromDocSnapshot({
        snapshot,
      });
      expect(plain.file.match(/\[Footnote 1\]/g)).toHaveLength(2);
      expect(plain.file).not.toContain("[^Research]");
      for (const body of [
        "Definition heading",
        "Nested unordered item",
        "Completed task",
        "Pending task",
        "literal[^not-a-reference]",
        "one",
        "two",
        "three",
        "Footnote 2:",
      ])
        expect(plain.file).toContain(body);
    } finally {
      job[Symbol.dispose]();
    }
  });

  test("adjacent local HTML markers keep independent anchors and reimport atom counts", async () => {
    const job = createJob();
    const provider = getProvider();
    try {
      const doc = (await new MarkdownAdapter(job, provider).toDocSnapshot({
        file: "Adjacent[^α][^α]\n\n[^α]: Complete body.\n",
      }))!;
      const html = new HtmlAdapter(job, provider);
      const output = await html.fromDocSnapshot({ snapshot: doc });
      const dom = new DOMParser().parseFromString(output.file, "text/html");
      expect(dom.querySelectorAll('[role="doc-noteref"]')).toHaveLength(2);
      expect(dom.querySelectorAll('[role="doc-backlink"]')).toHaveLength(2);
      const restored = (await html.toDocSnapshot({ file: output.file }))!;
      assertLocalTargets(restored.blocks);
      expect(
        flatten([restored.blocks])
          .flatMap((b) => (b.props.text as { delta?: Delta[] })?.delta ?? [])
          .filter((d) => d.attributes?.footnote?.definitionId)
          .reduce((n, d) => n + d.insert.length, 0),
      ).toBe(2);
    } finally {
      job[Symbol.dispose]();
    }
  });

  test("retained complex fixture keeps every ordered rich child and materializes one parent", async () => {
    const job = createJob();
    const create = vi.spyOn(job.docCRUD, "create");
    try {
      const source = readFileSync(
        resolve(
          "build/fixtures/markdown/obsidian-vault/Structured footnotes.md",
        ),
        "utf8",
      );
      const bytes = readFileSync(
        resolve("build/fixtures/markdown/obsidian-vault/media/pixel.svg"),
      );
      job.assetsManager
        .getAssets()
        .set(
          "footnote-pixel",
          new File([bytes], "pixel.svg", { type: "image/svg+xml" }),
        );
      job.assetsManager
        .getPathBlobIdMap()
        .set("media/pixel.svg", "footnote-pixel");
      await job.assetsManager.writeToBlob("footnote-pixel");
      const adapter = new MarkdownAdapter(job, getProvider());
      const doc = await adapter.toDoc({
        file: source,
        assets: job.assetsManager,
      });
      expect(doc).toBeDefined();
      expect(create).toHaveBeenCalledTimes(1);
      expect(doc!.workspace.meta.docMetas).toHaveLength(1);
      const snapshot = job.docToSnapshot(doc!)!;
      assertLocalTargets(snapshot.blocks);
      const research = definitions(snapshot.blocks)[0];
      expect(research.children.map((block) => block.flavour)).toEqual([
        "myoxus:paragraph",
        "myoxus:paragraph",
        "myoxus:paragraph",
        "myoxus:list",
        "myoxus:paragraph",
        "myoxus:code",
        "myoxus:image",
        "myoxus:table",
      ]);
      expect(research.children[0].props.text).toMatchObject({
        delta: expect.arrayContaining([
          { insert: "bold", attributes: { bold: true } },
          { insert: "emphasis", attributes: { italic: true } },
          { insert: "strike", attributes: { strike: true } },
          { insert: "inline code", attributes: { code: true } },
          {
            insert: "normal link",
            attributes: { link: "https://example.org/reference" },
          },
        ]),
      });
      expect(text(research.children[1])).toBe(
        "Second paragraph with a soft break and a hard break.\nContinued after the hard break.",
      );
      expect(research.children[2].props.type).toBe("h3");
      expect(research.children[3].props).toMatchObject({
        type: "numbered",
        order: 3,
      });
      expect(
        research.children[3].children.map((block) => ({
          type: block.props.type,
          checked: block.props.checked,
          text: text(block),
        })),
      ).toEqual([
        { type: "bulleted", checked: false, text: "Nested unordered item" },
        { type: "todo", checked: true, text: "Completed task" },
        { type: "todo", checked: false, text: "Pending task" },
      ]);
      expect(research.children[4].props.type).toBe("quote");
      expect(text(research.children[5])).toBe(
        'const source = "literal[^not-a-reference]";',
      );
      expect(research.children[6].props.sourceId).toBe("footnote-pixel");
      expect(
        Object.values(
          research.children[7].props.columns as Record<
            string,
            { textAlign: string }
          >,
        ).map((column) => column.textAlign),
      ).toEqual(["left", "center", "right"]);
      const exported = await adapter.fromDocSnapshot({
        snapshot,
        assets: job.assetsManager,
      });
      expect(exported.assetsIds).toEqual(["footnote-pixel"]);
      expect(
        new Uint8Array(
          await job.assetsManager
            .getAssets()
            .get("footnote-pixel")!
            .arrayBuffer(),
        ),
      ).toEqual(new Uint8Array(bytes));
      job.assetsManager
        .getPathBlobIdMap()
        .set("assets/pixel.svg", "footnote-pixel");
      const again = await adapter.toBlockSnapshot({
        file: exported.file,
        assets: job.assetsManager,
      });
      assertLocalTargets(again);
      expect(
        definitions(again)[0].children.map((block) => block.flavour),
      ).toEqual(research.children.map((block) => block.flavour));
      expect(
        (
          await adapter.fromBlockSnapshot({
            snapshot: again,
            assets: job.assetsManager,
          })
        ).file,
      ).toBe(exported.file);
    } finally {
      job[Symbol.dispose]();
    }
  });

  test("footnote clipboard HTML, mixed text and native slices keep full bodies and local identities", async () => {
    using job = createJob();
    const provider = getProvider();
    const source = readFileSync(
      resolve("build/fixtures/markdown/obsidian-vault/Structured footnotes.md"),
      "utf8",
    );
    const bytes = readFileSync(
      resolve("build/fixtures/markdown/obsidian-vault/media/pixel.svg"),
    );
    job.assetsManager
      .getAssets()
      .set("pixel", new File([bytes], "pixel.svg", { type: "image/svg+xml" }));
    job.assetsManager.getPathBlobIdMap().set("media/pixel.svg", "pixel");
    await job.assetsManager.writeToBlob("pixel");
    const markdown = new MarkdownAdapter(job, provider);
    const doc = (await markdown.toDoc({
      file: source,
      assets: job.assetsManager,
    }))!;
    const paragraph = doc
      .getBlocksByFlavour("myoxus:paragraph")
      .find(({ model }) =>
        model.text?.toString().startsWith("Parent reference"),
      )!.model;
    const snapshot = job.sliceToSnapshot(Slice.fromModels(doc, [paragraph]))!;
    wrapFakeNote(snapshot);
    expect(
      flatten(snapshot.content).filter(
        (b) => b.flavour === "myoxus:footnote-definition",
      ),
    ).toHaveLength(2);
    const create = vi.spyOn(job.docCRUD, "create");
    const remove = vi.spyOn(job.docCRUD, "delete");
    for (const adapter of [
      new HtmlAdapter(job, provider),
      new MixTextAdapter(job, provider),
      new ClipboardAdapter(job, provider),
    ]) {
      const payload = await adapter.fromSliceSnapshot({
        snapshot,
        assets: job.assetsManager,
      });
      if (adapter instanceof HtmlAdapter) {
        expect(payload.file).toContain('start="3"');
        expect(payload.file).toContain("<br");
        expect(payload.file).toContain("data:image/svg+xml;base64,");
      }
      if (adapter instanceof MixTextAdapter) {
        expect(payload.file).toContain("    ### Definition heading");
        expect(payload.file).toContain("    ```ts");
        expect(payload.file).toContain("data:image/svg+xml;base64,");
      }
      const imported = (await adapter.prepareSliceSnapshot(
        { file: payload.file, assets: job.assetsManager },
        doc,
      ))!;
      const blocks = flatten(imported.content);
      const defs = blocks.filter(
        (b) => b.flavour === "myoxus:footnote-definition",
      );
      expect(defs.map((d) => d.props.label)).toEqual(["Research-2", "2-2"]);
      expect(defs[0].id).not.toBe(
        doc.getBlocksByFlavour("myoxus:footnote-definition")[0].model.id,
      );
      expect(defs[0].children.map((b) => b.flavour)).toEqual([
        "myoxus:paragraph",
        "myoxus:paragraph",
        "myoxus:paragraph",
        "myoxus:list",
        "myoxus:paragraph",
        "myoxus:code",
        "myoxus:image",
        "myoxus:table",
      ]);
      expect(text(defs[0].children[1])).toContain("hard break.\nContinued");
      expect(defs[0].children[3].props.order).toBe(3);
      expect(defs[0].children[3].children).toHaveLength(3);
      const refs = blocks.flatMap((b) =>
        ((b.props.text as { delta?: Delta[] })?.delta ?? []).flatMap((d) =>
          d.attributes?.footnote?.definitionId ? [d.attributes.footnote] : [],
        ),
      );
      expect(refs.map((r) => r.definitionId)).toEqual([
        defs[0].id,
        defs[0].id,
        defs[1].id,
      ]);
      const image = defs[0].children[6];
      const blob = job.assetsManager
        .getAssets()
        .get(String(image.props.sourceId))!;
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
        new Uint8Array(bytes),
      );
      adapter.assertPreparedSliceCurrent();
    }
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(doc.workspace.meta.docMetas).toHaveLength(1);
  });

  test("footnote slice preprocessing preserves source continuation ranges and rejects unavailable images", async () => {
    using job = createJob();
    const mix = new MixTextAdapter(job, getProvider());
    const source =
      "Read[^Study].\n\n[^Study]: first\n\n    second\n\n    3. third\n\n    ```text\n    literal[^code]\n    ```";
    const snapshot = (await mix.toSliceSnapshot({
      file: source,
      workspaceId: "source",
      pageId: "parent",
      assets: job.assetsManager,
    }))!;
    const defs = flatten(snapshot.content).filter(
      (b) => b.flavour === "myoxus:footnote-definition",
    );
    expect(defs).toHaveLength(1);
    expect(defs[0].children.map((b) => b.flavour)).toEqual([
      "myoxus:paragraph",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:code",
    ]);
    expect(text(defs[0].children[1])).toBe("second");
    expect(defs[0].children[2].props.order).toBe(3);
    expect(text(defs[0].children[3])).toBe("literal[^code]");
    const create = vi.spyOn(job.docCRUD, "create");
    await expect(
      new MarkdownAdapter(job, getProvider()).toDocSnapshot({
        file: "Read[^Study].\n\n[^Study]: ![missing](assets/unavailable.png)",
        assets: job.assetsManager,
      }),
    ).rejects.toThrow("Footnote image unavailable: Study");
    expect(create).not.toHaveBeenCalled();
  });

  test("native export rejects dangling or ambiguous local IDs and clears per-parent citation state", async () => {
    const job = createJob();
    const adapter = new MarkdownAdapter(job, getProvider());
    try {
      const source = await adapter.toBlockSnapshot({
        file: 'Read[^local] and[^source].\n\n[^local]: body\n\n[^source]: {"type":"url","url":"https%3A%2F%2Fexample.org"}',
      });
      const paragraph = source.children.find((block) => markers(block).length)!;
      const part = (paragraph.props.text as { delta: Delta[] }).delta.find(
        (part) => part.attributes?.footnote?.definitionId,
      )!;
      const original = part.attributes!.footnote!;
      part.attributes!.footnote = {
        ...original,
        definitionId: "absent-local-id",
      };
      await expect(
        adapter.fromBlockSnapshot({ snapshot: source }),
      ).rejects.toThrow("Unresolved footnote definition");
      part.attributes!.footnote = {
        ...original,
        reference: { type: "url", url: "https://example.org" },
      };
      await expect(
        adapter.fromBlockSnapshot({ snapshot: source }),
      ).rejects.toThrow();
      part.attributes!.footnote = original;
      expect(
        (await adapter.fromBlockSnapshot({ snapshot: source })).file,
      ).toContain("[^source]:");
      const definition = definitions(source)[0];
      const duplicate = {
        ...definition,
        id: "other-local-definition",
        children: [],
        props: { ...definition.props },
      };
      source.children.push(duplicate);
      await expect(
        adapter.fromBlockSnapshot({ snapshot: source }),
      ).rejects.toThrow("Conflicting footnote definition");
      source.children.pop();
      const other = await adapter.toBlockSnapshot({
        file: "A different parent.",
      });
      expect((await adapter.fromBlockSnapshot({ snapshot: other })).file).toBe(
        "A different parent.\n",
      );
    } finally {
      job[Symbol.dispose]();
    }
  });
});

function authoringFixture() {
  const job = createJob();
  const store = job.docCRUD.create("footnote-authoring-parent");
  store.load();
  const root = store.addBlock("myoxus:page", { title: new Text("Parent") });
  const note = store.addBlock("myoxus:note", {}, root);
  const paragraph = store.getModelById<ParagraphBlockModel>(
    store.addBlock(
      "myoxus:paragraph",
      { text: new Text("prefix suffix") },
      note,
    ),
  )!;
  const std = new BlockStdScope({ store, extensions: testStoreExtensions });
  // Only the DOM render boundary is substituted; model, selection and history
  // are the registered production owners exercised by the desktop journey.
  vi.spyOn(std, "host", "get").mockReturnValue({
    updateComplete: Promise.resolve(),
  } as unknown as EditorHost);
  const dispose = () => {
    std.unmount();
    store.workspace.dispose();
    vi.restoreAllMocks();
  };
  return { job, store, note, paragraph, std, dispose };
}
test("authoring inserts one local definition and paragraph atomically, reuses it and preserves normal history", async () => {
  const { job, store, note, paragraph, std, dispose } = authoringFixture();
  const create = vi.spyOn(job.docCRUD, "create");
  const remove = vi.spyOn(job.docCRUD, "delete");
  try {
    paragraph.text!.insert(" ", 0, {
      footnote: {
        label: "1",
        reference: { type: "url", url: "https://example.org" },
      },
    });
    store.history.undoManager.clear();
    const baseline = paragraph.text!.toDelta();
    const id = insertLocalFootnote(std, paragraph, 8)!;
    await Promise.resolve();
    const definition = store.getModelById<FootnoteDefinitionBlockModel>(id)!;
    expect(definition.props.label).toBe("2");
    expect(store.getParent(definition)?.id).toBe(note);
    expect(definition.children).toHaveLength(1);
    const bodyId = definition.children[0].id;
    expect(definition.children[0].flavour).toBe("myoxus:paragraph");
    expect(std.selection.find(TextSelection)?.from.blockId).toBe(bodyId);
    expect(paragraph.text!.toString()).toBe(" prefix  suffix");
    store.undo();
    expect(store.getModelById(id)).toBeNull();
    expect(store.getModelById(bodyId)).toBeNull();
    expect(paragraph.text!.toDelta()).toEqual(baseline);
    store.redo();
    expect(store.getModelById(id)?.children.map((child) => child.id)).toEqual([
      bodyId,
    ]);
    const repeated = insertLocalFootnote(
      std,
      paragraph,
      paragraph.text!.length,
      id,
    );
    await Promise.resolve();
    expect(repeated).toBe(id);
    expect(store.getBlocksByFlavour("myoxus:footnote-definition")).toHaveLength(
      1,
    );
    paragraph.text!.delete(paragraph.text!.length - 1, 1);
    expect(store.getModelById(id)?.children.map((child) => child.id)).toEqual([
      bodyId,
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(store.workspace.meta.docMetas.map((meta) => meta.id)).toEqual([
      store.id,
    ]);
  } finally {
    dispose();
  }
});
test("rename updates every same-parent marker including normal table cells, with stable identity and conflict fences", async () => {
  const { store, note, paragraph, std, dispose } = authoringFixture();
  try {
    const id = insertLocalFootnote(std, paragraph, 0)!;
    await Promise.resolve();
    insertLocalFootnote(std, paragraph, paragraph.text!.length, id);
    await Promise.resolve();
    const tableId = store.addBlock(
      "myoxus:table",
      {
        cells: {
          "r:c": {
            text: new Text(" "),
          },
        },
      },
      note,
    );
    const table = store.getModelById<TableBlockModel>(tableId)!;
    table.props.cells["r:c"].text.format(0, 1, {
      footnote: { label: "1", definitionId: id },
    });
    store.captureSync();
    expect(renameLocalFootnote(store, id, "Überblick-α-long-label", "1")).toBe(
      true,
    );
    const renamed = { label: "Überblick-α-long-label", definitionId: id };
    expect(
      paragraph
        .text!.toDelta()
        .filter((delta) => delta.attributes?.footnote)
        .map((delta) => delta.attributes?.footnote),
    ).toEqual([renamed, renamed]);
    expect(
      table.props.cells["r:c"].text.toDelta()[0].attributes?.footnote,
    ).toEqual(renamed);
    expect(
      store.getModelById<FootnoteDefinitionBlockModel>(id)?.props.label,
    ).toBe(renamed.label);
    expect(renameLocalFootnote(store, id, "Research", "1")).toBe(false);
    expect(renameLocalFootnote(store, id, "invalid label", renamed.label)).toBe(
      false,
    );
    store.addBlock("myoxus:footnote-definition", { label: "RESEARCH" }, note);
    expect(renameLocalFootnote(store, id, "research", renamed.label)).toBe(
      false,
    );
    paragraph.text!.insert(" ", 0, {
      footnote: {
        label: "source",
        reference: { type: "url", url: "https://example.org" },
      },
    });
    expect(renameLocalFootnote(store, id, "SOURCE", renamed.label)).toBe(false);
    store.readonly = true;
    expect(renameLocalFootnote(store, id, "Another", renamed.label)).toBe(
      false,
    );
    expect(
      store.getModelById<FootnoteDefinitionBlockModel>(id)?.props.label,
    ).toBe(renamed.label);
  } finally {
    dispose();
  }
});
test("local navigation and menu caret follow parent edits, reject removed markers, and stay available readonly", async () => {
  const { store, paragraph, std, dispose } = authoringFixture();
  try {
    const id = insertLocalFootnote(std, paragraph, 7)!;
    await Promise.resolve();
    const caret = localFootnoteCaret(paragraph, 7);
    paragraph.text!.insert("new ", 0);
    expect(caret()).toBe(11);
    expect(returnFromLocalFootnote(std, id)).toBe(true);
    expect(std.selection.find(TextSelection)?.from).toEqual({
      blockId: paragraph.id,
      index: 11,
      length: 1,
    });
    store.readonly = true;
    expect(
      navigateLocalFootnote(std, id, { model: paragraph, index: 11 }),
    ).toBe(true);
    expect(returnFromLocalFootnote(std, id)).toBe(true);
    store.readonly = false;
    paragraph.text!.delete(11, 1);
    expect(returnFromLocalFootnote(std, id)).toBe(false);
    expect(canReturnLocalFootnote(std, id)).toBe(false);
    expect(store.getModelById(id)).not.toBeNull();
    store.captureSync();
    store.deleteBlock(id);
    store.captureSync();
    expect(navigateLocalFootnote(std, id)).toBe(false);
    store.undo();
    expect(store.getModelById(id)?.id).toBe(id);
  } finally {
    dispose();
  }
});
test("insertion rejects nested bodies, stale targets and readonly destinations before writes", async () => {
  const { store, paragraph, std, dispose } = authoringFixture();
  try {
    const id = insertLocalFootnote(std, paragraph, 0)!;
    await Promise.resolve();
    const body = store.getModelById(id)!.children[0];
    const nested = store.getModelById(
      store.addBlock("myoxus:list", { text: new Text("nested") }, body),
    )!;
    const baseline = paragraph.text!.toDelta();
    expect(insertLocalFootnote(std, body, 0)).toBeNull();
    expect(insertLocalFootnote(std, nested, 0)).toBeNull();
    expect(
      insertLocalFootnote(std, paragraph, 0, "removed-definition"),
    ).toBeNull();
    store.readonly = true;
    expect(insertLocalFootnote(std, paragraph, 0)).toBeNull();
    expect(insertLocalFootnote(std, paragraph, 0, id)).toBeNull();
    expect(paragraph.text!.toDelta()).toEqual(baseline);
    expect(store.getBlocksByFlavour("myoxus:footnote-definition")).toHaveLength(
      1,
    );
  } finally {
    dispose();
  }
});

test("table marker return uses the existing non-block inline range and follows its own Yjs field", async () => {
  const { store, note, paragraph, std, dispose } = authoringFixture();
  try {
    const id = insertLocalFootnote(std, paragraph, 0)!;
    await Promise.resolve();
    const table = store.getModelById<TableBlockModel>(
      store.addBlock(
        "myoxus:table",
        { cells: { "r:c": { text: new Text(" ") } } },
        note,
      ),
    )!;
    const cell = table.props.cells["r:c"].text;
    cell.format(0, 1, { footnote: { label: "1", definitionId: id } });
    const restore = vi.fn(() => true);
    expect(
      navigateLocalFootnote(std, id, {
        model: table,
        index: 0,
        text: cell.yText,
        restore,
      }),
    ).toBe(true);
    cell.insert("prefix ", 0);
    store.readonly = true;
    const before = cell.toDelta();
    expect(returnFromLocalFootnote(std, id)).toBe(true);
    expect(restore).toHaveBeenCalledExactlyOnceWith(7, 1);
    expect(cell.toDelta()).toEqual(before);
    store.readonly = false;
    cell.delete(7, 1);
    expect(returnFromLocalFootnote(std, id)).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
  }
});

test("adjacent repeated markers return to exactly their original embed inside a coalesced delta", async () => {
  const { store, paragraph, std, dispose } = authoringFixture();
  try {
    const id = insertLocalFootnote(std, paragraph, 0)!;
    await Promise.resolve();
    paragraph.text!.insert(" ", 1, {
      footnote: { label: "1", definitionId: id },
    });
    expect(paragraph.text!.toDelta()[0].insert).toBe("  ");
    for (const index of [0, 1]) {
      expect(navigateLocalFootnote(std, id, { model: paragraph, index })).toBe(
        true,
      );
      expect(returnFromLocalFootnote(std, id)).toBe(true);
      expect(std.selection.find(TextSelection)?.from).toEqual({
        blockId: paragraph.id,
        index,
        length: 1,
      });
    }
    navigateLocalFootnote(std, id, { model: paragraph, index: 1 });
    paragraph.text!.insert("prefix ", 0);
    store.readonly = true;
    expect(returnFromLocalFootnote(std, id)).toBe(true);
    expect(std.selection.find(TextSelection)?.from).toEqual({
      blockId: paragraph.id,
      index: 8,
      length: 1,
    });
  } finally {
    dispose();
  }
});

test("deleting an origin cannot retarget return to an adjacent equal marker", async () => {
  const { paragraph, std, dispose } = authoringFixture();
  try {
    const id = insertLocalFootnote(std, paragraph, 0)!;
    await Promise.resolve();
    paragraph.text!.insert(" ", 1, {
      footnote: { label: "1", definitionId: id },
    });
    navigateLocalFootnote(std, id, { model: paragraph, index: 0 });
    paragraph.text!.delete(0, 1);
    expect(paragraph.text!.toDelta()[0].insert).toBe(" ");
    expect(canReturnLocalFootnote(std, id)).toBe(false);
    expect(returnFromLocalFootnote(std, id)).toBe(false);
    navigateLocalFootnote(std, id, { model: paragraph, index: 0 });
    expect(canReturnLocalFootnote(std, id)).toBe(true);
    expect(returnFromLocalFootnote(std, id)).toBe(true);
  } finally {
    dispose();
  }
});

test("shared native placements derive body-order numbers including citations and table markers", async () => {
  const job = createJob();
  try {
    const adapter = new MarkdownAdapter(job, getProvider());
    const snapshot = await adapter.toDocSnapshot({
      file: numberingFixture.source,
    });
    const defs = definitions(snapshot!.blocks);
    for (const definition of defs) {
      const placement =
        numberingFixture.placements[
          definition.props.label as keyof typeof numberingFixture.placements
        ];
      if (placement === null) delete definition.props.placement;
      else definition.props.placement = placement;
    }
    const doc = await job.snapshotToDoc(snapshot!);
    const labels = () =>
      Object.fromEntries(
        [...localFootnotePresentation(doc!)].map(([id, value]) => [
          doc!.getModelById<FootnoteDefinitionBlockModel>(id)!.props.label,
          value,
        ]),
      );
    expect(labels()).toEqual(numberingFixture.expected);
    const before = job.docToSnapshot(doc!)!;
    const note = doc!.root!.children.find((b) => b.flavour === "myoxus:note")!;
    doc!.captureSync();
    doc!.updateBlock(note, {
      children: [
        ...note.children.filter(
          (b) => b.flavour !== "myoxus:footnote-definition",
        ),
        ...note.children
          .filter((b) => b.flavour === "myoxus:footnote-definition")
          .reverse(),
      ],
    });
    doc!.captureSync();
    expect(labels()).toEqual(numberingFixture.expected);
    doc!.undo();
    expect(labels()).toEqual(numberingFixture.expected);
    expect(job.docToSnapshot(doc!)!.blocks).toEqual(before.blocks);
    const citation = note.children.find((block) => {
      const delta = block.text?.toDelta();
      return (
        delta?.length === 1 &&
        (delta[0].attributes?.footnote as { reference?: unknown })
          ?.reference !== undefined
      );
    })!;
    expect(citation).toBeDefined();
    doc!.captureSync();
    doc!.updateBlock(note, {
      children: [
        citation,
        ...note.children.filter((block) => block !== citation),
      ],
    });
    doc!.captureSync();
    expect(labels().Research).toEqual({
      placement: "footnote",
      number: 2,
      order: 2,
    });
    expect(labels().End).toEqual(numberingFixture.expected.End);
    doc!.undo();
    expect(labels()).toEqual(numberingFixture.expected);
    const html = new HtmlAdapter(job, getProvider());
    const exported = await html.fromDocSnapshot({ snapshot: before });
    const reading = new DOMParser().parseFromString(exported.file, "text/html");
    expect(
      [...reading.querySelectorAll("section header")].map(
        (node) => node.textContent,
      ),
    ).toEqual([
      "Endnote 1",
      "Footnote 1",
      "Footnote 4",
      "Footnote 5",
      "Endnote — no reference",
    ]);
    expect(
      [...reading.querySelectorAll('[role="doc-noteref"]')].map((node) =>
        node.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Endnote 1",
      "Footnote 1",
      "Footnote 1",
      "Footnote 4",
      "Footnote 5",
    ]);
    const reimport = await html.toBlockSnapshot({ file: exported.file });
    expect(
      definitions(reimport).map((b) => [b.props.label, b.props.placement]),
    ).toEqual(
      defs.map((b) => [b.props.label, b.props.placement ?? "footnote"]),
    );
    const normalized = await adapter.fromDocSnapshot({ snapshot: before });
    expect(adapter.exportDiagnostics.normalizedEndnotes).toBe(2);
    expect(normalized.file).toContain("[^End]: End body.");
    expect(normalized.file).toContain("[^Unused]: Retained body.");
    const portable = await adapter.toDocSnapshot({ file: normalized.file });
    expect(
      definitions(portable!.blocks).every(
        (node) => node.props.placement === "footnote",
      ),
    ).toBe(true);
    const invalid = structuredClone(before);
    definitions(invalid.blocks)[0].props.placement = "invalid";
    await expect(html.fromDocSnapshot({ snapshot: invalid })).rejects.toThrow(
      "placement",
    );
    const definition = doc!.getModelById<FootnoteDefinitionBlockModel>(
      defs[0].id,
    )!;
    doc!.updateBlock(definition, { placement: "bad" as "footnote" });
    expect(
      localFootnotePresentation(doc!).get(definition.id)?.placement,
    ).toBeUndefined();
    expect(
      localFootnotePresentation(doc!).get(definition.id)?.number,
    ).toBeUndefined();
    doc!.deleteBlock(definition);
    expect(localFootnotePresentation(doc!).has(definition.id)).toBe(false);
    expect(labels().Research).toEqual({
      placement: "footnote",
      number: 1,
      order: 1,
    });
  } finally {
    job[Symbol.dispose]();
  }
});

test("placement presets share insertion, reuse only matching kind and switch once without replacing content", async () => {
  const { store, paragraph, std, dispose } = authoringFixture();
  try {
    const id = insertLocalFootnote(std, paragraph, 0, undefined, "endnote")!;
    await Promise.resolve();
    const definition = store.getModelById<FootnoteDefinitionBlockModel>(id)!;
    const children = definition.children.map((child) => child.id);
    definition.children[0].text!.insert("retained rich body", 0, {
      bold: true,
    });
    const label = definition.props.label;
    const delta = paragraph.text!.toDelta();
    expect(definition.props.placement).toBe("endnote");
    expect(insertLocalFootnote(std, paragraph, 0, id, "footnote")).toBeNull();
    expect(paragraph.text!.toDelta()).toEqual(delta);
    expect(insertLocalFootnote(std, paragraph, 0, id, "endnote")).toBe(id);
    await Promise.resolve();
    expect(localFootnotePresentation(store).get(id)?.number).toBe(1);
    expect(setLocalFootnotePlacement(store, id, "footnote", "endnote")).toBe(
      true,
    );
    expect(definition.props.placement).toBe("footnote");
    expect(definition.props.label).toBe(label);
    expect(definition.children.map((child) => child.id)).toEqual(children);
    store.undo();
    expect(definition.props.placement).toBe("endnote");
    expect(paragraph.text!.toDelta()).toHaveLength(2);
    store.redo();
    expect(definition.props.placement).toBe("footnote");
    expect(definition.children[0].text!.toDelta()).toEqual([
      { insert: "retained rich body", attributes: { bold: true } },
    ]);
    // A remote placement change invalidates the previously opened menu choice.
    store.spaceDoc.transact(
      () => store.updateBlock(definition, { placement: "endnote" }),
      "remote-owner",
    );
    expect(setLocalFootnotePlacement(store, id, "footnote", "footnote")).toBe(
      false,
    );
    expect(definition.props.placement).toBe("endnote");
    store.readonly = true;
    expect(setLocalFootnotePlacement(store, id, "footnote", "endnote")).toBe(
      false,
    );
    expect(
      insertLocalFootnote(std, paragraph, 0, undefined, "endnote"),
    ).toBeNull();
  } finally {
    dispose();
  }
});
