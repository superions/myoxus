/** @vitest-environment happy-dom */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

const mocked = vi.hoisted(() => {
  const schemaSnapshot = {
    modules: [
      {
        module: "server",
        label: "Server",
        groups: [],
      },
    ],
  };

  const valuesSnapshot = {
    revision: "config-revision",
    effectiveFields: [],
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
                value: "Myoxus",
              },
            ],
          },
        ],
      },
    ],
  };

  const useQueryMock = vi.fn();
  const useMutationMock = vi.fn();

  return {
    schemaSnapshot,
    valuesSnapshot,
    useQueryMock,
    useMutationMock,
    updateConfigMock: vi.fn(),
    schemaMutateMock: vi.fn(),
    valuesMutateMock: vi.fn(),
  };
});

vi.mock("@myoxus/admin/use-query", () => ({
  useQuery: (options: { query: { id: string } }) =>
    mocked.useQueryMock(options),
}));

vi.mock("@myoxus/admin/use-mutation", () => ({
  useMutation: (options: { mutation: { id: string } }) =>
    mocked.useMutationMock(options),
}));

import {
  adminConfigSchemaQuery,
  adminConfigValuesQuery,
  adminUpdateConfigMutation,
} from "@myoxus/graphql";

import {
  type AdminConfigSchemaSnapshot,
  type AdminConfigSnapshot,
  adminConfigSnapshotToAppConfig,
  adminConfigFieldErrorsByPath,
  normalizeAdminConfigSnapshot,
  useAdminConfigContract,
} from "./use-admin-config-contract";

describe("useAdminConfigContract", () => {
  beforeEach(() => {
    mocked.useQueryMock.mockReset();
    mocked.useMutationMock.mockReset();
    mocked.updateConfigMock.mockReset();
    mocked.schemaMutateMock.mockReset();
    mocked.valuesMutateMock.mockReset();
    mocked.schemaMutateMock.mockResolvedValue({
      admin: { adminConfigSchema: mocked.schemaSnapshot },
    });
    mocked.valuesMutateMock.mockResolvedValue({
      admin: { adminConfigValues: mocked.valuesSnapshot },
    });

    mocked.useQueryMock.mockImplementation(
      (options: { query: { id: string } }) => {
        if (options.query.id === adminConfigSchemaQuery.id) {
          return {
            data: { admin: { adminConfigSchema: mocked.schemaSnapshot } },
            mutate: mocked.schemaMutateMock,
          };
        }

        if (options.query.id === adminConfigValuesQuery.id) {
          return {
            data: { admin: { adminConfigValues: mocked.valuesSnapshot } },
            mutate: mocked.valuesMutateMock,
          };
        }

        throw new Error(`Unexpected query id: ${options.query.id}`);
      },
    );

    mocked.useMutationMock.mockImplementation(
      (options: { mutation: { id: string } }) => {
        if (options.mutation.id !== adminUpdateConfigMutation.id) {
          throw new Error(`Unexpected mutation id: ${options.mutation.id}`);
        }

        return {
          trigger: mocked.updateConfigMock,
        };
      },
    );

    mocked.updateConfigMock.mockResolvedValue({
      admin: {
        adminUpdateConfig: {
          applied: true,
          config: mocked.valuesSnapshot,
          fieldErrors: [],
        },
      },
    });
  });

  test("binds admin schema, values and update mutation", async () => {
    const { result } = renderHook(() => useAdminConfigContract());

    expect(result.current.schema).toBe(mocked.schemaSnapshot);
    expect(result.current.values).toBe(mocked.valuesSnapshot);
    expect(mocked.useQueryMock).toHaveBeenCalledWith({
      query: adminConfigSchemaQuery,
    });
    expect(mocked.useQueryMock).toHaveBeenCalledWith({
      query: adminConfigValuesQuery,
    });
    expect(mocked.useMutationMock).toHaveBeenCalledWith({
      mutation: adminUpdateConfigMutation,
    });

    const updateResult = await result.current.updateConfig({
      updates: [
        {
          module: "server",
          key: "name",
          value: "Myoxus Workspace",
        },
      ],
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

    // Verify the envelope is unwrapped — consumer gets flat AdminConfigUpdateResult
    expect(updateResult.applied).toBe(true);
    expect(updateResult.fieldErrors).toEqual([]);
  });

  test("materializes values and update snapshots but excludes schema snapshots", () => {
    const updatedValues = structuredClone(mocked.valuesSnapshot);
    updatedValues.modules[0].groups[0].fields[0].value = "Updated Myoxus";

    expect(adminConfigSnapshotToAppConfig(mocked.valuesSnapshot)).toEqual({
      server: { name: "Myoxus" },
    });
    expect(adminConfigSnapshotToAppConfig(updatedValues)).toEqual({
      server: { name: "Updated Myoxus" },
    });
    expectTypeOf<AdminConfigSchemaSnapshot>().not.toMatchTypeOf<AdminConfigSnapshot>();
  });

  test("maps structured field errors to the UI field path", () => {
    const fieldErrors = [
      {
        module: "storage",
        key: "backend",
        path: "storage.backend",
        message: "backend is required",
      },
    ];

    expect(adminConfigFieldErrorsByPath(fieldErrors)).toEqual({
      "storage/backend": fieldErrors[0],
    });
  });

  test("reloads schema and values together instead of retrying stale render state", async () => {
    const { result } = renderHook(() => useAdminConfigContract());

    const refreshed = await result.current.reloadServerState();

    expect(mocked.schemaMutateMock).toHaveBeenCalledOnce();
    expect(mocked.valuesMutateMock).toHaveBeenCalledOnce();
    expect(refreshed).toEqual({
      schema: mocked.schemaSnapshot,
      values: mocked.valuesSnapshot,
    });
  });

  test("normalizes partial, wrong-type and unknown values without exposing raw values", () => {
    const schema = {
      revision: "schema-revision",
      effectiveFields: [
        {
          path: "git_sync.enabled",
          winningSource: "ENVIRONMENT",
          runtimeEffectiveValue: false,
          runtimeEffectiveState: "PENDING_RESTART",
          requiresRestart: true,
          sensitive: false,
        },
      ],
      modules: [
        {
          module: "git_sync",
          label: "Git Sync",
          groups: [
            {
              groupKey: "policy",
              label: "Policy",
              helpText: null,
              fields: [
                {
                  path: "git_sync.enabled",
                  key: "enabled",
                  label: "Enabled",
                  groupKey: "policy",
                  valueType: "Boolean",
                  defaultValue: true,
                  databaseWritable: true,
                  sensitive: false,
                },
                {
                  path: "git_sync.default_branch",
                  key: "default_branch",
                  label: "Default branch",
                  groupKey: "policy",
                  valueType: "String",
                  defaultValue: "main",
                  databaseWritable: true,
                  sensitive: false,
                },
              ],
            },
          ],
        },
      ],
    } as any;
    const values = {
      revision: "config-revision",
      modules: [
        {
          module: "git_sync",
          groups: [
            {
              fields: [
                { path: "git_sync.enabled", value: "raw-secret-like-value" },
                { path: "git_sync.retired_field", value: 42 },
              ],
            },
          ],
        },
      ],
    } as any;

    const normalized = normalizeAdminConfigSnapshot(schema, values);

    expect(normalized.config).toEqual({
      git_sync: { enabled: true, default_branch: "main" },
    });
    expect(normalized.issues).toEqual(
      expect.arrayContaining([
        {
          code: "VALUE_TYPE",
          path: "git_sync.enabled",
          expectedType: "Boolean",
          actualType: "String",
        },
        {
          code: "VALUE_MISSING",
          path: "git_sync.default_branch",
          expectedType: "String",
          actualType: "Missing",
        },
        {
          code: "UNKNOWN_FIELD",
          path: "git_sync.retired_field",
          expectedType: "KnownSchemaField",
          actualType: "Number",
        },
      ]),
    );
    expect(JSON.stringify(normalized.issues)).not.toContain(
      "raw-secret-like-value",
    );
    expect(normalized.fieldStates["git_sync.enabled"]).toMatchObject({
      editable: true,
      winningSource: "ENVIRONMENT",
      runtimeEffectiveValue: false,
      runtimeEffectiveState: "PENDING_RESTART",
      requiresRestart: true,
    });
    expect(normalized.schemaRevision).toBe("schema-revision");
    expect(normalized.configRevision).toBe("config-revision");
  });

  test("rejects unsafe schema and value paths before constructing editable config", () => {
    const schema = {
      revision: "schema-revision",
      modules: [
        {
          module: "git_sync",
          groups: [
            {
              fields: [
                {
                  path: "git_sync.__proto__.enabled",
                  valueType: "Boolean",
                  defaultValue: true,
                  databaseWritable: true,
                },
              ],
            },
          ],
        },
      ],
    } as any;
    const values = {
      revision: "config-revision",
      modules: [
        {
          module: "git_sync",
          groups: [
            {
              fields: [
                {
                  path: "git_sync.__proto__.enabled",
                  value: true,
                },
                {
                  path: "git_sync/invalid",
                  value: "raw-value-must-not-surface",
                },
              ],
            },
          ],
        },
      ],
    } as any;

    const normalized = normalizeAdminConfigSnapshot(schema, values);

    expect(normalized.config).toEqual({});
    expect(normalized.issues).toEqual(
      expect.arrayContaining([
        {
          code: "UNSAFE_PATH",
          path: "git_sync.__proto__.enabled",
          expectedType: "SafeConfigPath",
          actualType: "InvalidPath",
        },
        {
          code: "UNSAFE_PATH",
          path: "git_sync/invalid",
          expectedType: "SafeConfigPath",
          actualType: "InvalidPath",
        },
      ]),
    );
    expect(JSON.stringify(normalized.issues)).not.toContain(
      "raw-value-must-not-surface",
    );
    expect(({} as { enabled?: boolean }).enabled).toBeUndefined();
  });
});
