/**
 * Shared hooks and utilities used across multiple admin modules.
 *
 * Provides access to server configuration, the current user, admin
 * capability detection, and route-level feature helpers.
 */
import {
  adminConfigValuesQuery,
  type AdminServerConfigQuery,
  adminServerConfigQuery,
  FeatureType,
  type GetCurrentUserFeaturesQuery,
  getCurrentUserFeaturesQuery,
} from "@myoxus/graphql";
import { useCallback } from "react";

import { useMutateQueryResource } from "../use-mutation";
import { useQuery } from "../use-query";

// Server config changes rarely, so this shared resource avoids redundant
// focus/reconnect requests while retaining explicit mutation revalidation.
const SERVER_CONFIG_SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  dedupingInterval: 60_000,
} as const;

/**
 * Exact SWR resource for the public server configuration.
 *
 * Bootstrap callers must use this resource's local `revalidate` function: it
 * targets the mounted key including its serialized variables and returns the
 * fresh response that released the setup guard.
 */
export const useServerConfigResource = () => {
  const { data, mutate } = useQuery(
    { query: adminServerConfigQuery },
    SERVER_CONFIG_SWR_OPTIONS,
  );
  const revalidate = useCallback(async () => {
    const refreshed = await mutate();
    return refreshed?.admin.serverInfo;
  }, [mutate]);

  return {
    serverConfig: data?.admin.serverInfo,
    revalidate,
  };
};

/** Returns the server configuration object from the GraphQL API. */
export const useServerConfig = ():
  AdminServerConfigQuery["admin"]["serverInfo"] | undefined =>
  useServerConfigResource().serverConfig;

/** Feature flags derived from the server's structured configuration response. */
export interface AdminCapabilities {
  /** Whether the job queue dashboard UI should be shown. */
  hasQueueDashboard: boolean;
  /** Whether job-related settings should appear in the settings page. */
  hasJobSettings: boolean;
}

/**
 * Derives `AdminCapabilities` from the set of module names present in the
 * structured config snapshot.
 *
 * Pure function — safe to call outside React component tree (e.g. in tests).
 *
 * @param moduleNames - array of module name strings from `adminConfigValues.modules[].module`
 */
export function getAdminCapabilities(
  moduleNames?: string[] | null,
): AdminCapabilities {
  const names = new Set(moduleNames ?? []);

  return {
    hasQueueDashboard: names.has("job"),
    hasJobSettings: names.has("job"),
  };
}

/** Hook that returns the current admin capability flags for the connected server. */
export const useAdminCapabilities = () => {
  const { data } = useQuery(
    { query: adminConfigValuesQuery },
    SERVER_CONFIG_SWR_OPTIONS,
  );

  const moduleNames = data?.admin?.adminConfigValues?.modules?.map(
    (m: { module: string }) => m.module,
  );

  return getAdminCapabilities(moduleNames);
};

/**
 * Composite hook that exposes both server config and admin capabilities from
 * one call-site.
 *
 * Both underlying queries use the same SWR dedup options, so no additional
 * network requests are made compared to calling each hook separately.
 */
export const useAdminContext = () => {
  const serverConfig = useServerConfig();
  const capabilities = useAdminCapabilities();
  return { serverConfig, capabilities };
};

/** Returns a callback that triggers a revalidation of the cached server config. */
export const useRevalidateServerConfig = () => {
  return useServerConfigResource().revalidate;
};

/** Returns a callback that triggers a revalidation of the cached current-user query. */
export const useRevalidateCurrentUser = () => {
  const revalidate = useMutateQueryResource();

  return () => {
    return revalidate(getCurrentUserFeaturesQuery);
  };
};
/** Returns the currently authenticated user, or `null` if not logged in. */
export const useCurrentUser = ():
  GetCurrentUserFeaturesQuery["currentUser"] | undefined => {
  const { data } = useQuery({
    query: getCurrentUserFeaturesQuery,
  });
  return data?.currentUser;
};

/**
 * Returns `true` when the given user has the `Admin` feature flag.
 * Used by route guards to determine whether to allow access to admin pages.
 */
export function isAdmin(
  user: NonNullable<GetCurrentUserFeaturesQuery["currentUser"]>,
) {
  return user.features.includes(FeatureType.Admin);
}
