// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidSequenceRendererToken,
  type SequenceReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidSequenceRuntimeEditor } from "./editor";
export function createMermaidSequenceRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<SequenceReactHostProps> {
  const nativeView = (props: SequenceReactHostProps) =>
    createElement(MermaidSequenceRuntimeEditor, { props });
  return {
    token: mermaidSequenceRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
