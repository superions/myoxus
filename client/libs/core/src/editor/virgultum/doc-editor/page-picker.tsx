// SPDX-License-Identifier: AGPL-3.0-or-later
import { useService } from "@myoxus/infra";
import { computed, signal } from "@preact/signals-core";
import { autoUpdate } from "@floating-ui/dom";
import type {
  EditorDocumentPickerControls,
  EditorDocumentPickerState,
} from "@virgultum/core/services";
import type { LinkedMenuGroup } from "@virgultum/editor/widgets/linked-doc";
import { useLayoutEffect, useState } from "react";
import { AtMenuConfigService } from "../../../modules/at-menu-config/services";
import { EditorDocumentPicker } from "../../view-extensions/editor-view/editor-chrome/document-picker";
import type { PageInteraction, PickerStart } from "./page-interaction";

export default function PagePicker({
  owner,
  start,
  root,
  close,
}: {
  owner: PageInteraction;
  start: PickerStart;
  root: HTMLElement;
  close: () => void;
}) {
  const config = useService(AtMenuConfigService);
  const [controls, setControls] = useState<EditorDocumentPickerControls>();
  useLayoutEffect(() => {
    const input = root.querySelector<HTMLElement>("[data-page-body]")!;
    const stop = new AbortController();
    const source = signal<{ query: string; groups: LinkedMenuGroup[] }>({
      query: "",
      groups: [],
    });
    const expanded = signal<number[]>([]);
    const keys = new Set<(e: KeyboardEvent) => void>();
    let request: AbortController | undefined,
      releaseAnchor: (() => void) | undefined;
    let selected: string | null = null,
      query: string | undefined,
      pending = false,
      composing = false;
    const rect = () =>
      document.getSelection()?.rangeCount
        ? document.getSelection()!.getRangeAt(0).getBoundingClientRect()
        : input.getBoundingClientRect();
    const resolve = <T,>(v: T | { readonly value: T }): T =>
      v !== null && typeof v === "object" && "value" in v ? v.value : (v as T);
    const snapshot = computed<EditorDocumentPickerState>(() => {
      const { groups, query } = source.value;
      const visible = groups.flatMap((g, index) => {
        if (resolve(g.hidden)) return [];
        const all = resolve(g.items),
          loading = !!resolve(g.loading),
          max = expanded.value.includes(index)
            ? all.length
            : (g.maxDisplay ?? all.length);
        if (!all.length && !loading && !g.emptyMessage) return [];
        const items = all.slice(0, max).map(({ key, action: _, ...item }) => ({
          ...item,
          id: `${index}:${key}`,
        }));
        if (all.length > max)
          items.push({
            id: `more:${index}`,
            name: resolve(g.overflowText) ?? "…",
            icon: "MoreHorizontalIcon",
          });
        return [
          {
            id: String(index),
            name: g.name,
            loading,
            emptyMessage: g.emptyMessage,
            items,
          },
        ];
      });
      const preferred = config.autoFocusedItemKey(groups, query) ?? selected;
      return {
        open: true,
        query,
        groups: visible,
        preferredId: visible
          .flatMap((g) => g.items)
          .find((i) => i.id.endsWith(`:${preferred}`))?.id,
      };
    });
    const cancel = () => {
      if (!stop.signal.aborted) {
        stop.abort();
        close();
      }
    };
    const refresh = () => {
      if (stop.signal.aborted || composing || owner.isComposing || pending)
        return;
      const current = owner.pickerRange(start);
      if (!current || current.query.startsWith(" ")) {
        cancel();
        return;
      }
      if (query === current.query) return;
      query = current.query;
      request?.abort();
      request = new AbortController();
      expanded.value = [];
      const captured = query;
      let insert: ReturnType<PageInteraction["consumePicker"]>;
      const accept = () => {
        if (stop.signal.aborted) return;
        insert = owner.consumePicker(start, captured);
        cancel();
      };
      const groups = config.pageGroups(
        captured,
        accept,
        {
          anchorRect: rect,
          insertDocument: (id) => insert?.(id),
          insertMember: (id) => {
            accept();
            return insert?.(id, "mention");
          },
        },
        request.signal,
        start.trigger,
      );
      source.value = { query: captured, groups };
    };
    const later = () => queueMicrotask(refresh);
    const opts = { signal: stop.signal };
    input.addEventListener(
      "keydown",
      (e) => {
        if (e.isComposing || composing) return;
        keys.forEach((k) => k(e));
        if (e.defaultPrevented) e.stopImmediatePropagation();
        else if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancel();
        }
      },
      { ...opts, capture: true },
    );
    input.addEventListener("beforeinput", later, opts);
    input.addEventListener(
      "compositionstart",
      () => {
        composing = true;
      },
      opts,
    );
    input.addEventListener(
      "compositionend",
      () => {
        composing = false;
        later();
      },
      opts,
    );
    document.addEventListener("selectionchange", later, opts);
    const control: EditorDocumentPickerControls = {
      input,
      getSnapshot: () => snapshot.value,
      subscribe: (f) => snapshot.subscribe(f),
      subscribeKeys: (f) => {
        keys.add(f);
        return () => {
          keys.delete(f);
        };
      },
      activate: (id) => {
        selected = id.slice(id.indexOf(":") + 1);
      },
      choose: (id) => {
        if (stop.signal.aborted || pending) return;
        refresh();
        if (stop.signal.aborted) return;
        const [group, ...key] = id.split(":");
        if (group === "more") {
          expanded.value = [...expanded.value, Number(key[0])];
          return;
        }
        const g = source.value.groups[Number(group)];
        if (!g || resolve(g.hidden)) return;
        const item = resolve(g.items).find((i) => i.key === key.join(":"));
        if (!item || item.disabled) return;
        pending = true;
        void Promise.resolve(item.action())
          .catch(console.error)
          .finally(() => {
            pending = false;
          });
      },
      cancel,
      setAnchor(el) {
        releaseAnchor?.();
        if (!el || stop.signal.aborted) return;
        releaseAnchor = autoUpdate(
          { contextElement: input, getBoundingClientRect: rect },
          el,
          () => {
            const r = rect();
            Object.assign(el.style, {
              position: "fixed",
              left: `${r.left}px`,
              top: `${r.top}px`,
              width: "1px",
              height: `${r.height}px`,
              pointerEvents: "none",
            });
          },
        );
      },
    };
    refresh();
    if (!stop.signal.aborted) setControls(control);
    return () => {
      stop.abort();
      request?.abort();
      releaseAnchor?.();
      keys.clear();
    };
  }, [owner, start, root, close, config]);
  return controls ? <EditorDocumentPicker controls={controls} /> : null;
}
