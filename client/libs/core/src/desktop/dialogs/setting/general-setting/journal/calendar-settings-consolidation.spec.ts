// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const readPeer = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("calendar settings information architecture", () => {
  test("does not keep the personal calendar linking entry in account settings", () => {
    const accountSettings = readPeer("../../account-setting/index.tsx");

    expect(accountSettings).not.toContain("CalendarAccountsSettings");
    expect(accountSettings).not.toContain("calendarAccountsQuery");
    expect(accountSettings).not.toContain("integrations-panel");
  });

  test("does not expose duplicate workspace calendar entry points", () => {
    const workspaceSettings = readPeer("../../workspace-setting/index.tsx");
    const integrationConstants = readPeer(
      "../../workspace-setting/integration/constants.tsx",
    );
    const workspaceCalendarPanel = readPeer(
      "../../workspace-setting/integration/calendar/setting-panel.tsx",
    );
    const calendarAccounts = readPeer("./calendar-accounts.tsx");

    expect(workspaceSettings).not.toContain("workspace:calendar");
    expect(integrationConstants).not.toContain('id: "calendar"');
    expect(workspaceCalendarPanel).not.toContain("IntegrationSettingHeader");
    expect(workspaceCalendarPanel).not.toContain("TodayIcon");
    expect(calendarAccounts).not.toContain("CollapsibleWrapper");
    expect(calendarAccounts).not.toContain("TodayIcon");
  });

  test("does not render workspace subscription controls before accounts exist", () => {
    const workspaceCalendarPanel = readPeer(
      "../../workspace-setting/integration/calendar/setting-panel.tsx",
    );
    const calendarAccounts = readPeer("./calendar-accounts.tsx");

    expect(calendarAccounts).toContain('data-testid="calendar-accounts-empty"');
    expect(workspaceCalendarPanel).toContain("if (accounts.length === 0)");
    expect(workspaceCalendarPanel).toContain("return null");
    expect(workspaceCalendarPanel).toContain("hasCalendars ? (");
    expect(workspaceCalendarPanel).toContain(
      'data-testid="workspace-calendar-subscriptions-save"',
    );
  });

  test("does not show the workspace calendar save action before defaults are dirty", () => {
    const workspaceCalendarSettings = readPeer(
      "../../workspace-setting/calendar/index.tsx",
    );

    expect(workspaceCalendarSettings).toContain("const settingsDirty =");
    expect(workspaceCalendarSettings).toContain(
      "settingsDirty || savingSettings",
    );
    expect(workspaceCalendarSettings).toContain(
      'data-testid="workspace-calendar-settings-save"',
    );
  });

  test("confirms event tag deletion through the shared facade modal", () => {
    const workspaceCalendarSettings = readPeer(
      "../../workspace-setting/calendar/index.tsx",
    );
    const en = JSON.parse(
      readPeer("../../../../../../../i18n/src/resources/en.json"),
    );
    const de = JSON.parse(
      readPeer("../../../../../../../i18n/src/resources/de.json"),
    );

    expect(workspaceCalendarSettings).toContain("useConfirmModal");
    expect(workspaceCalendarSettings).toContain("handleRequestDeleteTag");
    expect(workspaceCalendarSettings).toContain("openConfirmModal({");
    expect(workspaceCalendarSettings).toContain(
      '"com.myoxus.settings.workspace.calendar.tags.delete-confirm.title"',
    );
    expect(workspaceCalendarSettings).toContain(
      '"com.myoxus.settings.workspace.calendar.tags.delete-confirm.description"',
    );
    expect(workspaceCalendarSettings).toContain("tagName: tag.name");
    expect(workspaceCalendarSettings).toContain('variant: "error"');
    expect(workspaceCalendarSettings).toContain(
      "await handleDeleteTag(tagId);",
    );
    expect(workspaceCalendarSettings).toContain(
      "onClick={() => handleRequestDeleteTag(tag.id)}",
    );
    expect(workspaceCalendarSettings).not.toContain(
      "onClick={() => handleDeleteTag(tag.id).catch(() => undefined)}",
    );
    expect(workspaceCalendarSettings).not.toContain("tagDeleteConfirmCopy");
    expect(workspaceCalendarSettings).not.toContain("language.toLowerCase()");
    expect(workspaceCalendarSettings).not.toContain(
      "Bestehende Termine bleiben erhalten",
    );
    expect(workspaceCalendarSettings).not.toContain(
      "Existing events remain in place",
    );
    expect(
      en["com.myoxus.settings.workspace.calendar.tags.delete-confirm.title"],
    ).toBe("Delete event tag?");
    expect(
      de[
        "com.myoxus.settings.workspace.calendar.tags.delete-confirm.description"
      ],
    ).toContain("{{tagName}}");
  });

  test("calendar account chrome uses facade roles instead of local css", () => {
    const calendarAccounts = readPeer("./calendar-accounts.tsx");

    for (const token of [
      "SettingsToolbar",
      "SettingsStatusText",
      "SettingsControlEmpty",
      "SettingsFieldGroup",
      "FormRow",
      "DialogFooterActions",
      "SurfaceList",
      "SurfaceListItem",
      "SurfaceListItemIcon",
      "SurfaceListItemMain",
      "SurfaceListMeta",
      "SurfaceListText",
      "StatusDot",
      "MyoxusText",
    ]) {
      expect(calendarAccounts).toContain(token);
    }

    expect(calendarAccounts).not.toContain("./calendar-accounts.styles");
    expect(calendarAccounts).not.toContain("styles.");
    expect(calendarAccounts).not.toContain("className=");
    expect(calendarAccounts).not.toMatch(/<(?:div|p|span)\b/);
    expect(calendarAccounts).not.toContain("width={480}");
    expect(calendarAccounts).toContain('component="a"');
    expect(calendarAccounts).toContain('tone="link"');

    for (const removed of [
      "./calendar-accounts.css",
      "./calendar-accounts.styles.ts",
    ]) {
      expect(existsSync(new URL(removed, import.meta.url)), removed).toBe(
        false,
      );
    }
  });
});
