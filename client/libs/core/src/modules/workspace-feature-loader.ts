// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

type WorkspaceFeatureLoader = () => Promise<void>;

let loader: WorkspaceFeatureLoader | undefined;
let loading: Promise<void> | undefined;
let resolveRegistration: (() => void) | undefined;
const registration = new Promise<void>((resolve) => {
  resolveRegistration = resolve;
});

/** Registers the platform-specific workspace feature boundary. */
export function registerWorkspaceFeatureLoader(next: WorkspaceFeatureLoader) {
  loader = next;
  loading = undefined;
  resolveRegistration?.();
  resolveRegistration = undefined;
}

/**
 * Resolves workspace feature registration once. Native clients configure the
 * full framework eagerly and therefore intentionally leave this unregistered.
 */
export async function loadWorkspaceFeatures() {
  // React Router resolves a direct workspace deep link while app.tsx is still
  // evaluating. Browser Web must wait for its platform loader to be registered;
  // native clients configure the full framework synchronously and skip this.
  if (!loader && BUILD_CONFIG.isWeb) {
    await registration;
  }

  if (!loader) {
    return;
  }

  loading ??= loader().catch((error) => {
    loading = undefined;
    throw error;
  });
  await loading;
}
