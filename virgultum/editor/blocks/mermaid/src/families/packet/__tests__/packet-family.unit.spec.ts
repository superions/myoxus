import { describe, expect, test } from "vitest";

import { mermaidPacketDiagramTitle } from "../diagram-title.js";
import { mermaidPacketFamily } from "../family.js";

describe("Mermaid Packet family module", () => {
  test("wraps Packet parsing and requires Source commands with range and count fields", () => {
    const parsed = mermaidPacketFamily.parseSource(
      'packet\n  0-3: "Version"\n  +4: "Flags"\n',
      "packet",
    );
    const state = mermaidPacketFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") throw new Error("Packet must be editable");

    expect(state.visualModel.diagramType).toBe("packet");
    expect(state.visualModel.fields).toEqual([
      expect.objectContaining({
        endBit: 3,
        label: "Version",
        sourceForm: "range",
        startBit: 0,
        width: 4,
      }),
      expect.objectContaining({
        endBit: 7,
        label: "Flags",
        sourceForm: "count",
        startBit: 4,
        width: 4,
      }),
    ]);
    expect(
      mermaidPacketFamily.applyVisualToSource(state.visualModel, parsed.source),
    ).toMatchObject({
      source: parsed.source,
      diagnostics: [{ code: "packet.command-required", severity: "error" }],
    });
  });

  test("patches only the effective title record without matching text inside multiline records", () => {
    const source =
      'packet\n  title First\n  title Effective\n  accDescr {\n    title Description text\n  }\n  0-3: "Version\ntitle Label text"\n';
    expect(mermaidPacketDiagramTitle.resolve(source, "packet")?.value).toBe(
      "Effective",
    );
    expect(mermaidPacketDiagramTitle.patch(source, "packet", "Edited")).toBe(
      source.replace("title Effective", "title Edited"),
    );
  });

  test("returns source-only state for unsupported family syntax", () => {
    const parsed = mermaidPacketFamily.parseSource(
      "flowchart TD\n  A-->B\n",
      "flowchart",
    );
    const state = mermaidPacketFamily.toVisualModel(parsed);

    expect(parsed.model).toBeNull();
    expect(parsed.diagnostics[0]?.code).toBe("packet.unsupported-diagram-type");
    expect(state.kind).toBe("source-only");
  });
});
