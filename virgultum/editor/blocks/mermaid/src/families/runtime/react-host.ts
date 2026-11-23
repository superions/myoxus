// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  EditorActionMenuControls,
  ToolbarControl,
} from "@virgultum/core/services";

import { createIdentifier } from "@virgultum/core/primitives/di";
import type { ExtensionType } from "@virgultum/core/store";
import type { ReactNode } from "react";
import { computed, type ReadonlySignal } from "@preact/signals-core";
import type { ShapeTextEditDraftActions } from "@virgultum/canvas/gfx";
import type {
  MermaidBlockShellReactHostProps,
  MermaidEmbeddedTitleReactHostProps,
  MermaidShellNoticeReactHostProps,
} from "./shell-contract.js";

export type MermaidFamilyReactRendererToken<TProps> = {
  readonly id: string;
  readonly props: (props: TProps) => void;
};
export type MermaidFamilyReactRendererRegistration<TProps> = {
  readonly token: MermaidFamilyReactRendererToken<TProps>;
  readonly render: (props: TProps) => ReactNode;
};
export function defineMermaidFamilyReactRendererToken<TProps>(
  id: string,
): MermaidFamilyReactRendererToken<TProps> {
  return { id, props: (_props: TProps) => undefined };
}
export function createMermaidFamilyReactRendererHost(
  registrations: ReadonlyArray<MermaidFamilyReactRendererRegistration<never>>,
): Pick<MermaidFamilyReactHost, "renderFamilyEditor" | "toolbarControl"> {
  return {
    toolbarControl: (token, props) => {
      const registration = registrations.find(
        (candidate) => candidate.token === token,
      );
      if (!registration)
        throw new Error(`Missing native Mermaid toolbar view: ${token.id}`);
      return { type: "native", node: registration.render(props as never) };
    },
    renderFamilyEditor: (token, props) => {
      const registration = registrations.find(
        (candidate) => candidate.token === token,
      );
      if (!registration)
        throw new Error(`Missing Mermaid renderer registration: ${token.id}`);
      return registration.render(props as never);
    },
  };
}
export type MermaidViewBinding = {
  readonly getSnapshot: () => ReactNode;
  readonly subscribe: (listener: () => void) => () => void;
  readonly afterCommit?: () => void;
};

export type MermaidFamilyReactHost = {
  readonly mount: (
    anchor: HTMLElement,
    binding: MermaidViewBinding,
  ) => () => void;
  readonly renderContextMenu: (controls: EditorActionMenuControls) => ReactNode;
  /** Reuse the registered native view directly inside the selection toolbar. */
  readonly toolbarControl: <TProps>(
    token: MermaidFamilyReactRendererToken<TProps>,
    props: TProps,
  ) => ToolbarControl;
  readonly renderEmbeddedTitle: (
    props: MermaidEmbeddedTitleReactHostProps,
  ) => ReactNode;
  readonly renderBlockShell: (
    props: MermaidBlockShellReactHostProps,
  ) => ReactNode;
  readonly renderShellNotice: (
    props: MermaidShellNoticeReactHostProps,
  ) => ReactNode;
  readonly renderFamilyEditor: <TProps>(
    token: MermaidFamilyReactRendererToken<TProps>,
    props: TProps,
  ) => ReactNode;
};
/** Keep draft chrome mounted while its anchor follows scoped GFX geometry. */
export function mountMermaidDraftActions<TProps>(
  host: MermaidFamilyReactHost | undefined | null,
  anchor: HTMLElement,
  actions: ReadonlySignal<ShapeTextEditDraftActions | null>,
  token: MermaidFamilyReactRendererToken<TProps>,
  props: (actions: ShapeTextEditDraftActions) => TProps,
) {
  if (!host) return;
  const view = computed(() => {
    const current = actions.value;
    return current ? host.renderFamilyEditor(token, props(current)) : null;
  });
  return host.mount(anchor, {
    getSnapshot: () => view.value,
    subscribe: (listener) => view.subscribe(listener),
  });
}

export const MermaidFamilyReactHostIdentifier =
  createIdentifier<MermaidFamilyReactHost>("MermaidFamilyReactHost");
export function MermaidFamilyReactHostExtension(
  host: MermaidFamilyReactHost,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(MermaidFamilyReactHostIdentifier, () => host);
    },
  };
}
