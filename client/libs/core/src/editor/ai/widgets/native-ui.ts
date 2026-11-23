// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { createIdentifier } from "@virgultum/editor/global/di";
import type { ExtensionType } from "@virgultum/editor/store";
import type { MountReactPortal } from "@myoxus/lit-react";
import type { ReadonlySignal } from "@preact/signals-core";
import {
  createElement,
  type ReactNode,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { EditorEmbeddedUIRoot } from "../../view-extensions/editor-view/embedded-ui-root";
import type { TemplateResult } from "lit";

/** The existing editor React tree owns theme, portals and disposal; AI stays client-only. */
export const AIWidgetUI =
  createIdentifier<(view: ReactNode) => TemplateResult>("MyoxusAIWidgetUI");
export function aiWidgetUI(
  render: (view: ReactNode) => TemplateResult,
): ExtensionType {
  return { setup: (di) => di.addImpl(AIWidgetUI, () => render) };
}

type MountAIWidget = (
  anchor: HTMLElement,
  view: ReadonlySignal<ReactNode>,
  onCommit?: () => void,
) => () => void;

export const NativeAIWidgetUI = createIdentifier<MountAIWidget>(
  "MyoxusNativeAIWidgetUI",
);

function NativeAIWidgetView({
  anchor,
  view,
  onCommit,
}: {
  anchor: HTMLElement;
  view: ReadonlySignal<ReactNode>;
  onCommit?: () => void;
}) {
  const snapshot = useSyncExternalStore(
    (notify) => view.subscribe(notify),
    () => view.value,
  );
  useLayoutEffect(() => onCommit?.(), [snapshot, onCommit]);
  return createElement(EditorEmbeddedUIRoot, { portalRoot: anchor }, snapshot);
}

export function nativeAIWidgetUI(mount: MountReactPortal): ExtensionType {
  return {
    setup: (di) =>
      di.addImpl(
        NativeAIWidgetUI,
        (): MountAIWidget => (anchor, view, onCommit) =>
          mount(
            anchor,
            createElement(NativeAIWidgetView, { anchor, view, onCommit }),
          ),
      ),
  };
}
