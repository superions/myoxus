// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SelectionAction } from "@virgultum/core/services";
import type { BlockComponent } from "@virgultum/core/runtime";
import { mermaidMessages as m } from "../i18n.js";
import { MermaidFamilyReactHostIdentifier } from "../families/runtime/react-host.js";
import { mermaidMindmapRendererToken } from "../families/mindmap/react-host-contract.js";

export function openMermaidMindmapImport(edgeless: BlockComponent) {
  if (edgeless.store.readonly) return;
  const react = edgeless.std.get(MermaidFamilyReactHostIdentifier);
  const container = document.createElement("div");
  edgeless.host.append(container);
  const close = () => {
    release();
    container.remove();
  };
  const view = react.renderFamilyEditor(mermaidMindmapRendererToken, {
    surface: "import",
    host: edgeless.host,
    onClose: close,
  });
  const release = react.mount(container, {
    getSnapshot: () => view,
    subscribe: () => () => undefined,
  });
  edgeless.disposables.add(close);
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
