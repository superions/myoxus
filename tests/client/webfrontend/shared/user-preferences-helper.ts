// SPDX-License-Identifier: AGPL-3.0-or-later

import type { APIRequestContext, Page } from "@playwright/test";

import { smokeGql } from "./workspace-helper";

export type AuthenticatedPreferenceTarget = {
  request: APIRequestContext;
  gqlEndpoint: string;
  cookies: string[];
};

export type UserColorMode = "dark" | "light" | "system";

export async function getAccountLocale({
  request,
  gqlEndpoint,
  cookies,
}: AuthenticatedPreferenceTarget): Promise<string | null> {
  const result = await smokeGql<{
    currentUser: { preferences: { values: { locale: string | null } } };
  }>(
    request,
    gqlEndpoint,
    cookies,
    `query WebEvidenceAccountLocale {
      currentUser { preferences { values { locale } } }
    }`,
  );
  return result.currentUser.preferences.values.locale;
}

export async function setAccountLocale(
  { request, gqlEndpoint, cookies }: AuthenticatedPreferenceTarget,
  locale: string | null,
): Promise<void> {
  await smokeGql(
    request,
    gqlEndpoint,
    cookies,
    `mutation WebEvidenceSetLocale($input: UpdateUserPreferencesInput!) {
      updatePreferences(input: $input) { effectiveValues { locale } }
    }`,
    { input: { locale } },
  );
}

export async function getAccountColorMode({
  request,
  gqlEndpoint,
  cookies,
}: AuthenticatedPreferenceTarget): Promise<UserColorMode | null> {
  const result = await smokeGql<{
    currentUser: {
      preferences: { values: { colorMode: UserColorMode | null } };
    };
  }>(
    request,
    gqlEndpoint,
    cookies,
    `query WebEvidenceAccountColorMode {
      currentUser { preferences { values { colorMode } } }
    }`,
  );
  return result.currentUser.preferences.values.colorMode;
}

export async function setAccountColorMode(
  { request, gqlEndpoint, cookies }: AuthenticatedPreferenceTarget,
  colorMode: UserColorMode | null,
): Promise<void> {
  await smokeGql(
    request,
    gqlEndpoint,
    cookies,
    `mutation WebEvidenceSetColorMode($input: UpdateUserPreferencesInput!) {
      updatePreferences(input: $input) { effectiveValues { colorMode } }
    }`,
    { input: { colorMode } },
  );
}

/**
 * Keep unauthenticated browser-language evidence and authenticated account
 * preference evidence on their real product paths. No removed localStorage
 * language authority is recreated in tests.
 */
export async function setBrowserLocale(
  page: Page,
  locale: string,
  authenticated?: AuthenticatedPreferenceTarget,
): Promise<void> {
  await page.addInitScript((language) => {
    Object.defineProperty(navigator, "language", {
      configurable: true,
      get: () => language,
    });
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => [language],
    });
  }, locale);

  if (!authenticated) return;
  await setAccountLocale(authenticated, locale);
}
