// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mermaidGitGraphRendererToken,
  mermaidGitGraphRepairRendererToken,
  type GitGraphRepairHostProps,
  type GitGraphReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { createElement } from "react";
import { GitGraphSourceRepair } from "./commit-popover";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidGitGraphRuntimeEditor } from "./editor";
export function createMermaidGitGraphRendererRegistration(): MermaidFamilyReactRendererRegistration<GitGraphReactHostProps> {
  const nativeView = (props: GitGraphReactHostProps) =>
    createElement(MermaidGitGraphRuntimeEditor, { props });
  return {
    token: mermaidGitGraphRendererToken,
    render: nativeView,
  };
}

export function createMermaidGitGraphRepairRegistration(): MermaidFamilyReactRendererRegistration<GitGraphRepairHostProps> {
  return {
    token: mermaidGitGraphRepairRendererToken,
    render: (props) =>
      props.surface === "controls"
        ? createElement(GitGraphSourceRepair, { props })
        : createElement(MermaidGfxEditorWorkbench, {
            context: null,
            contextOpened: false,
            onCloseContext: props.onCancelPreview,
            onWorkareaResize: props.onWorkareaResize,
            resolveReturnFocusTarget: props.resolveReturnFocusTarget,
            selectionKey: props.sourceBasis,
            toolbar: createElement(GitGraphSourceRepair, { props }),
            workarea: props.workarea,
            workareaFooter: props.workareaFooter,
            workareaLabel: props.model.accessibilityTitle,
            workareaAccessibilityTitle: props.model.accessibilityTitle,
            workareaAccessibilityDescription:
              props.model.accessibilityDescription,
            pageViewport: props.pageViewport,
          }),
  };
}
