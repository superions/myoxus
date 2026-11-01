import { describe, expect, test } from "vitest";

import { resolveMermaidFamilyRuntime } from "../../../runtime/registry.js";

describe("Mermaid Treemap family module", () => {
  test("owns treemap and treemap-beta as one structured Core Facade runtime", () => {
    for (const header of ["treemap", "treemap-beta"]) {
      const resolution = resolveMermaidFamilyRuntime(
        `${header}\n"Root"\n  "A": 3\n`,
      );
      expect(resolution).toMatchObject({
        capabilities: { kind: "structured" },
        diagramType: "treemap",
        kind: "resolved",
      });
      expect("chartModel" in resolution).toBe(false);
      expect("sourceWriter" in resolution).toBe(false);
    }
  });
});
