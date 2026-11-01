import { afterEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@myoxus/ui-facade", () => ({ notify: notifyMock }));

import { notify } from "@myoxus/ui-facade";

import { mutateWithToast } from "./mutate-with-toast";

describe("mutateWithToast", () => {
  afterEach(() => vi.clearAllMocks());
  it("calls toast.success with static message on success", async () => {
    const result = await mutateWithToast(
      () => Promise.resolve(42),
      "Done.",
      "Failed",
    );
    expect(result).toBe(42);
    expect(notify.success).toHaveBeenCalledWith({ title: "Done." });
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("calls toast.success with dynamic message on success", async () => {
    await mutateWithToast(
      () => Promise.resolve({ name: "Alpha" }),
      (r) => `Team "${r.name}" created.`,
      "Create failed",
    );
    expect(notify.success).toHaveBeenCalledWith({
      title: 'Team "Alpha" created.',
    });
  });

  it("calls toast.error with prefix on failure", async () => {
    const result = await mutateWithToast(
      () => Promise.reject(new Error("network timeout")),
      "OK",
      "Update failed",
    );
    expect(result).toBeUndefined();
    expect(notify.error).toHaveBeenCalledWith({
      title: "Update failed: network timeout",
    });
    expect(notify.success).not.toHaveBeenCalled();
  });
});
