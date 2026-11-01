// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  gitGraphPayload,
  gitGraphData,
  readGitGraphProjectionModel,
  gitGraphBinding,
} from "./gfx-data.js";
import { gitGraphModelToVisual } from "./visual-model.js";

/** Font readiness can change measured captions after cold materialization.
 * Keep a whole-owner transform, but never preserve boxes that make the Shape
 * text consumer wrap an already measured caption a second time. */
export function reconcileGitGraphTypographyGeometry(
  current: MermaidVisualModel,
  source: MermaidVisualModel,
) {
  if (
    gitGraphPayload(current)?.sourceHash !== gitGraphPayload(source)?.sourceHash
  )
    return current;
  const origin = source.nodes.find((node) => node.id.endsWith(":origin"));
  const actual = origin && current.nodes.find((node) => node.id === origin.id);
  if (!origin || !actual) return current;
  const scaleX = actual.width / origin.width;
  const scaleY = actual.height / origin.height;
  const fits = source.nodes.every((node) => {
    const role = gitGraphBinding(node)?.role;
    if (!["id", "message", "tag", "branch"].includes(role ?? "")) return true;
    const old = current.nodes.find((item) => item.id === node.id);
    return (
      old &&
      old.width + 0.5 >= node.width * scaleX &&
      old.height + 0.5 >= node.height * scaleY
    );
  });
  return fits
    ? current
    : preserveGitGraphOwnerTransform(source, source, current);
}

/** Recover only the complete owner's transform from its fixed-size origin.
 * The next layout still comes from Source; former individual coordinates do
 * not choose branches, sequence locations or relationship endpoints. */
export function preserveGitGraphOwnerTransform(
  next: MermaidVisualModel,
  previous: MermaidVisualModel,
  displayed: MermaidVisualModel,
): MermaidVisualModel {
  const origin = previous.nodes.find((node) => node.id.endsWith(":origin"));
  const actual =
    origin && displayed.nodes.find((node) => node.id === origin.id);
  if (!origin || !actual) return next;
  const scaleX = actual.width / origin.width;
  const scaleY = actual.height / origin.height;
  if (![scaleX, scaleY].every((value) => Number.isFinite(value) && value > 0))
    return next;
  const offsetX = actual.x - origin.x * scaleX;
  const offsetY = actual.y - origin.y * scaleY;
  return {
    ...next,
    nodes: next.nodes.map((node) => ({
      ...node,
      x: node.x * scaleX + offsetX,
      y: node.y * scaleY + offsetY,
      width: node.width * scaleX,
      height: node.height * scaleY,
    })),
  };
}

/** The checked Source-write draft already carries the owner's transform.
 * Reparse validates semantics and advances bindings without resetting it. */
export function canonicalizeGitGraphSourceWrite(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
  source: string,
): MermaidVisualModel {
  // The main branch of a non-string config value uses the header occurrence
  // as its symbolic identity. Bind before evaluation, not after deriving IDs.
  const bound = readGitGraphProjectionModel(source, requested);
  const next = bound
    ? gitGraphModelToVisual(bound)
    : reconcileGitGraphVisual(parsed, requested);
  if (
    gitGraphPayload(parsed)?.sourceHash !==
    gitGraphPayload(requested)?.sourceHash
  )
    return next;
  const retained = new Map(requested.nodes.map((node) => [node.id, node]));
  return {
    ...next,
    nodes: next.nodes.map((node) => {
      const old = retained.get(node.id);
      return old
        ? { ...node, x: old.x, y: old.y, width: old.width, height: old.height }
        : node;
    }),
  };
}
/** Geometry readback is not a Git command. Only checked family Source results
 * may change history, branch membership or derived parent relationships. */
export function applyGitGraphVisualToSource(
  source: string,
  _visual: MermaidVisualModel,
) {
  return { source, changed: false };
}
/** Reparse adopts writer-advanced occurrence bindings before GFX reconciliation.
 * Source-derived geometry is preserved, rather than arbitrary old child X/Y. */
export function reconcileGitGraphVisual(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
) {
  const incoming = gitGraphPayload(parsed),
    retained = gitGraphPayload(requested),
    records = Array.isArray(incoming?.records) ? incoming.records : [],
    oldRecords = Array.isArray(retained?.records) ? retained.records : [],
    keys = new Map<string, string>();
  for (const r of records) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const old = oldRecords.find(
      (o) =>
        o &&
        typeof o === "object" &&
        !Array.isArray(o) &&
        o.kind === r.kind &&
        o.start === r.start &&
        o.end === r.end &&
        o.hash === r.hash,
    );
    if (
      old &&
      typeof old === "object" &&
      !Array.isArray(old) &&
      typeof old.key === "string" &&
      typeof r.key === "string"
    )
      keys.set(r.key, old.key);
    if (
      old &&
      typeof old === "object" &&
      !Array.isArray(old) &&
      Array.isArray(r.attributes) &&
      Array.isArray(old.attributes)
    )
      for (const a of r.attributes) {
        if (!a || typeof a !== "object" || Array.isArray(a)) continue;
        const retained = old.attributes.find((b: unknown) => {
          if (!b || typeof b !== "object" || Array.isArray(b)) return false;
          const value = b as Record<string, unknown>;
          return (
            value.name === a.name &&
            value.start === a.start &&
            value.end === a.end &&
            value.hash === a.hash
          );
        });
        if (
          retained &&
          typeof retained === "object" &&
          !Array.isArray(retained) &&
          typeof retained.key === "string" &&
          typeof a.key === "string"
        )
          keys.set(a.key, retained.key);
      }
  }
  const remap = (key: string) => {
    for (const [from, to] of keys)
      if (key === from || key.startsWith(`${from}:`))
        return to + key.slice(from.length);
    return key;
  };
  const data = (object: { familyData?: MermaidVisualModel["familyData"] }) => {
    const p = gitGraphPayload(object);
    return p
      ? gitGraphData(
          Object.fromEntries(
            Object.entries(p).map(([name, value]) => [
              name,
              typeof value === "string" &&
              [
                "sourceKey",
                "anchorKey",
                "parent",
                "attributeKey",
                "head",
                "origin",
              ].includes(name)
                ? remap(value)
                : value,
            ]),
          ),
        )
      : object.familyData;
  };
  const next: MermaidVisualModel = {
    ...parsed,
    familyData: incoming
      ? gitGraphData({
          ...incoming,
          records: records.map((r) => {
            if (!r || typeof r !== "object" || Array.isArray(r)) return r;
            return {
              ...r,
              key: typeof r.key === "string" ? remap(r.key) : r.key,
              attributes: Array.isArray(r.attributes)
                ? r.attributes.map((a: unknown) => {
                    if (!a || typeof a !== "object" || Array.isArray(a))
                      return null;
                    const value = a as Record<
                      string,
                      import("../runtime/gfx-family-data.js").MermaidGfxJsonValue
                    >;
                    return {
                      ...value,
                      key:
                        typeof value.key === "string"
                          ? remap(value.key)
                          : value.key,
                    };
                  })
                : [],
            };
          }),
        })
      : parsed.familyData,
    nodes: parsed.nodes.map((n) => ({
      ...n,
      id: remap(n.id),
      familyData: data(n),
    })),
    edges: parsed.edges.map((e) => ({
      ...e,
      id: remap(e.id),
      source: remap(e.source),
      target: remap(e.target),
      familyData: data(e),
    })),
  };
  // Projection changes (for example measured tag/branch carriers) do not
  // discard an existing whole-owner resize of the unchanged Source.
  return typeof incoming?.sourceHash === "string" &&
    incoming.sourceHash === retained?.sourceHash &&
    next.nodes.some((node) =>
      requested.nodes.some(
        (old) => old.id === node.id && old.shape !== node.shape,
      ),
    )
    ? preserveGitGraphOwnerTransform(next, next, requested)
    : next;
}
