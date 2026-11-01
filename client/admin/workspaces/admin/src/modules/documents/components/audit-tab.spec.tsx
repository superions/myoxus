/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => en[key] ?? key,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("@myoxus/graphql", () => ({
  AdminDocumentAuditGroupType: {
    document_lifecycle: "document_lifecycle",
    metadata_policy: "metadata_policy",
    status_schema: "status_schema",
    status_transition: "status_transition",
    document_type: "document_type",
    version_policy: "version_policy",
    workspace_settings: "workspace_settings",
    document_metadata: "document_metadata",
    document_version: "document_version",
    pdf_export: "pdf_export",
  },
}));

const auditQueryMock = vi.fn();

vi.mock("../api", () => ({
  useDocumentAuditLogQuery: (filter: unknown, pagination: unknown) => {
    auditQueryMock(filter, pagination);
    return {
      totalCount: 75,
      entries: Array.from({ length: 50 }, (_, index) => ({
        id: `audit-${index + 1}`,
        createdAt: "2026-05-04T10:00:00Z",
        group: "workspace_settings",
        eventKey: "document_metadata.workspace_settings.update",
        target: {
          id: "8e6f2d85-41fd-462a-9b51-6914bc6cbf47",
          type: "workspace",
          label: "Alpha workspace",
        },
      })),
    };
  },
}));

import { AuditTab } from "./audit-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

async function selectFacadeOption(
  label: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("AuditTab", () => {
  afterEach(() => {
    cleanup();
    auditQueryMock.mockReset();
  });

  test("renders document-domain audit entries and wires group filter", async () => {
    renderWithProvider(<AuditTab />);

    expect(screen.getByTestId("documents-audit-soft-list")).toBeTruthy();
    expect(
      screen.getAllByText("Workspace document settings updated").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Alpha workspace").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("document_metadata.workspace_settings.update"),
    ).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Event" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Time" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Target" })).toBeTruthy();
    expect(screen.getAllByText(/May 4, 2026/).length).toBeGreaterThan(0);
    expect(auditQueryMock).toHaveBeenLastCalledWith(
      {},
      { limit: 50, offset: 0 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(auditQueryMock).toHaveBeenLastCalledWith(
      {},
      { limit: 50, offset: 50 },
    );

    await selectFacadeOption("Document audit group", "Document lifecycle");

    expect(auditQueryMock).toHaveBeenLastCalledWith(
      {
        groups: ["document_lifecycle"],
      },
      { limit: 50, offset: 0 },
    );
  });
});
