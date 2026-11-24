import { signal } from "@preact/signals-core";
import { createElement } from "react";
import { mountEditorPortal } from "@virgultum/core/view/portal";
import { NativeEditorWidget, WidgetViewExtension } from "@virgultum/editor/std";

import { BlockDiffProvider } from "../../services/block-diff";
import { NativeAIWidgetUI } from "../native-ui";
import { DiffPlaygroundButton, DiffPlaygroundForm } from "./view";

export const MYOXUS_BLOCK_DIFF_PLAYGROUND = "myoxus-block-diff-playground";

export class BlockDiffPlayground extends NativeEditorWidget {
  private dialog?: AbortController;

  private readonly open = (button: HTMLButtonElement) => {
    this.dialog?.abort();
    const abort = (this.dialog = new AbortController());
    const service = this.std.get(BlockDiffProvider);
    const load = () => service.getMarkdownFromDoc(this.std.store);
    const view = createElement(DiffPlaygroundForm, {
      load,
      clear: () => service.setChangedMarkdown(""),
      confirm: async (markdown: string) => {
        const original = await load();
        if (abort.signal.aborted) return;
        service.setOriginalMarkdown(original);
        service.setChangedMarkdown(markdown);
        abort.abort();
      },
    });
    const root = mountEditorPortal(
      this.host,
      abort,
      (anchor) => {
        anchor.style.width =
          "min(100vw, calc((var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 20))";
        return this.std.get(NativeAIWidgetUI)(anchor, signal(view));
      },
      { referenceElement: button, placement: "top-end" },
    );
    if (!root) return;
    this.ownerDocument.addEventListener(
      "click",
      (event) => {
        const path = event.composedPath();
        if (!path.includes(root) && !path.includes(button)) abort.abort();
      },
      { signal: abort.signal },
    );
  };

  override connectedCallback() {
    super.connectedCallback();
    Object.assign(this.style, {
      position: "fixed",
      right: "var(--mantine-spacing-2xl)",
      bottom: "var(--mantine-spacing-2xl)",
      zIndex: "var(--myoxus-z-index-modal)",
    });
    const control = createElement(DiffPlaygroundButton, { open: this.open });
    const view = signal<ReturnType<typeof createElement> | null>(null);
    this.disposables.add(
      this.std.store.readonly$.subscribe((readonly) => {
        view.value = readonly ? null : control;
        if (readonly) this.dialog?.abort();
      }),
    );
    this.disposables.add(this.std.get(NativeAIWidgetUI)(this, view));
    this.disposables.add(() => this.dialog?.abort());
  }
}

export const blockDiffPlayground = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_BLOCK_DIFF_PLAYGROUND,
  MYOXUS_BLOCK_DIFF_PLAYGROUND,
);
