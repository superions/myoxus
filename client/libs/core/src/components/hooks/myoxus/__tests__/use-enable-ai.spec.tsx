/**
 * @vitest-environment happy-dom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientFeature: true as boolean | null | undefined,
  serverCopilot: true as boolean | null | undefined,
  workspaceEnabled: true as boolean | null | undefined,
  workspaceCopilotPermission: true as boolean | null | undefined,
}));

vi.mock("@myoxus/core/modules/server", () => ({
  ServerService: class ServerService {},
}));

vi.mock("@myoxus/core/modules/feature-flag", () => ({
  FeatureFlagService: class FeatureFlagService {},
}));

vi.mock("@myoxus/core/modules/share-setting", () => ({
  WorkspaceShareSettingService: class WorkspaceShareSettingService {},
}));

vi.mock("@myoxus/core/components/guard", () => ({
  useGuard: vi.fn(() => mocks.workspaceCopilotPermission),
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useLiveData: (source: { value?: unknown }) => source.value,
  useService: (service: { name?: string }) => {
    switch (service.name) {
      case "FeatureFlagService":
        return {
          flags: {
            enable_ai: {
              $: { value: mocks.clientFeature },
            },
          },
        };
      case "ServerService":
        return {
          server: {
            features$: {
              value: { copilot: mocks.serverCopilot },
            },
          },
        };
      case "WorkspaceShareSettingService":
        return {
          sharePreview: {
            enableAi$: { value: mocks.workspaceEnabled },
          },
        };
      default:
        throw new Error(`unexpected service ${String(service.name)}`);
    }
  },
}));

import { isAIEnabledForWorkspace, useEnableAI } from "../use-enable-ai";

describe("isAIEnabledForWorkspace", () => {
  test("requires every existing AI gate to be explicitly enabled", () => {
    expect(
      isAIEnabledForWorkspace({
        clientFeature: true,
        serverCopilot: true,
        workspaceEnabled: true,
        workspaceCopilotPermission: true,
      }),
    ).toBe(true);

    for (const disabledGate of [
      "clientFeature",
      "serverCopilot",
      "workspaceEnabled",
      "workspaceCopilotPermission",
    ] as const) {
      expect(
        isAIEnabledForWorkspace({
          clientFeature: true,
          serverCopilot: true,
          workspaceEnabled: true,
          workspaceCopilotPermission: true,
          [disabledGate]: false,
        }),
      ).toBe(false);
    }
  });

  test("keeps loading or missing workspace state disabled to avoid AI flashes", () => {
    expect(
      isAIEnabledForWorkspace({
        clientFeature: true,
        serverCopilot: true,
        workspaceEnabled: null,
        workspaceCopilotPermission: true,
      }),
    ).toBe(false);
    expect(
      isAIEnabledForWorkspace({
        clientFeature: true,
        serverCopilot: true,
        workspaceEnabled: true,
        workspaceCopilotPermission: undefined,
      }),
    ).toBe(false);
  });
});

describe("useEnableAI", () => {
  beforeEach(() => {
    mocks.clientFeature = true;
    mocks.serverCopilot = true;
    mocks.workspaceEnabled = true;
    mocks.workspaceCopilotPermission = true;
  });

  test("enables AI only when the global, workspace, and permission gates are true", () => {
    expect(renderHook(() => useEnableAI()).result.current).toBe(true);

    mocks.workspaceEnabled = false;
    expect(renderHook(() => useEnableAI()).result.current).toBe(false);

    mocks.workspaceEnabled = true;
    mocks.workspaceCopilotPermission = false;
    expect(renderHook(() => useEnableAI()).result.current).toBe(false);

    mocks.workspaceCopilotPermission = true;
    mocks.serverCopilot = false;
    expect(renderHook(() => useEnableAI()).result.current).toBe(false);

    mocks.serverCopilot = true;
    mocks.clientFeature = false;
    expect(renderHook(() => useEnableAI()).result.current).toBe(false);
  });
});
