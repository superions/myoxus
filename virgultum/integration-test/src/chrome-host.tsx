// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { patchEditorChromeHost } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome";
import { setupGlobal } from "@myoxus/env/global";
import { getOrCreateI18n, I18nextProvider } from "@myoxus/i18n";
import { useLitPortalFactory } from "@myoxus/lit-react";
import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import type { ExtensionType } from "@virgultum/editor/store";
import { Fragment, useLayoutEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import themeProjection from "../../../client/branding/theme-fallback.css?raw";

function ChromeHost({
  root,
  bind,
}: {
  root: HTMLElement;
  bind: (extension: ExtensionType) => void;
}) {
  const [reactToLit, portals] = useLitPortalFactory();
  const extension = useMemo(
    () => patchEditorChromeHost(reactToLit),
    [reactToLit],
  );
  useLayoutEffect(() => bind(extension), [extension, bind]);
  return (
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusEmbeddedUIProvider getRootElement={() => root}>
        {portals.map(({ id, portal }) => (
          <Fragment key={id}>{portal}</Fragment>
        ))}
      </MyoxusEmbeddedUIProvider>
    </I18nextProvider>
  );
}

/** The test app consumes production controls through the same scoped portal host. */
export function mountEditorChrome(
  root: HTMLElement,
  bind: (extension: ExtensionType) => void,
) {
  setupGlobal();
  // The standalone harness consumes the generated server projection, including its font catalogue.
  if (!document.querySelector('[data-myoxus-branding="true"]')) {
    const style = document.createElement("style");
    style.dataset.myoxusBranding = "true";
    style.textContent = themeProjection;
    document.head.append(style);
  }
  const container = document.createElement("div");
  root.append(container);
  const reactRoot = createRoot(container);
  reactRoot.render(<ChromeHost root={root} bind={bind} />);
  return () => {
    reactRoot.unmount();
    container.remove();
  };
}
