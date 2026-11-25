// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { type Store, Text } from "../store/index";

const SESSION_COLOR_KEY = "virgultum:remote-color";
export const RECENT_TEXT_CUE_TTL_MS = 15_000;

export const REMOTE_PEER_PALETTE = [
  "var(--myoxus-multi-players-purple)",
  "var(--myoxus-multi-players-magenta)",
  "var(--myoxus-multi-players-red)",
  "var(--myoxus-multi-players-orange)",
  "var(--myoxus-multi-players-green)",
  "var(--myoxus-multi-players-blue)",
  "var(--myoxus-text-highlight-foreground-yellow)",
  "var(--myoxus-text-highlight-foreground-teal)",
] as const;

export function vividRemoteColor(color: string): string {
  if (color === "var(--myoxus-multi-players-grey)") {
    return "var(--myoxus-text-highlight-foreground-teal)";
  }
  if (color === "var(--myoxus-multi-players-brown)") {
    return "var(--myoxus-text-highlight-foreground-yellow)";
  }
  return color;
}

/** Match a peer's presence hue to the editor's text-marker highlight token. */
export function textMarkerColor(color: string): string {
  if (color === "var(--myoxus-multi-players-magenta)") return color;
  const tone = color.match(
    /^var\(--myoxus-(?:multi-players|text-highlight-foreground)-(purple|red|orange|green|blue|yellow|teal)\)$/,
  )?.[1];
  return tone ? `var(--myoxus-text-highlight-foreground-${tone})` : color;
}

function readSavedSessionColor(): string | null {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(SESSION_COLOR_KEY) ?? "null",
    );
    return typeof saved === "string" && saved ? vividRemoteColor(saved) : null;
  } catch {
    return null;
  }
}

function persistSessionColor(color: string): void {
  try {
    sessionStorage.setItem(SESSION_COLOR_KEY, JSON.stringify(color));
  } catch {
    /* Session storage may be unavailable in restricted contexts. */
  }
}

function chooseDistinctPeerColor(
  usedColors: ReadonlySet<string>,
  clientId: number,
): string {
  const free = REMOTE_PEER_PALETTE.filter(
    (candidate) => !usedColors.has(candidate),
  );
  if (free.length > 0) {
    return free[Math.abs(clientId) % free.length];
  }
  return REMOTE_PEER_PALETTE[Math.abs(clientId) % REMOTE_PEER_PALETTE.length];
}

/**
 * Shared awareness color manager for all Myoxus collaborative surfaces
 * (native Page, RegisteredEditor, Canvas Note, and Canvas Edgeless).
 *
 * Uses a deterministic lower-clientID tie-breaker so concurrent peers never
 * stay on the same color even when joining a document simultaneously.
 */
export class RemoteColorManager {
  private color: string;

  constructor(private readonly awarenessStore: Store["awarenessStore"]) {
    const localId = awarenessStore.awareness.clientID;
    const peerColors = this.collectPeerColors();
    const saved = readSavedSessionColor();
    this.color =
      saved && !peerColors.has(saved)
        ? saved
        : chooseDistinctPeerColor(peerColors, localId);
    if (saved !== this.color) {
      persistSessionColor(this.color);
    }
    awarenessStore.awareness.setLocalStateField("color", this.color);
  }

  private collectPeerColors(): Set<string> {
    const used = new Set<string>();
    const localId = this.awarenessStore.awareness.clientID;
    for (const [clientId, state] of this.awarenessStore.getStates()) {
      if (clientId === localId) continue;
      if (typeof state?.color === "string" && state.color) {
        used.add(vividRemoteColor(state.color));
      }
    }
    return used;
  }

  /**
   * Re-checks connected peers and switches the local color if a peer with a
   * lower Yjs clientID currently claims the same hue.
   */
  resolveCollisions(): boolean {
    const localId = this.awarenessStore.awareness.clientID;
    const peerColors = new Set<string>();
    let lowerPeerCollision = false;
    for (const [clientId, state] of this.awarenessStore.getStates()) {
      if (clientId === localId) continue;
      if (typeof state?.color === "string" && state.color) {
        const normalized = vividRemoteColor(state.color);
        peerColors.add(normalized);
        if (clientId < localId && normalized === this.color) {
          lowerPeerCollision = true;
        }
      }
    }
    if (!lowerPeerCollision) return false;
    const nextColor = chooseDistinctPeerColor(peerColors, localId);
    if (nextColor === this.color) return false;
    this.color = nextColor;
    persistSessionColor(this.color);
    this.awarenessStore.awareness.setLocalStateField("color", this.color);
    return true;
  }

  get(id: number): string | null {
    const color = this.awarenessStore.getStates().get(id)?.color;
    if (typeof color === "string" && color) return vividRemoteColor(color);
    if (id !== this.awarenessStore.awareness.clientID) {
      return REMOTE_PEER_PALETTE[Math.abs(id) % REMOTE_PEER_PALETTE.length];
    }
    this.awarenessStore.awareness.setLocalStateField("color", this.color);
    return this.color;
  }
}

export interface OverlayRect {
  top: number;
  left: number;
  width: number;
  height: number;
  transparent?: boolean;
}

export interface DocRemotePeerSnapshot {
  clientId: number;
  userName: string;
  selectionRects: OverlayRect[];
  blockOutlineRects?: OverlayRect[];
  caretRect: OverlayRect | null;
  caretBlockId: string | null;
}

export interface DocRecentTextMeasurement {
  rects: OverlayRect[];
  fieldRect: OverlayRect | null;
  /** Viewport x-coordinate of the block's left edge, used to decide margin vs top author-chip placement. */
  viewportLeft: number;
}

export interface DocRemotePresenceHost {
  getPeers(): DocRemotePeerSnapshot[];
  measureRecentText(blockId: string): DocRecentTextMeasurement;
  /** Optional viewport-relative top threshold check; defaults to caretRect.top < 28. */
  shouldFlipLabelBelow?(caretRect: OverlayRect): boolean;
  onBeforePaint?(): boolean;
}

export interface DocRemotePresenceHandle {
  schedulePaint(): void;
  dispose(): void;
}

const DOC_REMOTE_PRESENCE_STYLES = `
:host {
  pointer-events: none;
}
.remote-selection {
  position: absolute;
  pointer-events: none;
  background-color: var(--remote-color);
  opacity: 0.2;
  border-radius: 3px;
}
.remote-selection[data-transparent="true"] {
  background-color: transparent;
}
.remote-block-selection {
  position: absolute;
  pointer-events: none;
  box-sizing: border-box;
  border: 2px solid var(--remote-color);
  border-radius: var(--mantine-radius-sm, 4px);
}
.remote-caret {
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  border-radius: 1.5px;
  pointer-events: none;
  background-color: var(--remote-color);
  box-shadow: 0 0 0 1px var(--myoxus-background-primary-color);
  will-change: transform;
}
.remote-caret.is-ready {
  transition:
    transform 80ms cubic-bezier(0.22, 1, 0.36, 1),
    height 80ms ease-out;
}
.remote-username {
  position: absolute;
  left: -1px;
  bottom: calc(100% + 2px);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 6px 0 4px;
  background-color: var(--myoxus-background-primary-color);
  color: var(--myoxus-text-primary-color);
  border: 1.5px solid var(--remote-color);
  border-radius: 6px 6px 6px 2px;
  box-shadow: var(--myoxus-shadow-1);
  max-width: 168px;
  font-family: var(--myoxus-font-sans-family);
  font-size: var(--myoxus-font-xs);
  font-weight: 600;
  line-height: 15px;
  letter-spacing: 0.01em;
  pointer-events: none;
}
.remote-username[hidden],
.remote-recent-bar[hidden],
.remote-recent-author[hidden] {
  display: none;
}
.remote-username[data-placement="bottom"] {
  bottom: auto;
  top: calc(100% + 2px);
  border-radius: 2px 6px 6px 6px;
}
.remote-username-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remote-username-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
  background-color: var(--remote-color);
}
.recent-remote-text {
  position: absolute;
  pointer-events: none;
  border-radius: 3px;
  background-color: var(--remote-marker-color);
  animation: recent-remote-text 15s ease-out forwards;
}
.remote-recent-bar {
  position: absolute;
  width: 3px;
  border-radius: 2px;
  pointer-events: none;
  background-color: var(--remote-color);
  animation: remote-recent-bar 15s ease-out forwards;
}
.remote-recent-author {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px 0 4px;
  background-color: var(--myoxus-background-primary-color);
  color: var(--myoxus-text-primary-color);
  border: 1px solid var(--remote-color);
  border-radius: var(--mantine-radius-sm, 4px);
  box-shadow: var(--myoxus-shadow-1);
  max-width: 120px;
  font-family: var(--myoxus-font-sans-family);
  font-size: var(--myoxus-font-xs);
  font-weight: 500;
  line-height: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  transform: translateX(-100%);
  animation: remote-recent-bar 15s ease-out forwards;
}
.remote-recent-author[data-placement="top"] {
  transform: translateY(calc(-100% - 2px));
}
@keyframes recent-remote-text {
  0% {
    opacity: 0.28;
  }
  70% {
    opacity: 0.16;
  }
  100% {
    opacity: 0;
  }
}
@keyframes remote-recent-bar {
  0% {
    opacity: 0.92;
  }
  70% {
    opacity: 0.55;
  }
  100% {
    opacity: 0;
  }
}
@media print {
  :host {
    display: none !important;
  }
}
`;

type RecentCueEntry = {
  blockId: string;
  clientId: number;
  color: string;
  markerColor: string;
  userName: string;
  anchor: HTMLDivElement;
  bar: HTMLDivElement;
  author: HTMLDivElement;
  timeout: ReturnType<typeof setTimeout>;
};

type CaretEntry = {
  el: HTMLDivElement;
  label: HTMLDivElement;
  nameText: HTMLSpanElement;
  positioned: boolean;
};

/**
 * Single shared overlay and 15-second edit-cue ("Spur") engine for both
 * native Page (`PlainPageView`) and registered `EditorHost`
 * (`MyoxusDocRemoteSelectionWidget`, including Canvas Note editing).
 *
 * View-only marks never write to Yjs documents or undo history.
 */
export function mountDocRemotePresenceOverlay(
  host: HTMLElement,
  store: Store,
  adapter: DocRemotePresenceHost,
): DocRemotePresenceHandle {
  const doc = host.ownerDocument;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = DOC_REMOTE_PRESENCE_STYLES;
  const marksLayer = doc.createElement("div");
  const selectionsLayer = doc.createElement("div");
  const caretsLayer = doc.createElement("div");
  shadow.replaceChildren(style, marksLayer, selectionsLayer, caretsLayer);

  const awarenessStore = store.awarenessStore;
  const awareness = awarenessStore.awareness;
  const colors = new RemoteColorManager(awarenessStore);
  const recentCues = new Map<string, RecentCueEntry>();
  const seenSequences = new Map<number, number>();
  const pendingLocalBlocks = new Set<string>();
  const carets = new Map<number, CaretEntry>();
  let paintQueued = false;
  let disposed = false;

  const clearRecentCue = (blockId: string) => {
    const entry = recentCues.get(blockId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    entry.anchor.remove();
    entry.bar.remove();
    entry.author.remove();
    recentCues.delete(blockId);
  };

  const schedulePaint = () => {
    if (paintQueued || disposed) return;
    paintQueued = true;
    queueMicrotask(() => {
      paintQueued = false;
      if (!disposed) paint();
    });
  };

  const markRecentChange = (
    blockId: string,
    clientId: number,
    color: string,
    userName: string,
  ) => {
    clearRecentCue(blockId);
    const anchor = doc.createElement("div");
    anchor.dataset.remoteChangeBlock = blockId;
    const bar = doc.createElement("div");
    bar.className = "remote-recent-bar";
    bar.style.setProperty("--remote-color", color);
    const author = doc.createElement("div");
    author.className = "remote-recent-author";
    author.style.setProperty("--remote-color", color);
    const dot = doc.createElement("span");
    dot.className = "remote-username-dot";
    const text = doc.createElement("span");
    text.textContent = userName;
    author.append(dot, text);
    marksLayer.append(anchor, bar, author);

    recentCues.set(blockId, {
      blockId,
      clientId,
      color,
      markerColor: textMarkerColor(color),
      userName,
      anchor,
      bar,
      author,
      timeout: setTimeout(
        () => clearRecentCue(blockId),
        RECENT_TEXT_CUE_TTL_MS,
      ),
    });
    schedulePaint();
  };

  const paint = () => {
    if (adapter.onBeforePaint && !adapter.onBeforePaint()) return;
    const peers = adapter.getPeers();
    const activeCaretByBlock = new Map<string, Set<number>>();
    const activeCaretClients = new Set<number>();
    const selectionFragment = doc.createDocumentFragment();

    for (const peer of peers) {
      const color = colors.get(peer.clientId);
      if (!color) continue;

      for (const rect of peer.selectionRects) {
        const box = doc.createElement("div");
        box.className = "remote-selection";
        box.style.setProperty("--remote-color", color);
        if (rect.transparent) box.dataset.transparent = "true";
        box.style.top = `${rect.top}px`;
        box.style.left = `${rect.left}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        selectionFragment.append(box);
      }

      for (const rect of peer.blockOutlineRects ?? []) {
        const outline = doc.createElement("div");
        outline.className = "remote-block-selection";
        outline.style.setProperty("--remote-color", color);
        outline.style.top = `${rect.top}px`;
        outline.style.left = `${rect.left}px`;
        outline.style.width = `${rect.width}px`;
        outline.style.height = `${rect.height}px`;
        selectionFragment.append(outline);
      }

      if (peer.caretRect) {
        activeCaretClients.add(peer.clientId);
        if (peer.caretBlockId) {
          let set = activeCaretByBlock.get(peer.caretBlockId);
          if (!set) {
            set = new Set();
            activeCaretByBlock.set(peer.caretBlockId, set);
          }
          set.add(peer.clientId);
        }

        let entry = carets.get(peer.clientId);
        if (!entry) {
          const el = doc.createElement("div");
          el.className = "remote-caret";
          el.dataset.remoteCursor = String(peer.clientId);
          const label = doc.createElement("div");
          label.className = "remote-username";
          const dot = doc.createElement("span");
          dot.className = "remote-username-dot";
          const nameText = doc.createElement("span");
          nameText.className = "remote-username-name";
          label.append(dot, nameText);
          el.append(label);
          caretsLayer.append(el);
          entry = { el, label, nameText, positioned: false };
          carets.set(peer.clientId, entry);
        }

        entry.el.style.setProperty("--remote-color", color);
        entry.el.style.transform = `translate3d(${peer.caretRect.left}px, ${peer.caretRect.top}px, 0)`;
        entry.el.style.height = `${Math.max(16, peer.caretRect.height)}px`;
        if (!entry.positioned) {
          entry.positioned = true;
          requestAnimationFrame(() => {
            if (!disposed) entry?.el.classList.add("is-ready");
          });
        }
        entry.label.hidden = !peer.userName;
        const flipBelow = adapter.shouldFlipLabelBelow
          ? adapter.shouldFlipLabelBelow(peer.caretRect)
          : peer.caretRect.top < 28;
        entry.label.dataset.placement = flipBelow ? "bottom" : "top";
        if (entry.nameText.textContent !== peer.userName) {
          entry.nameText.textContent = peer.userName;
        }
      }
    }

    selectionsLayer.replaceChildren(selectionFragment);

    for (const [clientId, entry] of carets) {
      if (!activeCaretClients.has(clientId)) {
        entry.el.remove();
        carets.delete(clientId);
      }
    }

    // Update active 15-second edit cues without restarting their CSS fade animations.
    for (const [blockId, cue] of recentCues) {
      const { rects, fieldRect, viewportLeft } =
        adapter.measureRecentText(blockId);
      while (cue.anchor.childElementCount > rects.length) {
        cue.anchor.lastElementChild?.remove();
      }
      rects.forEach((rect, index) => {
        let mark = cue.anchor.children[index] as HTMLDivElement | undefined;
        if (!mark) {
          mark = doc.createElement("div");
          mark.className = "recent-remote-text";
          cue.anchor.append(mark);
        }
        mark.style.setProperty("--remote-marker-color", cue.markerColor);
        mark.style.top = `${rect.top}px`;
        mark.style.left = `${rect.left}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height}px`;
      });

      const top =
        rects.length > 0
          ? Math.min(...rects.map((r) => r.top))
          : fieldRect
            ? fieldRect.top
            : -1;
      const bottom =
        rects.length > 0
          ? Math.max(...rects.map((r) => r.top + r.height))
          : fieldRect
            ? fieldRect.top + fieldRect.height
            : -1;
      const blockLeft = fieldRect
        ? fieldRect.left
        : rects.length > 0
          ? Math.min(...rects.map((r) => r.left))
          : 0;
      const visible = top >= 0 && bottom > top;
      cue.bar.hidden = !visible;
      if (visible) {
        cue.bar.style.top = `${top}px`;
        cue.bar.style.left = `${blockLeft - 12}px`;
        cue.bar.style.height = `${Math.max(16, bottom - top)}px`;
      }
      const samePeerCaretHere =
        activeCaretByBlock.get(blockId)?.has(cue.clientId) ?? false;
      cue.author.hidden = !visible || !cue.userName || samePeerCaretHere;
      if (!cue.author.hidden) {
        if (viewportLeft >= 120) {
          delete cue.author.dataset.placement;
          cue.author.style.top = `${Math.max(0, top - 1)}px`;
          cue.author.style.left = `${blockLeft - 18}px`;
        } else {
          cue.author.dataset.placement = "top";
          cue.author.style.top = `${Math.max(0, top)}px`;
          cue.author.style.left = `${blockLeft}px`;
        }
      }
    }
  };

  // Initial awareness snapshots describe existing state, never a fresh edit.
  const receiveAwareness = () => {
    colors.resolveCollisions();
    const states = awarenessStore.getStates();
    const localId = awareness.clientID;
    for (const client of seenSequences.keys()) {
      if (!states.has(client)) seenSequences.delete(client);
    }
    for (const [clientId, state] of states) {
      if (clientId === localId) continue;
      const change = state.recentTextChanges;
      const prev = seenSequences.get(clientId);
      const seq = change?.sequence ?? 0;
      if (!Number.isSafeInteger(seq)) continue;
      seenSequences.set(clientId, seq);
      if (prev === undefined || prev === seq) continue;
      if (!Array.isArray(change?.blocks)) continue;
      const color = colors.get(clientId);
      if (!color) continue;
      const userName =
        typeof state.user?.name === "string" ? state.user.name.trim() : "";
      for (const id of change.blocks) {
        if (typeof id === "string") {
          markRecentChange(id, clientId, color, userName);
        }
      }
    }
    schedulePaint();
  };

  const announceLocalTextChange = (blockId: string) => {
    if (pendingLocalBlocks.size === 0) {
      queueMicrotask(() => {
        if (disposed || pendingLocalBlocks.size === 0) return;
        const sequence =
          (awarenessStore.getLocalState()?.recentTextChanges?.sequence ?? 0) +
          1;
        const blocks = [...pendingLocalBlocks];
        pendingLocalBlocks.clear();
        awarenessStore.setLocalStateField("recentTextChanges", {
          sequence,
          blocks,
        });
      });
    }
    pendingLocalBlocks.add(blockId);
  };

  receiveAwareness();
  awareness.on("change", receiveAwareness);

  const blockSub = store.slots.blockUpdated.subscribe((event) => {
    if (event.type === "delete") {
      clearRecentCue(event.id);
    } else if (event.isLocal) {
      const model = store.getBlock(event.id)?.model;
      const textChanged =
        event.type === "add"
          ? !event.init &&
            Object.values(event.model.props).some(
              (value) => value instanceof Text,
            )
          : model && Reflect.get(model.props, event.props.key) instanceof Text;
      // Root titles are document metadata, not rendered content text blocks.
      if (model?.role === "content" && textChanged) {
        announceLocalTextChange(event.id);
      }
    }
    schedulePaint();
  });

  return {
    schedulePaint,
    dispose() {
      disposed = true;
      awareness.off("change", receiveAwareness);
      blockSub.unsubscribe();
      for (const entry of recentCues.values()) clearTimeout(entry.timeout);
      recentCues.clear();
      carets.clear();
      pendingLocalBlocks.clear();
      seenSequences.clear();
      shadow.replaceChildren();
    },
  };
}
