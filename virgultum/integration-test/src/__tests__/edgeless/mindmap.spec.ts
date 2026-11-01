// SPDX-License-Identifier: MIT
import "../../../../../client/branding/theme-fallback.css";
import {
  applyMermaidVisualModelCommand,
  getMermaidBlockSource,
  getMermaidGfxNode,
  getMermaidVisualModel,
  insertMermaidEdgelessDiagramCommand,
  MindmapLayoutType,
  prepareMermaidFamilySource,
  projectMindmapTree,
  readMindmapProjectionModel,
  readMindmapProjectionOptions,
} from "@virgultum/editor/blocks/mermaid";
import type { MermaidBlockModel } from "@virgultum/model";
import { beforeEach, describe, expect, test } from "vitest";
import { createMindmapCommandConsumer } from "../../../../editor/blocks/mermaid/src/families/mindmap/host-adapter.js";
import { MERMAID_GFX_TITLE_ROLE } from "../../../../editor/blocks/mermaid/src/families/runtime/gfx-element-roles.js";
import { wait } from "../utils/common.js";
import { setupEditor } from "../utils/setup.js";

const SOURCE = "mindmap\nroot\n  leaf1\n  leaf2\n  leaf3\n    leaf4\n";

describe("Source-owned mindmap", () => {
  let owner: MermaidBlockModel;
  const visual = () => getMermaidVisualModel(owner)!;
  const source = () => getMermaidBlockSource(owner.props);
  const tree = () => readMindmapProjectionModel(source(), visual())!;
  const apply = (
    next: ReturnType<typeof visual>,
    sourceWrite = { baseSource: source(), source: source() },
  ) => {
    const [applied] = editor.host!.std.command.exec(
      applyMermaidVisualModelCommand,
      {
        model: owner,
        visualModel: next,
        sourceWrite,
      },
    );
    return { applied };
  };
  const command = () =>
    createMindmapCommandConsumer({
      getSource: source,
      getReadonly: () => doc.readonly,
      getVisualModel: visual,
      applyVisualModel: (next, options) => apply(next, options?.sourceWrite),
      selectAfterProjection: () => {},
      selectEmpty: () => {},
    });
  const key = (label: string) =>
    tree().nodes.find((node) => node.label === label)!.sourceKey;
  // The owner retains its independent Source title when all Mindmap nodes are
  // deleted. Content counts still include every other (including dangling) ID.
  const contentChildIds = () =>
    owner.childIds.filter(
      (id) =>
        owner.surface?.getElementById(id)?.yMap.get("mermaidRole") !==
        MERMAID_GFX_TITLE_ROLE,
    );

  beforeEach(async () => {
    const cleanup = await setupEditor("edgeless");
    await prepareMermaidFamilySource(SOURCE);
    const [ok, ctx] = editor.host!.std.command.exec(
      insertMermaidEdgelessDiagramCommand,
      { source: SOURCE },
    );
    expect(ok).toBe(true);
    owner = doc.getBlock(ctx.insertedMermaidDiagram!.blockId)!
      .model as MermaidBlockModel;
    const model = tree();
    expect(
      apply(projectMindmapTree(model, { layout: MindmapLayoutType.RIGHT }))
        .applied,
    ).toBe(true);
    await wait();
    doc.resetHistory();
    return cleanup;
  });

  test("root deletion retains the empty owner; subtree deletion and undo retain all Source bindings", async () => {
    const initial = source(),
      keys = tree().nodes.map((node) => node.sourceKey);
    expect(
      command()({ type: "delete", keys: [key("root")] }, initial).changed,
    ).toBe(true);
    expect(doc.getBlock(owner.id)?.model).toBe(owner);
    expect(tree().nodes).toHaveLength(0);
    expect(contentChildIds()).toHaveLength(0);
    doc.undo();
    await wait();
    expect(source()).toBe(initial);
    expect(tree().nodes.map((node) => node.sourceKey)).toEqual(keys);
    expect(
      command()({ type: "delete", keys: [key("leaf3")] }, source()).changed,
    ).toBe(true);
    expect(tree().nodes.map((node) => node.label)).toEqual([
      "root",
      "leaf1",
      "leaf2",
    ]);
    expect(contentChildIds()).toHaveLength(5); // Three nodes and their two connectors, not the independent title.
    doc.undo();
    await wait();
    expect(source()).toBe(initial);
    expect(tree().nodes.map((node) => node.sourceKey)).toEqual(keys);
  });

  test("creation lays out real owned child shapes automatically", () => {
    const shape = (label: string) => getMermaidGfxNode(doc, owner, key(label))!;
    const root = shape("root"),
      children = ["leaf1", "leaf2", "leaf3"].map(shape);
    children.forEach((child) =>
      expect(child.x).toBeGreaterThan(root.x + root.w),
    );
    expect(children[1].y).toBeGreaterThan(children[0].y + children[0].h);
    expect(children[2].y).toBeGreaterThan(children[1].y + children[1].h);
    expect(shape("leaf4").x).toBeGreaterThan(children[2].x + children[2].w);
  });

  test("cyclic reparent is rejected without losing Source nodes or children", () => {
    const initial = source(),
      children = [...owner.childIds];
    const result = command()(
      { type: "move", key: key("leaf3"), parentKey: key("leaf4") },
      initial,
    );
    expect(result.changed).toBe(false);
    expect(result.diagnostic).toBeTruthy();
    expect(source()).toBe(initial);
    expect(owner.childIds).toEqual(children);
    expect(tree().nodes).toHaveLength(5);
  });

  test("collapse preserves hidden Source records and restores projection through undo", async () => {
    const initial = source(),
      model = tree(),
      keys = model.nodes.map((node) => node.sourceKey);
    const branch = key("leaf3"),
      leaf = key("leaf4");
    expect(
      apply(
        projectMindmapTree(model, {
          ...readMindmapProjectionOptions(visual()),
          collapsed: new Set([branch]),
        }),
      ).applied,
    ).toBe(true);
    expect(source()).toBe(initial);
    expect(tree().nodes.map((node) => node.sourceKey)).toEqual(keys);
    expect(getMermaidGfxNode(doc, owner, branch)).toBeDefined();
    expect(getMermaidGfxNode(doc, owner, leaf)).toBeUndefined();
    doc.undo();
    await wait();
    expect(readMindmapProjectionOptions(visual()).collapsed?.size ?? 0).toBe(0);
    expect(getMermaidGfxNode(doc, owner, leaf)).toBeDefined();
    doc.redo();
    await wait();
    expect(source()).toBe(initial);
    expect(readMindmapProjectionOptions(visual()).collapsed?.has(branch)).toBe(
      true,
    );
    expect(getMermaidGfxNode(doc, owner, leaf)).toBeUndefined();
  });
});
