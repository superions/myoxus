// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidClassRendererToken,
  type ClassReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidClassRuntimeEditor } from "./editor";
export function createMermaidClassRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<ClassReactHostProps> {
  const nativeView = (props: ClassReactHostProps) =>
    createElement(MermaidClassRuntimeEditor, { props });
  return {
    token: mermaidClassRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
