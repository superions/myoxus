// SPDX-License-Identifier: AGPL-3.0-or-later

import { effect } from "@preact/signals-core";
import { Bound } from "@virgultum/global/gfx";
import { MermaidBlockSchema, type MermaidBlockModel } from "@virgultum/model";
import { GfxBlockComponent } from "@virgultum/std";
import {
  type BoxSelectionContext,
  GfxViewInteractionExtension,
  InteractivityExtension,
  type GfxModel,
} from "@virgultum/std/gfx";
import { html, nothing, type PropertyValues } from "lit";

import { resolveMermaidSourceLifecycle } from "../families/runtime/source-lifecycle.js";
import { MermaidFamilyReactHostIdentifier } from "../families/runtime/react-host.js";
import { mermaidMessages } from "../i18n.js";
import { getMermaidBlockSource } from "../utils.js";
import { subscribeMermaidNativeValidation } from "../families/runtime/native-validation.js";
import {
  ensureMermaidProjectionOwnerCommand,
  getMermaidGfxNode,
} from "../commands.js";
import { readMermaidGfxMeta } from "../mermaid-gfx-metadata.js";
import { getMermaidGfxFamilyHooks } from "../families/runtime/gfx-family-hooks-registry.js";
import { canMutateMermaidGfxOwnerSource } from "./owner.js";
import { getMermaidVisualModelFromProjectionOwner } from "../commands/materialization.js";
import {
  typeOwnedMermaidDescendantSubgraphIds,
  typeOwnedMermaidGeometrySelection,
} from "../families/runtime/gfx-owner-hooks.js";
import { getMermaidGfxSelectionIdentity } from "../mermaid-gfx-selection.js";
import { resolveNativeMermaidOwnerForSelection } from "./edgeless-owner-resolution.js";
import { bindNativeMermaidSessionSelection } from "../families/runtime/session-selection.js";

/** Expand native moves through semantic membership, never overlapping bounds. */
export class MermaidEdgelessSubgraphInteraction extends InteractivityExtension {
  static override key = "mermaid-edgeless-subgraph-interaction";

  private canChangeGeometry(element: GfxModel, selected: readonly GfxModel[]) {
    const owner = resolveNativeMermaidOwnerForSelection(this.std.store, [
      element,
    ]);
    if (!owner) return true;
    if (
      this.std.store.readonly ||
      !canMutateMermaidGfxOwnerSource({
        lastValidSource: owner.model.props.lastValidSource,
        parent: this.std.store.getParent(owner.model.id),
        source: getMermaidBlockSource(owner.model.props),
      })
    )
      return false;
    // Whole-owner move/resize transforms the existing owner and descendants
    // together. Source-derived child geometry forbids independent gestures,
    // not the standard placement/scale operation on the complete diagram.
    if (selected.some((item) => item.id === owner.model.id)) return true;
    const model = getMermaidVisualModelFromProjectionOwner(
      this.std,
      owner.model,
    );
    if (!model) return false;
    const identity = getMermaidGfxSelectionIdentity(element);
    const ids =
      element.id === owner.model.id
        ? [...model.nodes, ...model.edges, ...(model.subgraphs ?? [])].map(
            (item) => item.id,
          )
        : [
            identity.edgeId ||
              identity.subgraphId ||
              identity.nodeId ||
              element.id,
          ];
    return typeOwnedMermaidGeometrySelection(model, ids).length > 0;
  }

  override mounted() {
    this.action.onElementSelect(({ target, suggest }) => {
      const nodeId = readMermaidGfxMeta(target, "mermaidDetailOwnerNodeId");
      if (!nodeId || readMermaidGfxMeta(target, "mermaidDetailSourceKey"))
        return;
      const owner = resolveNativeMermaidOwnerForSelection(this.std.store, [
        target,
      ]);
      if (!owner) return;
      const model = getMermaidVisualModelFromProjectionOwner(
        this.std,
        owner.model,
      );
      if (
        !model ||
        !getMermaidGfxFamilyHooks(model)?.detailSelectionViaFamilyControls
      )
        return;
      // Derived content has no independent Source record or geometry gesture.
      // Redirect through the native selector so modifier selection and drag still work.
      const body = getMermaidGfxNode(this.std.store, owner.model, nodeId);
      if (body) suggest({ id: body.id });
    });
    this.action.onMoveElements((context) => {
      context.elements = context.elements.filter((element) =>
        this.canChangeGeometry(element, context.elements),
      );
      const selected = [...context.elements];
      const included = new Set(selected.map((element) => element.id));
      for (const element of selected) {
        const identity = getMermaidGfxSelectionIdentity(element);
        if (!identity.isSubgraphShape && !identity.isNodeShape) continue;
        const owner = resolveNativeMermaidOwnerForSelection(this.std.store, [
          element,
        ]);
        if (!owner) continue;
        if (identity.isNodeShape) {
          // Presentation carriers follow the same native move preview and
          // cancellation as their body; they never become a separate selection.
          for (const child of owner.model.descendantElements) {
            if (
              included.has(child.id) ||
              readMermaidGfxMeta(child, "mermaidDetailOwnerNodeId") !==
                identity.nodeId ||
              readMermaidGfxMeta(child, "mermaidDetailSourceKey")
            )
              continue;
            included.add(child.id);
            context.elements.push(child);
          }
          continue;
        }
        const model = getMermaidVisualModelFromProjectionOwner(
          this.std,
          owner.model,
        );
        if (!model) continue;
        const descendants = typeOwnedMermaidDescendantSubgraphIds(
          model,
          identity.subgraphId,
        );
        if (!descendants) continue;
        const groupIds = new Set([identity.subgraphId, ...descendants]);
        const nodeIds = new Set(
          (model.subgraphs ?? [])
            .filter((group) => groupIds.has(group.id))
            .flatMap((group) => group.nodeIds),
        );
        for (const child of owner.model.descendantElements) {
          const childIdentity = getMermaidGfxSelectionIdentity(child);
          if (
            included.has(child.id) ||
            (!groupIds.has(childIdentity.subgraphId) &&
              !nodeIds.has(childIdentity.nodeId))
          )
            continue;
          included.add(child.id);
          context.elements.push(child);
        }
      }
      // GFX owns pointer preview/cancellation and keyboard geometry writes for
      // this same expanded set. This hook never changes the visible selection.
      // Another extension may consume all generic elements to own its drag
      // (native Mindmap does). An empty list is not a Mermaid cancellation.
    });
    this.action.onElementResize(({ elements }) => {
      const nodes = elements.flatMap((element) => {
        const identity = getMermaidGfxSelectionIdentity(element);
        if (
          !identity.isNodeShape ||
          readMermaidGfxMeta(element, "mermaidDetailOwnerNodeId")
        )
          return [];
        const owner = resolveNativeMermaidOwnerForSelection(this.std.store, [
          element,
        ]);
        if (!owner) return [];
        const model = getMermaidVisualModelFromProjectionOwner(
          this.std,
          owner.model,
        );
        const hooks = model && getMermaidGfxFamilyHooks(model);
        const node = model?.nodes.find((node) => node.id === identity.nodeId);
        return model &&
          node &&
          hooks?.nodeDetailGeometryFollowsBody &&
          hooks.normalizeNodeDimensions
          ? [{ model, node, normalize: hooks.normalizeNodeDimensions }]
          : [];
      });
      if (!nodes.length) return {};
      return {
        onResizeMove({ scaleX, scaleY, lockRatio, suggest }) {
          // The native shape floor cannot protect family-owned compartments.
          // Constrain the shared gesture before painting or committing it.
          let widthScale = Math.abs(scaleX),
            heightScale = Math.abs(scaleY);
          for (const { model, node, normalize } of nodes) {
            const sized = normalize(
              {
                ...node,
                width: node.width * widthScale,
                height: node.height * heightScale,
              },
              model,
            );
            widthScale = Math.max(widthScale, sized.width / node.width);
            heightScale = Math.max(heightScale, sized.height / node.height);
          }
          // Native multi-selection takes the smaller scale when locking ratio.
          // Both axes must carry the strongest compartment floor before that step.
          if (lockRatio) {
            const fits = (scale: number) =>
              nodes.every(({ model, node, normalize }) => {
                const width = node.width * scale,
                  height = node.height * scale;
                const sized = normalize({ ...node, width, height }, model);
                return sized.width <= width && sized.height <= height;
              });
            let lower = Math.min(Math.abs(scaleX), Math.abs(scaleY));
            let upper = Math.max(1, lower);
            if (!fits(upper)) upper = Math.max(upper, widthScale, heightScale);
            if (!fits(upper)) {
              suggest({ scaleX: 1, scaleY: 1 });
              return;
            }
            if (fits(lower)) upper = lower;
            else
              for (let step = 0; step < 12; step++) {
                const middle = (lower + upper) / 2;
                if (fits(middle)) upper = middle;
                else lower = middle;
              }
            // Wrapping at the requested narrow width can require a taller body
            // than the original. Solve the uniform floor instead of turning
            // a shrink gesture into growth on both axes.
            widthScale = heightScale = upper;
          }
          suggest({
            scaleX: (Math.sign(scaleX) || 1) * widthScale,
            scaleY: (Math.sign(scaleY) || 1) * heightScale,
          });
        },
      };
    });
    this.action.onTransformElements((context) => {
      // A multi-selection uses one bounding matrix. Reject the whole resize
      // when one protected member would otherwise be transformed indirectly.
      if (
        context.elements.some(
          (element) => !this.canChangeGeometry(element, context.elements),
        )
      )
        context.elements = [];
    });
  }
}

export class MermaidEdgelessBlockComponent extends GfxBlockComponent<MermaidBlockModel> {
  override connectedCallback() {
    super.connectedCallback();
    const selection = bindNativeMermaidSessionSelection(
      this.store,
      this.model,
      this.gfx,
    );
    this.disposables.add(selection.dispose);
    void this.updateComplete.then(() => {
      if (this.isConnected) selection.restore();
    });
    this.disposables.add(
      subscribeMermaidNativeValidation((source) => {
        if (source === getMermaidBlockSource(this.model.props)) {
          this.std.command.exec(ensureMermaidProjectionOwnerCommand, {
            model: this.model,
            capture: false,
            preferSource: true,
          });
        } else if (source !== this.model.props.lastValidSource) return;
        // Retained Source is validated again after cold load. Its verdict
        // updates the notice without reconciling the invalid current Source.
        this.requestUpdate();
        selection.restore();
      }),
    );
    this.disposables.add(
      effect(() => {
        void this.transformState$.value;
        // The owner contributes geometry and interaction only. Its DOM host
        // must never cover native children or their overlays.
        this.style.pointerEvents = "none";
      }),
    );
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(({ id, type }) => {
        if (id === this.model.id && type === "update") this.requestUpdate();
      }),
    );
  }

  override getRenderingRect() {
    const bound = Bound.deserialize(this.model.xywh);
    return {
      h: bound.h,
      rotate: this.model.rotate,
      w: bound.w,
      x: bound.x,
      y: bound.y,
      zIndex: this.toZIndex(),
    };
  }

  override updated(changed: PropertyValues) {
    super.updated(changed);
    // Native children paint on the shared surface, so expose the diagram's
    // accessible metadata on its existing non-intercepting owner host.
    const visual = getMermaidVisualModelFromProjectionOwner(
      this.std,
      this.model,
    );
    for (const [attribute, value] of [
      [
        "role",
        visual?.accessibilityTitle || visual?.accessibilityDescription
          ? "group"
          : undefined,
      ],
      ["aria-label", visual?.accessibilityTitle],
      ["aria-description", visual?.accessibilityDescription],
    ]) {
      if (value) this.setAttribute(attribute!, value);
      else this.removeAttribute(attribute!);
    }
  }

  override onBoxSelected({ box }: BoxSelectionContext) {
    const selectionBound = new Bound(box.x, box.y, box.w, box.h);
    return (
      this.model.childElements.length === 0 ||
      selectionBound.contains(this.model.elementBound)
    );
  }

  override renderGfxBlock() {
    const source = getMermaidBlockSource(this.model.props);
    if (
      canMutateMermaidGfxOwnerSource({
        lastValidSource: this.model.props.lastValidSource,
        parent: this.store.getParent(this.model.id),
        source,
      })
    ) {
      return nothing;
    }
    const lifecycle = resolveMermaidSourceLifecycle(source);
    const resolution = lifecycle.resolution;
    const message =
      lifecycle.reason ??
      ("diagnostics" in resolution
        ? resolution.diagnostics[0]?.message
        : undefined) ??
      mermaidMessages.visualMutationSourceRejected(
        resolution.diagramType || "Mermaid",
      );
    const reactHost = this.std.getOptional(MermaidFamilyReactHostIdentifier);
    const retained = this.model.props.lastValidSource;
    // Keep diagnostic chrome above the native owner rather than covering its
    // retained Start/edge labels. This is overlay geometry, not a Source move.
    return html`<div style="transform: translateY(-100%)">
      ${
        reactHost?.renderShellNotice({
          message,
          title:
            retained &&
            resolveMermaidSourceLifecycle(retained).canRetainAsLastValid
              ? `${mermaidMessages.lastValidPreviewLabel()} · ${mermaidMessages.ganttReadOnly()}`
              : mermaidMessages.errorTitle(),
          tone: "error",
        }) ?? nothing
      }
    </div>`;
  }
}

export const MermaidEdgelessBlockInteraction =
  GfxViewInteractionExtension<MermaidEdgelessBlockComponent>(
    MermaidBlockSchema.model.flavour,
    {
      handleResize: ({ add, model }) => {
        const added = new Set<string>();
        for (const descendant of model.descendantElements) {
          if (added.has(descendant.id)) continue;
          added.add(descendant.id);
          add(descendant);
        }
        // The standard context already contains the owner. Keeping it there
        // transforms owner and descendants once with the same matrix.
        return {};
      },
      handleRotate: () => ({
        beforeRotate: (context) => context.set({ rotatable: false }),
      }),
      handleSelection: ({ gfx, model }) => ({
        selectable(context) {
          if (!context.default(context)) return false;
          const hits = gfx.getElementByPoint(
            context.position.x,
            context.position.y,
            { all: true },
          );
          return !hits.some(
            (candidate) =>
              candidate.id !== model.id && model.hasDescendant(candidate),
          );
        },
      }),
    },
  );

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-mermaid": MermaidEdgelessBlockComponent;
  }
}
