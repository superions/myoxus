// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "admin.audit-log.detail.old-value": "Old value",
        "admin.audit-log.detail.new-value": "New value",
      })[key] ?? key,
  }),
}));

import { buildAuditJsonDiffRows, redactAuditValue } from "./audit-json-diff";

afterEach(cleanup);

describe("AuditJsonDiff", () => {
  test("redacts sensitive keys recursively before diff rendering", () => {
    const value = redactAuditValue({
      profile: { email: "ada@example.com", passwordHash: "bcrypt$secret" },
      tokens: [{ accessToken: "raw-token" }],
    });

    expect(JSON.stringify(value)).toContain("***redacted***");
    expect(JSON.stringify(value)).not.toContain("bcrypt");
    expect(JSON.stringify(value)).not.toContain("raw-token");
  });

  test("builds added, removed and changed path rows with stable line numbers", () => {
    const rows = buildAuditJsonDiffRows(
      { name: "Old", nested: { keep: true, remove: "gone" } },
      { name: "New", nested: { keep: true }, added: 3 },
    );

    expect(rows.find((row) => row.path === "$.name")?.status).toBe("changed");
    expect(rows.find((row) => row.path === "$.added")?.status).toBe("added");
    expect(rows.find((row) => row.path === "$.nested.remove")?.status).toBe(
      "removed",
    );
    expect(rows.every((row) => row.oldLine !== 0 && row.newLine !== 0)).toBe(
      true,
    );
  });
});
