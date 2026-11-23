// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { NativeViewElement } from "@virgultum/core/runtime";
import { effect } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { NoteBlockModel } from "@virgultum/core/models";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { stopPropagation } from "@virgultum/core/utils";

import { hasEdgelessNoteHeader, NoteConfigExtension } from "../config";
import {
  focusCanvasNoteBackground,
  readCanvasNoteBackground,
} from "./edgeless-note-background";
import { background } from "./edgeless-note-background.styles";
import { pageBlockTitle } from "./edgeless-page-block-title.styles";

/** Keep the mounted control stable when unrelated note properties change. */
function mountWhile(
  visible: () => boolean,
  mount: () => (() => void) | undefined,
) {
  let dispose: (() => void) | undefined;
  const stop = effect(() => {
    if (visible()) dispose ??= mount();
    else {
      dispose?.();
      dispose = undefined;
    }
  });
  return () => {
    stop();
    dispose?.();
  };
}

export class EdgelessNoteBackground extends NativeViewElement {
  note!: NoteBlockModel;
  std!: BlockStdScope;
  editing = false;
  private connection?: DisposableGroup;

  connectedCallback() {
    const connection = new DisposableGroup();
    this.connection = connection;
    const { note, std } = this;
    const context = { note, std };
    const config = std.getOptional(NoteConfigExtension.identifier);

    this.classList.add(background);
    connection.add(
      effect(() => {
        Object.assign(this.style, readCanvasNoteBackground(std, note));
      }),
    );
    connection.addFromEvent(this, "pointerdown", stopPropagation);
    connection.addFromEvent(this, "click", (event) =>
      focusCanvasNoteBackground(this, note, std, this.editing, event),
    );
    if (config) {
      connection.add(
        mountWhile(
          () => hasEdgelessNoteHeader(context),
          () => config.mountEdgelessNoteHeader(this, context),
        ),
      );
    }
  }

  disconnectedCallback() {
    this.connection?.dispose();
    this.connection = undefined;
  }
}

export class EdgelessPageBlockTitle extends NativeViewElement {
  note!: NoteBlockModel;
  std!: BlockStdScope;
  private connection?: DisposableGroup;

  connectedCallback() {
    const { note, std } = this;
    const config = std.getOptional(NoteConfigExtension.identifier);
    const context = { note, std };
    const connection = new DisposableGroup();
    this.connection = connection;
    const container = this.ownerDocument.createElement("div");
    container.className = pageBlockTitle;
    connection.add(
      mountWhile(
        () => note.isPageBlock(),
        () => {
          this.append(container);
          return () => container.remove();
        },
      ),
    );
    if (config) {
      connection.add(
        mountWhile(
          () =>
            note.isPageBlock() &&
            (config.pageBlockTitleVisible?.(context) ?? true),
          () => config.mountPageBlockTitle(container, context),
        ),
      );
    }
  }

  disconnectedCallback() {
    this.connection?.dispose();
    this.connection = undefined;
  }
}
