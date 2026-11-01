// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  applyJourneyCommands,
  addMermaidJourneySection,
  addMermaidJourneyStep,
  deleteMermaidJourneyStep,
  generateMermaidJourneySource,
  moveMermaidJourneySection,
  moveMermaidJourneyStep,
  parseMermaidJourneySource,
} from "../journey/index.js";
import {
  applyPacketCommand,
  parseMermaidPacketSource,
} from "../packet/index.js";

describe("journey semantic command model", () => {
  test("retains untouched bytes, duplicate membership and comment anchors while rejecting stale writes", () => {
    const source = [
      "---",
      'title: "Retained"',
      'config: {journey: {retained: "foreign"}}',
      "---",
      '%%{init: {"journey": {"width": 210}}}%%',
      "journey",
      "  Initial: 0.5: QA: ignored",
      "  section Same",
      "    %% travels with the first duplicate",
      "    Same: 2.50e0: QA, QA",
      "",
      "%% position stays",
      "",
      "  section Same",
      "    Same: 4: Support",
    ].join("\r\n");
    const model = parseMermaidJourneySource(source)!;
    const initial = model.steps[0],
      step = model.steps[1],
      target = model.sections[2];
    const command = {
      type: "move-step" as const,
      id: step.id,
      sectionId: target.id,
    };
    const preview = applyJourneyCommands(model, [command], {
      intent: "preview",
    });
    const expected =
      source.replace(
        "    %% travels with the first duplicate\r\n    Same: 2.50e0: QA, QA\r\n",
        "",
      ) +
      "\r\n    %% travels with the first duplicate\r\n    Same: 2.50e0: QA, QA";
    expect(preview.source).toBe(expected);
    expect(model.sourceDocument.source).toBe(source);
    const applied = applyJourneyCommands(model, [command], {
      baseSource: source,
    });
    expect(applied).toMatchObject({
      changed: true,
      source: expected,
      reason: "applied",
    });
    expect(applied.model.steps.find((s) => s.id === step.id)).toMatchObject({
      sectionId: target.id,
      score: 2.5,
      actors: ["QA", "QA"],
    });
    expect(
      applied.model.comments.find(
        (c) => c.text === "travels with the first duplicate",
      )?.anchorId,
    ).toBe(step.id);
    expect(
      applied.model.comments.find((c) => c.text === "position stays")?.anchorId,
    ).toBeNull();
    const removedParentSource = source.replace(
      "  section Same\r\n    Same: 4: Support",
      "",
    );
    const current = parseMermaidJourneySource(removedParentSource, model)!;
    expect(
      applyJourneyCommands(current, [command], { baseSource: source }),
    ).toMatchObject({
      changed: false,
      source: removedParentSource,
      reason: "conflict",
    });
    expect(
      applyJourneyCommands(model, [command], { intent: "cancel" }),
    ).toMatchObject({ changed: false, source });
    expect(
      applyJourneyCommands(model, [command], { readonly: true }),
    ).toMatchObject({ changed: false, source, reason: "readonly" });
    const actors = { type: "actors" as const, id: initial.id, value: [] };
    expect(applyJourneyCommands(model, [actors])).toMatchObject({
      changed: false,
      source,
      reason: "invalid",
    });
    expect(
      applyJourneyCommands(model, [{ ...actors, removeTail: true }]).source,
    ).toBe(source.replace("Initial: 0.5: QA: ignored", "Initial: 0.5"));
  });
  test("keeps a header-only Journey editable so the first section can be added", () => {
    const model = parseMermaidJourneySource("journey\n")!;
    expect(model.sections).toEqual([]);
    expect(generateMermaidJourneySource(model)).toBe("journey\n");
    expect(
      addMermaidJourneySection(model, "New section").sections,
    ).toHaveLength(1);
  });

  test("preserves section, step, score and actor order through commands and source", () => {
    const parsed = parseMermaidJourneySource(
      "journey\n  title Onboarding\n  section Discover\n    Open workspace: 5: User\n    Invite team: 4: Admin, User\n  section Adopt\n    Publish: 3: Editor\n",
    )!;
    const withSection = addMermaidJourneySection(parsed, "New section");
    const withStep = addMermaidJourneyStep(
      withSection,
      withSection.sections[2].id,
      "New step",
    );
    const reorderedStep = moveMermaidJourneyStep(
      withStep,
      withStep.steps[1].id,
      -1,
    );
    const reorderedSection = moveMermaidJourneySection(
      reorderedStep,
      reorderedStep.sections[2].id,
      -1,
    );
    const source = generateMermaidJourneySource(reorderedSection);
    const roundtrip = parseMermaidJourneySource(source)!;

    expect(roundtrip.sections.map((section) => section.title)).toEqual([
      "Discover",
      "New section",
      "Adopt",
    ]);
    expect(
      roundtrip.steps
        .filter((step) => step.sectionId === roundtrip.sections[0].id)
        .map((step) => [step.label, step.score, step.actors]),
    ).toEqual([
      ["Invite team", 4, ["Admin", "User"]],
      ["Open workspace", 5, ["User"]],
    ]);
    expect(source).toContain("New step: 3\n");
    expect(
      deleteMermaidJourneyStep(
        reorderedSection,
        reorderedSection.steps.at(-1)!.id,
      ).steps,
    ).toHaveLength(3);
  });
});

describe("packet deterministic geometry model", () => {
  test("patches retained Source bytes and anchors through boundary, split, merge and reorder", () => {
    const source =
      '---\r\nconfig: {packet: {bitsPerRow: 32, retained: "foreign"}}\r\n---\r\npacket-beta\r\n  title Kept\r\n  %% bound to version\r\n  0-3: \'Version\'\r\n  +60: "Payload"\r\n  64-95: "Tail"';
    const model = parseMermaidPacketSource(source)!;
    const [version, payload, tail] = model.fields;
    const renamed = applyPacketCommand(model, {
      type: "rename-field",
      fieldKey: version.id,
      label: "Header",
    });
    expect(renamed.source).toBe(source.replace("'Version'", "'Header'"));
    expect(renamed.model.comments?.[0]).toMatchObject({
      id: model.comments?.[0].id,
      anchorId: version.id,
    });
    const command = {
      type: "move-boundary" as const,
      leftKey: payload.id,
      rightKey: tail.id,
      nextBoundary: 66,
    };
    const preview = applyPacketCommand(model, command, { intent: "preview" });
    const expected = source.replace("+60:", "+62:").replace("64-95:", "66-95:");
    expect(preview.source).toBe(expected);
    expect(model.sourceDocument.source).toBe(source);
    const moved = applyPacketCommand(model, command, { baseSource: source });
    expect(moved).toMatchObject({
      changed: true,
      source: expected,
      reason: "applied",
    });
    expect(moved.model.fields.map((f) => [f.startBit, f.endBit])).toEqual([
      [0, 3],
      [4, 65],
      [66, 95],
    ]);
    for (const options of [{ intent: "cancel" as const }, { readonly: true }]) {
      expect(applyPacketCommand(model, command, options)).toMatchObject({
        changed: false,
        source,
      });
    }
    expect(
      applyPacketCommand(moved.model, command, { baseSource: source }),
    ).toMatchObject({ changed: false, source: expected, reason: "conflict" });
    const split = applyPacketCommand(moved.model, {
      type: "split-field",
      fieldKey: payload.id,
      boundary: 32,
      label: "Payload tail",
      sourceForm: "count",
    });
    expect(split.changed).toBe(true);
    expect(split.model.fields.map((f) => [f.startBit, f.endBit])).toEqual([
      [0, 3],
      [4, 31],
      [32, 65],
      [66, 95],
    ]);
    expect(split.model.totalWidth).toBe(96);
    const merged = applyPacketCommand(split.model, {
      type: "merge-fields",
      fieldKey: payload.id,
      neighborKey: split.model.fields[2].id,
      label: "Payload",
      sourceForm: "count",
    });
    expect(merged.source).toBe(expected);
    const reordered = applyPacketCommand(merged.model, {
      type: "reorder-field",
      fieldKey: tail.id,
      targetIndex: 1,
    });
    expect(reordered.changed).toBe(true);
    expect(
      reordered.model.fields.map((f) => [f.id, f.startBit, f.endBit]),
    ).toEqual([
      [version.id, 0, 3],
      [tail.id, 4, 33],
      [payload.id, 34, 95],
    ]);
    expect(reordered.model.fields.map((f) => f.sourceForm)).toEqual([
      "range",
      "range",
      "count",
    ]);
    expect(reordered.model.comments?.[0]).toMatchObject({
      id: model.comments?.[0].id,
      anchorId: version.id,
    });
    expect(reordered.model.totalWidth).toBe(96);
    expect(reordered.model.issues).toEqual([]);
  });

  test("keeps a header-only Packet editable so the first field can be added", () => {
    const model = parseMermaidPacketSource("packet\n")!;
    expect(model).toMatchObject({ fields: [], issues: [], totalWidth: 0 });
    expect(model.sourceDocument.source).toBe("packet\n");
    expect(
      applyPacketCommand(model, {
        type: "add-field",
        draft: {
          label: "New field",
          width: 8,
          position: "append",
          sourceForm: "range",
        },
      }).model.fields[0],
    ).toMatchObject({
      endBit: 7,
      startBit: 0,
    });
  });

  test("reports gaps, overlap and reversed ranges without flattening source order", () => {
    const model = parseMermaidPacketSource(
      'packet\n  0-3: "Version"\n  8-15: "Length"\n  12-19: "Overlap"\n  24-20: "Reverse"\n',
    )!;

    expect(model.fields.map((field) => field.label)).toEqual([
      "Version",
      "Length",
      "Overlap",
      "Reverse",
    ]);
    expect(model.fields.map((field) => field.width)).toEqual([4, 8, 8, 1]);
    expect(model.issues.map((issue) => issue.code)).toEqual([
      "invalid-range",
      "gap",
      "overlap",
    ]);
    expect(
      applyPacketCommand(model, {
        type: "rename-field",
        fieldKey: model.fields[0].id,
        label: "Rejected",
      }),
    ).toMatchObject({
      changed: false,
      reason: "invalid",
      source: model.sourceDocument.source,
    });
    expect(model.sourceDocument.source).toContain('24-20: "Reverse"');
  });

  test("adds, reorders and deletes contiguous ranges through Source commands", () => {
    const parsed = parseMermaidPacketSource(
      'packet\n  0-3: "Version"\n  4-15: "Length"\n',
    )!;
    const added = applyPacketCommand(parsed, {
      type: "add-field",
      draft: {
        label: "New field",
        width: 8,
        position: "append",
        sourceForm: "range",
      },
    }).model;
    expect(added.fields[2]).toMatchObject({
      endBit: 23,
      startBit: 16,
      width: 8,
    });
    const rejected = applyPacketCommand(added, {
      type: "edit-field",
      fieldKey: added.fields[2].id,
      edit: { startBit: 4, endBit: 18 },
    });
    expect(rejected).toMatchObject({
      changed: false,
      reason: "invalid",
      source: added.sourceDocument.source,
    });
    const resized = applyPacketCommand(added, {
      type: "edit-field",
      fieldKey: added.fields[2].id,
      edit: { startBit: 20, endBit: 31 },
    }).model;
    expect(resized.fields[2]).toMatchObject({
      endBit: 31,
      startBit: 20,
      width: 12,
    });
    expect(resized.fields[1]).toMatchObject({ startBit: 4, endBit: 19 });
    const reordered = applyPacketCommand(resized, {
      type: "reorder-field",
      fieldKey: resized.fields[2].id,
      targetIndex: 1,
    }).model;
    expect(reordered.fields.map((field) => field.label)).toEqual([
      "Version",
      "New field",
      "Length",
    ]);
    expect(
      reordered.fields.map((field) => [field.startBit, field.endBit]),
    ).toEqual([
      [0, 3],
      [4, 15],
      [16, 31],
    ]);
    const deleted = applyPacketCommand(reordered, {
      type: "delete-field",
      fieldKey: reordered.fields[1].id,
    });
    expect(deleted.model.fields).toHaveLength(2);
    expect(
      deleted.model.fields.map((field) => [field.startBit, field.endBit]),
    ).toEqual([
      [0, 3],
      [4, 19],
    ]);
    expect(deleted.model.issues).toEqual([]);
  });
});
