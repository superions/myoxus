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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string) => key),
}));
vi.mock("@myoxus/i18n", async () => {
  const { createI18nMock } = await import("../../../__tests__/test-utils");
  return createI18nMock(tMock);
});

const { gqlFetcherMock } = vi.hoisted(() => ({
  gqlFetcherMock: vi.fn(),
}));
vi.mock("../../../use-query", () => ({
  gqlFetcher: (...args: unknown[]) => gqlFetcherMock(...args),
}));

import { UserPicker } from "../user-picker";

type AdminUser = {
  id: string;
  email: string;
  name: string;
  features: string[];
  isAdmin: boolean;
  disabled: boolean;
};

type ManagerUser = {
  id: string;
  email: string;
  name: string;
  features: string[];
};

function setIdle() {
  gqlFetcherMock.mockResolvedValue({});
}

function setAdminData(users: AdminUser[]) {
  gqlFetcherMock.mockImplementation((options: unknown) => {
    const opts = options as
      { query?: { id?: string }; variables?: unknown } | undefined;
    if (opts?.query?.id === "adminSearchUsersQuery") {
      return Promise.resolve({ admin: { adminSearchUsers: users } });
    }
    return Promise.resolve({});
  });
}

function setManagerData(users: ManagerUser[]) {
  gqlFetcherMock.mockImplementation((options: unknown) => {
    const opts = options as
      { query?: { id?: string }; variables?: unknown } | undefined;
    if (opts?.query?.id === "managerSearchUsersQuery") {
      return Promise.resolve({ managerSearchUsers: users });
    }
    return Promise.resolve({});
  });
}

function findCallForOp(
  op: "adminSearchUsersQuery" | "managerSearchUsersQuery",
) {
  const calls = gqlFetcherMock.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const opts = calls[i][0] as
      { query?: { id?: string }; variables?: unknown } | undefined;
    if (opts?.query?.id === op) return opts;
  }
  return undefined;
}

async function flushSearch() {
  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("UserPicker", () => {
  beforeEach(() => {
    gqlFetcherMock.mockReset();
    setIdle();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    tMock.mockClear();
  });

  test("inv_p_ar_0_03_debounce: typing 1 char fires admin query after 200ms", async () => {
    setAdminData([
      {
        id: "u-1",
        email: "alice@example.com",
        name: "Alice",
        features: [],
        isAdmin: false,
        disabled: false,
      },
    ]);

    renderWithProvider(
      <UserPicker mode="admin" value={null} onChange={vi.fn()} />,
    );
    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "a" } });
    });

    // Before debounce window elapses, the admin query was not issued.
    expect(findCallForOp("adminSearchUsersQuery")).toBeUndefined();

    await flushSearch();

    const call = findCallForOp("adminSearchUsersQuery");
    expect(call).toBeDefined();
    expect((call as { variables: Record<string, unknown> }).variables).toEqual({
      query: "a",
      limit: 50,
      features: null,
      excludeUnitId: null,
    });
  });

  test("inv_p_ar_0_03_admin_query: features filter is forwarded", async () => {
    setAdminData([]);
    renderWithProvider(
      <UserPicker
        mode="admin"
        features={["manager"]}
        value={null}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "x" } });
    });
    await flushSearch();

    const call = findCallForOp("adminSearchUsersQuery");
    expect(call).toBeDefined();
    expect(
      (call as { variables: Record<string, unknown> }).variables.features,
    ).toEqual(["manager"]);
  });

  test("inv_p_ar_0_03_admin_query: excludeUnitId is forwarded for OU member pickers", async () => {
    setAdminData([]);
    renderWithProvider(
      <UserPicker
        mode="admin"
        excludeUnitId="ou-1"
        value={null}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "x" } });
    });
    await flushSearch();

    const call = findCallForOp("adminSearchUsersQuery");
    expect(call).toBeDefined();
    expect(
      (call as { variables: Record<string, unknown> }).variables.excludeUnitId,
    ).toBe("ou-1");
  });

  test("inv_p_ar_0_03_manager_query: mode=manager calls managerSearchUsersQuery (NOT admin)", async () => {
    setManagerData([
      {
        id: "u-2",
        email: "bobby@example.com",
        name: "Bobby",
        features: [],
      },
    ]);
    renderWithProvider(
      <UserPicker
        mode="manager"
        unitId="ou-1"
        value={null}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "b" } });
    });
    await flushSearch();

    const managerCall = findCallForOp("managerSearchUsersQuery");
    expect(managerCall).toBeDefined();
    expect(
      (managerCall as { variables: Record<string, unknown> }).variables,
    ).toEqual({
      query: "b",
      unitId: "ou-1",
      limit: 50,
    });

    // Admin query MUST NOT be issued in manager mode.
    expect(findCallForOp("adminSearchUsersQuery")).toBeUndefined();
  });

  test("inv_p_ar_0_03_manager_no_badges: manager mode never renders feature dots", async () => {
    setManagerData([
      {
        id: "u-mgr",
        email: "mgr@example.com",
        name: "Manager",
        features: ["manager"],
      },
    ]);
    renderWithProvider(
      <UserPicker
        mode="manager"
        unitId="ou-1"
        value={null}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "m" } });
    });
    await flushSearch();

    const option = screen.getByRole("option", { hidden: true });
    // Manager mode hides admin/manager badges (StatusDot writes lowercase
    // "admin"/"manager" labels) — guard by absence of those tokens.
    expect(option.textContent).not.toContain("admin");
    expect(option.textContent).not.toMatch(/\bmanager\b/);
  });
});
