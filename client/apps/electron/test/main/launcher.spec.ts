// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    flush: vi.fn(async () => undefined),
    show: vi.fn(),
    initMain: vi.fn(async () => undefined),
    createOnboarding: vi.fn(async () => ({
      isVisible: () => false,
      show: runtime.show,
    })),
  };
});

vi.mock("../../src/main/shared-storage/storage", () => ({
  globalStateStorage: {
    get: (key: string) => runtime.values.get(key),
    set: (key: string, value: unknown) => runtime.values.set(key, value),
    flush: runtime.flush,
  },
}));
vi.mock("../../src/main/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/main/windows-manager/main-window", () => ({
  initAndShowMainWindow: runtime.initMain,
}));
vi.mock("../../src/main/windows-manager/onboarding", () => ({
  getOrCreateOnboardingWindow: runtime.createOnboarding,
}));

import { launch } from "../../src/main/windows-manager/launcher";

beforeEach(() => {
  runtime.values.clear();
  runtime.flush.mockClear();
  runtime.show.mockClear();
  runtime.initMain.mockClear();
  runtime.createOnboarding.mockClear();
  delete process.env.SKIP_ONBOARDING;
});

describe("desktop launcher", () => {
  test("shows onboarding for a fresh profile instead of opening main", async () => {
    await launch();
    expect(runtime.createOnboarding).toHaveBeenCalledOnce();
    expect(runtime.show).toHaveBeenCalledOnce();
    expect(runtime.initMain).not.toHaveBeenCalled();
  });

  test("opens main directly only for durably completed onboarding", async () => {
    runtime.values.set("onboardingState", { completed: true });
    await launch();
    expect(runtime.initMain).toHaveBeenCalledOnce();
    expect(runtime.createOnboarding).not.toHaveBeenCalled();
  });

  test("flushes the exact SKIP_ONBOARDING=1 state before opening main", async () => {
    process.env.SKIP_ONBOARDING = "1";
    await launch();
    expect(runtime.values.get("onboardingState")).toEqual({ completed: true });
    expect(runtime.flush).toHaveBeenCalledOnce();
    expect(runtime.initMain).toHaveBeenCalledOnce();
  });
});
