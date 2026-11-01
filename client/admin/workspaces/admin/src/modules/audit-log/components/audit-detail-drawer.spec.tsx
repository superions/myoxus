import type * as React from "react";
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "admin.common.close": "Close",
        "admin.audit-log.detail.title": "Entry details",
        "admin.audit-log.detail.copy": "Copy JSON",
        "admin.audit-log.detail.copied": "Copied!",
        "admin.audit-log.detail.event-key": "Event key",
        "admin.audit-log.detail.created-at": "Created at",
        "admin.audit-log.detail.actor": "Actor",
        "admin.audit-log.detail.target": "Target",
        "admin.audit-log.detail.old-value": "Old value",
        "admin.audit-log.detail.new-value": "New value",
        "admin.audit-log.detail.metadata": "Metadata",
        "admin.audit-log.systemChange": "System",
        "admin.audit-log.actor.kind.api_key": "API key",
        "admin.audit-log.actor.kind.system": "System",
        "admin.audit-log.actor.kind.user": "User",
        "admin.audit-log.filter.targetType.mcp_api_key": "MCP API key",
        "admin.audit-log.event-key.organization__unit__upsert":
          "Organizational unit saved",
      })[key] ?? key,
  }),
}));

import { AuditDetailDrawer } from "./audit-detail-drawer";

function renderDrawer(ui: React.ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const entry = {
  id: "audit-1",
  eventKey: "organization.unit.upsert",
  category: "organization",
  createdAt: "2026-05-04T10:00:00Z",
  actor: { id: "u-1", label: "Ada Admin" },
  target: { id: "ou-1", type: "organization_unit", label: "Marketing" },
  oldValue: { name: "Old", passwordHash: "bcrypt$secret" },
  newValue: { name: "New", passwordHash: "bcrypt$new-secret" },
  metadata: { requestId: "req-1", apiToken: "raw-token" },
};

describe("AuditDetailDrawer", () => {
  test("copy action exports redacted audit envelope", async () => {
    renderDrawer(
      <AuditDetailDrawer entry={entry as never} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("***redacted***"),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("bcrypt"),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("raw-token"),
    );
  });
});
