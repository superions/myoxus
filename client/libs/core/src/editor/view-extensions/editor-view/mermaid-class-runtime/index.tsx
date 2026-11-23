// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mermaidClassRendererToken,
  type ClassReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidClassRuntimeEditor } from "./editor";
export function createMermaidClassRendererRegistration(): MermaidFamilyReactRendererRegistration<ClassReactHostProps> {
  const nativeView = (props: ClassReactHostProps) =>
    createElement(MermaidClassRuntimeEditor, { props });
  return {
    token: mermaidClassRendererToken,
    render: nativeView,
  };
}
