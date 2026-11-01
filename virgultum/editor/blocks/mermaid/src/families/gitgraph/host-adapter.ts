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
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  readGitGraphProjectionModel,
  gitGraphBinding,
  gitGraphPayload,
} from "./gfx-data.js";
import { gitGraphModelToVisual } from "./visual-model.js";
import { preserveGitGraphOwnerTransform } from "./source-application.js";
import {
  runGitGraphCommand,
  gitGraphPageSelectionTools,
  GITGRAPH_ACTIONS,
  type GitGraphAction,
  type GitGraphCommandArgs,
  type GitGraphCommandName,
  gitGraphActionLabel,
} from "./actions.js";
import {
  mermaidGitGraphRendererToken,
  mermaidGitGraphRepairRendererToken,
  type GitGraphReactHostProps,
  type GitGraphFeedback,
} from "./react-host-contract.js";

import { createGitGraphSourceRepairProps } from "./source-repair.js";
import { mermaidMessages as m } from "../../i18n.js";
import { formatGitGraphDiagnostic } from "./diagnostics.js";
export type GitGraphEditorProjectionContext = Pick<
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
  | "selectNode"
  | "viewportIdentity"
  | "visualModel"
  | "workarea"
  | "workareaFooter"
> &
  Partial<Pick<MermaidGfxActionContext, "pageViewport">> & {
    selectedItems: readonly Pick<MermaidPageSelectionItem, "editKey">[];
    getVisualModel?: () => MermaidVisualModel;
  };
export function createGitGraphEditorProps(
  context: GitGraphEditorProjectionContext,
  host: Pick<
    MermaidHostProjectionContext,
    "getSource" | "getReadonly" | "getTransientState" | "setTransientState"
  > &
    Partial<Pick<MermaidHostProjectionContext, "copySource" | "exportMmd">>,
): GitGraphReactHostProps | null {
  const model = readGitGraphProjectionModel(
    host.getSource(),
    context.visualModel,
  );
  if (!model) return null;
  const selectedItem = context.selectedItems[0],
    selectedObject = selectedItem
      ? (context.visualModel.nodes.find((n) => n.id === selectedItem.editKey) ??
        context.visualModel.edges.find((e) => e.id === selectedItem.editKey))
      : context.displayOnly
        ? (context.visualModel.nodes.find(
            (n) =>
              gitGraphBinding(n)?.role === "comment" &&
              gitGraphBinding(n)?.sourceKey ===
                host.getTransientState("gitgraph.readComment"),
          ) ?? null)
        : null,
    binding = selectedObject && gitGraphBinding(selectedObject),
    kind =
      selectedObject && "source" in selectedObject
        ? ("edge" as const)
        : ("node" as const);
  const selected =
    selectedObject && binding
      ? { ...binding, visualKey: selectedObject.id, kind }
      : null;
  if (binding?.role === "comment")
    host.setTransientState("gitgraph.readComment", binding.sourceKey);
  const selectedKeys = [
    ...new Set(
      context.selectedItems.flatMap((item) => {
        const object = context.visualModel.nodes.find(
            (n) => n.id === item.editKey,
          ),
          b = object && gitGraphBinding(object);
        return b && b.role !== "rail" ? [b.sourceKey] : [];
      }),
    ),
  ];
  const select = (key: string, role?: "origin" | "head") => {
    const n =
      (role
        ? context.visualModel.nodes.find((n) => n.id === `${key}:${role}`)
        : context.visualModel.nodes.find((n) => n.id === key)) ??
      context.visualModel.nodes.find(
        (n) => gitGraphBinding(n)?.sourceKey === key,
      );
    if (n) {
      context.selectNode(n.id);
      host.setTransientState("gitgraph.returnSelection", n.id);
      requestAnimationFrame(() => {
        const target = context.resolveReturnFocusTarget();
        const viewport = target?.closest(".myoxus-mermaid-gfx-viewport");
        const carrier = viewport?.querySelector<HTMLElement>(
          `[data-mermaid-edit-key="${CSS.escape(n.id)}"]`,
        );
        (carrier || target)?.focus({ preventScroll: true });
      });
    }
  };
  // The viewport/owner transient port keeps cancellation stable across host
  // refreshes, so React cleanup does not dismiss a live preview on every render.
  let cancel = host.getTransientState("gitgraph.cancelPreview") as
    (() => void) | undefined;
  if (!cancel) {
    cancel = () => {
      (host.getTransientState("gitgraph.preview") as (() => void) | null)?.();
      host.setTransientState("gitgraph.preview", null);
      host.setTransientState("gitgraph.previewedSource", null);
    };
    host.setTransientState("gitgraph.cancelPreview", cancel);
  }
  const close = () => {
    cancel();
    host.setTransientState("gitgraph.readComment", null);
    host.setTransientState("gitgraph.editIntent", null);
    host.setTransientState("gitgraph.parentIntent", null);
    context.refreshWorkarea();
    requestAnimationFrame(() => {
      const target = context.resolveReturnFocusTarget(),
        key = host.getTransientState("gitgraph.returnSelection") as
          string | undefined;
      const carrier =
        key &&
        target
          ?.closest(".myoxus-mermaid-gfx-viewport")
          ?.querySelector<HTMLElement>(
            `[data-mermaid-edit-key="${CSS.escape(key)}"]`,
          );
      (carrier || target)?.focus({ preventScroll: true });
    });
  };
  const execute = <K extends GitGraphCommandName>(
    name: K,
    args: GitGraphCommandArgs<K>,
    basis: string,
    preview = false,
  ): GitGraphFeedback => {
    const previewed = host.getTransientState("gitgraph.previewedSource");
    cancel();
    if (host.getReadonly() || context.readonly || context.displayOnly)
      return { changed: false, diagnostic: m.ganttReadOnly() };
    if (basis !== host.getSource())
      return { changed: false, diagnostic: m.chartSourceChanged() };
    const displayed = context.getVisualModel?.() ?? context.visualModel;
    const current = readGitGraphProjectionModel(basis, displayed);
    if (!current) return { changed: false, diagnostic: m.classPatchRejected() };
    const result = runGitGraphCommand(current, name, args);
    if (result.status === "rejected")
      return {
        changed: false,
        diagnostic: result.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) =>
            formatGitGraphDiagnostic(
              d,
              result.diagnosticSource ?? result.source,
            ),
          )
          .join("\n"),
        impact: result.impact,
      };
    if (!result.changed)
      return {
        changed: false,
        sourceBasis: basis,
        selection: result.selection,
        impact: result.impact,
      };
    const visual = preserveGitGraphOwnerTransform(
      gitGraphModelToVisual(result.model),
      gitGraphModelToVisual(current),
      displayed,
    );
    if (preview) {
      if (!context.previewVisualModel)
        return { changed: false, diagnostic: m.classPatchRejected() };
      host.setTransientState(
        "gitgraph.preview",
        context.previewVisualModel(visual),
      );
      host.setTransientState("gitgraph.previewedSource", result.source);
      return {
        changed: false,
        impact: result.impact,
        selection: result.selection,
      };
    }
    if (result.impact.length && previewed !== result.source)
      return {
        changed: false,
        diagnostic: m.gitGraphPreviewImpact(),
        impact: result.impact,
      };
    const committed = context.applyVisualModel(visual, {
      preserveSourceBytes: true,
      sourceWrite: { baseSource: basis, source: result.source },
    });
    if (!committed.applied)
      return {
        changed: false,
        diagnostic: committed.diagnostic ?? m.classPatchRejected(),
      };
    if (result.selection) {
      const n =
        visual.nodes.find((n) => n.id === result.selection) ??
        visual.nodes.find(
          (n) => gitGraphBinding(n)?.sourceKey === result.selection,
        );
      if (n) {
        context.selectAfterProjection(
          { kind: "node", editKey: n.id },
          {
            focus:
              name === "editGitGraphCommit" ||
              name === "editGitGraphMerge" ||
              name === "editGitGraphAttributeOccurrence",
          },
        );
        host.setTransientState("gitgraph.returnSelection", n.id);
      }
    }
    return {
      changed: true,
      sourceBasis: result.source,
      selection: result.selection,
      impact: result.impact,
    };
  };
  const anchor =
    selected &&
    context.resolveVisualAnchor(selected.kind, selected.visualKey, true);
  const carrierHeight =
    selected?.kind === "node"
      ? (context.resolveVisualBounds?.("node", selected.visualKey)?.height ?? 0)
      : 0;
  return {
    surface: "editor",
    model,
    sourceBasis: host.getSource(),
    onCopySource: host.copySource,
    onExportMmd: host.exportMmd,
    visualModel: context.visualModel,
    selected,
    selectedKeys,
    guidesVisible: host.getTransientState("gitgraph.guidesVisible") !== false,
    commentsVisible:
      host.getTransientState("gitgraph.commentsVisible") !== false,
    onVisibility: (kind, visible) => {
      host.setTransientState(`gitgraph.${kind}Visible`, visible);
      context.refreshWorkarea();
    },
    selectionProblem:
      context.selectedItems.some((i) =>
        context.visualModel.edges.some((e) => e.id === i.editKey),
      ) ||
      (context.selectedItems.length > 1 &&
        context.selectedItems.some(
          (i) =>
            !context.visualModel.nodes.some(
              (n) => n.id === i.editKey && gitGraphBinding(n)?.role !== "rail",
            ),
        ))
        ? m.gitGraphMixedSelection()
        : undefined,
    selectedAnchor: anchor ? { ...anchor, height: carrierHeight } : null,
    intent: host.getTransientState(
      "gitgraph.editIntent",
    ) as MermaidGfxObjectEditIntent | null,
    parentIntent: host.getTransientState(
      "gitgraph.parentIntent",
    ) as GitGraphAction | null,
    readonly: context.readonly || host.getReadonly(),
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    viewportIdentity: context.viewportIdentity,
    onCommand: execute,
    onPreview: (name, args, basis) => execute(name, args, basis, true),
    onCancelPreview: cancel,
    onCloseSelection: close,
    resolveVisualAnchor: context.resolveVisualAnchor,
    selectSourceKey: select,
    resolveSequenceAnchor: (point, key) => {
      const owner = context.resolveVisualBounds?.("diagram", "", true);
      const focus = context.resolveReturnFocusTarget();
      const viewport = (
        focus?.closest(".myoxus-mermaid-gfx-viewport") ??
        focus?.querySelector(".myoxus-edgeless-viewport")
      )?.getBoundingClientRect();
      // Nearest-statement lookup is meaningful only inside this visible owner.
      // A drop over other document content or toolbar chrome cancels the draft.
      const contains = (rect: {
        left: number;
        top: number;
        width: number;
        height: number;
      }) =>
        point.left >= rect.left &&
        point.left <= rect.left + rect.width &&
        point.top >= rect.top &&
        point.top <= rect.top + rect.height;
      if (!owner || !contains(owner) || (viewport && !contains(viewport)))
        return null;
      const options = model
        .sourceDocument!.records.filter(
          (r) =>
            r.sourceKey !== key &&
            ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(
              r.kind,
            ),
        )
        .flatMap((r) => {
          const n = context.visualModel.nodes.find(
            (n) =>
              gitGraphBinding(n)?.sourceKey === r.sourceKey &&
              ["commit", "statement", "branch"].includes(
                gitGraphBinding(n)?.role ?? "",
              ),
          );
          const bounds = n && context.resolveVisualBounds?.("node", n.id, true);
          return n && bounds ? [{ record: r, bounds }] : [];
        });
      const nearest = options.reduce<(typeof options)[number] | null>(
        (a, b) =>
          !a ||
          Math.hypot(
            point.left - (b.bounds.left + b.bounds.width / 2),
            point.top - (b.bounds.top + b.bounds.height / 2),
          ) <
            Math.hypot(
              point.left - (a.bounds.left + a.bounds.width / 2),
              point.top - (a.bounds.top + a.bounds.height / 2),
            )
            ? b
            : a,
        null,
      );
      if (!nearest) return null;
      return {
        sourceKey: nearest.record.sourceKey,
        position: (
          model.direction === "LR"
            ? point.left < nearest.bounds.left + nearest.bounds.width / 2
            : model.direction === "BT"
              ? point.top > nearest.bounds.top + nearest.bounds.height / 2
              : point.top < nearest.bounds.top + nearest.bounds.height / 2
        )
          ? "before"
          : "after",
      };
    },
    onEditIntent: (intent) => {
      cancel();
      host.setTransientState("gitgraph.parentIntent", null);
      host.setTransientState("gitgraph.editIntent", intent);
      if (intent)
        host.setTransientState(
          "gitgraph.returnSelection",
          intent.ownerId ?? intent.id,
        );
      context.refreshWorkarea();
      if (!intent) close();
    },
    onParentIntent: (intent) => {
      cancel();
      host.setTransientState("gitgraph.editIntent", null);
      host.setTransientState("gitgraph.parentIntent", intent);
      context.refreshWorkarea();
      if (!intent) close();
    },
    onWorkareaResize: context.refreshWorkarea,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
  };
}
export const mermaidGitGraphHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: resolution.renderSurface,
    pageSelectionTools: gitGraphPageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        hiddenObjectKeys: resolution.visualModel.nodes
          .filter((n) => {
            const b = gitGraphBinding(n),
              p = gitGraphPayload(n);
            return b?.role === "comment"
              ? (displayOnly &&
                  host.getTransientState("gitgraph.readComment") !==
                    b.sourceKey) ||
                  host.getTransientState("gitgraph.commentsVisible") === false
              : b?.role === "statement" || p?.authoringGuide === true
                ? displayOnly ||
                  host.getTransientState("gitgraph.guidesVisible") === false
                : false;
          })
          .map((n) => n.id),
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: resolution.renderSurface,
        pageSelectionTools: gitGraphPageSelectionTools,
        onObjectEditIntent: (intent) => {
          host.setTransientState("gitgraph.pendingEditIntent", intent);
          return true;
        },
        projectActions: (context) => {
          const pending = host.getTransientState(
            "gitgraph.pendingEditIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (pending) {
            host.setTransientState(
              "gitgraph.returnSelection",
              pending.ownerId ?? pending.id,
            );
            if (!context.selectedItems.some((i) => i.editKey === pending.id)) {
              if (pending.kind === "edge") context.selectEdge(pending.id);
              else context.selectNode(pending.id);
            }
            host.setTransientState(
              "gitgraph.editIntent",
              pending.action === "select" || pending.action === "delete"
                ? null
                : pending,
            );
            host.setTransientState(
              "gitgraph.parentIntent",
              pending.action === "delete" ? "deleteSelection" : null,
            );
            host.setTransientState("gitgraph.pendingEditIntent", null);
          }
          const props = createGitGraphEditorProps(context, host);
          if (!props) return null;
          host.setTransientState("gitgraph.currentActions", props);
          const label =
              props.selected?.role === "relationship"
                ? m.gitGraphRelationReadOnly()
                : m.visualDelete(),
            disabled =
              context.readonly || props.selected?.role === "relationship",
            selectionKey = `${context.selectedItems.map((i) => `${i.kind}:${i.editKey}`).join("|")}:${disabled}:${label}`;
          let selectionAction = host.getTransientState(
            "gitgraph.selectionAction",
          ) as
            | {
                key: string;
                action: ReturnType<
                  MermaidHostProjectionContext["getSelectionAction"]
                >;
              }
            | undefined;
          if (selectionAction?.key !== selectionKey) {
            selectionAction = {
              key: selectionKey,
              action: context.selectedItems.length
                ? {
                    label,
                    disabled,
                    onSelect: () =>
                      (
                        host.getTransientState(
                          "gitgraph.currentActions",
                        ) as GitGraphReactHostProps
                      ).onParentIntent("deleteSelection"),
                  }
                : null,
            };
            host.setTransientState("gitgraph.selectionAction", selectionAction);
          }
          // This port requests a host render when its value changes. Recreating
          // the action inside that render would keep replacing focused carriers.
          host.setSelectionAction(selectionAction.action);
          const body = context.reactHost?.renderFamilyEditor(
            mermaidGitGraphRendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions:
                    displayOnly || context.embedded
                      ? []
                      : GITGRAPH_ACTIONS.filter(
                          (a) => a !== "deleteSelection",
                        ).map((action) => ({
                          id: `gitgraph.${action}`,
                          label: gitGraphActionLabel(action),
                          disabled: context.readonly,
                          onSelect: () => props.onParentIntent(action),
                        })),
                  portal: !context.embedded,
                  selectionAction: host.getSelectionAction(),
                },
              }
            : null;
        },
      }),
  }),
  projectInvalidSource: (_source, lastValid) => ({
    kind: "gfx",
    renderSurface: "core-facade",
    readonlyExploration: true,
    project: (host) => {
      const makeProps = (context?: MermaidGfxActionContext) =>
        createGitGraphSourceRepairProps(
          {
            getSource: host.getSource,
            getReadonly: host.getReadonly,
            getSourceMetadata: () => lastValid?.familyData,
            getTransientState: host.getTransientState,
            setTransientState: host.setTransientState,
            preview: context?.previewVisualModel,
            apply: (visual, sourceWrite) =>
              context
                ? context.applyVisualModel(visual, {
                    preserveSourceBytes: true,
                    sourceWrite,
                  })
                : (host.commitSource(sourceWrite.source, {
                    preserveSourceBytes: true,
                    sourceWrite,
                  }),
                  { applied: host.getSource() === sourceWrite.source }),
            select: (key) =>
              context?.selectAfterProjection(
                { kind: "node", editKey: key },
                { focus: true },
              ),
          },
          {
            embedded: host.embedded ?? false,
            surface: "editor",
            workarea: context?.workarea ?? null,
            workareaFooter: context?.workareaFooter ?? null,
            pageViewport: context?.pageViewport,
            viewportIdentity: context?.viewportIdentity,
            resolveReturnFocusTarget: () =>
              context?.resolveReturnFocusTarget() ?? host.getActionTarget(),
            onWorkareaResize: () => context?.refreshWorkarea(),
          },
        );
      const render = (context?: MermaidGfxActionContext) =>
        host
          .getReactHost()
          ?.renderFamilyEditor(
            mermaidGitGraphRepairRendererToken,
            makeProps(context),
          );
      if (lastValid)
        return host.renderGfx(lastValid, {
          displayOnly: true,
          embeddedFacadeSurface: true,
          renderSurface: "core-facade",
          projectActions: (context) => ({
            body: render(context),
            actions: { actions: [], portal: false },
          }),
        });
      return {
        actions: null,
        body: render(),
        notice: {
          tone: "error",
          title: m.errorTitle(),
          message:
            makeProps().diagnostics.find((d) => d.severity === "error")
              ?.message ?? m.errorCopy(),
        },
      };
    },
  }),
  projectPreview: (visualModel, source) =>
    mermaidGitGraphHostAdapter.projectGfx({
      visualModel,
      source,
      diagramType: visualModel.diagramType,
      renderSurface: "core-facade",
    }),
};
