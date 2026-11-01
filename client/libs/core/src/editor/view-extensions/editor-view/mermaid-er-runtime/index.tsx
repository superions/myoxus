// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidErRendererToken,
  type ErReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidErRuntimeEditor } from "./editor";
export function createMermaidErRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<ErReactHostProps> {
  const nativeView = (props: ErReactHostProps) =>
    createElement(MermaidErRuntimeEditor, { props });
  return {
    token: mermaidErRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
