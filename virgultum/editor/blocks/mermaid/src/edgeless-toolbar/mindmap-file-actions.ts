// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SelectionAction } from "@virgultum/core/services";
import type { BlockComponent } from "@virgultum/core/runtime";
import { render, nothing } from "lit";
import { mermaidMessages as m } from "../i18n.js";
import { MermaidFamilyReactHostIdentifier } from "../families/runtime/react-host.js";
import { mermaidMindmapRendererToken } from "../families/mindmap/react-host-contract.js";

export function openMermaidMindmapImport(edgeless: BlockComponent) {
  if (edgeless.store.readonly) return;
  const react = edgeless.std.get(MermaidFamilyReactHostIdentifier);
  const container = document.createElement("div");
  edgeless.host.append(container);
  const close = () => {
    render(nothing, container);
    container.remove();
  };
  edgeless.disposables.add(close);
  render(
    react.renderFamilyEditor(mermaidMindmapRendererToken, {
      surface: "import",
      host: edgeless.host,
      onClose: close,
    }),
    container,
  );
}

export function createMermaidMindmapImportMenuItem(
  edgeless: BlockComponent,
): SelectionAction {
  return {
    id: "myoxus-mermaid-edgeless-import-mindmap",
    label: m.mindmapImport(),
    icon: "ImportIcon",
    disabled: edgeless.store.readonly,
    run: () => openMermaidMindmapImport(edgeless),
  };
}
