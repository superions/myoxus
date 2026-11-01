/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocked = vi.hoisted(() => {
  const makeSnapshot = (serverName: string, allowSignup: boolean) => ({
    modules: [
      {
        module: "server",
        label: "Server",
        groups: [
          {
            groupKey: "server",
            label: "Server",
            helpText: null,
            fields: [
              {
                path: "server.name",
                key: "name",
                label: "Name",
                groupKey: "server",
                valueType: "String",
                sensitive: false,
                enum: [],
                min: null,
                max: null,
                helpText: null,
                value: serverName,
              },
            ],
          },
        ],
      },
      {
        module: "auth",
        label: "Accounts",
        groups: [
          {
            groupKey: "auth",
            label: "Accounts",
            helpText: null,
            fields: [
              {
                path: "auth.allow_signup",
                key: "allow_signup",
                label: "Allow signup",
                groupKey: "auth",
                valueType: "Boolean",
                sensitive: false,
                enum: [],
                min: null,
                max: null,
                helpText: null,
                value: allowSignup,
              },
            ],
          },
        ],
      },
      {
        module: "storage",
        label: "Storage",
        groups: [
          {
            groupKey: "storage",
            label: "Storage",
            helpText: null,
            fields: [
              {
                path: "storage.backend",
                key: "backend",
                label: "Provider",
                groupKey: "storage",
                valueType: "String",
                sensitive: false,
                enum: [],
                min: null,
                max: null,
                helpText: null,
                value: "fs",
              },
            ],
          },
        ],
      },
    ],
  });

  let valuesSnapshot = {
    adminConfigValues: makeSnapshot("Myoxus", true),
  };

  return {
    getValuesSnapshot: () => valuesSnapshot,
    setValuesSnapshot: (next: typeof valuesSnapshot) => {
      valuesSnapshot = next;
    },
    makeSnapshot,
    updateConfigMock: vi.fn(),
    mutateValuesMock: vi.fn(),
    notifySuccessMock: vi.fn(),
    notifyWarningMock: vi.fn(),
    notifyErrorMock: vi.fn(),
  };
});

vi.mock("./use-admin-config-contract", () => ({
  adminConfigSnapshotToAppConfig: (snapshot: { modules?: Array<any> }) => {
    const config: Record<string, unknown> = {};
    for (const module of snapshot?.modules ?? []) {
      for (const group of module.groups ?? []) {
        for (const field of group.fields ?? []) {
          if (!field.path) continue;
          const path = field.path.split(".");
          let cursor = config;
          for (let i = 0; i < path.length - 1; i += 1) {
            const segment = path[i];
            if (!cursor[segment] || typeof cursor[segment] !== "object") {
              cursor[segment] = {};
            }
            cursor = cursor[segment] as Record<string, unknown>;
          }
          cursor[path[path.length - 1]] = field.value;
        }
      }
    }
    return config;
  },
  normalizeAdminConfigSnapshot: (
    _schema: unknown,
    snapshot: { modules?: Array<any> },
  ) => {
    const config: Record<string, unknown> = {};
    for (const module of snapshot?.modules ?? []) {
      for (const group of module.groups ?? []) {
        for (const field of group.fields ?? []) {
          const [root, ...rest] = field.path.split(".");
          const moduleConfig = (config[root] ??= {}) as Record<string, unknown>;
          moduleConfig[rest.join(".")] = field.value;
        }
      }
    }
    return {
      config,
      issues: [],
      fieldStates: {},
      schemaRevision: "test-schema",
      configRevision: "test-config",
    };
  },
  adminConfigFieldErrorsByPath: (
    fieldErrors: Array<{ path: string; message: string }>,
  ) =>
    fieldErrors.reduce(
      (acc, fieldError) => {
        const [module, ...rest] = fieldError.path.split(".");
        acc[`${module}/${rest.join(".")}`] = fieldError;
        return acc;
      },
      {} as Record<string, { path: string; message: string }>,
    ),
  formatAdminConfigFieldErrors: (
    fieldErrors: Array<{ path: string; message: string }>,
  ) =>
    fieldErrors.length === 0
      ? "Settings update failed."
      : fieldErrors
          .map(({ path, message }) => `${path}: ${message}`)
          .join("; "),
  pickAppConfigModules: (
    config: Record<string, unknown>,
    modules: string[],
  ) => {
    const partial: Record<string, unknown> = {};
    for (const module of modules) {
      if (Object.prototype.hasOwnProperty.call(config, module)) {
        partial[module] = config[module];
      }
    }
    return partial;
  },
  useAdminConfigContract: () => ({
    schema: { modules: [] },
    values: mocked.getValuesSnapshot().adminConfigValues,
    mutateValues: mocked.mutateValuesMock,
    updateConfig: mocked.updateConfigMock,
    schemaError: undefined,
    valuesError: undefined,
    isLoading: false,
    reloadServerState: async () => ({
      schema: { modules: [] },
      values: mocked.getValuesSnapshot().adminConfigValues,
    }),
  }),
}));

vi.mock("@myoxus/ui-facade", () => ({
  notify: {
    success: mocked.notifySuccessMock,
    warning: mocked.notifyWarningMock,
    error: mocked.notifyErrorMock,
  },
}));

import { useAppConfig } from "./use-app-config";

describe("useAppConfig", () => {
  beforeEach(() => {
    mocked.setValuesSnapshot({
      adminConfigValues: mocked.makeSnapshot("Myoxus", true),
    });

    mocked.updateConfigMock.mockReset();
    mocked.mutateValuesMock.mockReset();
    mocked.notifySuccessMock.mockReset();
    mocked.notifyWarningMock.mockReset();
    mocked.notifyErrorMock.mockReset();

    mocked.updateConfigMock.mockResolvedValue({
      applied: true,
      config: mocked.makeSnapshot("Myoxus", true),
      fieldErrors: [],
    });
    mocked.mutateValuesMock.mockResolvedValue(undefined);
  });

  test("clears dirty state when value is changed back to original", () => {
    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.update("server/name", "Myoxus Workspace");
    });
    expect(result.current.isGroupDirty("server")).toBe(true);

    act(() => {
      result.current.update("server/name", "Myoxus");
    });
    expect(result.current.isGroupDirty("server")).toBe(false);
  });

  test("resetGroup cancels only target group changes immediately", () => {
    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.update("server/name", "Myoxus Workspace");
      result.current.update("auth/allow_signup", false);
    });

    expect(result.current.isGroupDirty("server")).toBe(true);
    expect(result.current.isGroupDirty("auth")).toBe(true);

    act(() => {
      result.current.resetGroup("server");
    });

    expect(result.current.isGroupDirty("server")).toBe(false);
    expect(result.current.isGroupDirty("auth")).toBe(true);
    expect(result.current.patchedAppConfig.server.name).toBe("Myoxus");
    expect(result.current.getGroupVersion("server")).toBe(1);
  });

  test("saveGroup submits only target group updates and keeps others dirty", async () => {
    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.update("server/name", "Myoxus Workspace");
      result.current.update("auth/allow_signup", false);
    });

    mocked.updateConfigMock.mockResolvedValue({
      applied: true,
      config: mocked.makeSnapshot("Myoxus Workspace", true),
      fieldErrors: [],
    });

    await act(async () => {
      await result.current.saveGroup("server");
    });

    expect(mocked.updateConfigMock).toHaveBeenCalledWith({
      updates: [
        {
          module: "server",
          key: "name",
          value: "Myoxus Workspace",
        },
      ],
    });
    expect(result.current.isGroupDirty("server")).toBe(false);
    expect(result.current.isGroupDirty("auth")).toBe(true);
    expect(result.current.patchedAppConfig.server.name).toBe(
      "Myoxus Workspace",
    );
    expect(result.current.getGroupVersion("server")).toBe(1);
    expect(mocked.mutateValuesMock).toHaveBeenCalledTimes(1);
    expect(mocked.notifySuccessMock).toHaveBeenCalledTimes(1);
  });

  test("saveGroup preserves dirty state and reports field errors", async () => {
    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.update("server/name", "broken-value");
    });

    mocked.updateConfigMock.mockResolvedValue({
      applied: false,
      config: mocked.makeSnapshot("Myoxus", true),
      fieldErrors: [
        {
          module: "server",
          key: "name",
          path: "server.name",
          message: "Name too short",
        },
      ],
    });

    await act(async () => {
      await result.current.saveGroup("server");
    });

    expect(result.current.isGroupDirty("server")).toBe(true);
    expect(result.current.patchedAppConfig.server.name).toBe("broken-value");
    expect(result.current.fieldErrors).toHaveLength(1);
    expect(result.current.fieldErrorsByPath["server/name"]).toEqual({
      module: "server",
      key: "name",
      path: "server.name",
      message: "Name too short",
    });
    expect(mocked.mutateValuesMock).not.toHaveBeenCalled();
    expect(mocked.notifyErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Save failed",
        message: expect.stringContaining("server.name: Name too short"),
      }),
    );
  });

  test("provider child edits submit one complete ordered map and retain it on rejection", async () => {
    const providers = {
      openai: {
        kind: "openai",
        enabled: true,
        endpoint: "https://api.example/v1",
        api_key: "********",
        models: ["first", "fallback"],
        timeout_ms: 30000,
      },
      local: {
        kind: "local",
        enabled: false,
        endpoint: "http://localhost:11434/v1",
        api_key: "",
        models: ["local-first"],
        timeout_ms: 60000,
      },
    };
    const { result } = renderHook(() => useAppConfig());
    act(() => {
      result.current.update("copilot/providers", providers);
      result.current.update("copilot/providers/openai.models", [
        "first",
        "second",
        "fallback",
      ]);
      result.current.update("copilot/providers/openai.timeout_ms", 45000);
      result.current.update("copilot/providers/local.enabled", true);
    });
    const expected = {
      openai: {
        ...providers.openai,
        models: ["first", "second", "fallback"],
        timeout_ms: 45000,
      },
      local: { ...providers.local, enabled: true },
    };
    mocked.updateConfigMock.mockResolvedValue({
      applied: false,
      config: mocked.makeSnapshot("Myoxus", true),
      fieldErrors: [
        {
          module: "copilot",
          key: "providers",
          path: "copilot.providers",
          message: "Provider rejected",
        },
      ],
    });
    await act(async () => {
      await result.current.saveGroup("copilot");
    });
    expect(mocked.updateConfigMock).toHaveBeenCalledExactlyOnceWith({
      updates: [{ module: "copilot", key: "providers", value: expected }],
    });
    expect(result.current.patchedAppConfig.copilot.providers).toEqual(expected);
    expect(result.current.fieldErrorsByPath["copilot/providers"]?.message).toBe(
      "Provider rejected",
    );
    expect(result.current.isGroupDirty("copilot")).toBe(true);
    expect(mocked.notifySuccessMock).not.toHaveBeenCalled();
  });

  test("removeOverrides releases all requested database values in one batch", async () => {
    const { result } = renderHook(() => useAppConfig());

    await act(async () => {
      await result.current.removeOverrides([
        "preview/max_text_chars",
        "preview/max_active_global_renders",
      ]);
    });

    expect(mocked.updateConfigMock).toHaveBeenCalledWith({
      updates: [
        { module: "preview", key: "max_text_chars", value: null },
        {
          module: "preview",
          key: "max_active_global_renders",
          value: null,
        },
      ],
    });
    expect(mocked.mutateValuesMock).toHaveBeenCalledTimes(1);
    expect(mocked.notifySuccessMock).toHaveBeenCalledTimes(1);
  });

  test("reports a committed save with failed YAML mirroring as a warning", async () => {
    const { result } = renderHook(() => useAppConfig());

    act(() => {
      result.current.update("server/name", "NewName");
    });
    mocked.updateConfigMock.mockResolvedValue({
      applied: true,
      writeback: "failed",
      fieldErrors: [],
      config: mocked.makeSnapshot("NewName", true),
    });

    await act(async () => {
      await result.current.saveGroup("server");
    });

    expect(mocked.notifyWarningMock).toHaveBeenCalledTimes(1);
    expect(mocked.notifySuccessMock).not.toHaveBeenCalled();
    expect(mocked.notifyErrorMock).not.toHaveBeenCalled();
    expect(result.current.isGroupDirty("server")).toBe(false);
  });
});
