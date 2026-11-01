// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidBlockRendererToken,
  type BlockReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidBlockRuntimeEditor } from "./editor";
export function createMermaidBlockRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<BlockReactHostProps> {
  const nativeView = (props: BlockReactHostProps) =>
    createElement(MermaidBlockRuntimeEditor, { props });
  return {
    token: mermaidBlockRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
