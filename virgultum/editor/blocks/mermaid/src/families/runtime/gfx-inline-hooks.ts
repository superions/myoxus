// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "./gfx-model.js";
import type {
  MermaidTypeOwnedInlineMutation,
  MermaidTypeOwnedInlineValue,
} from "./gfx-family-hooks-contract.js";
import { getMermaidGfxFamilyHooks } from "./gfx-family-hooks-registry.js";

export type {
  MermaidTypeOwnedInlineMutation,
  MermaidTypeOwnedInlineValue,
} from "./gfx-family-hooks-contract.js";

export function resolveTypeOwnedMermaidNodeInlineValue(
  model: MermaidVisualModel,
  nodeId: string,
): MermaidTypeOwnedInlineValue {
  const resolveValue = getMermaidGfxFamilyHooks(model)?.nodeInlineValue;
  return resolveValue
    ? { handled: true, value: resolveValue(model, nodeId) }
    : { handled: false };
}

export function resolveTypeOwnedMermaidSubgraphInlineValue(
  model: MermaidVisualModel,
  subgraphId: string,
): MermaidTypeOwnedInlineValue {
  const resolveValue = getMermaidGfxFamilyHooks(model)?.subgraphInlineValue;
  return resolveValue
    ? { handled: true, value: resolveValue(model, subgraphId) }
    : { handled: false };
}

export function resolveTypeOwnedMermaidNodeInlineRename(
  model: MermaidVisualModel,
  nodeId: string,
  value: string,
  source?: string,
): MermaidTypeOwnedInlineMutation {
  const rename = getMermaidGfxFamilyHooks(model)?.nodeInlineRename;
  return rename
    ? { handled: true, visualModel: rename(model, nodeId, value, source) }
    : { handled: false };
}

export function resolveTypeOwnedMermaidEdgeInlineRename(
  model: MermaidVisualModel,
  edgeId: string,
  value: string,
  source?: string,
): MermaidTypeOwnedInlineMutation {
  const rename = getMermaidGfxFamilyHooks(model)?.edgeInlineRename;
  return rename
    ? { handled: true, visualModel: rename(model, edgeId, value, source) }
    : { handled: false };
}

export function resolveTypeOwnedMermaidSubgraphInlineRename(
  model: MermaidVisualModel,
  subgraphId: string,
  value: string,
  source?: string,
): MermaidTypeOwnedInlineMutation {
  const rename = getMermaidGfxFamilyHooks(model)?.subgraphInlineRename;
  return rename
    ? { handled: true, visualModel: rename(model, subgraphId, value, source) }
    : { handled: false };
}
