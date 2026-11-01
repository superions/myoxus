import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

// Shared test fixtures

interface MemberFixture {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  status: string;
}

interface UserFixture {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  disabled: boolean;
  features: string[];
  hasPassword: boolean;
  emailVerified: boolean;
}

const WORKSPACE_ID = "ws-test-123";
const OWNER_ID = "u-owner";

const MEMBERS: MemberFixture[] = [
  {
    id: OWNER_ID,
    name: "Alice Owner",
    email: "alice@test.com",
    avatarUrl: null,
    role: "Owner",
    status: "Accepted",
  },
  {
    id: "u-bob",
    name: "Bob Collab",
    email: "bob@test.com",
    avatarUrl: null,
    role: "Collaborator",
    status: "Accepted",
  },
  {
    id: "u-carol",
    name: "Carol Pending",
    email: "carol@test.com",
    avatarUrl: null,
    role: "Reader",
    status: "Pending",
  },
];

const USER_SEARCH_RESULTS: UserFixture[] = [
  {
    id: "u-dave",
    name: "Dave New",
    email: "dave@test.com",
    avatarUrl: null,
    disabled: false,
    features: [],
    hasPassword: true,
    emailVerified: true,
  },
  {
    id: "u-bob",
    name: "Bob Collab",
    email: "bob@test.com",
    avatarUrl: null,
    disabled: false,
    features: [],
    hasPassword: true,
    emailVerified: true,
  },
];

// Mock setup helper

const workspaceMemberMocks = vi.hoisted(() => ({
  removeTrigger: vi.fn(),
  addTrigger: vi.fn(),
  updateRoleTrigger: vi.fn(),
  revalidateFn: vi.fn(),
  lastQueryCalls: [] as Array<{ queryId: string; variables: unknown }>,
  members: [] as MemberFixture[],
  memberCount: 0,
  searchUsers: [] as UserFixture[],
}));

vi.mock("../../../use-query", () => ({
  useQuery: (opts: { query: { id: string }; variables: unknown }) => {
    workspaceMemberMocks.lastQueryCalls.push({
      queryId: opts.query.id,
      variables: opts.variables,
    });

    if (opts.query.id === "listUsersQuery") {
      return {
        data: {
          admin: {
            users: workspaceMemberMocks.searchUsers,
            usersCount: workspaceMemberMocks.searchUsers.length,
          },
        },
      };
    }

    return {
      data: {
        admin: {
          adminWorkspace: {
            id: WORKSPACE_ID,
            memberCount: workspaceMemberMocks.memberCount,
            members: workspaceMemberMocks.members,
            owner: {
              id: OWNER_ID,
              name: "Alice Owner",
              email: "alice@test.com",
              avatarUrl: null,
            },
          },
        },
      },
    };
  },
}));

vi.mock("../../../use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) => {
    if (mutation.id === "adminRemoveWorkspaceMemberMutation") {
      return { trigger: workspaceMemberMocks.removeTrigger, isMutating: false };
    }
    if (mutation.id === "adminAddWorkspaceMemberMutation") {
      return { trigger: workspaceMemberMocks.addTrigger, isMutating: false };
    }
    if (mutation.id === "adminUpdateWorkspaceMemberRoleMutation") {
      return {
        trigger: workspaceMemberMocks.updateRoleTrigger,
        isMutating: false,
      };
    }
    return { trigger: vi.fn(), isMutating: false };
  },
  useMutateQueryResource: () => workspaceMemberMocks.revalidateFn,
}));

import { WorkspaceMembersSection } from "./workspace-panel-members";

function setupMocks(
  members: MemberFixture[] = MEMBERS,
  memberCount = MEMBERS.length,
  searchUsers: UserFixture[] = USER_SEARCH_RESULTS,
) {
  workspaceMemberMocks.removeTrigger = vi.fn().mockResolvedValue(true);
  workspaceMemberMocks.addTrigger = vi.fn().mockResolvedValue(true);
  workspaceMemberMocks.updateRoleTrigger = vi.fn().mockResolvedValue(true);
  workspaceMemberMocks.revalidateFn = vi.fn().mockResolvedValue(undefined);
  workspaceMemberMocks.lastQueryCalls = [];
  workspaceMemberMocks.members = members;
  workspaceMemberMocks.memberCount = memberCount;
  workspaceMemberMocks.searchUsers = searchUsers;
}

// Tests

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("WorkspaceMembersSection", () => {
  afterEach(() => {
    cleanup();
  });

  // INV-MEM-01: Members table renders Name / Email / Role / Status columns

  // INV-MEM-02: Search input is passed as memberQuery to query variables
  test("passes search term as memberQuery variable after debounce", async () => {
    setupMocks();
    renderWithFacade(
      <WorkspaceMembersSection workspaceId={WORKSPACE_ID} ownerId={OWNER_ID} />,
    );

    const searchInput = screen.getByTestId("member-search-input");
    fireEvent.change(searchInput, { target: { value: "bob" } });

    // Advance debounce timer
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    const workspaceCalls = workspaceMemberMocks.lastQueryCalls.filter(
      (c) => c.queryId === "adminWorkspaceQuery",
    );
    const lastCall = workspaceCalls[workspaceCalls.length - 1] as {
      variables: { memberQuery?: string };
    };
    expect(lastCall.variables.memberQuery).toBe("bob");
  });

  // INV-MEM-03: Remove button absent on owner row
  test("does not render Remove button on owner row", async () => {
    setupMocks();
    renderWithFacade(
      <WorkspaceMembersSection workspaceId={WORKSPACE_ID} ownerId={OWNER_ID} />,
    );

    expect(screen.queryByTestId(`remove-member-btn-${OWNER_ID}`)).toBeNull();
    expect(
      screen.getByTestId("remove-member-btn-u-bob").getAttribute("data-testid"),
    ).toBe("remove-member-btn-u-bob");
  });

  // INV-MEM-04: Remove button opens confirmation dialog

  // INV-MEM-05: Confirm in dialog calls adminRemoveWorkspaceMemberMutation with correct args
  test("confirming removal calls adminRemoveMember with workspaceId and userId", async () => {
    setupMocks();
    renderWithFacade(
      <WorkspaceMembersSection workspaceId={WORKSPACE_ID} ownerId={OWNER_ID} />,
    );

    fireEvent.click(screen.getByTestId("remove-member-btn-u-bob"));

    // Find and click the confirm button (text "Remove" inside the dialog)
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(workspaceMemberMocks.removeTrigger).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: "u-bob",
    });
  });

  // INV-MEM-06: "Add Member" button opens the add dialog

  // INV-MEM-07: User search results shown; existing members disabled
  test("user search shows results and disables existing members", async () => {
    setupMocks();
    renderWithFacade(
      <WorkspaceMembersSection workspaceId={WORKSPACE_ID} ownerId={OWNER_ID} />,
    );

    fireEvent.click(screen.getByTestId("add-member-btn"));

    const searchInput = await screen.findByTestId("add-member-search");
    fireEvent.change(searchInput, { target: { value: "test" } });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // Dave is not a member → enabled
    const daveBtn = screen.getByTestId("user-result-u-dave");
    expect((daveBtn as HTMLButtonElement).disabled).toBe(false);

    // Bob is already a member → disabled
    const bobBtn = screen.getByTestId("user-result-u-bob");
    expect(bobBtn.getAttribute("aria-disabled")).toBe("true");
    expect(bobBtn.tabIndex).toBe(-1);
    fireEvent.click(bobBtn);
    expect(bobBtn.getAttribute("aria-pressed")).toBe("false");
    expect(
      (screen.getByTestId("add-member-confirm-btn") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  // INV-MEM-08: Confirming add calls adminAddWorkspaceMemberMutation with correct args
  test("adding a user calls adminAddMember with workspaceId, userId, and role", async () => {
    setupMocks();
    renderWithFacade(
      <WorkspaceMembersSection workspaceId={WORKSPACE_ID} ownerId={OWNER_ID} />,
    );

    fireEvent.click(screen.getByTestId("add-member-btn"));

    const searchInput = await screen.findByTestId("add-member-search");
    fireEvent.change(searchInput, { target: { value: "dave" } });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    fireEvent.click(screen.getByTestId("user-result-u-dave"));

    fireEvent.click(screen.getByTestId("add-member-confirm-btn"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(workspaceMemberMocks.addTrigger).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: "u-dave",
      role: "Collaborator",
    });
  });

  // INV-MEM-09: Role changes use the admin workspace-member mutation.
  test("changing a member role calls adminUpdateWorkspaceMemberRole", async () => {
    setupMocks();
    renderWithFacade(
      <WorkspaceMembersSection workspaceId={WORKSPACE_ID} ownerId={OWNER_ID} />,
    );

    const bobRoleSelect = screen.getByTestId("member-role-select-u-bob");
    expect(bobRoleSelect.getAttribute("role")).toBe("combobox");
    expect(screen.queryByTestId(`member-role-select-${OWNER_ID}`)).toBeNull();

    fireEvent.click(bobRoleSelect);
    const adminOption = await screen.findByRole("option", { name: "Admin" });
    fireEvent.click(adminOption);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(workspaceMemberMocks.updateRoleTrigger).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: "u-bob",
      role: "Admin",
    });
  });
});
