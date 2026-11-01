import { describe, expect, test } from "vitest";

import type { MermaidVisualModel } from "../gfx-model.js";
import { getMermaidVisualHistoryStacks } from "../../../mermaid-visual-source-history.js";
import { hashMermaidSource } from "../../../utils.js";
import { resolveMermaidFamilyRuntime } from "../registry.js";
import {
  beginMermaidRuntimeTransaction,
  commitMermaidRuntimeTransaction,
} from "../transaction.js";

describe("Mermaid family runtime", () => {
  test("routes Timeline to the temporal source model instead of a stale GFX frame", () => {
    const staleFrame: MermaidVisualModel = {
      diagramType: "flowchart",
      direction: "TD",
      edges: [],
      nodes: [
        {
          height: 72,
          id: "stale",
          label: "Stale",
          shape: "rect",
          width: 160,
          x: 0,
          y: 0,
        },
      ],
      version: 1,
    };
    const source =
      "timeline\n  title Release\n  2026-08-12 : Runtime cutover\n";
    const resolution = resolveMermaidFamilyRuntime(source, staleFrame);

    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.diagramType).toBe("timeline");
    expect(resolution.capabilities.kind).toBe("structured");
    expect(resolution.gfxVisualModel).toBeUndefined();
  });

  test("routes representable Kanban through its opaque capability", () => {
    const source = "kanban\n  todo[To Do]\n    task[Task]\n";
    const resolution = resolveMermaidFamilyRuntime(source);
    expect(resolution).toMatchObject({
      capabilities: { kind: "structured" },
      diagramType: "kanban",
      kind: "resolved",
      source,
    });
    expect("kanbanModel" in resolution).toBe(false);
    expect("sourceWriter" in resolution).toBe(false);
  });

  test("routes specialized Journey and Packet editors through the Core Facade", () => {
    expect(
      resolveMermaidFamilyRuntime(
        "journey\n  section Start\n    Open workspace: 5: User\n",
      ),
    ).toMatchObject({ capabilities: { kind: "structured" }, kind: "resolved" });
    expect(
      resolveMermaidFamilyRuntime('packet\n  0-7: "Version"\n'),
    ).toMatchObject({ capabilities: { kind: "structured" }, kind: "resolved" });
    expect(
      resolveMermaidFamilyRuntime('gitGraph\n  commit id:"Initial"\n'),
    ).toMatchObject({
      diagramType: "gitGraph",
      capabilities: { kind: "gfx" },
      kind: "resolved",
    });
  });

  test("keeps unsupported source byte-stable and exposes no writer", () => {
    const source = "info\n  showInfo\n";
    expect(resolveMermaidFamilyRuntime(source)).toMatchObject({
      kind: "source-first",
      runtime: null,
      source,
    });

    const kanban = "kanban\n  todo[To Do]\n    task[Task]\n  [Unclosed\n";
    const resolution = resolveMermaidFamilyRuntime(kanban);
    expect(resolution).toMatchObject({
      diagramType: "kanban",
      kind: "resolved",
      source: kanban,
      structuredModel: { ambiguous: true, cards: [], columns: [] },
    });
    expect("sourceWriter" in resolution).toBe(false);

    // Gantt no longer degrades to source-first for a non-default dateFormat or
    // a working calendar: both are part of the supported source contract.
    for (const ganttSource of [
      "gantt\n  dateFormat DD-MM-YYYY\n  section Work\n  Ship :s1, 12-08-2026, 1d\n",
      "gantt\n  excludes weekends\n  section Work\n  Ship :s1, 2026-08-12, 1d\n",
    ]) {
      const ganttResolution = resolveMermaidFamilyRuntime(ganttSource);
      expect(ganttResolution).toMatchObject({
        diagramType: "gantt",
        kind: "resolved",
        source: ganttSource,
      });
    }
    const timelineResolution = resolveMermaidFamilyRuntime(
      "timeline\n  accTitle: Release history\n  2026 : Launch\n",
    );
    expect(timelineResolution).toMatchObject({
      kind: "resolved",
      source: "timeline\n  accTitle: Release history\n  2026 : Launch\n",
    });
  });

  test("commits one source transition and one history entry", () => {
    const owner = {};
    const beforeVisualModel: MermaidVisualModel = {
      diagramType: "flowchart",
      direction: "TD",
      edges: [],
      nodes: [],
      version: 1,
    };
    const afterVisualModel: MermaidVisualModel = {
      ...beforeVisualModel,
      nodes: [
        {
          height: 72,
          id: "A",
          label: "Start",
          shape: "rect",
          width: 160,
          x: 20,
          y: 20,
        },
      ],
    };
    const transaction = beginMermaidRuntimeTransaction({
      currentSource: "flowchart TD\n  A[Start]\n",
      currentVisualModel: beforeVisualModel,
      readonly: false,
    });
    expect(transaction).not.toBeNull();
    if (!transaction) return;

    const commit = commitMermaidRuntimeTransaction({
      applied: true,
      currentSource: "flowchart TD\n  A[Start]\n  A --> B[Done]\n",
      currentVisualModel: afterVisualModel,
      owner,
      transaction,
    });
    expect(commit?.historyAdded).toBe(true);
    const history = getMermaidVisualHistoryStacks(owner);
    expect(history.undoStack).toHaveLength(1);
    expect(history.undoStack[0]?.undoSourceHash).toBe(
      hashMermaidSource(commit?.after ?? ""),
    );

    expect(
      commitMermaidRuntimeTransaction({
        applied: false,
        currentSource: commit?.after ?? "",
        owner,
        transaction,
      }),
    ).toBeNull();
    expect(history.undoStack).toHaveLength(1);
  });

  test("blocks transactions in readonly state", () => {
    expect(
      beginMermaidRuntimeTransaction({
        currentSource: "flowchart TD\n",
        readonly: true,
      }),
    ).toBeNull();
  });
});
