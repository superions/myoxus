import type { ReactElement } from "react";
import type { Mock } from "vitest";
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

/** @vitest-environment happy-dom */
import { FeatureType } from "@myoxus/graphql";
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

// Test fixtures

const WS_ID = "ws-test-panel-001";
const WS_NAME = "Alpha Team Space";

const MOCK_WORKSPACE = {
  id: WS_ID,
  public: false,
  createdAt: "2026-01-01T00:00:00Z",
  name: WS_NAME,
  avatarKey: null,
  isPersonal: false,
  workspaceType: "UserOwned",
  ownerPrincipalType: "user",
  ownerPrincipalId: "u-owner",
  ownerPrincipalName: null as string | null,
  enableAi: false,
  enableSharing: false,
  enableUrlPreview: false,
  enableDocEmbedding: false,
  features: [] as FeatureType[],
  memberCount: 1,
  publicPageCount: 0,
  snapshotCount: 1,
  snapshotSize: 512,
  blobCount: 0,
  blobSize: 0,
  storageQuotaBytes: null,
  storageQuotaUsed: 0,
  owner: {
    id: "u-owner",
    name: "Owner",
    email: "owner@test.com",
    avatarUrl: null,
  } as {
    id: string;
    name: string;
    email: string;
    avatarUrl: null;
  } | null,
  sharedLinks: [],
  members: [],
};

// Per-test mock state

let reindexTrigger: Mock<
  () => Promise<{ admin: { triggerWorkspaceReindex: boolean } }>
>;
let deleteTrigger: Mock<() => Promise<{ admin: { deleteWorkspace: boolean } }>>;
let revalidateFn: Mock<() => Promise<void>>;
let onCloseFn: Mock<() => void>;
let updateTrigger: Mock;

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function openReindexDialog() {
  fireEvent.click(screen.getByTestId("workspace-reindex-btn"));
  return screen.findByRole("dialog");
}

async function openDeleteDialog() {
  fireEvent.click(screen.getByTestId("workspace-delete-btn"));
  return screen.findByRole("dialog");
}

function setupMocks(
  workspace = MOCK_WORKSPACE,
  serverConfig: { availableWorkspaceFeatures: FeatureType[] } = {
    availableWorkspaceFeatures: [],
  },
) {
  reindexTrigger = vi
    .fn<() => Promise<{ admin: { triggerWorkspaceReindex: boolean } }>>()
    .mockResolvedValue({ admin: { triggerWorkspaceReindex: true } });
  deleteTrigger = vi
    .fn<() => Promise<{ admin: { deleteWorkspace: boolean } }>>()
    .mockResolvedValue({ admin: { deleteWorkspace: true } });
  revalidateFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  onCloseFn = vi.fn<() => void>();
  updateTrigger = vi
    .fn()
    .mockResolvedValue({ admin: { updateWorkspace: workspace } });

  vi.resetModules();

  vi.doMock("../../../use-query", () => ({
    useQuery: () => ({
      data: { admin: { adminWorkspace: workspace } },
      error: null,
      isLoading: false,
    }),
  }));

  vi.doMock("../../../use-mutation", () => ({
    useMutation: (opts: { mutation: { op: string } }) => {
      if (opts.mutation.op === "adminTriggerWorkspaceReindex") {
        return { trigger: reindexTrigger, isMutating: false };
      }
      if (opts.mutation.op === "adminDeleteWorkspace") {
        return { trigger: deleteTrigger, isMutating: false };
      }
      if (opts.mutation.op === "adminUpdateWorkspace") {
        return { trigger: updateTrigger, isMutating: false };
      }
      return { trigger: vi.fn(), isMutating: false };
    },
    useMutateQueryResource: () => revalidateFn,
  }));

  vi.doMock("../../panel/context", () => ({
    useRightPanel: () => ({
      setHasDirtyChanges: vi.fn(),
      hasDirtyChanges: false,
    }),
  }));

  vi.doMock("../../header", () => ({
    RightPanelHeader: ({ title }: { title: string }) => (
      <div data-testid="panel-header">{title}</div>
    ),
  }));

  vi.doMock("../../common", () => ({
    useServerConfig: () => serverConfig,
  }));

  vi.doMock("@myoxus/i18n", () => ({
    useI18n: () => ({
      "com.myoxus.peek-view-controls.close": () => "Close",
      t: (key: string, opts?: Record<string, unknown>) => {
        // Return human-readable label for key strings used in assertions
        const MAP: Record<string, string> = {
          "admin.common.details": "Details",
          "admin.common.name": "Name",
          "admin.workspace.maintenance": "Maintenance",
          "admin.workspace.reindex": "Reindex",
          "admin.workspace.reindex-desc":
            "Trigger a full reindex of this workspace's search index.",
          "admin.workspace.reindex-confirm-title": "Reindex Workspace?",
          "admin.workspace.reindex-confirm-desc":
            "This will rebuild the search index for this workspace. The operation runs in the background.",
          "admin.workspace.reindex-success":
            "Workspace reindex triggered successfully.",
          "admin.workspace.reindex-error": `Failed to trigger reindex: ${opts?.message ?? ""}`,
          "admin.workspace.danger-zone": "Danger Zone",
          "admin.workspace.delete": "Delete Workspace",
          "admin.workspace.delete-confirm-title": "Delete Workspace?",
          "admin.workspace.delete-confirm-desc":
            "This will permanently delete the workspace and all its data. Type the workspace name to confirm.",
          "admin.workspace.delete-confirm-placeholder":
            "Type workspace name to confirm",
          "admin.workspace.delete-success": "Workspace deleted successfully.",
          "admin.workspace.delete-error": `Failed to delete workspace: ${opts?.message ?? ""}`,
        };
        return MAP[key] ?? key;
      },
      exists: () => false,
      language: "en",
      changeLanguage: () => Promise.resolve(),
    }),
  }));

  vi.doMock("@myoxus/admin/notifications", () => ({
    adminToast: {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      dismiss: vi.fn(),
    },
  }));

  // Stub out sub-components that are not under test
  vi.doMock("./workspace-panel-members", () => ({
    WorkspaceMembersSection: () => <div data-testid="members-stub" />,
  }));

  vi.doMock("./workspace-template-drawer", () => ({
    WorkspaceTemplateDrawer: () => null,
  }));
}

// Tests

describe("WorkspacePanel — Maintenance section (P98-B-01)", () => {
  let WorkspacePanel: typeof import("./workspace-panel").WorkspacePanel;

  beforeEach(async () => {
    setupMocks();
    // Cold module transformation belongs to fixture setup, not the interaction deadline.
    ({ WorkspacePanel } = await import("./workspace-panel"));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("discards a draft without mutating, and keeps successful saves open", async () => {
    const dirtyChanged = vi.fn();
    renderWithFacade(
      <WorkspacePanel
        workspaceId={WS_ID}
        onClose={onCloseFn}
        onDirtyChange={dirtyChanged}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Draft name" } });
    expect(dirtyChanged).toHaveBeenLastCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: "admin.common.discard-changes" }),
    );
    expect((name as HTMLInputElement).value).toBe(WS_NAME);
    expect(dirtyChanged).toHaveBeenLastCalledWith(false);
    expect(updateTrigger).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Saved name" } });
    fireEvent.click(screen.getByRole("button", { name: "admin.common.save" }));
    await waitFor(() =>
      expect(updateTrigger).toHaveBeenCalledWith({
        input: expect.objectContaining({ id: WS_ID, name: "Saved name" }),
      }),
    );
    await waitFor(() => expect(dirtyChanged).toHaveBeenLastCalledWith(false));
    expect(onCloseFn).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-detail-content")).not.toBeNull();
    expect((name as HTMLInputElement).value).toBe("Saved name");
  });

  test("retains an unsaved draft when saving fails", async () => {
    updateTrigger.mockRejectedValueOnce(new Error("Cannot save"));
    const dirtyChanged = vi.fn();
    renderWithFacade(
      <WorkspacePanel
        workspaceId={WS_ID}
        onClose={onCloseFn}
        onDirtyChange={dirtyChanged}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "admin.common.save" }));
    await waitFor(() => expect(updateTrigger).toHaveBeenCalledTimes(1));
    expect((name as HTMLInputElement).value).toBe("Keep my draft");
    expect(dirtyChanged).toHaveBeenLastCalledWith(true);
    expect(onCloseFn).not.toHaveBeenCalled();
  });

  test("renders maintenance controls and sends the reindex mutation", async () => {
    renderWithFacade(
      <WorkspacePanel workspaceId={WS_ID} onClose={onCloseFn} />,
    );

    expect(screen.getByTestId("workspace-reindex-btn")).not.toBeNull();
    expect(screen.getByText("Maintenance")).not.toBeNull();
    expect(
      screen
        .getAllByText("Reindex")
        .some((node) =>
          node.closest('[data-myoxus-ui-role="settings-row-label"]'),
        ),
    ).toBe(true);

    const dialog = await openReindexDialog();
    expect(within(dialog).getByText("Reindex Workspace?")).not.toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Reindex" }));

    await waitFor(() => {
      expect(reindexTrigger).toHaveBeenCalledWith({ workspaceId: WS_ID });
    });
  }, 15_000);
});

describe("WorkspacePanel — visible admin information hierarchy", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("shows the authoritative OU owner name for shared workspaces", async () => {
    setupMocks({
      ...MOCK_WORKSPACE,
      workspaceType: "Shared",
      ownerPrincipalType: "ou",
      ownerPrincipalId: "ou-owner",
      ownerPrincipalName: "Owner Unit",
      owner: null,
    });

    const { WorkspacePanel } = await import("./workspace-panel");
    renderWithFacade(
      <WorkspacePanel workspaceId={WS_ID} onClose={onCloseFn} />,
    );

    const basics = await screen.findByTestId("workspace-drawer-panel-basics");
    expect(within(basics).getByText("Owner Unit")).not.toBeNull();
    expect(basics.textContent).not.toContain("admin.workspaces.list.no-owner");
  }, 15_000);
});

describe("WorkspacePanel — Danger Zone section (P98-B-04)", () => {
  beforeEach(() => {
    setupMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders danger-zone controls and sends the delete mutation after typed confirmation", async () => {
    const { WorkspacePanel } = await import("./workspace-panel");
    renderWithFacade(
      <WorkspacePanel workspaceId={WS_ID} onClose={onCloseFn} />,
    );

    expect(screen.getByTestId("workspace-delete-btn")).not.toBeNull();
    expect(screen.getByText("Danger Zone")).not.toBeNull();

    const dialog = await openDeleteDialog();

    expect(within(dialog).getByText("Delete Workspace?")).not.toBeNull();
    expect(
      within(dialog).getByPlaceholderText("Type workspace name to confirm"),
    ).not.toBeNull();

    const confirmBtn = within(dialog).getByRole("button", {
      name: "Delete Workspace",
    });
    expect(confirmBtn.hasAttribute("disabled")).toBe(true);

    const input = within(dialog).getByPlaceholderText(
      "Type workspace name to confirm",
    );
    fireEvent.change(input, { target: { value: WS_NAME } });
    expect(confirmBtn.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(deleteTrigger).toHaveBeenCalledWith({ id: WS_ID });
      expect(revalidateFn).toHaveBeenCalled();
      expect(onCloseFn).toHaveBeenCalled();
    });
  });
});
