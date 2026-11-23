// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mermaidErRendererToken,
  type ErReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidErRuntimeEditor } from "./editor";
export function createMermaidErRendererRegistration(): MermaidFamilyReactRendererRegistration<ErReactHostProps> {
  const nativeView = (props: ErReactHostProps) =>
    createElement(MermaidErRuntimeEditor, { props });
  return {
    token: mermaidErRendererToken,
    render: nativeView,
  };
}
