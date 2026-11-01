// SPDX-License-Identifier: AGPL-3.0-or-later

export interface CaptchaRuntime {
  isSecureContext?: boolean;
}

/**
 * ALTCHA v3 aborts verification on non-secure browser contexts before the user
 * can tick the checkbox. Undefined means "non-browser/test runtime"; those
 * environments should keep the default widget path unless a test explicitly
 * simulates `isSecureContext === false`.
 */
export function canUseAltchaWidget(
  runtime: CaptchaRuntime = globalThis,
): boolean {
  return (
    typeof runtime.isSecureContext !== "boolean" || runtime.isSecureContext
  );
}
