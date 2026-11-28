import { effect, type Signal, signal, untracked } from "@preact/signals-core";
import {
  NoteDisplayMode,
  ParagraphBlockModel,
  RootBlockModel,
} from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { EditorHost } from "@virgultum/core/runtime";
import {
  DocModeProvider,
  EditorChromeHostIdentifier,
  type EditorOutlineEntryControls,
} from "@virgultum/core/services";
import type { BlockModel } from "@virgultum/core/store";
import { matchModels } from "@virgultum/core/utils";

import {
  getHeadingBlocksFromDoc,
  observeActiveHeadingDuringScroll,
  scrollToBlockWithHighlight,
} from "./outline-helpers.js";

export const MYOXUS_MOBILE_OUTLINE_MENU = "myoxus-mobile-outline-menu";

type MountedMobileOutlineItem = {
  el: HTMLDivElement;
  controls$: Signal<EditorOutlineEntryControls | null>;
  unmount: () => void;
};

export class MobileOutlineMenu extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _activeHeadingId$ = signal<string | null>(null);
  private readonly _revision$ = signal(0);

  private _editor!: EditorHost;
  private _editorDisposables: DisposableGroup | null = null;
  private _highlightMaskDisposable = () => {};
  private _lockActiveHeadingId = false;
  private readonly _items = new Map<string, MountedMobileOutlineItem>();

  get editor(): EditorHost {
    return this._editor;
  }
  set editor(value: EditorHost) {
    const changed = this._editor !== value;
    this._editor = value;
    if (changed && this.isConnected) {
      this._clearItems();
      this._bindEditor();
    }
    this._revision$.value = this._revision$.peek() + 1;
  }

  private async _scrollToBlock(blockId: string) {
    this._lockActiveHeadingId = true;
    this._activeHeadingId$.value = blockId;
    this._highlightMaskDisposable = await scrollToBlockWithHighlight(
      this.editor,
      blockId,
    );
    this._lockActiveHeadingId = false;
  }

  private _clearItems() {
    for (const item of this._items.values()) {
      item.unmount();
      item.el.remove();
    }
    this._items.clear();
  }

  private _bindEditor() {
    this._editorDisposables?.dispose();
    this._editorDisposables = null;
    if (!this._editor) return;

    this._editorDisposables = new DisposableGroup();
    this._editorDisposables.add(
      observeActiveHeadingDuringScroll(
        () => this.editor,
        (newHeadingId) => {
          if (this._lockActiveHeadingId) return;
          this._activeHeadingId$.value = newHeadingId;
        },
      ),
    );
  }

  private _buildControls(
    item: BlockModel,
    activeHeadingId: string | null,
  ): EditorOutlineEntryControls | null {
    const root = matchModels(item, [RootBlockModel]);
    const heading =
      matchModels(item, [ParagraphBlockModel]) &&
      ["h1", "h2", "h3", "h4", "h5", "h6"].includes(item.props.type$.value);
    if (!root && !heading) return null;
    return {
      entry: {
        id: item.id,
        label: root
          ? item.props.title$.value.toString()
          : item.props.text$.value.toString(),
        level: root
          ? 0
          : Math.max(0, Number(item.props.type$.value.slice(1)) - 1),
        icon: "PageIcon",
      },
      active: activeHeadingId === item.id,
      showIcon: false,
      activate: () => {
        this._scrollToBlock(item.id).catch(console.error);
      },
    };
  }

  private _sync() {
    void this._revision$.value;
    const activeHeadingId = this._activeHeadingId$.value;
    if (!this._editor) {
      untracked(() => this._clearItems());
      return;
    }

    const docModeService = this._editor.std.get(DocModeProvider);
    const mode = docModeService.getEditorMode();
    if (this._editor.store.root === null || mode === "edgeless") {
      untracked(() => this._clearItems());
      return;
    }

    const headingBlocks = getHeadingBlocksFromDoc(
      this._editor.store,
      [NoteDisplayMode.DocAndEdgeless, NoteDisplayMode.DocOnly],
      true,
    );

    if (headingBlocks.length === 0) {
      untracked(() => this._clearItems());
      return;
    }

    const items = [
      ...(this._editor.store.meta?.title !== ""
        ? [this._editor.store.root]
        : []),
      ...headingBlocks,
    ];

    const entries = items.map((block) => ({
      block,
      controls: this._buildControls(block, activeHeadingId),
    }));

    untracked(() => {
      const chrome = this._editor.std.getOptional(EditorChromeHostIdentifier);
      const nextIds = new Set(entries.map(({ block }) => block.id));
      for (const [id, mounted] of this._items) {
        if (!nextIds.has(id)) {
          mounted.unmount();
          mounted.el.remove();
          this._items.delete(id);
        }
      }

      for (const { block, controls } of entries) {
        let mounted = this._items.get(block.id);
        if (!mounted) {
          const el = this.ownerDocument.createElement("div");
          el.style.display = "contents";
          const controls$ = signal<EditorOutlineEntryControls | null>(controls);
          const unmount = chrome
            ? chrome.mountOutlineEntry(el, controls$)
            : () => {};
          mounted = { el, controls$, unmount };
          this._items.set(block.id, mounted);
        } else {
          mounted.controls$.value = controls;
        }
        this.append(mounted.el);
      }
    });
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    this._bindEditor();
    this.disposables.add(
      effect(() => {
        this._sync();
      }),
    );
  }

  disconnectedCallback() {
    this._editorDisposables?.dispose();
    this._editorDisposables = null;
    this._clearItems();
    this.disposables.dispose();
    this._highlightMaskDisposable();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_MOBILE_OUTLINE_MENU]: MobileOutlineMenu;
  }
}
