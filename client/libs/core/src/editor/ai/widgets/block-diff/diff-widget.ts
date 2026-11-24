// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { signal } from "@preact/signals-core";
import { NativeEditorWidget } from "@virgultum/editor/std";
import type { ReactNode } from "react";
import { BlockDiffProvider } from "../../services/block-diff";
import { NativeAIWidgetUI } from "../native-ui";

/** A document can have thousands of blocks. Allocate a portal only for visible changes. */
export abstract class DiffWidget extends NativeEditorWidget {
  private readonly view = signal<ReactNode>(null);
  private release?: () => void;

  protected get diffService() {
    return this.std.get(BlockDiffProvider);
  }

  protected abstract renderDiff(): ReactNode;

  protected refresh = () => {
    const next = this.renderDiff();
    this.view.value = next;
    if (next == null) {
      this.release?.();
      this.release = undefined;
    } else {
      this.release ??= this.std.get(NativeAIWidgetUI)(this, this.view);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(this.diffService.diffMap$.subscribe(this.refresh));
    this.disposables.add(this.diffService.rejects$.subscribe(this.refresh));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.release?.();
    this.release = undefined;
    this.view.value = null;
  }
}
