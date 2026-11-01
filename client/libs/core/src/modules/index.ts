// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import type { Framework } from "@myoxus/infra";

import { configureCommonShellModules } from "./shell";
import { configureCommonWorkspaceFeatureModules } from "./workspace-features";

export { configureCommonShellModules } from "./shell";
export { configureCommonWorkspaceFeatureModules } from "./workspace-features";

/**
 * Full client configuration retained for native clients. Browser Web uses the
 * shell and workspace-feature functions separately so route-only services do
 * not become part of its application entry chunk.
 */
export function configureCommonModules(framework: Framework) {
  configureCommonShellModules(framework);
  configureCommonWorkspaceFeatureModules(framework);
}
