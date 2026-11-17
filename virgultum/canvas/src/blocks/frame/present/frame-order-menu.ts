import { EdgelessCRUDIdentifier } from "@virgultum/canvas-runtime/surface";
import { SignalWatcher, WithDisposable } from "@virgultum/core/primitives/lit";
import {
  type BlockComponent,
  ShadowlessElement,
} from "@virgultum/core/runtime";
import { generateKeyBetweenV2 } from "@virgultum/core/runtime/gfx";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import { EdgelessFrameManagerIdentifier } from "../frame-manager";

export class EdgelessFrameOrderMenu extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private get frameManager() {
    return this.edgeless.std.get(EdgelessFrameManagerIdentifier);
  }

  private readonly move = (id: string, before: string | null) => {
    if (this.edgeless.store.readonly || id === before) return;
    const manager = this.frameManager;
    const frames = manager.frames;
    const source = frames.findIndex((frame) => frame.id === id);
    const target =
      before === null
        ? frames.length
        : frames.findIndex((frame) => frame.id === before);
    if (source < 0 || target < 0 || target === source || target === source + 1)
      return;

    // Normalize old presentation indices using the same command as the original menu.
    manager.refreshLegacyFrameOrder();
    const neighbours = manager.frames.filter((frame) => frame.id !== id);
    const insertion =
      before === null
        ? neighbours.length
        : neighbours.findIndex((frame) => frame.id === before);
    this.edgeless.std.get(EdgelessCRUDIdentifier).updateElement(id, {
      presentationIndex: generateKeyBetweenV2(
        neighbours[insertion - 1]?.props.presentationIndex || null,
        neighbours[insertion]?.props.presentationIndex || null,
      ),
    });
    this.edgeless.store.captureSync();
    this.requestUpdate();
  };

  override render() {
    return (
      this.edgeless.std
        .getOptional(EditorChromeHostIdentifier)
        ?.renderFrameOrder({
          items: this.frameManager.frames.map((frame) => ({
            id: frame.id,
            title: frame.props.title.toString(),
          })),
          embedded: this.embed,
          readonly: this.edgeless.store.readonly,
          move: this.move,
        }) ?? nothing
    );
  }

  @property({ attribute: false })
  accessor edgeless!: BlockComponent;

  @property({ attribute: false })
  accessor embed = false;
}
