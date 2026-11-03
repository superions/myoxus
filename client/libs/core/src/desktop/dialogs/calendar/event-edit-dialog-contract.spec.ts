// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { eventReminderPatch } from "./event-edit-input";

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

  test("preserves unchanged reminder definitions and distinguishes clear from replacement", () => {
    const basis = { reminderMinutes: 15, reminderChannel: "email" };
    expect(eventReminderPatch({ ...basis }, basis)).toEqual({});
    expect(
      eventReminderPatch(
        { reminderMinutes: "", reminderChannel: "email" },
        basis,
      ),
    ).toEqual({ reminders: [] });
    expect(
      eventReminderPatch({ ...basis, reminderMinutes: 30 }, basis),
    ).toEqual({ reminders: [{ minutesBefore: 30, channel: "email" }] });
  });
});
