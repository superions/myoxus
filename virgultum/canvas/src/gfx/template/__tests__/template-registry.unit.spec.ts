// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Template, TemplateManager } from "../toolbar/template-type.js";

describe("builtInTemplates registry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers custom template providers for categories, list, and search", async () => {
    const { builtInTemplates } =
      await import("../toolbar/builtin-templates.js");
    const customEntry = {
      name: "Custom Flow",
      type: "template",
    } as Template;
    const provider: TemplateManager = {
      list: () => [customEntry],
      categories: () => ["custom"],
      search: () => [customEntry],
    };

    builtInTemplates.extend(provider);
    // Repeated registration of the same provider instance is ignored.
    builtInTemplates.extend(provider);

    expect(await builtInTemplates.categories()).toEqual(["custom"]);
    expect(await builtInTemplates.list("any")).toEqual([customEntry]);
    expect(await builtInTemplates.search("flow")).toEqual([customEntry]);
  });

  it("isolates module state across tests without global leakage", async () => {
    const { builtInTemplates } =
      await import("../toolbar/builtin-templates.js");
    expect(await builtInTemplates.categories()).toEqual([]);
    expect(await builtInTemplates.list("any")).toEqual([]);
  });
});
