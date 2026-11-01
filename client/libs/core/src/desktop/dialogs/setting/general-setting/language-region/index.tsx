// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  type DateFormatPreference,
  formatRegionalDate,
  formatRegionalTime,
  I18nService,
  normalizeDateFormatPreference,
  normalizeTimeFormatPreference,
  type RegionalFormatPreferences,
  type TimeFormatPreference,
} from "@myoxus/core/modules/i18n";
import { GraphQLService } from "@myoxus/core/modules/server";
import {
  type DocumentMetadataValueDefinitionsQuery,
  documentMetadataValueDefinitionsQuery,
} from "@myoxus/graphql";
import { SUPPORTED_LANGUAGE_CODES, useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect, useMemo, useState } from "react";

import {
  FormSelect,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../primitives";

const INHERIT = "inherit";
const LOCALE = "locale";
const SERVER_TIMEZONE = "UTC";
const PREVIEW_DATE = new Date("2026-07-13T13:45:00Z");
const FALLBACK_DOCUMENT_LANGUAGE_KEYS = new Set(SUPPORTED_LANGUAGE_CODES);

function supportedTimezones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const values = intl.supportedValuesOf?.("timeZone") ?? [];
  return values.includes("UTC") ? values : ["UTC", ...values];
}

export function LanguageRegionSettings() {
  const t = useI18n();
  const i18n = useService(I18nService).i18n;
  const graphqlService = useService(GraphQLService);
  const currentLanguage = useLiveData(i18n.currentLanguage$);
  const languageList = useLiveData(i18n.languageList$);
  const { preferences, effectivePreferences, updatePreferences } =
    useUserPreferences();
  const [documentLanguageKeys, setDocumentLanguageKeys] = useState<Set<string>>(
    FALLBACK_DOCUMENT_LANGUAGE_KEYS,
  );

  useEffect(() => {
    let active = true;
    void graphqlService
      .gql({
        query: documentMetadataValueDefinitionsQuery,
        variables: { fieldKey: "language" },
      })
      .then((response) => {
        if (!active) return;
        const definitions = (
          response as DocumentMetadataValueDefinitionsQuery
        ).documentMetadataValueDefinitions.filter(
          (definition) => definition.isActive,
        );
        if (definitions.length > 0) {
          setDocumentLanguageKeys(
            new Set(definitions.map((definition) => definition.key)),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [graphqlService]);

  const effective: RegionalFormatPreferences = useMemo(
    () => ({
      locale: effectivePreferences?.locale ?? currentLanguage.key,
      timezone: effectivePreferences?.timezone ?? SERVER_TIMEZONE,
      dateFormat: normalizeDateFormatPreference(
        effectivePreferences?.dateFormat,
      ),
      timeFormat: normalizeTimeFormatPreference(
        effectivePreferences?.timeFormat,
      ),
    }),
    [
      currentLanguage.key,
      effectivePreferences?.dateFormat,
      effectivePreferences?.locale,
      effectivePreferences?.timeFormat,
      effectivePreferences?.timezone,
    ],
  );

  const languageOptions = useMemo(
    () =>
      languageList.map((language) => ({
        value: language.key,
        label: language.originalName,
      })),
    [languageList],
  );

  const documentLanguageOptions = useMemo(
    () => [
      {
        value: INHERIT,
        label: t["com.myoxus.settings.language-region.document.inherit"]({
          language: currentLanguage.originalName,
        }),
      },
      ...languageOptions.filter((language) =>
        documentLanguageKeys.has(language.value),
      ),
    ],
    [currentLanguage.originalName, documentLanguageKeys, languageOptions, t],
  );

  const timezoneOptions = useMemo(() => {
    const systemTimezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return [
      {
        value: INHERIT,
        label: t["com.myoxus.settings.language-region.timezone.inherit"]({
          timezone: SERVER_TIMEZONE,
        }),
      },
      ...supportedTimezones().map((timezone) => ({
        value: timezone,
        label:
          timezone === systemTimezone
            ? t["com.myoxus.settings.language-region.timezone.system"]({
                timezone,
              })
            : timezone,
      })),
    ];
  }, [t]);

  const dateFormatOptions = useMemo(
    () =>
      (
        [
          LOCALE,
          "day-month-year",
          "month-day-year",
          "year-month-day",
        ] as DateFormatPreference[]
      ).map((dateFormat) => ({
        value: dateFormat,
        label:
          dateFormat === LOCALE
            ? t["com.myoxus.settings.language-region.format.automatic"]({
                example: formatRegionalDate(PREVIEW_DATE, {
                  ...effective,
                  dateFormat,
                }),
              })
            : formatRegionalDate(PREVIEW_DATE, { ...effective, dateFormat }),
      })),
    [effective, t],
  );

  const timeFormatOptions = useMemo(
    () =>
      ([LOCALE, "12-hour", "24-hour"] as TimeFormatPreference[]).map(
        (timeFormat) => ({
          value: timeFormat,
          label:
            timeFormat === LOCALE
              ? t["com.myoxus.settings.language-region.format.automatic"]({
                  example: formatRegionalTime(PREVIEW_DATE, {
                    ...effective,
                    timeFormat,
                  }),
                })
              : formatRegionalTime(PREVIEW_DATE, {
                  ...effective,
                  timeFormat,
                }),
        }),
      ),
    [effective, t],
  );

  return (
    <SettingsPage
      title={t["com.myoxus.settings.language-region"]()}
      subtitle={t["com.myoxus.settings.language-region.subtitle"]()}
      testId="settings-page-language-region"
    >
      <SettingsSection
        title={t["com.myoxus.settings.language-region.languages"]()}
      >
        <SettingsRow
          name={t["com.myoxus.appearanceSettings.language.title"]()}
          desc={t["com.myoxus.appearanceSettings.language.description"]()}
        >
          <FormSelect
            data={languageOptions}
            searchable
            value={currentLanguage.key}
            onChange={(language) => {
              i18n.changeLanguage(language);
              void updatePreferences({ locale: language });
            }}
          />
        </SettingsRow>
        <SettingsRow
          name={t["com.myoxus.settings.language-region.document.title"]()}
          desc={t["com.myoxus.settings.language-region.document.description"]()}
        >
          <FormSelect
            data={documentLanguageOptions}
            searchable
            value={preferences?.values.defaultDocumentLanguage ?? INHERIT}
            onChange={(language) =>
              void updatePreferences({
                defaultDocumentLanguage: language === INHERIT ? null : language,
              })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={t["com.myoxus.settings.language-region.regional-format"]()}
      >
        <SettingsRow
          name={t["com.myoxus.common.timezone"]()}
          desc={t["com.myoxus.common.timezone.desc"]()}
        >
          <FormSelect
            data={timezoneOptions}
            searchable
            value={preferences?.values.timezone ?? INHERIT}
            onChange={(timezone) =>
              void updatePreferences({
                timezone: timezone === INHERIT ? null : timezone,
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          name={t["com.myoxus.settings.language-region.date-format.title"]()}
          desc={t[
            "com.myoxus.settings.language-region.date-format.description"
          ]()}
        >
          <FormSelect
            data={dateFormatOptions}
            value={preferences?.values.dateFormat ?? LOCALE}
            onChange={(dateFormat) =>
              void updatePreferences({
                dateFormat: dateFormat === LOCALE ? null : dateFormat,
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          name={t["com.myoxus.settings.language-region.time-format.title"]()}
          desc={t[
            "com.myoxus.settings.language-region.time-format.description"
          ]()}
        >
          <FormSelect
            data={timeFormatOptions}
            value={preferences?.values.timeFormat ?? LOCALE}
            onChange={(timeFormat) =>
              void updatePreferences({
                timeFormat: timeFormat === LOCALE ? null : timeFormat,
              })
            }
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
