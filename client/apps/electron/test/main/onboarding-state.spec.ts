// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

import type { DesktopStateStorage } from "../../src/main/shared-storage/storage";
import {
  applyOnboardingEnvironment,
  completeOnboarding,
  readOnboardingState,
} from "../../src/main/windows-manager/onboarding-state";

function storageWith(initial?: unknown, flush = vi.fn(async () => undefined)) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set("onboardingState", initial);
  return {
    storage: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: <T>(key: string, value: T | undefined) => {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      },
      del: (key: string) => values.delete(key),
      clear: () => values.clear(),
      keys: () => [...values.keys()],
      watch: vi.fn(),
      all: () => Object.fromEntries(values),
      watchAll: vi.fn(),
      flush,
      dispose: vi.fn(async () => undefined),
    } as unknown as DesktopStateStorage,
    flush,
  };
}

describe("desktop onboarding state", () => {
  test.each([undefined, null, {}, { completed: "yes" }])(
    "uses the incomplete fresh default for invalid input %j",
    (initial) => {
      expect(readOnboardingState(storageWith(initial).storage)).toEqual({
        completed: false,
      });
    },
  );

  test("recognizes only the exact completed schema", () => {
    expect(
      readOnboardingState(storageWith({ completed: true }).storage),
    ).toEqual({ completed: true });
  });

  test.each([undefined, "", "0", "true", "yes"])(
    "does not skip onboarding for %j",
    async (value) => {
      const { storage, flush } = storageWith();
      await applyOnboardingEnvironment(storage, value);
      expect(readOnboardingState(storage)).toEqual({ completed: false });
      expect(flush).not.toHaveBeenCalled();
    },
  );

  test("persists SKIP_ONBOARDING=1 before reporting completion", async () => {
    const { storage, flush } = storageWith();
    await applyOnboardingEnvironment(storage, "1");
    expect(readOnboardingState(storage)).toEqual({ completed: true });
    expect(flush).toHaveBeenCalledOnce();
  });

  test("surfaces a completion write failure", async () => {
    const failure = new Error("disk unavailable");
    const { storage } = storageWith(
      undefined,
      vi.fn(async () => {
        throw failure;
      }),
    );
    await expect(completeOnboarding(storage)).rejects.toBe(failure);
  });
});
