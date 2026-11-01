// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidFamilyHostAdapter,
  MermaidPageSelectionItem,
} from "../runtime/contracts.js";
import type {
  MermaidGfxActionContext,
  MermaidHostProjectionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import type {
  C4EditorReactHostProps,
  C4ParentIntent,
} from "./react-host-contract.js";
import { c4PageSelectionTools } from "./selection-tools.js";
import { c4ActionCatalog } from "./action-catalog.js";
import { mermaidC4RendererToken } from "./react-host-contract.js";
import { readC4ProjectionModel } from "./gfx-data.js";
import { createC4CommandConsumer } from "./command-port.js";
import { setC4BoundaryCollapsed } from "./boundary-projection.js";
import { c4CommentMarkers } from "./annotation-projection.js";
import { mermaidMessages as m } from "../../i18n.js";

/** Page and native Root adapters supply the same Source/control ports. */
export type C4EditorProjectionContext = Pick<
  MermaidGfxActionContext,
  | "actionTarget"
  | "applyVisualModel"
  | "displayOnly"
  | "embedded"
  | "embeddedEditing"
  | "onEmbeddedActionsInsetChange"
  | "previewVisualModel"
  | "readonly"
  | "refreshWorkarea"
  | "resolveReturnFocusTarget"
  | "resolveViewportPoint"
  | "resolveVisualAnchor"
  | "resolveVisualBounds"
  | "selectAfterProjection"
  | "viewportIdentity"
  | "visualModel"
  | "workarea"
  | "workareaFooter"
> &
  Partial<Pick<MermaidGfxActionContext, "pageViewport">> & {
    // The C4 editor consumes exact Source keys from both Page items and native
    // Root selections; the native set can also contain a non-element owner.
    readonly selectedItems: ReadonlyArray<
      Pick<MermaidPageSelectionItem, "editKey">
    >;
    readonly getVisualModel?: () => MermaidGfxActionContext["visualModel"];
  };
export function createC4EditorProps(
  context: C4EditorProjectionContext,
  host: Pick<
    MermaidHostProjectionContext,
    "getSource" | "getReadonly" | "getTransientState" | "setTransientState"
  >,
): C4EditorReactHostProps | null {
  const model = readC4ProjectionModel(host.getSource(), context.visualModel);
  if (!model) return null;
  const close = () => {
    host.setTransientState("c4.editIntent", null);
    host.setTransientState("c4.parentIntent", null);
    context.refreshWorkarea();
    requestAnimationFrame(() => {
      const key = host.getTransientState("c4.returnSelection") as string | null;
      const viewport = context
        .resolveReturnFocusTarget()
        ?.closest(".myoxus-mermaid-gfx-viewport");
      const target =
        key &&
        viewport?.querySelector<HTMLElement>(
          `[data-mermaid-edit-key="${CSS.escape(key)}"]`,
        );
      (target || context.resolveReturnFocusTarget())?.focus({
        preventScroll: true,
      });
    });
  };
  const commands = createC4CommandConsumer({
    getSource: host.getSource,
    getReadonly: () =>
      host.getReadonly() || context.readonly || context.displayOnly,
    getVisualModel: context.getVisualModel ?? (() => context.visualModel),
    applyVisualModel: context.applyVisualModel,
    previewVisualModel: context.previewVisualModel,
    selectAfterProjection: context.selectAfterProjection,
  });
  return {
    surface: "editor",
    model,
    sourceBasis: model.sourceDocument.source,
    visualModel: context.visualModel,
    viewportIdentity: context.viewportIdentity,
    resolveViewportPoint: context.resolveViewportPoint,
    selectedKeys: context.selectedItems.map((item) => item.editKey),
    intent: host.getTransientState(
      "c4.editIntent",
    ) as MermaidGfxObjectEditIntent | null,
    parentIntent: host.getTransientState(
      "c4.parentIntent",
    ) as C4ParentIntent | null,
    readonly: context.readonly || host.getReadonly(),
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    resolveVisualAnchor: context.resolveVisualAnchor,
    resolveVisualBounds: context.resolveVisualBounds,
    commentMarkers: c4CommentMarkers(
      model,
      context.resolveVisualAnchor,
      context.visualModel,
    ),
    onEditIntent: (intent) => {
      host.setTransientState("c4.parentIntent", null);
      host.setTransientState("c4.editIntent", intent);
      // Dismissal must retain the opener until close restores its focus.
      if (intent)
        host.setTransientState(
          "c4.returnSelection",
          intent.ownerId ?? intent.id,
        );
      context.refreshWorkarea();
      if (!intent) close();
    },
    onParentIntent: (intent) => {
      host.setTransientState("c4.editIntent", null);
      host.setTransientState("c4.parentIntent", intent);
      context.refreshWorkarea();
      if (!intent) close();
    },
    onCommand: (name, args, basis) => {
      const result = commands.onCommand(name, args, basis);
      if (result.changed || result.selection)
        host.setTransientState("c4.returnSelection", result.selection ?? null);
      return result;
    },
    previewCommand: commands.previewCommand,
    onBoundaryCollapsed: (key, collapsed, basis) => {
      if (host.getReadonly() || context.readonly || context.displayOnly)
        return { changed: false, diagnostic: m.ganttReadOnly() };
      if (host.getSource() !== basis)
        return { changed: false, diagnostic: m.chartSourceChanged() };
      const stored = context.getVisualModel?.() ?? context.visualModel;
      const visual = setC4BoundaryCollapsed(stored, key, collapsed);
      if (!visual)
        return { changed: false, diagnostic: m.classPatchRejected() };
      if (visual === stored) return { changed: false };
      const commit = context.applyVisualModel(visual, {
        preserveSourceBytes: true,
      });
      return {
        changed: commit.applied,
        diagnostic: commit.diagnostic,
        sourceBasis: basis,
        selection: key,
      };
    },
    onCloseSelection: close,
    onWorkareaResize: context.refreshWorkarea,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
  };
}

/** C4 shares the existing Page/Embedded workbench and Source commit boundary. */
export const mermaidC4HostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: resolution.renderSurface,
    pageSelectionTools: c4PageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: resolution.renderSurface,
        pageSelectionTools: c4PageSelectionTools,
        onContainerActionIntent: () => {
          if (host.getReadonly() || displayOnly) return false;
          host.setTransientState("c4.editIntent", null);
          host.setTransientState("c4.pendingEditIntent", null);
          host.setTransientState("c4.parentIntent", "group");
          return true;
        },
        onObjectEditIntent: (intent) => {
          host.setTransientState("c4.pendingEditIntent", intent);
          host.setTransientState(
            "c4.parentIntent",
            intent.action === "delete" ? "deleteSelection" : null,
          );
          return true;
        },
        projectActions: (context) => {
          const pending = host.getTransientState(
            "c4.pendingEditIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (pending) {
            const key = pending.ownerId ?? pending.id;
            if (!context.selectedItems.some((item) => item.editKey === key)) {
              if (pending.kind === "edge") context.selectEdge(key);
              else if (pending.kind === "subgraph")
                context.selectContainer(key);
              else context.selectNode(key);
            }
            host.setTransientState(
              "c4.editIntent",
              pending.action === "delete" ? null : pending,
            );
            host.setTransientState("c4.returnSelection", key);
            host.setTransientState("c4.pendingEditIntent", null);
          }
          const intent = host.getTransientState(
            "c4.editIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (
            !pending &&
            intent &&
            !context.selectedItems.some(
              (item) => item.editKey === (intent.ownerId ?? intent.id),
            )
          )
            host.setTransientState("c4.editIntent", null);
          const props = createC4EditorProps(context, host);
          host.setSelectionAction(
            context.selectedItems.length > 0
              ? {
                  label: m.visualDelete(),
                  disabled: context.readonly,
                  onSelect: () => props?.onParentIntent("deleteSelection"),
                }
              : null,
          );
          if (!props) return null;
          const body = context.reactHost?.renderFamilyEditor(
            mermaidC4RendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions:
                    displayOnly || context.embedded
                      ? []
                      : c4ActionCatalog(props).map((action) => ({
                          id: `c4.${action.intent}`,
                          label: action.label,
                          disabled: action.disabled,
                          onSelect: () => props.onParentIntent(action.intent),
                        })),
                  portal: !context.embedded,
                  selectionAction: host.getSelectionAction(),
                },
              }
            : null;
        },
      }),
  }),
  projectPreview: (visualModel, source) =>
    mermaidC4HostAdapter.projectGfx({
      visualModel,
      source,
      diagramType: visualModel.diagramType,
      renderSurface: "core-facade",
    }),
};
