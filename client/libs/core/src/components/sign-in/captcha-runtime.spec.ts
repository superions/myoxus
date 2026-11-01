// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { canUseAltchaWidget } from "./captcha-runtime";

describe("canUseAltchaWidget", () => {
  test("allows the official ALTCHA widget in secure or non-browser contexts", () => {
    expect(canUseAltchaWidget({ isSecureContext: true })).toBe(true);
    expect(canUseAltchaWidget({})).toBe(true);
  });

  test("disables the official widget on non-local HTTP secure-context failures", () => {
    expect(canUseAltchaWidget({ isSecureContext: false })).toBe(false);
  });
});
