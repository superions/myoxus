// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  HtmlAdapter,
  MarkdownAdapter,
  configureMarkdownReferenceMetas,
} from "@virgultum/core/adapters";
import type { BlockSnapshot } from "@virgultum/core/store";
import { Text } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import { BlockStdScope, type EditorHost } from "@virgultum/core/runtime";
import {
  calloutPresentation,
  type CalloutBlockModel,
} from "@virgultum/core/models";
import { beforeAll, describe, expect, test, vi } from "vitest";
import fixtures from "../../../../../build/fixtures/contracts/note-callouts.json";
import { createJob } from "./utils/create-job";
import { getProvider } from "./utils/get-provider";
import { testStoreExtensions } from "./utils/store";
import { splitCalloutCommand } from "../../../../content/src/blocks/callout/commands/split-callout";
import { calloutToParagraphCommand } from "../../../../content/src/blocks/callout/commands/callout-to-paragraph";

const callouts = (blocks: BlockSnapshot[]): BlockSnapshot[] =>
  blocks.flatMap((block) => [
    ...(block.flavour === "myoxus:callout" ? [block] : []),
    ...callouts(block.children),
  ]);
const text = (value: unknown) =>
  (value as { delta?: { insert?: string }[] } | undefined)?.delta
    ?.map((part) => part.insert ?? "")
    .join("") ?? "";

describe("registered native note callout codec", () => {
  beforeAll(async () => {
    // This suite checks conversion semantics, not cold bundler transforms.
    // Store registration is data-only; prepare its existing Mermaid source
    // owner before timed cases, as the former eager graph did during import.
    await import("@virgultum/block-mermaid");
  });
  test.each([false, true])(
    "unsupported children retain complete source and a diagnosis (typed=%s)",
    async (typed) => {
      const job = createJob();
      try {
        const adapter = new MarkdownAdapter(job, getProvider());
        const snapshot: BlockSnapshot = {
          type: "block",
          id: "callout",
          flavour: "myoxus:callout",
          props: {
            ...(typed
              ? {
                  type: "note",
                  title: {
                    "$virgultum:internal:text$": true,
                    delta: [{ insert: "Current title" }],
                  },
                }
              : {}),
            icon: { type: "emoji", unicode: "💡" },
          },
          children: [
            {
              type: "block",
              id: "unsupported-diagram",
              flavour: "myoxus:mermaid",
              props: {
                source: {
                  "$virgultum:internal:text$": true,
                  delta: [{ insert: "graph LR\nCurrent-->Diagram" }],
                },
              },
              children: [],
            },
          ],
        };
        const output = await adapter.fromBlockSnapshot({ snapshot });
        expect(output.file).toContain("Current-->Diagram");
        expect(adapter.exportDiagnostics.unsupportedCallouts).toBe(1);
        const imported = await adapter.toBlockSnapshot({ file: output.file });
        expect(callouts(imported.children)).toHaveLength(0);
        expect(adapter.importDiagnostics.unsupportedCallouts).toBe(1);
      } finally {
        job[Symbol.dispose]();
      }
    },
  );
  test("existing callout commands split and merge canonical own body without moving lists or deleting content", () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("callout-commands");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const id = store.addBlock(
        "myoxus:callout",
        {
          type: "note",
          title: new Text("Title"),
          text: new Text([
            { insert: "First ", attributes: { bold: true } },
            { insert: "second" },
          ]),
        },
        note,
      );
      const list = store.addBlock(
        "myoxus:list",
        { text: new Text("Action") },
        id,
      );
      const std = new BlockStdScope({ store, extensions: testStoreExtensions });
      // Commands use the real store/selection; only the host's focus-scheduling
      // boundary is supplied here. Actual focus is verified in the served editor.
      vi.spyOn(std, "host", "get").mockReturnValue({
        store,
        updateComplete: Promise.resolve(),
      } as unknown as EditorHost);
      std.command.exec(splitCalloutCommand, {
        blockId: id,
        currentBlockId: id,
        inlineIndex: 6,
      });
      const callout = store.getModelById(id)! as CalloutBlockModel;
      expect(callout.text!.toDelta()).toEqual([
        { insert: "First ", attributes: { bold: true } },
      ]);
      expect(callout.children.map((child) => child.flavour)).toEqual([
        "myoxus:paragraph",
        "myoxus:list",
      ]);
      const paragraph = callout.children[0];
      expect(paragraph.text!.toString()).toBe("second");
      std.command.exec(calloutToParagraphCommand, { id: paragraph.id });
      expect(callout.text!.toDelta()).toEqual([
        { insert: "First ", attributes: { bold: true } },
        { insert: "second" },
      ]);
      expect(callout.children.map((child) => child.id)).toEqual([list]);
      callout.text!.replace(0, callout.text!.length, "");
      const first = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("Do not delete") },
        id,
        0,
      );
      std.command.exec(calloutToParagraphCommand, { id: first });
      expect(store.getModelById(first)?.text!.toString()).toBe("Do not delete");
      expect(callout.props.title?.toString()).toBe("Title");
    } finally {
      vi.restoreAllMocks();
      workspace.dispose();
    }
  });
  test("actual HTML reading adapter keeps custom title, own rich body and children", async () => {
    const job = createJob();
    try {
      const provider = getProvider();
      const markdown = new MarkdownAdapter(job, provider);
      const snapshot = await markdown.toBlockSnapshot({
        file: "> [!note] Current & approval\n> **Visible** body.\n>\n> - First action\n\n%%Hidden annotation%%",
      });
      const own = snapshot.children[0].props.text as {
        delta: { insert: string; attributes?: object }[];
      };
      own.delta.push({
        insert: " ",
        attributes: {
          reference: {
            type: "LinkedPage",
            pageId: "target-key",
            title: "Open target",
          },
        },
      });
      const adapter = new HtmlAdapter(job, provider);
      adapter.configs.set("docLinkBaseUrl", "https://example.test/workspace");
      configureMarkdownReferenceMetas(adapter.configs, [
        { id: "target-key", title: "Current target title" },
      ]);
      const html = await adapter.fromBlockSnapshot({
        snapshot: snapshot.children[0],
      });
      const root = document.createElement("div");
      root.innerHTML = html.file;
      expect(root.querySelector("strong")?.textContent).toBe(
        "Current & approval",
      );
      expect(root.querySelector("a")?.textContent).toBe("Open target");
      expect(root.querySelector("a")?.getAttribute("href")).toContain(
        "target-key",
      );
      expect(html.file).toContain("<strong>Visible</strong>");
      expect(html.file).toContain("body.");
      expect(html.file).toContain("First action");
      expect(html.file).not.toContain("Hidden annotation");
    } finally {
      job[Symbol.dispose]();
    }
  });
  test.each(
    fixtures.filter(({ name }) =>
      [
        "empty note",
        "paragraphs and lists",
        "case and CRLF",
        "foldable plus",
        "nested typed callouts",
        "callout inside list with nested list",
        "nested child first preserves order",
        "ordinary quote containing a callout first",
        "unsupported table keeps diagnosis",
        "code stays literal",
        "escaped header stays literal",
      ].includes(name),
    ),
  )("$name", async (fixture) => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const imported = await adapter.toBlockSnapshot({ file: fixture.source });
      const native = callouts(imported.children);
      expect(native).toHaveLength(fixture.native);
      expect(adapter.importDiagnostics.unsupportedCallouts ?? 0).toBe(
        fixture.unsupported,
      );
      if (fixture.native) {
        const complete = await adapter.fromBlockSnapshot({
          snapshot: imported,
        });
        const reimported = await adapter.toBlockSnapshot({
          file: complete.file,
        });
        const second = await adapter.fromBlockSnapshot({
          snapshot: reimported,
        });
        expect(second.file).toBe(complete.file);
        if (fixture.name === "ordinary quote containing a callout first") {
          expect(complete.file).toContain("> > [!note]- Nested");
          expect(complete.file).toContain("> Final outer quote paragraph");
        }
        if (fixture.name === "callout inside list with nested list")
          expect(complete.file).toContain("Outer instruction");
      }
      if (native.length) {
        const kind = fixture.kind ?? "note";
        expect(native[0].props.type).toBe(kind);
        expect(text(native[0].props.title)).toBe(fixture.title);
        expect(native[0].props.foldable).toBe(
          "foldable" in fixture ? fixture.foldable : false,
        );
        expect(native[0].props.defaultOpen).toBe(
          "defaultOpen" in fixture ? fixture.defaultOpen : true,
        );
        expect(native[0].props.icon).toEqual({
          type: "emoji",
          unicode: calloutPresentation(kind).icon,
        });
        expect(native[0].props).not.toHaveProperty("emoji");
        const first = await adapter.fromBlockSnapshot({ snapshot: native[0] });
        const again = await adapter.toBlockSnapshot({ file: first.file });
        const reimported = callouts(again.children);
        expect(reimported).toHaveLength(fixture.native);
        expect(reimported[0].props.type).toBe(kind);
        expect(reimported[0].props.foldable).toBe(native[0].props.foldable);
        expect(reimported[0].props.defaultOpen).toBe(
          native[0].props.defaultOpen,
        );
        expect(text(reimported[0].props.title)).toBe(fixture.title);
        expect(reimported[0].props.text).toEqual(native[0].props.text);
        const second = await adapter.fromBlockSnapshot({
          snapshot: reimported[0],
        });
        expect(second.file).toBe(first.file);
        if (fixture.name === "nested child first preserves order") {
          expect(text(native[0].props.text)).toBe("");
          expect(native[0].children.map((child) => child.flavour)).toEqual([
            "myoxus:callout",
            "myoxus:paragraph",
          ]);
          expect(first.file.indexOf("Inner body")).toBeLessThan(
            first.file.indexOf("Final outer paragraph"),
          );
        }
        if (fixture.name === "paragraphs and lists") {
          expect(text(native[0].props.text)).toBe(
            "Review the changes. Second line.",
          );
          expect(
            (native[0].props.text as { delta: unknown[] }).delta[0],
          ).toEqual({
            insert: "Review",
            attributes: { bold: true },
          });
          expect(native[0].children.map((child) => child.flavour)).toEqual([
            "myoxus:list",
            "myoxus:list",
            "myoxus:paragraph",
          ]);
        }
        expect(
          reimported[0].children.map((child) => ({
            flavour: child.flavour,
            type: child.props.type,
            text: text(child.props.text),
          })),
        ).toEqual(
          native[0].children.map((child) => ({
            flavour: child.flavour,
            type: child.props.type,
            text: text(child.props.text),
          })),
        );
      }
    } finally {
      job[Symbol.dispose]();
    }
  });
  test("recursive callouts reject at the existing codec depth bound before creating a snapshot", async () => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const source = Array.from(
        { length: 100 },
        (_, index) => `${"> ".repeat(index + 1)}[!note] Level ${index}`,
      ).join("\n");
      await expect(adapter.toBlockSnapshot({ file: source })).rejects.toThrow(
        "recursion limit",
      );
    } finally {
      job[Symbol.dispose]();
    }
  });
  test("own rich body and legacy icon do not become an inferred title or type", async () => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const snapshot: BlockSnapshot = {
        type: "block",
        id: "legacy",
        flavour: "myoxus:callout",
        children: [],
        props: {
          icon: { type: "emoji", unicode: "💡" },
          text: {
            "$virgultum:internal:text$": true,
            delta: [{ insert: "note not a title", attributes: { bold: true } }],
          },
        },
      };
      const output = await adapter.fromBlockSnapshot({ snapshot });
      expect(output.file).toContain("**note not a title**");
      const imported = await adapter.toBlockSnapshot({ file: output.file });
      const legacy = callouts(imported.children)[0];
      expect(legacy.props.type).toBeUndefined();
      expect(legacy.props.title).toBeUndefined();
      expect(legacy.props.icon).toEqual(snapshot.props.icon);
      expect(text(legacy.children[0].props.text)).toBe("note not a title");
    } finally {
      job[Symbol.dispose]();
    }
  });
  test("legacy icon-less marker still imports its complete body", async () => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const imported = await adapter.toBlockSnapshot({
        file: "> [!]\n> Existing body\n",
      });
      const legacy = callouts(imported.children)[0];
      expect(legacy).toBeDefined();
      expect(legacy.props.type).toBeUndefined();
      expect(text(legacy.children[0].props.text)).toBe("Existing body");
      expect(adapter.importDiagnostics.unsupportedCallouts ?? 0).toBe(0);
    } finally {
      job[Symbol.dispose]();
    }
  });
});

describe("callout presentation controls", () => {
  test("the registered appearance control can return to soft and undo the change", async () => {
    const { createBuiltinToolbarConfigExtension } =
      await import("../../../../content/src/blocks/callout/configs/toolbar");
    const { ToolbarContext, ToolbarModuleIdentifier } =
      await import("@virgultum/core/services");
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("callout-appearance-control");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const id = store.addBlock("myoxus:callout", {}, note);
      const model = store.getModelById(id)! as CalloutBlockModel;
      const std = new BlockStdScope({
        store,
        extensions: [
          ...testStoreExtensions,
          ...createBuiltinToolbarConfigExtension("myoxus:callout"),
        ],
      });
      const ctx = new ToolbarContext(std);
      vi.spyOn(ctx, "getCurrentModel").mockReturnValue(model);
      const module = std.provider
        .getAll(ToolbarModuleIdentifier)
        .get("myoxus:callout")!;
      const group = module.config.actions.find(
        (action) => action.id === "style",
      )!;
      if (!("actions" in group)) throw new Error("style group missing");
      const action = group.actions.find(
        (action) => action.id === "appearance",
      )!;
      if (!("control" in action) || typeof action.control !== "function")
        throw new Error("appearance control missing");
      for (const value of ["accent", "soft", "outline", "soft"]) {
        const control = action.control(ctx);
        if (control?.type !== "choice")
          throw new Error("appearance choice missing");
        control.change(value);
        expect(model.props.appearance).toBe(value);
      }
      store.undo();
      expect(model.props.appearance).toBe("outline");
      store.redo();
      expect(model.props.appearance).toBe("soft");
    } finally {
      workspace.dispose();
    }
  });

  test("openCalloutIconPicker delegates to EditorChromeHost, updates icon, and releases cleanly on close/reopen", async () => {
    const { openCalloutIconPicker } =
      await import("../../../../content/src/blocks/callout/icon-picker-wrapper");
    const { EditorChromeHostIdentifier } =
      await import("@virgultum/core/services");
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("callout-icon-picker");
    doc.load();
    const store = doc.getStore();
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const id = store.addBlock("myoxus:callout", {}, note);
    const model = store.getBlock(id)?.model as CalloutBlockModel;
    const hostEl = document.createElement("div");
    const anchor = document.createElement("button");
    hostEl.append(anchor);
    document.body.append(hostEl);
    const unmount = vi.fn();
    let mountedControls:
      { onSelect: (icon?: unknown) => void; close: () => void } | undefined;
    const mountIconPicker = vi.fn((_root, controls) => {
      mountedControls = controls;
      return unmount;
    });
    const fakeStd = {
      store,
      host: hostEl,
      getOptional: (id: unknown) =>
        id === EditorChromeHostIdentifier ? { mountIconPicker } : undefined,
    } as unknown as Parameters<typeof openCalloutIconPicker>[0];

    try {
      const onClose = vi.fn();
      const close = openCalloutIconPicker(fakeStd, model, anchor, onClose);
      expect(mountIconPicker).toHaveBeenCalledTimes(1);
      mountedControls?.onSelect({ type: "emoji", unicode: "🚀" });
      expect(model.props.icon).toEqual({ type: "emoji", unicode: "🚀" });
      expect(unmount).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      close?.();

      const close2 = openCalloutIconPicker(fakeStd, model, anchor);
      expect(mountIconPicker).toHaveBeenCalledTimes(2);
      close2?.();
      expect(unmount).toHaveBeenCalledTimes(2);
    } finally {
      hostEl.remove();
      workspace.dispose();
    }
  });
});

test("callout presets insert semantic types and change existing types without losing authored content", async () => {
  const { calloutSlashMenuConfig } =
    await import("../../../../content/src/blocks/callout/configs/slash-menu");
  const { createBuiltinToolbarConfigExtension } =
    await import("../../../../content/src/blocks/callout/configs/toolbar");
  const { ToolbarContext, ToolbarModuleIdentifier } =
    await import("@virgultum/core/services");
  const workspace = new TestWorkspace();
  workspace.storeExtensions = testStoreExtensions;
  workspace.meta.initialize();
  const doc = workspace.createDoc("callout-preset-insertion");
  doc.load();
  const store = doc.getStore();
  try {
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const paragraph = store.addBlock("myoxus:paragraph", {}, note);
    const std = new BlockStdScope({
      store,
      extensions: [
        ...testStoreExtensions,
        ...createBuiltinToolbarConfigExtension("myoxus:callout"),
      ],
    });
    vi.spyOn(std, "host", "get").mockReturnValue({
      store,
      updateComplete: Promise.resolve(),
    } as unknown as EditorHost);
    const items = calloutSlashMenuConfig.items;
    if (typeof items === "function") throw new Error("expected static presets");
    const warning = items.find(
      (item) => item.id === "block-callout-warning-insert",
    );
    if (!warning || !("action" in warning))
      throw new Error("warning preset missing");
    warning.action({ model: store.getModelById(paragraph)!, std });
    await Promise.resolve();
    const model = store
      .getModelById(note)!
      .children.find(
        (child) => child.flavour === "myoxus:callout",
      )! as CalloutBlockModel;
    expect(model.props.type).toBe("warning");
    expect(model.props.icon).toEqual({ type: "emoji", unicode: "⚠️" });
    expect(model.props.backgroundColorName).toBe("yellow");
    const body = model.children[0];
    store.updateBlock(body, { text: new Text("Keep the body") });
    store.updateBlock(model, {
      title: new Text("Keep the title"),
      foldable: true,
      defaultOpen: false,
    });
    const ctx = new ToolbarContext(std);
    vi.spyOn(ctx, "getCurrentModel").mockReturnValue(model);
    const group = std.provider
      .getAll(ToolbarModuleIdentifier)
      .get("myoxus:callout")!
      .config.actions.find((action) => action.id === "style")!;
    if (!("actions" in group)) throw new Error("style group missing");
    const action = group.actions.find(
      (action) => action.id === "callout-type",
    )!;
    if (!("control" in action) || typeof action.control !== "function")
      throw new Error("type control missing");
    const control = action.control(ctx);
    if (control?.type !== "choice") throw new Error("type choice missing");
    control.change("tip");
    expect(model.props.type).toBe("tip");
    expect(model.props.icon).toEqual({ type: "emoji", unicode: "💡" });
    expect(model.props.backgroundColorName).toBe("green");
    expect(model.props.title?.toString()).toBe("Keep the title");
    expect(model.children[0]).toBe(body);
    expect(body.text?.toString()).toBe("Keep the body");
    expect([model.props.foldable, model.props.defaultOpen]).toEqual([
      true,
      false,
    ]);
    store.undo();
    expect(model.props.type).toBe("warning");
  } finally {
    workspace.dispose();
  }
});
