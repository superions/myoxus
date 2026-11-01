import type * as React from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "admin.audit-log.diff.old": "old:",
        "admin.audit-log.diff.new": "new:",
        "admin.audit-log.field.email": "Email",
        "admin.audit-log.field.name": "Name",
        "admin.audit-log.field.passwordHash": "Password hash",
        "admin.audit-log.field.smtpHost": "SMTP host",
      };
      return map[key] ?? key;
    },
  }),
}));

import { AuditRowDiffCell } from "./audit-row";

afterEach(cleanup);

function renderAuditRow(ui: React.ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

const makeEntry = (
  category: string,
  oldValue: Record<string, unknown> | null,
  newValue: Record<string, unknown> | null,
) => ({ category, oldValue, newValue });

// INV-D02-1: Config category renders old / new values

describe("INV-D02-1: config category renders old/new", () => {
  test("shows both old and new values for config entry", () => {
    const { container } = renderAuditRow(
      <AuditRowDiffCell
        entry={makeEntry(
          "config",
          { smtpHost: "old.host" },
          { smtpHost: "new.host" },
        )}
      />,
    );
    expect(screen.getByText(/old:/)).toBeTruthy();
    expect(screen.getByText(/new:/)).toBeTruthy();
    expect(screen.getAllByText("SMTP host")[0]).toBeTruthy();
    expect(screen.queryByText(/old\.host/)).toBeNull();
    expect(screen.queryByText(/new\.host/)).toBeNull();
    expect(container.querySelector(".admin-audit-row-diff")).toBeNull();
    expect(container.querySelector(".admin-audit-row-field-chip")).toBeNull();
    expect(
      container.querySelectorAll('[data-myoxus-ui-role^="badge:"]').length,
    ).toBeGreaterThan(0);
  });
});

// INV-D02-2: Team category renders field diff (old/new)

// INV-D02-3: User category redacts passwordHash

describe("INV-D02-3: user category redacts passwordHash", () => {
  test("passwordHash value is not exposed in summary mode", () => {
    renderAuditRow(
      <AuditRowDiffCell
        entry={makeEntry(
          "user",
          { email: "alice@example.com", passwordHash: "bcrypt$abc123" },
          null,
        )}
      />,
    );
    expect(screen.getByText("Password hash")).toBeTruthy();
    expect(screen.queryByText(/bcrypt/)).toBeNull();
  });

  test("email field name remains visible for user entry", () => {
    renderAuditRow(
      <AuditRowDiffCell
        entry={makeEntry(
          "user",
          { email: "alice@example.com", passwordHash: "secret" },
          null,
        )}
      />,
    );
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.queryByText(/alice@example\.com/)).toBeNull();
  });
});

// INV-D02-4: Unknown category falls back to generic KV renderer

describe("INV-D02-4: unknown category falls back to generic KV renderer", () => {
  test("renders changed fields for unknown category", () => {
    renderAuditRow(
      <AuditRowDiffCell
        entry={makeEntry("unknown-xyz", null, { key: "someValue" })}
      />,
    );
    expect(screen.getByText(/new:/)).toBeTruthy();
    expect(screen.getByText("Key")).toBeTruthy();
    expect(screen.queryByText(/someValue/)).toBeNull();
  });

  test("verbose inline mode is opt-in for diagnostic surfaces", () => {
    renderAuditRow(
      <AuditRowDiffCell
        mode="inline"
        entry={makeEntry("unknown-xyz", null, { key: "someValue" })}
      />,
    );
    expect(screen.getByText(/someValue/)).toBeTruthy();
  });
});
