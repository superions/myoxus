// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  unchangedMindmap,
  editMindmapNativeConfig,
  addMindmapNode,
  deleteMindmapSubtrees,
  pasteMindmapSubtrees,
  duplicateMindmapSubtrees,
  type MindmapCopiedSubtree,
  addMindmapSibling,
  moveMindmapSubtree,
  editMindmapNode,
  editMindmapComment,
  removeMindmapComment,
  type MermaidMindmapModel,
  type MermaidMindmapShape,
  type MindmapCommandResult,
  type MindmapLabelForm,
} from "../../engine/mindmap/index.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { mermaidMessages as m } from "../../i18n.js";
import type { MindmapEditIntent } from "./react-host-contract.js";
import type { MermaidFamilyActionModel } from "../runtime/shell-contract.js";
import type { MindmapLayoutType as LayoutType } from "./projection/types.js";

export type MindmapAction =
  | import("./projection/options.js").MindmapSettingsAction
  | {
      type: "paste";
      parentKey: string;
      copies: readonly MindmapCopiedSubtree[];
      projection: import("./projection/layout.js").MindmapProjectionOptions;
    }
  | { type: "duplicate"; keys: readonly string[] }
  | { type: "delete"; keys: readonly string[] }
  | {
      type: "move";
      key: string;
      parentKey: string;
      beforeKey?: string;
      side?: LayoutType.LEFT | LayoutType.RIGHT;
      /** Explicit side selection enables BALANCE; ordinary drags retain layout. */
      balanced?: boolean;
    }
  | {
      type: "comment";
      key?: string;
      text: string;
      anchorKey?: string;
      position?: "before" | "after";
    }
  | { type: "remove-comment"; key: string }
  | { type: "add-root"; label: string; sourceKey?: string }
  | {
      type: "add-child" | "add-sibling";
      side?: LayoutType.LEFT | LayoutType.RIGHT;
      key: string;
      label: string;
      sourceKey?: string;
    }
  | {
      type: "rename";
      key: string;
      label: string;
      shape?: MermaidMindmapShape;
      form?: MindmapLabelForm;
      syntaxId?: string;
      icon?: string;
      classes?: string;
    };
export function runMindmapAction(
  model: MermaidMindmapModel,
  action: MindmapAction,
): MindmapCommandResult & { keyMap?: ReadonlyMap<string, string> } {
  switch (action.type) {
    case "settings":
      return action.nativeConfig
        ? editMindmapNativeConfig(model, action.nativeConfig)
        : unchangedMindmap(model);
    case "paste":
      return pasteMindmapSubtrees(model, action.parentKey, action.copies);
    case "duplicate":
      return duplicateMindmapSubtrees(model, action.keys);
    case "delete":
      return deleteMindmapSubtrees(model, action.keys);
    case "move":
      return moveMindmapSubtree(
        model,
        action.key,
        action.parentKey,
        action.beforeKey,
      );
    case "comment":
      return editMindmapComment(model, action);
    case "remove-comment":
      return removeMindmapComment(model, action.key);
    case "add-root":
      return addMindmapNode(model, action.label, undefined, "default", {
        sourceKey: action.sourceKey,
      });
    case "add-child":
      return addMindmapNode(model, action.label, action.key, "default", {
        sourceKey: action.sourceKey,
      });
    case "add-sibling":
      return addMindmapSibling(model, action.label, action.key, "default", {
        sourceKey: action.sourceKey,
      });
    case "rename":
      return editMindmapNode(model, action.key, {
        label: action.label,
        shape: action.shape,
        form: action.form,
        syntaxId: action.syntaxId,
        icon: action.icon,
        classes: action.classes,
      });
  }
}
export const mindmapPageSelectionTools: MermaidPageSelectionToolsContribution =
  {
    boxSelectableKinds: ["node"],
    selectableKinds: ["node"],
    selectAllKinds: ["node"],
    operations: {
      deleteSelection: true,
      duplicateSelection: true,
      moveSelection: false,
    },
    resolveItems: (model) =>
      model.nodes.map((node) => ({ kind: "node", editKey: node.id })),
  };

/** One action contribution for Page, the local 3E slot and native root toolbar. */
export function mindmapControlActions(
  model: MermaidMindmapModel,
  selectedKey: string | null,
  readonly: boolean,
  open: (intent: MindmapEditIntent) => void,
  collapsed: ReadonlySet<string> = new Set(),
): Array<
  MermaidFamilyActionModel & {
    intent: MindmapEditIntent | null;
    disabledReason?: string;
  }
> {
  const selectedNode = model.nodes.find(
    (node) => node.sourceKey === selectedKey,
  );
  const intents: Array<{
    intent: MindmapEditIntent | null;
    id: string;
    label: string;
    disabledReason?: string;
  }> = model.nodes.length
    ? [
        {
          id: "mindmap.add-child",
          label: m.addChild(),
          intent: selectedKey ? { type: "add-child", key: selectedKey } : null,
        },
        {
          id: "mindmap.add-sibling",
          label: m.addSibling(),
          intent:
            selectedKey &&
            !model.nodes.find((node) => node.sourceKey === selectedKey)?.root
              ? { type: "add-sibling", key: selectedKey }
              : null,
          disabledReason:
            selectedKey &&
            model.nodes.find((node) => node.sourceKey === selectedKey)?.root
              ? m.mindmapRootNoSibling()
              : undefined,
        },
        {
          id: "mindmap.rename",
          label: m.actionRename(),
          intent: selectedKey ? { type: "rename", key: selectedKey } : null,
        },
        {
          id: "mindmap.move",
          label: m.treemapMove(),
          intent:
            selectedKey &&
            !model.nodes.find((node) => node.sourceKey === selectedKey)?.root
              ? { type: "move", key: selectedKey }
              : null,
        },
        {
          id: "mindmap.collapse",
          label: collapsed.has(selectedKey ?? "") ? m.expand() : m.collapse(),
          intent:
            selectedKey &&
            model.nodes.some((node) => node.parentId === selectedNode?.id)
              ? { type: "toggle-collapse", key: selectedKey }
              : null,
        },
        {
          id: "mindmap.properties",
          label: m.visualInspector(),
          intent: selectedKey ? { type: "properties", key: selectedKey } : null,
        },
      ]
    : [
        {
          id: "mindmap.add-root",
          label: m.addRoot(),
          intent: { type: "add-root" },
        },
      ];
  intents.push({
    id: "mindmap.layout",
    label: m.layoutLabel(),
    intent: { type: "layout" },
  });
  intents.push({
    id: "mindmap.import",
    label: m.mindmapImport(),
    intent: { type: "import" },
  });
  return intents.map((action) => ({
    ...action,
    disabled: readonly || !action.intent,
    onSelect: () => {
      if (!readonly && action.intent) open(action.intent);
    },
  }));
}
