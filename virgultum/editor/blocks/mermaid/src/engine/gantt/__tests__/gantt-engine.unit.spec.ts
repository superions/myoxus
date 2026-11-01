// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { applyGanttCommand, applyGanttCommands } from "../commands/index.js";
import { parseMermaidGanttSource } from "../parser.js";

const SOURCE = `gantt
  title Build Plan
  dateFormat YYYY-MM-DD
  excludes weekends

  section Work
  %% design note
  Design : des1, 2026-01-01, 3d
  Build : bld, after des1, 5d
  Review : rev, milestone, after bld, 0d
`;

function parse(source: string = SOURCE) {
  const model = parseMermaidGanttSource(source);
  if (!model) throw new Error("expected a gantt model");
  return model;
}

describe("gantt task statement round-trips every schedule field", () => {
  it("keeps a coexisting until reference through a status-only rewrite", () => {
    // `after` and `until` are independent fields; a status edit reused the
    // single-clause writer and silently dropped the `until p1` end.
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Plan : p1, 2026-01-01, 5d\n  Ship : s1, after p1, until p1\n",
    );
    const ship = model.tasks.find((task) => task.id === "s1")!;
    const result = applyGanttCommand({
      command: {
        statuses: ["done"],
        taskId: ship.recordId,
        type: "task.set-statuses",
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    expect(result.source).toContain("Ship : done, s1, after p1, until p1");
    expect(result.source).not.toContain("Ship : done, s1, after p1\n");
  });
});

describe("gantt schedule command preserves an independent until end", () => {
  const SOURCE =
    "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Guard : g1, 2026-01-02, 1d\n  Plan : p1, 2026-01-05, 5d\n  Later : l1, 2026-01-20, 2d\n  Ship : s1, after p1, until l1\n";

  it("keeps a preserved until while re-owning the after start", () => {
    const model = parse(SOURCE);
    const ship = model.tasks.find((task) => task.id === "s1")!;
    // Adding a second `after` reference must not drop the independent `until`
    // end bound, and an until-bound end carries no free duration.
    const result = applyGanttCommand({
      command: {
        afterIds: ["p1", "g1"],
        duration: "6d",
        end: "",
        mode: "after",
        start: "",
        taskId: ship.recordId,
        type: "schedule.set",
        untilIds: ["l1"],
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    expect(result.source).toContain("Ship : s1, after p1 g1, until l1");
    expect(result.source).not.toContain("6d");
  });

  it("keeps the after start when until mode owns the end", () => {
    const model = parse(
      `${SOURCE.replace("\n", "\n  Last : l2, 2026-01-25, 1d\n")}`,
    );
    const ship = model.tasks.find((task) => task.id === "s1")!;
    const result = applyGanttCommand({
      command: {
        afterIds: ["p1"],
        duration: "",
        end: "",
        mode: "until",
        start: "",
        taskId: ship.recordId,
        type: "schedule.set",
        untilIds: ["l1", "l2"],
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    // The `after` start survives an until-end edit.
    expect(result.source).toContain("Ship : s1, after p1, until l1 l2");
  });

  it("drops the until when an end-owning mode replaces it", () => {
    const model = parse(SOURCE);
    const ship = model.tasks.find((task) => task.id === "s1")!;
    const result = applyGanttCommand({
      command: {
        afterIds: [],
        duration: "",
        end: "2026-01-15",
        mode: "explicit-range",
        start: "2026-01-10",
        taskId: ship.recordId,
        type: "schedule.set",
        untilIds: [],
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    expect(result.source).toContain("Ship : s1, 2026-01-10, 2026-01-15");
    expect(result.source).not.toContain("until l1");
  });
});

describe("gantt source document", () => {
  it("keeps untouched trivia byte-stable across a minimal label patch", () => {
    const model = parse();
    const design = model.tasks.find((task) => task.id === "des1")!;
    const result = applyGanttCommand({
      command: {
        label: "Design v2",
        taskId: design.recordId,
        type: "task.rename",
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    expect(result.source).toBe(SOURCE.replace("  Design :", "  Design v2 :"));
  });

  it("renames a task id atomically across after, until and click references", () => {
    const source = `${SOURCE}  Deploy : dep, after bld, 2d\n  Guard : grd, 2025-12-30, until des1\n  click des1 notify "done"\n`;
    const model = parse(source);
    const design = model.tasks.find((task) => task.id === "des1")!;
    const result = applyGanttCommand({
      command: {
        newId: "design",
        taskId: design.recordId,
        type: "task.rename-id",
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    expect(result.source).toBe(source.replaceAll("des1", "design"));
  });

  it("resolves after references with weekend exclusions", () => {
    const model = parse();
    const build = model.tasks.find((task) => task.id === "bld")!;
    // Design starts Thursday 2026-01-01 and runs three working days, so the
    // weekend widens the resolved interval without rewriting the source.
    expect(build.scheduleKind).toBe("after");
    expect(build.afterIds).toEqual(["des1"]);
    expect(model.calendar.excludes).toEqual(["weekends"]);
    expect(model.diagnostics).toEqual([]);
    expect(model.intervals[build.recordId]).toEqual({
      start: Date.UTC(2026, 0, 6),
      end: Date.UTC(2026, 0, 13),
    });
  });

  it("projects local diagnostics without disabling the whole editor", () => {
    const sources = [
      `${SOURCE}  Broken : brk, not-a-date, 3d\n`,
      ...["09:99:00.123", "09:30:99.123", "24:00:00.123"].flatMap((time) =>
        ["start", "end"].map((edge) =>
          [
            "gantt",
            "  dateFormat DD/MM/YYYY HH:mm:ss.SSS",
            "  section Work",
            "  Good : good, 01/01/2026 08:00:00.123, 1h",
            `  Broken : brk, 01/01/2026 ${edge === "start" ? time : "08:00:00.123"}, 01/01/2026 ${edge === "end" ? time : "10:00:00.123"}`,
          ].join("\n"),
        ),
      ),
    ];
    for (const source of sources) {
      const model = parse(source);
      const broken = model.tasks.find((task) => task.id === "brk")!;
      const diagnostic = model.diagnostics.filter(
        (item) =>
          item.code === "invalid-date" && item.statementId === broken.recordId,
      );
      expect(diagnostic).toHaveLength(1);
      expect(broken.diagnostics).toEqual(diagnostic);
      expect(diagnostic[0].range).toEqual(
        model.sourceDocument.statements.find(
          (item) => item.id === broken.recordId,
        )!.range,
      );
      expect(model.intervals[model.tasks[0].recordId]).toBeDefined();
      expect(model.intervals[broken.recordId]).toBeUndefined();
      expect(model.ambiguous).toBe(false);
      expect(model.sourceDocument.source).toBe(source);
    }
    const ambiguous = parse(
      "gantt\ngantt\n  section Work\n  Good : good, 2026-01-01, 1d",
    );
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.diagnostics).toHaveLength(1);
    expect(ambiguous.diagnostics[0]).toMatchObject({
      code: "ambiguous-source",
      range: { line: 2 },
    });
    expect(ambiguous.diagnostics[0].statementId).toBe(
      ambiguous.sourceDocument.statements[1].id,
    );
  });

  it("keeps Previous source time forms when removing the last after reference", () => {
    const model = parse();
    const build = model.tasks.find((task) => task.id === "bld")!;
    const result = applyGanttCommand({
      command: {
        kind: "after",
        referenceId: "des1",
        taskRecordId: build.recordId,
        type: "dependency.delete",
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    expect(result.source).toBe(SOURCE.replace("after des1, ", ""));
  });

  it("keeps bare option statements editable and effective", () => {
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD\n  inclusiveEndDates\n  section Work\n  Design : des1, 2026-01-01, 3d\n",
    );
    expect(model.diagnostics).toEqual([]);
    expect(model.calendar.inclusiveEndDates).toBe(true);
    expect(model.sourceDocument.source).toContain("  inclusiveEndDates\n");
  });

  it("resolves after-start with until-end from both source forms", () => {
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Plan : p1, 2026-01-01, 5d\n  Guard : g1, 2026-01-02, 1d\n  Later : l1, 2026-01-08, 2d\n  Ship : s1, after g1, until l1\n",
    );
    const ship = model.tasks.find((task) => task.id === "s1")!;
    expect(ship.afterIds).toEqual(["g1"]);
    expect(ship.untilIds).toEqual(["l1"]);
    expect(model.diagnostics).toEqual([]);
    // `after` fixes the start at the latest dependency end and `until` the end
    // at the earliest referenced start; neither form is rewritten into dates.
    expect(model.intervals[ship.recordId]).toEqual({
      end: Date.UTC(2026, 0, 8),
      start: Date.UTC(2026, 0, 3),
    });
    expect(model.sourceDocument.source).toContain("after g1, until l1");
  });

  it("keeps statements separate when the source has no trailing newline", () => {
    // No trailing line ending: the insertion still has to start its own line.
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Design : des1, 2026-01-01, 3d",
    );
    expect(
      model.sourceDocument.statements.filter((entry) => entry.kind === "task"),
    ).toHaveLength(1);
    const result = applyGanttCommand({
      command: {
        label: "Rollout",
        milestone: true,
        sectionId: model.sections[0].id,
        start: "2026-01-04",
        type: "task.add",
      },
      model,
      readonly: false,
    });
    expect(result.changed).toBe(true);
    expect(result.source).toContain(
      "3d\n  Rollout : milestone, 2026-01-04, 0d",
    );
    const reparsed = parse(result.source);
    expect(reparsed?.tasks).toHaveLength(2);
    expect(reparsed?.tasks[1]).toMatchObject({ isMilestone: true });
  });

  it("keeps a dependent resolvable when its until reference is deleted", () => {
    const source =
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Plan : p1, 2026-01-01, 5d\n  Guard : g1, after p1, until p1\n  Ship : s1, 2026-01-09, 2d\n";
    const model = parse(source);
    const guard = model.tasks.find((task) => task.id === "g1")!;
    const removed = applyGanttCommand({
      command: {
        kind: "until",
        referenceId: "p1",
        taskRecordId: guard.recordId,
        type: "dependency.delete",
      },
      model,
      readonly: false,
    });
    expect(removed.changed).toBe(true);
    const reparsed = parse(removed.source);
    expect(reparsed?.diagnostics).toEqual([]);
    expect(reparsed?.tasks.find((task) => task.id === "g1")?.untilIds).toEqual(
      [],
    );
  });

  it("parses an id followed by an after clause without a duration", () => {
    for (const shape of ["", "milestone, "]) {
      const source = `gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Plan : p1, 2026-01-01, 5d\n  Ship : ${shape}s1, after p1\n`;
      const model = parse(source);
      const ship = model.tasks.find((task) => task.id === "s1")!;
      expect(ship).toMatchObject({
        scheduleKind: "after",
        afterIds: ["p1"],
        duration: "",
      });
      expect(model.diagnostics).toEqual([]);
      const renamed = applyGanttCommand({
        model,
        readonly: false,
        command: {
          type: "task.rename",
          taskId: ship.recordId,
          label: "Renamed",
        },
      });
      expect(renamed.source).toBe(source.replace("  Ship :", "  Renamed :"));
      expect(renamed.model.intervals[ship.recordId]).toEqual(
        model.intervals[ship.recordId],
      );
      const status = applyGanttCommand({
        model,
        readonly: false,
        command: {
          type: "task.set-statuses",
          taskId: ship.recordId,
          statuses: ["done"],
        },
      });
      expect(status.source).toBe(
        source.replace("  Ship : ", "  Ship : done, "),
      );
      expect(status.model.intervals[ship.recordId]).toEqual(
        model.intervals[ship.recordId],
      );
    }
  });

  it("keeps the legacy accDescription form and decimal duration units", () => {
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD\n  accDescription: old style\n  section Work\n  Plan : p1, 2026-01-01, 1.5d\n",
    );
    expect(model.diagnostics).toEqual([]);
    expect(model.accessibilityDescription).toBe("old style");
    expect(model.tasks[0]).toMatchObject({ duration: "1.5d" });
    expect(
      model.sourceDocument.statements.some((entry) =>
        entry.raw.includes("accDescription:"),
      ),
    ).toBe(true);
  });

  it("appends a diagram comment after the last line, not below the header", () => {
    const model = parse();
    const added = applyGanttCommand({
      command: {
        anchor: { kind: "diagram" },
        text: "release note",
        type: "comment.add",
      },
      model,
      readonly: false,
    });
    expect(added.changed).toBe(true);
    const lines = added.source.trimEnd().split("\n");
    expect(lines[1]?.trim()).toBe("title Build Plan");
    expect(lines.at(-1)).toBe("  %% release note");
    expect(parse(added.source)?.diagnostics).toEqual([]);
  });

  it("appends a new option after the last line and patches an existing one", () => {
    const model = parse();
    const added = applyGanttCommand({
      command: { name: "tickInterval", type: "option.set", value: "1week" },
      model,
      readonly: false,
    });
    expect(added.changed).toBe(true);
    const lines = added.source.trimEnd().split("\n");
    expect(lines[1]?.trim()).toBe("title Build Plan");
    expect(lines.at(-1)).toBe("  tickInterval 1week");
    const patched = applyGanttCommand({
      command: { name: "axisFormat", type: "option.set", value: "%d.%m" },
      model: added.model,
      readonly: false,
    });
    expect(patched.changed).toBe(true);
    expect(patched.source).toContain("  axisFormat %d.%m");
    expect(patched.source).toContain("  title Build Plan");
    // Both new statements went to the end, in the order they were requested.
    expect(patched.source.trimEnd().split("\n").slice(-2)).toEqual([
      "  tickInterval 1week",
      "  axisFormat %d.%m",
    ]);
  });

  it("reconnects a dependency to another task and refuses a cycle", () => {
    const model = parse();
    const build = model.tasks.find((task) => task.id === "bld")!;
    const design = model.tasks.find((task) => task.id === "des1")!;
    const rolled = applyGanttCommand({
      command: {
        kind: "after",
        newReferenceId: design.id,
        referenceId: "missing",
        taskRecordId: build.recordId,
        type: "dependency.reconnect",
      },
      model,
      readonly: false,
    });
    expect(rolled.changed).toBe(false);
    const reconnected = applyGanttCommand({
      command: {
        kind: "after",
        newReferenceId: "nope",
        referenceId: "des1",
        taskRecordId: build.recordId,
        type: "dependency.reconnect",
      },
      model,
      readonly: false,
    });
    // Re-pointing at an unknown id is refused before writing, so the
    // source keeps the previous, still resolvable reference.
    expect(reconnected.changed).toBe(false);
    expect(reconnected.diagnosis).toBe("unknown-reference");
    expect(reconnected.source).toBe(SOURCE);
    const cycle = applyGanttCommand({
      model,
      readonly: false,
      command: {
        type: "dependency.create",
        fromTaskId: build.recordId,
        toTaskId: design.recordId,
      },
    });
    expect(cycle.changed).toBe(false);
    expect(cycle.diagnosis).toBe("cycle");
    expect(cycle.source).toBe(SOURCE);
  });

  it("blocks mutations in readonly mode", () => {
    const model = parse();
    const design = model.tasks.find((task) => task.id === "des1")!;
    const result = applyGanttCommand({
      command: { label: "Nope", taskId: design.recordId, type: "task.rename" },
      model,
      readonly: true,
    });
    expect(result.changed).toBe(false);
    expect(result.diagnosis).toBe("readonly");
  });
});

describe("gantt schedule command preserves real task time forms", () => {
  const HOUR_SOURCE = [
    "gantt",
    "  dateFormat YYYY-MM-DD HH:mm:ss",
    "  section Work",
    "  Shift : sh, 2026-01-01 08:00:00, 2026-01-01 16:00:00",
    "",
  ].join("\n");

  it("uses runtime formats without losing authored boundaries or precision", () => {
    for (const [format, start, end, movedStart] of [
      ["X", "1788768000123", "1788940800", "1788854400123"],
      ["YYYY-M-D", "2026-9-7", "2026-9-9", "2026-9-8"],
      ["DD MMM YYYY", "07 Sep 2026", "09 Sep 2026", "08 Sep 2026"],
      [
        "YYYY-MM-DD[T]HH:mm:ss.SSS[Z]",
        "2026-09-07T08:00:00.123Z",
        "2026-09-09T08:00:00.123Z",
        "2026-09-08T08:00:00.123Z",
      ],
      [
        "YYYY-MM-DD[T]HH:mm:ss.SSSZ",
        "2026-09-07T10:00:00.123+02:00",
        "2026-09-09T10:00:00.123+02:00",
        "2026-09-08T10:00:00.123+02:00",
      ],
    ]) {
      const source = `gantt\n  dateFormat ${format}\n  section Work\n  Plan : p1, ${start}, ${end}\n`;
      const model = parse(source);
      const task = model.tasks[0]!;
      expect(model.diagnostics).toEqual([]);
      const interval = model.intervals[task.recordId]!;
      const moved = applyGanttCommand({
        model,
        readonly: false,
        command: {
          type: "task.move",
          taskId: task.recordId,
          deltaMs: 86_400_000,
        },
      });
      expect(moved.changed).toBe(true);
      expect(moved.model.tasks[0].start).toBe(movedStart);
      expect(moved.model.intervals[task.recordId]).toEqual({
        start: interval.start + 86_400_000,
        end: interval.end + 86_400_000,
      });
      const resized = applyGanttCommand({
        model,
        readonly: false,
        command: {
          type: "task.resize",
          taskId: task.recordId,
          edge: "start",
          valueMs: interval.start + 86_400_000,
        },
      });
      expect(resized.changed).toBe(true);
      expect(resized.model.tasks[0].end).toBe(end);
      const renamed = applyGanttCommand({
        model,
        readonly: false,
        command: {
          type: "task.rename",
          taskId: task.recordId,
          label: "Renamed",
        },
      });
      expect(renamed.source).toBe(source.replace("Plan :", "Renamed :"));
      const unrepresentable = applyGanttCommand({
        model,
        readonly: false,
        command: { type: "task.move", taskId: task.recordId, deltaMs: 0.5 },
      });
      expect(unrepresentable.source).toBe(source);
      expect(unrepresentable.diagnosis).toBe("invalid-date");
    }
  });

  it("edits one binding atomically with id rename and preserves other bindings and trivia", () => {
    const source = `${HOUR_SOURCE}  click sh href "/help"\n  %% callback note\n  click sh call notify("first", "second")\n`;
    const model = parse(source);
    const task = model.tasks[0]!;
    const binding = model.clicks[1]!;
    const result = applyGanttCommands({
      model,
      readonly: false,
      commands: [
        { type: "task.rename-id", taskId: task.recordId, newId: "shift" },
        {
          type: "click.set",
          taskRecordId: task.recordId,
          clickId: binding.id,
          kind: "click",
          callbackOrUrl: "notifyUpdated",
          args: ["first", "changed, value", "last"],
        },
      ],
    });
    expect(result.changed).toBe(true);
    expect(result.source).toBe(
      source
        .replaceAll("sh", "shift")
        .replace(
          'notify("first", "second")',
          'notifyUpdated("first", "changed, value", "last")',
        ),
    );
    expect(result.model.clicks[1].args).toEqual([
      '"first"',
      '"changed, value"',
      '"last"',
    ]);
    const unchanged = applyGanttCommand({
      model,
      readonly: false,
      command: {
        type: "click.set",
        taskRecordId: task.recordId,
        clickId: binding.id,
        kind: "click",
        callbackOrUrl: "notify",
        args: ["first", "second"],
      },
    });
    expect(unchanged.source).toBe(source);
    expect(unchanged.changed).toBe(false);
    const invalid = applyGanttCommands({
      model,
      readonly: false,
      commands: [
        { type: "task.rename-id", taskId: task.recordId, newId: "shift" },
        {
          type: "click.set",
          taskRecordId: task.recordId,
          clickId: binding.id,
          kind: "click",
          callbackOrUrl: "notify",
          args: ['bad"quote'],
        },
      ],
    });
    expect(invalid.changed).toBe(false);
    expect(invalid.source).toBe(source);
  });

  it("moves an explicit task by a millisecond delta without day rounding", () => {
    const model = parse(HOUR_SOURCE);
    const shift = model.tasks[0]!;
    const moved = applyGanttCommand({
      command: {
        deltaMs: 3 * 3_600_000,
        taskId: shift.recordId,
        type: "task.move",
      },
      model,
      readonly: false,
    });
    expect(moved.changed).toBe(true);
    // A three-hour move must stay three hours; the previous day rounding
    // produced a whole-day jump instead.
    expect(moved.source).toContain("2026-01-01 11:00:00");
    expect(moved.source).toContain("2026-01-01 19:00:00");
  });

  it("keeps the untouched end and recomputes the duration on start resize", () => {
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Plan : p1, 2026-01-01, 3d\n",
    );
    const plan = model.tasks[0]!;
    const resized = applyGanttCommand({
      command: {
        edge: "start",
        taskId: plan.recordId,
        type: "task.resize",
        valueMs: Date.UTC(2026, 0, 2),
      },
      model,
      readonly: false,
    });
    expect(resized.changed).toBe(true);
    // The end stays 2026-01-04; only the working length shrinks to two days.
    expect(resized.source).toContain("Plan : p1, 2026-01-02, 2d");
    expect(resized.source).not.toContain("Plan : p1, 2026-01-02, 3d");
  });

  it("rejects a move of a reference-bound start instead of a silent rewrite", () => {
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Design : d1, 2026-01-01, 2d\n  Build : b1, after d1, 3d\n",
    );
    const build = model.tasks.find((task) => task.id === "b1")!;
    const moved = applyGanttCommand({
      command: {
        deltaMs: 86_400_000,
        taskId: build.recordId,
        type: "task.move",
      },
      model,
      readonly: false,
    });
    expect(moved.changed).toBe(false);
    expect(moved.diagnosis).toBe("bound-start");
    expect(moved.source).toContain("after d1");
  });

  it("recomputes the duration when a resize ends on a fractional day", () => {
    const model = parse(
      "gantt\n  dateFormat YYYY-MM-DD HH:mm:ss\n  section Work\n  Plan : p1, 2026-01-01 08:00:00, 4h\n",
    );
    const plan = model.tasks[0]!;
    const resized = applyGanttCommand({
      command: {
        edge: "end",
        taskId: plan.recordId,
        type: "task.resize",
        valueMs: Date.UTC(2026, 0, 1, 10, 0, 0),
      },
      model,
      readonly: false,
    });
    expect(resized.changed).toBe(true);
    expect(resized.source).toContain("2h");
    expect(resized.source).not.toContain("2d");
  });
});

describe("gantt dependency reconnect and delete keep both endpoints honest", () => {
  const SOURCE = [
    "gantt",
    "  dateFormat YYYY-MM-DD",
    "  section Work",
    "  API : api, 2026-09-01, 3d",
    "  Build : bld, after api, 5d",
    "  Ship : shp, after bld, 2d",
    "",
  ].join("\n");

  it("re-points only the referenced task on a source reconnect", () => {
    const source = `${SOURCE}  Other API : api2, 2026-09-02, 3d\n`;
    const model = parse(source);
    const build = model.tasks.find((task) => task.id === "bld")!;
    const api = model.tasks.find((task) => task.id === "api")!;
    const reconnected = applyGanttCommand({
      command: {
        endpoint: "source",
        kind: "after",
        newReferenceId: api.id,
        referenceId: "api",
        taskRecordId: build.recordId,
        type: "dependency.reconnect",
      },
      model,
      readonly: false,
    });
    // Re-pointing at the same id is a no-op, so no source changes.
    expect(reconnected.changed).toBe(false);
    expect(reconnected.source).toBe(source);
    const moved = applyGanttCommand({
      model,
      readonly: false,
      command: {
        type: "dependency.reconnect",
        endpoint: "source",
        kind: "after",
        taskRecordId: build.recordId,
        referenceId: "api",
        newReferenceId: "api2",
      },
    });
    expect(moved.changed).toBe(true);
    expect(moved.source).toBe(
      source.replace("Build : bld, after api,", "Build : bld, after api2,"),
    );
  });

  it("moves the dependent end to a new owner atomically", () => {
    const model = parse(SOURCE);
    const build = model.tasks.find((task) => task.id === "bld")!;
    const ship = model.tasks.find((task) => task.id === "shp")!;
    // `Build` currently owns `after api`; reconnecting its dependent end moves
    // that whole reference onto `Ship`.
    const moved = applyGanttCommand({
      command: {
        endpoint: "target",
        kind: "after",
        newOwnerRecordId: ship.recordId,
        referenceId: "api",
        taskRecordId: build.recordId,
        type: "dependency.reconnect",
      },
      model,
      readonly: false,
    });
    expect(moved.changed).toBe(true);
    // `Build` loses its reference; `Ship` gains it without losing `bld`.
    expect(moved.source).toContain("Build : bld, 5d");
    expect(moved.source).toContain("Ship : shp, after bld api, 2d");
    expect(parse(moved.source)?.diagnostics).toEqual([]);
  });

  it("refuses a duplicate reconnect instead of writing a double edge", () => {
    const source = SOURCE.replace(
      "Ship : shp, after bld,",
      "Ship : shp, after bld api,",
    );
    const model = parse(source);
    const ship = model.tasks.find((task) => task.id === "shp")!;
    const refused = applyGanttCommand({
      command: {
        endpoint: "source",
        kind: "after",
        newReferenceId: "bld",
        referenceId: "api",
        taskRecordId: ship.recordId,
        type: "dependency.reconnect",
      },
      model,
      readonly: false,
    });
    expect(refused.changed).toBe(false);
    expect(refused.diagnosis).toBe("duplicate-reference");
    expect(refused.source).toBe(source);
  });
});

describe("gantt reorder near a newline-less source end", () => {
  it("keeps lines separate when a section moves to a source with no trailing newline", () => {
    const source = [
      "gantt",
      "  title Release Plan",
      "  dateFormat YYYY-MM-DD",
      "  section Discovery",
      "  Design : des1, 2026-09-04, 2.5d",
      "  section Delivery",
      "  Build : imp1, after des1, 6d",
    ].join("\n");
    const model = parse(source);
    const discovery = model.sections.find(
      (section) => section.title === "Discovery",
    )!;
    const moved = applyGanttCommand({
      command: {
        sectionId: discovery.id,
        targetOrder: 1,
        type: "section.reorder",
      },
      model,
      readonly: false,
    });
    expect(moved.changed).toBe(true);
    // The fused `6d  section Discovery` line was the pre-fix defect.
    expect(moved.source).toContain(
      "Build : imp1, after des1, 6d\n  section Discovery",
    );
    expect(moved.source).not.toContain("6d  section");
    expect(parse(moved.source)?.diagnostics).toEqual([]);
  });
});

describe("gantt reorder across sections", () => {
  it("moves a task statement with its trivia into the target section", () => {
    const source = [
      "gantt",
      "  dateFormat YYYY-MM-DD",
      "  section Release",
      "",
      "  %% API owner note",
      "  API freeze : api, 2026-09-01, 3d",
      "  Build : bld, after api, 5d",
      "  section Go live",
      "  Rollout : roll, 2026-10-01, 1w",
      "",
    ].join("\n");
    const model = parse(source);
    const api = model.tasks.find((task) => task.id === "api")!;
    const goLive = model.sections.find(
      (section) => section.title === "Go live",
    )!;
    const inserted = applyGanttCommand({
      model,
      readonly: false,
      command: {
        type: "section.add",
        title: "Review",
        afterSectionId: model.sections[0].id,
      },
    });
    expect(inserted.changed).toBe(true);
    const records = inserted.model.sourceDocument.statements;
    expect(new Set(records.map((item) => item.id)).size).toBe(records.length);
    for (const old of model.sourceDocument.statements) {
      expect(records.find((item) => item.id === old.id)?.raw).toBe(old.raw);
    }
    const moved = applyGanttCommand({
      command: {
        targetOrder: 0,
        targetSectionId: goLive.id,
        taskId: api.recordId,
        type: "task.reorder",
      },
      model: inserted.model,
      readonly: false,
    });
    expect(moved.diagnosis).toBe("ok");
    expect(moved.changed).toBe(true);
    expect(moved.source.indexOf("API freeze")).toBeGreaterThan(
      moved.source.indexOf("section Go live"),
    );
    expect(parse(moved.source)?.diagnostics).toEqual([]);
    expect(moved.source).toContain(
      "  %% API owner note\n  API freeze : api, 2026-09-01, 3d",
    );
    expect(moved.model.tasks.find((task) => task.id === "api")?.recordId).toBe(
      api.recordId,
    );
  });
});
