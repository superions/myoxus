/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const useQueryMock = vi.fn();

vi.mock("../../use-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "admin.audit-log.title": "Audit Log",
        "admin.audit-log.description": "Audit description",
        "admin.audit-log.empty": "No audit log entries.",
        "admin.audit-log.systemChange": "System",
        "admin.audit-log.actor.kind.api_key": "API key",
        "admin.audit-log.actor.kind.system": "System",
        "admin.audit-log.actor.kind.user": "User",
        "admin.audit-log.previous": "Previous",
        "admin.audit-log.next": "Next",
        "admin.audit-log.filter.title": "Forensic filters",
        "admin.audit-log.filter.description": "Server filters",
        "admin.audit-log.filter.active": "Active filters",
        "admin.audit-log.filter.category.label": "Category",
        "admin.audit-log.filter.category.all": "All categories",
        "admin.audit-log.filter.actor.label": "Actor",
        "admin.audit-log.filter.actor.placeholder": "Search actor\u2026",
        "admin.audit-log.filter.actor.selected": "Selected actor ID",
        "admin.audit-log.filter.target.label": "Target",
        "admin.audit-log.filter.target.placeholder": "Search target\u2026",
        "admin.audit-log.filter.targetType.label": "Target type",
        "admin.audit-log.filter.targetType.all": "All target types",
        "admin.audit-log.filter.targetType.workspace": "Workspace",
        "admin.audit-log.filter.targetType.user": "User",
        "admin.audit-log.filter.targetType.organization_unit":
          "Organization unit",
        "admin.audit-log.filter.targetType.template": "Template",
        "admin.audit-log.filter.targetType.document": "Document",
        "admin.audit-log.filter.targetType.mcp_api_key": "MCP API key",
        "admin.audit-log.filter.targetType.pdf_export_config":
          "PDF export config",
        "admin.audit-log.filter.targetType.config": "Config",
        "admin.audit-log.filter.targetUnit.preset": "Preset unit filter",
        "admin.audit-log.filter.eventKey.label": "Event key",
        "admin.audit-log.filter.eventKey.placeholder": "Event key prefix\u2026",
        "admin.audit-log.filter.datetime.placeholder": "YYYY-MM-DD HH:MM",
        "admin.audit-log.filter.from.label": "From",
        "admin.audit-log.filter.to.label": "To",
        "admin.audit-log.filter.preset.today": "Today",
        "admin.audit-log.filter.preset.last24h": "Last 24h",
        "admin.audit-log.filter.preset.last7d": "Last 7 days",
        "admin.audit-log.filter.preset.last30d": "Last 30 days",
        "admin.audit-log.filter.reset": "Reset",
        "admin.audit-log.col.time": "Time",
        "admin.audit-log.col.category": "Category",
        "admin.audit-log.col.actor": "Actor",
        "admin.audit-log.col.eventKey": "Event",
        "admin.audit-log.col.target": "Target",
        "admin.audit-log.col.diff": "Change",
        "admin.audit-log.category.config": "Config",
        "admin.audit-log.category.auth": "Auth",
        "admin.audit-log.category.organization": "Organization",
        "admin.audit-log.category.user": "User",
        "admin.audit-log.category.workspace": "Workspace",
        "admin.audit-log.category.document": "Document",
        "admin.audit-log.category.template": "Template",
        "admin.audit-log.category.feature": "Feature",
        "admin.audit-log.category.cache": "Cache",
        "admin.audit-log.category.logging": "Logging",
        "admin.audit-log.category.document_version": "Document versions",
        "admin.audit-log.category.pdf_export_config": "PDF export config",
        "admin.audit-log.category.mcp": "MCP",
        "admin.audit-log.event-key.config__update": "Configuration changed",
        "admin.audit-log.event-key.organization__policy__update":
          "Organization policy changed",
        "admin.audit-log.event-key.workspace__update": "Workspace changed",
        "admin.audit-log.event-key.document__delete_permanent":
          "Document permanently deleted",
        "admin.audit-log.event-key.mcp__api_key__create": "MCP API key created",
        "admin.audit-log.event-key.mcp__api_key__revoke": "MCP API key revoked",
        "admin.audit-log.event-key.mcp__doc__create": "MCP document created",
        "admin.audit-log.detail.title": "Entry Details",
        "admin.audit-log.detail.copy": "Copy JSON",
        "admin.audit-log.detail.copied": "Copied!",
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock("@myoxus/graphql", () => ({
  adminAuditLogQuery: "mock-audit-log-query",
}));

vi.mock("../../components/domain-pickers", () => ({
  UserPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string | null) => void;
  }) => {
    const [query, setQuery] = useState(value ?? "");
    return (
      <input
        aria-label="Actor"
        data-testid="audit-log-actor-picker"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          onChange(event.currentTarget.value || null);
        }}
      />
    );
  },
}));

vi.mock("../header", () => ({
  Header: ({ title, endFix }: { title: string; endFix?: React.ReactNode }) => (
    <div>
      <h1 data-testid="page-title">{title}</h1>
      <div data-testid="header-endfix">{endFix}</div>
    </div>
  ),
}));

// Shim for AuditDetailDrawer — avoids portal issues in happy-dom
vi.mock("./components/audit-detail-drawer", () => ({
  AuditDetailDrawer: ({
    entry,
    onClose,
  }: {
    entry: { id: string; eventKey: string } | null;
    onClose: () => void;
  }) =>
    entry ? (
      <div data-testid="audit-detail-drawer">
        <span data-testid="drawer-event-key">{entry.eventKey}</span>
        <button data-testid="drawer-close" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}));

// ── Import under test ────────────────────────────────────────────────────────

import { AuditLogPage } from "./index";

function renderAuditLogPage(initialEntry = "/adminfrontend/audit-log") {
  return render(
    <MyoxusUIProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuditLogPage />
      </MemoryRouter>
    </MyoxusUIProvider>,
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const makeEntry = (
  id: string,
  eventKey: string,
  category: string,
  actorLabel: string | null,
  targetLabel: string,
) => ({
  id,
  eventKey,
  category,
  target: { id: `tgt-${id}`, type: category, label: targetLabel },
  actor: actorLabel !== null ? { id: "u-1", label: actorLabel } : null,
  createdAt: "2026-04-17T10:00:00Z",
  oldValue: null,
  newValue: { value: "updated" },
  metadata: null,
});

const mockEntries = [
  makeEntry(
    "e-1",
    "config.update",
    "config",
    "admin@myoxus.local",
    "auth.allowSignup",
  ),
  makeEntry(
    "e-2",
    "organization.policy.update",
    "organization",
    "admin@myoxus.local",
    "Alpha",
  ),
  makeEntry("e-3", "workspace.update", "workspace", null, "Bobby"),
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AuditLogPage", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  test("inv_audit_ui_target_fallback — uuid targets are shortened behind a localized type", () => {
    useQueryMock.mockReturnValue({
      data: {
        admin: {
          adminAuditLog: [
            {
              ...makeEntry(
                "e-uuid",
                "pdf_workspace.set_default",
                "pdf_export_config",
                "admin@myoxus.local",
                "ignored",
              ),
              target: {
                id: "f0b80254-faeb-4447-8dff-ecd675c5ac70",
                type: "pdf_export_config",
                label: null,
              },
            },
          ],
          adminAuditLogCount: 1,
        },
      },
    });
    renderAuditLogPage();
    expect(
      screen.getByText("PDF export config · f0b80254…c5ac70"),
    ).toBeTruthy();
    expect(
      screen.queryByText("f0b80254-faeb-4447-8dff-ecd675c5ac70"),
    ).toBeNull();
  });

  test("inv_audit_ui_humanizes_unknown_event_keys — fallback stays user-readable", () => {
    useQueryMock.mockReturnValue({
      data: {
        admin: {
          adminAuditLog: [
            makeEntry(
              "e-unknown",
              "config.auth.allowSignup.update",
              "config",
              "admin@myoxus.local",
              "auth.allowSignup",
            ),
          ],
          adminAuditLogCount: 1,
        },
      },
    });
    renderAuditLogPage();
    expect(
      screen.getByText("Config · Auth · AllowSignup · Update"),
    ).toBeTruthy();
    expect(screen.queryByText("config.auth.allowSignup.update")).toBeNull();
  });

  test("inv_audit_ui_category_filter — document-version category passes filter to query", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: [], adminAuditLogCount: 0 } },
    });
    renderAuditLogPage();
    fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
    fireEvent.click(screen.getByRole("option", { name: "Document versions" }));
    const lastCall =
      useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(lastCall[0].variables.filter.category).toBe("document_version");
  });

  test("inv_audit_ui_actor_filter — actor picker passes actorUserId to query", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: mockEntries, adminAuditLogCount: 3 } },
    });
    renderAuditLogPage();
    const input = screen.getByLabelText("Actor") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "u-admin" } });
    const lastCall =
      useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(lastCall[0].variables.filter.actorUserId).toBe("u-admin");
  });

  test("inv_audit_ui_target_type_filter — target id requires target type", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: [], adminAuditLogCount: 0 } },
    });
    renderAuditLogPage();
    expect(screen.queryByRole("textbox", { name: "Target" })).toBeNull();
    let lastCall = useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(lastCall[0].variables.filter.targetId).toBeUndefined();

    fireEvent.click(screen.getByRole("combobox", { name: "Target type" }));
    fireEvent.click(screen.getByRole("option", { name: "Workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Target" }), {
      target: { value: "workspace-1" },
    });
    lastCall = useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(lastCall[0].variables.filter.targetType).toBe("workspace");
    expect(lastCall[0].variables.filter.targetId).toBe("workspace-1");
  });

  test("inv_audit_ui_url_presets — actor and unit URL params prefill server filters", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: [], adminAuditLogCount: 0 } },
    });
    renderAuditLogPage(
      "/adminfrontend/audit-log?actor_user_id=u-1&target_unit_id=ou-1",
    );
    const firstCall = useQueryMock.mock.calls[0];
    expect(firstCall[0].variables.filter.actorUserId).toBe("u-1");
    expect(firstCall[0].variables.filter.targetUnitId).toBe("ou-1");
    expect(firstCall[0].variables.filter.targetType).toBe("organization_unit");
  });

  test("inv_audit_ui_reset_clears_filters — Reset button restores empty filter state", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: [], adminAuditLogCount: 0 } },
    });
    renderAuditLogPage();
    fireEvent.change(screen.getByLabelText("Actor"), {
      target: { value: "u-admin" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
    fireEvent.click(screen.getByRole("option", { name: "Config" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    const lastCall =
      useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(lastCall[0].variables.filter.category).toBeUndefined();
    expect(lastCall[0].variables.filter.actorUserId).toBeUndefined();
    expect((screen.getByLabelText("Actor") as HTMLInputElement).value).toBe("");
  });

  test("inv_audit_ui_prev_disabled_on_first_page — Previous disabled at offset=0", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: mockEntries, adminAuditLogCount: 3 } },
    });
    renderAuditLogPage();
    const prevBtn = screen.getByRole("button", {
      name: "Previous",
    }) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  test("inv_audit_ui_next_disabled_below_page_size — Next disabled when < 50 results", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: mockEntries, adminAuditLogCount: 3 } },
    });
    renderAuditLogPage();
    const nextBtn = screen.getByRole("button", {
      name: "Next",
    }) as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  test("inv_audit_ui_row_click_opens_detail_drawer — clicking a row opens the detail drawer", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: mockEntries, adminAuditLogCount: 3 } },
    });
    renderAuditLogPage();
    // No drawer visible initially
    expect(screen.queryByTestId("audit-detail-drawer")).toBeNull();
    // Click the first row by its localized label; raw keys are reserved for details.
    fireEvent.click(screen.getByText("Configuration changed"));
    expect(screen.getByTestId("drawer-event-key").textContent).toBe(
      "config.update",
    );
  });

  test("inv_audit_ui_drawer_close_hides_drawer — closing the drawer removes it", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: mockEntries, adminAuditLogCount: 3 } },
    });
    renderAuditLogPage();
    fireEvent.click(screen.getByText("Configuration changed"));
    expect(screen.getByTestId("audit-detail-drawer")).toBeTruthy();
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(screen.queryByTestId("audit-detail-drawer")).toBeNull();
  });

  test("inv_audit_ui_preset_last24h_sets_from_filter — Last 24h preset populates from filter", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: [], adminAuditLogCount: 0 } },
    });
    renderAuditLogPage();
    fireEvent.click(screen.getByText("Last 24h"));
    const lastCall =
      useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    const { from, to } = lastCall[0].variables.filter;
    expect(Date.parse(to) - Date.parse(from)).toBe(24 * 60 * 60 * 1000);
    expect(Math.abs(Date.now() - Date.parse(to))).toBeLessThan(60_000);
  });

  test("inv_audit_ui_datetime_filters_ignore_invalid_values — invalid text never crashes query construction", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: [], adminAuditLogCount: 0 } },
    });
    renderAuditLogPage();

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "not a date" },
    });
    const lastCall =
      useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(lastCall[0].variables.filter.from).toBeUndefined();
  });

  test("inv_audit_ui_reset_clears_time_range — Reset clears from/to inputs", () => {
    useQueryMock.mockReturnValue({
      data: { admin: { adminAuditLog: [], adminAuditLogCount: 0 } },
    });
    renderAuditLogPage();
    fireEvent.click(screen.getByText("Today"));
    // After preset, from/to should be in filter
    const afterPreset =
      useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(afterPreset[0].variables.filter.from).toBeTruthy();
    // Now reset
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    const afterReset =
      useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1];
    expect(afterReset[0].variables.filter.from).toBeUndefined();
    expect(afterReset[0].variables.filter.to).toBeUndefined();
  });
});
