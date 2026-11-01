import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { RevisionStateType } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocks: api.ts

const mockImportTemplateBundle = vi.fn();
const mockRevalidateCatalog = vi.fn().mockResolvedValue(undefined);
const mockRevalidateAssignments = vi.fn().mockResolvedValue(undefined);
const mockRevalidateRevisions = vi.fn().mockResolvedValue(undefined);
const mockPublishTrigger = vi.fn().mockResolvedValue({});
const mockAssign = vi.fn().mockResolvedValue({});
const mockRemove = vi.fn().mockResolvedValue({});
const mockDriftScan = vi.fn().mockResolvedValue({});
const mockBumpBuilderVersion = vi.fn().mockResolvedValue({
  admin: {
    bumpBuilderVersion: {
      slug: "test",
      newVersion: 2,
      workspacesNotified: 3,
    },
  },
});
const mockSetTemplateDefaultPolicy = vi.fn().mockResolvedValue({});
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

// Mutable catalog state used across tests
const catalogState: { entries: any[] } = { entries: [] };
// Mutable assignments state
const assignmentsState: { assignments: any[] } = { assignments: [] };
// Mutable revisions state
const revisionsState: { revisions: any[] } = { revisions: [] };

// Mutable default policies state
const policiesState: { policies: any[] } = { policies: [] };

vi.mock("./api", () => ({
  importTemplateBundle: (...args: any[]) => mockImportTemplateBundle(...args),
  assignTemplateToWorkspace: (...args: any[]) => mockAssign(...args),
  removeTemplateAssignment: (...args: any[]) => mockRemove(...args),
  triggerTemplateDriftScan: (...args: any[]) => mockDriftScan(...args),
  bumpBuilderVersion: (...args: any[]) => mockBumpBuilderVersion(...args),
  setTemplateDefaultPolicy: (...args: any[]) =>
    mockSetTemplateDefaultPolicy(...args),
  useTemplateCatalogQuery: () => ({
    entries: catalogState.entries,
    totalCount: catalogState.entries.length,
  }),
  useTemplateAssignmentsQuery: () => ({
    assignments: assignmentsState.assignments,
  }),
  useWorkspaceTemplateInstancesQuery: () => ({ instances: [] }),
  useTemplateRevisionsQuery: () => ({
    revisions: revisionsState.revisions,
  }),
  useTemplateDefaultPoliciesQuery: () => ({
    policies: policiesState.policies,
  }),
  usePublishRevisionMutation: () => ({
    trigger: (...args: any[]) => mockPublishTrigger(...args),
    isMutating: false,
  }),
  useTemplateRegistryRevalidate: () => ({
    revalidateCatalog: mockRevalidateCatalog,
    revalidateAssignments: mockRevalidateAssignments,
    revalidateRevisions: mockRevalidateRevisions,
    revalidateJobs: vi.fn().mockResolvedValue(undefined),
    revalidateWorkspaceInstances: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../components/shared/admin-confirm-modal", () => ({
  AdminConfirmModal: ({ open, title, onConfirm, confirmText }: any) =>
    open ? (
      <div data-testid={`dialog-${title.replace(/\s+/g, "-").toLowerCase()}`}>
        <span data-testid="dialog-title">{title}</span>
        <button data-testid="dialog-confirm" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

vi.mock("../../hooks/mutate-with-toast", () => ({
  mutateWithToast: async (fn: () => Promise<any>) => {
    const result = await fn();
    return result;
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
  return { ...actual, notify: notifyMock };
});

import { AssignmentsTab } from "./assignments-tab";

import { ImportTab } from "./import-tab";

import { VersionsTab } from "./versions-tab";

// Helper

function resetState() {
  catalogState.entries = [];
  assignmentsState.assignments = [];
  revisionsState.revisions = [];
  policiesState.policies = [];
  vi.clearAllMocks();
  mockRevalidateCatalog.mockResolvedValue(undefined);
  mockRevalidateAssignments.mockResolvedValue(undefined);
  mockRevalidateRevisions.mockResolvedValue(undefined);
  mockPublishTrigger.mockResolvedValue({});
  mockAssign.mockResolvedValue({});
  mockRemove.mockResolvedValue({});
  mockDriftScan.mockResolvedValue({});
  mockBumpBuilderVersion.mockResolvedValue({
    admin: {
      bumpBuilderVersion: {
        slug: "test",
        newVersion: 2,
        workspacesNotified: 3,
      },
    },
  });
  mockSetTemplateDefaultPolicy.mockResolvedValue({});
}

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function selectTemplateOption(optionName: string) {
  const trigger = screen.getByPlaceholderText("Select a template...");
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

// INV-TPL-01: Import → catalog updated

describe("INV-TPL-01: Import template bundle", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  test("successful import triggers catalog revalidation", async () => {
    mockImportTemplateBundle.mockResolvedValueOnce({
      admin: {
        importTemplate: {
          entry: { id: "new-tpl", title: "New Template", slug: "new-tpl" },
          revision: { id: "rev-1", version: "1.0.0", state: "VALIDATED" },
          warnings: [],
          metadata: {},
        },
      },
    });

    const { container } = renderWithFacade(<ImportTab />);
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["zip-bytes"], "my-template.zip", {
      type: "application/zip",
    });

    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByText("Upload & Validate"));

    await waitFor(() => {
      expect(mockImportTemplateBundle).toHaveBeenCalledWith(file);
    });
    await waitFor(() => {
      // INV-TPL-01: catalog must be revalidated after import
      expect(mockRevalidateCatalog).toHaveBeenCalledTimes(1);
    });
  });
});

// INV-TPL-06: Import error → structured error displayed

describe("INV-TPL-06: Import error — structured error display", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  test("import failure shows error state without touching catalog", async () => {
    const error = new Error("Invalid bundle format");
    Object.assign(error, {
      extensions: { data: JSON.stringify({ errors: [] }) },
    });
    mockImportTemplateBundle.mockRejectedValueOnce(error);

    const { container } = renderWithFacade(<ImportTab />);
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["bad"], "bad.zip", { type: "application/zip" });

    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByText("Upload & Validate"));

    await waitFor(() => {
      expect(screen.getByText("Import Failed")).toBeTruthy();
      // INV-TPL-06: catalog not revalidated on error
      expect(mockRevalidateCatalog).not.toHaveBeenCalled();
    });
  });
});

// INV-TPL-02: Publish Draft → state transitions to PUBLISHED

describe("INV-TPL-02: Publish revision", () => {
  beforeEach(() => {
    resetState();
    catalogState.entries = [
      { id: "tpl-1", title: "MyTemplate", slug: "my-template" },
    ];
    revisionsState.revisions = [
      {
        id: "rev-1",
        version: "1.0.0",
        state: RevisionStateType.Validated,
        publishedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
  });
  afterEach(cleanup);

  test("publish confirms dialog then calls mutation and revalidates catalog", async () => {
    renderWithFacade(<VersionsTab />);

    // Select template through the same combobox path a user uses after the
    // Facade/Mantine cut-over.
    await selectTemplateOption("MyTemplate (my-template)");

    // Click Publish
    await waitFor(() => {
      expect(screen.getByText("Publish")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Publish"));

    // Confirm dialog appears
    await waitFor(() => {
      expect(screen.getByTestId("dialog-publish-revision")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("dialog-confirm"));

    await waitFor(() => {
      // INV-TPL-02: publish mutation called with correct revision ID
      expect(mockPublishTrigger).toHaveBeenCalledWith({ revisionId: "rev-1" });
    });
    await waitFor(() => {
      // INV-TPL-02: catalog and revisions revalidated after publish
      expect(mockRevalidateCatalog).toHaveBeenCalledTimes(1);
      expect(mockRevalidateRevisions).toHaveBeenCalledTimes(1);
    });
  });
});

// INV-TPL-03: Assign → workspace assignments list gains entry

describe("INV-TPL-03: Assign template to workspace", () => {
  beforeEach(() => {
    resetState();
    catalogState.entries = [
      { id: "tpl-1", title: "Team Template", slug: "team-tpl" },
    ];
    assignmentsState.assignments = [];
  });
  afterEach(cleanup);

  test("remove assignment mutation is wired to correct assignment ID", async () => {
    // Pre-populate with an existing assignment
    assignmentsState.assignments = [
      {
        id: "assign-to-remove",
        templateId: "tpl-1",
        selectionMode: "PUBLISHED",
        provisioningMode: "SEED_ONCE",
        isEnabled: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    renderWithFacade(<AssignmentsTab />);
    const input = screen.getByPlaceholderText(
      "Search workspace by name, owner or ID...",
    );
    fireEvent.change(input, { target: { value: "ws-integration-2" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => screen.getAllByText("Remove"));
    fireEvent.click(screen.getAllByText("Remove")[0]);

    await waitFor(() => screen.getByTestId("dialog-remove-assignment"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));

    await waitFor(() => {
      // INV-TPL-03: remove mutation called with exact assignment ID
      expect(mockRemove).toHaveBeenCalledWith("assign-to-remove");
    });
    await waitFor(() => {
      // INV-TPL-03: assignments revalidated so list reflects removal
      expect(mockRevalidateAssignments).toHaveBeenCalledTimes(1);
    });
  });
});

// INV-TPL-05: Remove assignment → no longer shown

// INV-TPL-04: Drift detection — UPDATE_AVAILABLE badge visible

// INV-TPL-A-01: Builtin detail drawer shows read-only banner

// INV-TPL-A-03: VersionsTab builtin → no Publish button

describe("INV-TPL-A-03: VersionsTab read-only for builtin", () => {
  beforeEach(() => {
    resetState();
    catalogState.entries = [
      {
        id: "builtin-3",
        title: "Notebook",
        slug: "notebook",
        source: "Builtin",
      },
      {
        id: "bundle-1",
        title: "Bundle Tpl",
        slug: "bundle-tpl",
        source: "Bundle",
      },
    ];
    revisionsState.revisions = [
      {
        id: "rev-1",
        version: "1.0.0",
        state: RevisionStateType.Validated,
        publishedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
  });
  afterEach(cleanup);

  test("builtin template does not show Publish button in revisions list", async () => {
    renderWithFacade(<VersionsTab />);

    await selectTemplateOption("Notebook (notebook) ★");

    await waitFor(() => {
      expect(screen.getByText("1.0.0")).toBeTruthy();
    });

    // INV-TPL-A-03: Publish button must NOT appear for builtin template
    expect(screen.queryByText("Publish")).toBeNull();
    // "Managed by builder" indicator visible instead
    expect(screen.getByText("Historical catalog entry")).toBeTruthy();
  });
});

// INV-TPL-A-04: DefaultPoliciesTab renders policies and toggle opens confirm
