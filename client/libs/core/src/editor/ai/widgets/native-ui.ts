// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import type { MountReactPortal } from "@myoxus/core/editor/portal";
import type { ReadonlySignal } from "@preact/signals-core";
import { createIdentifier } from "@virgultum/editor/global/di";
import type { ExtensionType } from "@virgultum/editor/store";
import {
  createElement,
  type ReactNode,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { EditorEmbeddedUIRoot } from "../../view-extensions/editor-view/embedded-ui-root";

export type MountAIWidget = (
  anchor: HTMLElement,
  view: ReadonlySignal<ReactNode>,
  onCommit?: () => void,
) => () => void;

export const NativeAIWidgetUI = createIdentifier<MountAIWidget>(
  "MyoxusNativeAIWidgetUI",
);

export function ReactivePortalView({
  view,
  onCommit,
}: {
  view: ReadonlySignal<ReactNode>;
  onCommit?: () => void;
}) {
  const snapshot = useSyncExternalStore(
    (notify) => view.subscribe(notify),
    () => view.value,
  );
  useLayoutEffect(() => onCommit?.(), [snapshot, onCommit]);
  return snapshot;
}

function NativeAIWidgetView({
  anchor,
  view,
  onCommit,
}: {
  anchor: HTMLElement;
  view: ReadonlySignal<ReactNode>;
  onCommit?: () => void;
}) {
  return createElement(
    EditorEmbeddedUIRoot,
    { portalRoot: anchor },
    createElement(ReactivePortalView, { view, onCommit }),
  );
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
