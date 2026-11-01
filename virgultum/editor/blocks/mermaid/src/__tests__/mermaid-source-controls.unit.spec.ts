import { describe, expect, test } from "vitest";

import {
  resolveMermaidBlankSourceControl,
  resolveMermaidTemplateSourceControl,
} from "../mermaid-source-controls.js";

describe("Mermaid source controls", () => {
  test("resolves template and blank source changes with template metadata", () => {
    const blank = resolveMermaidBlankSourceControl();

    expect(blank?.source).toContain("flowchart");
    expect(resolveMermaidTemplateSourceControl(blank!.templateId!)).toEqual(
      blank,
    );
    expect(resolveMermaidTemplateSourceControl("missing-template")).toBeNull();
  });
});
