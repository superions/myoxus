// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
import type { MermaidBlockModel } from "@virgultum/editor/model";
import { beforeEach, describe, expect, test } from "vitest";

import {
  createMindmapCommandConsumer,
  MERMAID_GFX_TITLE_ROLE,
} from "../../../../editor/all/src/test-support/mermaid.js";
import { flushFrame } from "../../harness/pointer.js";
import { mountTestSession } from "../../harness/session.js";

const MINDMAP_SOURCE = "mindmap\nroot\n  leaf1\n  leaf2\n  leaf3\n    leaf4\n";

describe("Source-owned Mermaid mindmap invariants", () => {
  let owner!: MermaidBlockModel;

  const readVisual = () => getMermaidVisualModel(owner)!;
  const readSource = () => getMermaidBlockSource(owner.props);
  const readTree = () =>
    readMindmapProjectionModel(readSource(), readVisual())!;

  const applyProjection = (
    next: ReturnType<typeof readVisual>,
    sourceWrite = { baseSource: readSource(), source: readSource() },
  ) => {
    const [applied] = editor.host!.std.command.exec(
      applyMermaidVisualModelCommand,
      { model: owner, visualModel: next, sourceWrite },
    );
    return { applied };
  };

  const runCommand = () =>
    createMindmapCommandConsumer({
      getSource: readSource,
      getReadonly: () => doc.readonly,
      getVisualModel: readVisual,
      applyVisualModel: (next, opts) =>
        applyProjection(next, opts?.sourceWrite),
      selectAfterProjection: () => {},
      selectEmpty: () => {},
    });

  const nodeKey = (label: string) =>
    readTree().nodes.find((n) => n.label === label)!.sourceKey;

  const nonTitleChildIds = () =>
    owner.childIds.filter(
      (id) =>
        owner.surface?.getElementById(id)?.yMap.get("mermaidRole") !==
        MERMAID_GFX_TITLE_ROLE,
    );

  beforeEach(async () => {
    const dispose = await mountTestSession("edgeless");
    await prepareMermaidFamilySource(MINDMAP_SOURCE);
    const [ok, ctx] = editor.host!.std.command.exec(
      insertMermaidEdgelessDiagramCommand,
      { source: MINDMAP_SOURCE },
    );
    expect(ok).toBe(true);
    owner = doc.getBlock(ctx.insertedMermaidDiagram!.blockId)!
      .model as MermaidBlockModel;

    const projected = projectMindmapTree(readTree(), {
      layout: MindmapLayoutType.RIGHT,
    });
    expect(applyProjection(projected).applied).toBe(true);
    await flushFrame();
    doc.resetHistory();
    return dispose;
  });

  test("retains owner on root delete and restores bindings across subtree delete + undo", async () => {
    const baselineSource = readSource();
    const baselineKeys = readTree().nodes.map((n) => n.sourceKey);

    expect(
      runCommand()({ type: "delete", keys: [nodeKey("root")] }, baselineSource)
        .changed,
    ).toBe(true);
    expect(doc.getBlock(owner.id)?.model).toBe(owner);
    expect(readTree().nodes).toHaveLength(0);
    expect(nonTitleChildIds()).toHaveLength(0);

    doc.undo();
    await flushFrame();
    expect(readSource()).toBe(baselineSource);
    expect(readTree().nodes.map((n) => n.sourceKey)).toEqual(baselineKeys);

    expect(
      runCommand()({ type: "delete", keys: [nodeKey("leaf3")] }, readSource())
        .changed,
    ).toBe(true);
    expect(readTree().nodes.map((n) => n.label)).toEqual([
      "root",
      "leaf1",
      "leaf2",
    ]);
    // Three remaining nodes + two connectors (excluding standalone title element).
    expect(nonTitleChildIds()).toHaveLength(5);

    doc.undo();
    await flushFrame();
    expect(readSource()).toBe(baselineSource);
    expect(readTree().nodes.map((n) => n.sourceKey)).toEqual(baselineKeys);
  });

  test("positions projected child shapes automatically to the right of their parents", () => {
    const shapeFor = (label: string) =>
      getMermaidGfxNode(doc, owner, nodeKey(label))!;
    const rootShape = shapeFor("root");
    const firstLevel = ["leaf1", "leaf2", "leaf3"].map(shapeFor);

    for (const child of firstLevel) {
      expect(child.x).toBeGreaterThan(rootShape.x + rootShape.w);
    }
    expect(firstLevel[1].y).toBeGreaterThan(firstLevel[0].y + firstLevel[0].h);
    expect(firstLevel[2].y).toBeGreaterThan(firstLevel[1].y + firstLevel[1].h);
    expect(shapeFor("leaf4").x).toBeGreaterThan(
      firstLevel[2].x + firstLevel[2].w,
    );
  });

  test("rejects cyclic reparenting while keeping Source and owned children intact", () => {
    const baselineSource = readSource();
    const baselineChildren = [...owner.childIds];
    const outcome = runCommand()(
      { type: "move", key: nodeKey("leaf3"), parentKey: nodeKey("leaf4") },
      baselineSource,
    );

    expect(outcome.changed).toBe(false);
    expect(outcome.diagnostic).toBeDefined();
    expect(readSource()).toBe(baselineSource);
    expect(owner.childIds).toEqual(baselineChildren);
    expect(readTree().nodes).toHaveLength(5);
  });

  test("preserves hidden Source records across collapse, undo, and redo", async () => {
    const baselineSource = readSource();
    const baselineKeys = readTree().nodes.map((n) => n.sourceKey);
    const branchKey = nodeKey("leaf3");
    const leafKey = nodeKey("leaf4");

    expect(
      applyProjection(
        projectMindmapTree(readTree(), {
          ...readMindmapProjectionOptions(readVisual()),
          collapsed: new Set([branchKey]),
        }),
      ).applied,
    ).toBe(true);

    expect(readSource()).toBe(baselineSource);
    expect(readTree().nodes.map((n) => n.sourceKey)).toEqual(baselineKeys);
    expect(getMermaidGfxNode(doc, owner, branchKey)).toBeDefined();
    expect(getMermaidGfxNode(doc, owner, leafKey)).toBeUndefined();

    doc.undo();
    await flushFrame();
    expect(
      readMindmapProjectionOptions(readVisual()).collapsed?.size ?? 0,
    ).toBe(0);
    expect(getMermaidGfxNode(doc, owner, leafKey)).toBeDefined();

    doc.redo();
    await flushFrame();
    expect(readSource()).toBe(baselineSource);
    expect(
      readMindmapProjectionOptions(readVisual()).collapsed?.has(branchKey),
    ).toBe(true);
    expect(getMermaidGfxNode(doc, owner, leafKey)).toBeUndefined();
  });
});
