// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { TranscriptionBlockModel } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import { effect } from "@preact/signals-core";
import {
  BlockViewExtension,
  NativeContainerBlock,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";

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
    this.disposables.addFromEvent(this, "click", (event) => {
      event.stopPropagation();
    });
    return this;
  }
}

export const AITranscriptionBlockSpec: ExtensionType[] = [
  BlockViewExtension("myoxus:transcription", "transcription-block"),
];
