// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "../projection/types.js";
import { findMindmapDropTarget, planMindmapInsertion } from "./drop-plan.js";
import { planMindmapResponseAreas } from "./response-plan.js";
import { Bound } from "@virgultum/global/gfx";
import {
  mindmapMoveAtAnchor,
  mindmapMoveImpact,
  type MindmapMoveAction,
  type MindmapMoveImpact,
} from "./move.js";

import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../../runtime/gfx-model.js";
import type { MermaidGfxPreview } from "../../runtime/gfx-preview.js";
import type { MindmapReactHostProps } from "../react-host-contract.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import { mermaidVisualFamilyPayload } from "../../runtime/gfx-family-data.js";
import {
  mindmapDropIndicator,
  styleMindmapDropIndicator,
} from "./indicator.js";

export type MindmapDragFeedback = {
  left: number;
  top: number;
  kind: "reorder" | "reparent";
  impact: MindmapMoveImpact;
  anchor?: string;
  position?: "before" | "after";
};

export type MindmapDragPort = {
  readonly viewportIdentity: object;
  readonly registerPointerDown: (
    handler: (event: PointerEvent) => boolean,
  ) => () => void;
  readonly visual: MermaidVisualModel;
  readonly containsEvent: (event: Event) => boolean;
  readonly resolvePoint: (point: {
    left: number;
    top: number;
  }) => { x: number; y: number } | null;
  readonly resolveNodeBounds: (
    key: string,
  ) => { left: number; top: number; width: number; height: number } | null;
  readonly preview: (model: MermaidVisualModel) => MermaidGfxPreview;
  readonly select: (key: string) => void;
};
type Snapshot = Pick<
  MindmapReactHostProps,
  | "drag"
  | "model"
  | "sourceBasis"
  | "readonly"
  | "displayOnly"
  | "draftActive"
  | "intent"
  | "onCommand"
  | "resolveReturnFocusTarget"
>;
type Node = {
  visual: MermaidVisualNode;
  parent: Node | null;
  children: Node[];
  bound: Bound;
};

/** One local pointer journey uses the Source tree and the native pure hit plans.
 * No GFX child/model property is written; disposal restores the live projection. */
export function bindMindmapDrag(
  current: () => Snapshot,
  onActiveChange: (active: boolean) => void,
  onFeedback: (feedback: MindmapDragFeedback | null) => void,
): () => void {
  let active: {
    pointer: number;
    source: string;
    key: string;
    cancel: () => void;
  } | null = null;
  let moveJourney: ((event: PointerEvent) => void) | null = null;
  let finishJourney: ((event: PointerEvent) => void) | null = null;
  const down = (event: PointerEvent) => {
    const snapshot = current(),
      port = snapshot.drag;
    if (
      active ||
      !port ||
      snapshot.readonly ||
      snapshot.displayOnly ||
      snapshot.draftActive ||
      snapshot.intent ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !port.containsEvent(event)
    )
      return;
    if (
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.matches(
              'button,input,textarea,select,a[href],[role="dialog"],[role="menu"]',
            ),
        )
    )
      return;
    // Claim the node under this down before the generic GFX free-move path.
    // Requiring a prior selection turns the first drag into a different gesture.
    const key = port.visual.nodes.find((node) => {
      const bounds = port.resolveNodeBounds(node.id);
      return (
        bounds &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.left + bounds.width &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.top + bounds.height
      );
    })?.id;
    const sourceNode = snapshot.model.nodes.find(
      (node) => node.sourceKey === key,
    );
    if (!key || !sourceNode || sourceNode.root) return;
    const hit = port.resolveNodeBounds(key);
    if (
      !hit ||
      event.clientX < hit.left ||
      event.clientX > hit.left + hit.width ||
      event.clientY < hit.top ||
      event.clientY > hit.top + hit.height
    )
      return;
    const options = readMindmapProjectionOptions(port.visual);
    const nodes = port.visual.nodes.map(
      (visual) =>
        ({
          visual,
          parent: null,
          children: [],
          bound: new Bound(visual.x, visual.y, visual.width, visual.height),
        }) as Node,
    );
    const byKey = new Map(nodes.map((node) => [node.visual.id, node]));
    for (const node of nodes) {
      const parentKey = mermaidVisualFamilyPayload(
        node.visual.familyData,
        "mindmap",
      )?.parentKey;
      if (typeof parentKey === "string") {
        node.parent = byKey.get(parentKey) ?? null;
        node.parent?.children.push(node);
      }
    }
    const root = nodes.find((node) => !node.parent),
      source = byKey.get(key);
    if (!root || !source) return;
    const sides = () => ({
      left: root.children
        .filter((n) => options.rootSides?.get(n.visual.id) === LayoutType.LEFT)
        .reverse(),
      right: root.children.filter(
        (n) => options.rootSides?.get(n.visual.id) !== LayoutType.LEFT,
      ),
    });
    const children = (node: Node) =>
      options.collapsed?.has(node.visual.id) ? [] : node.children;
    const direction = (node: Node): LayoutType => {
      if (options.layout !== LayoutType.BALANCE)
        return options.layout ?? LayoutType.RIGHT;
      if (node === root) return LayoutType.BALANCE;
      while (node.parent && node.parent !== root) node = node.parent;
      return options.rootSides?.get(node.visual.id) ?? LayoutType.RIGHT;
    };
    const areas = planMindmapResponseAreas(
      root,
      options.layout ?? LayoutType.RIGHT,
      {
        children,
        parent: (node) => node.parent,
        collapsed: (node) => options.collapsed?.has(node.visual.id) ?? false,
        bounds: (node) => node.bound,
        measuredBounds: (node) => node.bound,
        responseArea: () => undefined,
        sides,
      },
    );
    const subtree = new Set<string>();
    const stack = [source];
    while (stack.length) {
      const node = stack.pop()!;
      subtree.add(node.visual.id);
      stack.push(...node.children);
    }
    const origin = port.resolvePoint({ left: hit.left, top: hit.top }),
      start = port.resolvePoint({ left: event.clientX, top: event.clientY });
    if (!origin || !start) return;
    const offset = {
      x: origin.x - source.bound.x,
      y: origin.y - source.bound.y,
    };
    const pointer = event.pointerId,
      sourceBasis = snapshot.sourceBasis;
    let preview: MermaidGfxPreview | null = null,
      moved = false;
    let drop: MindmapMoveAction | null = null;
    const dispose = () => {
      preview?.();
      preview = null;
      active = null;
      onActiveChange(false);
      onFeedback(null);
      moveJourney = null;
      finishJourney = null;
    };
    const restore = () => {
      dispose();
      port.select(key);
      requestAnimationFrame(() =>
        current().resolveReturnFocusTarget()?.focus({ preventScroll: true }),
      );
    };
    active = { pointer, source: sourceBasis, key, cancel: restore };
    port.select(key);
    onActiveChange(true);
    event.preventDefault();
    event.stopImmediatePropagation();
    moveJourney = (move) => {
      if (move.pointerId !== pointer) return;
      const now = current();
      if (
        now.readonly ||
        now.sourceBasis !== sourceBasis ||
        now.drag?.viewportIdentity !== port.viewportIdentity
      ) {
        restore();
        return;
      }
      const point = port.resolvePoint({
        left: move.clientX,
        top: move.clientY,
      });
      if (!point) return;
      if (
        !moved &&
        Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) <
          4
      )
        return;
      moved = true;
      move.preventDefault();
      move.stopImmediatePropagation();
      const local: [number, number] = [point.x - offset.x, point.y - offset.y];
      const target = findMindmapDropTarget(root, local, {
        children,
        bounds: (node) => node.bound,
        responseArea: (node) => areas.get(node),
        direction,
      });
      const insert =
        target && !subtree.has(target.visual.id)
          ? planMindmapInsertion(
              local,
              target.bound,
              areas.get(target),
              direction(target),
              options.layout === LayoutType.BALANCE && target.parent === root,
            )
          : null;
      const parent =
        target && insert
          ? insert.type === "child"
            ? target
            : target.parent
          : null;
      drop = null;
      onFeedback(null);
      let candidate: MermaidVisualModel = {
        ...port.visual,
        nodes: [
          ...port.visual.nodes.filter((node) => !subtree.has(node.id)),
          ...port.visual.nodes.filter((node) => subtree.has(node.id)),
        ].map((node) =>
          subtree.has(node.id)
            ? {
                ...node,
                x: node.x + point.x - start.x,
                y: node.y + point.y - start.y,
              }
            : node,
        ),
        edges: port.visual.edges.filter((edge) => edge.target !== key),
      };
      if (target && insert && parent && !subtree.has(parent.visual.id)) {
        const siblings = parent.children.filter((node) => node !== source);
        const action = mindmapMoveAtAnchor(
          snapshot.model,
          key,
          parent.visual.id,
          insert.type === "sibling" ? target.visual.id : undefined,
          insert.type === "sibling" && insert.position === "next"
            ? "after"
            : "before",
        );
        drop = action ? { ...action, side: insert.layoutDir } : null;
        const impact = drop && mindmapMoveImpact(snapshot.model, drop);
        if (impact)
          onFeedback({
            left: move.clientX,
            top: move.clientY,
            kind: source.parent === parent ? "reorder" : "reparent",
            impact,
            anchor: insert.type === "sibling" ? target.visual.label : undefined,
            position:
              insert.type === "sibling" && insert.position === "next"
                ? "after"
                : "before",
          });
        candidate = mindmapDropIndicator(
          candidate,
          parent.visual,
          target.visual,
          options.collapsed?.has(parent.visual.id)
            ? undefined
            : siblings.at(-1)?.visual,
          insert,
          options.layout === LayoutType.BALANCE,
          parent === root,
          source.parent === parent,
        );
      }
      preview?.();
      preview = port.preview(candidate);
      styleMindmapDropIndicator(
        preview,
        source.parent?.visual.id === drop?.parentKey,
      );
    };
    finishJourney = (up) => {
      if (up.pointerId !== pointer) return;
      up.preventDefault();
      up.stopImmediatePropagation();
      // Release coordinates are authoritative even without a final move event.
      if (moved) moveJourney?.(up);
      if (!active) return;
      const result = drop;
      dispose();
      const now = current();
      if (moved && result && !now.readonly && now.sourceBasis === sourceBasis)
        now.onCommand(result, sourceBasis);
      port.select(key);
      requestAnimationFrame(() =>
        current().resolveReturnFocusTarget()?.focus({ preventScroll: true }),
      );
    };
  };
  const move = (event: PointerEvent) => moveJourney?.(event);
  const up = (event: PointerEvent) => finishJourney?.(event);
  const cancel = (event: PointerEvent) => {
    if (active?.pointer === event.pointerId) active.cancel();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && active) {
      event.preventDefault();
      event.stopImmediatePropagation();
      active.cancel();
    }
  };
  const blur = () => active?.cancel();
  window.addEventListener("blur", blur);
  const start = (event: PointerEvent) => {
    down(event);
    return active?.pointer === event.pointerId;
  };
  const unregister = current().drag?.registerPointerDown(start);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  return () => {
    active?.cancel();
    window.removeEventListener("blur", blur);
    unregister?.();
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
  };
}
