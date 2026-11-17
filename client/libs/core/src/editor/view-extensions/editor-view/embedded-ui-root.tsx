// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LitPortalDecorator } from "@myoxus/lit-react";
import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState,
} from "react";

function findEditorThemeScope(element: Element): Element | null {
  let current: Element | null = element;
  while (current) {
    const themeScope = current.closest(
      "[data-theme='light'], [data-theme='dark']",
    );
    if (themeScope) return themeScope;

    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function resolveEditorColorScheme(
  portalRoot: HTMLElement,
): "dark" | "light" | undefined {
  const theme = findEditorThemeScope(portalRoot)?.getAttribute("data-theme");
  return theme === "dark" || theme === "light" ? theme : undefined;
}

function ensureEditorPortalSelector(portalRoot: HTMLElement) {
  const attribute = "data-myoxus-editor-react-root";
  let id = portalRoot.getAttribute(attribute);
  if (!id) {
    id = portalRoot.getAttribute("portalid");
    if (!id) throw new Error("Editor React portal is missing its anchor id");
    portalRoot.setAttribute(attribute, id);
  }
  return `[${attribute}="${id}"]`;
}

/** Keep Mantine controls aligned with the nearest Page/Edgeless renderer. */
export function EditorEmbeddedUIRoot({
  children,
  portalRoot,
}: PropsWithChildren<{ portalRoot: HTMLElement }>) {
  const [colorScheme, setColorScheme] = useState<"dark" | "light" | undefined>(
    () => resolveEditorColorScheme(portalRoot),
  );
  const [cssVariablesSelector] = useState(() =>
    ensureEditorPortalSelector(portalRoot),
  );
  const getRootElement = useCallback(() => portalRoot, [portalRoot]);

  useEffect(() => {
    const themeScope = findEditorThemeScope(portalRoot);
    if (!themeScope) return undefined;
    const update = () => setColorScheme(resolveEditorColorScheme(portalRoot));
    update();
    const observer = new MutationObserver(update);
    observer.observe(themeScope, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, [portalRoot]);

  return (
    <MyoxusEmbeddedUIProvider
      colorScheme={colorScheme}
      cssVariablesSelector={cssVariablesSelector}
      getRootElement={getRootElement}
    >
      {children}
    </MyoxusEmbeddedUIProvider>
  );
}

/** Reuse the renderer-local theme for native chrome mounted by the existing Lit bridge. */
export const decorateEditorEmbeddedUI: LitPortalDecorator = (
  element,
  portalRoot,
) => (
  <EditorEmbeddedUIRoot portalRoot={portalRoot}>{element}</EditorEmbeddedUIRoot>
);
