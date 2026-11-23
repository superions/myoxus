// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mermaidStateRendererToken,
  type StateReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidStateRuntimeEditor } from "./editor";
export function createMermaidStateRendererRegistration(): MermaidFamilyReactRendererRegistration<StateReactHostProps> {
  const nativeView = (props: StateReactHostProps) =>
    createElement(MermaidStateRuntimeEditor, { props });
  return {
    token: mermaidStateRendererToken,
    render: nativeView,
  };
}
