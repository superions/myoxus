import { EmbedSyncedDocBlockSchema } from "@virgultum/core/models";
import { type EditorHost, LifeCycleWatcher } from "@virgultum/core/runtime";
import type { BlockModel } from "@virgultum/core/store";
import type { Subscription } from "rxjs";

import type { EmbedEdgelessSyncedDocBlockComponent } from "./embed-edgeless-synced-doc-block";
import { calcSyncedDocFullHeight } from "./utils";

export class HeightInitializationExtension extends LifeCycleWatcher {
  static override key = "embed-synced-doc-block-height-initialization";

  private createdHere = new WeakSet<BlockModel>();
  private subscription?: Subscription;

  override mounted() {
    this.subscription = this.std.store.slots.blockUpdated.subscribe(
      (payload) => {
        if (
          payload.type === "add" &&
          payload.isLocal &&
          payload.flavour === EmbedSyncedDocBlockSchema.model.flavour &&
          payload.model.parent?.flavour === "myoxus:surface"
        )
          this.createdHere.add(payload.model);
      },
    );
  }

  /** Only fit a newly created local card, once its nested text has laid out. */
  async fitPreview(
    block: EmbedEdgelessSyncedDocBlockComponent,
    preview: EditorHost,
  ) {
    const { model } = block;
    if (!this.createdHere.has(model)) return;
    const originalSize = model.xywh;
    // The caller returns this host to its owner; connection precedes readiness.
    await Promise.resolve();
    if (
      !(await preview.updateComplete) ||
      !block.contains(preview) ||
      block.store.readonly ||
      !this.createdHere.delete(model) ||
      originalSize !== model.xywh
    )
      return;
    const { x, y, w } = model.elementBound;
    const height = calcSyncedDocFullHeight(block);
    model.xywh$.value = `[${x},${y},${w},${height}]`;
  }

  override unmounted() {
    this.subscription?.unsubscribe();
    this.createdHere = new WeakSet();
  }
}
