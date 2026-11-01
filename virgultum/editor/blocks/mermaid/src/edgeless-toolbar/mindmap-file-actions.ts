// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImportIcon } from "@myoxus/icons/lit";
import { menu, type MenuConfig } from "@virgultum/components/context-menu";
import type { BlockComponent } from "@virgultum/std";
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
): MenuConfig {
  return menu.action({
    name: m.mindmapImport(),
    prefix: ImportIcon({ width: "20px", height: "20px" }),
    select: () => openMermaidMindmapImport(edgeless),
    testId: "myoxus-mermaid-edgeless-import-mindmap",
  });
}
