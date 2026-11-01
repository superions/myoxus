// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { migrateLegacyMermaidNodeFamilyData } from "../families/runtime/gfx-projection-read-migration.js";

describe("released Mermaid GFX metadata read migration", () => {
  test("does not materialize obsolete Packet fields into the GFX projection", () => {
    const released = new Map<string, unknown>([
      ["mermaidRole", "mermaid-flowchart-node"],
      ["mermaidFlowchartVisualStyleVersion", "gfx-flowchart-v1"],
      ["mermaidNodePacketStartBit", 0],
      ["mermaidNodePacketEndBit", 7],
      ["mermaidNodePacketSourceMode", "range"],
    ]);
    expect(
      migrateLegacyMermaidNodeFamilyData("packet", undefined, (key) =>
        released.get(key),
      ),
    ).toBeUndefined();

    released.set("mermaidFlowchartVisualStyleVersion", "gfx-flowchart-v2");
    expect(
      migrateLegacyMermaidNodeFamilyData("packet", undefined, (key) =>
        released.get(key),
      ),
    ).toBeUndefined();

    released.set("mermaidFlowchartVisualStyleVersion", "gfx-flowchart-v1");
    released.delete("mermaidNodePacketEndBit");
    expect(
      migrateLegacyMermaidNodeFamilyData("packet", undefined, (key) =>
        released.get(key),
      ),
    ).toBeUndefined();
  });
});
