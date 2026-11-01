// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
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
export function createMermaidGitGraphRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<GitGraphReactHostProps> {
  const nativeView = (props: GitGraphReactHostProps) =>
    createElement(MermaidGitGraphRuntimeEditor, { props });
  return {
    nativeView,
    token: mermaidGitGraphRendererToken,
    render: (props) => reactToLit(nativeView(props), true),
  };
}

export function createMermaidGitGraphRepairRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<GitGraphRepairHostProps> {
  return {
    token: mermaidGitGraphRepairRendererToken,
    nativeView: (props) => createElement(GitGraphSourceRepair, { props }),
    render: (props) =>
      props.surface === "controls"
        ? reactToLit(createElement(GitGraphSourceRepair, { props }), true)
        : reactToLit(
            createElement(MermaidGfxEditorWorkbench, {
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
            true,
          ),
  };
}
