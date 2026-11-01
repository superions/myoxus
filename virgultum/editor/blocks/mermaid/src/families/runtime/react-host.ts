// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolbarControl } from "@virgultum/shared/services";

import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";
import type { TemplateResult } from "lit";
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
  readonly render: (props: TProps) => TemplateResult;
  readonly nativeView?: (props: TProps) => unknown;
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
      if (!registration?.nativeView)
        throw new Error(`Missing native Mermaid toolbar view: ${token.id}`);
      return { type: "native", node: registration.nativeView(props as never) };
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
export type MermaidFamilyReactHost = {
  /** Reuse the registered native view directly inside the selection toolbar. */
  readonly toolbarControl: <TProps>(
    token: MermaidFamilyReactRendererToken<TProps>,
    props: TProps,
  ) => ToolbarControl;
  readonly renderEmbeddedTitle: (
    props: MermaidEmbeddedTitleReactHostProps,
  ) => TemplateResult;
  readonly renderBlockShell: (
    props: MermaidBlockShellReactHostProps,
  ) => TemplateResult;
  readonly renderShellNotice: (
    props: MermaidShellNoticeReactHostProps,
  ) => TemplateResult;
  readonly renderFamilyEditor: <TProps>(
    token: MermaidFamilyReactRendererToken<TProps>,
    props: TProps,
  ) => TemplateResult;
};
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
