// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { autoUpdate } from "@floating-ui/dom";
import { computed, signal } from "@preact/signals-core";
import {
  cleanSpecifiedTail,
  getTextContentFromInlineRange,
} from "@virgultum/rich-text";
import type {
  EditorDocumentPickerControls,
  EditorDocumentPickerState,
} from "@virgultum/shared/services";
import { createKeydownObserver } from "@virgultum/shared/utils";
import type { LinkedDocContext, LinkedMenuGroup } from "./config";
import { resolveSignal } from "./utils";

/** One input session; providers own search, permissions and document writes. */
export class DocumentPickerSession implements EditorDocumentPickerControls {
  readonly input: HTMLElement;
  readonly abort = new AbortController();
  private request?: AbortController;
  private stopAnchor?: () => void;
  private readonly keys = new Set<(event: KeyboardEvent) => void>();
  private readonly expanded = signal(new Set<string>());
  private activeKey: string | null = null;
  private composing = false;
  private pending = false;
  private readonly state = signal<{
    open: boolean;
    query?: string;
    groups: LinkedMenuGroup[];
  }>({ open: true, groups: [] });
  private readonly presentation = computed<EditorDocumentPickerState>(() => {
    const { open, query = "", groups } = this.state.value;
    const visible = groups.flatMap((group, index) => {
      if (resolveSignal(group.hidden)) return [];
      const all = resolveSignal(group.items);
      const loading = !!resolveSignal(group.loading);
      if (!all.length && !loading && !group.emptyMessage) return [];
      const limit = this.expanded.value.has(group.name)
        ? all.length
        : (group.maxDisplay ?? all.length);
      const items = all.slice(0, limit).map(({ action: _, key, ...item }) => ({
        ...item,
        id: `${index}:${key}`,
      }));
      if (all.length > limit)
        items.push({
          id: `more:${index}`,
          name: resolveSignal(group.overflowText) || "…",
          icon: "MoreHorizontalIcon",
        });
      return [
        {
          id: String(index),
          name: group.name,
          loading,
          emptyMessage: group.emptyMessage,
          items,
        },
      ];
    });
    const preferred =
      this.context.config.autoFocusedItemKey?.(
        groups,
        query,
        this.activeKey,
        this.context.std.host,
        this.context.inlineEditor,
      ) ?? this.activeKey;
    return {
      open,
      query,
      groups: visible,
      preferredId: visible.flatMap((group) =>
        group.items.filter(
          (item) => item.id === `${group.id}:${preferred}` && !item.disabled,
        ),
      )[0]?.id,
    };
  });

  constructor(private readonly context: LinkedDocContext) {
    this.input = context.inlineEditor.eventSource!;
    const rendered = context.inlineEditor.slots.renderComplete.subscribe(() =>
      queueMicrotask(this.refresh),
    );
    this.abort.signal.addEventListener(
      "abort",
      () => {
        rendered.unsubscribe();
        this.request?.abort();
        this.stopAnchor?.();
      },
      { once: true },
    );
    this.input.addEventListener(
      "compositionstart",
      () => {
        this.composing = true;
      },
      { signal: this.abort.signal },
    );
    this.input.addEventListener(
      "compositionend",
      () => {
        this.composing = false;
        queueMicrotask(this.refresh);
      },
      { signal: this.abort.signal },
    );
    createKeydownObserver({
      target: this.input,
      signal: this.abort.signal,
      onAbort: this.cancel,
      interceptor: (event, next) => {
        if (
          event.isComposing ||
          this.composing ||
          event.key === "Process" ||
          event.defaultPrevented
        )
          return;
        this.keys.forEach((listener) => listener(event));
        if (event.defaultPrevented) return;
        if (
          [
            "Escape",
            "ArrowLeft",
            "ArrowRight",
            "GroupNext",
            "GroupPrevious",
          ].includes(event.key)
        ) {
          if (event.key === "Escape") this.cancel();
          event.preventDefault();
          event.stopPropagation();
        } else {
          if (["Home", "End"].includes(event.key)) this.cancel();
          next();
        }
      },
    });
    this.refresh();
  }

  getSnapshot = () => this.presentation.value;
  subscribe = (listener: () => void) => this.presentation.subscribe(listener);
  subscribeKeys = (listener: (event: KeyboardEvent) => void) => {
    this.keys.add(listener);
    return () => {
      this.keys.delete(listener);
    };
  };
  private item(id: string) {
    const separator = id.indexOf(":");
    const group = this.state.peek().groups[Number(id.slice(0, separator))];
    return group && !resolveSignal(group.hidden)
      ? resolveSignal(group.items).find(
          (item) => item.key === id.slice(separator + 1),
        )
      : undefined;
  }
  activate = (id: string) => {
    this.activeKey = this.item(id)?.key ?? null;
  };

  private isCurrent() {
    const { inlineEditor, startRange, triggerKey, std } = this.context;
    const range = inlineEditor.getInlineRange();
    const selection = this.input.ownerDocument.getSelection();
    return (
      !this.abort.signal.aborted &&
      this.input.isConnected &&
      !std.store.readonly &&
      !!selection?.anchorNode &&
      !!inlineEditor.rootElement?.contains(selection.anchorNode) &&
      !!selection.focusNode &&
      inlineEditor.rootElement.contains(selection.focusNode) &&
      range?.length === 0 &&
      range.index >= startRange.index &&
      inlineEditor.yTextString.slice(
        startRange.index - triggerKey.length,
        startRange.index,
      ) === triggerKey
    );
  }

  refresh = () => {
    if (this.abort.signal.aborted || this.composing || this.pending) return;
    const { inlineEditor, startRange, config, std, triggerKey } = this.context;
    const query = getTextContentFromInlineRange(inlineEditor, startRange);
    if (!this.isCurrent() || query === null || query.startsWith(" ")) {
      this.cancel();
      return;
    }
    if (query === this.state.peek().query) return;
    this.request?.abort();
    this.state.value = { open: true, query, groups: [] };
    const request = (this.request = new AbortController());
    void Promise.resolve()
      .then(() =>
        request.signal.aborted
          ? []
          : config.getMenus(
              query,
              this.accept,
              std.host,
              inlineEditor,
              request.signal,
              triggerKey,
            ),
      )
      .then((groups) => {
        if (!request.signal.aborted && this.isCurrent())
          this.state.value = { open: true, query, groups };
      })
      .catch((error) => {
        if (!request.signal.aborted) {
          console.error(error);
          this.cancel();
        }
      });
  };

  /** Existing actions close before inserting; remove only this session's current query. */
  private accept = () => {
    if (!this.isCurrent()) return;
    const { std, inlineEditor, triggerKey, startRange } = this.context;
    const query = getTextContentFromInlineRange(inlineEditor, startRange);
    if (query === null) return;
    this.cancel();
    cleanSpecifiedTail(std, inlineEditor, triggerKey + query);
  };

  choose = (id: string) => {
    if (this.pending || !this.isCurrent()) {
      this.cancel();
      return;
    }
    // Queued pointer events must not execute results from the previous query.
    this.refresh();
    if (id.startsWith("more:")) {
      const group = this.state.peek().groups[Number(id.slice(5))];
      if (group && !resolveSignal(group.hidden))
        this.expanded.value = new Set([...this.expanded.peek(), group.name]);
      return;
    }
    const item = this.item(id);
    if (!item || item.disabled || this.abort.signal.aborted) return;
    this.pending = true;
    try {
      void Promise.resolve(item.action())
        .catch(console.error)
        .finally(() => {
          this.pending = false;
        });
    } catch (error) {
      this.pending = false;
      console.error(error);
    }
  };

  setAnchor = (anchor: HTMLElement | null) => {
    this.stopAnchor?.();
    if (!anchor || this.abort.signal.aborted) return;
    const { inlineEditor, startRange, triggerKey } = this.context;
    const getRect = () =>
      inlineEditor
        .toDomRange({
          index: startRange.index - triggerKey.length,
          length: triggerKey.length,
        })
        ?.getBoundingClientRect() ?? new DOMRect();
    this.stopAnchor = autoUpdate(
      { contextElement: this.input, getBoundingClientRect: getRect },
      anchor,
      () => {
        if (!this.isCurrent()) {
          this.cancel();
          return;
        }
        const rect = getRect();
        // Only caret geometry is local; Mantine owns dropdown sizing and placement.
        Object.assign(anchor.style, {
          position: "fixed",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${Math.max(1, rect.width)}px`,
          height: `${rect.height}px`,
          pointerEvents: "none",
        });
      },
      { animationFrame: true, elementResize: false },
    );
    if (this.abort.signal.aborted) this.stopAnchor();
  };

  cancel = () => {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.keys.clear();
    this.state.value = {
      open: false,
      query: this.state.peek().query,
      groups: [],
    };
    this.context.close();
  };
}
