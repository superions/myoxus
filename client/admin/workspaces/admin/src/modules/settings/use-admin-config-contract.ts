/**
 * Contract hook for the admin config GraphQL API.
 *
 * Binds the server-authoritative schema/values queries plus the update
 * mutation and provides helpers to convert the snapshot payload back into the
 * nested config object shape used by the admin pages.
 */
import { useMutation } from "@myoxus/admin/use-mutation";
import { useQuery } from "@myoxus/admin/use-query";
import {
  type AdminConfigFieldErrorType,
  type AdminConfigSchemaQuery,
  adminConfigSchemaQuery,
  type AdminConfigValuesQuery,
  adminConfigValuesQuery,
  type AdminConfigValueType,
  type AdminUpdateConfigMutation,
  adminUpdateConfigMutation,
  type UpdateAppConfigInput,
} from "@myoxus/graphql";
import { useCallback } from "react";

import type { AppConfig } from "./config";
import { setByPath } from "./utils";

export type AdminConfigFieldError = AdminConfigFieldErrorType;
export type AdminConfigFieldErrorMap = Record<
  string,
  AdminConfigFieldErrorType
>;
export type AdminConfigSchemaSnapshot =
  AdminConfigSchemaQuery["admin"]["adminConfigSchema"];
export type AdminConfigValuesSnapshot =
  AdminConfigValuesQuery["admin"]["adminConfigValues"];
export type AdminConfigUpdateResult =
  AdminUpdateConfigMutation["admin"]["adminUpdateConfig"];
export type AdminConfigSnapshot =
  AdminConfigValuesSnapshot | AdminConfigUpdateResult["config"];
export { type UpdateAppConfigInput };

export type AdminConfigNormalizationIssue = {
  code:
    | "SCHEMA_MISSING"
    | "VALUE_MISSING"
    | "VALUE_TYPE"
    | "DEFAULT_TYPE"
    | "UNKNOWN_FIELD"
    | "UNSAFE_PATH";
  path: string;
  expectedType: string;
  actualType: string;
};

export type AdminConfigFieldState = {
  editable: boolean;
  databaseWritable: boolean;
  winningSource?: string;
  requiresRestart: boolean;
  runtimeEffectiveValue?: unknown;
  runtimeEffectiveState?: string;
  sensitive: boolean;
};

export type NormalizedAdminConfig = {
  config: AppConfig;
  issues: AdminConfigNormalizationIssue[];
  fieldStates: Record<string, AdminConfigFieldState>;
  schemaRevision: string;
  configRevision: string;
};

type ConfigSnapshotLike = {
  revision?: string;
  modules?: Array<{
    module: string;
    groups?: Array<{
      fields?: Array<{
        path: string;
        value?: unknown;
        defaultValue?: unknown;
        valueType?: AdminConfigValueType | string;
        databaseWritable?: boolean;
        sensitive?: boolean;
        restart_required?: boolean;
        requiresRestart?: boolean;
      }>;
    }>;
  }>;
  effectiveFields?: Array<{
    path: string;
    winningSource?: string | null;
    runtimeEffectiveValue?: unknown;
    runtimeEffectiveState?: string | null;
    requiresRestart?: boolean;
    sensitive?: boolean;
  }>;
};

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  switch (typeof value) {
    case "boolean":
      return "Boolean";
    case "number":
      return Number.isFinite(value) ? "Number" : "NonFiniteNumber";
    case "string":
      return "String";
    case "object":
      return "Object";
    case "undefined":
      return "Missing";
    default:
      return "Unsupported";
  }
}

function valueMatchesType(
  value: unknown,
  expected: AdminConfigValueType | string,
  nullable: boolean,
) {
  if (value === null) return nullable;
  return valueType(value) === expected;
}

function snapshotFields(snapshot?: ConfigSnapshotLike | null) {
  return (snapshot?.modules ?? []).flatMap((module) =>
    (module.groups ?? []).flatMap((group) => group.fields ?? []),
  );
}

const CONFIG_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;
const UNSAFE_CONFIG_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isSafeConfigPath(path: string) {
  const segments = path.split(".");
  return (
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        CONFIG_PATH_SEGMENT.test(segment) &&
        !UNSAFE_CONFIG_PATH_SEGMENTS.has(segment),
    )
  );
}

/**
 * Normalizes a values snapshot strictly against the server schema. Invalid
 * values never reach product controls; the matching server-owned fallback is
 * used and a structural issue is retained for visible diagnosis.
 */
export function normalizeAdminConfigSnapshot(
  schema?: AdminConfigSchemaSnapshot | null,
  values?: AdminConfigValuesSnapshot | AdminConfigUpdateResult["config"] | null,
): NormalizedAdminConfig {
  const typedSchema = schema as ConfigSnapshotLike | null | undefined;
  const typedValues = values as ConfigSnapshotLike | null | undefined;
  const config: Record<string, unknown> = {};
  const issues: AdminConfigNormalizationIssue[] = [];
  const valueFields = new Map(
    snapshotFields(typedValues).map((field) => [field.path, field]),
  );
  const schemaFields = snapshotFields(typedSchema);
  const schemaPaths = new Set<string>();
  const effectiveFields = new Map(
    [
      ...(typedSchema?.effectiveFields ?? []),
      ...(typedValues?.effectiveFields ?? []),
    ].map((field) => [field.path, field]),
  );
  const fieldStates: Record<string, AdminConfigFieldState> = {};

  if (!typedSchema || schemaFields.length === 0) {
    issues.push({
      code: "SCHEMA_MISSING",
      path: "git_sync",
      expectedType: "ServerSchema",
      actualType: "Missing",
    });
  }

  for (const field of schemaFields) {
    if (!isSafeConfigPath(field.path)) {
      issues.push({
        code: "UNSAFE_PATH",
        path: field.path,
        expectedType: "SafeConfigPath",
        actualType: "InvalidPath",
      });
      continue;
    }
    schemaPaths.add(field.path);

    const expected = field.valueType ?? "Unsupported";
    const current = valueFields.get(field.path);
    const fallback = field.defaultValue;
    const nullable = fallback === null;
    const effective = effectiveFields.get(field.path);
    const winningSource = effective?.winningSource ?? undefined;
    const databaseWritable = Boolean(field.databaseWritable);
    fieldStates[field.path] = {
      editable: databaseWritable,
      databaseWritable,
      winningSource: winningSource ?? undefined,
      requiresRestart: Boolean(
        effective?.requiresRestart ??
        field.restart_required ??
        field.requiresRestart,
      ),
      runtimeEffectiveValue: effective?.runtimeEffectiveValue,
      runtimeEffectiveState: effective?.runtimeEffectiveState ?? undefined,
      sensitive: Boolean(effective?.sensitive ?? field.sensitive),
    };

    let normalizedValue: unknown;
    if (!current) {
      issues.push({
        code: "VALUE_MISSING",
        path: field.path,
        expectedType: String(expected),
        actualType: "Missing",
      });
      normalizedValue = fallback;
    } else if (!valueMatchesType(current.value, expected, nullable)) {
      issues.push({
        code: "VALUE_TYPE",
        path: field.path,
        expectedType: String(expected),
        actualType: valueType(current.value),
      });
      normalizedValue = fallback;
    } else {
      normalizedValue = current.value;
    }

    if (
      normalizedValue !== undefined &&
      !valueMatchesType(normalizedValue, expected, nullable)
    ) {
      issues.push({
        code: "DEFAULT_TYPE",
        path: field.path,
        expectedType: String(expected),
        actualType: valueType(normalizedValue),
      });
      continue;
    }
    if (normalizedValue !== undefined) {
      setByPath(config, field.path, structuredClone(normalizedValue));
    }
  }

  for (const field of valueFields.values()) {
    if (!isSafeConfigPath(field.path)) {
      issues.push({
        code: "UNSAFE_PATH",
        path: field.path,
        expectedType: "SafeConfigPath",
        actualType: "InvalidPath",
      });
      continue;
    }
    if (!schemaPaths.has(field.path)) {
      issues.push({
        code: "UNKNOWN_FIELD",
        path: field.path,
        expectedType: "KnownSchemaField",
        actualType: valueType(field.value),
      });
    }
  }

  return {
    config: config as AppConfig,
    issues,
    fieldStates,
    schemaRevision: typedSchema?.revision ?? "missing",
    configRevision: typedValues?.revision ?? "missing",
  };
}

export const adminConfigSnapshotToAppConfig = (
  snapshot?: AdminConfigSnapshot | null,
  schema?: AdminConfigSchemaSnapshot | null,
): AppConfig => {
  if (schema) {
    return normalizeAdminConfigSnapshot(schema, snapshot).config;
  }
  const config: Record<string, unknown> = {};

  for (const module of snapshot?.modules ?? []) {
    for (const group of module.groups ?? []) {
      for (const field of group.fields ?? []) {
        if (!field.path) {
          continue;
        }
        setByPath(config, field.path, structuredClone(field.value));
      }
    }
  }

  return config as AppConfig;
};

export const pickAppConfigModules = (
  config: AppConfig,
  modules: string[],
): Partial<AppConfig> => {
  const partial: Record<string, unknown> = {};

  for (const module of modules) {
    if (Object.prototype.hasOwnProperty.call(config, module)) {
      partial[module] = structuredClone(config[module as keyof AppConfig]);
    }
  }

  return partial as Partial<AppConfig>;
};

export const formatAdminConfigFieldErrors = (
  fieldErrors: AdminConfigFieldErrorType[],
): string => {
  if (fieldErrors.length === 0) {
    return "Settings update failed.";
  }

  return fieldErrors
    .map(({ path, message }) => `${path}: ${message}`)
    .join("; ");
};

export const adminConfigFieldErrorUiPath = (
  fieldError: AdminConfigFieldErrorType,
): string => {
  const prefix = `${fieldError.module}.${fieldError.key}`;

  if (fieldError.path === prefix) {
    return `${fieldError.module}/${fieldError.key}`;
  }

  if (fieldError.path.startsWith(`${prefix}.`)) {
    const remainder = fieldError.path
      .slice(prefix.length + 1)
      .replace(/\./g, "/");
    return `${fieldError.module}/${fieldError.key}/${remainder}`;
  }

  if (fieldError.path.startsWith(`${fieldError.module}.`)) {
    const remainder = fieldError.path
      .slice(fieldError.module.length + 1)
      .replace(/\./g, "/");
    return `${fieldError.module}/${remainder}`;
  }

  return fieldError.path.replace(/\./g, "/");
};

export const adminConfigFieldErrorsByPath = (
  fieldErrors: AdminConfigFieldErrorType[] | null | undefined,
): AdminConfigFieldErrorMap => {
  return (fieldErrors ?? []).reduce<AdminConfigFieldErrorMap>(
    (acc, fieldError) => {
      acc[adminConfigFieldErrorUiPath(fieldError)] = fieldError;
      return acc;
    },
    {},
  );
};

export const useAdminConfigContract = (): {
  schema: AdminConfigSchemaSnapshot | null | undefined;
  values: AdminConfigValuesSnapshot | null | undefined;
  mutateValues: ReturnType<
    typeof useQuery<typeof adminConfigValuesQuery>
  >["mutate"];
  schemaError: unknown;
  valuesError: unknown;
  isLoading: boolean;
  reloadServerState: () => Promise<{
    schema: AdminConfigSchemaSnapshot | null | undefined;
    values: AdminConfigValuesSnapshot | null | undefined;
  }>;
  updateConfig: (variables: {
    updates: UpdateAppConfigInput[];
  }) => Promise<AdminConfigUpdateResult>;
} => {
  const {
    data: schemaData,
    error: schemaError,
    isLoading: schemaLoading,
    mutate: mutateSchema,
  } = useQuery({
    query: adminConfigSchemaQuery,
  });
  const {
    data: valuesData,
    error: valuesError,
    isLoading: valuesLoading,
    mutate: mutateValues,
  } = useQuery({
    query: adminConfigValuesQuery,
  });
  const { trigger } = useMutation({ mutation: adminUpdateConfigMutation });

  const updateConfig = useCallback(
    async (variables: {
      updates: UpdateAppConfigInput[];
    }): Promise<AdminConfigUpdateResult> => {
      // trigger returns the full GQL envelope: { admin: { adminUpdateConfig: { applied, fieldErrors, config } } }
      // Unwrap to the flat result that consumers expect.
      const envelope = (await trigger(variables)) as {
        admin: { adminUpdateConfig: AdminConfigUpdateResult };
      };
      return envelope.admin.adminUpdateConfig;
    },
    [trigger],
  );

  const reloadServerState = useCallback(async () => {
    const [nextSchema, nextValues] = await Promise.all([
      mutateSchema(),
      mutateValues(),
    ]);
    return {
      schema: nextSchema?.admin.adminConfigSchema,
      values: nextValues?.admin.adminConfigValues,
    };
  }, [mutateSchema, mutateValues]);

  return {
    schema: schemaData?.admin.adminConfigSchema,
    values: valuesData?.admin.adminConfigValues,
    mutateValues,
    schemaError,
    valuesError,
    isLoading: Boolean(schemaLoading || valuesLoading),
    reloadServerState,
    updateConfig,
  };
};
