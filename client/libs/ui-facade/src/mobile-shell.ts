// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CSS variable contract for native/mobile app shell integration.
 *
 * Mobile keyboard providers and editor extensions need to exchange dynamic
 * viewport heights without importing route-local CSS. Keep the names semantic
 * and facade-owned so platform apps can load `mobile-shell.css` explicitly.
 */
export const mobileShellCssVars = {
  appKeyboardHeight: "--myoxus-mobile-app-keyboard-height",
  appKeyboardStaticHeight: "--myoxus-mobile-app-keyboard-static-height",
  appTabHeight: "--myoxus-mobile-app-tab-height",
  appTabSafeArea: "--myoxus-mobile-app-tab-safe-area",
} as const;
