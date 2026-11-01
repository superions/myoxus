// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorElementModel } from "@virgultum/model";
import type { ToolbarContext } from "@virgultum/shared/services";
import type { MermaidEdgelessSelectionContext } from "../../edgeless-toolbar/selection-context.js";
import { getMermaidGfxNode } from "../../commands.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxNodeId,
} from "../../mermaid-gfx-metadata.js";
import type {
  MermaidGfxConnectionProposal,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import { typeOwnedMermaidNodeConnectionPorts } from "../runtime/gfx-owner-hooks.js";
import {
  createRequirementRelationPreview,
  type RequirementCommandPort,
} from "./actions.js";
import { previewNativeRequirement } from "./native-creation.js";
import { readRequirementProjectionModel } from "./readback.js";
import type { RequirementRelationDraft } from "../../engine/requirement/index.js";

type NativeReconnectSession = {
  cancel: () => void;
  listener?: (intent: MermaidGfxObjectEditIntent) => void;
};
const sessions = new WeakMap<object, NativeReconnectSession>();

/** Adapt the native handle's cancellable start into the existing local relation
 * draft. Neither a drag nor a failed drop mutates the real connector or Source. */
export function subscribeNativeRequirementReconnect(
  context: ToolbarContext,
  state: MermaidEdgelessSelectionContext,
  port: RequirementCommandPort,
  listener: (intent: MermaidGfxObjectEditIntent) => void,
) {
  const session: NativeReconnectSession = sessions.get(state.owner) ?? {
    cancel: () => {},
  };
  sessions.set(state.owner, session);
  session.listener = listener;
  const start = (event: Event) => {
    const request = event as CustomEvent<{
      event: PointerEvent;
      connector: ConnectorElementModel;
      endpoint: "source" | "target";
    }>;
    const { connector, endpoint, event: pointer } = request.detail;
    if (!state.owner.childIds.includes(connector.id)) return;
    const edge = port
      .getVisualModel()
      .edges.find((edge) => edge.id === readMermaidGfxEdgeId(connector));
    if (!edge) return;
    request.preventDefault();
    pointer.preventDefault();
    session.cancel();
    const basis = port.getSource(),
      model = readRequirementProjectionModel(basis, port.getVisualModel());
    const relation = model?.relations.find(
      (relation) => relation.id === edge.id,
    );
    if (!model || !relation || port.getReadonly() || state.owner.isLocked())
      return;
    let preview: (() => void) | null = null,
      previous = "",
      disposed = false;
    const stops: (() => void)[] = [];
    const valid = () =>
      !port.getReadonly() &&
      !state.owner.isLocked() &&
      context.host.isConnected &&
      port.getSource() === basis;
    const proposal = (
      pointer: PointerEvent,
    ): MermaidGfxConnectionProposal | null => {
      const [x, y] = context.gfx.viewport.toModelCoordFromClientCoord([
        pointer.clientX,
        pointer.clientY,
      ]);
      const hit = context.gfx
        .getElementByPoint(x, y, { all: true })
        .filter((hit) => state.owner.childIds.includes(hit.id))
        .reverse()
        .find((hit) => readMermaidGfxNodeId(hit));
      const node =
        hit &&
        port
          .getVisualModel()
          .nodes.find((node) => node.id === readMermaidGfxNodeId(hit));
      if (!node) return null;
      const ports = typeOwnedMermaidNodeConnectionPorts(
        port.getVisualModel(),
        node,
      );
      if (ports?.length === 0) return null;
      const shape = getMermaidGfxNode(context.store, state.owner, node.id);
      if (!shape) return null;
      const chosen =
        ports &&
        [...ports].sort(
          (a, b) =>
            Math.hypot(
              shape.x + shape.w * a.position[0] - x,
              shape.y + shape.h * a.position[1] - y,
            ) -
            Math.hypot(
              shape.x + shape.w * b.position[0] - x,
              shape.y + shape.h * b.position[1] - y,
            ),
        )[0];
      return {
        edgeId: edge.id,
        endpoint,
        sourceNodeId: endpoint === "source" ? node.id : edge.source,
        targetNodeId: endpoint === "target" ? node.id : edge.target,
        sourcePortId: endpoint === "source" ? chosen?.id : edge.sourcePortId,
        sourcePosition:
          endpoint === "source" ? chosen?.position : edge.sourcePosition,
        targetPortId: endpoint === "target" ? chosen?.id : edge.targetPortId,
        targetPosition:
          endpoint === "target" ? chosen?.position : edge.targetPosition,
      };
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (session.cancel === dispose) session.cancel = () => {};
      preview?.();
      for (const stop of stops) stop();
    };
    session.cancel = dispose;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== request.detail.event.pointerId) return;
      if (!valid()) {
        dispose();
        return;
      }
      const next = proposal(pointer),
        key = JSON.stringify(next);
      if (key === previous) return;
      previous = key;
      preview?.();
      preview = null;
      if (next) {
        const objects = [...model.requirements, ...model.elements];
        preview = createRequirementRelationPreview(port, (candidate) =>
          previewNativeRequirement(context, state, port, candidate),
        )(
          {
            sourceKey:
              objects.find((object) => object.id === next.sourceNodeId)
                ?.sourceKey ?? "",
            targetKey:
              objects.find((object) => object.id === next.targetNodeId)
                ?.sourceKey ?? "",
            kind: relation.kind as RequirementRelationDraft["kind"],
            sourceForm: relation.sourceForm ?? "right",
          },
          basis,
          next,
        );
      }
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== request.detail.event.pointerId) return;
      const next = valid() ? proposal(pointer) : null;
      pointer.preventDefault();
      pointer.stopImmediatePropagation();
      dispose();
      // The following native click must not replace the edge selection with
      // the drop target or dismiss the just-opened confirmation popover.
      const click = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener("click", click, true);
      requestAnimationFrame(() =>
        window.removeEventListener("click", click, true),
      );
      if (next)
        session.listener?.({ kind: "edge", id: edge.id, connection: next });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        dispose();
      }
    };
    const abort = (event: PointerEvent) => {
      if (event.pointerId === pointer.pointerId) dispose();
    };
    const invalidation = () => {
      if (!valid()) dispose();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointercancel", abort, true);
    stops.push(
      () => window.removeEventListener("pointermove", move, true),
      () => window.removeEventListener("pointerup", up, true),
      () => window.removeEventListener("keydown", key, true),
      state.owner.props.source$.subscribe(invalidation),
      context.store.readonly$.subscribe(invalidation),
      state.owner.lockedBySelf$.subscribe(invalidation),
    );
    stops.push(() => window.removeEventListener("pointercancel", abort, true));
  };
  context.host.addEventListener("gfx-connector-reconnect-start", start);
  return () => {
    // Pointer-down refreshes the native toolbar subscription. The gesture
    // belongs to its owner until up/cancel, not to that transient React effect.
    if (session.listener === listener) session.listener = undefined;
    queueMicrotask(() => {
      // Effect refresh installs its replacement synchronously; final unmount
      // must also release window listeners when no pointer-up follows it.
      if (!session.listener) session.cancel();
    });
    context.host.removeEventListener("gfx-connector-reconnect-start", start);
  };
}
