// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  mountDocRemotePresenceOverlay,
  type DocRemotePeerSnapshot,
  type OverlayRect,
} from "@virgultum/core/services";
import type { Store } from "@virgultum/core/store";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { readPageRange, resolveDomPoint } from "./plain-page-input";
import type { PageLine } from "./plain-page-model";

const SELECTION_PUBLISH_THROTTLE_MS = 50;

type RemoteTextRangePoint = {
  blockId: string;
  index: number;
  length: number;
};

type RemoteTextSelectionJson = {
  type: "text";
  from: RemoteTextRangePoint;
  to: RemoteTextRangePoint | null;
  reverse?: boolean;
};

type RemoteBlockSelectionJson = {
  type: "block";
  blockId: string;
};

type RemoteSelectionJson = RemoteTextSelectionJson | RemoteBlockSelectionJson;

function isPoint(value: unknown): value is RemoteTextRangePoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RemoteTextRangePoint).blockId === "string" &&
    typeof (value as RemoteTextRangePoint).index === "number" &&
    typeof (value as RemoteTextRangePoint).length === "number"
  );
}

function parseRemoteSelection(raw: unknown): RemoteSelectionJson | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.type === "text" &&
    isPoint(candidate.from) &&
    (candidate.to === null ||
      candidate.to === undefined ||
      isPoint(candidate.to))
  ) {
    return {
      type: "text",
      from: candidate.from,
      to: candidate.to ?? null,
      reverse: Boolean(candidate.reverse),
    };
  }
  if (candidate.type === "block" && typeof candidate.blockId === "string") {
    return { type: "block", blockId: candidate.blockId };
  }
  return null;
}

function toOverlayRect(rect: DOMRect, hostRect: DOMRect): OverlayRect {
  return {
    top: rect.top - hostRect.top,
    left: rect.left - hostRect.left,
    width: rect.width,
    height: rect.height,
  };
}

function measureTextFragments(
  body: HTMLElement,
  hostRect: DOMRect,
  blockId: string,
) {
  const field = body.querySelector<HTMLElement>(
    `[data-page-text="${CSS.escape(blockId)}"]`,
  );
  if (!field) {
    return { rects: [], fieldRect: null, viewportLeft: hostRect.left };
  }
  const fieldBounds = field.getBoundingClientRect();
  const doc = body.ownerDocument;
  const rawRects: DOMRect[] = [];
  const walker = doc.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent || node.textContent.length === 0) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.height > 0) rawRects.push(r);
    }
  }
  return {
    rects: rawRects.map((r) => toOverlayRect(r, hostRect)),
    fieldRect:
      fieldBounds.height > 0 ? toOverlayRect(fieldBounds, hostRect) : null,
    viewportLeft:
      rawRects.length > 0
        ? Math.min(...rawRects.map((r) => r.left))
        : fieldBounds.left,
  };
}

function measureCaretRect(
  body: HTMLElement,
  blockId: string,
  offset: number,
): DOMRect | null {
  const doc = body.ownerDocument;
  const field = body.querySelector<HTMLElement>(
    `[data-page-text="${CSS.escape(blockId)}"]`,
  );
  if (!field) return null;
  const pt = resolveDomPoint(body, { id: blockId, offset });
  if (pt) {
    try {
      const range = doc.createRange();
      range.setStart(pt[0], pt[1]);
      range.collapse(true);
      const rects = [...range.getClientRects()].filter((r) => r.height > 0);
      if (rects.length > 0) return rects[rects.length - 1];
    } catch {
      /* Fall back to field rect below. */
    }
  }
  const rect = field.getBoundingClientRect();
  if (rect.height <= 0) return null;
  const style = doc.defaultView?.getComputedStyle(field);
  const lineHeight =
    Number.parseFloat(style?.lineHeight ?? "") ||
    Number.parseFloat(style?.fontSize ?? "") * 1.4 ||
    22;
  return new DOMRect(rect.left, rect.top, 0, Math.min(rect.height, lineHeight));
}

function measureTextSelectionRects(
  body: HTMLElement,
  selection: RemoteTextSelectionJson,
): DOMRect[] {
  const doc = body.ownerDocument;
  const from = selection.from;
  const to = selection.to;
  if (!to || to.blockId === from.blockId) {
    if (from.length <= 0) return [];
    const start = resolveDomPoint(body, {
      id: from.blockId,
      offset: from.index,
    });
    const end = resolveDomPoint(body, {
      id: from.blockId,
      offset: from.index + from.length,
    });
    if (!start || !end) return [];
    try {
      const range = doc.createRange();
      range.setStart(start[0], start[1]);
      range.setEnd(end[0], end[1]);
      return [...range.getClientRects()].filter(
        (r) => r.width > 0 && r.height > 0,
      );
    } catch {
      return [];
    }
  }
  const start = resolveDomPoint(body, { id: from.blockId, offset: from.index });
  const end = resolveDomPoint(body, {
    id: to.blockId,
    offset: to.index + to.length,
  });
  if (!start || !end) return [];
  try {
    const range = doc.createRange();
    if (
      start[0].compareDocumentPosition(end[0]) &
      Node.DOCUMENT_POSITION_PRECEDING
    ) {
      range.setStart(end[0], end[1]);
      range.setEnd(start[0], start[1]);
    } else {
      range.setStart(start[0], start[1]);
      range.setEnd(end[0], end[1]);
    }
    return [...range.getClientRects()].filter(
      (r) => r.width > 0 && r.height > 0,
    );
  } catch {
    return [];
  }
}

function serializeLocalSelection(
  page: Store,
  lines: PageLine[],
  body: HTMLElement,
): RemoteTextSelectionJson[] {
  const range = readPageRange(body);
  if (!range) return [];
  const rootId = page.root?.id;
  if (range.anchor.id === rootId || range.focus.id === rootId) return [];
  const anchorIndex = lines.findIndex((l) => l.model.id === range.anchor.id);
  const focusIndex = lines.findIndex((l) => l.model.id === range.focus.id);
  if (anchorIndex < 0 || focusIndex < 0) return [];
  const reverse =
    anchorIndex > focusIndex ||
    (anchorIndex === focusIndex && range.anchor.offset > range.focus.offset);
  const start = reverse ? range.focus : range.anchor;
  const end = reverse ? range.anchor : range.focus;
  if (start.id === end.id) {
    return [
      {
        type: "text",
        from: {
          blockId: start.id,
          index: start.offset,
          length: Math.max(0, end.offset - start.offset),
        },
        to: null,
        reverse,
      },
    ];
  }
  const startLine = lines[Math.min(anchorIndex, focusIndex)];
  return [
    {
      type: "text",
      from: {
        blockId: start.id,
        index: start.offset,
        length: Math.max(0, startLine.text.length - start.offset),
      },
      to: {
        blockId: end.id,
        index: 0,
        length: end.offset,
      },
      reverse,
    },
  ];
}

/**
 * Thin native-Page DOM adapter for the shared `mountDocRemotePresenceOverlay`
 * engine: publishes local DOM selections into `selectionV2` and supplies
 * `[data-page-text]` geometry without pulling in `@virgultum/editor`.
 */
export function PageRemotePresence({
  page,
  bodyRef,
  readonly,
  lines,
  epoch,
}: {
  page: Store;
  bodyRef: RefObject<HTMLDivElement | null>;
  readonly: boolean;
  lines: PageLine[];
  epoch: number;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef({ lines, readonly });
  latestRef.current = { lines, readonly };
  const repaintRef = useRef<() => void>(() => {});

  useEffect(() => {
    const overlayEl = overlayRef.current;
    const body = bodyRef.current;
    if (!overlayEl || !body) return;

    const doc = overlayEl.ownerDocument;
    const awarenessStore = page.awarenessStore;
    const selectionKey = `${page.id}:native-page`;
    let currentHostRect = new DOMRect();

    const handle = mountDocRemotePresenceOverlay(overlayEl, page, {
      onBeforePaint() {
        const currentOverlay = overlayRef.current;
        if (!bodyRef.current || !currentOverlay) return false;
        currentHostRect = currentOverlay.getBoundingClientRect();
        return currentHostRect.width > 0 || currentHostRect.height > 0;
      },
      getPeers(): DocRemotePeerSnapshot[] {
        const currentBody = bodyRef.current;
        if (!currentBody) return [];
        const states = awarenessStore.getStates();
        const localId = awarenessStore.awareness.clientID;
        const peers: DocRemotePeerSnapshot[] = [];

        for (const [clientId, state] of states) {
          if (clientId === localId) continue;
          const rawSelections = Object.entries(state.selectionV2 ?? {})
            .filter(([key]) => key.startsWith(`${page.id}:`))
            .flatMap(([, items]) => (Array.isArray(items) ? items : []));
          if (rawSelections.length === 0) continue;

          const parsed = rawSelections
            .map(parseRemoteSelection)
            .filter((item): item is RemoteSelectionJson => item !== null);
          if (parsed.length === 0) continue;

          const userName =
            typeof state.user?.name === "string" && state.user.name.trim()
              ? state.user.name.trim()
              : "";
          const textSel = parsed.find(
            (item): item is RemoteTextSelectionJson => item.type === "text",
          );
          const blockSels = parsed.filter(
            (item): item is RemoteBlockSelectionJson => item.type === "block",
          );

          const selectionRects: OverlayRect[] = [];
          const blockOutlineRects: OverlayRect[] = [];
          let caretRect: OverlayRect | null = null;
          let caretBlockId: string | null = null;

          if (textSel) {
            for (const r of measureTextSelectionRects(currentBody, textSel)) {
              selectionRects.push(toOverlayRect(r, currentHostRect));
            }
            const focusPoint = textSel.to
              ? textSel.reverse
                ? { blockId: textSel.from.blockId, offset: textSel.from.index }
                : {
                    blockId: textSel.to.blockId,
                    offset: textSel.to.index + textSel.to.length,
                  }
              : {
                  blockId: textSel.from.blockId,
                  offset: textSel.reverse
                    ? textSel.from.index
                    : textSel.from.index + textSel.from.length,
                };
            caretBlockId = focusPoint.blockId;
            const measured = measureCaretRect(
              currentBody,
              focusPoint.blockId,
              focusPoint.offset,
            );
            if (measured) {
              caretRect = toOverlayRect(measured, currentHostRect);
            }
          } else if (blockSels.length > 0) {
            for (const blockSel of blockSels) {
              const blockEl = currentBody.querySelector<HTMLElement>(
                `[data-block-id="${CSS.escape(blockSel.blockId)}"]`,
              );
              if (!blockEl) continue;
              const r = blockEl.getBoundingClientRect();
              blockOutlineRects.push(toOverlayRect(r, currentHostRect));
              caretBlockId = blockSel.blockId;
              caretRect = toOverlayRect(
                new DOMRect(r.right, r.top, 0, Math.min(r.height, 26)),
                currentHostRect,
              );
            }
          }

          peers.push({
            clientId,
            userName,
            selectionRects,
            blockOutlineRects,
            caretRect,
            caretBlockId,
          });
        }
        return peers;
      },
      measureRecentText(blockId) {
        const currentBody = bodyRef.current;
        if (!currentBody) {
          return {
            rects: [],
            fieldRect: null,
            viewportLeft: currentHostRect.left,
          };
        }
        return measureTextFragments(currentBody, currentHostRect, blockId);
      },
    });
    repaintRef.current = handle.schedulePaint;

    let lastSerialized = "";
    let publishTimer: ReturnType<typeof setTimeout> | null = null;
    const publishLocalSelection = () => {
      if (publishTimer !== null) return;
      publishTimer = setTimeout(() => {
        publishTimer = null;
        const currentBody = bodyRef.current;
        const next =
          latestRef.current.readonly || !currentBody
            ? []
            : serializeLocalSelection(
                page,
                latestRef.current.lines,
                currentBody,
              );
        const serialized = JSON.stringify(next);
        if (serialized === lastSerialized) return;
        lastSerialized = serialized;
        awarenessStore.setLocalSelection(selectionKey, next);
      }, SELECTION_PUBLISH_THROTTLE_MS);
    };

    const onWindowBlur = () => {
      if (lastSerialized !== "[]") {
        lastSerialized = "[]";
        awarenessStore.setLocalSelection(selectionKey, []);
      }
    };
    const onResize = () => handle.schedulePaint();

    doc.addEventListener("selectionchange", publishLocalSelection);
    doc.defaultView?.addEventListener("blur", onWindowBlur);
    doc.defaultView?.addEventListener("resize", onResize);

    const resizeObserver = new ResizeObserver(() => handle.schedulePaint());
    resizeObserver.observe(body);
    resizeObserver.observe(overlayEl);

    return () => {
      repaintRef.current = () => {};
      if (publishTimer !== null) clearTimeout(publishTimer);
      doc.removeEventListener("selectionchange", publishLocalSelection);
      doc.defaultView?.removeEventListener("blur", onWindowBlur);
      doc.defaultView?.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
      awarenessStore.setLocalSelection(selectionKey, []);
      handle.dispose();
    };
  }, [page, bodyRef]);

  useLayoutEffect(() => {
    if (readonly) {
      page.awarenessStore.setLocalSelection(`${page.id}:native-page`, []);
    }
    repaintRef.current();
  }, [page, readonly, lines, epoch]);

  return (
    <div ref={overlayRef} data-plain-remote-overlay="" aria-hidden="true" />
  );
}
