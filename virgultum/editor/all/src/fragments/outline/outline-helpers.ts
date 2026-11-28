// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { getDocTitleByEditorHost } from "@virgultum/content/title";
import {
  NoteDisplayMode,
  type ParagraphBlockModel,
} from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { clamp } from "@virgultum/core/primitives/gfx";
import type { EditorHost } from "@virgultum/core/runtime";
import { DocModeProvider } from "@virgultum/core/services";
import type { BlockModel, Store } from "@virgultum/core/store";
import type { Viewport } from "@virgultum/core/types";
import {
  getOutlineHeadingBlocksFromDoc,
  getOutlineNotesFromStore,
  isOutlineHeadingBlock,
} from "@virgultum/core/utils";

export const outlineSettingsKey = "outlinePanelSettings";

export const defaultOutlinePanelLabels = {
  title: "Table of Contents",
  emptyPlaceholder: "Use headings to create a table of contents.",
  previewSettings: "Preview settings",
  visibilityAndSort: "Visibility and sort",
  hiddenContents: "Hidden contents",
  hiddenNoticeTitle: "Some contents hidden",
  hiddenNoticeBody: "Some contents are not visible on edgeless.",
  hiddenNoticeActionPrefix: "Click here or",
  hiddenNoticeActionSuffix: "to organize content.",
  modeBoth: "Both",
  modeEdgeless: "Edgeless",
  modePage: "Page",
  next: "Next",
  previous: "Previous",
};

export type OutlinePanelLabels = typeof defaultOutlinePanelLabels;

export type NoteCardEntity = {
  type: "toc-card";
  noteId: string;
};

export type NoteDropPayload = {
  noteId: string;
};

const ALL_NOTE_MODES: NoteDisplayMode[] = [
  NoteDisplayMode.DocAndEdgeless,
  NoteDisplayMode.DocOnly,
  NoteDisplayMode.EdgelessOnly,
];

const DOC_HEADING_MODES: NoteDisplayMode[] = [
  NoteDisplayMode.DocAndEdgeless,
  NoteDisplayMode.DocOnly,
];

const HIGHLIGHT_POLL_MS = 100;
const HIGHLIGHT_DURATION_MS = 1000;

export function getNotesFromStore(
  store: Store,
  modes: NoteDisplayMode[] = ALL_NOTE_MODES,
) {
  return getOutlineNotesFromStore(store, modes);
}

export function isHeadingBlock(
  block: BlockModel,
): block is ParagraphBlockModel {
  return isOutlineHeadingBlock(block);
}

export function getHeadingBlocksFromDoc(
  store: Store,
  modes: NoteDisplayMode[] = ALL_NOTE_MODES,
  ignoreEmpty = false,
) {
  return getOutlineHeadingBlocksFromDoc(store, modes, ignoreEmpty);
}

function isHeadingAboveViewportCenter(
  blockId: string,
  host: EditorHost,
): boolean {
  const blockElement = host.view.getBlock(blockId);
  if (!blockElement) return false;

  const viewportHeight = document.documentElement.clientHeight;
  const hostRect = (host.parentElement ?? host).getBoundingClientRect();
  const blockRect = blockElement.getBoundingClientRect();
  const visibleCenterY =
    clamp(hostRect.top, 0, viewportHeight) +
    Math.min(hostRect.height, viewportHeight) / 2;

  return (
    blockRect.top + blockRect.height / 2 < visibleCenterY + blockRect.height
  );
}

/**
 * Tracks which document heading is currently above the visible editor midpoint
 * during capture-phase scroll events.
 */
export function observeActiveHeadingDuringScroll(
  getEditor: () => EditorHost,
  onActiveHeadingChange: (headingId: string | null) => void,
): DisposableGroup {
  const syncActiveHeading = () => {
    const host = getEditor();
    const headings = getHeadingBlocksFromDoc(
      host.store,
      DOC_HEADING_MODES,
      true,
    );
    let currentId: string | null = host.store.root?.id ?? null;
    for (const heading of headings) {
      if (isHeadingAboveViewportCenter(heading.id, host)) {
        currentId = heading.id;
      }
    }
    onActiveHeadingChange(currentId);
  };

  syncActiveHeading();

  const disposables = new DisposableGroup();
  disposables.addFromEvent(window, "scroll", syncActiveHeading, true);
  return disposables;
}

type HighlightSession = {
  overlay: HTMLDivElement | null;
  hideTimer: ReturnType<typeof setTimeout> | null;
  settleTimer: ReturnType<typeof setInterval> | null;
};

const activeHighlight: HighlightSession = {
  overlay: null,
  hideTimer: null,
  settleTimer: null,
};

function clearActiveHighlightOverlay(): void {
  if (activeHighlight.hideTimer !== null) {
    clearTimeout(activeHighlight.hideTimer);
    activeHighlight.hideTimer = null;
  }
  activeHighlight.overlay?.remove();
  activeHighlight.overlay = null;
}

function showBlockHighlight(host: EditorHost, blockId: string): () => void {
  if (host.store.root?.id === blockId) return () => {};

  const pageRoot = host.querySelector<HTMLElement & { viewport?: Viewport }>(
    "myoxus-page-root",
  );
  if (!pageRoot?.viewport) return () => {};

  const blockElement = host.view.getBlock(blockId);
  if (!blockElement) return () => {};

  const { top, left, width, height } = blockElement.getBoundingClientRect();
  const {
    top: rootTop,
    left: rootLeft,
    scrollTop,
    scrollLeft,
  } = pageRoot.viewport;

  if (!activeHighlight.overlay || !activeHighlight.overlay.isConnected) {
    activeHighlight.overlay?.remove();
    const overlay = host.ownerDocument.createElement("div");
    pageRoot.append(overlay);
    activeHighlight.overlay = overlay;
  }

  Object.assign(activeHighlight.overlay.style, {
    position: "absolute",
    top: `${top - rootTop + scrollTop}px`,
    left: `${left - rootLeft + scrollLeft}px`,
    width: `${width}px`,
    height: `${height}px`,
    background: "var(--myoxus-hover-color)",
    borderRadius: "4px",
    pointerEvents: "none",
    display: "block",
  });

  if (activeHighlight.hideTimer !== null) {
    clearTimeout(activeHighlight.hideTimer);
  }
  activeHighlight.hideTimer = setTimeout(() => {
    if (activeHighlight.overlay) {
      activeHighlight.overlay.style.display = "none";
    }
    activeHighlight.hideTimer = null;
  }, HIGHLIGHT_DURATION_MS);

  return clearActiveHighlightOverlay;
}

function scrollPageTargetIntoView(host: EditorHost, blockId: string): void {
  if (host.std.get(DocModeProvider).getEditorMode() === "edgeless") return;

  if (host.store.root?.id === blockId) {
    getDocTitleByEditorHost(host)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    return;
  }

  host.view.getBlock(blockId)?.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
}

/**
 * Smoothly scrolls a Page-mode block into view and briefly highlights its
 * rendered box once the scroll position settles.
 *
 * @returns Cleanup callback that removes any active highlight overlay.
 */
export function scrollToBlockWithHighlight(
  host: EditorHost,
  blockId: string,
  timeoutMs = 3000,
): Promise<() => void> {
  scrollPageTargetIntoView(host, blockId);

  if (activeHighlight.settleTimer !== null) {
    clearInterval(activeHighlight.settleTimer);
    activeHighlight.settleTimer = null;
  }

  return new Promise((resolve) => {
    let elapsedMs = 0;
    let previousTop: number | null = null;

    const timer = setInterval(() => {
      const blockElement = host.view.getBlock(blockId);
      if (!blockElement || elapsedMs > timeoutMs) {
        clearInterval(timer);
        if (activeHighlight.settleTimer === timer) {
          activeHighlight.settleTimer = null;
        }
        resolve(() => {});
        return;
      }

      const currentTop = blockElement.getBoundingClientRect().top;
      if (previousTop === null || currentTop !== previousTop) {
        previousTop = currentTop;
        elapsedMs += HIGHLIGHT_POLL_MS;
        return;
      }

      clearInterval(timer);
      if (activeHighlight.settleTimer === timer) {
        activeHighlight.settleTimer = null;
      }
      resolve(showBlockHighlight(host, blockId));
    }, HIGHLIGHT_POLL_MS);

    activeHighlight.settleTimer = timer;
  });
}
