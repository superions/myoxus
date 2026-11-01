import type { ReactElement } from "react";
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

// Shared mocks

vi.mock("./api", () => ({
  archiveTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  enableTemplate: vi.fn().mockResolvedValue({}),
  bumpBuilderVersion: vi.fn(),
  assignTemplateToWorkspace: vi.fn().mockResolvedValue({}),
  removeTemplateAssignment: vi.fn().mockResolvedValue({}),
  triggerTemplateDriftScan: vi.fn().mockResolvedValue({}),
  useTemplateCatalogQuery: () => ({
    entries: [
      {
        id: "tpl-1",
        slug: "onboarding",
        title: "Onboarding",
        category: "hr",
        status: "ACTIVE",
        tags: [],
      },
    ],
    totalCount: 1,
  }),
  useTemplateAssignmentsQuery: () => ({
    assignments: [
      {
        id: "assign-1",
        templateId: "tpl-1",
        selectionMode: "PUBLISHED",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  }),
  useTemplateRevisionsQuery: () => ({ revisions: [] }),
  useWorkspaceTemplateInstancesQuery: () => ({ instances: [] }),
  useTemplateRegistryRevalidate: () => ({
    revalidateCatalog: vi.fn().mockResolvedValue(undefined),
    revalidateAssignments: vi.fn().mockResolvedValue(undefined),
    revalidateJobs: vi.fn().mockResolvedValue(undefined),
    revalidateWorkspaceInstances: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../hooks/mutate-with-toast", () => ({
  mutateWithToast: async (fn: () => Promise<any>) => {
    return fn();
  },
}));

vi.mock("../../components/domain-pickers", () => ({
  WorkspacePicker: ({ value, onChange, placeholder }: any) => (
    <input
      aria-label="Workspace picker"
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value || null)}
    />
  ),
}));

import { AssignmentsTab } from "./assignments-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("Template A11y — AdminConfirmModal semantics", () => {
  afterEach(() => {
    cleanup();
  });

  test('AssignmentsTab — Remove dialog has role="dialog" and accessible labeling', async () => {
    renderWithFacade(<AssignmentsTab />);
    const input = screen.getByPlaceholderText(
      "Search workspace by name, owner or ID...",
    );
    fireEvent.change(input, { target: { value: "ws-a11y-1" } });
    fireEvent.click(screen.getByText("Search"));

    // Open remove dialog
    const removeBtn = screen.getAllByText("Remove")[0];
    fireEvent.click(removeBtn);

    // Mantine registers its title and description after mounting the portal.
    // Wait for the accessible name, not merely the role, before checking both links.
    const dialog = await screen.findByRole("dialog", {
      name: "Remove Assignment",
      description:
        /Remove this central assignment\? Reusable template sources are permanently deleted\. Ordinary guides and documents previously created from templates remain unchanged\./,
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
