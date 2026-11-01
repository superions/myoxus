/**
 * Reads `adminI18n.defaultLocale` from the server config and applies it to the
 * shared i18next instance on mount and whenever the stored value changes.
 *
 * Placed inside AuthenticatedRoutes so the admin-specific config read only runs
 * for logged-in admins.
 * Uses { suspense: false } to avoid suspending outside a Suspense boundary.
 */
import { adminConfigValuesQuery } from "@myoxus/graphql";
import { getOrCreateI18n, SUPPORTED_LANGUAGES } from "@myoxus/i18n";
import { useEffect, useMemo } from "react";
import { useLocation } from "react-router";

import { useQuery } from "../../use-query";
import { useServerConfig } from "../common";
import { adminConfigSnapshotToAppConfig } from "../settings/use-admin-config-contract";

const PUBLIC_BOOTSTRAP_PATHS = new Set([
  "/adminfrontend/auth",
  "/adminfrontend/config-wizard",
  "/adminfrontend/setup",
]);

function applySupportedLanguage(locale: unknown) {
  if (typeof locale !== "string" || !(locale in SUPPORTED_LANGUAGES)) {
    return;
  }
  getOrCreateI18n()
    .changeLanguage(locale)
    .catch(() => {
      /* language not loaded — i18next falls back gracefully */
    });
}

/**
 * Public setup/config/auth pages cannot read `adminConfigValues`, but they can
 * use the non-sensitive `serverInfo.i18n.defaultLocale` projection that is
 * already required for the bootstrap redirect decision.
 */
export function AdminBootstrapLocaleSync() {
  const location = useLocation();
  const serverConfig = useServerConfig();
  const shouldSync = PUBLIC_BOOTSTRAP_PATHS.has(location.pathname);
  const locale = serverConfig?.i18n?.defaultLocale;

  useEffect(() => {
    if (!shouldSync) return;
    applySupportedLanguage(locale);
  }, [locale, shouldSync]);

  return null;
}

export function AdminLocaleSync() {
  const { data } = useQuery(
    { query: adminConfigValuesQuery },
    { suspense: false },
  );

  const appConfig = useMemo(
    () => adminConfigSnapshotToAppConfig(data?.admin?.adminConfigValues),
    [data],
  );

  const locale = (appConfig?.admin_i18n as Record<string, unknown> | undefined)
    ?.default_locale;

  useEffect(() => {
    applySupportedLanguage(locale);
  }, [locale]);

  return null;
}
