// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mermaidBlockRendererToken,
  type BlockReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { MermaidBlockRuntimeEditor } from "./editor";
export function createMermaidBlockRendererRegistration(): MermaidFamilyReactRendererRegistration<BlockReactHostProps> {
  const nativeView = (props: BlockReactHostProps) =>
    createElement(MermaidBlockRuntimeEditor, { props });
  return {
    token: mermaidBlockRendererToken,
    render: nativeView,
  };
}
