// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */
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
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
import { selectMantineOption } from "../../__tests__/test-utils";
const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
    t: (key: string, options?: Record<string, unknown>): string => {
      let text = en[key] ?? key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        });
      }
      return text;
    },
  }),
}));

const apiMocks = vi.hoisted(() => ({
  mutate: vi.fn(async () => undefined),
  update: vi.fn(async () => true),
  setAdmin: vi.fn(async () => undefined),
  reset: vi.fn(async (_id: string) => undefined),
  disable: vi.fn((_id: string, cb?: () => void) => cb?.()),
  enable: vi.fn((_id: string, cb?: () => void) => cb?.()),
  deleting: false,
  deleteUser: vi.fn((_id: string, cb?: () => void) => cb?.()),
  recentLoginAt: new Date().toISOString(),
}));

const queryStates = vi.hoisted(() => {
  const resource = () => ({
    isLoading: false,
    isValidating: false,
    error: undefined as Error | undefined,
    mutate: vi.fn(async () => undefined),
  });
  return {
    users: resource(),
    units: resource(),
    memberships: resource(),
    activity: resource(),
  };
});

const users = [
  {
    id: "u-admin",
    name: "Ada Admin",
    email: "ada@example.com",
    disabled: false,
    features: ["Admin"],
    hasPassword: true,
    emailVerified: true,
    avatarUrl: null,
  },
  {
    id: "u-manager",
    name: "Mira Manager",
    email: "mira@example.com",
    disabled: false,
    features: ["Manager"],
    hasPassword: false,
    emailVerified: false,
    avatarUrl: null,
  },
  {
    id: "u-disabled",
    name: "Drew Disabled",
    email: "drew@example.com",
    disabled: true,
    features: [],
    hasPassword: true,
    emailVerified: true,
    avatarUrl: null,
  },
];

const memberships: Record<string, any[]> = {
  "u-admin": [],
  "u-manager": [
    {
      unitId: "ou-1",
      unitName: "Marketing",
      unitSlug: "marketing",
      role: "manager",
      source: "manual",
      joinedAt: "2026-01-01T00:00:00Z",
    },
  ],
  "u-disabled": [],
};

vi.mock("./api", () => ({
  useOrganizationUnitsQuery: () => ({
    ...queryStates.units,
    units: [{ id: "ou-1", name: "Marketing", slug: "marketing" }],
  }),
  useOrganizationUsersQuery: () => ({
    ...queryStates.users,
    users,
    usersCount: users.length,
    mutate: apiMocks.mutate,
  }),
  useUserOrganizationMembershipsQuery: (userId: string) => ({
    ...queryStates.memberships,
    memberships: memberships[userId] ?? [],
  }),
  useUserLastLoginAtQuery: (userId: string) => ({
    lastLoginAt: userId === "u-disabled" ? null : apiMocks.recentLoginAt,
  }),
  useUserAuditLogQuery: () => ({
    ...queryStates.activity,
    entries: [
      {
        id: "audit-1",
        eventKey: "organization.member.assign",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ],
  }),
}));

vi.mock("./use-user-management", async () => {
  const { useState } = await vi.importActual<typeof import("react")>("react");
  return {
    useUpdateUser: () => ({ update: apiMocks.update, updating: false }),
    useSetUserAdmin: () => apiMocks.setAdmin,
    useResetUserPassword: () => {
      const [resetPasswordLink, setResetPasswordLink] = useState("");
      return {
        resetPasswordLink,
        onResetPassword: async (id: string) => {
          await apiMocks.reset(id);
          setResetPasswordLink(
            "https://reset.example/auth/changePassword?userId=user-1&token=one-time-token",
          );
        },
      };
    },
    useDisableUser: () => apiMocks.disable,
    useEnableUser: () => apiMocks.enable,
    useDeleteUser: () => ({
      deleteUser: apiMocks.deleteUser,
      deleting: apiMocks.deleting,
    }),
  };
});

import { MembersTab } from "./members-tab";

function renderWithProvider(node: React.ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

function expectNoMembersLegacyChrome(root: ParentNode): void {
  expect(
    root.querySelector(
      [
        '[class*="admin-org-member"]',
        '[class*="admin-org-members"]',
        '[class*="admin-org-filter"]',
        '[class*="admin-role-"]',
        ".admin-ui-link-muted",
      ].join(","),
    ),
  ).toBeNull();
}

async function selectFacadeOption(
  testId: string,
  option: string | RegExp,
): Promise<void> {
  selectMantineOption(await screen.findByTestId(testId), option);
}

beforeEach(() => {
  apiMocks.deleting = false;
  for (const resource of Object.values(queryStates)) {
    resource.isLoading = false;
    resource.isValidating = false;
    resource.error = undefined;
    resource.mutate.mockClear();
  }
  Object.values(apiMocks).forEach((fn) => {
    if (typeof fn === "function") fn.mockClear();
  });
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MembersTab", () => {
  test("renders tenant users and derives manager status from OU memberships", async () => {
    const { container } = renderWithProvider(<MembersTab />);

    expect(screen.getByText("Ada Admin")).toBeTruthy();
    expect(screen.getByText("Mira Manager")).toBeTruthy();
    expect(
      container.querySelector('[data-detail-priority="detail"]'),
    ).toBeTruthy();
    expect(screen.getByText("OU manager")).toBeTruthy();
    expect(screen.queryByTestId("organization-member-drawer")).toBeNull();
    const managerRow = screen.getByTestId("organization-member-row-u-manager");
    expect(managerRow.getAttribute("data-myoxus-ui-role")).toBe(
      "navigation-link",
    );
    expect(managerRow.getAttribute("aria-pressed")).toBe("false");
    expect(managerRow.textContent).toContain("mira@example.com");
    expectNoMembersLegacyChrome(container);

    await selectFacadeOption("organization-members-unit-filter", "Marketing");

    await waitFor(() => {
      expect(screen.queryByText("Ada Admin")).toBeNull();
      expect(screen.getByText("Mira Manager")).toBeTruthy();
    });
  });

  test("profile drawer covers update, reset, disable, delete and admin toggle paths", async () => {
    const { container } = renderWithProvider(<MembersTab />);
    fireEvent.click(screen.getByTestId("organization-member-row-u-admin"));
    const drawer = screen.getByTestId("organization-member-drawer");
    expect(
      drawer.querySelector(".org-h3, .org-h4, .org-body, .org-label"),
    ).toBeNull();
    expect(
      within(drawer)
        .getByRole("heading", { name: "Ada Admin", level: 2 })
        .getAttribute("data-myoxus-ui-role"),
    ).toBe("settings-section-heading-level-2");
    expectNoMembersLegacyChrome(container);
    expect(screen.queryByText("Password reset link")).toBeNull();
    expect(screen.getByText("Magic link").textContent).toBe("Magic link");

    fireEvent.change(screen.getByDisplayValue("Ada Admin"), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(apiMocks.update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u-admin", name: "Ada Lovelace" }),
      ),
    );

    fireEvent.click(screen.getByText("Reset password"));
    await waitFor(() => {
      expect(apiMocks.reset).toHaveBeenCalledWith("u-admin");
      expect(screen.getByText("Password reset link").textContent).toBe(
        "Password reset link",
      );
    });

    fireEvent.click(screen.getByText("Disable"));
    expect(apiMocks.disable).toHaveBeenCalledWith(
      "u-admin",
      expect.any(Function),
    );

    fireEvent.click(
      screen.getByTestId("organization-member-drawer-tab-capabilities"),
    );
    expect(
      screen
        .getByText("Server administrator")
        .getAttribute("data-myoxus-ui-role"),
    ).toBe("settings-section-heading-level-3");
    expect(
      screen
        .getByText(/Grants global administration rights/)
        .getAttribute("data-myoxus-ui-role"),
    ).toBe("settings-section-description");
    fireEvent.click(screen.getByText("Remove admin"));
    await waitFor(() =>
      expect(apiMocks.setAdmin).toHaveBeenCalledWith("u-admin", false),
    );
    expect(screen.getByText(/Manager rights are derived/)).toBeTruthy();

    fireEvent.click(
      screen.getByTestId("organization-member-drawer-tab-profile"),
    );
    fireEvent.change(screen.getByDisplayValue("Ada Lovelace"), {
      target: { value: "Draft before deletion" },
    });
    fireEvent.click(screen.getByText("Delete"));
    expect(apiMocks.deleteUser).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    expect(apiMocks.deleteUser).toHaveBeenCalledWith(
      "u-admin",
      expect.any(Function),
    );

    // The fixture intentionally keeps its pre-revalidation list: success must
    // close the deleted profile rather than use the retained selection fallback.
    expect(screen.queryByTestId("organization-member-drawer")).toBeNull();
    fireEvent.click(screen.getByTestId("organization-member-row-u-manager"));
    expect(screen.queryByTestId("admin-confirm-modal-confirm")).toBeNull();
    expect(
      within(screen.getByTestId("organization-member-drawer")).getByRole(
        "heading",
        { name: "Mira Manager", level: 2 },
      ),
    ).toBeTruthy();
  });

  test("pending deletion retains its selected owner until the known success callback", async () => {
    let committed: (() => void) | undefined;
    apiMocks.deleteUser.mockImplementationOnce((_id, callback) => {
      committed = callback;
    });
    const { rerender } = renderWithProvider(<MembersTab />);
    fireEvent.click(screen.getByTestId("organization-member-row-u-admin"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    expect(screen.getByTestId("organization-member-drawer")).toBeTruthy();
    apiMocks.deleting = true;
    rerender(
      <MyoxusUIProvider>
        <MembersTab />
      </MyoxusUIProvider>,
    );
    fireEvent.click(screen.getByTestId("organization-member-row-u-manager"));
    expect(
      within(screen.getByTestId("organization-member-drawer")).getByRole(
        "heading",
        { name: "Ada Admin", level: 2 },
      ),
    ).toBeTruthy();
    expect(
      (screen.getByDisplayValue("ada@example.com") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    apiMocks.deleting = false;
    act(() => committed?.());
    expect(screen.queryByTestId("organization-member-drawer")).toBeNull();
  });

  test("drawer shows read-only OU memberships and actor audit snippets", () => {
    const onOpenUnit = vi.fn();
    const { container } = renderWithProvider(
      <MembersTab onOpenUnit={onOpenUnit} />,
    );
    fireEvent.click(screen.getByTestId("organization-member-row-u-manager"));

    fireEvent.click(
      screen.getByTestId("organization-member-drawer-tab-memberships"),
    );
    expect(screen.getAllByText("Marketing").length).toBeGreaterThan(1);
    expect(screen.getByText(/marketing/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("organization-member-membership-ou-1"));
    expect(onOpenUnit).toHaveBeenCalledWith("ou-1");

    fireEvent.click(
      screen.getByTestId("organization-member-drawer-tab-activity"),
    );
    expect(screen.getByText("Organization member assigned")).toBeTruthy();
    expect(screen.queryByText("organization.member.assign")).toBeNull();
    expectNoMembersLegacyChrome(container);
  });

  test("keeps a profile draft across tabs and filters, guards owner changes and discards directly", async () => {
    renderWithProvider(<MembersTab />);
    fireEvent.click(screen.getByTestId("organization-member-row-u-admin"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft Ada" },
    });
    fireEvent.click(
      screen.getByTestId("organization-member-drawer-tab-capabilities"),
    );
    fireEvent.click(
      screen.getByTestId("organization-member-drawer-tab-profile"),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft Ada",
    );
    await selectFacadeOption("organization-members-unit-filter", "Marketing");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft Ada",
    );
    fireEvent.click(screen.getByTestId("organization-member-row-u-manager"));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Changes will not be saved.",
    );
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft Ada",
    );
    fireEvent.click(
      within(screen.getByTestId("organization-member-drawer")).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Ada Admin",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("organization-member-row-u-manager"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Mira Manager",
    );
    expect(apiMocks.update).not.toHaveBeenCalled();
  });

  test("failed persistence retains the draft and save action, successful persistence clears dirty state", async () => {
    apiMocks.update.mockResolvedValueOnce(false);
    renderWithProvider(<MembersTab />);
    fireEvent.click(screen.getByTestId("organization-member-row-u-admin"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft Ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMocks.update).toHaveBeenCalledOnce());
    expect(apiMocks.mutate).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft Ada",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMocks.mutate).toHaveBeenCalledOnce());
    expect(
      (
        screen.getByRole("button", {
          name: "Save",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
