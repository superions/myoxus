// SPDX-License-Identifier: AGPL-3.0-or-later
import { SurfaceBlockComponent } from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import { mountShapeTextEditor } from "@virgultum/gfx-shape";
import type { ToolbarContext } from "@virgultum/shared/services";
import {
  getMermaidGfxNode,
  getMermaidVisualElementOriginBound,
  getMermaidVisualElementOriginFromAnchor,
} from "../../commands.js";
import type { RequirementObjectKind } from "../../engine/requirement/index.js";
import type { MermaidEdgelessSelectionContext } from "../../edgeless-toolbar/selection-context.js";
import { previewMermaidGfxModel } from "../runtime/gfx-preview.js";
import { getMermaidGfxTitleBandHeight } from "../runtime/gfx-element-projection.js";
import { revealNativeMermaidNode } from "../runtime/gfx-edgeless-toolbar.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import {
  beginRequirementCreationDraft,
  type RequirementCreationDraft,
} from "./creation-draft.js";
import {
  createRequirementObjectConsumer,
  type RequirementCommandPort,
} from "./actions.js";
import { mermaidRequirementRendererToken } from "./react-host-contract.js";

const placements = new WeakMap<object, () => void>();
const drafts = new WeakMap<object, RequirementCreationDraft>();

function nativeRequirementOrigin(
  context: ToolbarContext,
  state: MermaidEdgelessSelectionContext,
  port: RequirementCommandPort,
) {
  const visual = port.getVisualModel(),
    first = visual.nodes.find((node) =>
      getMermaidGfxNode(context.store, state.owner, node.id),
    );
  const shape =
      first && getMermaidGfxNode(context.store, state.owner, first.id),
    fallback = Bound.deserialize(state.owner.xywh);
  return first && shape
    ? getMermaidVisualElementOriginFromAnchor(
        first,
        Bound.deserialize(shape.xywh),
        fallback,
      )
    : getMermaidVisualElementOriginBound(
        visual,
        fallback,
        visual.diagramTitle?.trim() ? getMermaidGfxTitleBandHeight(visual) : 0,
      );
}

/** Native drafts share one viewport-local projection port with creation. */
export function previewNativeRequirement(
  context: ToolbarContext,
  state: MermaidEdgelessSelectionContext,
  port: RequirementCommandPort,
  candidate: ReturnType<RequirementCommandPort["getVisualModel"]>,
) {
  const surface = state.owner.surface,
    component = context.gfx.surfaceComponent;
  if (!surface || !(component instanceof SurfaceBlockComponent))
    return () => {};
  return previewMermaidGfxModel(candidate, {
    surface,
    creator: state.owner,
    viewport: context.gfx.viewport,
    origin: nativeRequirementOrigin(context, state, port),
    elements: [],
    hideOriginals: () =>
      component.renderer.excludeElementsTemporarily(
        new Set(
          state.owner.childIds.filter(
            (id) =>
              surface.getElementById(id)?.yMap.get("mermaidRole") !==
              "mermaid-diagram-title",
          ),
        ),
      ),
    refresh: () => component.requestUpdate(),
  });
}

/** The native toolbar adapts the same scoped local-shape preview and neutral
 * text draft ports used by the Page host. It does not provision a second owner. */
export function beginNativeRequirementCreation(
  context: ToolbarContext,
  state: MermaidEdgelessSelectionContext,
  port: RequirementCommandPort,
  kind: RequirementObjectKind,
) {
  placements.get(state.owner)?.();
  drafts.get(state.owner)?.cancel();
  const surface = state.owner.surface;
  const root =
    context.store.root && context.std.view.getBlock(context.store.root.id);
  if (!surface || !root || port.getReadonly() || state.owner.isLocked()) return;
  const basis = port.getSource(),
    previous = context.gfx.selection.selectedElements.map(
      (element) => element.id,
    );
  const component = context.gfx.surfaceComponent;
  if (!(component instanceof SurfaceBlockComponent)) return;
  const origin = () => nativeRequirementOrigin(context, state, port);
  let disposed = false;
  const stops: (() => void)[] = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    context.host.removeEventListener("pointerdown", place, true);
    context.host.removeEventListener("keydown", cancel, true);
    context.host.removeEventListener("focusout", leave);
    for (const stop of stops) stop();
    if (placements.get(state.owner) === dispose) placements.delete(state.owner);
  };
  const leave = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      !context.host.contains(event.relatedTarget)
    )
      dispose();
  };
  const cancel = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dispose();
    }
  };
  const place = (event: PointerEvent) => {
    if (
      event.button !== 0 ||
      !event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            (["CANVAS", "MYOXUS-SURFACE"].includes(target.tagName) ||
              target.classList.contains("edgeless-background") ||
              target.classList.contains("edgeless-block-children-container")),
        )
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dispose();
    if (
      port.getReadonly() ||
      state.owner.isLocked() ||
      port.getSource() !== basis
    )
      return;
    const [x, y] = context.gfx.viewport.toModelCoordFromClientCoord([
        event.clientX,
        event.clientY,
      ]),
      offset = origin();
    let draft: RequirementCreationDraft | null = null;
    draft = beginRequirementCreationDraft(
      {
        ...port,
        getReadonly: () =>
          port.getReadonly() ||
          state.owner.isLocked() ||
          !context.host.isConnected,
        command: createRequirementObjectConsumer(port),
        clearSelection: () =>
          context.gfx.selection.set({ editing: false, elements: [] }),
        restoreSelection: () =>
          context.gfx.selection.set({
            editing: false,
            elements: previous.filter((id) => surface.getElementById(id)),
          }),
        selectAfterPreview: (id) => {
          const shape = getMermaidGfxNode(context.store, state.owner, id);
          if (shape) {
            context.gfx.selection.set({ editing: false, elements: [shape.id] });
            revealNativeMermaidNode(context, shape.xywh);
          }
        },
        subscribeInvalidation: (invalidate) => {
          const source = state.owner.props.source$.subscribe(invalidate),
            readonly = context.store.readonly$.subscribe(invalidate),
            locked = state.owner.lockedBySelf$.subscribe(invalidate);
          return () => {
            source();
            readonly();
            locked();
          };
        },
        previewVisualModel: (candidate) =>
          previewNativeRequirement(context, state, port, candidate),
        mountShapeDraft: (shape, edit) => {
          revealNativeMermaidNode(context, shape.xywh);
          const editor = mountShapeTextEditor(shape, root, { draft: edit });
          return editor ? () => editor.cancelDraft() : null;
        },
        renderActions: (actions) =>
          context.std
            .getOptional(MermaidFamilyReactHostIdentifier)
            ?.renderFamilyEditor(mermaidRequirementRendererToken, {
              surface: "label-actions",
              ...actions,
            }) ?? undefined,
        finish: () => {
          if (drafts.get(state.owner) === draft) drafts.delete(state.owner);
          requestAnimationFrame(() => {
            if (
              !drafts.has(state.owner) &&
              (!document.activeElement ||
                document.activeElement === document.body)
            )
              context.host.focus({ preventScroll: true });
          });
        },
      },
      kind,
      { centerX: x - offset.x, centerY: y - offset.y },
    );
    if (draft) drafts.set(state.owner, draft);
  };
  placements.set(state.owner, dispose);
  stops.push(
    state.owner.props.source$.subscribe(() => {
      if (port.getSource() !== basis) dispose();
    }),
    context.store.readonly$.subscribe(() => {
      if (port.getReadonly()) dispose();
    }),
    state.owner.lockedBySelf$.subscribe(() => {
      if (state.owner.isLocked()) dispose();
    }),
  );
  context.host.addEventListener("pointerdown", place, true);
  context.host.addEventListener("keydown", cancel, true);
  context.host.addEventListener("focusout", leave);
  context.host.focus({ preventScroll: true });
}
