// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
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
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const createFirstAdminUserMock = vi.fn();
const revalidateServerConfigMock = vi.fn();
const useServerConfigMock = vi.fn();

vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => en[key] ?? key,
    }),
  };
});

vi.mock("../../api/setup-bootstrap-api", () => ({
  createFirstAdminUser: (...args: unknown[]) =>
    createFirstAdminUserMock(...args),
}));

vi.mock("../common", () => ({
  useServerConfigResource: () => ({
    serverConfig: useServerConfigMock(),
    revalidate: revalidateServerConfigMock,
  }),
}));

import { Form } from "./form";

function renderForm() {
  return render(
    <MyoxusUIProvider>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Form />} />
          <Route
            path="/adminfrontend/config-wizard"
            element={<h1>Wizard admission</h1>}
          />
        </Routes>
      </MemoryRouter>
    </MyoxusUIProvider>,
  );
}

function enterValidAdmin() {
  fireEvent.change(screen.getByLabelText(/^Name/), {
    target: { value: "Ada Admin" },
  });
  fireEvent.change(screen.getByLabelText(/^Email/), {
    target: { value: "ada@example.test" },
  });
  fireEvent.change(screen.getByLabelText(/^Password/), {
    target: { value: "correct-horse" },
  });
}

describe("Setup Form", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    createFirstAdminUserMock.mockReset();
    createFirstAdminUserMock.mockResolvedValue({});
    revalidateServerConfigMock.mockReset();
    revalidateServerConfigMock.mockResolvedValue({ initialized: true });
    useServerConfigMock.mockReturnValue({
      credentialsRequirement: {
        password: {
          minLength: 8,
          maxLength: 72,
        },
      },
      initialized: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("does not finish until the exact server-config refresh confirms initialization", async () => {
    let resolveRefresh: ((value: { initialized: boolean }) => void) | undefined;
    revalidateServerConfigMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    enterValidAdmin();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(createFirstAdminUserMock).toHaveBeenCalledWith({
        name: "Ada Admin",
        email: "ada@example.test",
        password: "correct-horse",
      });
    });
    expect(revalidateServerConfigMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("All Settings Done")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
    ).toBe(true);
    for (const label of ["Name", "Email", "Password"]) {
      expect(
        screen.getByLabelText(new RegExp(`^${label}`)).hasAttribute("disabled"),
      ).toBe(true);
    }
    expect(
      screen.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(createFirstAdminUserMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh?.({ initialized: true });
    });
    expect((await screen.findByText("Wizard admission")).textContent).toBe(
      "Wizard admission",
    );
  });

  test("retries only revalidation when a stale response still says uninitialized", async () => {
    revalidateServerConfigMock
      .mockResolvedValueOnce({ initialized: false })
      .mockResolvedValueOnce({ initialized: true });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    enterValidAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(revalidateServerConfigMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("All Settings Done")).toBeNull();
    expect(
      screen.getByLabelText(/^Email/).getAttribute("aria-invalid"),
    ).not.toBe("true");
    expect(
      screen.getByLabelText(/^Password/).getAttribute("aria-invalid"),
    ).not.toBe("true");
    await waitFor(() => {
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Wizard admission")).toBeTruthy();
    expect(createFirstAdminUserMock).toHaveBeenCalledTimes(1);
    expect(revalidateServerConfigMock).toHaveBeenCalledTimes(2);
  });

  test("keeps invalid credentials local and does not call the setup API", async () => {
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Ada Admin" },
    });
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: "short" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Invalid email address.")).toBeTruthy();
    expect(screen.getByLabelText(/^Email/).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(
      screen.getByLabelText(/^Email/).getAttribute("aria-describedby"),
    ).toContain("error");
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: "ada@example.test" },
    });
    expect(
      screen.getByLabelText(/^Email/).getAttribute("aria-invalid"),
    ).not.toBe("true");
    expect(screen.getByLabelText(/^Password/).getAttribute("minlength")).toBe(
      "8",
    );
    expect(screen.getByLabelText(/^Password/).getAttribute("maxlength")).toBe(
      "72",
    );
    expect(
      screen.getByLabelText(/^Password/).getAttribute("autocomplete"),
    ).toBe("new-password");
    expect(createFirstAdminUserMock).not.toHaveBeenCalled();
    expect(revalidateServerConfigMock).not.toHaveBeenCalled();
  });
});
