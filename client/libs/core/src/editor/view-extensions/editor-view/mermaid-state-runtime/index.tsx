// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidStateRendererToken,
  type StateReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidStateRuntimeEditor } from "./editor";
export function createMermaidStateRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<StateReactHostProps> {
  const nativeView = (props: StateReactHostProps) =>
    createElement(MermaidStateRuntimeEditor, { props });
  return {
    token: mermaidStateRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
