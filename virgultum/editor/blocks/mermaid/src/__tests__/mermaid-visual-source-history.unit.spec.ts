import { describe, expect, test } from "vitest";

import type { MermaidVisualHistoryEntry } from "../mermaid-block-constants.js";
import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import {
  getMermaidVisualHistoryStacks,
  pushMermaidVisualHistory,
  pushMermaidVisualHistoryForOwner,
  takeMermaidVisualRedoEntry,
  takeMermaidVisualUndoEntry,
} from "../mermaid-visual-source-history.js";

function model(x: number, label = "Start"): MermaidVisualModel {
  return {
    diagramType: "flowchart",
    direction: "TD",
    edges: [],
    nodes: [
      {
        height: 72,
        id: "A",
        label,
        shape: "rect",
        width: 160,
        x,
        y: 20,
      },
    ],
    version: 1,
  };
}

describe("Mermaid visual history", () => {
  test("stores only complete visual snapshots and coalesces one gesture", () => {
    const undoStack: MermaidVisualHistoryEntry[] = [];
    const redoStack: MermaidVisualHistoryEntry[] = [
      { after: model(900), before: model(800) },
    ];

    expect(
      pushMermaidVisualHistory({
        after: model(40),
        before: model(20),
        coalesceKey: "node:A",
        redoStack,
        undoSourceHash: "after-40",
        undoStack,
      }),
    ).toBe(true);
    expect(
      pushMermaidVisualHistory({
        after: model(80, "Done"),
        before: model(40),
        coalesceKey: "node:A",
        redoStack,
        undoSourceHash: "after-80",
        undoStack,
      }),
    ).toBe(true);

    expect(undoStack).toEqual([
      {
        after: model(80, "Done"),
        before: model(20),
        coalesceKey: "node:A",
        undoSourceHash: "after-80",
      },
    ]);
    expect(redoStack).toEqual([]);
    expect(Object.keys(undoStack[0] ?? {})).not.toContain("source");
  });

  test("does not record a complete-model no-op", () => {
    const undoStack: MermaidVisualHistoryEntry[] = [];
    expect(
      pushMermaidVisualHistory({
        after: model(20),
        before: model(20),
        redoStack: [],
        undoStack,
      }),
    ).toBe(false);
    expect(undoStack).toEqual([]);
  });

  test("replays only the top snapshot matching the current semantic model", () => {
    const entry: MermaidVisualHistoryEntry = {
      after: model(80, "Done"),
      before: model(20),
      undoSourceHash: "grouped-source",
    };
    const undoStack: MermaidVisualHistoryEntry[] = [entry];
    const redoStack: MermaidVisualHistoryEntry[] = [];

    expect(
      takeMermaidVisualUndoEntry({
        current: model(80),
        currentSourceHash: "stale-source",
        undoStack,
      }),
    ).toBeNull();
    expect(undoStack).toHaveLength(1);

    const reprojected = model(120, "Done");
    reprojected.familyData = {
      family: "flowchart",
      payload: { comments: [], syntax: "flowchart" },
      version: 1,
    };
    reprojected.sourcePreamble = ['title: "Flowchart"'];
    reprojected.styleStatements = [];
    reprojected.subgraphs = [];
    expect(
      takeMermaidVisualUndoEntry({
        current: reprojected,
        currentSourceHash: "grouped-source",
        undoStack,
      }),
    ).toEqual(entry);
    redoStack.push(entry);
    entry.redoSourceHash = "canonical-before";
    expect(
      takeMermaidVisualRedoEntry({
        current: model(60, "projection differs"),
        currentSourceHash: "stale-source",
        redoStack,
      }),
    ).toBeNull();
    expect(
      takeMermaidVisualRedoEntry({
        current: model(60, "projection differs"),
        currentSourceHash: "canonical-before",
        redoStack,
      }),
    ).toEqual(entry);
  });

  test("keeps session-local stacks isolated per Mermaid owner", () => {
    const owner = {};
    const otherOwner = {};
    expect(
      pushMermaidVisualHistoryForOwner({
        after: model(40),
        before: model(20),
        owner,
      }),
    ).toBe(true);
    expect(getMermaidVisualHistoryStacks(owner).undoStack).toHaveLength(1);
    expect(getMermaidVisualHistoryStacks(otherOwner).undoStack).toEqual([]);
  });

  test("keeps one block history across model wrapper remounts", () => {
    const yBlock = {};
    const owner = { id: "mermaid-1", store: { doc: {} }, yBlock };
    const remountedOwner = { id: "mermaid-1", store: { doc: {} }, yBlock };
    const otherBlock = { id: "mermaid-2", store: { doc: {} }, yBlock: {} };

    getMermaidVisualHistoryStacks(owner).undoStack.push({
      after: model(40),
      before: model(20),
    });

    expect(
      getMermaidVisualHistoryStacks(remountedOwner).undoStack,
    ).toHaveLength(1);
    expect(getMermaidVisualHistoryStacks(otherBlock).undoStack).toEqual([]);
  });
});
