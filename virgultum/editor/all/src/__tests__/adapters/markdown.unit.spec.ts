// @vitest-environment happy-dom

import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";
import { Container } from "@virgultum/global/di";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultTheme,
  NoteDisplayMode,
  type ParagraphBlockModel,
  type TableBlockModel,
  type TableBlockPropsSerialized,
  TableModelFlavour,
  TextAlign,
} from "@virgultum/model";
import {
  ClipboardAdapter,
  HtmlAdapter,
  CalloutAdmonitionType,
  CalloutExportStyle,
  calloutMarkdownExportMiddleware,
  documentReferenceMiddleware,
  markdownNativeTargets,
  prepareMarkdownExportSnapshots,
  DOCUMENT_REFERENCE_TARGETS_PREFIX,
  embedSyncedDocMiddleware,
  MarkdownAdapter,
  MixTextAdapter,
} from "@virgultum/shared/adapters";
import {
  NotificationExtension,
  type NotificationService,
  ThemeProvider,
  ThemeService,
} from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";
import {
  AssetsManager,
  type BlockSnapshot,
  type DocSnapshot,
  MemoryBlobCRUD,
  Schema,
  type SliceSnapshot,
  type TransformerMiddleware,
} from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { describe, expect, test, vi } from "vitest";

import { TableDataManager } from "../../../../blocks/table/src/table-data-manager.js";

import { MyoxusSchemas } from "../../schemas.js";
import { createJob } from "../utils/create-job.js";
import { getProvider } from "../utils/get-provider.js";
import { nanoidReplacement } from "../utils/nanoid-replacement.js";
import { testStoreExtensions } from "../utils/store.js";
import { Zip } from "../../../../widgets/linked-doc/src/transformers/utils.js";

const provider = getProvider();

describe("snapshot to markdown", () => {
  test("client Markdown imports retain forward and local native navigation targets", async () => {
    const collection = new TestWorkspace();
    collection.storeExtensions = testStoreExtensions;
    collection.meta.initialize();
    const schema = new Schema().register(MyoxusSchemas);
    const archive = new Zip();
    await archive.file(
      "Source.md",
      "# Source\n\n[[Target#Target|heading]] [instruction](Target.md#%5Einstruction) [[Target#^release|checklist]] [[#^local|decision]] [[Target#Repeated]] [[Target#Linked decision|linked heading]]\n\nLocal decision. ^local\n\n%%Literal [[Target#^release]]%%",
    );
    await archive.file(
      "Target.md",
      "# Target\n\nRelease instruction. ^instruction\n\n- Check the backup. ^release\n  - Confirm the audit log.\n\n## Repeated\n\nFirst\n\n## Repeated\n\nSecond\n\n## Linked [[Source#^local|decision]]",
    );
    try {
      const result = await MarkdownTransformer.importMarkdownZip({
        collection,
        schema,
        imported: await archive.generate(),
        extensions: testStoreExtensions,
      });
      expect(result.docIds).toHaveLength(2);
      expect(collection.meta.docMetas).toHaveLength(2);
      expect(result.diagnostics).toEqual({
        unresolvedReferences: 1,
        unsupportedReferences: 0,
      });
      const sourceId = collection.meta.docMetas.find(
        ({ title }) => title === "Source",
      )!.id;
      const targetId = collection.meta.docMetas.find(
        ({ title }) => title === "Target",
      )!.id;
      const source = collection.getDoc(sourceId)!.getStore({ id: sourceId });
      const target = collection.getDoc(targetId)!.getStore({ id: targetId });
      const targetSnapshot = target.getTransformer([]).docToSnapshot(target)!;
      const titles = new Map(
        collection.meta.docMetas.map(({ id, title }) => [id, title]),
      );
      const targets = markdownNativeTargets(targetSnapshot.blocks, titles);
      const heading = targets.find(
        ({ headingPath }) => headingPath?.join("#") === "Target",
      )!;
      const instruction = targets.find(
        ({ sourceAnchor }) => sourceAnchor === "instruction",
      )!;
      const checklist = targets.find(
        ({ sourceAnchor }) => sourceAnchor === "release",
      )!;
      const linkedHeading = targets.find(
        ({ headingPath }) => headingPath?.at(-1) === "Linked decision",
      )!;
      expect(target.getBlock(heading.blockId)?.model.flavour).toBe(
        "myoxus:paragraph",
      );
      expect(target.getBlock(checklist.blockId)?.model.flavour).toBe(
        "myoxus:list",
      );
      expect(target.getBlock(checklist.blockId)?.model.children).toHaveLength(
        1,
      );
      const sourceSnapshot = source.getTransformer([]).docToSnapshot(source)!;
      const flatten = (root: BlockSnapshot): BlockSnapshot[] => [
        root,
        ...root.children.flatMap(flatten),
      ];
      const references = flatten(sourceSnapshot.blocks).flatMap((block) => {
        const text = block.props.text as
          | {
              delta?: Array<{
                attributes?: {
                  reference?: {
                    pageId: string;
                    params: { mode: string; blockIds: string[] };
                  };
                };
              }>;
            }
          | undefined;
        return (text?.delta ?? []).flatMap(({ attributes }) =>
          attributes?.reference ? [attributes.reference] : [],
        );
      });
      const local = markdownNativeTargets(sourceSnapshot.blocks, titles).find(
        ({ sourceAnchor }) => sourceAnchor === "local",
      )!;
      expect(references).toEqual([
        {
          type: "LinkedPage",
          pageId: targetId,
          title: "heading",
          params: { mode: "page", blockIds: [heading.blockId] },
        },
        {
          type: "LinkedPage",
          pageId: targetId,
          title: "instruction",
          params: { mode: "page", blockIds: [instruction.blockId] },
        },
        {
          type: "LinkedPage",
          pageId: targetId,
          title: "checklist",
          params: { mode: "page", blockIds: [checklist.blockId] },
        },
        {
          type: "LinkedPage",
          pageId: sourceId,
          title: "decision",
          params: { mode: "page", blockIds: [local.blockId] },
        },
        {
          type: "LinkedPage",
          pageId: targetId,
          title: "linked heading",
          params: { mode: "page", blockIds: [linkedHeading.blockId] },
        },
      ]);
      const solo = await MarkdownTransformer.importMarkdownToDoc({
        collection,
        schema,
        fileName: "Solo",
        markdown: "# Solo\n\n[[#Solo|top]]",
        extensions: testStoreExtensions,
      });
      expect(solo.diagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      const soloStore = collection
        .getDoc(solo.docId!)!
        .getStore({ id: solo.docId! });
      const soloSnapshot = soloStore
        .getTransformer([])
        .docToSnapshot(soloStore)!;
      const note = soloSnapshot.blocks.children.find(
        ({ flavour }) => flavour === "myoxus:note",
      )!;
      expect(note.children[0].props.type).toBe("h1");
      expect(JSON.stringify(note.children[1].props.text)).toContain(
        note.children[0].id,
      );
    } finally {
      collection.dispose();
    }
  });
  test("precise references resolve only current authorized native targets", async () => {
    const job = createJob();
    const targetSnapshot = await new MarkdownAdapter(
      job,
      provider,
    ).toDocSnapshot({
      file: "# Über Größe\n\nRelease instruction. ^instruction\n\n## Résumé\n\nFirst ^repeated\n\n## Résumé\n\nSecond ^repeated\n\n# Literal # heading\n\n`Code ^code`\n\n%%Private annotation ^annotation%%",
    });
    targetSnapshot.meta.id = "target";
    const native = (await job.snapshotToDoc(targetSnapshot))!;
    const targets = markdownNativeTargets(
      targetSnapshot.blocks,
      new Map([["target", "Current metadata"]]),
    );
    const adapter = new MarkdownAdapter(
      createJob([
        documentReferenceMiddleware(
          [{ id: "target", title: "Current metadata" }],
          new Map([
            ["Target.md", "target"],
            ["Private.md", "private"],
          ]),
          "Source.md",
          {
            nativeTargets: new Map([
              ["target", targets],
              ["private", targets],
            ]),
            currentDocumentId: "target",
          },
        ),
      ]),
      provider,
    );
    expect(
      adapter.configs.has(DOCUMENT_REFERENCE_TARGETS_PREFIX + "private"),
    ).toBe(false);
    const source =
      "[[Target#%C3%9Cber%20Gr%C3%B6%C3%9Fe|heading]] [instruction](Target.md#%5Einstruction) [[#^instruction|local]] [[Target#Résumé]] [[Target#^repeated]] [[Target#Literal%20%23%20heading]] [[Target#%255Einstruction]] [[Target#^code]] [[Target#^annotation]] [[Private#^instruction]] [private link](Private.md)";
    const imported = await adapter.toBlockSnapshot({ file: source });
    const flatten = (block: BlockSnapshot): BlockSnapshot[] => [
      block,
      ...block.children.flatMap(flatten),
    ];
    const deltas = flatten(imported).flatMap(
      (block) =>
        (
          block.props.text as
            | {
                delta?: Array<{
                  insert: string;
                  attributes?: {
                    reference?: {
                      pageId: string;
                      title?: string;
                      params?: { mode: string; blockIds: string[] };
                    };
                  };
                }>;
              }
            | undefined
        )?.delta ?? [],
    );
    const references = deltas.flatMap((delta) =>
      delta.attributes?.reference ? [delta.attributes.reference] : [],
    );
    expect(references.map((reference) => reference.title)).toEqual([
      "heading",
      "instruction",
      "local",
    ]);
    const heading = targets.find(
      (target) => target.headingPath?.[0] === "Über Größe",
    )!;
    const instruction = targets.find(
      (target) => target.sourceAnchor === "instruction",
    )!;
    expect(references.map((reference) => reference.params)).toEqual([
      { mode: "page", blockIds: [heading.blockId] },
      { mode: "page", blockIds: [instruction.blockId] },
      { mode: "page", blockIds: [instruction.blockId] },
    ]);
    for (const reference of references)
      expect(native.getBlock(reference.params!.blockIds[0])?.model.id).toBe(
        reference.params!.blockIds[0],
      );
    expect(adapter.importDiagnostics).toEqual({
      unresolvedReferences: 8,
      unsupportedReferences: 0,
    });
    expect(deltas.map((delta) => delta.insert).join("")).toContain(
      "[[Target#^repeated]]",
    );
    expect(deltas.map((delta) => delta.insert).join("")).toContain(
      "[[Target#Literal%20%23%20heading]]",
    );
    const headingModel = native.getBlock(heading.blockId)!
      .model as ParagraphBlockModel;
    headingModel.props.text.replace(
      0,
      headingModel.props.text.length,
      "Renamed review",
    );
    const writer = () =>
      new MarkdownAdapter(
        createJob([
          documentReferenceMiddleware(
            [{ id: "target", title: "Current metadata" }],
            new Map([["Target.md", "target"]]),
            "Source.md",
            {
              nativeTargets: new Map([
                [
                  "target",
                  markdownNativeTargets(
                    job.docToSnapshot(native)!.blocks,
                    new Map([["target", "Current metadata"]]),
                  ),
                ],
              ]),
            },
          ),
        ]),
        provider,
      );
    const renamedWriter = writer();
    const exported = (
      await renamedWriter.fromBlockSnapshot({ snapshot: imported })
    ).file;
    expect(exported).toContain("[heading](Target.md#Renamed\\%20review)");
    expect(exported).toContain("[instruction](Target.md#\\%5Einstruction)");
    expect(renamedWriter.exportDiagnostics).toEqual({
      unresolvedReferences: 0,
      unsupportedReferences: 0,
    });
    const roundtrip = await renamedWriter.toBlockSnapshot({ file: exported });
    const serializedRoundtrip = JSON.stringify(roundtrip);
    for (const reference of references)
      expect(serializedRoundtrip).toContain(reference.params!.blockIds[0]);
    const frozenTarget = job.docToSnapshot(native)!;
    const frozenSource = await adapter.toDocSnapshot({ file: source });
    frozenSource.meta.id = "source";
    const captured = new Map([
      ["target", frozenTarget],
      ["source", frozenSource],
    ]);
    const titles = new Map([
      ["target", "Current metadata"],
      ["source", "Source"],
    ]);
    const prepared = await prepareMarkdownExportSnapshots(captured, titles);
    const generated = prepared.nativeTargets
      .get("target")!
      .find((target) => target.blockId === heading.blockId)!.sourceAnchor;
    expect(generated).toMatch(/^myoxus-[a-f0-9]{64}$/);
    expect(
      markdownNativeTargets(frozenTarget.blocks, titles).find(
        (target) => target.blockId === heading.blockId,
      )?.sourceAnchor,
    ).toBeUndefined();
    expect(
      (await prepareMarkdownExportSnapshots(captured, titles)).snapshots,
    ).toEqual(prepared.snapshots);
    const archiveWriter = new MarkdownAdapter(
      createJob([
        documentReferenceMiddleware(
          [...titles].map(([id, title]) => ({ id, title })),
          new Map([
            ["Target.md", "target"],
            ["Source.md", "source"],
          ]),
          "Source.md",
          {
            nativeTargets: prepared.nativeTargets,
            currentDocumentId: "source",
          },
        ),
      ]),
      provider,
    );
    const archiveSource = (
      await archiveWriter.fromDocSnapshot({
        snapshot: prepared.snapshots.get("source")!,
      })
    ).file;
    const archiveTarget = (
      await archiveWriter.fromDocSnapshot({
        snapshot: prepared.snapshots.get("target")!,
      })
    ).file;
    expect(archiveSource).toContain(
      "[heading](Target.md#\\%5E" + generated + ")",
    );
    expect(archiveSource).toContain("[private link](Private.md)");
    expect(archiveTarget).toContain("# Renamed review ^" + generated);
    expect(archiveTarget).toContain("`Code ^code`");
    expect(archiveTarget).toContain("%%Private annotation ^annotation%%");
    const nextTarget = await new MarkdownAdapter(
      createJob(),
      provider,
    ).toDocSnapshot({ file: archiveTarget });
    nextTarget.meta.id = "next-target";
    const nextNative = (await job.snapshotToDoc(nextTarget))!;
    const nextTargets = markdownNativeTargets(
      nextTarget.blocks,
      new Map([["next-target", "Current metadata"]]),
    );
    const nextAdapter = new MarkdownAdapter(
      createJob([
        documentReferenceMiddleware(
          [{ id: "next-target", title: "Current metadata" }],
          new Map([["Target.md", "next-target"]]),
          "Source.md",
          { nativeTargets: new Map([["next-target", nextTargets]]) },
        ),
      ]),
      provider,
    );
    const nextSource = await nextAdapter.toBlockSnapshot({
      file: archiveSource,
    });
    const nextHeading = nextTargets.find(
      (target) => target.sourceAnchor === generated,
    )!;
    expect(nextHeading.blockId).not.toBe(heading.blockId);
    expect(nextNative.getBlock(nextHeading.blockId)?.model.id).toBe(
      nextHeading.blockId,
    );
    expect(JSON.stringify(nextSource)).toContain(nextHeading.blockId);
    expect(nextAdapter.importDiagnostics).toEqual({
      unresolvedReferences: 1,
      unsupportedReferences: 0,
    });
    native.deleteBlock(native.getBlock(instruction.blockId)!.model);
    const deletedWriter = writer();
    const deleted = (
      await deletedWriter.fromBlockSnapshot({ snapshot: imported })
    ).file;
    expect(deletedWriter.exportDiagnostics).toEqual({
      unresolvedReferences: 2,
      unsupportedReferences: 0,
    });
    expect(deleted).not.toContain("[instruction](Target.md");
    expect(deleted).toContain("instruction");
    native.workspace.dispose();
  });

  test("block anchor provenance survives native import, model edits and both writer passes", async () => {
    const adapter = new MarkdownAdapter(createJob(), provider);
    const source =
      "# Guide ^top\n\nPlain body ^paragraph\n\n- List body ^item\n\n> Quoted body ^quote\n\n> [!note]- Review\n> Callout body ^callout\n\nEscaped \\^literal\n\n`Inline ^code`\n\n%%Hidden ^annotation%%\n\n```text\nFenced ^literal\n```\n\n^standalone\n";
    const imported = await adapter.toBlockSnapshot({ file: source });
    const flatten = (block: BlockSnapshot): BlockSnapshot[] => [
      block,
      ...block.children.flatMap(flatten),
    ];
    const anchored = flatten(imported).filter(
      (block) => block.props.markdownAnchor !== undefined,
    );
    expect(anchored.map((block) => block.props.markdownAnchor)).toEqual([
      "top",
      "paragraph",
      "item",
      "quote",
      "callout",
    ]);
    expect(
      anchored.every((block) => block.id !== block.props.markdownAnchor),
    ).toBe(true);
    const heading = anchored[0];
    heading.props.text = {
      "$virgultum:internal:text$": true,
      delta: [{ insert: "Renamed guide" }],
    };
    const exported = (await adapter.fromBlockSnapshot({ snapshot: imported }))
      .file;
    expect(exported).toContain("# Renamed guide ^top");
    expect(exported).toContain("Plain body ^paragraph");
    expect(exported).toContain("* List body ^item");
    expect(exported).toContain("> Quoted body ^quote");
    expect(exported).toContain("> Callout body ^callout");
    expect(exported).toContain("Escaped \\^literal");
    expect(exported).toContain("%%Hidden ^annotation%%");
    expect(exported).toContain("Fenced ^literal");
    expect(exported).toContain("\\^standalone");
    const reimported = await adapter.toBlockSnapshot({ file: exported });
    expect(
      flatten(reimported)
        .filter((block) => block.props.markdownAnchor !== undefined)
        .map((block) => block.props.markdownAnchor),
    ).toEqual(["top", "paragraph", "item", "quote", "callout"]);
    expect(
      (await adapter.fromBlockSnapshot({ snapshot: reimported })).file,
    ).toBe(exported);
  });

  test("a matching title with an explicit anchor remains an ordinary editable heading", async () => {
    const schema = new Schema().register(MyoxusSchemas);
    const collection = new TestWorkspace();
    collection.storeExtensions = testStoreExtensions;
    collection.meta.initialize();
    const { docId } = await MarkdownTransformer.importMarkdownToDoc({
      collection,
      schema,
      markdown: "# Guide ^top\n\nBody ^body",
      fileName: "Guide",
      extensions: testStoreExtensions,
    });
    expect(docId).toBeTruthy();
    const doc = collection.getDoc(docId!)?.getStore({ id: docId! });
    expect(doc).toBeDefined();
    const job = doc!.getTransformer([]);
    const snapshot = job.docToSnapshot(doc!);
    expect(snapshot).not.toBeNull();
    const note = snapshot!.blocks.children.find(
      (block) => block.flavour === "myoxus:note",
    );
    expect(note?.children[0].props).toMatchObject({
      type: "h1",
      markdownAnchor: "top",
    });
    expect(note?.children[1].props.markdownAnchor).toBe("body");
    const exported = await new MarkdownAdapter(job, provider).fromDocSnapshot({
      snapshot: snapshot!,
      assets: job.assetsManager,
    });
    expect(exported.file).toContain("# Guide ^top");
    collection.dispose();
  });

  test("code", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:8hOLxad5Fv",
              flavour: "myoxus:code",
              props: {
                language: "python",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "import this",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown = "```python\nimport this\n```\n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("imports frontmatter metadata into doc meta", async () => {
    const schema = new Schema().register(MyoxusSchemas);
    const collection = new TestWorkspace();
    collection.storeExtensions = testStoreExtensions;
    collection.meta.initialize();

    const markdown = `---
title: Web developer
created: 2018-04-12T09:51:00
updated: 2018-04-12T10:00:00
tags: [a, b]
favorite: true
---
Hello world
`;

    const { docId } = await MarkdownTransformer.importMarkdownToDoc({
      collection,
      schema,
      markdown,
      fileName: "fallback-title",
      extensions: testStoreExtensions,
    });

    expect(docId).toBeTruthy();
    const meta = collection.meta.getDocMeta(docId!);
    expect(meta?.title).toBe("Web developer");
    expect(meta?.createDate).toBe(Date.parse("2018-04-12T09:51:00"));
    expect(meta?.updatedDate).toBe(Date.parse("2018-04-12T10:00:00"));
    expect(meta?.favorite).toBe(true);
    expect(meta?.tags).toEqual(["a", "b"]);
  });

  test("full-document imports consume only their matching title heading", async () => {
    const schema = new Schema().register(MyoxusSchemas);
    const collection = new TestWorkspace();
    collection.storeExtensions = testStoreExtensions;
    collection.meta.initialize();

    const importAndExport = async (markdown: string, fileName: string) => {
      const { docId } = await MarkdownTransformer.importMarkdownToDoc({
        collection,
        schema,
        markdown,
        fileName,
        extensions: testStoreExtensions,
      });
      expect(docId).toBeTruthy();

      const doc = collection.getDoc(docId!)?.getStore({ id: docId! });
      expect(doc).toBeDefined();
      const job = doc!.getTransformer([]);
      const snapshot = job.docToSnapshot(doc!);
      expect(snapshot).not.toBeNull();
      return (
        await new MarkdownAdapter(job, provider).fromDocSnapshot({
          snapshot: snapshot!,
          assets: job.assetsManager,
        })
      ).file;
    };

    const canonical = `# Roundtrip title

Soft alpha soft beta

Hard alpha\\
hard beta
`;
    const first = await importAndExport(canonical, "Roundtrip title");
    const second = await importAndExport(first, "Roundtrip title");
    const third = await importAndExport(second, "Roundtrip title");

    expect(first).toBe(canonical);
    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(first.match(/^# Roundtrip title$/gm)).toHaveLength(1);

    const distinctHeading = await importAndExport(
      "# Content heading\n\nBody\n",
      "Filename title",
    );
    expect(distinctHeading).toContain(
      "# Filename title\n\n# Content heading\n\nBody",
    );
  });

  test("paragraph", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Bdn8Yvqcny",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                presentation: "eyebrow",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                      attributes: {
                        labelTone: "accent",
                      },
                    },
                  ],
                },
              },
              children: [
                {
                  type: "block",
                  id: "block:72SMa5mdLy",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                  },
                  children: [],
                },
                {
                  type: "block",
                  id: "block:f-Z6nRrGK_",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ccc",
                        },
                      ],
                    },
                  },
                  children: [
                    {
                      type: "block",
                      id: "block:sP3bU52el7",
                      flavour: "myoxus:paragraph",
                      props: {
                        type: "text",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "ddd",
                            },
                          ],
                        },
                      },
                      children: [],
                    },
                    {
                      type: "block",
                      id: "block:X_HMxP4wxC",
                      flavour: "myoxus:paragraph",
                      props: {
                        type: "text",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "eee",
                            },
                          ],
                        },
                      },
                      children: [],
                    },
                    {
                      type: "block",
                      id: "block:iA34Rb-RvV",
                      flavour: "myoxus:paragraph",
                      props: {
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "fff",
                            },
                          ],
                        },
                        type: "text",
                      },
                      children: [],
                    },
                  ],
                },
                {
                  type: "block",
                  id: "block:I0Fmz5Nv02",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ggg",
                        },
                      ],
                    },
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:12lDwMD7ec",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "hhh",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = `aaa

&#x20;   bbb

&#x20;   ccc

&#x20;       ddd

&#x20;       eee

&#x20;       fff

&#x20;   ggg

hhh
`;

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("bulleted list", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:imiLDMKSkx",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [
                {
                  type: "block",
                  id: "block:kYliRIovvL",
                  flavour: "myoxus:list",
                  props: {
                    type: "bulleted",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [
                    {
                      type: "block",
                      id: "block:UyvxA_gqCJ",
                      flavour: "myoxus:list",
                      props: {
                        type: "bulleted",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "ccc",
                            },
                          ],
                        },
                        checked: false,
                        collapsed: false,
                      },
                      children: [],
                    },
                  ],
                },
                {
                  type: "block",
                  id: "block:-guNZRm5u1",
                  flavour: "myoxus:list",
                  props: {
                    type: "bulleted",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ddd",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:B9CaZzQ2CO",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "eee",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = `* aaa
  * bbb
    * ccc
  * ddd
* eee
`;

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("todo list", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:imiLDMKSkx",
              flavour: "myoxus:list",
              props: {
                type: "todo",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [
                {
                  type: "block",
                  id: "block:kYliRIovvL",
                  flavour: "myoxus:list",
                  props: {
                    type: "todo",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                    checked: true,
                    collapsed: false,
                  },
                  children: [
                    {
                      type: "block",
                      id: "block:UyvxA_gqCJ",
                      flavour: "myoxus:list",
                      props: {
                        type: "todo",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "ccc",
                            },
                          ],
                        },
                        checked: false,
                        collapsed: false,
                      },
                      children: [],
                    },
                  ],
                },
                {
                  type: "block",
                  id: "block:-guNZRm5u1",
                  flavour: "myoxus:list",
                  props: {
                    type: "todo",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ddd",
                        },
                      ],
                    },
                    checked: true,
                    collapsed: false,
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:B9CaZzQ2CO",
              flavour: "myoxus:list",
              props: {
                type: "todo",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "eee",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = `\
* [ ] aaa
  * [x] bbb
    * [ ] ccc
  * [x] ddd
* [ ] eee
`;

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("numbered list", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:m5hvdXHXS2",
      flavour: "myoxus:page",
      version: 2,
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Y4J-oO9h9d",
          flavour: "myoxus:surface",
          version: 5,
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:1Ll22zT992",
          flavour: "myoxus:note",
          version: 1,
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: "both",
            edgeless: {
              style: {
                borderRadius: 8,
                borderSize: 4,
                borderStyle: "solid",
                shadowType: "--myoxus-note-shadow-box",
              },
            },
          },
          children: [
            {
              type: "block",
              id: "block:Fd0ZCYB7a4",
              flavour: "myoxus:list",
              version: 1,
              props: {
                type: "numbered",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [
                {
                  type: "block",
                  id: "block:8-GeKDc06x",
                  flavour: "myoxus:list",
                  version: 1,
                  props: {
                    type: "numbered",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [],
                },
                {
                  type: "block",
                  id: "block:f0c-9xKaEL",
                  flavour: "myoxus:list",
                  version: 1,
                  props: {
                    type: "numbered",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ccc",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:Fd0ZCYB7a5",
              flavour: "myoxus:list",
              version: 1,
              props: {
                type: "numbered",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "ddd",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown = `1. aaa
   1. bbb
   2. ccc
2. ddd
`;

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toEqual(markdown);
  });

  test("different list", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:m5hvdXHXS2",
      flavour: "myoxus:page",
      version: 2,
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Y4J-oO9h9d",
          flavour: "myoxus:surface",
          version: 5,
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:1Ll22zT992",
          flavour: "myoxus:note",
          version: 1,
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: "both",
            edgeless: {
              style: {
                borderRadius: 8,
                borderSize: 4,
                borderStyle: "solid",
                shadowType: "--myoxus-note-shadow-box",
              },
            },
          },
          children: [
            {
              type: "block",
              id: "block:Fd0ZCYB7a4",
              flavour: "myoxus:list",
              version: 1,
              props: {
                type: "numbered",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [
                {
                  type: "block",
                  id: "block:8-GeKDc06x",
                  flavour: "myoxus:list",
                  version: 1,
                  props: {
                    type: "numbered",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [],
                },
                {
                  type: "block",
                  id: "block:f0c-9xKaEL",
                  flavour: "myoxus:list",
                  version: 1,
                  props: {
                    type: "bulleted",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ccc",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [],
                },
                {
                  type: "block",
                  id: "block:f0c-9xKaEL",
                  flavour: "myoxus:list",
                  version: 1,
                  props: {
                    type: "numbered",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ddd",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:Fd0ZCYB7a5",
              flavour: "myoxus:list",
              version: 1,
              props: {
                type: "numbered",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "eee",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown = `1. aaa
   1. bbb
   * ccc
   1. ddd
2. eee
`;

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toEqual(markdown);
  });

  test("code inline", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:qhpbuss-KN",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa ",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        code: true,
                      },
                    },
                    {
                      insert: " ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = "aaa `bbb` ccc\n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("inline latex", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:qhpbuss-KN",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "inline ",
                    },
                    {
                      insert: " ",
                      attributes: {
                        latex: "E=mc^2",
                      },
                    },
                    {
                      insert: " latex",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = "inline $E=mc^2$ latex\n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("latex block", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:8hOLxad5Fv",
              flavour: "myoxus:latex",
              props: {
                latex: "E=mc^2",
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown = "$$\nE=mc^2\n$$\n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("link", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Bdn8Yvqcny",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa ",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        link: "https://example.com/",
                      },
                    },
                    {
                      insert: " ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = "aaa [bbb](https://example.com/) ccc\n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("inline link", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Bdn8Yvqcny",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa ",
                    },
                    {
                      insert: "https://example.com/  ",
                      attributes: {
                        link: "https://example.com/  ",
                      },
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = "aaa https://example.com/  \n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("bold", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:zxDyvrg1Mh",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        bold: true,
                      },
                    },
                    {
                      insert: "ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown = "aaa**bbb**ccc\n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("italic", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:zxDyvrg1Mh",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        italic: true,
                      },
                    },
                    {
                      insert: "ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown = "aaa*bbb*ccc\n";

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("image", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:WcYcyv-oZY",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:zqtuv999Ww",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:UTUZojv22c",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Gan31s-dYK",
              flavour: "myoxus:image",
              props: {
                sourceId: "YXXTjRmLlNyiOUnHb8nAIvUP6V7PAXhwW9F5_tc2LGs=",
                caption: "aaa",
                width: 0,
                height: 0,
                index: "a0",
                xywh: "[0,0,0,0]",
                rotate: 0,
              },
              children: [],
            },
            {
              type: "block",
              id: "block:If92CIQiOl",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown =
      '![](assets/YXXTjRmLlNyiOUnHb8nAIvUP6V7PAXhwW9F5_tc2LGs=.blob "aaa")\n\n';

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const blobCRUD = new MemoryBlobCRUD();
    await blobCRUD.set(
      "YXXTjRmLlNyiOUnHb8nAIvUP6V7PAXhwW9F5_tc2LGs=",
      new Blob(),
    );
    const assets = new AssetsManager({ blob: blobCRUD });

    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
      assets,
    });
    expect(target.file).toBe(markdown);
  });

  test("reference", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Bdn8Yvqcny",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
              },
              children: [
                {
                  type: "block",
                  id: "block:72SMa5mdLy",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                  },
                  children: [],
                },
                {
                  type: "block",
                  id: "C0sH2Ee6cz-MysVNLNrBt",
                  flavour: "myoxus:embed-linked-doc",
                  props: {
                    index: "a0",
                    xywh: "[0,0,0,0]",
                    rotate: 0,
                    pageId: "4T5ObMgEIMII-4Bexyta1",
                    style: "horizontal",
                    caption: null,
                    params: {
                      mode: "page",
                      blockIds: ["abc", "123"],
                      elementIds: ["def", "456"],
                      databaseId: "deadbeef",
                      databaseRowId: "123",
                    },
                  },
                  children: [],
                },
                {
                  type: "block",
                  id: "block:f-Z6nRrGK_",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ccc",
                        },
                      ],
                    },
                  },
                  children: [
                    {
                      type: "block",
                      id: "block:sP3bU52el7",
                      flavour: "myoxus:paragraph",
                      props: {
                        type: "text",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "ddd",
                            },
                          ],
                        },
                      },
                      children: [],
                    },
                    {
                      type: "block",
                      id: "block:X_HMxP4wxC",
                      flavour: "myoxus:paragraph",
                      props: {
                        type: "text",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "eee",
                            },
                            {
                              insert: "",
                              attributes: {
                                reference: {
                                  type: "LinkedPage",
                                  pageId: "deadbeef",
                                  params: {
                                    mode: "page",
                                    blockIds: ["abc", "123"],
                                    elementIds: ["def", "456"],
                                    databaseId: "deadbeef",
                                    databaseRowId: "123",
                                  },
                                },
                              },
                            },
                            {
                              insert: " ",
                              attributes: {
                                reference: {
                                  type: "LinkedPage",
                                  pageId: "foobar",
                                },
                              },
                            },
                          ],
                        },
                      },
                      children: [],
                    },
                    {
                      type: "block",
                      id: "block:iA34Rb-RvV",
                      flavour: "myoxus:paragraph",
                      props: {
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "fff",
                            },
                          ],
                        },
                        type: "text",
                      },
                      children: [],
                    },
                  ],
                },
                {
                  type: "block",
                  id: "block:I0Fmz5Nv02",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ggg",
                        },
                      ],
                    },
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:12lDwMD7ec",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "hhh",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const markdown = `aaa

&#x20;   bbb

[untitled](https://example.com/4T5ObMgEIMII-4Bexyta1?mode=page\\&blockIds=abc%2C123\\&elementIds=def%2C456\\&databaseId=deadbeef\\&databaseRowId=123)

&#x20;   ccc

&#x20;       ddd

&#x20;       eee[test](https://example.com/deadbeef?mode=page\\&blockIds=abc%2C123\\&elementIds=def%2C456\\&databaseId=deadbeef\\&databaseRowId=123)[](https://example.com/foobar)

&#x20;       fff

&#x20;   ggg

hhh
`;
    const middleware: TransformerMiddleware = ({ adapterConfigs }) => {
      adapterConfigs.set("title:deadbeef", "test");
      adapterConfigs.set("docLinkBaseUrl", "https://example.com");
    };
    const mdAdapter = new MarkdownAdapter(createJob([middleware]), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  test("synced-doc", async () => {
    // doc -> synced doc block -> deepest synced doc block
    // The deepest synced doc block only export it's title

    const deepestSyncedDocSnapshot: DocSnapshot = {
      type: "page",
      meta: {
        id: "deepestSyncedDoc",
        title: "Deepest Doc",
        createDate: 1715762171116,
        tags: [],
      },
      blocks: {
        type: "block",
        id: "8WdJmN5FTT",
        flavour: "myoxus:page",
        version: 2,
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "Deepest Doc",
              },
            ],
          },
        },
        children: [
          {
            type: "block",
            id: "zVN1EZFuZe",
            flavour: "myoxus:surface",
            version: 5,
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "2s9sJlphLH",
            flavour: "myoxus:note",
            version: 1,
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: "both",
              edgeless: {
                style: {
                  borderRadius: 8,
                  borderSize: 4,
                  borderStyle: "solid",
                  shadowType: "--myoxus-note-shadow-box",
                },
              },
            },
            children: [
              {
                type: "block",
                id: "vNp5XrR5yw",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "JTdfSl1ygZ",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "Hello, This is deepest doc.",
                      },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      },
    };

    const syncedDocSnapshot: DocSnapshot = {
      type: "page",
      meta: {
        id: "syncedDoc",
        title: "Synced Doc",
        createDate: 1719212435051,
        tags: [],
      },
      blocks: {
        type: "block",
        id: "AGOahFisBN",
        flavour: "myoxus:page",
        version: 2,
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "Synced Doc",
              },
            ],
          },
        },
        children: [
          {
            type: "block",
            id: "gfVzx5tGpB",
            flavour: "myoxus:surface",
            version: 5,
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "CzEfaUret4",
            flavour: "myoxus:note",
            version: 1,
            props: {
              xywh: "[0,0,800,95]",
              background: "--myoxus-note-background-blue",
              index: "a0",
              hidden: false,
              displayMode: "both",
              edgeless: {
                style: {
                  borderRadius: 0,
                  borderSize: 4,
                  borderStyle: "none",
                  shadowType: "--myoxus-note-shadow-sticker",
                },
              },
            },
            children: [
              {
                type: "block",
                id: "yFlNufsgke",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "h1",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "Heading 1",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "oMuLcD6XS3",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "h2",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "heading 2",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "PQ8FhGV6VM",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "paragraph",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "sA9paSrdEN",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "strike",
                        attributes: {
                          strike: true,
                        },
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "DF26giFpKX",
                flavour: "myoxus:code",
                version: 1,
                props: {
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "Hello world!",
                      },
                    ],
                  },
                  language: "cpp",
                  wrap: false,
                  caption: "",
                },
                children: [],
              },
              {
                type: "block",
                id: "-3bbVQTvI2",
                flavour: "myoxus:embed-synced-doc",
                version: 1,
                props: {
                  index: "a0",
                  xywh: "[0,0,0,0]",
                  rotate: 0,
                  pageId: "deepestSyncedDoc",
                  style: "syncedDoc",
                },
                children: [],
              },
            ],
          },
        ],
      },
    };

    const syncedDocMd =
      "# Synced Doc\n\n# Heading 1\n\n## heading 2\n\nparagraph\n\n~~strike~~\n\n```cpp\nHello world!\n```";

    const docSnapShot: DocSnapshot = {
      type: "page",
      meta: {
        id: "y5nsrywQtr",
        title: "Test Doc",
        createDate: 1719222172042,
        tags: [],
      },
      blocks: {
        type: "block",
        id: "VChAZIX7DM",
        flavour: "myoxus:page",
        version: 2,
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "Test Doc",
              },
            ],
          },
        },
        children: [
          {
            type: "block",
            id: "uRj8gejH4d",
            flavour: "myoxus:surface",
            version: 5,
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "AqFoVDUoW9",
            flavour: "myoxus:note",
            version: 1,
            props: {
              xywh: "[0,0,800,95]",
              background: "--myoxus-note-background-blue",
              index: "a0",
              hidden: false,
              displayMode: "both",
              edgeless: {
                style: {
                  borderRadius: 0,
                  borderSize: 4,
                  borderStyle: "none",
                  shadowType: "--myoxus-note-shadow-sticker",
                },
              },
            },
            children: [
              {
                type: "block",
                id: "cWBI4UGTqh",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "Hello",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "AqFoVxas19",
                flavour: "myoxus:embed-synced-doc",
                version: 1,
                props: {
                  index: "a0",
                  xywh: "[0,0,0,0]",
                  rotate: 0,
                  pageId: "syncedDoc",
                  style: "syncedDoc",
                },
                children: [],
              },
              {
                type: "block",
                id: "Db976U9v18",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "World!",
                      },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      },
    };

    const docMd = `\
# Test Doc

Hello

${syncedDocMd}

Deepest Doc

World!
`;

    const job = createJob([embedSyncedDocMiddleware("content")]);

    // workaround for adding docs to collection
    await job.snapshotToDoc(deepestSyncedDocSnapshot);
    await job.snapshotToDoc(syncedDocSnapshot);
    await job.snapshotToDoc(docSnapShot);

    const mdAdapter = new MarkdownAdapter(job, provider);
    const target = await mdAdapter.fromDocSnapshot({
      snapshot: docSnapShot,
    });
    expect(target.file).toBe(docMd);
  });

  test("footnote", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:zxDyvrg1Mh",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                    {
                      insert: " ",
                      attributes: {
                        footnote: {
                          label: "1",
                          reference: {
                            type: "url",
                            url: "https://www.example.com",
                            favicon: "https://www.example.com/favicon.ico",
                            title: "Example Domain",
                            description: "Example Domain",
                          },
                        },
                      },
                    },
                    {
                      insert: " ",
                      attributes: {
                        footnote: {
                          label: "2",
                          reference: {
                            type: "doc",
                            docId: "deadbeef",
                          },
                        },
                      },
                    },
                    {
                      insert: " ",
                      attributes: {
                        footnote: {
                          label: "3",
                          reference: {
                            type: "attachment",
                            blobId: "abcdefg",
                            fileName: "test.txt",
                            fileType: "text/plain",
                          },
                        },
                      },
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const markdown =
      'aaa[^1][^2][^3]\n\n[^1]: {"type":"url","url":"https%3A%2F%2Fwww.example.com","favicon":"https%3A%2F%2Fwww.example.com%2Ffavicon.ico","title":"Example Domain","description":"Example Domain"}\n\n[^2]: {"type":"doc","docId":"deadbeef"}\n\n[^3]: {"type":"attachment","blobId":"abcdefg","fileName":"test.txt","fileType":"text/plain"}\n';

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const target = await mdAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(markdown);
  });

  describe("callout", () => {
    test("without export middleware", async () => {
      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "block:vu6SK6WJpW",
        flavour: "myoxus:page",
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [],
          },
        },
        children: [
          {
            type: "block",
            id: "block:Tk4gSPocAt",
            flavour: "myoxus:surface",
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "block:WfnS5ZDCJT",
            flavour: "myoxus:note",
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: NoteDisplayMode.DocAndEdgeless,
            },
            children: [
              {
                type: "block",
                id: "block:8hOLxad5Fv",
                flavour: "myoxus:callout",
                props: {
                  emoji: "💡",
                  appearance: "outline",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [{ insert: "Callout own text" }],
                  },
                },
                children: [
                  {
                    type: "block",
                    id: "block:8hOLxad5Fv",
                    flavour: "myoxus:paragraph",
                    props: {
                      type: "text",
                      text: {
                        "$virgultum:internal:text$": true,
                        delta: [{ insert: "First callout" }],
                      },
                    },
                    children: [],
                  },
                ],
              },
              {
                type: "block",
                id: "block:8hOLxadvdv",
                flavour: "myoxus:callout",
                props: {
                  emoji: "",
                },
                children: [
                  {
                    type: "block",
                    id: "block:8hOLxad5Fv",
                    flavour: "myoxus:paragraph",
                    props: {
                      type: "text",
                      text: {
                        "$virgultum:internal:text$": true,
                        delta: [
                          { insert: "Warning second callout without emoji" },
                        ],
                      },
                    },
                    children: [],
                  },
                  {
                    type: "block",
                    id: "block:8hOLxad5Fv",
                    flavour: "myoxus:paragraph",
                    props: {
                      type: "text",
                      text: {
                        "$virgultum:internal:text$": true,
                        delta: [{ insert: "Text in second callout" }],
                      },
                    },
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };

      const markdown = `> \\[!💡]
>
> Callout own text
>
> First callout

> \\[!]
>
> Warning second callout without emoji
>
> Text in second callout
`;

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const target = await mdAdapter.fromBlockSnapshot({
        snapshot: blockSnapshot,
      });
      expect(target.file).toBe(markdown);
    });

    test("with export middleware", async () => {
      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "block:vu6SK6WJpW",
        flavour: "myoxus:page",
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [],
          },
        },
        children: [
          {
            type: "block",
            id: "block:Tk4gSPocAt",
            flavour: "myoxus:surface",
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "block:WfnS5ZDCJT",
            flavour: "myoxus:note",
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: NoteDisplayMode.DocAndEdgeless,
            },
            children: [
              {
                type: "block",
                id: "block:8hOLxad5Fv",
                flavour: "myoxus:callout",
                props: {
                  emoji: "💡",
                },
                children: [
                  {
                    type: "block",
                    id: "block:8hOLxad5Fv",
                    flavour: "myoxus:paragraph",
                    props: {
                      type: "text",
                      text: {
                        "$virgultum:internal:text$": true,
                        delta: [
                          { insert: "Callout that does not have a title" },
                        ],
                      },
                    },
                    children: [],
                  },
                ],
              },
              {
                type: "block",
                id: "block:8hOLxadvdv",
                flavour: "myoxus:callout",
                props: {
                  emoji: "",
                },
                children: [
                  {
                    type: "block",
                    id: "block:8hOLxad5Fv",
                    flavour: "myoxus:paragraph",
                    props: {
                      type: "text",
                      text: {
                        "$virgultum:internal:text$": true,
                        delta: [
                          {
                            insert:
                              "Warning callout with custom title and multiple paragraphs",
                          },
                        ],
                      },
                    },
                    children: [],
                  },
                  {
                    type: "block",
                    id: "block:8hOLxad5Fv",
                    flavour: "myoxus:paragraph",
                    props: {
                      type: "text",
                      text: {
                        "$virgultum:internal:text$": true,
                        delta: [{ insert: "Text in second callout" }],
                      },
                    },
                    children: [],
                  },
                ],
              },
              {
                type: "block",
                id: "block:8hOLxad5Fv",
                flavour: "myoxus:callout",
                props: {
                  emoji: "💡",
                },
                children: [
                  {
                    type: "block",
                    id: "block:8hOLxad5Fv",
                    flavour: "myoxus:paragraph",
                    props: {
                      type: "text",
                      text: {
                        "$virgultum:internal:text$": true,
                        delta: [
                          { insert: "details" },
                          { insert: " " },
                          { insert: "\nText in details callout with new line" },
                        ],
                      },
                    },
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };

      const markdown = `::: info

Callout that does not have a title

:::

::: warning callout with custom title and multiple paragraphs

Text in second callout

:::

::: details

Text in details callout with new line

:::
`;

      const mdAdapter = new MarkdownAdapter(
        createJob([
          calloutMarkdownExportMiddleware({
            style: CalloutExportStyle.Admonitions,
            admonitionType: CalloutAdmonitionType.Info,
          }),
        ]),
        provider,
      );
      const target = await mdAdapter.fromBlockSnapshot({
        snapshot: blockSnapshot,
      });
      expect(target.file).toBe(markdown);
    });
  });
});

describe("markdown to snapshot", () => {
  test("preserves quote containers and their children through roundtrip", async () => {
    const markdown = `> First **bold** line\\
> second [link](https://example.com)
>
> Continuation paragraph.
>
> > Nested quote.
>
> 7. Seventh
>    - [ ] Pending task
>
> \`\`\`ts
> const value = 1;
> \`\`\`
>
> | Column | Detail |
> | :--- | ---: |
> | one<br>two | value |
`;
    const mdAdapter = new MarkdownAdapter(createJob(), provider);

    const projectSemantics = (block: BlockSnapshot): unknown => {
      const text = block.props.text as
        | { delta?: Array<{ insert?: unknown; attributes?: unknown }> }
        | undefined;
      const semantic: Record<string, unknown> = {
        flavour: block.flavour,
        type: block.props.type,
        text: text?.delta,
        children: block.children.map(projectSemantics),
      };
      for (const key of ["order", "checked", "language"] as const) {
        if (block.props[key] !== undefined) semantic[key] = block.props[key];
      }
      if (block.flavour === TableModelFlavour) {
        const columns = Object.values(
          block.props.columns as Record<
            string,
            { columnId: string; order: string; textAlign?: string }
          >,
        ).sort((left, right) => left.order.localeCompare(right.order));
        const rows = Object.values(
          block.props.rows as Record<string, { rowId: string; order: string }>,
        ).sort((left, right) => left.order.localeCompare(right.order));
        const cells = block.props.cells as Record<
          string,
          { text: { delta: Array<{ insert?: unknown; attributes?: unknown }> } }
        >;
        semantic.table = {
          align: columns.map((column) => column.textAlign),
          cells: rows.map((row) =>
            columns.map(
              (column) => cells[`${row.rowId}:${column.columnId}`]?.text.delta,
            ),
          ),
        };
      }
      return semantic;
    };

    const imported = await mdAdapter.toBlockSnapshot({ file: markdown });
    const quote = imported.children[0];
    expect(quote).toMatchObject({
      flavour: "myoxus:paragraph",
      props: { type: "quote" },
    });
    expect(
      (quote!.props.text as { delta: Array<{ insert: string }> }).delta
        .map((part) => part.insert)
        .join(""),
    ).toBe("First bold line\nsecond link");
    expect(
      (quote!.props.text as { delta: Array<{ attributes?: unknown }> }).delta,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: { bold: true } }),
        expect.objectContaining({
          attributes: { link: "https://example.com" },
        }),
      ]),
    );
    expect(quote?.children.map((child) => child.flavour)).toEqual([
      "myoxus:paragraph",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:code",
      TableModelFlavour,
    ]);
    expect(quote?.children[1]).toMatchObject({
      flavour: "myoxus:paragraph",
      props: { type: "quote" },
    });
    expect(quote?.children[2]).toMatchObject({
      flavour: "myoxus:list",
      props: { type: "numbered", order: 7 },
      children: [
        {
          flavour: "myoxus:list",
          props: { type: "todo", checked: false },
        },
      ],
    });

    const exported = await mdAdapter.fromBlockSnapshot({ snapshot: imported });
    expect(exported.file).toContain("> 7. Seventh");
    expect(exported.file).toContain(">    * [ ] Pending task");
    const reimported = await mdAdapter.toBlockSnapshot({ file: exported.file });
    expect(projectSemantics(reimported)).toEqual(projectSemantics(imported));

    const mixTextAdapter = new MixTextAdapter(createJob(), provider);
    const pasted = await mixTextAdapter.toSliceSnapshot({
      file: markdown,
      workspaceId: "workspace",
      pageId: "page",
    });
    expect(pasted?.content).toHaveLength(1);
    expect(projectSemantics(pasted!.content[0]!)).toEqual(
      projectSemantics(imported),
    );
  });

  test("line-break semantics stabilize across repeated and cross-writer roundtrips", async () => {
    const fixture = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../../../build/fixtures/markdown/roundtrip-line-breaks.md",
      ),
      "utf8",
    );
    const adapter = new MarkdownAdapter(createJob(), provider);
    const blockText = (block: BlockSnapshot | undefined) =>
      (
        block?.props.text as
          | { delta?: Array<{ insert?: string; attributes?: unknown }> }
          | undefined
      )?.delta
        ?.map((part) => part.insert ?? "")
        .join("");
    const semantics = (snapshot: BlockSnapshot) => {
      const [soft, backslash, spaces, quote, list, table, code] =
        snapshot.children;
      const columns = Object.values(
        (table?.props.columns ?? {}) as Record<
          string,
          { columnId: string; order: string }
        >,
      ).sort((left, right) => left.order.localeCompare(right.order));
      const rows = Object.values(
        (table?.props.rows ?? {}) as Record<
          string,
          { rowId: string; order: string }
        >,
      ).sort((left, right) => left.order.localeCompare(right.order));
      const cells = (table?.props.cells ?? {}) as Record<
        string,
        { text: { delta: Array<{ insert?: string }> } }
      >;
      return {
        soft: blockText(soft),
        backslash: blockText(backslash),
        spaces: blockText(spaces),
        quote: blockText(quote),
        list: blockText(list),
        nestedList: blockText(list?.children[0]),
        table: rows.map((row) =>
          columns.map((column) =>
            cells[`${row.rowId}:${column.columnId}`]?.text.delta
              .map((part) => part.insert ?? "")
              .join(""),
          ),
        ),
        code: blockText(code),
      };
    };
    const expected = {
      soft: "Soft alpha soft beta & literal",
      backslash: "Backslash bold\nafter link",
      spaces: "Two-space italic\nafter",
      quote: "Quote soft wrap\nhard",
      list: "Ordered soft wrap\nhard",
      nestedList: "nested soft wrap\nhard",
      table: [["Value"], ["alpha\nbeta"]],
      code: "code line  \ncode backslash\\\nblank\n",
    };

    for (const [source, lineEnding] of [
      [fixture, "\n"],
      [fixture.replaceAll("\n", "\r\n"), "\r\n"],
      [fixture.replaceAll("\n", "\r"), "\r"],
    ] as const) {
      expect(
        semantics(await adapter.toBlockSnapshot({ file: source })),
      ).toEqual({
        ...expected,
        code: ["code line  ", "code backslash\\", "blank", ""].join(lineEnding),
      });
    }

    let snapshot = await adapter.toBlockSnapshot({ file: fixture });
    let canonical: string | undefined;
    for (let pass = 0; pass < 3; pass++) {
      const exported = await adapter.fromBlockSnapshot({ snapshot });
      expect(exported.file).toContain("Backslash **bold**\\\n**after**");
      expect(exported.file).toContain("Two-space *italic*\\\n*after*");
      if (canonical !== undefined) expect(exported.file).toBe(canonical);
      canonical = exported.file;
      snapshot = await adapter.toBlockSnapshot({ file: exported.file });
      expect(semantics(snapshot)).toEqual(expected);
    }

    const native: BlockSnapshot = {
      type: "block",
      id: "native-note",
      flavour: "myoxus:note",
      props: {},
      children: [
        {
          type: "block",
          id: "native-paragraph",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "native\nbreak" }],
            },
          },
          children: [],
        },
      ],
    };
    const nativeExport = await adapter.fromBlockSnapshot({ snapshot: native });
    expect(nativeExport.file).toBe("native\\\nbreak\n");
    expect(
      semantics(await adapter.toBlockSnapshot({ file: nativeExport.file }))
        .soft,
    ).toBe("native\nbreak");

    // This is the server writer's canonical spelling for the shared semantic
    // subset. The client may retain its own unrelated list/fence style.
    const serverHandoff =
      "Soft alpha soft beta & literal\n\nBackslash **bold**\\\n**after** [link](https://example.test/a_%28b%29)";
    const received = await adapter.toBlockSnapshot({ file: serverHandoff });
    const first = await adapter.fromBlockSnapshot({ snapshot: received });
    const second = await adapter.fromBlockSnapshot({
      snapshot: await adapter.toBlockSnapshot({ file: first.file }),
    });
    expect(first.file).toBe(second.file);
    expect(semantics(received)).toMatchObject({
      soft: expected.soft,
      backslash: expected.backslash,
    });
  });

  describe("code", () => {
    test("markdown code block", async () => {
      const markdown = "```python\nimport this\n```\n";

      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:code",
            props: {
              language: "python",
              wrap: false,
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert: "import this",
                  },
                ],
              },
            },
            children: [],
          },
        ],
      };

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });

    test("code with indentation 1 - slice", async () => {
      const markdown = "```python\n    import this\n```";

      const sliceSnapshot: SliceSnapshot = {
        type: "slice",
        content: [
          {
            type: "block",
            id: "matchesReplaceMap[0]",
            flavour: "myoxus:note",
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: "both",
            },
            children: [
              {
                type: "block",
                id: "matchesReplaceMap[1]",
                flavour: "myoxus:code",
                props: {
                  language: "python",
                  wrap: false,
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "    import this",
                      },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
        workspaceId: "",
        pageId: "",
      };

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawSliceSnapshot = await mdAdapter.toSliceSnapshot({
        file: markdown,
        workspaceId: "",
        pageId: "",
      });
      expect(nanoidReplacement(rawSliceSnapshot!)).toEqual(sliceSnapshot);
    });

    test("code with indentation 2 - slice", async () => {
      const markdown = "````python\n```python\n    import this\n```\n````";

      const sliceSnapshot: SliceSnapshot = {
        type: "slice",
        content: [
          {
            type: "block",
            id: "matchesReplaceMap[0]",
            flavour: "myoxus:note",
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: "both",
            },
            children: [
              {
                type: "block",
                id: "matchesReplaceMap[1]",
                flavour: "myoxus:code",
                props: {
                  language: "python",
                  wrap: false,
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "```python\n    import this\n```",
                      },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
        workspaceId: "",
        pageId: "",
      };

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawSliceSnapshot = await mdAdapter.toSliceSnapshot({
        file: markdown,
        workspaceId: "",
        pageId: "",
      });
      expect(nanoidReplacement(rawSliceSnapshot!)).toEqual(sliceSnapshot);
    });

    test("code with indentation 3 - slice", async () => {
      const markdown = "~~~~python\n````python\n    import this\n````\n~~~~";

      const sliceSnapshot: SliceSnapshot = {
        type: "slice",
        content: [
          {
            type: "block",
            id: "matchesReplaceMap[0]",
            flavour: "myoxus:note",
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: "both",
            },
            children: [
              {
                type: "block",
                id: "matchesReplaceMap[1]",
                flavour: "myoxus:code",
                props: {
                  language: "python",
                  wrap: false,
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "````python\n    import this\n````",
                      },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
        workspaceId: "",
        pageId: "",
      };

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawSliceSnapshot = await mdAdapter.toSliceSnapshot({
        file: markdown,
        workspaceId: "",
        pageId: "",
      });
      expect(nanoidReplacement(rawSliceSnapshot!)).toEqual(sliceSnapshot);
    });

    test("html block import as code block", async () => {
      const markdown = `<div class="container">
  <header>
    <h1>Welcome to My Page</h1>
    <nav>
      <ul>
        <li><a href="#home">Home</a></li>
        <li><a href="#about">About</a></li>
      </ul>
    </nav>
  </header>
  <main>
    <p>This is a sample HTML content</p>
  </main>
</div>`;

      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:code",
            props: {
              language: "html",
              wrap: false,
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert:
                      '<div class="container">\n  <header>\n    <h1>Welcome to My Page</h1>\n    <nav>\n      <ul>\n        <li><a href="#home">Home</a></li>\n        <li><a href="#about">About</a></li>\n      </ul>\n    </nav>\n  </header>\n  <main>\n    <p>This is a sample HTML content</p>\n  </main>\n</div>',
                  },
                ],
              },
            },
            children: [],
          },
        ],
      };

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });
  });

  test("html inline color span imports to nearest supported text color", async () => {
    const markdown = `<span style="color: #00afde;">Hello</span>`;
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "Hello",
                  attributes: {
                    color: "var(--myoxus-text-highlight-foreground-blue)",
                  },
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("paragraph", async () => {
    const markdown = `aaa

&#x20;   bbb

&#x20;   ccc

&#x20;       ddd

&#x20;       eee

&#x20;       fff

&#x20;   ggg

hhh
`;

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "    bbb",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "    ccc",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[4]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "        ddd",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[5]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "        eee",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[6]",
          flavour: "myoxus:paragraph",
          props: {
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "        fff",
                },
              ],
            },
            type: "text",
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[7]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "    ggg",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[8]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "hhh",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("bulleted list", async () => {
    const markdown = `* aaa

  * bbb

    * ccc

  - ddd

- eee
`;

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:list",
          props: {
            type: "bulleted",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: null,
          },
          children: [
            {
              type: "block",
              id: "matchesReplaceMap[2]",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "bbb",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
                order: null,
              },
              children: [
                {
                  type: "block",
                  id: "matchesReplaceMap[3]",
                  flavour: "myoxus:list",
                  props: {
                    type: "bulleted",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ccc",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                    order: null,
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "matchesReplaceMap[4]",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "ddd",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
                order: null,
              },
              children: [],
            },
          ],
        },
        {
          type: "block",
          id: "matchesReplaceMap[5]",
          flavour: "myoxus:list",
          props: {
            type: "bulleted",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "eee",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: null,
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("todo list", async () => {
    const markdown = `- [ ] aaa

  - [x] bbb

    - [ ] ccc

  - [x] ddd

- [ ] eee
`;

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:list",
          props: {
            type: "todo",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: null,
          },
          children: [
            {
              type: "block",
              id: "matchesReplaceMap[2]",
              flavour: "myoxus:list",
              props: {
                type: "todo",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "bbb",
                    },
                  ],
                },
                checked: true,
                collapsed: false,
                order: null,
              },
              children: [
                {
                  type: "block",
                  id: "matchesReplaceMap[3]",
                  flavour: "myoxus:list",
                  props: {
                    type: "todo",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ccc",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                    order: null,
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "matchesReplaceMap[4]",
              flavour: "myoxus:list",
              props: {
                type: "todo",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "ddd",
                    },
                  ],
                },
                checked: true,
                collapsed: false,
                order: null,
              },
              children: [],
            },
          ],
        },
        {
          type: "block",
          id: "matchesReplaceMap[5]",
          flavour: "myoxus:list",
          props: {
            type: "todo",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "eee",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: null,
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("non consecutive numbered list", async () => {
    const markdown = `
1. aaa

bbb

3. ccc
4. ddd
`;

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:list",
          props: {
            type: "numbered",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: 1,
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "bbb",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:list",
          props: {
            type: "numbered",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "ccc",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: 3,
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[4]",
          flavour: "myoxus:list",
          props: {
            type: "numbered",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "ddd",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: 4,
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("code inline", async () => {
    const markdown = "aaa `bbb` ccc\n";
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa ",
                },
                {
                  insert: "bbb",
                  attributes: {
                    code: true,
                  },
                },
                {
                  insert: " ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("code inline - slice", async () => {
    const markdown = "``` ```\n    aaa";

    const sliceSnapshot: SliceSnapshot = {
      type: "slice",
      content: [
        {
          type: "block",
          id: "matchesReplaceMap[0]",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: "both",
          },
          children: [
            {
              type: "block",
              id: "matchesReplaceMap[1]",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: " ",
                      attributes: {
                        code: true,
                      },
                    },
                    {
                      insert: "\n    aaa",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
      workspaceId: "",
      pageId: "",
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawSliceSnapshot = await mdAdapter.toSliceSnapshot({
      file: markdown,
      workspaceId: "",
      pageId: "",
    });
    expect(nanoidReplacement(rawSliceSnapshot!)).toEqual(sliceSnapshot);
  });

  test("link", async () => {
    const markdown = "aaa [bbb](https://example.com/) ccc\n";
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa ",
                },
                {
                  insert: "bbb",
                  attributes: {
                    link: "https://example.com/",
                  },
                },
                {
                  insert: " ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("inline link", async () => {
    const markdown = "aaa https://example.com/ ccc\n";
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa ",
                },
                {
                  insert: "https://example.com/",
                  attributes: {
                    link: "https://example.com/",
                  },
                },
                {
                  insert: " ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("bold", async () => {
    const markdown = "aaa**bbb**ccc\n";

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
                {
                  insert: "bbb",
                  attributes: {
                    bold: true,
                  },
                },
                {
                  insert: "ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("italic", async () => {
    const markdown = "aaa*bbb*ccc\n";

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
                {
                  insert: "bbb",
                  attributes: {
                    italic: true,
                  },
                },
                {
                  insert: "ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("table", async () => {
    const markdown = `| aaa | bbb | ccc |
| --- | --- | --- |
| ddd | eee | fff |
`;

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: "both",
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: TableModelFlavour,
          props: {
            headerRows: 1,
            columns: {
              "matchesReplaceMap[3]": {
                columnId: "matchesReplaceMap[3]",
                order: "matchesReplaceMap[4]",
              },
              "matchesReplaceMap[6]": {
                columnId: "matchesReplaceMap[6]",
                order: "matchesReplaceMap[7]",
              },
              "matchesReplaceMap[9]": {
                columnId: "matchesReplaceMap[9]",
                order: "matchesReplaceMap[10]",
              },
            },
            rows: {
              "matchesReplaceMap[12]": {
                rowId: "matchesReplaceMap[12]",
                order: "matchesReplaceMap[13]",
              },
              "matchesReplaceMap[15]": {
                rowId: "matchesReplaceMap[15]",
                order: "matchesReplaceMap[16]",
              },
            },
            cells: {
              "matchesReplaceMap[17]": {
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
              },
              "matchesReplaceMap[18]": {
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "bbb",
                    },
                  ],
                },
              },
              "matchesReplaceMap[19]": {
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "ccc",
                    },
                  ],
                },
              },
              "matchesReplaceMap[20]": {
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "ddd",
                    },
                  ],
                },
              },
              "matchesReplaceMap[21]": {
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "eee",
                    },
                  ],
                },
              },
              "matchesReplaceMap[22]": {
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "fff",
                    },
                  ],
                },
              },
            },
          },
          children: [],
        },
      ],
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);

    const table = rawBlockSnapshot.children[0];
    expect(table?.flavour).toBe(TableModelFlavour);
    if (!table) return;
    expect(table.props.appearance).toBeUndefined();
    expect(table.props.density).toBeUndefined();
    for (const headerRows of [0, 2]) {
      table.props.headerRows = headerRows;
      table.props.appearance = "ruled";
      table.props.density = "compact";
      const exported = (
        await mdAdapter.fromBlockSnapshot({ snapshot: rawBlockSnapshot })
      ).file;
      expect(exported).toContain("<table>");
      expect(exported.split("<th>").length - 1).toBe(headerRows * 3);
      expect(exported).not.toContain("| aaa |");
      const imported = await mdAdapter.toBlockSnapshot({ file: exported });
      expect(imported.children).toHaveLength(1);
      expect(imported.children[0]?.flavour).toBe(TableModelFlavour);
      expect(imported.children[0]?.props.headerRows).toBe(headerRows);
      expect(
        (await mdAdapter.fromBlockSnapshot({ snapshot: imported })).file,
      ).toBe(exported);
    }
  });

  test("HTML table Markdown preserves basic cell semantics and container order", async () => {
    const table =
      '<table><tbody><tr><td style="text-align:left"><strong>Label</strong></td><td style="text-align:right"></td></tr><tr><td style="text-align:left"><em>first<br>second</em></td><td style="text-align:right"><del>strike</del> <code>&lt;literal&gt;</code> <a href="https://example.test/?x=1&amp;y=2"><strong>link</strong></a></td></tr></tbody></table>';
    for (const file of [
      `Before\n\n${table}\n\nAfter`,
      `- Before\n\n  ${table}\n\n  After`,
      `> Before\n>\n> ${table}\n>\n> After`,
    ]) {
      const adapter = new MarkdownAdapter(createJob(), provider);
      const snapshot = await adapter.toBlockSnapshot({ file });
      const find = (block: BlockSnapshot): BlockSnapshot[] => [
        block,
        ...block.children.flatMap(find),
      ];
      const tables = find(snapshot).filter(
        (block) => block.flavour === TableModelFlavour,
      );
      expect(tables).toHaveLength(1);
      const props = tables[0].props as unknown as TableBlockPropsSerialized;
      expect(props.headerRows).toBe(0);
      const columns = Object.values(props.columns).sort((a, b) =>
        a.order.localeCompare(b.order),
      );
      const rows = Object.values(props.rows).sort((a, b) =>
        a.order.localeCompare(b.order),
      );
      expect(columns.map((column) => column.textAlign)).toEqual([
        "left",
        "right",
      ]);
      expect(
        props.cells[`${rows[0].rowId}:${columns[0].columnId}`].text.delta,
      ).toEqual([{ insert: "Label", attributes: { bold: true } }]);
      expect(
        props.cells[`${rows[0].rowId}:${columns[1].columnId}`].text.delta,
      ).toEqual([]);
      expect(
        props.cells[`${rows[1].rowId}:${columns[0].columnId}`].text.delta,
      ).toEqual([{ insert: "first\nsecond", attributes: { italic: true } }]);
      const rich =
        props.cells[`${rows[1].rowId}:${columns[1].columnId}`].text.delta;
      expect(rich).toContainEqual({
        insert: "<literal>",
        attributes: { code: true },
      });
      expect(rich).toContainEqual({
        insert: "link",
        attributes: { bold: true, link: "https://example.test/?x=1&y=2" },
      });
      expect(adapter.importDiagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      const exported = (await adapter.fromBlockSnapshot({ snapshot })).file;
      expect(exported.indexOf("Before")).toBeLessThan(
        exported.indexOf("<table>"),
      );
      expect(exported.indexOf("</table>")).toBeLessThan(
        exported.indexOf("After"),
      );
      const imported = await adapter.toBlockSnapshot({ file: exported });
      expect(
        (await adapter.fromBlockSnapshot({ snapshot: imported })).file,
      ).toBe(exported);
      expect(adapter.exportDiagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
    }
  });

  test("HTML table references rebind forward targets and use portable authorized exports", async () => {
    const collection = new TestWorkspace();
    collection.storeExtensions = testStoreExtensions;
    collection.meta.initialize();
    const archive = new Zip();
    await archive.file(
      "Source.md",
      '# Source\n\n<table><tbody><tr><td><a href="Target.md#%5Einstruction">instruction</a></td><td><a href="#%5Elocal">local</a></td></tr></tbody></table>\n\nLocal decision. ^local',
    );
    await archive.file(
      "Target.md",
      "# Target\n\nRelease instruction. ^instruction",
    );
    try {
      const result = await MarkdownTransformer.importMarkdownZip({
        collection,
        schema: new Schema().register(MyoxusSchemas),
        imported: await archive.generate(),
        extensions: testStoreExtensions,
      });
      expect(result.diagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      const metas = collection.meta.docMetas;
      const sourceId = metas.find(({ title }) => title === "Source")!.id;
      const targetId = metas.find(({ title }) => title === "Target")!.id;
      const source = collection.getDoc(sourceId)!.getStore({ id: sourceId });
      const snapshot = source.getTransformer([]).docToSnapshot(source)!;
      const table = snapshot.blocks.children
        .flatMap((block) => block.children)
        .find(({ flavour }) => flavour === TableModelFlavour)!;
      const deltas = Object.values(
        (table.props as unknown as TableBlockPropsSerialized).cells,
      ).flatMap((cell) => cell.text.delta);
      expect(deltas.map(({ attributes }) => attributes)).toEqual([
        expect.objectContaining({
          reference: expect.objectContaining({ pageId: targetId }),
        }),
        expect.objectContaining({
          reference: expect.objectContaining({ pageId: sourceId }),
        }),
      ]);
      const titles = new Map(metas.map(({ id, title }) => [id, title]));
      const targets = new Map(
        metas.map(({ id }) => [
          id,
          markdownNativeTargets(
            collection
              .getDoc(id)!
              .getStore({ id })
              .getTransformer([])
              .docToSnapshot(collection.getDoc(id)!.getStore({ id }))!.blocks,
            titles,
          ),
        ]),
      );
      const writer = new MarkdownAdapter(
        createJob([
          documentReferenceMiddleware(
            metas,
            new Map([
              ["Source.md", sourceId],
              ["Target.md", targetId],
            ]),
            "Source.md",
            { nativeTargets: targets, currentDocumentId: sourceId },
          ),
        ]),
        provider,
      );
      const exported = (await writer.fromDocSnapshot({ snapshot })).file;
      expect(exported).toContain('href="Target.md#%5Einstruction"');
      expect(exported).toContain('href="#%5Elocal"');
      expect(writer.exportDiagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      const denied = new MarkdownAdapter(
        createJob([
          documentReferenceMiddleware(
            [{ id: sourceId, title: "Source" }],
            new Map([["Source.md", sourceId]]),
            "Source.md",
            { nativeTargets: targets, currentDocumentId: sourceId },
          ),
        ]),
        provider,
      );
      const deniedExport = (await denied.fromDocSnapshot({ snapshot })).file;
      expect(deniedExport).not.toContain("Target.md");
      expect(deniedExport).toContain("instruction");
      expect(denied.exportDiagnostics.unresolvedReferences).toBe(1);
    } finally {
      collection.dispose();
    }
  });

  test("unsafe or unsupported table HTML stays inert without consuming valid tables twice", async () => {
    const safe = "<table><tbody><tr><td>Body</td></tr></tbody></table>";
    for (const unsafe of [
      safe.replace("<td>", '<td onclick="private()">'),
      safe.replace("<td>", '<td style="color:red">'),
      safe.replace("<td>", '<td colspan="2">'),
      safe.replace("Body", "<span>Body</span>"),
      safe.replace("Body", '<a href="javascript:private()">Body</a>'),
      safe.replace("Body", safe),
      safe.replace("</table>", ""),
      safe + "<script>private()</script>",
      safe.replace("<td>", '<td style="text-align:left" style="color:red">'),
    ]) {
      const adapter = new MarkdownAdapter(createJob(), provider);
      const snapshot = await adapter.toBlockSnapshot({ file: unsafe });
      expect(snapshot.children).toHaveLength(1);
      expect(snapshot.children[0]?.flavour).toBe("myoxus:code");
      expect(snapshot.children[0]?.props.text).toMatchObject({
        delta: [{ insert: unsafe }],
      });
      expect(adapter.importDiagnostics.unsupportedTables).toBe(1);
    }
    const adapter = new MarkdownAdapter(createJob(), provider);
    const snapshot = await adapter.toBlockSnapshot({
      file: `<div>Unrelated</div>\n\n\`\`\`html\n${safe}\n\`\`\`\n\n${safe}`,
    });
    expect(snapshot.children.map((block) => block.flavour)).toEqual([
      "myoxus:code",
      "myoxus:code",
      TableModelFlavour,
    ]);
    expect(adapter.importDiagnostics.unsupportedTables).toBeUndefined();
  });

  test("shared operations fixture preserves table alignment and rich body semantics", async () => {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../../../build/fixtures/seed-documents/complex/03-operations-runbook-fixture.md",
      ),
      "utf8",
    );
    const job = createJob();
    const adapter = new MarkdownAdapter(job, provider);
    const assets = job.assetsManager;
    try {
      // The standalone fixture has a relative diagram reference; supply its
      // inline SVG through the normal archive asset inventory.
      const svg = decodeURIComponent(
        source.match(
          /!\[SVG incident flow\]\(data:image\/svg\+xml,([^\n]+)\)/,
        )![1],
      );
      assets
        .getAssets()
        .set(
          "runbook-diagram",
          new File([svg], "runbook-diagram.svg", { type: "image/svg+xml" }),
        );
      assets
        .getPathBlobIdMap()
        .set("assets/runbook-diagram.svg", "runbook-diagram");
      const imported = await adapter.toBlockSnapshot({ file: source, assets });
      const semantics = (block: BlockSnapshot): unknown => {
        const result: Record<string, unknown> = {
          flavour: block.flavour,
          children: block.children.map(semantics),
        };
        for (const key of [
          "text",
          "type",
          "checked",
          "order",
          "language",
          "sourceId",
          "source",
        ])
          if (block.props[key] !== undefined) result[key] = block.props[key];
        if (block.flavour === TableModelFlavour) {
          const props = block.props as unknown as TableBlockPropsSerialized;
          const columns = Object.values(props.columns).sort(
            (a, b) =>
              a.order.localeCompare(b.order) ||
              a.columnId.localeCompare(b.columnId),
          );
          const rows = Object.values(props.rows).sort(
            (a, b) =>
              a.order.localeCompare(b.order) || a.rowId.localeCompare(b.rowId),
          );
          result.table = {
            headerRows: props.headerRows,
            alignment: columns.map((column) => column.textAlign),
            cells: rows.map((row) =>
              columns.map(
                (column) => props.cells[`${row.rowId}:${column.columnId}`].text,
              ),
            ),
          };
        }
        return result;
      };
      const tables = imported.children.filter(
        (block) => block.flavour === TableModelFlavour,
      );
      expect(tables).toHaveLength(4);
      const columns = Object.values(
        (tables[0].props as unknown as TableBlockPropsSerialized).columns,
      ).sort((a, b) => a.order.localeCompare(b.order));
      expect(columns.map((column) => column.textAlign)).toEqual([
        TextAlign.Left,
        TextAlign.Center,
        TextAlign.Right,
        undefined,
      ]);
      expect(Object.hasOwn(columns[3], "textAlign")).toBe(false);
      expect(
        imported.children.filter((block) => block.flavour === "myoxus:image"),
      ).toHaveLength(3);
      const exported = await adapter.fromBlockSnapshot({
        snapshot: imported,
        assets,
      });
      const separators = exported.file
        .split("\n")
        .filter((line) => /^\|[ :|-]+\|$/.test(line))
        .map((line) =>
          line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim().replace(/-+/g, "---")),
        );
      expect(separators).toEqual([
        [":---", ":---:", "---:", "---"],
        ["---", "---", "---"],
        ["---", "---", "---"],
        ["---", "---", "---"],
      ]);
      for (const [key, file] of assets.getAssets()) {
        assets.getPathBlobIdMap().set(`assets/${(file as File).name}`, key);
      }
      const restored = await adapter.toBlockSnapshot({
        file: exported.file,
        assets,
      });
      expect(semantics(restored)).toEqual(semantics(imported));
    } finally {
      job[Symbol.dispose]();
    }
  });

  test("preserves native table presentation through snapshots, clipboard and HTML", async () => {
    const markdown = `| **Left** | Center | Right | Legacy |
| :--- | :---: | ---: | --- |
| [link](https://example.com) |  | \`code\` | literal \\| pipe |
`;
    using job = createJob();
    using restoredJob = createJob();
    const mdAdapter = new MarkdownAdapter(job, provider);
    const doc = await mdAdapter.toDoc({ file: markdown });
    expect(doc).toBeDefined();
    if (!doc) return;

    const table = doc.getBlocksByFlavour(TableModelFlavour)[0]
      ?.model as TableBlockModel;
    expect(table).toBeDefined();
    const columns = Object.values(table.props.columns).sort((left, right) =>
      left.order.localeCompare(right.order),
    );
    expect(columns.map((column) => column.textAlign)).toEqual([
      TextAlign.Left,
      TextAlign.Center,
      TextAlign.Right,
      undefined,
    ]);

    const nativeRows = Object.values(table.props.rows).sort((a, b) =>
      a.order.localeCompare(b.order),
    );
    const firstRow = nativeRows[0];
    doc.transact(() => {
      table.props.appearance = "ruled";
      table.props.columns[columns[0].columnId].width = 240;
      table.props.columns[columns[1].columnId].width = 120;
      table.props.columns[columns[2].columnId].width = 60;
      table.props.columns[columns[1].columnId].backgroundColor =
        "var(--myoxus-tag-green)";
      table.props.rows[nativeRows[1].rowId].backgroundColor =
        "--myoxus-sem-status-preset-paper";
      table.props.cells[
        `${firstRow.rowId}:${columns[0].columnId}`
      ].backgroundColor = "--myoxus-sem-status-error-paper";
    });

    const stored = mdAdapter.job.docToSnapshot(doc);
    const storedTable = stored?.blocks.children
      .flatMap((block) => block.children)
      .find((block) => block.flavour === TableModelFlavour);
    expect(storedTable?.props.columns).toEqual({ ...table.props.columns });

    expect(Object.hasOwn(columns[3], "textAlign")).toBe(false);
    expect(
      table.yBlock.has(`prop:columns.${columns[3].columnId}.textAlign`),
    ).toBe(false);

    const restored = await restoredJob.snapshotToDoc(stored!);
    expect(restored).toBeDefined();
    const restoredTable = restored!.getBlocksByFlavour(TableModelFlavour)[0]
      .model as TableBlockModel;
    expect(restoredJob.blockToSnapshot(restoredTable)?.props).toEqual(
      mdAdapter.job.blockToSnapshot(table)?.props,
    );

    const clipboard = new ClipboardAdapter(restoredJob, provider);
    const copied = await clipboard.fromSliceSnapshot({
      snapshot: {
        type: "slice",
        workspaceId: "",
        pageId: restored!.id,
        content: [restoredJob.blockToSnapshot(restoredTable)!],
      },
      assets: restoredJob.assetsManager,
    });
    const pasted = await clipboard.toSliceSnapshot({ file: copied.file });
    const pasteTarget = await mdAdapter.toDoc({ file: "Paste destination" });
    expect(pasteTarget).toBeDefined();
    const parent = pasteTarget!.getBlocksByFlavour("myoxus:note")[0].model;
    const pastedTable = (await mdAdapter.job.snapshotToBlock(
      pasted.content[0],
      pasteTarget!,
      parent.id,
    )) as TableBlockModel;
    expect(mdAdapter.job.blockToSnapshot(pastedTable)?.props).toEqual(
      restoredJob.blockToSnapshot(restoredTable)?.props,
    );

    const theme = new ThemeService({
      getOptional: () => undefined,
      store: doc,
      host: document.createElement("div"),
    } as unknown as BlockStdScope);
    theme.getCssVariableColor("--myoxus-border-color");
    const paintScope = document.querySelector<HTMLElement>(
      '[data-myoxus-theme-color-probe="light"]',
    )!;
    const previousPaint = paintScope.getAttribute("style");
    // Happy DOM does not inherit stylesheet custom properties onto this probe.
    // Project the fixture palette directly; the real ThemeService still resolves it.
    for (const [name, value] of Object.entries({
      "--myoxus-sem-status-error-paper": "#f4c7c7",
      "--myoxus-sem-status-preset-paper": "#f8dd8e",
      "--myoxus-tag-green": "#c7e5d2",
      "--myoxus-text-primary-color": "#1f2330",
      "--myoxus-background-secondary-color": "#ededed",
      "--myoxus-border-color": "#112233",
    }))
      paintScope.style.setProperty(name, value);
    try {
      const exportServices = new Container();
      exportServices.addImpl(ThemeProvider, () => theme);
      const htmlAdapter = new HtmlAdapter(
        job,
        provider,
        exportServices.provider(undefined, provider),
      );
      const html = await htmlAdapter.fromDoc(doc);
      const exportedTable = new DOMParser()
        .parseFromString(html!.file, "text/html")
        .querySelector("table")!;
      const htmlCells = Array.from(
        exportedTable.querySelectorAll<HTMLTableCellElement>("th,td"),
      );
      expect(htmlCells.map((cell) => cell.style.textAlign)).toEqual([
        "left",
        "center",
        "right",
        "",
        "left",
        "center",
        "right",
        "",
      ]);
      expect(htmlCells.map((cell) => cell.style.backgroundColor)).toEqual([
        "#f4c7c7",
        "#c7e5d2",
        "#ededed",
        "#ededed",
        "#f8dd8e",
        "#c7e5d2",
        "#f8dd8e",
        "#f8dd8e",
      ]);
      const tracks = Array.from(exportedTable.querySelectorAll("col"), (col) =>
        parseFloat(col.style.width),
      );
      expect(tracks.map((width) => width / tracks[2])).toEqual([4, 2, 1, 2]);
      expect(
        htmlCells.every(
          (cell) => !cell.getAttribute("style")?.includes("var("),
        ),
      ).toBe(true);
      expect(htmlCells[0].getAttribute("style")).toContain(
        "border-block:1px solid #112233",
      );
      expect(exportedTable.querySelector("a")?.getAttribute("href")).toBe(
        "https://example.com",
      );
      const htmlImported = await htmlAdapter.toDoc({ file: html!.file });
      const htmlTable = htmlImported!.getBlocksByFlavour(TableModelFlavour)[0]
        .model as TableBlockModel;
      const htmlManager = new TableDataManager(htmlTable);
      expect(
        htmlManager.columns$.value.map((column) => column.textAlign),
      ).toEqual([TextAlign.Left, TextAlign.Center, TextAlign.Right, undefined]);
      const importedCells = htmlManager.rows$.value.flatMap((row) =>
        htmlManager.columns$.value.map((column) =>
          htmlManager.getCell(row.rowId, column.columnId)!,
        ),
      );
      expect(importedCells.map((cell) => cell.backgroundColor)).toEqual(
        htmlCells.map((cell) => cell.style.backgroundColor),
      );
      expect(importedCells.map((cell) => cell.text.toDelta())).toEqual(
        nativeRows.flatMap((row) =>
          columns.map((column) =>
            table.props.cells[`${row.rowId}:${column.columnId}`].text.toDelta(),
          ),
        ),
      );
    } finally {
      if (previousPaint === null) paintScope.removeAttribute("style");
      else paintScope.setAttribute("style", previousPaint);
    }

    const exported = await mdAdapter.fromDoc(doc);
    expect(exported?.file).not.toContain("<table>");
    expect(exported?.file).toContain("[link](https://example.com)");
    expect(exported?.file).toContain("`code`");
    expect(exported?.file).toContain("literal \\| pipe");

    const reimported = await mdAdapter.toDoc({ file: exported!.file });
    const reimportedTable = reimported?.getBlocksByFlavour(TableModelFlavour)[0]
      ?.model as TableBlockModel | undefined;
    expect(
      Object.values(reimportedTable!.props.columns)
        .sort((left, right) => left.order.localeCompare(right.order))
        .map((column) => column.textAlign),
    ).toEqual([TextAlign.Left, TextAlign.Center, TextAlign.Right, undefined]);
    const separators = (file: string) =>
      file
        .split("\n")
        .find((line) => /^\|[ :|-]+\|$/.test(line))!
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replace(/-+/g, "---"));
    expect(separators(exported!.file)).toEqual([
      ":---",
      ":---:",
      "---:",
      "---",
    ]);

    const manager = new TableDataManager(restoredTable);
    const duplicateId = manager.duplicateColumn(0)!;
    expect(restoredTable.props.columns[duplicateId].textAlign).toBe(
      TextAlign.Left,
    );
    for (const row of manager.rows$.value) {
      expect(manager.getCell(row.rowId, duplicateId)?.text.toDelta()).toEqual(
        manager.getCell(row.rowId, columns[0].columnId)?.text.toDelta(),
      );
      expect(manager.getCell(row.rowId, duplicateId)?.backgroundColor).toBe(
        manager.getCell(row.rowId, columns[0].columnId)?.backgroundColor,
      );
    }
    manager.moveColumn(1, 3);
    expect(manager.columns$.value.map((column) => column.textAlign)).toEqual([
      TextAlign.Left,
      TextAlign.Center,
      TextAlign.Right,
      TextAlign.Left,
      undefined,
    ]);
    const inserted = manager.addColumn(0);
    expect(
      Object.hasOwn(restoredTable.props.columns[inserted], "textAlign"),
    ).toBe(false);
    manager.setColumnTextAlign(columns[0].columnId);
    expect(
      Object.hasOwn(
        restoredTable.props.columns[columns[0].columnId],
        "textAlign",
      ),
    ).toBe(false);
    expect(
      restoredTable.yBlock.has(`prop:columns.${columns[0].columnId}.textAlign`),
    ).toBe(false);
    // Invalid persisted input is tolerated at the renderer/codec boundary.
    restoredTable.props.columns[columns[0].columnId].textAlign =
      "justify" as TextAlign;
    const restoredAdapter = new MarkdownAdapter(restoredJob, provider);
    expect(
      separators((await restoredAdapter.fromDoc(restored!))!.file),
    ).toEqual(["---", "---", ":---:", "---:", ":---", "---"]);

    const duplicateRowId = manager.duplicateRow(0)!;
    for (const column of manager.columns$.value) {
      expect(
        manager.getCell(duplicateRowId, column.columnId)?.backgroundColor,
      ).toBe(manager.getCell(firstRow.rowId, column.columnId)?.backgroundColor);
    }
  });

  describe("inline latex", () => {
    test.each([
      ["dollar sign syntax", "inline $E=mc^2$ latex\n"],
      ["backslash syntax", "inline \\(E=mc^2\\) latex\n"],
    ])("should convert %s correctly", async (_, markdown) => {
      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:paragraph",
            props: {
              type: "text",
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert: "inline ",
                  },
                  {
                    insert: " ",
                    attributes: {
                      latex: "E=mc^2",
                    },
                  },
                  {
                    insert: " latex",
                  },
                ],
              },
            },
            children: [],
          },
        ],
      };

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });
  });

  describe("latex block", () => {
    test.each([
      ["dollar sign syntax", "$$\nE=mc^2\n$$\n"],
      ["backslash syntax", "\\[\nE=mc^2\n\\]\n"],
    ])("should convert %s correctly", async (_, markdown) => {
      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:latex",
            props: {
              latex: "E=mc^2",
            },
            children: [],
          },
        ],
      };

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });

    test("escapes dollar signs followed by a digit or space and digit", async () => {
      const markdown =
        "The price of the T-shirt is $9.15 and the price of the hat is $ 8\n";
      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:paragraph",
            props: {
              type: "text",
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert:
                      "The price of the T-shirt is $9.15 and the price of the hat is $ 8",
                  },
                ],
              },
            },
            children: [],
          },
        ],
      };
      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });
  });

  test("reference", async () => {
    const markdown = `
aaa

&#x20;   bbb

[untitled](https://example.com/4T5ObMgEIMII-4Bexyta1)

&#x20;   ccc

&#x20;       ddd

&#x20;       eee[test](https://example.com/deadbeef?mode=page\\&blockIds=abc%2C123\\&elementIds=def%2C456)[](https://example.com/foobar)

&#x20;       fff

&#x20;   ggg

hhh
`;
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: "both",
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "aaa" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "    bbb" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: " ",
                  attributes: {
                    reference: {
                      type: "LinkedPage",
                      pageId: "4T5ObMgEIMII-4Bexyta1",
                      title: "untitled",
                      params: {},
                    },
                  },
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[4]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "    ccc" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[5]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "        ddd" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[6]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                { insert: "        eee" },
                {
                  insert: " ",
                  attributes: {
                    reference: {
                      type: "LinkedPage",
                      pageId: "deadbeef",
                      title: "test",
                      params: {
                        mode: "page",
                        blockIds: ["abc", "123"],
                        elementIds: ["def", "456"],
                      },
                    },
                  },
                },
                {
                  insert: " ",
                  attributes: {
                    reference: {
                      type: "LinkedPage",
                      pageId: "foobar",
                      params: {},
                    },
                  },
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[7]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "        fff" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[8]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "    ggg" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[9]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "hhh" }],
            },
          },
          children: [],
        },
      ],
    };
    const middleware: TransformerMiddleware = ({ adapterConfigs }) => {
      adapterConfigs.set("docLinkBaseUrl", "https://example.com");
    };
    const mdAdapter = new MarkdownAdapter(
      createJob([
        middleware,
        documentReferenceMiddleware([
          { id: "4T5ObMgEIMII-4Bexyta1", title: "Current title" },
          { id: "deadbeef", title: "Current test title" },
          { id: "foobar", title: "Current empty-label title" },
        ]),
      ]),
      provider,
    );
    const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
      file: markdown,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("an inaccessible own-workspace URL stays an ordinary visible link", async () => {
    const baseUrl: TransformerMiddleware = ({ adapterConfigs }) => {
      adapterConfigs.set("docLinkBaseUrl", "https://example.com");
    };
    const mdAdapter = new MarkdownAdapter(
      createJob([baseUrl, documentReferenceMiddleware([])]),
      provider,
    );
    const snapshot = await mdAdapter.toBlockSnapshot({
      file: "[Visible](https://example.com/inaccessible)",
    });
    const note = snapshot?.children[0];
    const paragraph = note?.children[0];
    expect(paragraph?.props.text).toMatchObject({
      delta: [
        {
          insert: "Visible",
          attributes: { link: "https://example.com/inaccessible" },
        },
      ],
    });
  });

  test("aggregates document-reference diagnostics per import operation", async () => {
    const mdAdapter = new MarkdownAdapter(
      createJob([
        documentReferenceMiddleware(
          [{ id: "known", title: "Known" }],
          new Map([["docs/known.md", "known"]]),
          "docs/source.md",
        ),
      ]),
      provider,
    );

    const snapshot = await mdAdapter.toBlockSnapshot({
      file: "[[Missing]] and [[Known#anchor]] and [relative](missing.md)",
    });

    expect(mdAdapter.importDiagnostics).toEqual({
      unresolvedReferences: 2,
      unsupportedReferences: 1,
    });
    expect(JSON.stringify(snapshot)).toContain("[[Missing]]");
    expect(JSON.stringify(snapshot)).toContain("[[Known#anchor]]");
    expect(JSON.stringify(snapshot)).toContain("relative");

    await mdAdapter.toBlockSnapshot({ file: "No references" });
    expect(mdAdapter.importDiagnostics).toEqual({
      unresolvedReferences: 0,
      unsupportedReferences: 0,
    });
  });

  test("invalid wiki paths never fall through to same-named titles", async () => {
    const unsafeTitles = [
      "/root.md",
      "C:\\root.md",
      "\\\\server\\share.md",
      "../../outside.md",
      "nested%2Ftarget.md",
      "%2E%2E",
      "%2Froot",
      "%43%3Aroot",
    ];
    const mdAdapter = new MarkdownAdapter(
      createJob([
        documentReferenceMiddleware(
          [
            { id: "legitimate", title: "Legitimate" },
            { id: "target", title: "Different target title" },
            ...unsafeTitles.map((title, index) => ({
              id: `unsafe-${index}`,
              title,
            })),
          ],
          new Map([["nested/target.md", "target"]]),
          "docs/source.md",
        ),
      ]),
      provider,
    );

    const snapshot = await mdAdapter.toBlockSnapshot({
      file: `${unsafeTitles.map((target) => `[[${target}]]`).join(" ")} [[Legitimate]] [[../nested/target]]`,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('"pageId":"legitimate"');
    expect(serialized).toContain('"pageId":"target"');
    expect(serialized).not.toContain('"pageId":"unsafe-');
    expect(mdAdapter.importDiagnostics).toEqual({
      unresolvedReferences: unsafeTitles.length,
      unsupportedReferences: 0,
    });
  });

  test("paste reports document-reference diagnostics once per operation", async () => {
    const notifyMarkdownImportDiagnostics = vi.fn();
    const notificationService: NotificationService = {
      notifyMarkdownImportDiagnostics,
      toast: vi.fn(),
      confirm: vi.fn(async () => false),
      prompt: vi.fn(async () => null),
      notify: vi.fn(),
      notifyWithUndoAction: vi.fn(),
    };
    const transformContainer = new Container();
    for (const extension of testStoreExtensions)
      extension.setup(transformContainer);
    const transformProvider = transformContainer.provider();
    const scopeContainer = new Container();
    NotificationExtension(notificationService).setup(scopeContainer);
    const scopeProvider = scopeContainer.provider(undefined, transformProvider);
    const adapter = new MixTextAdapter(
      createJob([
        documentReferenceMiddleware(
          [{ id: "known", title: "Known" }],
          new Map([["docs/known.md", "known"]]),
          "docs/source.md",
        ),
      ]),
      transformProvider,
      scopeProvider,
    );

    const diagnosticSnapshot = await adapter.toSliceSnapshot({
      file: "[[Missing]] and [[Known#anchor]] and [relative](missing.md)",
      workspaceId: "workspace",
      pageId: "page",
    });
    expect(diagnosticSnapshot?.content[0]?.children).not.toHaveLength(0);
    expect(notifyMarkdownImportDiagnostics).toHaveBeenCalledOnce();
    expect(notifyMarkdownImportDiagnostics).toHaveBeenCalledWith({
      unresolvedReferences: 2,
      unsupportedReferences: 1,
    });

    await adapter.toSliceSnapshot({
      file: "No references",
      workspaceId: "workspace",
      pageId: "page",
    });
    expect(notifyMarkdownImportDiagnostics).toHaveBeenCalledOnce();
  });

  describe("footnote", () => {
    const url = "https://www.example.com";
    const favicon = "https://www.example.com/favicon.ico";
    const title = "Example Domain";
    const description = "Example Domain";
    const blockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
                {
                  insert: " ",
                  attributes: {
                    footnote: {
                      label: "1",
                      reference: {
                        type: "url",
                        url,
                        favicon,
                        title,
                        description,
                      },
                    },
                  },
                },
                {
                  insert: " ",
                  attributes: {
                    footnote: {
                      label: "2",
                      reference: {
                        type: "doc",
                        docId: "deadbeef",
                      },
                    },
                  },
                },
                {
                  insert: " ",
                  attributes: {
                    footnote: {
                      label: "3",
                      reference: {
                        type: "attachment",
                        blobId: "abcdefg",
                        fileName: "test.txt",
                        fileType: "text/plain",
                      },
                    },
                  },
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "h6",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "Sources",
                },
              ],
            },
            collapsed: true,
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:bookmark",
          props: {
            style: "citation",
            url,
            title,
            description,
            icon: favicon,
            footnoteIdentifier: "1",
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[4]",
          flavour: "myoxus:embed-linked-doc",
          props: {
            style: "citation",
            pageId: "deadbeef",
            footnoteIdentifier: "2",
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[5]",
          flavour: "myoxus:attachment",
          props: {
            name: "test.txt",
            sourceId: "abcdefg",
            footnoteIdentifier: "3",
            style: "citation",
          },
          children: [],
        },
      ],
    };

    test("with encoded url and favicon", async () => {
      const encodedUrl = encodeURIComponent(url);
      const encodedFavicon = encodeURIComponent(favicon);
      const markdown = `aaa[^1][^2][^3]\n\n[^1]: {"type":"url","url":"${encodedUrl}","favicon":"${encodedFavicon}","title":"${title}","description":"${description}"}\n\n[^2]: {"type":"doc","docId":"deadbeef"}\n\n[^3]: {"type":"attachment","blobId":"abcdefg","fileName":"test.txt","fileType":"text/plain"}\n`;

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });

    test("with unencoded url and favicon", async () => {
      const markdown = `aaa[^1][^2][^3]\n\n[^1]: {"type":"url","url":"${url}","favicon":"${favicon}","title":"${title}","description":"${description}"}\n\n[^2]: {"type":"doc","docId":"deadbeef"}\n\n[^3]: {"type":"attachment","blobId":"abcdefg","fileName":"test.txt","fileType":"text/plain"}\n`;

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });

    test("should handle footnote reference with url prefix", async () => {
      const blockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:paragraph",
            props: {
              type: "text",
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert: "https://example.com",
                    attributes: {
                      link: "https://example.com",
                    },
                  },
                  {
                    insert: " ",
                  },
                  {
                    insert: " ",
                    attributes: {
                      footnote: {
                        label: "1",
                        reference: {
                          type: "url",
                          url,
                          favicon,
                          title,
                          description,
                        },
                      },
                    },
                  },
                ],
              },
            },
            children: [],
          },
          {
            type: "block",
            id: "matchesReplaceMap[2]",
            flavour: "myoxus:paragraph",
            props: {
              type: "h6",
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert: "Sources",
                  },
                ],
              },
              collapsed: true,
            },
            children: [],
          },
          {
            type: "block",
            id: "matchesReplaceMap[3]",
            flavour: "myoxus:bookmark",
            props: {
              style: "citation",
              url,
              title,
              description,
              icon: favicon,
              footnoteIdentifier: "1",
            },
            children: [],
          },
        ],
      };

      const markdown = `https://example.com[^1]\n\n[^1]: {"type":"url","url":"${url}","favicon":"${favicon}","title":"${title}","description":"${description}"}\n`;

      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });
  });

  test("should not wrap url with angle brackets if it is not a url", async () => {
    const markdown = "prompt: How many people will live in the world in 2040?";
    const sliceSnapshot: SliceSnapshot = {
      type: "slice",
      content: [
        {
          type: "block",
          id: "matchesReplaceMap[0]",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "matchesReplaceMap[1]",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert:
                        "prompt: How many people will live in the world in 2040?",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
      workspaceId: "",
      pageId: "",
    };

    const mdAdapter = new MarkdownAdapter(createJob(), provider);
    const rawSliceSnapshot = await mdAdapter.toSliceSnapshot({
      file: markdown,
      workspaceId: "",
      pageId: "",
    });
    expect(nanoidReplacement(rawSliceSnapshot!)).toEqual(sliceSnapshot);
  });

  describe("callout", () => {
    const calloutBlockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:callout",
          props: {
            emoji: "💬",
          },
          children: [
            {
              type: "block",
              id: "matchesReplaceMap[2]",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [{ insert: "This is a callout" }],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    test("callout start with escape character", async () => {
      const markdown = "> \\[!💬]\n> This is a callout";
      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(calloutBlockSnapshot);
    });

    test("callout start without escape character", async () => {
      const markdown = "> [!💬]\n> This is a callout";
      const mdAdapter = new MarkdownAdapter(createJob(), provider);
      const rawBlockSnapshot = await mdAdapter.toBlockSnapshot({
        file: markdown,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(calloutBlockSnapshot);
    });
  });
});
