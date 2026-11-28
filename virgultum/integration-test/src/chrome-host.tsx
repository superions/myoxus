// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { patchCalloutTitleHost } from "@myoxus/core/editor/view-extensions/editor-view/callout";
import { patchMermaidFamilyReactHost } from "@myoxus/core/editor/view-extensions/editor-view/mermaid-family-react-host";
import { patchEditorChromeHost } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome";
import { EditorFrameNavigator } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome/frame-navigator";
import { setupGlobal } from "@myoxus/env/global";
import { getOrCreateI18n, I18nextProvider } from "@myoxus/i18n";
import { usePortalFactory } from "@myoxus/core/editor/portal";
import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import { FrameNavigatorController } from "@virgultum/editor/fragments/frame-panel";
import type { EditorHost } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import { MermaidFamilyReactHostIdentifier } from "@virgultum/editor/blocks/mermaid";
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
  const [portals, mountPortal] = usePortalFactory();
  const extension = useMemo(() => {
    const chrome = patchEditorChromeHost(mountPortal);
    const mermaid = patchMermaidFamilyReactHost(mountPortal);
    return {
      setup(di) {
        chrome.setup(di);
        patchCalloutTitleHost(mountPortal).setup(di);
        // A renderer-contract fixture can supply its own host for this scope.
        if (!di.getFactory(MermaidFamilyReactHostIdentifier)) mermaid.setup(di);
      },
    } satisfies ExtensionType;
  }, [mountPortal]);
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

/**
 * Mounts the production {@link EditorFrameNavigator} backed by
 * {@link FrameNavigatorController} inside an isolated fixed fixture pane for
 * Playwright E2E tests, supporting host rebinding across mode switches.
 */
export function mountFrameNavigatorFixture(host: EditorHost): {
  setHost(nextHost: EditorHost): void;
  unmount(): void;
} {
  const controller = new FrameNavigatorController(host);
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    insetBlock: "0",
    insetInlineEnd: "0",
    inlineSize: "30vw",
    blockSize: "100vh",
    overflowY: "auto",
  });
  document.body.append(container);
  const reactRoot = createRoot(container);
  reactRoot.render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusEmbeddedUIProvider getRootElement={() => container}>
        <EditorFrameNavigator
          controller={controller}
          emptyLabel="Add frames to organize your presentation."
        />
      </MyoxusEmbeddedUIProvider>
    </I18nextProvider>,
  );
  return {
    setHost(nextHost: EditorHost) {
      controller.setHost(nextHost);
    },
    unmount() {
      reactRoot.unmount();
      container.remove();
    },
  };
}
