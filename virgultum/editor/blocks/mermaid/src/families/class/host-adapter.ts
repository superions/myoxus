// SPDX-License-Identifier: AGPL-3.0-or-later
import { MERMAID_GFX_TITLE_ROLE } from "../runtime/gfx-element-roles.js";
import { isValidUrl, normalizeUrl } from "@virgultum/shared/utils";
import { classCommentMarkers } from "./annotation-projection.js";
import { Bound } from "@virgultum/global/gfx";
import type { MermaidFamilyHostAdapter } from "../runtime/contracts.js";
import type {
  MermaidHostProjectionContext,
  MermaidGfxActionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import type {
  ClassReactHostProps,
  ClassSelection,
} from "./react-host-contract.js";
import { mermaidClassRendererToken } from "./react-host-contract.js";
import {
  readClassProjectionModel,
  reconcileClassVisual,
} from "./source-application.js";
import { classModelToVisual } from "./visual-model.js";
import { classNodeGfxData } from "./gfx-data.js";
import {
  classPageSelectionTools,
  runClassCommand,
  CLASS_PARENT_ACTIONS,
  CLASS_PARENT_ACTION_LABELS,
  type ClassParentAction,
} from "./actions.js";
import {
  classDeleteImpact,
  deleteClassNamespace,
  classRecordGroup,
  readClassConfig,
} from "../../engine/class/index.js";
import { mermaidMessages } from "../../i18n.js";
function selection(
  context: MermaidGfxActionContext,
  intent: MermaidGfxObjectEditIntent | null,
): ClassSelection | null {
  if (intent?.kind === "detail")
    return { kind: "member", key: intent.id, ownerKey: intent.ownerId };
  const item = intent
    ? { kind: intent.kind, editKey: intent.id }
    : context.selectedItems.length === 1
      ? context.selectedItems[0]
      : null;
  const node =
    item?.kind === "node"
      ? context.visualModel.nodes.find(
          (candidate) => candidate.id === item.editKey,
        )
      : null;
  if (node && classNodeGfxData(node)?.kind === "lollipop-interface") {
    const edge = context.visualModel.edges.find(
      (e) => e.source === node.id || e.target === node.id,
    );
    return edge ? { kind: "relation", key: edge.id } : null;
  }
  if (node)
    return {
      kind: classNodeGfxData(node)?.kind === "note" ? "note" : "class",
      key: node.id,
    };
  if (item?.kind === "edge") {
    const edge = context.visualModel.edges.find(
      (candidate) => candidate.id === item.editKey,
    );
    if (edge && !edge.familyData?.payload.noteLink)
      return { kind: "relation", key: edge.id };
  }
  if (item?.kind === "subgraph")
    return { kind: "namespace", key: item.editKey };
  return null;
}
function openClassLink(
  model: import("../../engine/class/model.js").MermaidClassModel,
  key: string,
) {
  const node = model.nodes.find((n) => n.sourceKey === key);
  const link = model.interactions.findLast(
    (i) => i.kind === "link" && i.classId === node?.sourceId,
  );
  if (!link || !isValidUrl(link.url)) return;
  window.open(normalizeUrl(link.url), link.target, "noopener,noreferrer");
}
export function classSelectionImpact(
  model: import("../../engine/class/model.js").MermaidClassModel,
  item: ClassSelection,
) {
  if (item.kind === "class") return classDeleteImpact(model, [item.key]);
  if (item.kind === "namespace")
    return deleteClassNamespace(
      model,
      item.key,
      item.deleteStrategy ?? "delete",
      "delete",
    ).impact;
  const group = classRecordGroup(model, item.key);
  return {
    records: (group?.records ?? []).map((r) => ({
      id: r.sourceKey,
      kind: r.kind,
      label: r.raw.trim(),
    })),
    attachedNotes: [],
  };
}
export type ClassCommandPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidGfxActionContext["visualModel"];
  applyVisualModel: MermaidGfxActionContext["applyVisualModel"];
  selectAfterProjection: MermaidGfxActionContext["selectAfterProjection"];
  getPlacement?: () => { centerX: number; centerY: number } | null;
  clearPlacement?: () => void;
  onMemberIntent?: (intent: MermaidGfxObjectEditIntent) => void;
};
/** Both hosts use the same checked Source command and one owner commit. */
export function createClassCommandConsumer(
  port: ClassCommandPort,
): ClassReactHostProps["onCommand"] {
  return (name, args, basis, requestedPlacement) => {
    if (port.getReadonly())
      return {
        changed: false,
        diagnostic: mermaidMessages.classPatchRejected(),
      };
    const current = port.getSource();
    if (current !== basis)
      return {
        changed: false,
        diagnostic: mermaidMessages.classSourceConflict(),
      };
    const active = readClassProjectionModel(current, port.getVisualModel());
    if (!active)
      return {
        changed: false,
        diagnostic: mermaidMessages.classPatchRejected(),
      };
    const result = runClassCommand(active, name, args);
    const forceLayout =
      name === "editClassAppearance" &&
      Boolean((args[0] as { layout?: boolean } | undefined)?.layout);
    if (result.status === "rejected" || (!result.changed && !forceLayout))
      return {
        changed: false,
        diagnostic: result.diagnostic,
        impact: result.impact,
      };
    const visual = reconcileClassVisual(
      classModelToVisual(result.model),
      port.getVisualModel(),
      !forceLayout,
    );
    const placement = (requestedPlacement ?? port.getPlacement?.()) as {
      centerX: number;
      centerY: number;
    } | null;
    if (name === "addClass" && placement && result.selection) {
      const added = visual.nodes.find((n) => n.id === result.selection);
      if (added) {
        added.x = placement.centerX - added.width / 2;
        added.y = placement.centerY - added.height / 2;
      }
    }
    const committed = port.applyVisualModel(visual, {
      preserveSourceBytes: true,
      ...(result.changed
        ? { sourceWrite: { baseSource: current, source: result.source } }
        : {}),
    });
    if (!committed.applied)
      return {
        changed: false,
        diagnostic:
          committed.diagnostic ?? mermaidMessages.classPatchRejected(),
      };
    if (result.selection) {
      const member = result.model.nodes
        .flatMap((n) => n.members)
        .find((m) => m.id === result.selection);
      const owner = member
        ? result.model.nodes.find((n) => n.sourceId === member.classId)
            ?.sourceKey
        : result.selection;
      const kind = visual.nodes.some((n) => n.id === owner)
        ? "node"
        : visual.edges.some((e) => e.id === owner)
          ? "edge"
          : visual.subgraphs?.some((g) => g.id === owner)
            ? "subgraph"
            : null;
      if (kind && owner) port.selectAfterProjection({ editKey: owner, kind });
      if (member)
        port.onMemberIntent?.({
          kind: "detail",
          id: member.id,
          ownerId: owner,
        });
    }
    port.clearPlacement?.();
    return {
      changed: true,
      sourceBasis: result.source,
      selection: result.selection,
      impact: result.impact,
    };
  };
}
export function createClassEditorProps(
  context: MermaidGfxActionContext,
  host: MermaidHostProjectionContext,
): ClassReactHostProps | null {
  const model = readClassProjectionModel(host.getSource(), context.visualModel);
  if (!model) return null;
  const intent = host.getTransientState(
    "class.editIntent",
  ) as MermaidGfxObjectEditIntent | null;
  const parentIntent = host.getTransientState(
    "class.parentIntent",
  ) as ClassParentAction | null;
  const retainedMember = host.getTransientState("class.selectedMember") as {
    key: string;
    ownerKey: string;
  } | null;
  const memberSelected =
    retainedMember &&
    context.selectedItems.length === 1 &&
    context.selectedItems[0]?.editKey === retainedMember.ownerKey &&
    model.nodes.some((n) => n.members.some((m) => m.id === retainedMember.key));
  if (retainedMember && !memberSelected && context.selectedItems.length)
    host.setTransientState("class.selectedMember", null);
  const selected = memberSelected
    ? { kind: "member" as const, ...retainedMember }
    : selection(context, intent);
  const onEditIntent = (value: MermaidGfxObjectEditIntent | null) => {
    host.setTransientState("class.editIntent", value);
    if (value?.kind === "detail" && value.ownerId)
      host.setTransientState("class.selectedMember", {
        key: value.id,
        ownerKey: value.ownerId,
      });
    else if (value) host.setTransientState("class.selectedMember", null);
    context.refreshWorkarea();
    if (!value)
      requestAnimationFrame(() => {
        const viewport = context
          .resolveReturnFocusTarget()
          ?.closest(".myoxus-mermaid-gfx-viewport");
        const key =
          (
            host.getTransientState("class.selectedMember") as {
              key?: string;
            } | null
          )?.key ??
          selected?.key ??
          "";
        const kind =
          selected?.kind === "member"
            ? "detail"
            : selected?.kind === "namespace"
              ? "subgraph"
              : selected?.kind === "relation"
                ? "edge"
                : "node";
        const row =
          key &&
          viewport?.querySelector<HTMLElement>(
            `[data-object-kind="${kind}"][data-mermaid-edit-key="${CSS.escape(key)}"]`,
          );
        (row || context.resolveReturnFocusTarget())?.focus({
          preventScroll: true,
        });
      });
  };
  const selectedKeys = context.selectedItems.map((item) => item.editKey);
  const groupAllowed =
    classPageSelectionTools.containerAction?.validate({
      items: context.selectedItems,
      visualModel: context.visualModel,
    }).valid ?? false;
  return {
    config: readClassConfig(model.sourceDocument).config,
    surface: "editor",
    model,
    sourceBasis: model.sourceDocument.source,
    selected,
    selectedKeys: selected?.kind === "member" ? [selected.key] : selectedKeys,
    selectedAnchor:
      (selected?.kind === "member"
        ? context.resolveVisualAnchor("detail", selected.key)
        : null) ??
      intent?.anchor ??
      (selected
        ? context.resolveVisualAnchor(
            selected.kind === "member"
              ? "detail"
              : selected.kind === "namespace"
                ? "subgraph"
                : selected.kind === "relation"
                  ? "edge"
                  : "node",
            selected.key,
          )
        : null) ??
      (selected?.kind === "member"
        ? context.resolveVisualAnchor("detail", selected.key)
        : null) ??
      context.selectedNodeAnchor ??
      context.selectedEdgeAnchor ??
      context.selectedSubgraphAnchor,
    intent,
    parentIntent,
    groupAllowed,
    readonly: context.readonly,
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    placement: host.getTransientState("class.placement") as {
      centerX: number;
      centerY: number;
    } | null,
    commentMarkers: classCommentMarkers(model, context.resolveVisualAnchor),
    getImpact: (item) => classSelectionImpact(model, item),
    resolveMemberInsertAnchor: (key) => {
      const anchor = context.resolveVisualAnchor("detail", key);
      const viewport = context
        .resolveReturnFocusTarget()
        ?.closest(".myoxus-mermaid-gfx-viewport");
      const rect = viewport?.getBoundingClientRect();
      return anchor && rect
        ? { left: anchor.left + rect.left, top: anchor.top + rect.top }
        : null;
    },
    onOpenLink: (key) => openClassLink(model, key),
    onCommand: createClassCommandConsumer({
      getSource: host.getSource,
      getReadonly: () => host.getReadonly() || context.readonly,
      getVisualModel: () => context.visualModel,
      applyVisualModel: context.applyVisualModel,
      selectAfterProjection: context.selectAfterProjection,
      getPlacement: () =>
        host.getTransientState("class.placement") as {
          centerX: number;
          centerY: number;
        } | null,
      clearPlacement: () => host.setTransientState("class.placement", null),
      onMemberIntent: (value) => {
        host.setTransientState("class.selectedMember", {
          key: value.id,
          ownerKey: value.ownerId,
        });
        host.setTransientState("class.editIntent", value);
      },
    }),
    onParentIntent: (value) => {
      onEditIntent(null);
      host.setTransientState("class.parentIntent", value);
      if (value === "addClass") {
        host.setTransientState("class.parentIntent", null);
        context.beginNodePlacement((placement) => {
          host.setTransientState("class.placement", placement);
          host.setTransientState("class.parentIntent", "addClass");
          context.refreshWorkarea();
        });
      } else context.refreshWorkarea();
    },
    onEditIntent,
    onCloseSelection: () => {
      onEditIntent(null);
      context.closeInspector();
    },
    onWorkareaResize: context.refreshWorkarea,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
  };
}
export const mermaidClassHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: resolution.renderSurface,
    pageSelectionTools: classPageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: resolution.renderSurface,
        pageSelectionTools: classPageSelectionTools,
        resolveDetailVisibilityTarget: () => {
          const edit = (host.getTransientState("class.pendingEditIntent") ??
            host.getTransientState(
              "class.editIntent",
            )) as MermaidGfxObjectEditIntent | null;
          if (edit?.kind === "detail" && edit.ownerId)
            return { ownerId: edit.ownerId, detailId: edit.id };
          const selected = host.getTransientState("class.selectedMember") as {
            ownerKey: string;
            key: string;
          } | null;
          return selected
            ? { ownerId: selected.ownerKey, detailId: selected.key }
            : null;
        },
        onObjectEditIntent: (intent) => {
          if (host.getReadonly()) return false;
          if (intent.action === "delete") {
            host.setTransientState("class.parentIntent", "deleteSelection");
            host.setTransientState("class.editIntent", null);
            return true;
          }
          host.setTransientState("class.pendingEditIntent", intent);
          host.setTransientState("class.parentIntent", null);
          return true;
        },
        projectActions: (context) => {
          const edit = host.getTransientState(
            "class.pendingEditIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (
            edit?.kind === "node" &&
            context.inspector.selectedNode?.id !== edit.id
          )
            context.selectNode(edit.id);
          if (
            edit?.kind === "detail" &&
            edit.ownerId &&
            context.inspector.selectedNode?.id !== edit.ownerId
          )
            context.selectNode(edit.ownerId);
          if (
            edit?.kind === "edge" &&
            context.inspector.selectedEdge?.id !== edit.id
          )
            context.selectEdge(edit.id);
          if (
            edit?.kind === "subgraph" &&
            context.inspector.selectedSubgraph?.id !== edit.id
          )
            context.selectContainer(edit.id);
          if (edit) {
            if (edit.kind === "detail" && edit.ownerId)
              host.setTransientState("class.selectedMember", {
                key: edit.id,
                ownerKey: edit.ownerId,
              });
            else host.setTransientState("class.selectedMember", null);
            host.setTransientState("class.editIntent", edit);
            host.setTransientState("class.pendingEditIntent", null);
          }
          const active = host.getTransientState(
            "class.editIntent",
          ) as MermaidGfxObjectEditIntent | null;
          const key = active?.kind === "detail" ? active.ownerId : active?.id;
          if (
            !edit &&
            active &&
            !context.selectedItems.some((item) => item.editKey === key)
          )
            host.setTransientState("class.editIntent", null);
          const props = createClassEditorProps(context, host);
          // A rights change can invalidate selection while a draft owns focus.
          // Use the existing close boundary to return focus to the surviving
          // object/viewport instead of leaving it on a removed form input.
          if (active && context.readonly && props && !props.intent)
            props.onEditIntent(null);
          host.setSelectionAction(
            context.selectedItems.length
              ? {
                  label: mermaidMessages.visualDelete(),
                  disabled: context.readonly,
                  onSelect: () => {
                    host.setTransientState(
                      "class.parentIntent",
                      "deleteSelection",
                    );
                    context.refreshWorkarea();
                  },
                }
              : null,
          );
          if (!props) return null;
          const body = context.reactHost?.renderFamilyEditor(
            mermaidClassRendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions:
                    displayOnly || context.embedded
                      ? []
                      : CLASS_PARENT_ACTIONS.map((id) => ({
                          id: `class.${id}`,
                          label: CLASS_PARENT_ACTION_LABELS[id](),
                          disabled: context.readonly && id !== "data",
                        })),
                  portal: !context.embedded,
                  selectionAction: host.getSelectionAction(),
                },
              }
            : null;
        },
      }),
  }),
  projectPreview: (visual, source) =>
    mermaidClassHostAdapter.projectGfx({
      visualModel: visual,
      source,
      diagramType: visual.diagramType,
      renderSurface: "core-facade",
    }),
};

import type { ToolbarContext } from "@virgultum/shared/services";
import {
  resolveMermaidEdgelessSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import {
  applyMermaidVisualModelCommand,
  getMermaidVisualModelForEditing,
  getMermaidGfxNode,
  getMermaidGfxConnector,
  getMermaidGfxSubgraph,
} from "../../commands.js";
import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
  readMermaidGfxSubgraphId,
  readMermaidGfxMeta,
} from "../../mermaid-gfx-metadata.js";
import { getMermaidBlockSource } from "../../utils.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import {
  MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  type MermaidFamilyEdgelessToolbarContribution,
  type MermaidPageSelectionItem,
} from "../runtime/contracts.js";
function nativeClassProps(context: ToolbarContext): ClassReactHostProps | null {
  const state = resolveMermaidEdgelessSelection(context);
  if (
    !state?.visualModel ||
    !["classDiagram", "classDiagram-v2"].includes(state.diagramType)
  )
    return null;
  const source = getMermaidBlockSource(state.owner.props);
  const model = readClassProjectionModel(source, state.visualModel);
  if (!model) return null;
  const items = state.selectedModels.flatMap<MermaidPageSelectionItem>(
    (element) => {
      const nodeId = readMermaidGfxNodeId(element),
        edgeId = readMermaidGfxEdgeId(element),
        subgraphId = readMermaidGfxSubgraphId(element);
      if (nodeId) return [{ editKey: nodeId, kind: "node" }];
      if (edgeId) return [{ editKey: edgeId, kind: "edge" }];
      if (subgraphId) return [{ editKey: subgraphId, kind: "subgraph" }];
      return [];
    },
  );
  const uniqueItems = [
    ...new Map(
      items.map((item) => [`${item.kind}:${item.editKey}`, item]),
    ).values(),
  ];
  const detail =
    state.selectedModels.length === 1
      ? readMermaidGfxMeta(state.selectedModels[0], "mermaidDetailId")
      : "";
  const member = model.nodes
    .flatMap((n) => n.members)
    .find((m) => m.id === detail);
  const item = uniqueItems.length === 1 ? uniqueItems[0] : undefined;
  const titleElement =
    state.selectedModels.length === 1 &&
    readMermaidGfxMeta(state.selectedModels[0], "mermaidRole") ===
      MERMAID_GFX_TITLE_ROLE
      ? state.selectedModels[0]
      : null;
  let selected: ClassSelection | null = titleElement
    ? { kind: "title", key: titleElement.id }
    : member
      ? {
          kind: "member",
          key: member.id,
          ownerKey: model.nodes.find((n) => n.sourceId === member.classId)
            ?.sourceKey,
        }
      : item
        ? {
            kind:
              item.kind === "edge"
                ? "relation"
                : item.kind === "subgraph"
                  ? "namespace"
                  : model.notes.some((n) => n.sourceKey === item.editKey)
                    ? "note"
                    : "class",
            key: item.editKey,
          }
        : null;
  if (
    selected?.kind === "relation" &&
    !model.relations.some((r) => r.sourceKey === selected?.key)
  )
    selected = null;
  const interfaceNode =
    selected?.kind === "class"
      ? model.nodes.find(
          (n) =>
            n.sourceKey === selected?.key && n.kind === "lollipop-interface",
        )
      : undefined;
  if (interfaceNode) {
    const relation = model.relations.find(
      (r) => r.from === interfaceNode.id || r.to === interfaceNode.id,
    );
    selected = relation ? { kind: "relation", key: relation.sourceKey } : null;
  }
  const visualModel = state.visualModel;
  let placement: { centerX: number; centerY: number } | null = null;
  return {
    surface: "controls",
    model,
    config: readClassConfig(model.sourceDocument).config,
    sourceBasis: source,
    selected,
    selectedKeys: member
      ? [member.id]
      : uniqueItems.map((item) => item.editKey),
    selectedAnchor: null,
    intent: null,
    parentIntent: null,
    groupAllowed:
      !member &&
      (classPageSelectionTools.containerAction?.validate({
        items: uniqueItems,
        visualModel,
      }).valid ??
        false),
    readonly: context.readonly,
    displayOnly: false,
    embedded: false,
    embeddedEditing: false,
    workarea: null,
    workareaFooter: null,
    markersInClientSpace: true,
    commentMarkers: classCommentMarkers(model, (kind, key) => {
      const element =
        kind === "detail"
          ? state.owner.childIds
              .map((id) => state.owner.surface?.getElementById(id))
              .find(
                (child) => readMermaidGfxMeta(child, "mermaidDetailId") === key,
              )
          : kind === "node"
            ? getMermaidGfxNode(context.store, state.owner, key ?? "")
            : kind === "edge"
              ? getMermaidGfxConnector(context.store, state.owner, key ?? "")
              : kind === "subgraph"
                ? getMermaidGfxSubgraph(context.store, state.owner, key ?? "")
                : state.owner;
      if (!element?.xywh) return null;
      const bound = Bound.deserialize(element.xywh),
        rect = context.gfx.viewport.boundingClientRect;
      const [left, top] = context.gfx.viewport.toViewCoord(bound.maxX, bound.y);
      return { left: left + rect.left, top: top + rect.top };
    }),
    getImpact: (value) => classSelectionImpact(model, value),
    resolveMemberInsertAnchor: (key) => {
      const element = state.owner.childIds
        .map((id) => state.owner.surface?.getElementById(id))
        .find((child) => readMermaidGfxMeta(child, "mermaidDetailId") === key);
      if (!element?.xywh) return null;
      const bound = Bound.deserialize(element.xywh),
        rect = context.gfx.viewport.boundingClientRect;
      const [left, top] = context.gfx.viewport.toViewCoord(bound.maxX, bound.y);
      return { left: left + rect.left, top: top + rect.top };
    },
    onOpenLink: (key) => openClassLink(model, key),
    onCommand: createClassCommandConsumer({
      getPlacement: () => placement,
      clearPlacement: () => {
        placement = null;
      },
      getSource: () => getMermaidBlockSource(state.owner.props),
      getReadonly: () => context.store.readonly,
      getVisualModel: () =>
        getMermaidVisualModelForEditing(context.std, state.owner) ??
        visualModel,
      applyVisualModel: (visual, options) => {
        let feedback: { applied: boolean; diagnostic?: string } = {
          applied: false,
        };
        const applied = runMermaidEdgelessMutation(context, state.owner, () => {
          const [ok, result] = context.command.exec(
            applyMermaidVisualModelCommand,
            {
              model: state.owner,
              visualModel: visual,
              sourceWrite: options?.sourceWrite,
            },
          );
          feedback = {
            applied: Boolean(ok && result?.applied),
            diagnostic: result?.diagnostic,
          };
          return feedback.applied;
        });
        return { ...feedback, applied };
      },
      onMemberIntent: (value) => {
        const element = state.owner.childIds
          .map((id) => state.owner.surface?.getElementById(id))
          .find(
            (child) =>
              readMermaidGfxMeta(child, "mermaidDetailSourceKey") === value.id,
          );
        if (element)
          context.gfx.selection.set({ editing: false, elements: [element.id] });
      },
      selectAfterProjection: (value) => {
        const element =
          value.kind === "node"
            ? getMermaidGfxNode(context.store, state.owner, value.editKey)
            : value.kind === "edge"
              ? getMermaidGfxConnector(
                  context.store,
                  state.owner,
                  value.editKey,
                )
              : getMermaidGfxSubgraph(
                  context.store,
                  state.owner,
                  value.editKey,
                );
        if (element)
          context.gfx.selection.set({ editing: false, elements: [element.id] });
      },
    }),
    subscribeEditIntent: (handler) => {
      const listener = (event: Event) => {
        const intent = (event as CustomEvent<MermaidGfxObjectEditIntent>)
          .detail;
        if (intent) handler(intent);
      };
      context.host.addEventListener("mermaid-gfx-object-edit", listener);
      return () =>
        context.host.removeEventListener("mermaid-gfx-object-edit", listener);
    },
    requestPlacement: (onPlace, onCancel) => {
      const host = context.host;
      host.setAttribute("data-mermaid-placement-owner", state.owner.id);
      const dispose = () => {
        host.removeAttribute("data-mermaid-placement-owner");
        host.removeEventListener("pointerdown", place, true);
        host.removeEventListener("keydown", cancel, true);
      };
      const cancel = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          dispose();
          onCancel?.();
          event.preventDefault();
          event.stopPropagation();
        }
      };
      const place = (event: PointerEvent) => {
        if (
          event.button !== 0 ||
          context.store.readonly ||
          !event
            .composedPath()
            .some(
              (element) =>
                element instanceof HTMLElement &&
                (element.tagName === "MYOXUS-SURFACE" ||
                  element.tagName === "CANVAS" ||
                  element.classList.contains("edgeless-background") ||
                  element.classList.contains(
                    "edgeless-block-children-container",
                  )),
            )
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dispose();
        const [x, y] = context.gfx.viewport.toModelCoordFromClientCoord([
          event.clientX,
          event.clientY,
        ]);
        const current = getMermaidVisualModelForEditing(
            context.std,
            state.owner,
          ),
          first = current?.nodes[0];
        const element =
          first && getMermaidGfxNode(context.store, state.owner, first.id);
        const origin = element
          ? Bound.deserialize(element.xywh)
          : Bound.deserialize(state.owner.xywh);
        placement = {
          centerX: x - (first ? origin.x - first.x : origin.x),
          centerY: y - (first ? origin.y - first.y : origin.y),
        };
        onPlace(placement);
      };
      host.addEventListener("pointerdown", place, true);
      host.addEventListener("keydown", cancel, true);
      return dispose;
    },
    onParentIntent: () => {},
    onEditIntent: () => {},
    onCloseSelection: () => {},
    onWorkareaResize: () => {},
    onEmbeddedActionsInsetChange: () => {},
    resolveReturnFocusTarget: () => context.host,
  };
}
export const classEdgelessToolbar = {
  readonlySelection: true,
  actions: [
    {
      id: "mermaid-class.controls",
      label: mermaidMessages.controlsLabel(),
      control(context) {
        const props = nativeClassProps(context);
        return props
          ? (context.std
              .getOptional(MermaidFamilyReactHostIdentifier)
              ?.toolbarControl(mermaidClassRendererToken, props) ?? null)
          : null;
      },
    },
  ],
  suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  when: (context) => nativeClassProps(context) !== null,
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
