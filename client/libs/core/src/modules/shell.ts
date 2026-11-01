// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Framework } from "@myoxus/infra";

import { configureWorkspaceDBModule } from "./db";
import { configureDialogModule } from "./dialogs";
import { configureDocModule } from "./doc";
import { configureFeatureFlagModule } from "./feature-flag";
import { configureGlobalContextModule } from "./global-context";
import { configureI18nModule } from "./i18n";
import { configureImportTemplateModule } from "./import-template";
import { configureLifecycleModule } from "./lifecycle";
import { configureNavigationModule } from "./navigation";
import { configureNotificationModule } from "./notification";
import { configureOpenInApp } from "./open-in-app";
import { configureServerModule } from "./server";
import {
  configureCommonGlobalStorageImpls,
  configureStorageModule,
} from "./storage";
import { configureSystemFontFamilyModule } from "./system-font-family";
import { configureTelemetryModule } from "./telemetry";
import { configureAppThemeModule } from "./theme";
import { configureUrlModule } from "./url";
import { configureWorkspaceModule } from "./workspace";

/** Services required before Browser Web resolves a workspace route. */
export function configureCommonShellModules(framework: Framework) {
  configureI18nModule(framework);
  configureWorkspaceModule(framework);
  configureDocModule(framework);
  configureWorkspaceDBModule(framework);
  configureStorageModule(framework);
  configureGlobalContextModule(framework);
  configureLifecycleModule(framework);
  configureFeatureFlagModule(framework);
  configureNavigationModule(framework);
  configureServerModule(framework);
  configureNotificationModule(framework);
  configureTelemetryModule(framework);
  configureSystemFontFamilyModule(framework);
  configureImportTemplateModule(framework);
  configureUrlModule(framework);
  configureAppThemeModule(framework);
  configureDialogModule(framework);
  configureOpenInApp(framework);
  configureCommonGlobalStorageImpls(framework);
}
