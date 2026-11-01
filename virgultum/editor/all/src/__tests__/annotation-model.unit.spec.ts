// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AnnotationBlockModel,
  AnnotationSchema,
  expandAnnotationSelection,
  getAnnotationRanges,
} from "@virgultum/editor/model/annotation";
import { Container } from "@virgultum/global/di";
import {
  ClipboardAdapter,
  HtmlAdapter,
  MarkdownAdapter,
  MixTextAdapter,
  pasteMiddleware,
} from "@virgultum/shared/adapters";
import { printToPdf } from "@virgultum/shared/utils";
import { Text, type SliceSnapshot, type BlockSnapshot } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { describe, expect, test, vi } from "vitest";
import { html } from "lit";
import {
  AnnotationBlockComponent,
  annotationSlashMenuConfig,
  type AnnotationBlockHostProps,
  type AnnotationInlineHostProps,
} from "@virgultum/editor/blocks/annotation";
import { TextSelection, type BlockStdScope } from "@virgultum/std";

import {
  AnnotationInlineSpecExtension,
  InlineAnnotation,
} from "@virgultum/editor/inlines/preset";
import { InlineEditor } from "@virgultum/std/inline";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { createJob } from "./utils/create-job";
import { getProvider } from "./utils/get-provider";
import { testStoreExtensions } from "./utils/store";
import syntaxFixtures from "../../../../../build/fixtures/contracts/annotation-syntax.json";
import interchangeFixtures from "../../../../../build/fixtures/contracts/annotation-interchange.json";
import { annotationsToLiteralSnapshot } from "../../../shared/src/adapters/markdown/annotation-deltas";

function snapshotAnnotations(
  blocks: BlockSnapshot[],
): { body: string; standalone: boolean }[] {
  return blocks.flatMap((block) => {
    const text = block.props.text as
      { delta: Parameters<typeof getAnnotationRanges>[0] } | undefined;
    const cells =
      block.flavour === "myoxus:table"
        ? Object.values(
            block.props.cells as Record<
              string,
              { text: { delta: Parameters<typeof getAnnotationRanges>[0] } }
            >,
          ).flatMap((cell) =>
            getAnnotationRanges(cell.text.delta).map((range) => ({
              body: range.body,
              standalone: false,
            })),
          )
        : [];
    const own =
      block.flavour === "myoxus:annotation"
        ? [
            {
              body: text?.delta.map((delta) => delta.insert).join("") ?? "",
              standalone: true,
            },
          ]
        : getAnnotationRanges(text?.delta ?? []).map((range) => ({
            body: range.body,
            standalone: false,
          }));
    return [...own, ...cells, ...snapshotAnnotations(block.children)];
  });
}

// Exercise the real custom element; the generic Lit setup stubs registration.
vi.unstubAllGlobals();

describe("canonical annotations", () => {
  test.each(interchangeFixtures.filter(({ body }) => body !== "%"))(
    "current native block interchange: $body",
    async ({ body, supported }) => {
      const job = createJob();
      try {
        const adapter = new MarkdownAdapter(job, getProvider());
        const snapshot: BlockSnapshot = {
          type: "block",
          id: "annotation",
          flavour: "myoxus:annotation",
          children: [],
          props: {
            text: {
              "$virgultum:internal:text$": true,
              delta: body ? [{ insert: body }] : [],
            },
          },
        };
        const result = await adapter.fromBlockSnapshot({ snapshot });
        expect(adapter.exportDiagnostics.unsupportedAnnotations ?? 0).toBe(
          supported ? 0 : 1,
        );
        const readback = await adapter.toBlockSnapshot({ file: result.file });
        expect(snapshotAnnotations(readback.children)).toEqual(
          supported ? [{ body, standalone: true }] : [],
        );
        const text = readback.children[0].props.text as {
          delta: { insert: string }[];
        };
        expect(text.delta.map((delta) => delta.insert).join("")).toBe(
          supported ? body : `%%${body}%%`,
        );
        expect(snapshot.props.text).toEqual({
          "$virgultum:internal:text$": true,
          delta: body ? [{ insert: body }] : [],
        });
      } finally {
        job[Symbol.dispose]();
      }
    },
  );
  test("registered doc/block/slice writers retain logical bodies, neighboring IDs, code and report sole-inline normalization", async () => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const paragraph: BlockSnapshot = {
        type: "block",
        id: "paragraph",
        flavour: "myoxus:paragraph",
        children: [],
        props: {
          type: "text",
          text: {
            "$virgultum:internal:text$": true,
            delta: [
              { insert: "Before ", attributes: { bold: true } },
              { insert: "first\n", attributes: { annotation: { id: "a" } } },
              {
                insert: "second %% ✓",
                attributes: { annotation: { id: "a" }, bold: true },
              },
              { insert: "neighbor", attributes: { annotation: { id: "b" } } },
              { insert: " after " },
              { insert: "%%code%%", attributes: { code: true } },
            ],
          },
        },
      };
      const first = await adapter.fromBlockSnapshot({ snapshot: paragraph });
      expect(adapter.exportDiagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
        unsupportedAnnotations: 1,
      });
      const readback = await adapter.toBlockSnapshot({ file: first.file });
      expect(snapshotAnnotations(readback.children)).toEqual([
        { body: "first\nsecond %% ✓", standalone: false },
        { body: "neighbor", standalone: false },
      ]);
      const text = readback.children[0].props.text as {
        delta: { insert: string; attributes?: MyoxusTextAttributes }[];
      };
      expect(text.delta.find((delta) => delta.attributes?.code)?.insert).toBe(
        "%%code%%",
      );
      expect(text.delta.find((delta) => delta.attributes?.bold)?.insert).toBe(
        "Before ",
      );
      const slice = {
        type: "slice" as const,
        workspaceId: "workspace",
        pageId: "doc",
        content: [paragraph],
      };
      expect((await adapter.fromSliceSnapshot({ snapshot: slice })).file).toBe(
        first.file,
      );
      const alone: BlockSnapshot = {
        ...paragraph,
        props: {
          type: "text",
          text: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "alone\nmultiline",
                attributes: { annotation: { id: "c" } },
              },
            ],
          },
        },
      };
      const doc: import("@virgultum/store").DocSnapshot = {
        type: "page",
        meta: { id: "doc", title: "", createDate: 0, tags: [] },
        blocks: {
          type: "block",
          id: "note",
          flavour: "myoxus:note",
          props: {},
          children: [alone],
        },
      };
      const exported = await adapter.fromDocSnapshot({ snapshot: doc });
      expect(adapter.exportDiagnostics.normalizedAnnotations).toBe(1);
      expect(adapter.exportDiagnostics.unsupportedAnnotations ?? 0).toBe(0);
      const reimported = await adapter.toBlockSnapshot({ file: exported.file });
      expect(snapshotAnnotations(reimported.children)).toEqual([
        { body: "alone\nmultiline", standalone: true },
      ]);
    } finally {
      job[Symbol.dispose]();
    }
  });
  test.each(["%%body%%", "ordinary\n\n%%body%%"])(
    "paste lifecycle preserves semantic annotation boundaries in the middle of a paragraph: %s",
    async (source) => {
      const workspace = new TestWorkspace();
      workspace.storeExtensions = testStoreExtensions;
      workspace.meta.initialize();
      const doc = workspace.createDoc("annotation-paste-boundaries");
      doc.load();
      const store = doc.getStore();
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const id = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("beforeafter") },
        note,
      );
      const selection = new TextSelection({
        from: { blockId: id, index: 6, length: 0 },
        to: null,
      });
      const std = {
        store,
        view: { getBlock: (id: string) => ({ model: store.getModelById(id) }) },
        selection: { find: () => selection },
        getOptional: () => undefined,
        host: { updateComplete: Promise.resolve(), querySelector: () => null },
      } as unknown as BlockStdScope;
      const job = createJob([pasteMiddleware(std)]);
      try {
        const adapter = new MixTextAdapter(job, getProvider());
        const slice = await adapter.toSlice({ file: source }, store, note, 1);
        expect(slice).toBeDefined();
        const children = store.getModelById(note)!.children;
        expect(children.map((model) => model.flavour)).toEqual([
          "myoxus:paragraph",
          "myoxus:annotation",
          "myoxus:paragraph",
        ]);
        expect(children.map((model) => model.text!.toString())).toEqual([
          source.startsWith("ordinary") ? "beforeordinary" : "before",
          "body",
          "after",
        ]);
        expect(children[1].children).toEqual([]);
      } finally {
        job[Symbol.dispose]();
        workspace.dispose();
      }
    },
  );
  test("code, indented code and Mermaid retain their literal source through registered import/export", async () => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const snapshot = await adapter.toSliceSnapshot({
        file: "```text\n%%fence literal%%\n```\n\n    %%indent literal%%\n\n```mermaid\ngraph TD\nA-->B\n%%mermaid literal%%\n```",
        workspaceId: "source",
        pageId: "doc",
      });
      const blocks = snapshot!.content[0].children;
      expect(blocks.map((block) => block.flavour)).toEqual([
        "myoxus:code",
        "myoxus:code",
        "myoxus:mermaid",
      ]);
      const value = (text: unknown) =>
        (text as { delta: { insert: string }[] }).delta
          .map((delta) => delta.insert)
          .join("");
      expect(value(blocks[0].props.text)).toBe("%%fence literal%%");
      expect(value(blocks[1].props.text)).toBe("%%indent literal%%");
      expect(value(blocks[2].props.source)).toContain("%%mermaid literal%%");
      expect(snapshotAnnotations(snapshot!.content)).toEqual([]);
      const exported = await adapter.fromSliceSnapshot({ snapshot: snapshot! });
      expect(exported.file).toContain("%%fence literal%%");
      expect(exported.file).toContain("%%indent literal%%");
      expect(exported.file).toContain("%%mermaid literal%%");
    } finally {
      job[Symbol.dispose]();
    }
  });
  test.each([false, true])(
    "code paste keeps one literal span across deltas and standalone blocks (inline=%s)",
    (inlineCode) => {
      const paragraph: BlockSnapshot = {
        type: "block",
        id: "p",
        flavour: "myoxus:paragraph",
        children: [],
        props: {
          type: "text",
          text: {
            "$virgultum:internal:text$": true,
            delta: [
              { insert: "Before " },
              {
                insert: "first\n",
                attributes: { annotation: { id: "a" }, bold: true },
              },
              { insert: "second", attributes: { annotation: { id: "a" } } },
              { insert: " after %%%%" },
            ],
          },
        },
      };
      const block: BlockSnapshot = {
        type: "block",
        id: "a",
        flavour: "myoxus:annotation",
        children: [],
        props: {
          text: {
            "$virgultum:internal:text$": true,
            delta: [{ insert: "block body" }],
          },
        },
      };
      annotationsToLiteralSnapshot(paragraph, inlineCode);
      annotationsToLiteralSnapshot(block, inlineCode);
      const attrs = inlineCode ? { attributes: { code: true } } : {};
      expect(paragraph.props.text).toEqual({
        "$virgultum:internal:text$": true,
        delta: [{ insert: "Before %%first\nsecond%% after %%%%", ...attrs }],
      });
      expect(block.flavour).toBe("myoxus:paragraph");
      expect(block.props.text).toEqual({
        "$virgultum:internal:text$": true,
        delta: [{ insert: "%%block body%%", ...attrs }],
      });
    },
  );
  test.each(
    syntaxFixtures.filter(({ name }) =>
      [
        "literal HTML body",
        "HTML code literal",
        "literal preprocessing syntax",
        "quoted multiline inline",
        "listed multiline inline",
        "blank line inline",
        "padded block",
        "standalone list annotation",
        "standalone quote annotation",
        "empty inline literal",
        "soft wrap is not block",
        "unmatched literal",
        "escaped literal pairs",
        "escaped body delimiter",
        "tilde fence literal",
        "do not cross inline code",
        "do not cross fenced code",
        "do not cross indented code",
        "list and table cells",
      ].includes(name),
    ),
  )(
    "registered Markdown and plain clipboard codecs: $name",
    async (fixture) => {
      const job = createJob();
      try {
        for (const Adapter of [MarkdownAdapter, MixTextAdapter]) {
          const adapter = new Adapter(job, getProvider());
          const snapshot = await adapter.toSliceSnapshot({
            file: fixture.markdown,
            workspaceId: "source",
            pageId: "doc",
          });
          expect(snapshotAnnotations(snapshot?.content ?? [])).toEqual(
            fixture.annotations,
          );
        }
      } finally {
        job[Symbol.dispose]();
      }
    },
  );
  test("HTML clipboard retains surrounding structure and converts only eligible literal runs", async () => {
    const job = createJob();
    try {
      const adapter = new HtmlAdapter(job, getProvider());
      const snapshot = await adapter.toSliceSnapshot({
        file: "<p><strong>Before </strong>%%literal **body** [[Notiz]]<br>second line%% after <code>%%code%%</code></p><p>%%Check the publication scope.<br><br>Keep the private approval details here.%%</p><pre>%%fence%%</pre>",
        workspaceId: "source",
        pageId: "doc",
      });
      expect(snapshotAnnotations(snapshot?.content ?? [])).toEqual([
        { body: "literal **body** [[Notiz]]\nsecond line", standalone: false },
        {
          body: "Check the publication scope.\n\nKeep the private approval details here.",
          standalone: true,
        },
      ]);
      const paragraph = snapshot!.content[0].children[0];
      const text = paragraph.props.text as {
        delta: { insert: string; attributes?: Record<string, unknown> }[];
      };
      expect(text.delta[0]).toEqual({
        insert: "Before ",
        attributes: { bold: true },
      });
      expect(
        text.delta.find((delta) => delta.insert.includes("%%code%%"))
          ?.attributes?.code,
      ).toBe(true);
      const plain = new MixTextAdapter(job, getProvider());
      const output = await plain.fromSliceSnapshot({ snapshot: snapshot! });
      expect(output.file).toContain(
        "%%literal **body** [[Notiz]]\nsecond line%%",
      );
      expect(output.file).toContain(
        "%%Check the publication scope.\n\nKeep the private approval details here.%%",
      );
    } finally {
      job[Symbol.dispose]();
    }
  });
  test("browser printing removes annotation projections from its clone, never from the live source", async () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>Before <myoxus-inline-annotation>hidden inline</myoxus-inline-annotation> after</p><myoxus-annotation>hidden block</myoxus-annotation>";
    const clones: { text: string | null; annotations: number }[] = [];
    await printToPdf(root, {
      beforeprint: (iframe) => {
        const target = iframe.contentWindow!;
        clones.push({
          text: target.document.body.textContent,
          annotations: target.document.querySelectorAll(
            "myoxus-annotation, myoxus-inline-annotation",
          ).length,
        });
        target.print = () => target.dispatchEvent(new Event("afterprint"));
      },
    });
    expect(clones.length).toBeGreaterThan(0);
    for (const clone of clones) {
      expect(clone.text).toContain("Before  after");
      expect(clone.text).not.toContain("hidden");
      expect(clone.annotations).toBe(0);
    }
    expect(root.textContent).toContain("hidden inline");
    expect(root.textContent).toContain("hidden block");
    expect(
      root.querySelectorAll("myoxus-annotation, myoxus-inline-annotation"),
    ).toHaveLength(2);
    expect(document.querySelector("iframe")).toBeNull();
  });
  test("HTML reading and clipboard projections hide block and multiline inline bodies without mutating snapshots", async () => {
    const job = createJob();
    const adapter = new HtmlAdapter(job, getProvider());
    const snapshot: SliceSnapshot = {
      type: "slice",
      workspaceId: "source",
      pageId: "doc",
      content: [
        {
          type: "block",
          id: "paragraph",
          flavour: "myoxus:paragraph",
          children: [],
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                { insert: "Before " },
                {
                  insert: "hidden first\n",
                  attributes: { annotation: { id: "a" }, bold: true },
                },
                {
                  insert: "hidden second",
                  attributes: {
                    annotation: { id: "a" },
                    link: "https://example.org",
                  },
                },
                { insert: "after", attributes: { bold: true } },
                {
                  insert: " malformed stays",
                  attributes: { annotation: { id: "" } },
                },
              ],
            },
          },
        },
        {
          type: "block",
          id: "annotation",
          flavour: "myoxus:annotation",
          children: [],
          props: {
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "hidden block" }],
            },
          },
        },
      ],
    };
    const original = structuredClone(snapshot);
    try {
      const slice = await adapter.fromSliceSnapshot({ snapshot });
      expect(slice.file).toContain("Before ");
      expect(slice.file).toContain("<strong>after</strong>");
      expect(slice.file).toContain("malformed stays");
      expect(slice.file).not.toContain("hidden");
      const block = await adapter.fromBlockSnapshot({
        snapshot: {
          type: "block",
          id: "note",
          flavour: "myoxus:note",
          props: {},
          children: snapshot.content,
        },
      });
      expect(block.file).toContain("Before ");
      expect(block.file).not.toContain("hidden");
      expect(snapshot).toEqual(original);
    } finally {
      job[Symbol.dispose]();
    }
  });
  test("inline host updates one canonical multiline body, rejects stale or detached targets, and removes empty bodies", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-inline-host");
    doc.load();
    const store = doc.getStore();
    const owner = document.createElement("div");
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const text = new Text("before  after");
      const id = store.addBlock("myoxus:paragraph", { text }, note);
      text.insert("original\n✓", 7, { annotation: { id: "a" } });
      owner.dataset.blockId = id;
      document.body.append(owner);
      if (!customElements.get("myoxus-inline-annotation"))
        customElements.define("myoxus-inline-annotation", InlineAnnotation);
      const component = document.createElement("myoxus-inline-annotation");
      component.editor = new InlineEditor<MyoxusTextAttributes>(text.yText);
      component.startOffset = 7;
      component.delta = {
        insert: "original\n✓",
        attributes: { annotation: { id: "a" } },
      };
      let props!: AnnotationInlineHostProps;
      component.std = {
        store,
        getOptional: () => ({
          showAnnotations: true,
          renderInline: (value: AnnotationInlineHostProps) => {
            props = value;
            return html``;
          },
        }),
      } as unknown as BlockStdScope;
      owner.append(component);
      await component.updateComplete;
      expect(props.body).toBe("original\n✓");
      expect(props.apply("changed\n🙂", props.body)).toBe(true);
      expect(text.toString()).toBe("before changed\n🙂 after");
      expect(props.apply("stale", "original\n✓")).toBe(false);
      store.undo();
      expect(text.toString()).toBe("before original\n✓ after");
      store.redo();
      expect(text.toString()).toBe("before changed\n🙂 after");
      store.readonly = true;
      expect(props.remove("changed\n🙂")).toBe(false);
      store.readonly = false;
      expect(props.apply("", "changed\n🙂")).toBe(true);
      expect(text.toString()).toBe("before  after");
      expect(getAnnotationRanges(text.toDelta())).toHaveLength(0);
      store.undo();
      expect(text.toString()).toBe("before changed\n🙂 after");
      store.deleteBlock(store.getModelById(id)!);
      expect(props.apply("resurrect", "changed\n🙂")).toBe(false);
      expect(props.remove("changed\n🙂")).toBe(false);
    } finally {
      owner.remove();
      workspace.dispose();
    }
  });
  test("annotate replaces an empty slash leaf at its insertion point and requests body focus", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-slash");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const before = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("before") },
        note,
      );
      const empty = store.addBlock(
        "myoxus:paragraph",
        { text: new Text() },
        note,
      );
      const after = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("after") },
        note,
      );
      const startEditing = vi.fn();
      const std = {
        host: { updateComplete: Promise.resolve() },
        view: {
          getBlock: () => ({ flavour: "myoxus:annotation", startEditing }),
        },
      } as unknown as BlockStdScope;
      const items = annotationSlashMenuConfig.items;
      if (!Array.isArray(items))
        throw new Error("static annotation items expected");
      const item = items[0];
      if (!item || !("action" in item))
        throw new Error("annotation action missing");
      expect(item.searchAlias).toContain("annotate");
      item.action({ std, model: store.getModelById(empty)! });
      await std.host.updateComplete;
      const children = store.getModelById(note)!.children;
      expect(children.map((model) => model.flavour)).toEqual([
        "myoxus:paragraph",
        "myoxus:annotation",
        "myoxus:paragraph",
      ]);
      expect(children[0].id).toBe(before);
      expect(children[2].id).toBe(after);
      expect(store.getModelById(empty)).toBeNull();
      expect(startEditing).toHaveBeenCalledOnce();
      store.undo();
      expect(
        store.getModelById(note)!.children.map((model) => model.id),
      ).toEqual([before, empty, after]);
    } finally {
      workspace.dispose();
    }
  });
  test("block host writes native text atomically and rejects stale, readonly and deleted targets", () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-host");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const id = store.addBlock(
        "myoxus:annotation",
        { text: new Text("original") },
        note,
      );
      if (!customElements.get("myoxus-annotation")) {
        customElements.define("myoxus-annotation", AnnotationBlockComponent);
      }
      const component = document.createElement("myoxus-annotation");
      component.store = store;
      component.dataset.blockId = id;
      let props!: AnnotationBlockHostProps;
      component.std = {
        getOptional: () => ({
          showAnnotations: true,
          renderBlock: (value: AnnotationBlockHostProps) => {
            props = value;
            return html``;
          },
        }),
      } as unknown as BlockStdScope;
      component.renderBlock();
      expect(props.body).toBe("original");
      expect(props.apply("changed\n✓", "original")).toBe(true);
      expect(store.getModelById(id)!.text!.toString()).toBe("changed\n✓");
      store.undo();
      expect(store.getModelById(id)!.text!.toString()).toBe("original");
      store.redo();
      expect(store.getModelById(id)!.text!.toString()).toBe("changed\n✓");
      expect(props.apply("stale", "original")).toBe(false);
      store.readonly = true;
      expect(props.apply("denied", "changed\n✓")).toBe(false);
      store.readonly = false;
      store.deleteBlock(store.getModelById(id)!);
      expect(props.apply("resurrected", "changed\n✓")).toBe(false);
    } finally {
      workspace.dispose();
    }
  });
  test("validates identity without accepting a duplicate body or persisted offsets", () => {
    expect(AnnotationSchema.parse({ id: "annotation-a" })).toEqual({
      id: "annotation-a",
    });
    for (const value of [
      { id: "" },
      { id: "a", body: "copy" },
      { id: "a", index: 1 },
      "a",
    ]) {
      expect(AnnotationSchema.safeParse(value).success).toBe(false);
    }
    const container = new Container();
    AnnotationInlineSpecExtension.setup(container);
    const spec = container
      .provider()
      .get(AnnotationInlineSpecExtension.identifier);
    expect(
      spec.match({ insert: "body", attributes: { annotation: { id: "a" } } }),
    ).toBe(true);
    expect(spec.schema.parse({ annotation: { id: "" } })).toEqual({
      annotation: undefined,
    });
  });

  test("materializes, persists, moves, deletes and restores native text via Store history", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-model");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const paragraph = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("ordinary") },
        note,
      );
      const id = store.addBlock(
        "myoxus:annotation",
        { text: new Text("body\nsecond line") },
        note,
      );
      const model = store.getModelById(id)!;
      expect(model).toBeInstanceOf(AnnotationBlockModel);
      expect(model.text?.toString()).toBe("body\nsecond line");
      store.captureSync();
      model.text!.insert("changed ", 0);
      store.captureSync();
      store.undo();
      expect(model.text!.toString()).toBe("body\nsecond line");
      store.redo();
      expect(model.text!.toString()).toBe("changed body\nsecond line");

      const text = store.getModelById(paragraph)!.text!;
      text.insert("secret", text.length, { annotation: { id: "inline-a" } });
      text.format(10, 2, { bold: true });
      const ranges = getAnnotationRanges(text.toDelta());
      expect(ranges).toEqual([
        { id: "inline-a", index: 8, length: 6, body: "secret" },
      ]);
      text.insert("before ", 0, {});
      expect(getAnnotationRanges(text.toDelta())).toEqual([
        { ...ranges[0], index: 15 },
      ]);
      const secondNote = store.addBlock("myoxus:note", {}, root);
      store.moveBlocks(
        [store.getModelById(paragraph)!],
        store.getModelById(secondNote)!,
      );
      expect(
        getAnnotationRanges(store.getModelById(paragraph)!.text!.toDelta()),
      ).toEqual([{ ...ranges[0], index: 15 }]);
      const job = createJob();
      const snapshot = job.docToSnapshot(store)!;
      const restored = await job.snapshotToDoc(snapshot);
      expect(restored!.getModelById(id)!.text!.toString()).toBe(
        model.text!.toString(),
      );
      expect(
        getAnnotationRanges(restored!.getModelById(paragraph)!.text!.toDelta()),
      ).toEqual(getAnnotationRanges(text.toDelta()));
      store.captureSync();
      store.deleteBlock(model);
      expect(store.getModelById(id)).toBeNull();
      store.undo();
      expect(store.getModelById(id)!.text!.toString()).toBe(
        "changed body\nsecond line",
      );
      expect(store.getModelById(paragraph)!.text!.toString()).toBe(
        "before ordinarysecret",
      );
      restored!.dispose();
      job[Symbol.dispose]();
    } finally {
      store.dispose();
      workspace.forceStop();
      workspace.dispose();
    }
  });

  test("groups adjacent formatted deltas and newlines without combining different identities", () => {
    expect(
      getAnnotationRanges([
        { insert: "before " },
        { insert: "one\n", attributes: { annotation: { id: "a" } } },
        { insert: "two", attributes: { annotation: { id: "a" }, bold: true } },
        { insert: "three", attributes: { annotation: { id: "b" } } },
        { insert: " ordinary " },
        { insert: "four", attributes: { annotation: { id: "a" } } },
      ]),
    ).toEqual([
      { id: "a", index: 7, length: 7, body: "one\ntwo" },
      { id: "b", index: 14, length: 5, body: "three" },
      { id: "a", index: 29, length: 4, body: "four" },
    ]);
  });

  test("expands a partial marker selection to the entire body, not neighbouring text", () => {
    const deltas = [
      { insert: "before " },
      { insert: "first\n", attributes: { annotation: { id: "a" } } },
      { insert: "second", attributes: { annotation: { id: "a" }, bold: true } },
      { insert: " after" },
    ];
    expect(expandAnnotationSelection(deltas, 9, 1)).toEqual({
      index: 7,
      length: 12,
    });
    expect(expandAnnotationSelection(deltas, 7, 0)).toEqual({
      index: 7,
      length: 0,
    });
    expect(expandAnnotationSelection(deltas, 0, 7)).toEqual({
      index: 0,
      length: 7,
    });
  });

  test("native clipboard remaps the whole fragment while preserving bodies and other attributes", async () => {
    const job = createJob();
    const adapter = new ClipboardAdapter(job, getProvider());
    const snapshot: SliceSnapshot = {
      type: "slice",
      workspaceId: "source",
      pageId: "doc",
      content: [
        {
          type: "block",
          id: "paragraph",
          flavour: "myoxus:paragraph",
          children: [],
          props: {
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                { insert: "first\n", attributes: { annotation: { id: "a" } } },
                {
                  insert: "second",
                  attributes: { annotation: { id: "a" }, bold: true },
                },
                { insert: "other", attributes: { annotation: { id: "b" } } },
              ],
            },
          },
        },
      ],
    };
    try {
      const result = await adapter.toSliceSnapshot({
        file: JSON.stringify({ snapshot, blobs: {} }),
        assets: job.assetsManager,
      });
      const deltas = (
        result.content[0].props.text as {
          delta: {
            insert: string;
            attributes: { annotation: { id: string }; bold?: boolean };
          }[];
        }
      ).delta;
      expect(deltas.map((d) => d.insert)).toEqual([
        "first\n",
        "second",
        "other",
      ]);
      expect(deltas[0].attributes.annotation.id).not.toBe("a");
      expect(deltas[1].attributes.annotation.id).toBe(
        deltas[0].attributes.annotation.id,
      );
      expect(deltas[2].attributes.annotation.id).not.toBe(
        deltas[0].attributes.annotation.id,
      );
      expect(deltas[1].attributes.bold).toBe(true);
      expect(
        (
          snapshot.content[0].props.text as {
            delta: { attributes: { annotation: { id: string } } }[];
          }
        ).delta[0].attributes.annotation.id,
      ).toBe("a");
    } finally {
      job[Symbol.dispose]();
    }
  });
});
