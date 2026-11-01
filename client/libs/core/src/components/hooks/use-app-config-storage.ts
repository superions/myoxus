import {
  type AppConfigSchema,
  AppConfigStorage,
  defaultAppConfig,
} from "@myoxus/infra";
import { type Dispatch, useEffect, useMemo, useState } from "react";

const storage = BUILD_CONFIG.isElectron
  ? new AppConfigStorage({ config: defaultAppConfig })
  : new AppConfigStorage({
      config: defaultAppConfig,
      get: () => JSON.parse(localStorage.getItem("app_config") ?? "null"),
      set: (config) =>
        localStorage.setItem("app_config", JSON.stringify(config)),
    });

export const appConfigStorage = storage;

export function useAppConfigStorage(): [
  AppConfigSchema,
  Dispatch<AppConfigSchema>,
];
export function useAppConfigStorage(
  key: keyof AppConfigSchema,
): [AppConfigSchema[typeof key], Dispatch<AppConfigSchema[typeof key]>];

/**
 * Get reactive app config
 * @param key
 * @returns
 */
export function useAppConfigStorage(key?: keyof AppConfigSchema) {
  const [_config, _setConfig] = useState(storage.get());

  useEffect(() => {
    storage.set(_config);
  }, [_config]);

  const value = useMemo(() => (key ? _config[key] : _config), [_config, key]);

  const setValue = useMemo(() => {
    if (key) {
      return (value: AppConfigSchema[typeof key]) => {
        _setConfig((cfg) => ({ ...cfg, [key]: value }));
      };
    } else {
      return (config: AppConfigSchema) => {
        _setConfig(config);
      };
    }
  }, [_setConfig, key]);

  return [value, setValue];
}
