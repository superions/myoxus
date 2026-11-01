// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("calendar event dialog facade contract", () => {
  test("uses shared Mantine-backed facade controls instead of local form widgets", () => {
    for (const removedFile of [
      "client/libs/core/src/desktop/dialogs/calendar/event-edit-dialog.css",
      "client/libs/core/src/desktop/dialogs/calendar/event-edit-dialog.styles.ts",
    ]) {
      expect(existsSync(join(repoRoot, removedFile)), removedFile).toBe(false);
    }

    const source = readRepoFile(
      "client/libs/core/src/desktop/dialogs/calendar/event-edit-dialog.tsx",
    );

    for (const primitive of [
      "Button",
      "Checkbox",
      "DialogFooterActions",
      "Input",
      "Modal",
      "ResponsiveGrid",
      "Select",
      "SettingsNotice",
      "Textarea",
    ]) {
      expect(source).toContain(primitive);
    }
    expect(source).toContain('from "@myoxus/ui-facade"');
    expect(source).not.toMatch(/<(?:button|input|select|textarea)\b/);
    expect(source).not.toContain("./event-edit-dialog.styles");
    expect(source).not.toContain("styles.");
    expect(source).not.toContain("className={styles");
    expect(source).not.toContain("style={{");
    expect(source).not.toContain("520px");
    expect(source).not.toContain("100vw");
    expect(source).not.toContain("auto-fit");
    expect(source).not.toContain("minmax(");
  });

  test("keeps the reminder control editable and sends an explicit update patch", () => {
    const source = readRepoFile(
      "client/libs/core/src/desktop/dialogs/calendar/event-edit-dialog.tsx",
    );

    expect(source).toContain("existingEvent?.reminders[0]?.minutesBefore");
    expect(source).toContain("reminders:");
    expect(source).toMatch(/reminderMinutes === ""\s*\?\s*\[\]/);
    expect(source).toContain("data={reminderOptions}");
    expect(source).not.toMatch(
      /!isEditMode\s*\?\s*\(\s*<FormSelect\s+data=\{reminderOptions\}/s,
    );

    const query = readRepoFile(
      "client/libs/graphql/src/graphql/calendar/calendar-event.gql",
    );
    expect(query).toMatch(
      /calendarEvent\([\s\S]*reminders\s*\{[\s\S]*minutesBefore/,
    );
    expect(source).toContain("resolveEventDetails(eventId)");
    expect(source).toContain("close(eventId);");
    expect(source).toContain("close(created.id);");
    expect(source).not.toContain("onCreated");
  });
});
