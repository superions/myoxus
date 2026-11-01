// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notifyError: vi.fn(),
  resetPassword: vi.fn(),
  notifySuccess: vi.fn(),
  revalidate: vi.fn(async () => undefined),
}));

vi.mock("@myoxus/admin/use-mutation", () => ({
  useMutateQueryResource: () => mocks.revalidate,
  useMutation: () => ({ trigger: mocks.resetPassword, isMutating: false }),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@myoxus/ui-facade", () => ({
  notify: { error: mocks.notifyError, success: mocks.notifySuccess },
}));

import { useResetUserPassword, useUpdateUser } from "./use-user-management";

test("profile update resolves persistence before revalidation and reports failed saves to its caller", async () => {
  mocks.revalidate.mockClear();
  mocks.resetPassword.mockResolvedValueOnce({
    admin: { updateAccount: { id: "user-1" } },
  });
  const { result } = renderHook(() => useUpdateUser());
  await expect(
    result.current.update({
      userId: "user-1",
      name: "Ada",
      email: "ada@example.test",
    }),
  ).resolves.toBe(true);
  expect(mocks.resetPassword).toHaveBeenLastCalledWith({
    id: "user-1",
    input: { name: "Ada", email: "ada@example.test" },
  });
  expect(mocks.revalidate).toHaveBeenCalledOnce();
  mocks.resetPassword.mockRejectedValueOnce(new Error("profile unavailable"));
  await expect(
    result.current.update({ userId: "user-1", name: "Draft" }),
  ).resolves.toBe(false);
  expect(mocks.revalidate).toHaveBeenCalledOnce();
});

describe("useResetUserPassword", () => {
  beforeEach(() => {
    mocks.notifyError.mockReset();
    mocks.resetPassword.mockReset();
  });

  test("requests a server-owned reset link without supplying an origin or callback", async () => {
    const link =
      "https://workspace.example.test/auth/changePassword?userId=user-1&token=one-time-token";
    mocks.resetPassword.mockResolvedValue({
      admin: { createChangePasswordUrl: link },
    });
    const { result } = renderHook(() => useResetUserPassword());

    expect(result.current.resetPasswordLink).toBe("");
    await act(async () => {
      await result.current.onResetPassword("user-1");
    });

    expect(mocks.resetPassword).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
    });
    expect(result.current.resetPasswordLink).toBe(link);
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  test("clears an old link before a failed retry and reports the failure", async () => {
    mocks.resetPassword.mockResolvedValueOnce({
      admin: {
        createChangePasswordUrl: "https://workspace.example.test/first",
      },
    });
    const { result } = renderHook(() => useResetUserPassword());
    await act(async () => {
      await result.current.onResetPassword("user-1");
    });
    expect(result.current.resetPasswordLink).not.toBe("");

    mocks.resetPassword.mockRejectedValueOnce(new Error("reset unavailable"));
    await act(async () => {
      await result.current.onResetPassword("user-1");
    });

    expect(result.current.resetPasswordLink).toBe("");
    expect(mocks.notifyError).toHaveBeenCalledOnce();
  });
});
