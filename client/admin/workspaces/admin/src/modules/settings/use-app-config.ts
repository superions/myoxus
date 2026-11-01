/**
 * Hook for reading and editing the server's structured Admin configuration.
 *
 * The hook keeps a local patched copy of the config that reflects unsaved
 * edits. Changes are tracked per config key in the `updates` map (keyed as
 * `"module.field"`). Saving can be done all-at-once (`save`) or per module
 * group (`saveGroup`).
 *
 * A `groupVersions` counter bumps whenever a group is saved or reset, allowing
 * child components to re-initialise their local state via a `key` prop.
 *
 * AF-PERF-B-03: All six independent state variables have been consolidated
 * into a single `useReducer`, so compound operations (save success, reset)
 * produce exactly one re-render instead of 2–4.
 */
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { notify } from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useReducer } from "react";

import type { AppConfig } from "./config";
import {
  type AdminConfigFieldError,
  adminConfigFieldErrorsByPath,
  adminConfigFieldErrorUiPath,
  type AdminConfigFieldState,
  type AdminConfigNormalizationIssue,
  adminConfigSnapshotToAppConfig,
  type AdminConfigUpdateResult,
  formatAdminConfigFieldErrors,
  normalizeAdminConfigSnapshot,
  pickAppConfigModules,
  type UpdateAppConfigInput,
  useAdminConfigContract,
} from "./use-admin-config-contract";
import { getByPath, isEqual, setByPath } from "./utils";

export { type UpdateAppConfigInput };

export type AppConfigUpdates = Record<string, { from: any; to: any }>;
export type AppConfigFieldErrorsByPath = Record<string, AdminConfigFieldError>;

// ---------------------------------------------------------------------------
// Reducer state + actions
// ---------------------------------------------------------------------------

type AppConfigState = {
  serverAppConfig: AppConfig;
  patchedAppConfig: AppConfig;
  updates: AppConfigUpdates;
  fieldErrors: AdminConfigFieldError[];
  savingModules: Record<string, boolean>;
  groupVersions: Record<string, number>;
};

type AppConfigAction =
  /** Server values refreshed while there are no pending local edits. */
  | { type: "sync"; config: AppConfig }
  /** Explicit recovery replaces stale server/local state and discards edits. */
  | { type: "replace"; config: AppConfig }
  /** User edited one field. `key` is "module.field".
   *
   * The effective `to` is computed inside the reducer from the latest
   * `state.updates[key]?.to ?? from`, so that a burst of synchronous
   * `update()` calls (e.g. applyPreset firing 40 sub-field writes in one
   * tick) correctly accumulate. Computing `to` in the caller captures a
   * stale closure, causing every call to clobber the previous one's
   * sub-field change and leaving only the last write in the `updates` map.
   */
  | {
      type: "update";
      key: string;
      from: any;
      path: string;
      module: string;
      field: string;
      subField?: string;
      value: any;
    }
  /** Clear field errors for specific UI paths (e.g. "module/field"). */
  | { type: "clearErrors"; paths: string[] }
  /** Clear all field errors belonging to given module names. */
  | { type: "clearErrorsByModule"; modules: string[] }
  /** Merge saved config back into both server + patched configs and clear related state. */
  | {
      type: "applySaved";
      savedModules: Partial<AppConfig>;
      affectedModules: string[];
      fieldErrors: AdminConfigFieldError[];
      bumpVersion?: string;
    }
  /** Mark a module as saving or done. */
  | { type: "setSaving"; module: string; saving: boolean }
  /** Revert a module to server state and bump its version. */
  | { type: "resetGroup"; module: string }
  /** Replace the full field error list (used when server returns errors). */
  | { type: "setFieldErrors"; fieldErrors: AdminConfigFieldError[] };

function reducer(
  state: AppConfigState,
  action: AppConfigAction,
): AppConfigState {
  switch (action.type) {
    case "replace": {
      return {
        ...state,
        serverAppConfig: action.config,
        patchedAppConfig: structuredClone(action.config),
        updates: {},
        fieldErrors: [],
        groupVersions: Object.fromEntries(
          Object.keys(state.groupVersions).map((module) => [
            module,
            (state.groupVersions[module] ?? 0) + 1,
          ]),
        ),
      };
    }

    case "sync": {
      // Only sync when there are no pending edits (caller is responsible for guard).
      if (
        isEqual(state.serverAppConfig, action.config) &&
        isEqual(state.patchedAppConfig, action.config)
      ) {
        return state;
      }
      return {
        ...state,
        serverAppConfig: action.config,
        patchedAppConfig: structuredClone(action.config),
      };
    }

    case "update": {
      const { key, from, path, module, field, subField, value } = action;

      // Compute `to` from *current* reducer state so that synchronous bursts
      // of update() calls accumulate instead of clobbering each other. The
      // caller's closure can be stale between dispatches in the same tick.
      const base = state.updates[key]?.to ?? from ?? {};
      const to = subField
        ? setByPath(structuredClone(base), subField, value)
        : value;

      // Clear field error for this path
      const nextFieldErrors = state.fieldErrors.filter(
        (fe) => adminConfigFieldErrorUiPath(fe) !== path,
      );

      // Update pending-changes map
      let nextUpdates: AppConfigUpdates;
      if (isEqual(from, to)) {
        // Change reverted to original — remove from updates
        const copy = { ...state.updates };
        delete copy[key];
        nextUpdates = copy;
      } else {
        nextUpdates = { ...state.updates, [key]: { from, to } };
      }

      // Update patched config.
      //
      // Field names CAN contain dots (e.g. branding.theme.light is modelled
      // as module="branding", field="theme.light" on the server), and the
      // snapshot → AppConfig conversion nests those as {theme: {light: …}}.
      // We write through the full nested path `module.field.subField`,
      // mirroring adminConfigSnapshotToAppConfig. Writing
      // patched[module][field] with a literal dotted key would leave the
      // preview reading stale server data via getByPath(dot-traversal).
      const fullPath = subField
        ? `${module}.${field}.${subField}`
        : `${module}.${field}`;
      const clonedModule =
        structuredClone(state.patchedAppConfig[module]) ?? {};
      const nextModule = setByPath(
        { [module]: clonedModule } as Record<string, any>,
        fullPath,
        value,
      )[module];
      const nextPatched: AppConfig = {
        ...state.patchedAppConfig,
        [module]: nextModule,
      };

      return {
        ...state,
        updates: nextUpdates,
        patchedAppConfig: nextPatched,
        fieldErrors: nextFieldErrors,
      };
    }

    case "clearErrors": {
      if (action.paths.length === 0) return state;
      const next = state.fieldErrors.filter(
        (fe) => !action.paths.includes(adminConfigFieldErrorUiPath(fe)),
      );
      if (next.length === state.fieldErrors.length) return state;
      return { ...state, fieldErrors: next };
    }

    case "clearErrorsByModule": {
      if (action.modules.length === 0) return state;
      const next = state.fieldErrors.filter(
        (fe) => !action.modules.includes(fe.module),
      );
      if (next.length === state.fieldErrors.length) return state;
      return { ...state, fieldErrors: next };
    }

    case "applySaved": {
      const {
        savedModules,
        affectedModules,
        fieldErrors: errs,
        bumpVersion,
      } = action;
      // Clear updates for affected modules
      const nextUpdates = { ...state.updates };
      for (const key of Object.keys(nextUpdates)) {
        if (affectedModules.some((m) => key.startsWith(`${m}.`))) {
          delete nextUpdates[key];
        }
      }
      // Clear field errors for affected modules
      const nextFieldErrors =
        errs.length > 0
          ? errs
          : state.fieldErrors.filter(
              (fe) => !affectedModules.includes(fe.module),
            );

      // Shallow spread is correct here: savedModules contains whole module objects
      const nextServer = {
        ...state.serverAppConfig,
        ...savedModules,
      } as AppConfig;
      const nextPatched = {
        ...state.patchedAppConfig,
        ...savedModules,
      } as AppConfig;

      // Optionally bump the group version for the saved module
      const nextVersions = bumpVersion
        ? {
            ...state.groupVersions,
            [bumpVersion]: (state.groupVersions[bumpVersion] ?? 0) + 1,
          }
        : state.groupVersions;

      return {
        ...state,
        serverAppConfig: nextServer,
        patchedAppConfig: nextPatched,
        updates: nextUpdates,
        fieldErrors: nextFieldErrors,
        groupVersions: nextVersions,
      };
    }

    case "setSaving": {
      return {
        ...state,
        savingModules: {
          ...state.savingModules,
          [action.module]: action.saving,
        },
      };
    }

    case "resetGroup": {
      const { module } = action;
      // Clear updates for this module
      const nextUpdates = { ...state.updates };
      for (const key of Object.keys(nextUpdates)) {
        if (key.startsWith(`${module}.`)) delete nextUpdates[key];
      }
      // Clear field errors for this module
      const nextFieldErrors = state.fieldErrors.filter(
        (fe) => fe.module !== module,
      );
      // Restore patched config for this module
      const nextPatched = {
        ...state.patchedAppConfig,
        [module]: structuredClone(state.serverAppConfig[module] ?? {}),
      };
      // Bump group version
      const nextVersions = {
        ...state.groupVersions,
        [module]: (state.groupVersions[module] ?? 0) + 1,
      };
      return {
        ...state,
        updates: nextUpdates,
        fieldErrors: nextFieldErrors,
        patchedAppConfig: nextPatched,
        groupVersions: nextVersions,
      };
    }

    case "setFieldErrors": {
      return { ...state, fieldErrors: action.fieldErrors };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers (unchanged from original)
// ---------------------------------------------------------------------------

const getUpdateInputs = (
  entries: Array<[string, { from: any; to: any }]>,
): UpdateAppConfigInput[] => {
  return entries.map(([key, value]) => {
    const splitIndex = key.indexOf(".");
    const module = key.slice(0, splitIndex);
    const field = key.slice(splitIndex + 1);

    return {
      module,
      key: field,
      value: value.to,
    };
  });
};

const getModulesFromEntries = (
  entries: Array<[string, { from: any; to: any }]>,
) =>
  Array.from(
    new Set(
      entries.map(([key]) => {
        const splitIndex = key.indexOf(".");
        return key.slice(0, splitIndex);
      }),
    ),
  );

const filterFileOnlyFields = (
  entries: Array<[string, { from: any; to: any }]>,
  schema: any,
): Array<[string, { from: any; to: any }]> => {
  if (!schema?.modules) return entries;

  const fileOnlyFields = new Set<string>();
  for (const module of schema.modules) {
    for (const group of module.groups ?? []) {
      for (const field of group.fields ?? []) {
        if (field.databaseWritable === false) {
          fileOnlyFields.add(field.path);
        }
      }
    }
  }

  return entries.filter(([key]) => !fileOnlyFields.has(key));
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the current (and locally-patched) app configuration together with
 * mutation helpers for editing and saving individual config groups.
 *
 * Key returned values:
 * - `appConfig` — the server-authoritative structured snapshot (read-only).
 * - `patchedAppConfig` — the locally edited copy; use this for rendering inputs.
 * - `update(path, value)` — records a change; `path` format: `"module/field"` or `"module/field/subField"`.
 * - `save()` — saves all pending changes.
 * - `saveGroup(module, protectedValues?)` — atomically saves one group's changes
 *   and submit-only protected inputs without retaining their values in state.
 * - `removeOverrides(paths)` — atomically releases persisted DB overrides so
 *   the server can resolve the lower-precedence YAML/ENV/default baseline.
 * - `resetGroup(module)` — discards changes for one module group.
 * - `isGroupDirty(module)` — `true` when the group has unsaved edits.
 * - `isGroupSaving(module)` — `true` while the save request is in-flight.
 * - `getGroupVersion(module)` — monotonically incrementing version; use as React `key` to force remount.
 */
export const useAppConfig = (): {
  appConfig: AppConfig;
  patchedAppConfig: AppConfig;
  schema: ReturnType<typeof useAdminConfigContract>["schema"];
  update: (path: string, value: any) => void;
  save: () => Promise<void>;
  saveGroup: (
    module: string,
    protectedValues?: Readonly<Record<string, string | null>>,
  ) => Promise<void>;
  saveField: (fieldPath: string, value: any) => Promise<void>;
  removeOverrides: (fieldPaths: string[]) => Promise<void>;
  resetGroup: (module: string) => void;
  isGroupDirty: (module: string) => boolean;
  isGroupSaving: (module: string) => boolean;
  getGroupVersion: (module: string) => number;
  fieldErrors: AdminConfigFieldError[];
  fieldErrorsByPath: AppConfigFieldErrorsByPath;
  updates: AppConfigUpdates;
  normalizationIssues: AdminConfigNormalizationIssue[];
  configFieldStates: Record<string, AdminConfigFieldState>;
  schemaError: unknown;
  valuesError: unknown;
  isLoading: boolean;
  schemaRevision: string;
  configRevision: string;
  reloadServerState: () => Promise<void>;
  discardLocalChanges: () => void;
} => {
  const i18n = useI18n();
  const {
    values,
    schema,
    mutateValues,
    updateConfig,
    schemaError,
    valuesError,
    isLoading,
    reloadServerState: reloadContractState,
  } = useAdminConfigContract();

  const normalizedSnapshot = useMemo(
    () => normalizeAdminConfigSnapshot(schema, values),
    [schema, values],
  );
  const initialAppConfig = normalizedSnapshot.config;
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    serverAppConfig: initialAppConfig,
    patchedAppConfig: structuredClone(initialAppConfig),
    updates: {},
    fieldErrors: [],
    savingModules: {},
    groupVersions: {},
  }));

  const {
    serverAppConfig,
    patchedAppConfig,
    updates,
    fieldErrors,
    savingModules,
    groupVersions,
  } = state;

  const fieldErrorsByPath = useMemo(
    () => adminConfigFieldErrorsByPath(fieldErrors),
    [fieldErrors],
  );

  useEffect(() => {
    if (Object.keys(updates).length === 0) {
      dispatch({ type: "sync", config: normalizedSnapshot.config });
    }
  }, [normalizedSnapshot.config, updates]);

  const getEntriesByModule = useCallback(
    (module: string, source: AppConfigUpdates = updates) => {
      return Object.entries(source).filter(([key]) =>
        key.startsWith(`${module}.`),
      );
    },
    [updates],
  );

  const applySavedConfig = useCallback(
    async (
      response: AdminConfigUpdateResult,
      affectedModules: string[],
      bumpVersion?: string,
    ) => {
      if (!response.applied || response.fieldErrors.length > 0) {
        dispatch({ type: "setFieldErrors", fieldErrors: response.fieldErrors });
        throw new Error(formatAdminConfigFieldErrors(response.fieldErrors));
      }

      const savedAppConfig = adminConfigSnapshotToAppConfig(
        response.config,
        schema,
      );
      const savedModules = pickAppConfigModules(
        savedAppConfig,
        affectedModules,
      );

      dispatch({
        type: "applySaved",
        savedModules,
        affectedModules,
        fieldErrors: [],
        bumpVersion,
      });

      await mutateValues(() => ({
        admin: {
          adminConfigValues: response.config,
        },
      }));
    },
    [mutateValues, schema],
  );

  const notifySavedConfig = useCallback(
    (response: AdminConfigUpdateResult) => {
      if (response.writeback === "failed") {
        // The authoritative DB commit succeeded. Keep the feedback truthful:
        // this is a recoverable mirror warning, not a failed save. Repeating
        // the same save is meaningful because the server retains write intent
        // independently from its durable-change/audit list.
        notify.warning({
          title: i18n.t("admin.config.saved-mirror-warning"),
          message: i18n.t("admin.config.saved-mirror-warning-description"),
        });
        return;
      }
      notify.success({
        title: i18n.t("admin.config.saved"),
        message: i18n.t("admin.config.saved-description"),
      });
    },
    [i18n],
  );

  const reloadServerState = useCallback(async () => {
    const refreshed = await reloadContractState();
    const normalized = normalizeAdminConfigSnapshot(
      refreshed.schema,
      refreshed.values,
    );
    dispatch({ type: "replace", config: normalized.config });
  }, [reloadContractState]);

  const discardLocalChanges = useCallback(() => {
    dispatch({ type: "replace", config: normalizedSnapshot.config });
  }, [normalizedSnapshot.config]);

  const save = useCallback(async () => {
    let allEntries = Object.entries(updates);
    if (allEntries.length === 0) {
      return;
    }

    // File-only fields are visible for provenance but cannot be persisted to DB.
    allEntries = filterFileOnlyFields(allEntries, schema);
    if (allEntries.length === 0) {
      return;
    }

    try {
      const response = (await updateConfig({
        updates: getUpdateInputs(allEntries),
      })) as AdminConfigUpdateResult;
      await applySavedConfig(response, getModulesFromEntries(allEntries));

      notifySavedConfig(response);
    } catch (e) {
      const error = UserFriendlyError.fromAny(e);
      notify.error({
        title: i18n.t("admin.common.save-failed"),
        message: error.message,
      });
      console.error(error.message);
    }
  }, [
    applySavedConfig,
    i18n,
    notifySavedConfig,
    schema,
    updateConfig,
    updates,
  ]);

  const saveGroup = useCallback(
    async (
      module: string,
      protectedValues: Readonly<Record<string, string | null>> = {},
    ) => {
      // Read protected inputs only at submit. Their values never enter the
      // reducer, patched config or pending-edit map, and save with the group.
      let moduleEntries = [
        ...new Map([
          ...getEntriesByModule(module),
          ...Object.entries(protectedValues).map(
            ([key, to]) =>
              [`${module}.${key}`, { from: undefined, to }] as const,
          ),
        ]).entries(),
      ];
      if (moduleEntries.length === 0) {
        return;
      }

      // File-only fields are visible for provenance but cannot be persisted to DB.
      moduleEntries = filterFileOnlyFields(moduleEntries, schema);
      if (moduleEntries.length === 0) {
        return;
      }

      dispatch({ type: "setSaving", module, saving: true });

      try {
        const response = (await updateConfig({
          updates: getUpdateInputs(moduleEntries),
        })) as AdminConfigUpdateResult;
        // A returned validation rejection is normal form feedback. Preserve
        // drafts and protected inputs without treating it as a transport error.
        if (!response.applied || response.fieldErrors.length > 0) {
          dispatch({
            type: "setFieldErrors",
            fieldErrors: response.fieldErrors,
          });
          notify.error({
            title: i18n.t("admin.common.save-failed"),
            message: formatAdminConfigFieldErrors(response.fieldErrors),
          });
          return;
        }
        await applySavedConfig(response, [module], module);

        // When branding settings change, force the runtime CSS to re-evaluate
        // so the admin sees updated theme colors immediately. Also notify
        // other tabs/windows (including the web frontend) via BroadcastChannel.
        if (module === "branding") {
          const { reloadRuntimeTheme } = await import("../../runtime-theme");
          reloadRuntimeTheme();
          try {
            const bc = new BroadcastChannel("myoxus-branding");
            bc.postMessage("branding-updated");
            bc.close();
          } catch {
            /* BroadcastChannel unavailable */
          }
        }

        notifySavedConfig(response);
      } catch (e) {
        const error = UserFriendlyError.fromAny(e);
        notify.error({
          title: i18n.t("admin.common.save-failed"),
          message: error.message,
        });
        // Transport errors can carry metadata; retain only the operator message.
        console.error(error.message);
      } finally {
        dispatch({ type: "setSaving", module, saving: false });
      }
    },
    [
      applySavedConfig,
      getEntriesByModule,
      i18n,
      notifySavedConfig,
      updateConfig,
      schema,
    ],
  );

  const saveField = useCallback(
    async (fieldPath: string, value: any) => {
      const [module, ...keyParts] = fieldPath.split("/");
      const key = keyParts.join("/");

      try {
        const response = (await updateConfig({
          updates: [{ module, key, value }],
        })) as AdminConfigUpdateResult;
        await applySavedConfig(response, [module]);
      } catch (e) {
        const error = UserFriendlyError.fromAny(e);
        console.error("Failed to save field:", error.message);
        throw error;
      }
    },
    [applySavedConfig, updateConfig],
  );

  const removeOverrides = useCallback(
    async (fieldPaths: string[]) => {
      const updates = fieldPaths.map((fieldPath) => {
        const [module, ...keyParts] = fieldPath.split("/");
        return { module, key: keyParts.join("/"), value: null };
      });
      if (updates.length === 0) return;

      const modules = [...new Set(updates.map(({ module }) => module))];
      const response = (await updateConfig({
        updates,
      })) as AdminConfigUpdateResult;
      await applySavedConfig(response, modules);
      notifySavedConfig(response);
    },
    [applySavedConfig, notifySavedConfig, updateConfig],
  );

  const update = useCallback(
    (path: string, value: any) => {
      const [module, field, subField] = path.split("/");
      const key = `${module}.${field}`;
      const from = getByPath(serverAppConfig, key);

      // NB: `to` is NOT computed here. The reducer derives it from the
      // latest `state.updates[key]?.to` so that multiple synchronous
      // update() calls (applyPreset, batched seed writes) accumulate
      // correctly instead of clobbering each other via a stale closure.
      dispatch({
        type: "update",
        key,
        from,
        path,
        module,
        field,
        subField,
        value,
      });
    },
    [serverAppConfig],
  );

  const resetGroup = useCallback((module: string) => {
    dispatch({ type: "resetGroup", module });
  }, []);

  const isGroupDirty = useCallback(
    (module: string) => getEntriesByModule(module).length > 0,
    [getEntriesByModule],
  );

  const isGroupSaving = useCallback(
    (module: string) => Boolean(savingModules[module]),
    [savingModules],
  );

  const getGroupVersion = useCallback(
    (module: string) => groupVersions[module] ?? 0,
    [groupVersions],
  );

  return {
    appConfig: serverAppConfig as AppConfig,
    patchedAppConfig,
    schema,
    update,
    save,
    saveGroup,
    saveField,
    removeOverrides,
    resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrors,
    fieldErrorsByPath,
    updates,
    normalizationIssues: normalizedSnapshot.issues,
    configFieldStates: normalizedSnapshot.fieldStates,
    schemaError,
    valuesError,
    isLoading,
    schemaRevision: normalizedSnapshot.schemaRevision,
    configRevision: normalizedSnapshot.configRevision,
    reloadServerState,
    discardLocalChanges,
  };
};
