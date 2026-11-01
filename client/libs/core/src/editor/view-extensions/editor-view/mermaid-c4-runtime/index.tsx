// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidC4RendererToken,
  type C4EditorReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidC4RuntimeEditor } from "./editor";

/** Page, Embedded and native Root controls share the registered C4 consumer. */
export function createMermaidC4RendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<C4EditorReactHostProps> {
  const nativeView = (props: C4EditorReactHostProps) =>
    createElement(MermaidC4RuntimeEditor, { props });
  return {
    token: mermaidC4RendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
