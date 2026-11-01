// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { parseMermaidGanttSource } from "../../../engine/gantt/parser.js";
import {
  ganttTaskDeleteImpact,
  type GanttCommand,
} from "../../../engine/gantt/commands/index.js";
import {
  ganttDiagnosticMessage,
  ganttDiagnosticText,
  mermaidGanttFamily,
} from "../family.js";
import { mermaidGanttRuntime } from "../runtime.js";
import { applyMermaidGanttFamilySourceCommand } from "../source-application.js";

const SOURCE =
  "gantt\n  title Build Plan\n  dateFormat YYYY-MM-DD\n  section Work\n  Design : a1, 2026-01-01, 3d\n  Build : b1, after a1, 5d\n";

function run(
  build: (
    model: NonNullable<ReturnType<typeof parseMermaidGanttSource>>,
  ) => GanttCommand | readonly GanttCommand[],
  source = SOURCE,
) {
  const model = parseMermaidGanttSource(source);
  if (!model) throw new Error("fixture must parse");
  return applyMermaidGanttFamilySourceCommand({
    command: build(model),
    model,
    readonly: false,
    source,
  });
}

describe("mermaid gantt family", () => {
  test("declares its own inventory and parses through the engine", () => {
    expect(mermaidGanttFamily.id).toBe("gantt");
    expect(mermaidGanttRuntime.diagramTypes).toEqual(["gantt"]);
    const parsed = mermaidGanttFamily.parseSource(SOURCE, "gantt");
    expect(parsed.model?.diagramType).toBe("gantt");
    expect(parsed.diagnostics).toEqual([]);
  });

  test("routes a visual batch with source-backed creation defaults", () => {
    const result = run((model) => [
      { title: "Delivery", type: "section.add" },
      {
        label: "Rollout",
        sectionId: model.sections[0].id,
        start: "2026-02-02",
        type: "task.add",
      },
      {
        label: "Design doc",
        taskId: model.tasks[0].recordId,
        type: "task.rename",
      },
    ]);
    expect(result.changed).toBe(true);
    expect(result.source).toBe(
      `${SOURCE.replace("  Design :", "  Design doc :")}  Rollout : 2026-02-02, 1d\n  section Delivery\n`,
    );
  });

  test("reports delete impact before mutating dependents", () => {
    const model = parseMermaidGanttSource(SOURCE);
    if (!model) throw new Error("fixture must parse");
    const impact = ganttTaskDeleteImpact(model, model.tasks[0].recordId);
    expect(impact.dependents).toHaveLength(1);
    const unresolvable = run((current) => ({
      strategy: "remove-dependencies" as const,
      taskId: current.tasks[0].recordId,
      type: "task.delete",
    }));
    expect(unresolvable.changed).toBe(false);
    expect(unresolvable.source).toBe(SOURCE);
    const deleted = run((current) => ({
      strategy: "materialize-dates" as const,
      taskId: current.tasks[0].recordId,
      type: "task.delete",
    }));
    expect(deleted.changed).toBe(true);
    expect(deleted.source).toContain("Build : b1, 2026-01-04, 5d");
    expect(deleted.source).not.toContain("Design");
  });

  test("renders local diagnostics with their concrete detail, never a raw token", () => {
    const model = parseMermaidGanttSource(
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Broken : brk, not-a-date, 3d\n",
    );
    if (!model) throw new Error("fixture must parse");
    const invalidDate = model.diagnostics.find(
      (diagnostic) => diagnostic.code === "invalid-date",
    );
    expect(invalidDate?.detail).toBe("not-a-date");
    expect(ganttDiagnosticText(invalidDate!)).toContain("not-a-date");
    expect(ganttDiagnosticText(invalidDate!)).not.toContain("{value}");
    expect(ganttDiagnosticMessage(invalidDate!)).toContain("not-a-date");
  });

  test("refuses whole-model source rewriting", () => {
    const model = parseMermaidGanttSource(SOURCE);
    if (!model) throw new Error("fixture must parse");
    const applied = mermaidGanttFamily.applyVisualToSource(model, SOURCE);
    expect(applied.source).toBe(SOURCE);
    expect(applied.diagnostics[0]?.code).toBe("gantt.command-required");
  });
});
