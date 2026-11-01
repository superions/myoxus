// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  applyMermaidVisualModelCommand,
  mermaidMessages as m,
  getMermaidBlockSource,
  getMermaidVisualModel,
  getMermaidGfxNode,
  recordMermaidSelectionHistory,
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  prepareMindmapTree,
  mindmapSourceOutline,
  prepareMindmapTreeUpdate,
  projectMindmapTree,
  readMermaidSourceLimit,
  readMindmapProjectionModel,
  readMindmapProjectionOptions,
} from "@virgultum/block-mermaid";
import { MermaidBlockModel } from "@virgultum/editor/model";
import type { EditorHost } from "@virgultum/editor/std";
import {
  GfxPrimitiveElementModel,
  GfxControllerIdentifier,
  type GfxModel,
} from "@virgultum/editor/std/gfx";
import { editorToast } from "@virgultum/editor/shared/utils";
import { getAIPanelWidget } from "../utils/ai-widgets";
import { getSelections } from "../utils/selection-utils";
import type { AIContext } from "../utils/context";

export type MindmapSourceBasis = {
  ownerId: string;
  source: string;
  key: string;
};

export function sourceMindmapSelection(element?: GfxModel) {
  const owner = element instanceof MermaidBlockModel ? element : element?.group;
  if (!(owner instanceof MermaidBlockModel)) return null;
  const source = getMermaidBlockSource(owner.props);
  const visual = getMermaidVisualModel(owner);
  if (visual?.diagramType !== "mindmap") return null;
  const model = readMindmapProjectionModel(source, visual);
  if (!model?.nodes.length) return null;
  const key =
    element === owner
      ? model.nodes[0].sourceKey
      : element instanceof GfxPrimitiveElementModel
        ? element.yMap.get("mermaidNodeId")
        : undefined;
  const node = model.nodes.find((node) => node.sourceKey === key);
  if (!node) return null;
  return {
    owner,
    source,
    model,
    node,
    projection: readMindmapProjectionOptions(visual),
  };
}

/** Capture before streaming; acceptance must never overwrite a newer Source. */
export function captureMindmapSourceBasis(
  element?: GfxModel,
): MindmapSourceBasis | undefined {
  const selection = sourceMindmapSelection(element);
  return selection
    ? {
        ownerId: selection.owner.id,
        source: selection.source,
        key: selection.node.sourceKey,
      }
    : undefined;
}

export function sourceMindmapOutline(
  selection: NonNullable<ReturnType<typeof sourceMindmapSelection>>,
) {
  return mindmapSourceOutline(selection.model);
}

const pendingAcceptances = new WeakSet<AIContext>();

export async function acceptSourceMindmap(
  host: EditorHost,
  ctx: AIContext,
  target:
    | { kind: "page"; place: "after" | "before" }
    | { kind: "native"; x: number; y: number }
    | { kind: "expand" },
) {
  const state = ctx.get();
  const panel = getAIPanelWidget(host);
  const panelConfig = panel.config;
  const panelIsCurrent = () =>
    panel.state !== "hidden" && panel.config === panelConfig;
  if (
    !state.node ||
    host.store.readonly ||
    !panelIsCurrent() ||
    pendingAcceptances.has(ctx)
  )
    return false;
  pendingAcceptances.add(ctx);
  try {
    const maxTextSize = await readMermaidSourceLimit();
    if (
      host.store.readonly ||
      ctx.get().node !== state.node ||
      !panelIsCurrent()
    )
      return false;
    const reject = () => {
      editorToast(host, m.chartSourceChanged());
      return false;
    };
    const prepared = prepareMindmapTree(state.node, maxTextSize, state.style);
    const basis = state.mindmapSourceBasis;
    if (basis) {
      const owner = host.store.getBlock(basis.ownerId)?.model;
      if (
        !(owner instanceof MermaidBlockModel) ||
        owner.isLocked() ||
        getMermaidBlockSource(owner.props) !== basis.source
      )
        return reject();
      const visual = getMermaidVisualModel(owner);
      const model = readMindmapProjectionModel(
        basis.source,
        visual ?? undefined,
      );
      if (!model) return false;
      const result = prepareMindmapTreeUpdate(
        model,
        prepared,
        basis.key,
        target.kind !== "expand",
      );
      if (!result?.changed || result.source.length > maxTextSize)
        return reject();
      const options = readMindmapProjectionOptions(visual ?? undefined);
      const collapsed = new Set(options.collapsed);
      const byId = new Map(result.model.nodes.map((node) => [node.id, node]));
      const selectedKey =
        target.kind === "expand"
          ? result.selection
          : result.model.nodes[0]?.sourceKey;
      let selectedNode = result.model.nodes.find(
        (node) => node.sourceKey === selectedKey,
      );
      while (selectedNode) {
        collapsed.delete(selectedNode.sourceKey);
        selectedNode = selectedNode.parentId
          ? byId.get(selectedNode.parentId)
          : undefined;
      }
      const projection = {
        ...options,
        collapsed,
        ...(state.style === undefined ? {} : { design: state.style }),
      };
      const [, applied] = host.std.command.exec(
        applyMermaidVisualModelCommand,
        {
          model: owner,
          sourceWrite: { baseSource: basis.source, source: result.source },
          visualModel: projectMindmapTree(result.model, projection),
        },
      );
      if (!applied.applied) return false;
      recordMermaidSelectionHistory(host.store, owner.id, {
        before: [{ kind: "node", editKey: basis.key }],
        after: selectedKey ? [{ kind: "node", editKey: selectedKey }] : [],
      });
      const selected =
        selectedKey && getMermaidGfxNode(host.store, owner, selectedKey);
      host.std.get(GfxControllerIdentifier).selection.set({
        elements: [selected ? selected.id : owner.id],
        editing: false,
      });
      return true;
    }
    if (target.kind === "expand") return false;
    const options = {
      source: prepared.source,
      visualModel: prepared.visualModel,
    };
    const [, inserted] =
      target.kind === "page"
        ? host.std.command.exec(insertMermaidBlockCommand, {
            ...options,
            selectedModels: getSelections(host).selectedBlocks?.map(
              (block) => block.model,
            ),
            place: target.place,
          })
        : host.std.command.exec(insertMermaidEdgelessDiagramCommand, {
            ...options,
            position: target,
          });
    return Boolean(inserted.insertedMermaidBlockId);
  } catch {
    if (panelIsCurrent())
      editorToast(host, m.visualMutationSourceRejected("mindmap"));
    return false;
  } finally {
    pendingAcceptances.delete(ctx);
  }
}
