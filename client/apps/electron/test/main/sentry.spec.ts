/**
 * P-DEPS-ELEC-A-01-T — Sentry upgrade compat guard
 *
 * Verifies that the Sentry initialization path in main/index.ts:
 *  - calls Sentry.init with the required fields (dsn, environment, ipcMode)
 *  - calls Sentry.setTags with distribution and appVersion
 *  - does NOT call init when SENTRY_RELEASE is absent
 *
 * These tests guard against API breaks introduced by @sentry/electron upgrades.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInit = vi.fn();
const mockSetTags = vi.fn();

vi.mock("@sentry/electron/main", () => ({
  init: mockInit,
  setTags: mockSetTags,
  IPCMode: { Protocol: "protocol" },
}));

vi.mock("electron", () => ({
  app: {
    enableSandbox: vi.fn(),
    getVersion: vi.fn().mockReturnValue("1.2.3"),
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    whenReady: vi.fn().mockReturnValue(new Promise(() => {})),
    getPath: vi.fn().mockReturnValue("/tmp/mock-userData"),
    setPath: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    isReady: vi.fn().mockReturnValue(false),
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
  },
}));

// Prevent the index module from trying to import other electron sub-modules at test time
vi.mock("../../src/main/security-restrictions", () => ({}));
vi.mock("../../src/main/application-menu/create", () => ({
  createApplicationMenu: vi.fn(),
}));
vi.mock("../../src/main/config", () => ({
  buildType: "internal",
  isDev: false,
  overrideSession: false,
}));
vi.mock("../../src/main/deep-link", () => ({ setupDeepLink: vi.fn() }));
vi.mock("../../src/main/events", () => ({ registerEvents: vi.fn() }));
vi.mock("../../src/main/handlers", () => ({ registerHandlers: vi.fn() }));
vi.mock("../../src/main/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../src/main/protocol", () => ({ registerProtocol: vi.fn() }));
vi.mock("../../src/main/recording/feature", () => ({
  setupRecordingFeature: vi.fn(),
}));
vi.mock("../../src/main/tray", () => ({ setupTrayState: vi.fn() }));
vi.mock("../../src/main/updater", () => ({ registerUpdater: vi.fn() }));
vi.mock("../../src/main/windows-manager/launcher", () => ({
  launch: vi.fn().mockResolvedValue(undefined),
}));
describe("Sentry init — P-DEPS-ELEC-A-01-T", () => {
  beforeEach(() => {
    vi.resetModules();
    mockInit.mockClear();
    mockSetTags.mockClear();
  });

  afterEach(() => {
    delete process.env.SENTRY_RELEASE;
    delete process.env.SENTRY_DSN;
    delete process.env.BUILD_TYPE;
  });

  it("INV-SENTRY-01: Sentry.init is NOT called when SENTRY_RELEASE is unset", async () => {
    delete process.env.SENTRY_RELEASE;
    await import("../../src/main/index");
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("INV-SENTRY-02: Sentry.init is called with required fields when SENTRY_RELEASE is set", async () => {
    process.env.SENTRY_RELEASE = "1.2.3";
    process.env.SENTRY_DSN = "https://test@sentry.io/123";
    process.env.BUILD_TYPE = "internal";
    await import("../../src/main/index");
    expect(mockInit).toHaveBeenCalledOnce();
    const callArgs = mockInit.mock.calls[0][0];
    expect(callArgs).toHaveProperty("dsn", "https://test@sentry.io/123");
    expect(callArgs).toHaveProperty("environment", "internal");
    expect(callArgs).toHaveProperty("ipcMode", "protocol");
    expect(callArgs.transportOptions).toMatchObject({
      maxAgeDays: 30,
      maxQueueSize: 100,
    });
  });

  it("INV-SENTRY-03: Sentry.setTags is called with distribution and appVersion", async () => {
    process.env.SENTRY_RELEASE = "1.2.3";
    await import("../../src/main/index");
    expect(mockSetTags).toHaveBeenCalledOnce();
    const tags = mockSetTags.mock.calls[0][0];
    expect(tags).toHaveProperty("distribution", "electron");
    expect(tags).toHaveProperty("appVersion", "1.2.3");
  });
});
