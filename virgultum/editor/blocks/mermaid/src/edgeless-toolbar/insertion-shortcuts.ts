// SPDX-License-Identifier: AGPL-3.0-or-later
import { LifeCycleWatcher } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import {
  getMermaidEdgelessToolbarTemplates,
  insertMermaidEdgelessToolbarTemplate,
} from "./mermaid-edgeless-toolbar.js";

/** Insertion shortcuts outlive individual visible pages of the toolbar. */
export class MermaidEdgelessInsertionShortcuts extends LifeCycleWatcher {
  static override key = "mermaid-edgeless-insertion-shortcuts";
  private dispose?: () => void;

  override mounted() {
    this.dispose = this.std.event.bindHotkey({
      m: () => {
        const gfx = this.std.get(GfxControllerIdentifier);
        if (
          this.std.store.readonly ||
          gfx.viewport.locked ||
          gfx.selection.editing
        )
          return;
        const root =
          this.std.store.root && this.std.view.getBlock(this.std.store.root.id);
        const template = getMermaidEdgelessToolbarTemplates().find(
          ({ diagramType }) => diagramType === "mindmap",
        );
        if (root && template)
          void insertMermaidEdgelessToolbarTemplate(root, template);
      },
    });
  }

  override unmounted() {
    this.dispose?.();
    this.dispose = undefined;
  }
}
