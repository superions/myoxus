import {
  builtInTemplates,
  type Template,
  type TemplateManager,
} from "@virgultum/editor/gfx/template";
import { beforeEach, expect, test } from "vitest";

import { setupEditor } from "../utils/setup.js";

beforeEach(async () => {
  const cleanup = await setupEditor("edgeless");

  return cleanup;
});

test("extension api", async () => {
  const mockTemplate = {
    name: "Test",
    type: "template",
  } as Template;
  const customTemplate = {
    list: () => {
      return [mockTemplate];
    },
    categories: () => {
      return ["custom"];
    },
    search: (_, __) => {
      return [mockTemplate];
    },
  } satisfies TemplateManager;

  builtInTemplates.extend(customTemplate);

  const categories = await builtInTemplates.categories();
  expect(categories).toContain("custom");

  const templates = await builtInTemplates.list("any");
  expect(templates).toContain(mockTemplate);

  const searchTemplates = await builtInTemplates.search("any");
  expect(searchTemplates).toContain(mockTemplate);
});
