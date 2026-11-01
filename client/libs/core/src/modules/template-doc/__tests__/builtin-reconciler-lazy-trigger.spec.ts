// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("builtin template reconciler trigger contract", () => {
  test("does not materialize workspace templates when the settings panel merely mounts", () => {
    const settingsPanel = read(
      "client/libs/core/src/desktop/dialogs/setting/workspace-setting/preference/template.tsx",
    );

    expect(settingsPanel).not.toContain("BuiltinTemplateReconcilerService");
    expect(settingsPanel).not.toMatch(
      /useEffect\s*\(\s*\(\)\s*=>\s*\{[^}]*reconciler\.reconcile/s,
    );
  });

  test("reconciles lazily when a template picker is actually opened", () => {
    const templateMenu = read(
      "client/libs/core/src/modules/template-doc/view/template-list-menu.tsx",
    );

    expect(templateMenu).toContain("BuiltinTemplateReconcilerService");
    expect(templateMenu).toContain("onOpen");
    expect(templateMenu).toContain("await reconciler.reconcile()");
    expect(templateMenu).toContain("loadTemplateSuggestions");
    expect(templateMenu).toContain("loadSuggestionsOnMount");
  });

  test("journal template picker delegates to the shared suggestion-aware onboarding content", () => {
    const journalOnboarding = read(
      "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/journal/template-onboarding.tsx",
    );
    const journalFooter = read(
      "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/journal/sidebar-footer.tsx",
    );

    expect(journalOnboarding).not.toContain("BuiltinTemplateReconcilerService");
    expect(journalOnboarding).toContain("TemplateListMenuContentScrollable");
    expect(journalOnboarding).toContain(
      "TemplateSuggestionSurface.JournalOnboarding",
    );
    expect(journalFooter).not.toContain("TemplateListMenuContentScrollable");
    expect(journalFooter).not.toContain("TemplateSuggestionSurface");
    expect(journalFooter).not.toMatch(
      /useEffect\s*\(\s*\(\)\s*=>\s*\{[^}]*reconciler\.reconcile/s,
    );
  });

  test("all declared P6 create surfaces use server suggestion surfaces", () => {
    const sidebarButton = read(
      "client/libs/core/src/modules/app-sidebar/views/add-page-button/index.tsx",
    );
    const starterBar = read(
      "client/libs/core/src/editor/virgultum/doc-editor/starter-bar.tsx",
    );
    const journalOnboarding = read(
      "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/journal/template-onboarding.tsx",
    );

    expect(sidebarButton).toContain("TemplateSuggestionSurface.SidebarNewPage");
    expect(starterBar).toContain("TemplateSuggestionSurface.StarterBar");
    expect(journalOnboarding).toContain(
      "TemplateSuggestionSurface.JournalOnboarding",
    );
  });
});
