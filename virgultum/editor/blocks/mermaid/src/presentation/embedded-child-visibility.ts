// SPDX-License-Identifier: AGPL-3.0-or-later

import { DisposableGroup } from "@virgultum/global/disposable";
import type { MermaidBlockModel } from "@virgultum/model";
import { LifeCycleWatcher } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type { Store } from "@virgultum/store";

import { resolveMermaidLegacyLinkedOwner } from "./legacy-linked-owner.js";

type LocallyFilteredSurface = {
  setLocallyExcludedElementIds(ids: ReadonlySet<string>): void;
};

export function collectEmbeddedMermaidRootExclusions(store: Store) {
  const excludedElementIds = new Set<string>();

  for (const block of store.getBlocksByFlavour("myoxus:mermaid")) {
    const owner = block.model as MermaidBlockModel;
    const parent = store.getParent(owner.id);
    if (parent?.flavour === "myoxus:surface") continue;

    excludedElementIds.add(owner.id);
    const legacy =
      owner.childIds.length === 0
        ? resolveMermaidLegacyLinkedOwner(owner)
        : null;
    const ids = legacy?.childElementIds ?? owner.childIds;
    ids.forEach((id) => excludedElementIds.add(id));
    if (legacy) excludedElementIds.add(legacy.frame.id);
  }
  return excludedElementIds;
}

/**
 * Keeps children rendered by an embedded Mermaid host out of the root canvas.
 * Current owner children use the root surface's local exclusion set, so a
 * nested scoped renderer can project the same models without changing shared
 * model state. Rendering and hit-testing share this boundary; hidden root
 * children must never intercept input intended for the embedded host.
 */
export class MermaidEmbeddedChildVisibility extends LifeCycleWatcher {
  static override readonly key = "mermaid-embedded-child-visibility";

  private readonly _disposables = new DisposableGroup();
  override mounted() {
    this._recompute();
    this._disposables.add(
      this.std.store.slots.blockUpdated.subscribe(() => this._recompute()),
    );
    // The surface view can mount after this watcher. Readonly documents do not
    // produce a model write that would otherwise initialize the exclusion set.
    this._disposables.add(
      this.std.view.viewUpdated.subscribe(({ id, method, type }) => {
        if (
          type === "block" &&
          method === "add" &&
          id === this.std.getOptional(GfxControllerIdentifier)?.surface?.id
        )
          this._recompute();
      }),
    );
  }

  override unmounted() {
    this._disposables.dispose();
    const surface = this.std.getOptional(GfxControllerIdentifier)
      ?.surfaceComponent as LocallyFilteredSurface | null | undefined;
    surface?.setLocallyExcludedElementIds(new Set());
  }

  private _recompute() {
    const surface = this.std.getOptional(GfxControllerIdentifier)
      ?.surfaceComponent as LocallyFilteredSurface | null | undefined;
    surface?.setLocallyExcludedElementIds(
      collectEmbeddedMermaidRootExclusions(this.std.store),
    );
  }
}
