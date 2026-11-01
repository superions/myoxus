// SPDX-License-Identifier: AGPL-3.0-or-later

export { MermaidArchitectureRuntimeEditor } from "./editor";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidArchitectureRendererToken,
  type MermaidArchitectureReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { MermaidArchitectureRuntimeEditor } from "./editor";
import { createElement } from "react";
import { MermaidSelectionDeleteAction } from "../mermaid-editor-workbench";
import { MermaidArchitectureCommentPopover } from "./comment-popover";
import { MermaidArchitectureDiagramSettings } from "./diagram-settings";
import { MermaidArchitectureObjectPopover } from "./object-popover";

function MermaidArchitectureSurface({
  props,
}: {
  readonly props: MermaidArchitectureReactHostProps;
}) {
  switch (props.surface) {
    case "comments":
      return createElement(MermaidArchitectureCommentPopover, {
        anchor: props.anchor,
        props,
        marker: true,
      });
    case "delete-confirmation":
      return createElement(MermaidSelectionDeleteAction, {
        action: props.selectionAction,
        resolveReturnFocusTarget: props.resolveReturnFocusTarget,
      });
    case "editor":
      return createElement(MermaidArchitectureRuntimeEditor, { props });
    case "properties":
      return createElement(MermaidArchitectureObjectPopover, { props });
    case "settings":
      return createElement(MermaidArchitectureDiagramSettings, { props });
  }
}

export function createMermaidArchitectureRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidArchitectureReactHostProps> {
  const nativeView = (props: MermaidArchitectureReactHostProps) =>
    createElement(MermaidArchitectureSurface, { props });
  return {
    token: mermaidArchitectureRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
