// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mindmapSubtree,
  mindmapChildIndent,
  mindmapNativeIndent,
} from "./tree-commands.js";
import type { MermaidMindmapModel, MermaidMindmapShape } from "../model.js";
import {
  serializeMindmapNode,
  isMindmapSyntaxId,
  mindmapShapeDelimiters,
  type MindmapLabelForm,
} from "../runtime-contract.js";
import {
  unchangedMindmap,
  writeMindmapPatches,
  type MindmapCommandOptions,
} from "../writer.js";
import { mindmapDecorationPatches } from "./decoration-commands.js";

export function editMindmapNode(
  model: MermaidMindmapModel,
  sourceKey: string,
  changes: {
    label?: string;
    shape?: MermaidMindmapShape;
    form?: MindmapLabelForm;
    syntaxId?: string;
    icon?: string;
    classes?: string;
  },
  options: MindmapCommandOptions = {},
) {
  const node = model.nodes.find((n) => n.sourceKey === sourceKey);
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey,
  );
  if (!node || !record?.node) return unchangedMindmap(model, "selection");
  const decorations = mindmapDecorationPatches(model, sourceKey, changes);
  if (!decorations) return unchangedMindmap(model, "syntax");
  if (
    (changes.label === undefined || changes.label === node.label) &&
    (changes.shape === undefined || changes.shape === node.shape) &&
    (changes.form === undefined || changes.form === node.syntax?.labelForm) &&
    (changes.syntaxId === undefined ||
      changes.syntaxId === record.node.syntaxId)
  ) {
    return writeMindmapPatches(model, decorations, options, sourceKey);
  }
  let syntax =
    changes.form && node.syntax
      ? {
          ...node.syntax,
          labelForm: changes.form,
          ...(changes.form === "bare" &&
          node.shape === "default" &&
          !node.syntax.syntaxId
            ? { open: "", close: "" }
            : {}),
        }
      : node.syntax;
  if (changes.syntaxId !== undefined) {
    const shape = changes.shape ?? node.shape;
    if (
      !isMindmapSyntaxId(changes.syntaxId) ||
      (!node.syntax?.open &&
        shape === "default" &&
        (changes.form ?? "bare") === "bare")
    )
      return unchangedMindmap(model, "syntax");
    const [open, close] = mindmapShapeDelimiters[shape];
    syntax = {
      syntaxId: changes.syntaxId,
      labelForm: changes.form ?? node.syntax?.labelForm ?? "bare",
      open: node.syntax?.open || open || "(-",
      close: node.syntax?.close || close || "-)",
    };
  }
  if (
    changes.form === "bare" &&
    node.syntax?.labelForm !== "bare" &&
    (changes.shape ?? node.shape) === "default"
  ) {
    const id =
      changes.syntaxId ?? (record.node.open ? record.node.syntaxId : "");
    // Native DEFAULT accepts (- with a plain ) terminator. Using -) for a
    // bare description would make its dash part of the label in the lexer.
    syntax = {
      syntaxId: id,
      labelForm: "bare",
      open: id ? "(-" : "",
      close: id ? ")" : "",
    };
  }
  const next = serializeMindmapNode({
    ...node,
    label: changes.label ?? node.label,
    shape: changes.shape ?? node.shape,
    syntax,
  });
  if (next === null) return unchangedMindmap(model, "syntax");
  const current = model.sourceDocument.source.slice(
    record.range.start + record.indent.length,
    record.range.end,
  );
  const replacement = next.replace(/\r\n?|\n/g, model.sourceDocument.newline);
  let prefix = 0,
    suffix = 0;
  while (
    prefix < Math.min(current.length, replacement.length) &&
    current[prefix] === replacement[prefix]
  )
    prefix++;
  while (
    suffix < Math.min(current.length, replacement.length) - prefix &&
    current.at(-suffix - 1) === replacement.at(-suffix - 1)
  )
    suffix++;
  const start = record.range.start + record.indent.length;
  return writeMindmapPatches(
    model,
    [
      ...decorations,
      {
        start: start + prefix,
        end: record.range.end - suffix,
        text: replacement.slice(prefix, replacement.length - suffix),
        identities:
          prefix === 0 && !record.indent ? [[0, sourceKey]] : undefined,
      },
    ],
    options,
    sourceKey,
  );
}

export function renameMermaidMindmapNode(
  model: MermaidMindmapModel,
  nodeId: string,
  label: string,
) {
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  return node ? editMindmapNode(model, node.sourceKey, { label }).model : model;
}

export function setMermaidMindmapNodeShape(
  model: MermaidMindmapModel,
  nodeId: string,
  shape: MermaidMindmapShape,
) {
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  return node ? editMindmapNode(model, node.sourceKey, { shape }).model : model;
}

export type MindmapNodeCreationOptions = MindmapCommandOptions & {
  /** A transient preview may reserve the new occurrence's opaque key. */
  sourceKey?: string;
};

export function addMindmapNode(
  model: MermaidMindmapModel,
  label: string,
  parentKey?: string,
  shape: MermaidMindmapShape = "default",
  options: MindmapNodeCreationOptions = {},
) {
  const parent = parentKey
    ? model.nodes.find((n) => n.sourceKey === parentKey)
    : undefined;
  if ((parentKey && !parent) || (!parentKey && model.nodes.length))
    return unchangedMindmap(model, "tree");
  const target = parent
    ? mindmapSubtree(model, parent.sourceKey)!.end
    : model.sourceDocument.source.length;
  const indent = parent ? mindmapChildIndent(model, parent) : "";
  return insertMindmapNode(model, label, shape, target, indent, options);
}

/** A sibling follows the complete selected subtree, retaining its trailing
 * comments/decorators and its authored indentation. A root has no sibling. */
export function addMindmapSibling(
  model: MermaidMindmapModel,
  label: string,
  key: string,
  shape: MermaidMindmapShape = "default",
  options: MindmapNodeCreationOptions = {},
) {
  const subtree = mindmapSubtree(model, key);
  if (!subtree || subtree.root.root) return unchangedMindmap(model, "tree");
  return insertMindmapNode(
    model,
    label,
    shape,
    subtree.end,
    mindmapNativeIndent(model, key),
    options,
  );
}

function insertMindmapNode(
  model: MermaidMindmapModel,
  label: string,
  shape: MermaidMindmapShape,
  target: number,
  indent: string,
  options: MindmapNodeCreationOptions,
) {
  const syntax = serializeMindmapNode({ label, shape });
  if (!syntax) return unchangedMindmap(model, "syntax");
  const prefix =
    target > 0 && !/[\r\n]/.test(model.sourceDocument.source[target - 1])
      ? model.sourceDocument.newline
      : "";
  const key = options.sourceKey ?? `mindmap-source-${crypto.randomUUID()}`;
  if (
    !key.trim() ||
    model.sourceDocument.records.some((record) => record.sourceKey === key)
  )
    return unchangedMindmap(model, "selection");
  return writeMindmapPatches(
    model,
    [
      {
        start: target,
        end: target,
        text: prefix + indent + syntax + model.sourceDocument.newline,
        identities: [[prefix.length, key]],
      },
    ],
    options,
    key,
  );
}
