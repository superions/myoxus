/**
 * Admin theme bridge.
 *
 * The shared Myoxus UI facade owns Admin's light/dark/system mode bridge.
 * Visible UI primitives are rendered through the same provider so Mantine
 * receives the runtime CSS token mapping instead of an Admin-local theme copy.
 *
 * The branding/preset CSS is delivered via `/api/branding/theme.css` and is
 * NOT propagated through Admin's device-local mode bridge — that part is a server
 * round-trip and is reloaded via `reloadRuntimeTheme()` after admin mutations.
 */
import {
  MyoxusThemeModeProvider,
  MyoxusUIProvider,
} from "@myoxus/ui-facade/provider";
import type { PropsWithChildren } from "react";

const themes = ["dark", "light"];

/**
 * Admin-only device bootstrap key. Browser Web resolves color mode from the
 * authenticated account preference and does not consume this key.
 */
export const ADMIN_THEME_STORAGE_KEY = "myoxus-theme";

/**
 * Supported themes: `"light"` and `"dark"`.  Defaults to `"system"` so the
 * initial theme matches the OS preference without a flash of incorrect colour.
 *
 * @param children - React subtree to wrap.
 */
export const ThemeProvider = ({ children }: PropsWithChildren) => {
  return (
    <MyoxusThemeModeProvider
      themes={themes}
      enableSystem={true}
      defaultTheme="system"
      storageKey={ADMIN_THEME_STORAGE_KEY}
    >
      <MyoxusUIProvider>{children}</MyoxusUIProvider>
    </MyoxusThemeModeProvider>
  );
};
