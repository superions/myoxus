// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  record: null as Record<string, any> | null,
  triggers: new Map<string, ReturnType<typeof vi.fn>>(),
  close: vi.fn(),
  waitForRevalidation: vi.fn(async () => {}),
}));

const projection = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "import-1",
  status,
  queuedOperation: status === "queued" ? "preview" : null,
  progressStage: null,
  progressCurrent: status === "queued" ? 1 : 0,
  progressTotal: status === "queued" ? 2 : 0,
  cancelRequested: false,
  preview: null,
  targetWorkspaceId: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-07-14T00:00:00Z",
  updatedAt: "2026-07-14T00:00:00Z",
  expiresAt: "2026-07-15T00:00:00Z",
  ...extra,
});

const confirmablePreview = () =>
  projection("previewed", {
    preview: {
      detectedFormat: "obsidian_zip",
      proposedWorkspaceTitle: "Formula vault",
      counts: {
        documents: 2,
        assets: 0,
        databases: 0,
        fields: 0,
        rows: 0,
        cells: 0,
        views: 0,
      },
      omittedCounts: {},
      targetPlan: {
        workspaceId: "workspace-1",
        documentIds: [],
        assetIds: [],
        databaseIds: [],
      },
      diagnostics: [
        {
          code: "MIX_WORKSPACE_IMPORT_VAULT_SOURCE_PRESERVED",
          severity: "informational",
        },
      ],
      sourceHash: "source-hash",
      configFingerprint: "previous-policy",
      planFingerprint: "previous-plan",
      applyAllowed: true,
    },
  });

vi.mock("@myoxus/core/components/hooks/use-query", () => ({
  useQuery: (options?: unknown) => ({
    data:
      options && state.record ? { workspaceImport: state.record } : undefined,
    error: undefined,
    mutate: vi.fn(async (next?: { workspaceImport?: Record<string, any> }) => {
      if (next?.workspaceImport) state.record = next.workspaceImport;
    }),
  }),
}));

vi.mock("@myoxus/core/components/hooks/use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) => {
    const existing = state.triggers.get(mutation.id);
    if (existing) return { trigger: existing, isMutating: false };
    const trigger = vi.fn(async () => {
      if (mutation.id === "createWorkspaceImportUploadMutation") {
        return {
          createWorkspaceImportUpload: {
            workspaceImportId: "import-1",
            partSizeBytes: 8 * 1024 * 1024,
            expiresAt: "2026-07-15T00:00:00Z",
            parts: [
              {
                partNumber: 1,
                sizeBytes: 6,
                contentHash: "hash",
                uploadUrl: "/upload",
              },
            ],
          },
        };
      }
      if (mutation.id === "completeWorkspaceImportUploadMutation") {
        return { completeWorkspaceImportUpload: projection("staged") };
      }
      if (mutation.id === "previewWorkspaceImportMutation") {
        const record = projection("queued");
        state.record = record;
        return { previewWorkspaceImport: record };
      }
      if (mutation.id === "applyWorkspaceImportMutation") {
        const record = projection("queued", { queuedOperation: "apply" });
        state.record = record;
        return { applyWorkspaceImport: record };
      }
      if (mutation.id === "cancelWorkspaceImportMutation") {
        const record = projection("cancelled");
        state.record = record;
        return { cancelWorkspaceImport: record };
      }
      throw new Error(`Unexpected mutation ${mutation.id}`);
    });
    state.triggers.set(mutation.id, trigger);
    return { trigger, isMutating: false };
  },
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useService: () => ({
      list: {
        waitForRevalidation: state.waitForRevalidation,
        workspaces$: {
          value: [{ id: "workspace-1", flavour: "myoxus-cloud" }],
        },
      },
    }),
  };
});

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspacesService: class WorkspacesService {},
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => () => String(key),
      },
    ),
}));

vi.mock("./workspace-import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-import")>()),
  prepareWorkspaceImport: vi.fn(async (_file, options) => {
    options?.onProgress?.(6, 6);
    return {
      sourceHash: "source-hash",
      sourceSizeBytes: 6,
      parts: [{ partNumber: 1, sizeBytes: 6, contentHash: "hash" }],
    };
  }),
  uploadWorkspaceImportParts: vi.fn(async (_file, _parts, options) => {
    options?.onProgress?.(6, 6);
  }),
}));

vi.mock("@myoxus/ui-facade", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Accordion: Box,
    AccordionControl: Box,
    AccordionItem: Box,
    AccordionPanel: Box,
    Badge: Box,
    Button: ({ children, ...props }: any) => (
      <button {...props}>{children}</button>
    ),
    Checkbox: ({ checked, label, onChange, ...props }: any) => (
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange?.(event, event.currentTarget.checked)}
          {...props}
        />
        {label}
      </label>
    ),
    DialogFooterActions: Box,
    Group: Box,
    Modal: ({
      children,
      title,
    }: {
      children?: ReactNode;
      title?: ReactNode;
    }) => (
      <div>
        {title ? <h1>{title}</h1> : null}
        {children}
      </div>
    ),
    MyoxusText: Box,
    MyoxusTitle: Box,
    Progress: Box,
    RadioGroup: ({ items, value, onChange }: any) => (
      <div>
        {items.map((item: any) => (
          <button
            key={item.value}
            aria-pressed={value === item.value}
            data-testid={item.testId}
            onClick={() => onChange?.(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
    ),
    SettingsNotice: ({
      children,
      title,
    }: {
      children?: ReactNode;
      title?: ReactNode;
    }) => (
      <div>
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
    ),
    SimpleGrid: Box,
    Stack: Box,
    StatCell: ({ label, value }: { label: ReactNode; value: ReactNode }) => (
      <div>
        {label}: {value}
      </div>
    ),
    StatGrid: Box,
    UploadTarget: ({ onFile }: { onFile: (file: File) => void }) => (
      <button
        data-testid="workspace-import-upload"
        onClick={() => onFile(new File(["source"], "workspace.db"))}
      >
        upload
      </button>
    ),
  };
});

import { ImportWorkspaceDialog } from "./index";

describe("server-backed workspace import dialog", () => {
  afterEach(() => {
    // The production dialog intentionally remembers an in-flight server import
    // across close/reopen within the current renderer session. End each test
    // through the real Start over action so that this module-level recovery
    // contract cannot leak state into the next independent journey.
    state.record = projection("failed");
    const resetView = render(<ImportWorkspaceDialog close={state.close} />);
    for (const startOver of screen.queryAllByText(
      "com.myoxus.workspace-import.start-over",
    )) {
      fireEvent.click(startOver);
    }
    resetView.unmount();
    cleanup();
  });

  beforeEach(() => {
    state.record = null;
    state.triggers.clear();
    state.close.mockClear();
    state.waitForRevalidation.mockClear();
  });

  test("rejected preview confirmation stays recoverable and clears the checkbox", async () => {
    const view = render(<ImportWorkspaceDialog close={state.close} />);
    fireEvent.click(screen.getByTestId("workspace-import-upload"));
    await waitFor(() =>
      expect(
        state.triggers.get("previewWorkspaceImportMutation"),
      ).toHaveBeenCalled(),
    );
    state.record = confirmablePreview();
    view.rerender(<ImportWorkspaceDialog close={state.close} />);
    state.triggers
      .get("applyWorkspaceImportMutation")!
      .mockRejectedValueOnce(new Error("configuration changed"));
    fireEvent.click(screen.getByTestId("workspace-import-confirm-changes"));
    fireEvent.click(screen.getByTestId("workspace-import-apply"));
    await waitFor(() =>
      expect(
        screen.getByText("com.myoxus.workspace-import.error.generic")
          .isConnected,
      ).toBe(true),
    );
    expect(
      (
        screen.getByTestId(
          "workspace-import-confirm-changes",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("workspace-import-apply") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(state.record!.targetWorkspaceId).toBe(null);
    expect(screen.getByText("Formula vault").isConnected).toBe(true);
    fireEvent.click(screen.getByTestId("workspace-import-start-over"));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-import-upload").isConnected).toBe(
        true,
      ),
    );
  });

  test("failed Start over cancellation retains the job until cancellation succeeds", async () => {
    const view = render(<ImportWorkspaceDialog close={state.close} />);
    fireEvent.click(screen.getByTestId("workspace-import-upload"));
    await waitFor(() =>
      expect(
        state.triggers.get("previewWorkspaceImportMutation"),
      ).toHaveBeenCalled(),
    );
    state.record = confirmablePreview();
    view.rerender(<ImportWorkspaceDialog close={state.close} />);
    const cancel = state.triggers.get("cancelWorkspaceImportMutation")!;
    cancel.mockRejectedValueOnce(new Error("connection interrupted"));
    fireEvent.click(screen.getByTestId("workspace-import-start-over"));
    await waitFor(() =>
      expect(
        screen.getByText("com.myoxus.workspace-import.error.generic")
          .isConnected,
      ).toBe(true),
    );
    expect(screen.queryByTestId("workspace-import-upload")).toBeNull();
    expect(screen.getByText("Formula vault").isConnected).toBe(true);
    fireEvent.click(screen.getByTestId("workspace-import-start-over"));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-import-upload").isConnected).toBe(
        true,
      ),
    );
    expect(cancel).toHaveBeenNthCalledWith(2, {
      workspaceImportId: "import-1",
    });
  });

  test("uploads, previews, applies and opens the server-created workspace", async () => {
    const view = render(<ImportWorkspaceDialog close={state.close} />);

    fireEvent.click(screen.getByTestId("workspace-import-upload"));
    await waitFor(() =>
      expect(
        state.triggers.get("previewWorkspaceImportMutation"),
      ).toHaveBeenCalledWith({ workspaceImportId: "import-1" }),
    );
    expect(
      state.triggers.get("createWorkspaceImportUploadMutation"),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHash: "source-hash",
        sourceSizeBytes: 6,
      }),
    );

    state.record = projection("previewed", {
      preview: {
        detectedFormat: "snapshot_zip",
        proposedWorkspaceTitle: "Imported workspace",
        counts: {
          documents: 2,
          assets: 1,
          databases: 2,
          fields: 18,
          rows: 3,
          cells: 24,
          views: 3,
        },
        omittedCounts: {},
        targetPlan: {
          workspaceId: "workspace-1",
          documentIds: [],
          assetIds: [],
          databaseIds: [],
        },
        diagnostics: [
          {
            code: "MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED",
            severity: "informational",
            message: "portable label color normalized",
          },
        ],
        sourceHash: "source-hash",
        configFingerprint: "config",
        applyAllowed: true,
      },
    });
    view.rerender(<ImportWorkspaceDialog close={state.close} />);

    expect(screen.getByText("Imported workspace").isConnected).toBe(true);
    expect(screen.getByText("Tags").isConnected).toBe(true);
    expect(
      screen.getByText(
        "com.myoxus.workspace-import.diagnostic.label-color-normalized",
      ).isConnected,
    ).toBe(true);
    expect(
      (
        screen.getByText(
          "com.myoxus.workspace-import.apply",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("workspace-import-confirm-changes"));
    fireEvent.click(screen.getByText("com.myoxus.workspace-import.apply"));
    await waitFor(() =>
      expect(
        state.triggers.get("applyWorkspaceImportMutation"),
      ).toHaveBeenCalledWith({
        workspaceImportId: "import-1",
      }),
    );

    state.record = projection("succeeded", {
      targetWorkspaceId: "workspace-1",
    });
    view.rerender(<ImportWorkspaceDialog close={state.close} />);
    fireEvent.click(screen.getByText("com.myoxus.workspace-import.open"));

    await waitFor(() =>
      expect(state.close).toHaveBeenCalledWith({
        workspace: { id: "workspace-1", flavour: "myoxus-cloud" },
      }),
    );
  });

  test("selects the server-owned Obsidian format before uploading", async () => {
    render(<ImportWorkspaceDialog close={state.close} />);

    fireEvent.click(
      screen.getByTestId("workspace-import-source-obsidian-vault"),
    );
    fireEvent.click(screen.getByTestId("workspace-import-upload"));

    await waitFor(() =>
      expect(
        state.triggers.get("createWorkspaceImportUploadMutation"),
      ).toHaveBeenCalledWith(
        expect.objectContaining({ sourceFormat: "ObsidianZip" }),
      ),
    );
  });

  test("resumes a durable queued operation after the dialog is reopened and cancels it", async () => {
    const first = render(<ImportWorkspaceDialog close={state.close} />);
    fireEvent.click(screen.getByTestId("workspace-import-upload"));
    await waitFor(() =>
      expect(
        state.triggers.get("previewWorkspaceImportMutation"),
      ).toHaveBeenCalledWith({ workspaceImportId: "import-1" }),
    );
    first.unmount();

    const reopened = render(<ImportWorkspaceDialog close={state.close} />);
    expect(
      screen.getByText("com.myoxus.workspace-import.previewing").isConnected,
    ).toBe(true);
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() =>
      expect(
        state.triggers.get("cancelWorkspaceImportMutation"),
      ).toHaveBeenCalledWith({ workspaceImportId: "import-1" }),
    );
    state.record = projection("cancelled");
    reopened.rerender(<ImportWorkspaceDialog close={state.close} />);
    expect(
      screen.getByText("com.myoxus.workspace-import.cancelled").isConnected,
    ).toBe(true);
    expect(
      screen.getByRole("heading", {
        name: "com.myoxus.cmdk.import-workspace",
      }).isConnected,
    ).toBe(true);
    fireEvent.click(screen.getByText("com.myoxus.workspace-import.start-over"));
  });

  test("keeps blocking diagnostics visible and prevents apply", async () => {
    const view = render(<ImportWorkspaceDialog close={state.close} />);
    fireEvent.click(screen.getByTestId("workspace-import-upload"));
    await waitFor(() =>
      expect(
        state.triggers.get("previewWorkspaceImportMutation"),
      ).toHaveBeenCalled(),
    );
    state.record = projection("previewed", {
      preview: {
        detectedFormat: "snapshot_zip",
        proposedWorkspaceTitle: "Blocked workspace",
        counts: {
          documents: 2,
          assets: 0,
          databases: 1,
          fields: 3,
          rows: 1,
          cells: 2,
          views: 1,
        },
        omittedCounts: {},
        targetPlan: {
          workspaceId: "workspace-1",
          documentIds: [],
          assetIds: [],
          databaseIds: [],
        },
        diagnostics: [
          {
            code: "MIX_WORKSPACE_IMPORT_DATABASE_INVALID",
            severity: "blocking",
          },
        ],
        sourceHash: "source-hash",
        configFingerprint: "config",
        applyAllowed: false,
      },
    });
    view.rerender(<ImportWorkspaceDialog close={state.close} />);

    expect(
      screen.getAllByText(
        "com.myoxus.workspace-import.diagnostic.database-invalid",
      ),
    ).toHaveLength(2);
    expect(
      screen.getByText("com.myoxus.workspace-import.preview-blocked")
        .isConnected,
    ).toBe(true);
    expect(
      (
        screen.getByText(
          "com.myoxus.workspace-import.apply",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByText("com.myoxus.workspace-import.start-over"));
  });

  test("renders operator recovery guidance for cleanup-required imports", async () => {
    const view = render(<ImportWorkspaceDialog close={state.close} />);
    fireEvent.click(screen.getByTestId("workspace-import-upload"));
    await waitFor(() =>
      expect(
        state.triggers.get("previewWorkspaceImportMutation"),
      ).toHaveBeenCalled(),
    );
    state.record = projection("cleanup_required", {
      errorCode: "MIX_WORKSPACE_IMPORT_CLEANUP_REQUIRED",
    });
    view.rerender(<ImportWorkspaceDialog close={state.close} />);

    expect(
      screen.getByText("com.myoxus.workspace-import.cleanup-title").isConnected,
    ).toBe(true);
    expect(
      screen.getByText("com.myoxus.workspace-import.cleanup-description")
        .isConnected,
    ).toBe(true);

    // Restore the module-level session pointer so this test cannot influence
    // another dialog instance while preserving the real cleanup UI contract.
    state.record = projection("failed");
    view.rerender(<ImportWorkspaceDialog close={state.close} />);
    const cancel = state.triggers.get("cancelWorkspaceImportMutation");
    const previousCancellations = cancel?.mock.calls.length ?? 0;
    fireEvent.click(screen.getByText("com.myoxus.workspace-import.start-over"));
    expect(cancel?.mock.calls.length ?? 0).toBe(previousCancellations);
  });
});
