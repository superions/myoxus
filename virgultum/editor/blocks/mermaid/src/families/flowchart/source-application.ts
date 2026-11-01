// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  EDGE_ID_PREFIX_RE,
  flowchartEdgeLabelSource,
  flowchartEdgeTokenSource,
  flowchartNodeSource,
  flowchartSubgraphSource,
  isFlowchartStyleStatement,
  parseFlowchartEdgeTokenWithLabel,
  parseFlowchartNodeToken,
  parseMermaidSourceToVisualModel,
  type ParsedFlowchartNodeToken,
} from "../../engine/flowchart.js";
import { generateMermaidSourceFromVisualModel } from "../../engine/flowchart-writer.js";
import {
  flowchartModelData,
  type MermaidFlowchartComment,
} from "../../engine/flowchart-model.js";
import { getMermaidSourceHeaderIndex } from "../../engine/diagram-types.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";

type FlowchartStatementEdgeRange = {
  end: number;
  explicitId?: string;
  start: number;
};

type FlowchartStatementRanges = {
  edges: FlowchartStatementEdgeRange[];
  nodes: ParsedFlowchartNodeToken[];
};

function skipWhitespace(input: string, start: number) {
  let index = start;
  while (/\s/.test(input[index] ?? "")) index += 1;
  return index;
}

function statementRanges(input: string): FlowchartStatementRanges {
  const source = parseFlowchartNodeToken(input);
  if (!source) return { edges: [], nodes: [] };
  const nodes = [source];
  const edges: FlowchartStatementEdgeRange[] = [];
  let cursor = source.end;
  while (cursor < input.length) {
    const edgeStart = skipWhitespace(input, cursor);
    if (
      !input.slice(edgeStart).trim() ||
      input.slice(edgeStart).trim() === ";"
    ) {
      break;
    }
    const edgeIdMatch = EDGE_ID_PREFIX_RE.exec(input.slice(edgeStart));
    const tokenStart = edgeStart + (edgeIdMatch?.[0].length ?? 0);
    const edge = parseFlowchartEdgeTokenWithLabel(input.slice(tokenStart));
    if (!edge) return { edges: [], nodes: [] };
    const target = parseFlowchartNodeToken(input, tokenStart + edge.end);
    if (!target) return { edges: [], nodes: [] };
    edges.push({
      end: target.start,
      explicitId: edgeIdMatch?.[1],
      start: edgeStart,
    });
    nodes.push(target);
    cursor = target.end;
  }
  return { edges, nodes };
}

function applyLineReplacements(
  line: string,
  replacements: Array<{ end: number; start: number; value: string }>,
) {
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, replacement) =>
        `${current.slice(0, replacement.start)}${replacement.value}${current.slice(replacement.end)}`,
      line,
    );
}

function explicitSubgraphHeader(input: string) {
  return /^([A-Za-z0-9_][\w-]*)\s*\[([\s\S]*)\]$/.test(input.trim());
}

function stabilizeSourceIdentities(source: string, model: MermaidVisualModel) {
  const lines = source.split("\n");
  let edgeIndex = 0;
  let subgraphIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const subgraphMatch = /^(\s*subgraph\s+)([\s\S]+)$/.exec(line);
    if (subgraphMatch?.[1] && subgraphMatch[2]) {
      const subgraph = model.subgraphs?.[subgraphIndex];
      subgraphIndex += 1;
      if (subgraph && !explicitSubgraphHeader(subgraphMatch[2])) {
        lines[index] =
          `${subgraphMatch[1]}${flowchartSubgraphSource(subgraph)}`;
      }
      continue;
    }

    const ranges = statementRanges(line);
    const replacements: Array<{ end: number; start: number; value: string }> =
      [];
    for (const range of ranges.edges) {
      const edge = model.edges[edgeIndex];
      edgeIndex += 1;
      if (!edge || range.explicitId) continue;
      replacements.push({
        end: range.start,
        start: range.start,
        value: `${edge.id}@`,
      });
    }
    if (replacements.length) {
      lines[index] = applyLineReplacements(line, replacements);
    }
  }
  return lines.join("\n");
}

function sameEdgeToken(left: MermaidVisualEdge, right: MermaidVisualEdge) {
  return (
    left.label === right.label &&
    left.linkType === right.linkType &&
    left.style === right.style &&
    left.sourceMarker === right.sourceMarker &&
    left.targetMarker === right.targetMarker &&
    (left.mermaidId ?? left.id) === (right.mermaidId ?? right.id)
  );
}

function updateOwnedSourceRanges(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  const nextSubgraphs = new Map(
    (next.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  const lines = source.split("\n");
  const nodesWithExplicitSource = new Set<string>();
  for (const line of lines) {
    for (const token of statementRanges(line).nodes) {
      if (token.explicit) nodesWithExplicitSource.add(token.id);
    }
  }
  const emittedImplicitNodeIds = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const subgraphMatch =
      /^(\s*subgraph\s+)([A-Za-z0-9_][\w-]*)([\s\S]*)$/.exec(line);
    if (subgraphMatch?.[1] && subgraphMatch[2]) {
      const previousSubgraph = previous.subgraphs?.find(
        (subgraph) => subgraph.id === subgraphMatch[2],
      );
      const nextSubgraph = nextSubgraphs.get(subgraphMatch[2]);
      if (
        previousSubgraph &&
        nextSubgraph &&
        previousSubgraph.title !== nextSubgraph.title
      ) {
        lines[index] =
          `${subgraphMatch[1]}${flowchartSubgraphSource(nextSubgraph)}`;
      }
      continue;
    }

    const ranges = statementRanges(line);
    const replacements: Array<{ end: number; start: number; value: string }> =
      [];
    for (const token of ranges.nodes) {
      const previousNode = previousNodes.get(token.id);
      const nextNode = nextNodes.get(token.id);
      if (
        !previousNode ||
        !nextNode ||
        (previousNode.label === nextNode.label &&
          previousNode.shape === nextNode.shape &&
          JSON.stringify(previousNode.familyData) ===
            JSON.stringify(nextNode.familyData))
      ) {
        continue;
      }
      const ownsDefinition =
        token.explicit ||
        (!nodesWithExplicitSource.has(token.id) &&
          !emittedImplicitNodeIds.has(token.id));
      if (!ownsDefinition) continue;
      emittedImplicitNodeIds.add(token.id);
      replacements.push({
        end: token.end,
        start: token.start,
        value: flowchartNodeSource(nextNode),
      });
    }
    for (const range of ranges.edges) {
      const edgeId = range.explicitId;
      const previousEdge = edgeId
        ? previous.edges.find((edge) => edge.id === edgeId)
        : undefined;
      const nextEdge = edgeId ? nextEdges.get(edgeId) : undefined;
      if (!previousEdge || !nextEdge || sameEdgeToken(previousEdge, nextEdge)) {
        continue;
      }
      const label = nextEdge.label
        ? ` |${flowchartEdgeLabelSource(nextEdge.label)}|`
        : "";
      replacements.push({
        end: range.end,
        start: range.start,
        value: `${flowchartEdgeTokenSource(nextEdge)}${label} `,
      });
    }
    if (replacements.length) {
      lines[index] = applyLineReplacements(line, replacements);
    }
  }
  return updateSubgraphDirectionRanges(
    updateStyleStatementRanges(lines.join("\n"), previous, next),
    previous,
    next,
  );
}

function updateSubgraphDirectionRanges(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  const previousSubgraphs = new Map(
    (previous.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  const nextSubgraphs = new Map(
    (next.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  const lines = source.split("\n");
  const stack: string[] = [];
  const headerLineById = new Map<string, number>();
  const directionLineById = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = /^\s*subgraph\s+([A-Za-z0-9_][\w-]*)/.exec(line);
    if (header?.[1]) {
      stack.push(header[1]);
      headerLineById.set(header[1], index);
      continue;
    }
    if (/^\s*end\s*;?\s*$/.test(line)) {
      stack.pop();
      continue;
    }
    if (/^\s*direction\s+(?:TD|TB|BT|LR|RL)\s*;?\s*$/.test(line)) {
      const subgraphId = stack.at(-1);
      if (subgraphId) directionLineById.set(subgraphId, index);
    }
  }

  const insertions: Array<{ index: number; value: string }> = [];
  for (const [subgraphId, nextSubgraph] of nextSubgraphs) {
    const previousSubgraph = previousSubgraphs.get(subgraphId);
    if (
      !previousSubgraph ||
      previousSubgraph.direction === nextSubgraph.direction
    ) {
      continue;
    }
    const directionLine = directionLineById.get(subgraphId);
    if (directionLine !== undefined) {
      if (nextSubgraph.direction) {
        lines[directionLine] = lines[directionLine].replace(
          /(\bdirection\s+)(?:TD|TB|BT|LR|RL)/,
          `$1${nextSubgraph.direction}`,
        );
      } else {
        lines.splice(directionLine, 1);
      }
      continue;
    }
    const headerLine = headerLineById.get(subgraphId);
    if (headerLine === undefined || !nextSubgraph.direction) continue;
    const indent = /^(\s*)/.exec(lines[headerLine])?.[1] ?? "";
    insertions.push({
      index: headerLine + 1,
      value: `${indent}  direction ${nextSubgraph.direction}`,
    });
  }
  for (const insertion of insertions.sort(
    (left, right) => right.index - left.index,
  )) {
    lines.splice(insertion.index, 0, insertion.value);
  }
  return lines.join("\n");
}

type FlowchartSubgraphSourceBlock = {
  end: number;
  id: string;
  indent: string;
  parentId?: string;
  start: number;
};

function flowchartSubgraphSourceBlocks(source: string) {
  const blocks: FlowchartSubgraphSourceBlock[] = [];
  const stack: Array<Omit<FlowchartSubgraphSourceBlock, "end">> = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(\s*)subgraph\s+([A-Za-z0-9_][\w-]*)/.exec(lines[index]);
    if (header?.[1] !== undefined && header[2]) {
      stack.push({
        id: header[2],
        indent: header[1],
        parentId: stack.at(-1)?.id,
        start: index,
      });
      continue;
    }
    if (!/^\s*end\s*;?\s*$/.test(lines[index])) continue;
    const block = stack.pop();
    if (block) blocks.push({ ...block, end: index });
  }
  return blocks;
}

function subgraphStructureComparable(subgraph: MermaidVisualSubgraph) {
  return {
    direction: subgraph.direction,
    id: subgraph.id,
    nodeIds: [...subgraph.nodeIds].sort(),
    title: subgraph.title,
  };
}

function updateSubgraphBlockStructure(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  const previousSubgraphs = previous.subgraphs ?? [];
  const nextSubgraphs = next.subgraphs ?? [];
  if (!sameIds(previousSubgraphs, nextSubgraphs)) return null;
  const previousById = new Map(
    previousSubgraphs.map((subgraph) => [subgraph.id, subgraph]),
  );
  if (
    nextSubgraphs.some((subgraph) => {
      const previousSubgraph = previousById.get(subgraph.id);
      return (
        !previousSubgraph ||
        JSON.stringify(subgraphStructureComparable(previousSubgraph)) !==
          JSON.stringify(subgraphStructureComparable(subgraph))
      );
    })
  ) {
    return null;
  }

  const parentChanged = nextSubgraphs.find(
    (subgraph) => previousById.get(subgraph.id)?.parentId !== subgraph.parentId,
  );
  const previousOrder = previousSubgraphs.map(({ id }) => id);
  const nextOrder = nextSubgraphs.map(({ id }) => id);
  const reorderedId = nextOrder.find(
    (id, index) => previousOrder[index] !== id,
  );
  const movedId = parentChanged?.id ?? reorderedId;
  if (!movedId) return null;
  if (
    nextSubgraphs.some(
      (subgraph) =>
        subgraph.id !== movedId &&
        previousById.get(subgraph.id)?.parentId !== subgraph.parentId,
    )
  ) {
    return null;
  }

  const originalBlocks = flowchartSubgraphSourceBlocks(source);
  const movedBlock = originalBlocks.find(({ id }) => id === movedId);
  if (!movedBlock) return null;
  const lines = source.split("\n");
  const movedLines = lines.splice(
    movedBlock.start,
    movedBlock.end - movedBlock.start + 1,
  );
  const withoutMoved = lines.join("\n");
  const remainingBlocks = flowchartSubgraphSourceBlocks(withoutMoved);
  const movedSubgraph = nextSubgraphs.find(({ id }) => id === movedId);
  if (!movedSubgraph) return null;
  const siblings = nextSubgraphs.filter(
    (subgraph) => subgraph.parentId === movedSubgraph.parentId,
  );
  const siblingIndex = siblings.findIndex(({ id }) => id === movedId);
  const nextSibling = siblings[siblingIndex + 1];
  const nextSiblingBlock = nextSibling
    ? remainingBlocks.find(({ id }) => id === nextSibling.id)
    : undefined;
  const parentBlock = movedSubgraph.parentId
    ? remainingBlocks.find(({ id }) => id === movedSubgraph.parentId)
    : undefined;
  let insertionIndex: number;
  if (nextSiblingBlock) {
    insertionIndex = nextSiblingBlock.start;
  } else if (parentBlock) {
    insertionIndex = parentBlock.end;
  } else {
    const previousSibling = siblings[siblingIndex - 1];
    const previousSiblingBlock = previousSibling
      ? remainingBlocks.find(({ id }) => id === previousSibling.id)
      : undefined;
    insertionIndex = previousSiblingBlock ? previousSiblingBlock.end + 1 : 1;
  }
  const targetIndent = parentBlock
    ? `${parentBlock.indent}  `
    : (remainingBlocks.find((block) => !block.parentId)?.indent ?? "  ");
  const reindented = movedLines.map((line) => {
    if (!line.trim()) return line;
    const relative = line.startsWith(movedBlock.indent)
      ? line.slice(movedBlock.indent.length)
      : line.trimStart();
    return `${targetIndent}${relative}`;
  });
  lines.splice(insertionIndex, 0, ...reindented);
  return lines.join("\n");
}

function nodeOwnerById(model: MermaidVisualModel) {
  const owners = new Map<string, string>();
  for (const subgraph of model.subgraphs ?? []) {
    for (const nodeId of subgraph.nodeIds) owners.set(nodeId, subgraph.id);
  }
  return owners;
}

function updateNodeMembershipRanges(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  if (!sameIds(previous.nodes, next.nodes)) return null;
  const previousOwners = nodeOwnerById(previous);
  const nextOwners = nodeOwnerById(next);
  const movedNodeIds = previous.nodes
    .map(({ id }) => id)
    .filter((id) => previousOwners.get(id) !== nextOwners.get(id));
  if (movedNodeIds.length === 0) return null;
  const lines = source.split("\n");
  const blocks = flowchartSubgraphSourceBlocks(source);
  const lineByNodeId = new Map<
    string,
    { index: number; indent: string; value: string }
  >();
  for (let index = 0; index < lines.length; index += 1) {
    const ranges = statementRanges(lines[index]);
    if (ranges.edges.length || ranges.nodes.length !== 1) continue;
    const node = ranges.nodes[0];
    const suffix = lines[index].slice(node.end).trim();
    const ownerId = blocks
      .filter((block) => index > block.start && index < block.end)
      .sort(
        (left, right) => left.end - left.start - (right.end - right.start),
      )[0]?.id;
    if (
      !movedNodeIds.includes(node.id) ||
      ownerId !== previousOwners.get(node.id) ||
      (suffix && suffix !== ";")
    ) {
      continue;
    }
    lineByNodeId.set(node.id, {
      index,
      indent: /^(\s*)/.exec(lines[index])?.[1] ?? "",
      value: lines[index],
    });
  }
  if (movedNodeIds.some((id) => !lineByNodeId.has(id))) return null;

  const removed = movedNodeIds
    .map((id) => ({ id, ...lineByNodeId.get(id)! }))
    .sort((left, right) => right.index - left.index);
  for (const item of removed) lines.splice(item.index, 1);

  for (const item of [...removed].reverse()) {
    const targetId = nextOwners.get(item.id) ?? "";
    const remainingSource = lines.join("\n");
    const blocks = flowchartSubgraphSourceBlocks(remainingSource);
    const targetBlock = targetId
      ? blocks.find(({ id }) => id === targetId)
      : undefined;
    const targetIndent = targetBlock
      ? `${targetBlock.indent}  `
      : (blocks.find((block) => !block.parentId)?.indent ?? item.indent);
    const relative = item.value.startsWith(item.indent)
      ? item.value.slice(item.indent.length)
      : item.value.trimStart();
    const insertionIndex = targetBlock
      ? targetBlock.end
      : Math.max(
          1,
          ...blocks
            .filter((block) => !block.parentId)
            .map((block) => block.end + 1),
        );
    lines.splice(insertionIndex, 0, `${targetIndent}${relative}`);
  }
  return lines.join("\n");
}

function insertCreatedSubgraphRange(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  const previousIds = new Set(
    (previous.subgraphs ?? []).map((subgraph) => subgraph.id),
  );
  const created = (next.subgraphs ?? []).filter(
    (subgraph) => !previousIds.has(subgraph.id),
  );
  if (
    created.length !== 1 ||
    (next.subgraphs?.length ?? 0) !== (previous.subgraphs?.length ?? 0) + 1
  ) {
    return null;
  }
  const subgraph = created[0];
  if (subgraph.nodeIds.length < 2) return null;
  const previousOwners = nodeOwnerById(previous);
  const selectedParentIds = new Set(
    subgraph.nodeIds.map((nodeId) => previousOwners.get(nodeId) ?? ""),
  );
  if (
    selectedParentIds.size !== 1 ||
    (subgraph.parentId ?? "") !== [...selectedParentIds][0]
  ) {
    return null;
  }
  const lines = source.split("\n");
  const sourceBlocks = flowchartSubgraphSourceBlocks(source);
  const memberLines: Array<{
    id: string;
    index: number;
    indent: string;
    value: string;
  }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const ranges = statementRanges(lines[index]);
    if (ranges.edges.length || ranges.nodes.length !== 1) continue;
    const node = ranges.nodes[0];
    const suffix = lines[index].slice(node.end).trim();
    const ownerId = sourceBlocks
      .filter((block) => index > block.start && index < block.end)
      .sort(
        (left, right) => left.end - left.start - (right.end - right.start),
      )[0]?.id;
    if (
      !subgraph.nodeIds.includes(node.id) ||
      ownerId !== previousOwners.get(node.id) ||
      (suffix && suffix !== ";")
    ) {
      continue;
    }
    memberLines.push({
      id: node.id,
      index,
      indent: /^(\s*)/.exec(lines[index])?.[1] ?? "",
      value: lines[index],
    });
  }
  if (
    subgraph.nodeIds.some(
      (nodeId) => !memberLines.some(({ id }) => id === nodeId),
    )
  ) {
    return null;
  }
  for (const member of [...memberLines].sort(
    (left, right) => right.index - left.index,
  )) {
    lines.splice(member.index, 1);
  }
  const blocks = flowchartSubgraphSourceBlocks(lines.join("\n"));
  const parent = subgraph.parentId
    ? blocks.find(({ id }) => id === subgraph.parentId)
    : undefined;
  if (subgraph.parentId && !parent) return null;
  const indent = parent
    ? `${parent.indent}  `
    : (blocks.find((block) => !block.parentId)?.indent ?? "  ");
  const bodyIndent = `${indent}  `;
  const newBlock = [
    `${indent}subgraph ${flowchartSubgraphSource(subgraph)}`,
    ...(subgraph.direction
      ? [`${bodyIndent}direction ${subgraph.direction}`]
      : []),
    ...subgraph.nodeIds.map((nodeId) => {
      const member = memberLines.find(({ id }) => id === nodeId)!;
      const relative = member.value.startsWith(member.indent)
        ? member.value.slice(member.indent.length)
        : member.value.trimStart();
      return `${bodyIndent}${relative}`;
    }),
    `${indent}end`,
  ];
  const insertionIndex = parent
    ? parent.end
    : blocks.some((block) => !block.parentId)
      ? Math.max(
          ...blocks
            .filter((block) => !block.parentId)
            .map((block) => block.end + 1),
        )
      : Math.min(...memberLines.map(({ index }) => index));
  lines.splice(insertionIndex, 0, ...newBlock);
  return lines.join("\n");
}

function deleteSubgraphRange(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  const nextIds = new Set(
    (next.subgraphs ?? []).map((subgraph) => subgraph.id),
  );
  const deleted = (previous.subgraphs ?? []).filter(
    (subgraph) => !nextIds.has(subgraph.id),
  );
  if (
    deleted.length !== 1 ||
    (previous.subgraphs?.length ?? 0) !== (next.subgraphs?.length ?? 0) + 1
  ) {
    return null;
  }
  const lines = source.split("\n");
  const block = flowchartSubgraphSourceBlocks(source).find(
    ({ id }) => id === deleted[0].id,
  );
  if (!block) return null;
  const bodyIndent = `${block.indent}  `;
  const body = lines
    .slice(block.start + 1, block.end)
    .filter(
      (line) =>
        !(
          line.startsWith(bodyIndent) &&
          /^direction\s+(?:TD|TB|BT|LR|RL)\s*;?\s*$/.test(
            line.slice(bodyIndent.length),
          )
        ),
    )
    .map((line) =>
      line.startsWith(bodyIndent)
        ? `${block.indent}${line.slice(bodyIndent.length)}`
        : line,
    );
  lines.splice(block.start, block.end - block.start + 1, ...body);
  return lines.join("\n");
}

function longestCommonStyleStatementPairs(
  previous: readonly string[],
  next: readonly string[],
) {
  const lengths = Array.from({ length: previous.length + 1 }, () =>
    Array.from({ length: next.length + 1 }, () => 0),
  );
  for (let left = previous.length - 1; left >= 0; left -= 1) {
    for (let right = next.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] =
        previous[left] === next[right]
          ? 1 + lengths[left + 1]![right + 1]!
          : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }
  const pairs = new Map<number, number>();
  let left = 0;
  let right = 0;
  while (left < previous.length && right < next.length) {
    if (previous[left] === next[right]) {
      pairs.set(left, right);
      left += 1;
      right += 1;
    } else if (lengths[left + 1]![right]! >= lengths[left]![right + 1]!) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return pairs;
}

function updateStyleStatementRanges(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  const previousStatements = previous.styleStatements ?? [];
  const nextStatements = next.styleStatements ?? [];
  if (JSON.stringify(previousStatements) === JSON.stringify(nextStatements)) {
    return source;
  }

  const lines = source.split("\n");
  const styleLineIndices = lines.flatMap((line, index) =>
    isFlowchartStyleStatement(line) ? [index] : [],
  );
  if (
    JSON.stringify(styleLineIndices.map((index) => lines[index]!.trim())) !==
    JSON.stringify(previousStatements)
  ) {
    return source;
  }

  const matchedNextByPrevious = longestCommonStyleStatementPairs(
    previousStatements,
    nextStatements,
  );
  const result: string[] = [];
  const styleIndexByLine = new Map(
    styleLineIndices.map((lineIndex, styleIndex) => [lineIndex, styleIndex]),
  );
  let nextCursor = 0;
  const finalStyleLine = styleLineIndices.at(-1);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const previousIndex = styleIndexByLine.get(lineIndex);
    if (previousIndex === undefined) {
      result.push(lines[lineIndex]!);
      continue;
    }
    const matchedNextIndex = matchedNextByPrevious.get(previousIndex);
    const indent = /^\s*/.exec(lines[lineIndex]!)?.[0] ?? "  ";
    if (matchedNextIndex !== undefined) {
      while (nextCursor < matchedNextIndex) {
        result.push(`${indent}${nextStatements[nextCursor]}`);
        nextCursor += 1;
      }
      result.push(lines[lineIndex]!);
      nextCursor = matchedNextIndex + 1;
    }
    if (lineIndex === finalStyleLine) {
      while (nextCursor < nextStatements.length) {
        result.push(`${indent}${nextStatements[nextCursor]}`);
        nextCursor += 1;
      }
    }
  }

  if (nextCursor < nextStatements.length) {
    const insertion = nextStatements
      .slice(nextCursor)
      .map((statement) => `  ${statement}`);
    const trailingEmptyLine = result.at(-1) === "";
    result.splice(trailingEmptyLine ? -1 : result.length, 0, ...insertion);
  }
  return result.join("\n");
}

function stableIdentityModel(model: MermaidVisualModel) {
  return {
    ...model,
    edges: model.edges.map((edge) => ({
      ...edge,
      mermaidId: edge.mermaidId ?? edge.id,
    })),
  };
}

function nodeSourceState(node: MermaidVisualNode) {
  return {
    familyData: node.familyData,
    id: node.id,
    label: node.label,
    shape: node.shape,
  };
}

function edgeSourceState(edge: MermaidVisualEdge) {
  return {
    id: edge.id,
    label: edge.label,
    linkType: edge.linkType,
    mermaidId: edge.mermaidId ?? edge.id,
    source: edge.source,
    sourceMarker: edge.sourceMarker,
    style: edge.style,
    target: edge.target,
    targetMarker: edge.targetMarker,
  };
}

function subgraphSourceState(subgraph: MermaidVisualSubgraph) {
  return {
    direction: subgraph.direction,
    id: subgraph.id,
    nodeIds: [...subgraph.nodeIds].sort(),
    parentId: subgraph.parentId,
    title: subgraph.title,
  };
}

function keyedState<T extends { id: string }>(
  items: readonly T[],
  project: (item: T) => unknown,
) {
  return items
    .map(project)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function sourceState(model: MermaidVisualModel) {
  return {
    accessibilityDescription: model.accessibilityDescription ?? "",
    accessibilityTitle: model.accessibilityTitle ?? "",
    diagramType: model.diagramType,
    diagramTitle: model.diagramTitle ?? "",
    direction: model.direction,
    edges: keyedState(model.edges, edgeSourceState),
    familyData: model.familyData,
    nodes: keyedState(model.nodes, nodeSourceState),
    sourceAnnotations: model.sourceAnnotations ?? [],
    sourcePreamble: model.sourcePreamble ?? [],
    styleStatements: model.styleStatements ?? [],
    subgraphs: (model.subgraphs ?? []).map(subgraphSourceState),
  };
}

function sameSourceState(left: MermaidVisualModel, right: MermaidVisualModel) {
  return (
    JSON.stringify(sourceState(left)) === JSON.stringify(sourceState(right))
  );
}

function flowchartCommentSourceLines(source: string) {
  const lines = source.split("\n");
  const headerIndex = getMermaidSourceHeaderIndex(source);
  const indices: number[] = [];
  let inDirective = false;
  for (
    let index = Math.max(0, headerIndex + 1);
    index < lines.length;
    index += 1
  ) {
    const trimmed = lines[index]!.trim();
    if (inDirective) {
      if (trimmed.includes("}%%")) inDirective = false;
      continue;
    }
    if (trimmed.startsWith("%%{")) {
      inDirective = !trimmed.includes("}%%");
      continue;
    }
    if (trimmed.startsWith("%%")) indices.push(index);
  }
  return { indices, lines };
}

function flowchartCommentAnchorLine(
  source: string,
  model: MermaidVisualModel,
  comment: MermaidFlowchartComment,
) {
  const lines = source.split("\n");
  const headerIndex = getMermaidSourceHeaderIndex(source);
  if (comment.anchorKind === "diagram") return Math.max(0, headerIndex + 1);
  let edgeIndex = 0;
  for (
    let index = Math.max(0, headerIndex + 1);
    index < lines.length;
    index += 1
  ) {
    const line = lines[index]!;
    if (comment.anchorKind === "subgraph") {
      const match = /^\s*subgraph\s+([A-Za-z0-9_][\w-]*)/.exec(line);
      if (match?.[1] === comment.anchorId) return index;
    }
    const ranges = statementRanges(line);
    if (
      comment.anchorKind === "node" &&
      ranges.nodes.some(({ id }) => id === comment.anchorId)
    ) {
      return index;
    }
    for (const range of ranges.edges) {
      const edge = range.explicitId
        ? model.edges.find(({ id }) => id === range.explicitId)
        : model.edges[edgeIndex];
      edgeIndex += 1;
      if (comment.anchorKind === "edge" && edge?.id === comment.anchorId) {
        return index;
      }
    }
  }
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

function updateFlowchartCommentRanges(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  const previousComments = flowchartModelData(previous).comments;
  const nextComments = flowchartModelData(next).comments;
  if (JSON.stringify(previousComments) === JSON.stringify(nextComments))
    return null;
  const nextById = new Map(
    nextComments.map((comment) => [comment.id, comment]),
  );
  const previousIds = new Set(previousComments.map((comment) => comment.id));
  const { indices, lines } = flowchartCommentSourceLines(source);
  if (indices.length !== previousComments.length) return null;
  for (let index = previousComments.length - 1; index >= 0; index -= 1) {
    const previousComment = previousComments[index]!;
    const nextComment = nextById.get(previousComment.id);
    const sourceLine = indices[index]!;
    if (!nextComment) {
      lines.splice(sourceLine, 1);
      continue;
    }
    if (previousComment.line !== nextComment.line) {
      const indent = /^\s*/.exec(lines[sourceLine]!)?.[0] ?? "";
      lines[sourceLine] = `${indent}${nextComment.line}`;
    }
  }
  const created = nextComments.filter(
    (comment) => !previousIds.has(comment.id),
  );
  for (const comment of created) {
    const currentSource = lines.join("\n");
    const parsed = parseMermaidSourceToVisualModel(currentSource).model ?? next;
    const anchorLine = flowchartCommentAnchorLine(
      currentSource,
      parsed,
      comment,
    );
    const indent = /^\s*/.exec(lines[anchorLine] ?? "")?.[0] ?? "  ";
    lines.splice(anchorLine, 0, `${indent}${comment.line}`);
  }
  return lines.join("\n");
}

function updateFlowchartAccessibilityRanges(
  source: string,
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  if (
    previous.accessibilityTitle === next.accessibilityTitle &&
    previous.accessibilityDescription === next.accessibilityDescription
  ) {
    return null;
  }
  const lines = source.split("\n");
  const headerIndex = getMermaidSourceHeaderIndex(source);
  const replaceField = (
    pattern: RegExp,
    value: string,
    render: (indent: string, value: string) => string[],
  ) => {
    const start = lines.findIndex(
      (line, index) => index > headerIndex && pattern.test(line),
    );
    if (start >= 0) {
      const indent = /^\s*/.exec(lines[start]!)?.[0] ?? "  ";
      let end = start + 1;
      if (/^\s*accDescr\s*\{/.test(lines[start]!)) {
        while (end < lines.length && !/^\s*}\s*;?\s*$/.test(lines[end]!))
          end += 1;
        if (end < lines.length) end += 1;
      }
      lines.splice(start, end - start, ...render(indent, value));
      return;
    }
    if (value) lines.splice(headerIndex + 1, 0, ...render("  ", value));
  };
  replaceField(
    /^\s*accDescr\s*(?::|\{)/,
    next.accessibilityDescription ?? "",
    (indent, value) =>
      value
        ? [
            `${indent}accDescr {`,
            ...value.split(/\r?\n/).map((line) => `${indent}  ${line}`),
            `${indent}}`,
          ]
        : [],
  );
  replaceField(
    /^\s*accTitle\s*:/,
    next.accessibilityTitle ?? "",
    (indent, value) =>
      value
        ? [`${indent}accTitle: ${value.replaceAll(/\s*\r?\n\s*/g, " ")}`]
        : [],
  );
  return lines.join("\n");
}

function sameIds(
  left: readonly { readonly id: string }[],
  right: readonly { readonly id: string }[],
) {
  return (
    left.length === right.length &&
    left.every(({ id }) => right.some((candidate) => candidate.id === id))
  );
}

function canUpdateOwnedRanges(
  previous: MermaidVisualModel,
  next: MermaidVisualModel,
) {
  if (
    previous.accessibilityDescription !== next.accessibilityDescription ||
    previous.accessibilityTitle !== next.accessibilityTitle ||
    previous.diagramType !== next.diagramType ||
    previous.diagramTitle !== next.diagramTitle ||
    previous.direction !== next.direction ||
    !sameIds(previous.nodes, next.nodes) ||
    !sameIds(previous.edges, next.edges) ||
    !sameIds(previous.subgraphs ?? [], next.subgraphs ?? []) ||
    JSON.stringify(previous.sourcePreamble ?? []) !==
      JSON.stringify(next.sourcePreamble ?? []) ||
    JSON.stringify(previous.sourceAnnotations ?? []) !==
      JSON.stringify(next.sourceAnnotations ?? [])
  ) {
    return false;
  }

  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  if (
    previous.edges.some((edge) => {
      const candidate = nextEdges.get(edge.id);
      return (
        !candidate ||
        candidate.source !== edge.source ||
        candidate.target !== edge.target
      );
    })
  ) {
    return false;
  }

  const nextSubgraphs = new Map(
    (next.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  return (previous.subgraphs ?? []).every((subgraph) => {
    const candidate = nextSubgraphs.get(subgraph.id);
    return (
      candidate &&
      candidate.parentId === subgraph.parentId &&
      JSON.stringify([...candidate.nodeIds].sort()) ===
        JSON.stringify([...subgraph.nodeIds].sort())
    );
  });
}

export function applyFlowchartGfxVisualToSource(
  previousSource: string,
  requestedModel: MermaidVisualModel,
) {
  const requested = stableIdentityModel(requestedModel);
  const parsed = parseMermaidSourceToVisualModel(previousSource).model;
  if (!parsed) return generateMermaidSourceFromVisualModel(requested);

  const stableSource = stabilizeSourceIdentities(previousSource, parsed);
  const stableParsed = parseMermaidSourceToVisualModel(stableSource).model;
  if (!stableParsed) return generateMermaidSourceFromVisualModel(requested);
  if (sameSourceState(stableParsed, requested)) return stableSource;

  const commentCandidate = updateFlowchartCommentRanges(
    stableSource,
    stableParsed,
    requested,
  );
  if (commentCandidate) {
    const reparsed = parseMermaidSourceToVisualModel(commentCandidate).model;
    if (reparsed && sameSourceState(reparsed, requested))
      return commentCandidate;
  }

  const accessibilityCandidate = updateFlowchartAccessibilityRanges(
    stableSource,
    stableParsed,
    requested,
  );
  if (accessibilityCandidate) {
    const reparsed = parseMermaidSourceToVisualModel(
      accessibilityCandidate,
    ).model;
    if (reparsed && sameSourceState(reparsed, requested)) {
      return accessibilityCandidate;
    }
  }

  const structuralCandidate = updateSubgraphBlockStructure(
    stableSource,
    stableParsed,
    requested,
  );
  if (structuralCandidate) {
    const reparsed = parseMermaidSourceToVisualModel(structuralCandidate).model;
    if (reparsed && sameSourceState(reparsed, requested)) {
      return structuralCandidate;
    }
  }

  const createdSubgraphCandidate = insertCreatedSubgraphRange(
    stableSource,
    stableParsed,
    requested,
  );
  if (createdSubgraphCandidate) {
    const reparsed = parseMermaidSourceToVisualModel(
      createdSubgraphCandidate,
    ).model;
    if (reparsed && sameSourceState(reparsed, requested)) {
      return createdSubgraphCandidate;
    }
  }

  const deletedSubgraphCandidate = deleteSubgraphRange(
    stableSource,
    stableParsed,
    requested,
  );
  if (deletedSubgraphCandidate) {
    const reparsed = parseMermaidSourceToVisualModel(
      deletedSubgraphCandidate,
    ).model;
    if (reparsed && sameSourceState(reparsed, requested)) {
      return deletedSubgraphCandidate;
    }
  }

  const membershipCandidate = updateNodeMembershipRanges(
    stableSource,
    stableParsed,
    requested,
  );
  if (membershipCandidate) {
    const reparsed = parseMermaidSourceToVisualModel(membershipCandidate).model;
    if (reparsed && sameSourceState(reparsed, requested)) {
      return membershipCandidate;
    }
  }

  if (canUpdateOwnedRanges(stableParsed, requested)) {
    const candidate = updateOwnedSourceRanges(
      stableSource,
      stableParsed,
      requested,
    );
    const reparsed = parseMermaidSourceToVisualModel(candidate).model;
    if (reparsed && sameSourceState(reparsed, requested)) return candidate;
  }

  return generateMermaidSourceFromVisualModel(requested);
}
