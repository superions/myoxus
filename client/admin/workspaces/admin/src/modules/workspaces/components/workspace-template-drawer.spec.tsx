import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import userEvent from "@testing-library/user-event";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockAssignTrigger = vi.fn().mockResolvedValue({});
const mockRemoveTrigger = vi.fn().mockResolvedValue({});
const mockReconcileTrigger = vi.fn().mockResolvedValue({});
const mockRevalidate = vi.fn().mockResolvedValue(undefined);
const mockAssignmentsState: { assignments: any[] } = { assignments: [] };
const mockLoad = vi.fn().mockResolvedValue(undefined);
const mockResourceState = {
  queryId: "",
  error: null as Error | null,
  isLoading: false,
};
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("../../../use-query", () => ({
  useQuery: ({ query }: any) => {
    const queryId = query?.id ?? "";
    const resource = {
      error:
        queryId === mockResourceState.queryId ? mockResourceState.error : null,
      isLoading:
        queryId === mockResourceState.queryId && mockResourceState.isLoading,
      mutate: mockLoad,
    };
    if (queryId === "templateCatalogQuery") {
      return {
        ...resource,
        data: {
          admin: {
            templateCatalog: [
              {
                id: "tpl-1",
                title: "Weekly Standup",
                description: "Template",
                category: "work",
                status: "ACTIVE",
              },
            ],
          },
        },
      };
    }

    if (queryId === "templateAssignmentsQuery") {
      return {
        ...resource,
        data: {
          admin: {
            templateAssignments: mockAssignmentsState.assignments,
          },
        },
      };
    }

    if (queryId === "workspaceTemplateInstancesQuery") {
      return {
        ...resource,
        data: {
          admin: {
            workspaceTemplateInstances: [
              {
                id: "inst-1",
                templateId: "tpl-1",
                revisionId: "rev-1",
                state: "OK",
                lastSyncedAt: null,
                lastErrorMessage: null,
              },
            ],
          },
        },
      };
    }

    return { data: {} };
  },
}));

vi.mock("../../../use-mutation", () => ({
  useMutateQueryResource: () => mockRevalidate,
  useMutation: ({ mutation }: any) => {
    if (mutation?.id === "assignTemplateToWorkspaceMutation") {
      return {
        trigger: (...args: any[]) => mockAssignTrigger(...args),
        isMutating: false,
      };
    }
    if (mutation?.id === "adminRetireTemplateAssignmentMutation") {
      return {
        trigger: (...args: any[]) => mockRemoveTrigger(...args),
        isMutating: false,
      };
    }
    if (mutation?.id === "triggerReconcileMutation") {
      return {
        trigger: (...args: any[]) => mockReconcileTrigger(...args),
        isMutating: false,
      };
    }
    return { trigger: vi.fn(), isMutating: false };
  },
}));

vi.mock("@myoxus/admin/notifications", () => ({
  adminToast: {
    success: (...args: any[]) => toastSuccessMock(...args),
    error: (...args: any[]) => toastErrorMock(...args),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { WorkspaceTemplateDrawer } from "./workspace-template-drawer";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("WorkspaceTemplateDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssignTrigger.mockReset().mockResolvedValue({});
    mockAssignmentsState.assignments = [];
    mockResourceState.queryId = "";
    mockResourceState.error = null;
    mockResourceState.isLoading = false;
  });

  afterEach(() => {
    cleanup();
  });

  test("assign action sends GraphQL-compatible enum values", async () => {
    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Assign"));
    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(mockAssignTrigger).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        templateId: "tpl-1",
        provisioningMode: "SeedOnce",
        selectionMode: "Published",
      });
    });
  });

  test("remove and reconcile actions are wired on assigned tab", async () => {
    mockAssignmentsState.assignments = [
      {
        id: "assign-1",
        templateId: "tpl-1",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
      },
    ];

    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    const assignedTab = screen.getByRole("tab", { name: "Assigned" });
    fireEvent.mouseDown(assignedTab, { button: 0, ctrlKey: false });
    fireEvent.click(assignedTab);
    await screen.findByText("Reconcile Now");
    fireEvent.click(screen.getByText("Reconcile Now"));
    fireEvent.click(screen.getByText("Remove"));
    const dialogs = await waitFor(() => {
      const openDialogs = screen.getAllByRole("dialog");
      expect(openDialogs).toHaveLength(2);
      return openDialogs;
    });
    const confirmationActions = within(dialogs[1]).getAllByRole("button");
    fireEvent.click(confirmationActions[confirmationActions.length - 1]);

    await waitFor(() => {
      expect(mockReconcileTrigger).toHaveBeenCalledWith({
        workspaceId: "ws-1",
      });
      expect(mockRemoveTrigger).toHaveBeenCalledWith({
        policyId: "assign-1",
      });
    });
  });

  test("escape key closes the sheet via onOpenChange", async () => {
    const onOpenChange = vi.fn();
    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("assigned tab can be activated via keyboard", async () => {
    mockAssignmentsState.assignments = [
      {
        id: "assign-1",
        templateId: "tpl-1",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
      },
    ];

    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    const assignedTab = screen.getByRole("tab", { name: "Assigned" });
    assignedTab.focus();
    fireEvent.keyDown(assignedTab, { key: "Enter" });

    await screen.findByText("Reconcile Now");
  });

  test("assign error keeps confirm action available for retry", async () => {
    mockAssignTrigger
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({});

    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Assign"));
    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(mockAssignTrigger).toHaveBeenCalledTimes(2);
      expect(toastSuccessMock).toHaveBeenCalled();
    });
  });

  test("reconcile failures surface error feedback", async () => {
    mockAssignmentsState.assignments = [
      {
        id: "assign-1",
        templateId: "tpl-1",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
      },
    ];
    mockReconcileTrigger.mockRejectedValueOnce(new Error("reconcile failed"));

    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    const assignedTab = screen.getByRole("tab", { name: "Assigned" });
    fireEvent.mouseDown(assignedTab, { button: 0, ctrlKey: false });
    fireEvent.click(assignedTab);
    await screen.findByText("Reconcile Now");
    fireEvent.click(screen.getByText("Reconcile Now"));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("Failed to trigger reconciliation"),
      );
    });
  });

  // "Change Policy" flow — INV: Existing assignment can have its provisioning
  // mode updated without removing and re-assigning.

  test("change policy cancel hides the inline editor", async () => {
    mockAssignmentsState.assignments = [
      {
        id: "assign-1",
        templateId: "tpl-1",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
      },
    ];

    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    const assignedTab = screen.getByRole("tab", { name: "Assigned" });
    fireEvent.mouseDown(assignedTab, { button: 0, ctrlKey: false });
    fireEvent.click(assignedTab);
    await screen.findByText("Change Policy");

    fireEvent.click(screen.getByText("Change Policy"));
    expect(screen.getByText("Save Changes")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));

    // Editor is gone, Change Policy button is back
    expect(screen.queryByText("Save Changes")).toBeNull();
    expect(screen.getByText("Change Policy")).toBeTruthy();
  });

  test("change policy save calls assign mutation with new mode and shows toast", async () => {
    mockAssignmentsState.assignments = [
      {
        id: "assign-1",
        templateId: "tpl-1",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
      },
    ];
    mockAssignTrigger.mockResolvedValueOnce({});

    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    const assignedTab = screen.getByRole("tab", { name: "Assigned" });
    await userEvent.click(assignedTab);
    await screen.findByText("Change Policy");

    await userEvent.click(screen.getByText("Change Policy"));
    await screen.findByText("Save Changes");

    const mode = screen.getByRole("combobox", {
      name: "Select new provisioning mode",
    });
    await userEvent.click(mode);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect((mode as HTMLInputElement).value).toBe("Manual Update");
    fireEvent.click(screen.getByText("Save Changes"));

    await waitFor(() => {
      expect(mockAssignTrigger).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        templateId: "tpl-1",
        provisioningMode: "ManualUpdate",
        selectionMode: "Published",
      });
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringContaining("updated to ManualUpdate"),
      );
    });
  });

  test("change policy save failure shows error toast", async () => {
    mockAssignmentsState.assignments = [
      {
        id: "assign-1",
        templateId: "tpl-1",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
      },
    ];
    mockAssignTrigger.mockRejectedValueOnce(new Error("policy update failed"));

    renderWithFacade(
      <WorkspaceTemplateDrawer
        workspaceId="ws-1"
        open
        onOpenChange={vi.fn()}
      />,
    );

    const assignedTab = screen.getByRole("tab", { name: "Assigned" });
    fireEvent.mouseDown(assignedTab, { button: 0, ctrlKey: false });
    fireEvent.click(assignedTab);
    await screen.findByText("Change Policy");

    fireEvent.click(screen.getByText("Change Policy"));
    await screen.findByText("Save Changes");
    fireEvent.click(screen.getByText("Save Changes"));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("Failed to change policy"),
      );
    });
  });
});
