// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCurrentServerService } from "@myoxus/core/components/providers/current-server-scope";
import {
  type DateInput,
  formatRegionalCalendarDate,
  formatRegionalDate,
  formatRegionalDateTime,
  formatRegionalTime,
  normalizeDateFormatPreference,
  normalizeTimeFormatPreference,
  type RegionalFormatPreferences,
} from "@myoxus/core/modules/i18n";
import { DefaultServerService } from "@myoxus/core/modules/server/services/default-server";
import { UserPreferencesService } from "@myoxus/core/modules/server/services/user-preferences";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useMemo } from "react";

function useOptionalUserPreferencesService() {
  const defaultServerService = useService(DefaultServerService);
  const defaultServer = useLiveData(defaultServerService.server$);
  const currentServer = useCurrentServerService();
  return (currentServer ?? defaultServer)?.scope.get(UserPreferencesService);
}

export function useUserPreferencesService() {
  const service = useOptionalUserPreferencesService();
  if (!service) throw new Error("User preferences require a configured server");
  return service;
}

export function useUserPreferences() {
  const service = useOptionalUserPreferencesService();
  const preferences = useLiveData(service?.userPreferences$);
  const updatePreferences = useCallback(
    (
      patch: Parameters<UserPreferencesService["update"]>[0],
      options?: Parameters<UserPreferencesService["update"]>[1],
    ) => {
      if (!service) return Promise.reject(new Error("No configured server"));
      return service.update(patch, options);
    },
    [service],
  );

  return useMemo(
    () => ({
      preferences,
      effectivePreferences: preferences?.effectiveValues,
      updatePreferences,
    }),
    [preferences, updatePreferences],
  );
}

export function useRegionalPreferences(): RegionalFormatPreferences {
  const t = useI18n();
  const { effectivePreferences } = useUserPreferences();

  return useMemo(
    () => ({
      locale: effectivePreferences?.locale ?? t.language ?? "en",
      timezone: effectivePreferences?.timezone ?? "UTC",
      dateFormat: normalizeDateFormatPreference(
        effectivePreferences?.dateFormat,
      ),
      timeFormat: normalizeTimeFormatPreference(
        effectivePreferences?.timeFormat,
      ),
    }),
    [
      effectivePreferences?.dateFormat,
      effectivePreferences?.locale,
      effectivePreferences?.timeFormat,
      effectivePreferences?.timezone,
      t.language,
    ],
  );
}

export function useRegionalFormatters() {
  const preferences = useRegionalPreferences();

  return useMemo(
    () => ({
      formatCalendarDate: (value: string) =>
        formatRegionalCalendarDate(value, preferences),
      formatDate: (value: DateInput) => formatRegionalDate(value, preferences),
      formatDateTime: (value: DateInput) =>
        formatRegionalDateTime(value, preferences),
      formatTime: (value: DateInput) => formatRegionalTime(value, preferences),
      preferences,
    }),
    [preferences],
  );
}
