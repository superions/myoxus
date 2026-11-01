/**
 * Playwright global setup — runs once before any tests.
 *
 * The admin redesign removed the legacy Teams module. Global setup guarantees
 * that an admin user exists and writes a reusable authenticated storage-state
 * under ignored `playwright/.cache/` so spec files do not exhaust CAPTCHA
 * limits.
 */

import { request as playwrightRequest } from "@playwright/test";

import { getCachedAdminStorageState } from "./fixtures/auth";

export default async function globalSetup(): Promise<void> {
  await getCachedAdminStorageState(playwrightRequest);
}
