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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocks

const mockRevalidate = vi.fn().mockResolvedValue(undefined);
const mockAssignTemplateToWorkspace = vi.fn().mockResolvedValue({});
const mockRemoveTemplateAssignment = vi.fn().mockResolvedValue({});
const mockTriggerTemplateDriftScan = vi.fn().mockResolvedValue({});
const mockApplyTemplateManualUpdate = vi.fn().mockResolvedValue({});
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

const mockQueryData: Record<string, any> = {};

vi.mock("./api", () => ({
  assignTemplateToWorkspace: (...args: any[]) =>
    mockAssignTemplateToWorkspace(...args),
  removeTemplateAssignment: (...args: any[]) =>
    mockRemoveTemplateAssignment(...args),
  triggerTemplateDriftScan: (...args: any[]) =>
    mockTriggerTemplateDriftScan(...args),
  useApplyTemplateManualUpdateMutation: () => ({
    trigger: mockApplyTemplateManualUpdate,
    isMutating: false,
  }),
  useTemplateCatalogQuery: () => ({
    entries: [
      { id: "tpl-1", title: "Template One", slug: "tpl-one", source: "Bundle" },
      { id: "tpl-2", title: "Template Two", slug: "tpl-two", source: "Bundle" },
    ],
  }),
  useTemplateAssignmentsQuery: () => ({
    assignments: mockQueryData.assignments ?? [
      {
        id: "assign-1",
        templateId: "tpl-1",
        selectionMode: "PUBLISHED",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
        updatedAt: "2026-01-15T00:00:00Z",
      },
      {
        id: "assign-2",
        templateId: "tpl-2",
        selectionMode: "PINNED_REVISION",
        provisioningMode: "MANAGED_UNTIL_LOCAL_EDIT",
        isEnabled: false,
        updatedAt: "2026-01-10T00:00:00Z",
      },
    ],
  }),
  useTemplateRevisionsQuery: () => ({
    revisions: mockQueryData.revisions ?? [
      { id: "rev-b", version: "2.0.0", state: "Published" },
      { id: "rev-a", version: "1.0.0", state: "Deprecated" },
    ],
  }),
  useWorkspaceTemplateInstancesQuery: () => ({
    instances: mockQueryData.instances ?? [],
  }),
  useTemplateRegistryRevalidate: () => ({
    revalidateAssignments: mockRevalidate,
    revalidateWorkspaceInstances: mockRevalidate,
  }),
}));

let confirmDialogInstances: any[] = [];

vi.mock("../../components/shared/admin-confirm-modal", () => ({
  AdminConfirmModal: ({
    open,
    title,
    description,
    onConfirm,
    confirmText,
    danger,
  }: any) => {
    if (open) {
      confirmDialogInstances.push({
        title,
        onConfirm,
        confirmText,
        danger,
      });
    }
    return open ? (
      <div
        data-testid={`admin-confirm-modal-${title.replace(/\s+/g, "-").toLowerCase()}`}
      >
        <div data-testid="admin-confirm-modal-title">{title}</div>
        <div>{description}</div>
        <button
          data-testid={`confirm-btn-${title.replace(/\s+/g, "-").toLowerCase()}`}
          onClick={onConfirm}
        >
          {confirmText}
        </button>
      </div>
    ) : null;
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

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    notify: notifyMock,
    Select: ({
      data = [],
      value,
      onChange,
      id,
      placeholder,
      ...props
    }: any) => (
      <select
        id={id}
        aria-label={props["aria-label"] ?? placeholder}
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || null)}
      >
        <option value="">{placeholder}</option>
        {data.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

// Import after mocks

import { AssignmentsTab } from "./assignments-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("AssignmentsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmDialogInstances = [];
    mockAssignTemplateToWorkspace.mockReset();
    mockAssignTemplateToWorkspace.mockResolvedValue({});
    mockRemoveTemplateAssignment.mockReset();
    mockRemoveTemplateAssignment.mockResolvedValue({});
    mockTriggerTemplateDriftScan.mockReset();
    mockTriggerTemplateDriftScan.mockResolvedValue({});
    mockApplyTemplateManualUpdate.mockReset();
    mockApplyTemplateManualUpdate.mockResolvedValue({});
    mockRevalidate.mockReset();
    mockRevalidate.mockResolvedValue(undefined);
    delete mockQueryData.assignments;
    delete mockQueryData.instances;
    delete mockQueryData.revisions;
  });

  afterEach(() => {
    cleanup();
  });

  test("confirming remove calls mutation and shows toast", async () => {
    mockRemoveTemplateAssignment.mockResolvedValueOnce({
      admin: { removeTemplateAssignment: true },
    });

    renderWithFacade(<AssignmentsTab />);
    const input = screen.getByPlaceholderText(
      "Search workspace by name, owner or ID...",
    );
    fireEvent.change(input, { target: { value: "ws-123" } });
    fireEvent.click(screen.getByText("Search"));

    // Click remove on first assignment
    const removeButtons = screen.getAllByText("Remove");
    fireEvent.click(removeButtons[0]);

    // Confirm
    fireEvent.click(screen.getByTestId("confirm-btn-remove-assignment"));

    await waitFor(() => {
      expect(mockRemoveTemplateAssignment).toHaveBeenCalledWith("assign-1");
    });
    await waitFor(() => {
      expect(notifyMock.success).toHaveBeenCalledWith({
        title: "Assignment removed successfully.",
      });
    });
  });

  test("confirming drift scan calls mutation and shows toast", async () => {
    mockTriggerTemplateDriftScan.mockResolvedValueOnce({
      admin: { triggerDriftScan: true },
    });

    renderWithFacade(<AssignmentsTab />);
    const input = screen.getByPlaceholderText(
      "Search workspace by name, owner or ID...",
    );
    fireEvent.change(input, { target: { value: "ws-123" } });
    fireEvent.click(screen.getByText("Search"));

    fireEvent.click(screen.getByText("Trigger Drift Scan"));
    fireEvent.click(screen.getByTestId("confirm-btn-trigger-drift-scan"));

    await waitFor(() => {
      expect(mockTriggerTemplateDriftScan).toHaveBeenCalledWith("ws-123");
    });
    await waitFor(() => {
      expect(notifyMock.success).toHaveBeenCalledWith({
        title: "Drift scan triggered successfully.",
      });
    });
  });

  test("applies the selected successor only after explicit manual-update intent", async () => {
    mockQueryData.assignments = [
      {
        id: "assign-1",
        templateId: "tpl-1",
        selectionMode: "Published",
        provisioningMode: "ManualUpdate",
        isEnabled: true,
        updatedAt: "2026-01-15T00:00:00Z",
      },
    ];
    mockQueryData.instances = [
      {
        id: "instance-1",
        templateId: "tpl-1",
        revisionId: "rev-a",
        state: "UpdateAvailable",
      },
    ];

    renderWithFacade(<AssignmentsTab />);
    fireEvent.change(
      screen.getByPlaceholderText("Search workspace by name, owner or ID..."),
      { target: { value: "ws-123" } },
    );
    fireEvent.click(screen.getByText("Search"));
    fireEvent.click(await screen.findByText("Apply update"));

    await waitFor(() => {
      expect(mockApplyTemplateManualUpdate).toHaveBeenCalledWith({
        workspaceId: "ws-123",
        templateId: "tpl-1",
        revisionId: "rev-b",
      });
    });
    expect(notifyMock.success).toHaveBeenCalledWith({
      title: "Template update applied.",
    });
  });

  test("carries the selected revision when assigning a pinned template", async () => {
    renderWithFacade(<AssignmentsTab />);
    fireEvent.change(
      screen.getByPlaceholderText("Search workspace by name, owner or ID..."),
      { target: { value: "ws-123" } },
    );
    fireEvent.click(screen.getByText("Search"));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Assign to Workspace" })[0],
    );

    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "tpl-1" },
    });
    fireEvent.change(screen.getByLabelText("Selection Mode"), {
      target: { value: "PinnedRevision" },
    });
    fireEvent.change(screen.getByLabelText("Pinned revision"), {
      target: { value: "rev-a" },
    });
    fireEvent.click(
      screen.getByTestId("confirm-btn-assign-template-to-workspace"),
    );

    await waitFor(() => {
      expect(mockAssignTemplateToWorkspace).toHaveBeenCalledWith({
        workspaceId: "ws-123",
        templateId: "tpl-1",
        provisioningMode: "SeedOnce",
        selectionMode: "PinnedRevision",
        selectedRevisionId: "rev-a",
      });
    });
  });
});
