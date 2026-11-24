import type { TranscriptionBlockModel } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import {
  NativeContainerBlock,
  BlockViewExtension,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import { effect } from "@preact/signals-core";

export class TranscriptionBlockView extends NativeContainerBlock<TranscriptionBlockModel> {
  protected readonly blockStyles = `
    transcription-block {
      outline: none;
      display: flex;
      flex-direction: column;
      gap: var(--mantine-spacing-xs);
    }
  `;

  protected mountBody() {
    this.disposables.add(
      effect(() => {
        this.contentEditable = String(!this.store.readonly$.value);
      }),
    );
    this.disposables.addFromEvent(this, "click", (event) =>
      event.stopPropagation(),
    );
    return this;
  }
}

export const AITranscriptionBlockSpec: ExtensionType[] = [
  BlockViewExtension("myoxus:transcription", "transcription-block"),
];
