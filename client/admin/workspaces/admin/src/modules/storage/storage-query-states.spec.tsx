/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queries: {} as Record<
    string,
    {
      data?: any;
      error?: Error;
      isLoading: boolean;
      isValidating: boolean;
      mutate: ReturnType<typeof vi.fn>;
    }
  >,
  assign: vi.fn(),
  remove: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../use-query", () => ({
  useQuery: ({ query }: any) => mocks.queries[query.id],
  gqlFetcher: vi.fn(),
}));
vi.mock("../../use-mutation", () => ({
  useMutation: ({ mutation }: any) => ({
    trigger:
      mutation.id === "reassignWorkspaceOwnerMutation"
        ? mocks.assign
        : mocks.remove,
  }),
}));
vi.mock("@myoxus/admin/notifications", () => ({
  adminToast: { success: mocks.success, error: mocks.error },
}));

import { OrphanedWorkspacesContent } from "./orphaned-workspaces";

const orphan = {
  id: "workspace-orphan",
  name: "Ownerless QA",
  memberCount: 1,
  createdAt: "2026-01-01T00:00:00Z",
};
function renderOrphans() {
  return render(
    <MyoxusUIProvider>
      <OrphanedWorkspacesContent />
    </MyoxusUIProvider>,
  );
}
async function selectOwner() {
  fireEvent.click(screen.getByRole("button", { name: "Assign" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Select user…" }));
  fireEvent.click(
    await screen.findByRole("option", { name: "Admin (admin@example.test)" }),
  );
  fireEvent.blur(screen.getByRole("combobox", { name: "Select user…" }));
}
describe("Storage query state and mutation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const id of [
      "serverDirectoriesQuery",
      "orphanedWorkspacesQuery",
      "orphanedWorkspacesCountQuery",
      "listUsersQuery",
    ]) {
      mocks.queries[id] = {
        isLoading: false,
        isValidating: false,
        mutate: vi.fn().mockResolvedValue(undefined),
      };
    }
    mocks.queries.serverDirectoriesQuery.data = {
      admin: {
        serverDirectories: [
          {
            name: "Blob Storage",
            path: "/storage",
            exists: true,
            totalBytes: 1,
            freeBytes: 100,
            capacityBytes: 101,
            entryCount: 1,
          },
        ],
      },
    };
    mocks.queries.orphanedWorkspacesQuery.data = {
      admin: { orphanedWorkspaces: [orphan] },
    };
    mocks.queries.orphanedWorkspacesCountQuery.data = {
      admin: { orphanedWorkspacesCount: 1 },
    };
    mocks.queries.listUsersQuery.data = {
      admin: {
        users: [
          { id: "user-admin", name: "Admin", email: "admin@example.test" },
        ],
      },
    };
    mocks.assign
      .mockReset()
      .mockResolvedValue({ admin: { reassignWorkspaceOwner: true } });
    mocks.remove
      .mockReset()
      .mockResolvedValue({ admin: { deleteWorkspace: true } });
  });
  afterEach(cleanup);

  test("rejected reassignment keeps the selected owner and never reports success", async () => {
    mocks.assign.mockResolvedValue({
      admin: { reassignWorkspaceOwner: false },
    });
    renderOrphans();
    await selectOwner();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Failed to reassign owner"),
    );
    expect(
      (
        screen.getByRole("combobox", {
          name: "Select user…",
        }) as HTMLInputElement
      ).value,
    ).toBe("Admin (admin@example.test)");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.queries.orphanedWorkspacesQuery.mutate).not.toHaveBeenCalled();
  });

  test("applied reassignment locks actions through list/count readback and cannot repeat the write", async () => {
    let finish!: () => void;
    mocks.queries.orphanedWorkspacesQuery.mutate.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    renderOrphans();
    await selectOwner();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.queries.orphanedWorkspacesQuery.mutate).toHaveBeenCalled(),
    );
    expect(
      (screen.getByRole("button", { name: "Assign" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(mocks.assign).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() =>
      expect(
        mocks.queries.orphanedWorkspacesCountQuery.mutate,
      ).toHaveBeenCalledWith(undefined, { throwOnError: false }),
    );
    expect(mocks.assign).toHaveBeenCalledWith({
      workspaceId: "workspace-orphan",
      newOwnerId: "user-admin",
    });
  });

  test("rejected deletion retains typed confirmation and never reports an applied write", async () => {
    mocks.remove.mockResolvedValue({ admin: { deleteWorkspace: false } });
    renderOrphans();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete orphaned workspace",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Delete permanently",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByPlaceholderText("Workspace ID"), {
      target: { value: orphan.id },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.remove).toHaveBeenCalledWith({ id: orphan.id });
    expect(
      (within(dialog).getByPlaceholderText("Workspace ID") as HTMLInputElement)
        .value,
    ).toBe(orphan.id);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.queries.orphanedWorkspacesQuery.mutate).not.toHaveBeenCalled();
  });
});
