// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/global/disposable";
import {
  cleanSpecifiedTail,
  getTextContentFromInlineRange,
} from "@virgultum/rich-text";
import type {
  EditorSlashControls,
  EditorSlashState,
} from "@virgultum/shared/services";
import { DocModeProvider, TelemetryProvider } from "@virgultum/shared/services";
import type { MyoxusInlineEditor } from "@virgultum/shared/types";
import { getCurrentNativeRange, isFuzzyMatch } from "@virgultum/shared/utils";
import type {
  SlashMenuConfig,
  SlashMenuContext,
  SlashMenuItem,
  SlashMenuSubMenu,
} from "./types";
import {
  buildSlashMenuItems,
  getSlashMenuI18n,
  getSlashMenuItemId,
  getSlashMenuItemSearchTerms,
  getSlashMenuSearchScore,
  isSubMenuItem,
  getSlashMenuItemLabel,
  getSlashMenuGroupLabel,
  resolveSlashMenuText,
} from "./utils";

/** One editor's trigger, live query and command lifetime. The renderer owns option navigation. */
export class SlashSession implements EditorSlashControls {
  readonly abortController = new AbortController();
  private readonly disposables = new DisposableGroup();
  private readonly listeners = new Set<() => void>();
  private readonly keyListeners = new Set<(event: KeyboardEvent) => void>();
  private readonly startRange;
  private readonly items: SlashMenuItem[];
  private path: SlashMenuSubMenu[] = [];
  private composing = false;
  private pending = false;
  private visibleItems: SlashMenuItem[] = [];
  private anchor: HTMLElement | null = null;
  private snapshot: EditorSlashState = {
    open: true,
    query: "",
    options: [],
    depth: 0,
  };
  get input() {
    return this.inlineEditor.eventSource!;
  }
  setAnchor = (anchor: HTMLElement | null) => {
    this.anchor = anchor;
    this.updateAnchor();
  };
  private readonly updateAnchor = () => {
    const range = getCurrentNativeRange();
    if (!this.anchor || !range) return;
    const rect = range.getBoundingClientRect();
    // A caret-sized target lets Floating observe movement even when result dimensions stay unchanged.
    Object.assign(this.anchor.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${Math.max(1, rect.width)}px`,
      height: `${rect.height}px`,
      pointerEvents: "none",
    });
  };

  constructor(
    readonly context: SlashMenuContext,
    readonly inlineEditor: MyoxusInlineEditor,
    readonly triggerKey: string,
    private readonly config: SlashMenuConfig,
    transform: (item: SlashMenuItem) => SlashMenuItem,
  ) {
    this.startRange = inlineEditor.getInlineRange();
    this.items = buildSlashMenuItems(
      typeof config.items === "function" ? config.items(context) : config.items,
      context,
      transform,
    );
    const source = inlineEditor.eventSource;
    if (!source) {
      this.cancel();
      return;
    }
    this.disposables.addFromEvent(source, "compositionstart", () => {
      this.composing = true;
    });
    this.disposables.addFromEvent(source, "compositionend", () => {
      this.composing = false;
      queueMicrotask(this.refresh);
    });
    source.addEventListener("keydown", this.onKeyDown, {
      capture: true,
      signal: this.abortController.signal,
    });
    const rendered = inlineEditor.slots.renderComplete.subscribe(() =>
      queueMicrotask(this.refresh),
    );
    this.disposables.add(() => rendered.unsubscribe());
    this.disposables.addFromEvent(window, "scroll", this.updateAnchor, true);
    this.disposables.addFromEvent(window, "resize", this.updateAnchor);
    const i18n = getSlashMenuI18n(context);
    this.disposables.add(
      effect(() => {
        void i18n?.locale$.value;
        this.refresh();
      }),
    );
    context.std.getOptional(TelemetryProvider)?.track("OpenSlashMenu", {
      page: context.std.get(DocModeProvider).getEditorMode() ?? undefined,
      type: context.model.flavour.split(":").pop(),
      module: "slash menu",
    });
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribeKeys = (listener: (event: KeyboardEvent) => void) => {
    this.keyListeners.add(listener);
    return () => {
      this.keyListeners.delete(listener);
    };
  };

  private publish(query: string, items: SlashMenuItem[], returnTo?: string) {
    this.visibleItems = items;
    const i18n = getSlashMenuI18n(this.context);
    this.snapshot = {
      open: !this.abortController.signal.aborted,
      query,
      depth: this.path.length,
      heading: this.path.length
        ? getSlashMenuItemLabel(this.path.at(-1)!, i18n)
        : undefined,
      returnTo,
      options: items.map((item) => ({
        id: getSlashMenuItemId(item),
        label: getSlashMenuItemLabel(item, i18n),
        icon: item.icon,
        group: query ? "" : getSlashMenuGroupLabel(item, i18n),
        description: resolveSlashMenuText(item.description, i18n),
        submenu: isSubMenuItem(item),
        ...("tooltip" in item && item.tooltip
          ? {
              help: resolveSlashMenuText(item.tooltip.caption, i18n),
              shortcut: item.tooltip.shortcut,
            }
          : {}),
      })),
    };
    this.updateAnchor();
    this.listeners.forEach((listener) => listener());
  }

  private search(query: string): SlashMenuItem[] {
    if (query.endsWith(" ")) return [];
    const i18n = getSlashMenuI18n(this.context);
    let level = this.items;
    let result: SlashMenuItem[] = [];
    for (let depth = 0; level.length; depth++) {
      result = result.filter((item) => !isSubMenuItem(item));
      result.push(
        ...level.filter((item) =>
          getSlashMenuItemSearchTerms(item, i18n).some((term) =>
            isFuzzyMatch(term.toLocaleLowerCase(i18n?.locale$.value), query),
          ),
        ),
      );
      if (depth > 0 && result.length) break;
      level = level.flatMap((item) =>
        isSubMenuItem(item) ? item.subMenu : [],
      );
    }
    return result.sort(
      (a, b) =>
        getSlashMenuSearchScore(b, query, i18n) -
        getSlashMenuSearchScore(a, query, i18n),
    );
  }

  refresh = () => {
    if (this.abortController.signal.aborted || this.pending || this.composing)
      return;
    const { std } = this.context;
    const query = getTextContentFromInlineRange(
      this.inlineEditor,
      this.startRange,
    );
    const start = this.startRange?.index;
    if (
      std.store.readonly ||
      this.config.disableWhen?.(this.context) ||
      query === null ||
      this.inlineEditor.getInlineRange()?.length !== 0 ||
      start === undefined ||
      this.inlineEditor.yText
        .toString()
        .slice(start - this.triggerKey.length, start) !== this.triggerKey
    ) {
      this.cancel();
      return;
    }
    if (query !== this.snapshot.query) this.path = [];
    this.publish(
      query,
      this.path.length
        ? this.path.at(-1)!.subMenu
        : query
          ? this.search(
              query.toLocaleLowerCase(
                getSlashMenuI18n(this.context)?.locale$.value,
              ),
            )
          : (this.path.at(-1)?.subMenu ?? this.items),
    );
  };

  enter = (item: SlashMenuSubMenu) => {
    if (!this.snapshot.open || !this.visibleItems.includes(item)) return;
    this.path.push(item);
    this.publish(this.snapshot.query, item.subMenu);
  };
  back = () => {
    if (this.path.length) {
      const parent = this.path.pop()!;
      this.publish(
        this.snapshot.query,
        this.path.at(-1)?.subMenu ??
          (this.snapshot.query ? this.search(this.snapshot.query) : this.items),
        getSlashMenuItemId(parent),
      );
    } else this.cancel();
  };

  choose = (id: string) => {
    const item = this.visibleItems.find(
      (item) => getSlashMenuItemId(item) === id,
    );
    if (!item) return;
    if (
      !this.snapshot.open ||
      this.pending ||
      !this.visibleItems.includes(item)
    )
      return;
    if (isSubMenuItem(item)) {
      this.enter(item);
      return;
    }
    const { std, model } = this.context;
    this.refresh();
    if (
      !this.snapshot.open ||
      std.store.readonly ||
      this.config.disableWhen?.(this.context) ||
      item.when?.(this.context) === false
    ) {
      this.cancel();
      return;
    }
    this.pending = true;
    // Existing commands expect the slash/query removed before they inspect or replace the block.
    cleanSpecifiedTail(std, model, this.triggerKey + this.snapshot.query);
    void this.inlineEditor
      .waitForUpdate()
      .then(() => {
        if (
          this.abortController.signal.aborted ||
          !this.inlineEditor.eventSource?.isConnected ||
          std.store.readonly ||
          !std.store.getBlock(model.id)
        )
          return;
        item.action(this.context);
        std.getOptional(TelemetryProvider)?.track("SelectSlashMenuItem", {
          page: std.get(DocModeProvider).getEditorMode() ?? undefined,
          segment:
            model.flavour === "myoxus:edgeless-text" ? "edgeless-text" : "doc",
          module: "slash menu",
          control: getSlashMenuItemId(item),
        });
      })
      .catch(console.error)
      .finally(this.cancel);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      this.composing ||
      event.key === "Process" ||
      event.defaultPrevented
    )
      return;
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    if (event.shiftKey && event.key.startsWith("Arrow")) {
      this.cancel();
      return;
    }
    this.keyListeners.forEach((listener) => listener(event));
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      this.back();
      event.preventDefault();
      event.stopPropagation();
    } else if (
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
      event.key === "Enter" ||
      ((event.metaKey || event.ctrlKey) &&
        !["p", "n", "v"].includes(event.key.toLowerCase()))
    )
      this.cancel();
  };

  cancel = () => {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort();
    this.disposables.dispose();
    this.publish(this.snapshot.query, []);
    this.keyListeners.clear();
  };
}
