// SPDX-License-Identifier: AGPL-3.0-or-later

import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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

/** Keep Mantine controls aligned with the nearest Page/Edgeless renderer. */
export function EditorEmbeddedUIRoot({
  children,
  portalRoot,
}: PropsWithChildren<{ portalRoot: HTMLElement }>) {
  const [colorScheme, setColorScheme] = useState<"dark" | "light" | undefined>(
    () => resolveEditorColorScheme(portalRoot),
  );
  const id = useId();
  const attribute = "data-myoxus-editor-react-root";
  const cssVariablesSelector = `[${attribute}="${id}"]`;
  useLayoutEffect(() => {
    portalRoot.setAttribute(attribute, id);
    return () => portalRoot.removeAttribute(attribute);
  }, [portalRoot, id]);
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
