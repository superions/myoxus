// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import {
  mermaidMindmapRendererToken,
  type MindmapRendererHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { MindmapImportDialog } from "./import-dialog";
import { MindmapPassivePreview } from "./preview";
import { MermaidMindmapRuntimeEditor, MindmapLabelActions } from "./editor";
export function createMermaidMindmapRendererRegistration(): MermaidFamilyReactRendererRegistration<MindmapRendererHostProps> {
  const nativeView = (props: MindmapRendererHostProps) =>
    props.surface === "label-actions"
      ? createElement(MindmapLabelActions, { props })
      : props.surface === "import"
        ? createElement(MindmapImportDialog, { props })
        : props.surface === "preview"
          ? createElement(MindmapPassivePreview, { props })
          : createElement(MermaidMindmapRuntimeEditor, { props });
  return {
    token: mermaidMindmapRendererToken,
    render: nativeView,
  };
}
