// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const journalsRoot = "client/libs/core/src/desktop/pages/workspace/journals";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("workspace journals facade migration", () => {
  test("keeps retired journals route CSS and duplicate header modules deleted", () => {
    for (const file of [
      `${journalsRoot}/index.css`,
      `${journalsRoot}/index.styles.ts`,
      "client/libs/core/src/editor/virgultum/doc-header/journal/date-picker.tsx",
      "client/libs/core/src/editor/virgultum/doc-header/journal/today-button.tsx",
    ]) {
      expect(existsSync(join(repoRoot, file)), file).toBe(false);
    }
  });

  test("uses facade-owned layout, typography and empty-state primitives", () => {
    const source = readRepoFile(`${journalsRoot}/index.tsx`);
    const sharedHeader = readRepoFile(
      `${journalsRoot}/journal-workbench-header.tsx`,
    );
    expect(source).toContain('from "@myoxus/ui-facade"');
    expect(source).toContain("JournalWorkbenchHeader");
    expect(source).toContain("PageContentRail");
    expect(source).toContain("EmptyState");
    expect(source).toContain("EmptyStateTitle");
    expect(source).toContain("MyoxusTitle");
    expect(sharedHeader).toContain("WorkbenchHeaderFrame");
    expect(sharedHeader).toContain("WorkbenchToolsHeaderMenuButton");
    expect(sharedHeader).not.toContain("WorkbenchHeaderMenu");
    expect(sharedHeader).not.toContain("WorkbenchPageHeader");
    expect(sharedHeader).toContain("MiniCalendar");
    expect(sharedHeader).toContain("locale={t.language}");
    expect(sharedHeader).toContain(
      'previousLabel={t["com.myoxus.lastWeek"]()}',
    );
    expect(sharedHeader).toContain('nextLabel={t["com.myoxus.nextWeek"]()}');
    expect(sharedHeader).toContain('data-testid="journal-today-button"');
    expect(sharedHeader).not.toContain('size="large"');
    expect(sharedHeader).toContain("!isToday ? (");
    expect(source).not.toContain("DataPageHeaderRail");
    expect(source).not.toContain("WeekDatePicker");
    expect(source).not.toContain("VirgultumEditorJournalDocTitleUI");
    expect(source).not.toMatch(/\\.styles["']/);
    expect(source).not.toContain("styles.");
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/[0-9]+px/);
    expect(sharedHeader).not.toMatch(/\\.styles["']/);
    expect(sharedHeader).not.toContain("styles.");
    expect(sharedHeader).not.toContain("style={{");
    expect(sharedHeader).not.toMatch(/[0-9]+px/);
    expect(source).not.toContain("maxWidth");
    expect(sharedHeader).not.toContain("maxWidth");
    expect(source).toContain("journalService.ensureJournalByDate(dateString)");
    expect(source).toContain(
      "useLiveData(journalService.journalsByDate$(dateString))",
    );
    expect(source).not.toContain("ensureJournalByDateReadyForNavigation");
    expect(source).not.toContain("await journalService.ensureJournalByDate");
  });

  test("renders opened journal documents through the same shared week header", () => {
    const journalsRoute = readRepoFile(`${journalsRoot}/index.tsx`);
    const detailHeader = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/detail-page/detail-page-header.tsx",
    );

    expect(journalsRoute).toContain("JournalWorkbenchHeader");
    expect(detailHeader).toContain("JournalWorkbenchHeader");
    expect(detailHeader).toContain("journalService.journalDate$(page.id)");
    expect(detailHeader).toContain("journalService.getJournalsByDate");
    expect(detailHeader).not.toContain("JournalWeekDatePicker");
    expect(detailHeader).not.toContain("JournalTodayButton");
  });
});
