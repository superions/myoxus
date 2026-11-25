// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { LiveData } from "@myoxus/infra";
import { computed, signal } from "@preact/signals-core";
import { NoteDisplayMode } from "@virgultum/core/models";
import type {
  EditorOutlineControls,
  EditorOutlineEntry,
  EditorOutlineState,
} from "@virgultum/core/services";
import type { Store } from "@virgultum/core/store";
import {
  describeOutlineBlockFromStore,
  getOutlineHeadingBlocksFromDoc,
  OUTLINE_SETTINGS_KEY,
  type OutlineReferenceResolution,
} from "@virgultum/core/utils";

const PAGE_NOTE_MODES = [
  NoteDisplayMode.DocAndEdgeless,
  NoteDisplayMode.DocOnly,
] as const;

function escapeSelectorValue(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

export function findPageBlockElement(
  origin: HTMLElement | null,
  blockId: string,
  rootId?: string | null,
): HTMLElement | null {
  const scope: ParentNode | null =
    origin ?? (typeof document !== "undefined" ? document : null);
  if (!scope) return null;
  const escaped = escapeSelectorValue(blockId);
  if (rootId && blockId === rootId) {
    return (
      scope.querySelector<HTMLElement>(
        `[data-page-text="${escaped}"], [data-block-id="${escaped}"], [data-testid="doc-title-input"], doc-title`,
      ) ?? null
    );
  }
  return (
    scope.querySelector<HTMLElement>(
      `[data-block-id="${escaped}"], [data-page-text="${escaped}"]`,
    ) ?? null
  );
}

export function scrollToPageBlockWithHighlight(
  origin: HTMLElement | null,
  blockId: string,
  rootId?: string | null,
): () => void {
  const target = findPageBlockElement(origin, blockId, rootId);
  if (!target) return () => {};

  const isRoot = Boolean(rootId && blockId === rootId);
  target.scrollIntoView({
    behavior: "smooth",
    block: isRoot ? "start" : "center",
  });

  if (isRoot) return () => {};

  const prevBg = target.style.backgroundColor;
  const prevRadius = target.style.borderRadius;
  const prevTransition = target.style.transition;

  target.style.transition = "background-color 180ms ease";
  target.style.backgroundColor = "var(--myoxus-hover-color)";
  target.style.borderRadius = "var(--mantine-radius-sm)";

  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timer);
    target.style.backgroundColor = prevBg;
    target.style.borderRadius = prevRadius;
    target.style.transition = prevTransition;
  };
  const timer = setTimeout(clear, 1000);
  return clear;
}

export function computeActivePageHeading(
  store: Store,
  origin: HTMLElement | null,
): string | null {
  const headings = getOutlineHeadingBlocksFromDoc(store, PAGE_NOTE_MODES, true);
  let activeId = store.root?.id ?? null;
  if (!headings.length || typeof window === "undefined") return activeId;

  const viewportTop = origin
    ? Math.max(
        0,
        Math.min(origin.getBoundingClientRect().top, window.innerHeight),
      )
    : 0;
  const viewportHeight = origin
    ? Math.min(origin.getBoundingClientRect().height, window.innerHeight)
    : window.innerHeight;
  const center = viewportTop + viewportHeight / 2;

  for (const heading of headings) {
    const el = findPageBlockElement(origin, heading.id, store.root?.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const blockCenter = rect.top + rect.height / 2;
    if (blockCenter < center + rect.height) {
      activeId = heading.id;
    }
  }
  return activeId;
}

export interface PageOutlineControllerOptions {
  store: Store;
  origin$: LiveData<HTMLElement | null>;
  labels: EditorOutlineState["labels"];
  resolveReference: (
    pageId: string,
    workspaceId?: string,
  ) => OutlineReferenceResolution;
  resolveMessage: (key: string, fallback: string) => string;
  compactWindowRadius?: number;
  hideHeader?: boolean;
}

/**
 * Pure-Store Page outline controller for the document sidebar.
 * Reads heading hierarchy directly from Yjs/Store without requiring EditorHost.
 */
export function createPageOutlineController(
  options: PageOutlineControllerOptions,
): EditorOutlineControls {
  const {
    store,
    origin$,
    labels,
    resolveReference,
    resolveMessage,
    compactWindowRadius = 4,
    hideHeader = true,
  } = options;

  const active = signal<string | null>(null);
  const center = signal<number | null>(null);
  const revision = signal(0);
  const icons = signal(false);

  try {
    const stored = localStorage.getItem(OUTLINE_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as { showIcons?: unknown };
      icons.value = parsed.showIcons === true;
    }
  } catch {
    /* Ignore malformed personal outline settings. */
  }

  let subscribers = 0;
  let cleanups: (() => void)[] = [];
  let clearHighlight = () => {};
  let lockTimer: ReturnType<typeof setTimeout> | null = null;
  let locked = false;

  const project = (): EditorOutlineState => {
    void revision.value;
    const compact = compactWindowRadius > 0;
    const headings = getOutlineHeadingBlocksFromDoc(
      store,
      PAGE_NOTE_MODES,
      true,
    );
    const activeIndex = Math.max(
      0,
      headings.findIndex((block) => block.id === active.value),
    );
    const windowCenter = Math.min(
      Math.max(center.value ?? activeIndex, 0),
      Math.max(0, headings.length - 1),
    );
    const start = compact ? Math.max(0, windowCenter - compactWindowRadius) : 0;
    const end = compact
      ? Math.min(headings.length, windowCenter + compactWindowRadius + 1)
      : headings.length;

    const entries: EditorOutlineEntry[] = headings.slice(start, end).flatMap(
      (block) =>
        describeOutlineBlockFromStore(block, {
          resolveReference,
          resolveMessage,
        }) ?? [],
    );

    return {
      labels,
      hideHeader,
      activeId: active.value,
      showIcons: icons.value,
      sorting: false,
      edgeless: false,
      readonly: store.readonly,
      notice: false,
      entries,
      title:
        !compact && headings.length && store.root
          ? describeOutlineBlockFromStore(store.root, {
              resolveReference,
              resolveMessage,
            })
          : undefined,
      notes: [],
      previous: compact && start > 0 ? windowCenter - 1 : undefined,
      next: compact && end < headings.length ? windowCenter + 1 : undefined,
      drop: undefined,
    };
  };

  const snapshot = computed(() => project());

  const updateActive = () => {
    if (locked) return;
    const nextId = computeActivePageHeading(store, origin$.value);
    if (active.value !== nextId) {
      center.value = null;
      active.value = nextId;
    }
  };

  const attach = () => {
    const bump = () => {
      revision.value++;
      updateActive();
    };
    const blocks = store.slots.blockUpdated.subscribe(bump);
    const docMeta = store.workspace.meta.docMetaUpdated.subscribe(bump);
    const originSub = origin$.subscribe(() => updateActive());
    store.spaceDoc.on("afterTransaction", bump);
    const hasWindow = typeof window !== "undefined";
    let scrollRaf: number | null = null;
    const scheduleScrollUpdate = () => {
      if (scrollRaf !== null) return;
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = null;
        updateActive();
      });
    };
    if (hasWindow) {
      window.addEventListener("scroll", scheduleScrollUpdate, true);
    }
    updateActive();

    cleanups = [
      () => blocks.unsubscribe(),
      () => docMeta.unsubscribe(),
      () => originSub.unsubscribe(),
      () => store.spaceDoc.off("afterTransaction", bump),
      ...(hasWindow
        ? [
            () => {
              if (scrollRaf !== null) {
                window.cancelAnimationFrame(scrollRaf);
                scrollRaf = null;
              }
              window.removeEventListener("scroll", scheduleScrollUpdate, true);
            },
          ]
        : []),
    ];
  };

  return {
    getSnapshot: () => snapshot.value,
    subscribe: (listener) => {
      if (subscribers++ === 0) attach();
      const stop = snapshot.subscribe(listener);
      return () => {
        stop();
        if (--subscribers === 0) {
          cleanups.splice(0).forEach((cleanup) => cleanup());
          clearHighlight();
          clearHighlight = () => {};
          if (lockTimer) {
            clearTimeout(lockTimer);
            lockTimer = null;
          }
          locked = false;
        }
      };
    },
    navigate: (id) => {
      if (!store.getBlock(id)) return;
      locked = true;
      if (lockTimer) clearTimeout(lockTimer);
      active.value = id;
      center.value = null;
      clearHighlight();
      clearHighlight = scrollToPageBlockWithHighlight(
        origin$.value,
        id,
        store.root?.id,
      );
      lockTimer = setTimeout(() => {
        locked = false;
        lockTimer = null;
      }, 600);
    },
    window: (index) => {
      center.value = index;
    },
    toggleIcons: () => {
      icons.value = !icons.value;
      try {
        const prev = JSON.parse(
          localStorage.getItem(OUTLINE_SETTINGS_KEY) || "{}",
        ) as Record<string, unknown>;
        localStorage.setItem(
          OUTLINE_SETTINGS_KEY,
          JSON.stringify({ ...prev, showIcons: icons.value }),
        );
      } catch {
        /* Ignore storage errors. */
      }
    },
    toggleSorting: () => {},
    dismissNotice: () => {},
    select: () => {},
    fit: () => {},
    changeMode: () => {},
    history: (redo) => {
      if (store.readonly) return;
      if (redo) store.redo();
      else store.undo();
    },
    bindNote: () => () => {},
    bindScroll: () => {},
  };
}
