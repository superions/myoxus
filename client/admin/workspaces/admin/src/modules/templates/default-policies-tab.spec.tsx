import type { ReactElement } from "react";
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */
import { I18n } from "@myoxus/i18n";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockSetPolicy = vi.fn().mockResolvedValue({});
const mockRevalidateCatalog = vi.fn().mockResolvedValue(undefined);
const mockRevalidateDefaultPolicies = vi.fn().mockResolvedValue(undefined);
const mockPoliciesState: { policies: any[] } = { policies: [] };
const mockRevisionsState: { revisions: any[] } = { revisions: [] };
const mockCatalogState: { entries: any[] } = { entries: [] };

vi.mock("./api", () => ({
  useTemplateRevisionsQuery: () => mockRevisionsState,
  setTemplateDefaultPolicy: (...args: any[]) => mockSetPolicy(...args),
  useTemplateCatalogQuery: () => ({
    entries: mockCatalogState.entries,
  }),
  useTemplateDefaultPoliciesQuery: () => ({
    policies: mockPoliciesState.policies,
  }),
  useTemplateRegistryRevalidate: () => ({
    revalidateCatalog: mockRevalidateCatalog,
    revalidateDefaultPolicies: mockRevalidateDefaultPolicies,
  }),
}));

vi.mock("../../components/shared/admin-confirm-modal", () => ({
  AdminConfirmModal: ({ open, title, onConfirm, confirmText }: any) =>
    open ? (
      <div
        data-testid={`admin-confirm-modal-${title.replace(/\s+/g, "-").toLowerCase()}`}
      >
        <div>{title}</div>
        <button onClick={onConfirm}>{confirmText}</button>
      </div>
    ) : null,
}));

import { DefaultPoliciesTab } from "./default-policies-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("DefaultPoliciesTab", () => {
  beforeEach(async () => {
    await I18n.changeLanguage("en");
    vi.clearAllMocks();
    mockRevisionsState.revisions = [];
    mockCatalogState.entries = [
      {
        id: "tpl-open",
        title: "Open Template",
        slug: "open-template",
        source: "Bundle",
      },
      {
        id: "tpl-curated",
        title: "Curated Template",
        slug: "curated-template",
        source: "Bundle",
      },
      {
        id: "tpl-locked",
        title: "Locked Template",
        slug: "locked-template",
        source: "Bundle",
      },
    ];
    mockPoliciesState.policies = [
      {
        templateId: "tpl-open",
        applyToNewWorkspaces: false,
        selectionMode: "PUBLISHED",
        provisioningMode: "MANUAL_UPDATE",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      },
      {
        templateId: "tpl-curated",
        applyToNewWorkspaces: true,
        selectionMode: "PUBLISHED",
        provisioningMode: "SEED_ONCE",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      },
      {
        templateId: "tpl-locked",
        applyToNewWorkspaces: true,
        selectionMode: "PINNED_REVISION",
        provisioningMode: "MANAGED_UNTIL_LOCAL_EDIT",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
      },
    ];
  });

  afterEach(() => {
    cleanup();
  });

  test("opens confirmation before toggling default rollout", async () => {
    renderWithFacade(<DefaultPoliciesTab />);

    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    expect(
      screen.getByTestId("admin-confirm-modal-apply-to-new-workspaces"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(mockSetPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: "tpl-open",
          applyToNewWorkspaces: true,
        }),
      );
    });
  });
});
