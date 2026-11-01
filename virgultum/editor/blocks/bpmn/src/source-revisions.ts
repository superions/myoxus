// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  canPreserveBpmnSource,
  inspectBpmnSource,
} from "@myoxus/bpmn-editor/source";
import type { BpmnSourceRevisionProps } from "@virgultum/model";
import * as Y from "yjs";

/** Immutable whole-source payloads and compact ancestry live in distinct nested maps. */
type Links = { parent: string | null; supersedes: string[] };
type Context = {
  block: Y.Map<unknown>;
  heads: Y.Map<string>;
  links: Y.Map<string>;
  doc: Y.Doc;
};
export type BpmnSourceRevisionState = {
  status: "ready" | "conflict" | "empty";
  /** An LWW selected-head hint cannot choose between concurrent terminal revisions. */
  selected: string | null;
  heads: ReadonlyMap<string, string>;
};

// Outer document history tracks the clientID origin. Source revisions, retirement
// and derived state must not enter that undo stack or keep retired XML alive.
export const BPMN_SOURCE_TRANSACTION_ORIGIN = Object.freeze({
  bpmnSource: true,
  // Direct Yjs writes must refresh native model proxies too. The object origin
  // still excludes source/derived writes from outer document Undo history.
  force: true,
});

function failure(code: string): never {
  throw new Error(code);
}
function checkId(id: unknown): asserts id is string {
  if (
    typeof id !== "string" ||
    id.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    failure("BPMN_REVISION_ID");
}
function encodeLinks(links: Links) {
  return JSON.stringify(links);
}
function decodeLinks(id: string, value: unknown): Links {
  if (typeof value !== "string") failure("BPMN_REVISION_LINKS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return failure("BPMN_REVISION_LINKS");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("parent" in parsed) ||
    !("supersedes" in parsed)
  )
    failure("BPMN_REVISION_LINKS");
  const { parent, supersedes } = parsed;
  if (parent !== null) checkId(parent);
  if (!Array.isArray(supersedes)) failure("BPMN_REVISION_LINKS");
  for (const key of supersedes) checkId(key);
  if (
    parent === id ||
    supersedes.includes(id) ||
    new Set(supersedes).size !== supersedes.length
  )
    failure("BPMN_REVISION_CYCLE");
  return { parent, supersedes };
}
function context(block: Y.Map<unknown>): Context {
  const heads = block.get("prop:sourceHeads"),
    links = block.get("prop:sourceLinks");
  if (!(heads instanceof Y.Map) || !(links instanceof Y.Map) || !block.doc)
    failure("BPMN_REVISION_CONTEXT");
  return { block, heads, links, doc: block.doc };
}
function acceptedSource(source: string) {
  const result = inspectBpmnSource(source);
  if (result.status !== "accepted") failure(result.error.code);
}

/** Prepare before insertion. The store materializes each record as one persistent
 * nested Y.Map. Only new-document import opts into safe unsupported source;
 * replacement and modelling keep the strict accepted-source gate. */
export function createBpmnSourceRevisionProps(
  source: string,
  preserveUnsupported = false,
): BpmnSourceRevisionProps {
  if (preserveUnsupported) {
    const inspection = inspectBpmnSource(source);
    if (inspection.status !== "accepted" && !canPreserveBpmnSource(inspection))
      failure(inspection.error.code);
  } else acceptedSource(source);
  const id = globalThis.crypto.randomUUID();
  return {
    sourceHeads: { [id]: source },
    sourceLinks: { [id]: encodeLinks({ parent: null, supersedes: [] }) },
    selectedHead: id,
  };
}

type RevisionMaps = {
  heads: Iterable<[string, string]> & Pick<Y.Map<string>, "get" | "has">;
  links: Iterable<[string, string]>;
};
function inspect(context: RevisionMaps) {
  const graph = new Map<string, Links>();
  for (const [id, value] of context.links) {
    checkId(id);
    graph.set(id, decodeLinks(id, value));
  }
  const successors = new Map<string, string[]>();
  const dependencies = new Map<string, number>();
  for (const [id, { parent, supersedes }] of graph) {
    const previous = new Set([...(parent ? [parent] : []), ...supersedes]);
    dependencies.set(id, previous.size);
    for (const key of previous) {
      if (!graph.has(key)) failure("BPMN_REVISION_MISSING_BASE");
      const children = successors.get(key) ?? [];
      children.push(id);
      successors.set(key, children);
    }
  }
  // Iterative validation also handles long saved chains without recursive stack growth.
  const roots = [...dependencies]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  for (const id of roots) {
    visited++;
    for (const child of successors.get(id) ?? []) {
      const count = dependencies.get(child)! - 1;
      dependencies.set(child, count);
      if (count === 0) roots.push(child);
    }
  }
  if (visited !== graph.size) failure("BPMN_REVISION_CYCLE");
  const tips = new Set([...graph.keys()].filter((id) => !successors.has(id)));
  for (const [id, source] of context.heads)
    if (!graph.has(id) || typeof source !== "string")
      failure("BPMN_REVISION_PAYLOAD");
  for (const id of tips)
    if (!context.heads.has(id)) failure("BPMN_REVISION_MISSING_SOURCE");
  return { graph, tips };
}

/** Observational: neither source selection nor retirement happens merely by rendering a block. */
export function readBpmnSourceRevisions(
  block: Y.Map<unknown>,
): BpmnSourceRevisionState {
  const ctx = context(block);
  const { tips } = inspect(ctx);
  return {
    status: tips.size === 0 ? "empty" : tips.size === 1 ? "ready" : "conflict",
    selected: tips.size === 1 ? tips.values().next().value! : null,
    heads: new Map([...tips].map((id) => [id, ctx.heads.get(id)!])),
  };
}

export type BpmnSourceCandidate = {
  id: string;
  source: string;
  parent: string;
  supersedes: string[];
};

/**
 * Insert one prepared candidate, select its hint and retire only proven ancestors.
 * A stale base creates a visible competing head instead of overwriting a winner.
 * This is an in-memory Yjs commit, never a local-storage or remote-sync ACK.
 */
export function commitBpmnSourceRevision(
  block: Y.Map<unknown>,
  candidate: BpmnSourceCandidate,
  retainedBases: ReadonlySet<string> = new Set(),
): BpmnSourceRevisionState {
  checkId(candidate.id);
  checkId(candidate.parent);
  for (const id of candidate.supersedes) checkId(id);
  const ctx = context(block);
  const { graph, tips } = inspect(ctx);
  if (!graph.has(candidate.parent)) failure("BPMN_REVISION_MISSING_BASE");
  const links = encodeLinks({
    parent: candidate.parent,
    supersedes: [...new Set(candidate.supersedes)].sort(),
  });
  decodeLinks(candidate.id, links);
  if (ctx.links.has(candidate.id)) {
    if (
      ctx.links.get(candidate.id) !== links ||
      (ctx.heads.has(candidate.id) &&
        ctx.heads.get(candidate.id) !== candidate.source)
    )
      failure("BPMN_REVISION_COLLISION");
    // An already retired candidate is not reinserted on retry. The storage
    // owner must retry its captured original update, not interpret a no-op as ACK.
    return readBpmnSourceRevisions(block);
  }
  if (
    candidate.supersedes.length &&
    (new Set(candidate.supersedes).size !== tips.size ||
      candidate.supersedes.some((id) => !tips.has(id)))
  )
    failure("BPMN_CONFLICT_CHANGED");
  for (const id of retainedBases)
    if (!graph.has(id)) failure("BPMN_REVISION_MISSING_BASE");
  acceptedSource(candidate.source);
  ctx.doc.transact(() => {
    ctx.links.set(candidate.id, links);
    ctx.heads.set(candidate.id, candidate.source);
    ctx.block.set("prop:selectedHead", candidate.id);
    const { tips } = inspect(ctx);
    for (const id of ctx.heads.keys())
      if (!tips.has(id) && !retainedBases.has(id)) ctx.heads.delete(id);
  }, BPMN_SOURCE_TRANSACTION_ORIGIN);
  return readBpmnSourceRevisions(block);
}

/** Native snapshots carry plain values. Every import remaps live payloads and
 * ancestry again, even when the same clipboard payload is pasted repeatedly. */
export function cloneBpmnSourceRevisionSnapshot(
  props: BpmnSourceRevisionProps,
): BpmnSourceRevisionProps {
  return cloneRevisions(
    {
      heads: new Map(Object.entries(props.sourceHeads)),
      links: new Map(Object.entries(props.sourceLinks)),
    },
    props.selectedHead,
  );
}
function cloneRevisions(
  ctx: RevisionMaps,
  hint: unknown,
): BpmnSourceRevisionProps {
  const { graph } = inspect(ctx);
  const ids = new Map(
    [...graph.keys()].map((id) => [id, globalThis.crypto.randomUUID()]),
  );
  return {
    sourceHeads: Object.fromEntries(
      [...ctx.heads].map(([id, source]) => [ids.get(id)!, source]),
    ),
    sourceLinks: Object.fromEntries(
      [...graph].map(([id, links]) => [
        ids.get(id)!,
        encodeLinks({
          parent: links.parent ? ids.get(links.parent)! : null,
          supersedes: links.supersedes.map((id) => ids.get(id)!),
        }),
      ]),
    ),
    selectedHead: typeof hint === "string" ? (ids.get(hint) ?? "") : "",
  };
}
