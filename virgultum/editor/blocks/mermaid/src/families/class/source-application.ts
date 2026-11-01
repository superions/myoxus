// SPDX-License-Identifier: AGPL-3.0-or-later
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import {
  resolveMermaidClassSource,
  classRelationSemantics,
  editClass,
  editClassMember,
  editClassNote,
  editClassRelation,
  connectClasses,
  setClassNamespace,
  moveClassNamespace,
  editClassNamespace,
  type MermaidClassModel,
  type ClassCommandResult,
} from "../../engine/class/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { hashMermaidSource } from "../../utils.js";
import {
  classRecordBindings,
  classProjectionBinding,
  classNodeGfxData,
  classEdgeGfxData,
  classModelFamilyData,
} from "./gfx-data.js";
/** Projection bindings store identity, never a second Source/model. */
export function readClassProjectionModel(
  source: string,
  visual?: MermaidVisualModel,
): MermaidClassModel | null {
  const records = resolveMermaidClassSource(source).document.records,
    bindings = visual ? classRecordBindings(visual) : [],
    mapping = new Map<number, string>(),
    used = new Set<string>();
  for (const record of records) {
    const hash = hashMermaidSource(record.raw);
    let candidates = bindings.filter(
      (b) =>
        !used.has(b.key) &&
        b.kind === record.kind &&
        b.start === record.range.start &&
        b.end === record.range.end &&
        b.hash === hash,
    );
    if (!candidates.length)
      candidates = bindings.filter(
        (b) =>
          !used.has(b.key) &&
          b.hash === hash &&
          bindings.filter((other) => other.hash === hash).length === 1 &&
          records.filter((other) => hashMermaidSource(other.raw) === hash)
            .length === 1,
      );
    if (candidates.length === 1) {
      mapping.set(record.range.start, candidates[0]!.key);
      used.add(candidates[0]!.key);
    }
  }
  const classKeys = new Map(
    (visual?.nodes ?? []).flatMap((n) => {
      const b = classProjectionBinding(n);
      return b && classNodeGfxData(n)?.kind === "class"
        ? [[b.sourceId, b.sourceKey] as const]
        : [];
    }),
  );
  const identities =
    visual && mermaidVisualFamilyPayload(visual.familyData, "class")?.classes;
  if (Array.isArray(identities))
    for (const entry of identities) {
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.sourceId === "string" &&
        typeof entry.sourceKey === "string"
      )
        classKeys.set(entry.sourceId, entry.sourceKey);
    }
  const namespaceKeys = new Map<string, string>();
  const namespaces =
    visual &&
    mermaidVisualFamilyPayload(visual.familyData, "class")?.namespaces;
  if (Array.isArray(namespaces))
    for (const entry of namespaces)
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.sourceId === "string" &&
        typeof entry.sourceKey === "string"
      )
        namespaceKeys.set(entry.sourceId, entry.sourceKey);
  return resolveMermaidClassSource(
    source,
    undefined,
    mapping,
    classKeys,
    namespaceKeys,
  ).model;
}
/** Retain unaffected live geometry by record identity; new/expanded objects use measured bounds. */
export function reconcileClassVisual(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuse = true,
) {
  if (!canReuse) return parsed;
  const nodes = new Map(stored.nodes.map((n) => [n.id, n])),
    edges = new Map(stored.edges.map((e) => [e.id, e])),
    groups = new Map((stored.subgraphs ?? []).map((g) => [g.id, g]));
  return {
    ...parsed,
    nodes: parsed.nodes.map((n) => {
      const old =
        nodes.get(n.id) ??
        stored.nodes.find(
          (candidate) =>
            !classProjectionBinding(candidate) &&
            classNodeGfxData(candidate)?.kind === "class" &&
            candidate.id === classProjectionBinding(n)?.sourceId,
        );
      if (!old) return n;
      const unchanged =
        JSON.stringify(n.familyData) === JSON.stringify(old.familyData);
      let x = old.x,
        y = old.y;
      const data = classNodeGfxData(n),
        previousData = classNodeGfxData(old);
      if (
        data?.kind === "note" &&
        data.noteFor &&
        data.noteFor !== previousData?.noteFor
      ) {
        const target = parsed.nodes.find(
          (node) =>
            classNodeGfxData(node)?.kind === "class" &&
            classProjectionBinding(node)?.sourceId === data.noteFor,
        );
        const owner = target ? (nodes.get(target.id) ?? target) : undefined;
        const previousOwner = stored.nodes.find(
          (node) =>
            classNodeGfxData(node)?.kind === "class" &&
            classProjectionBinding(node)?.sourceId === previousData?.noteFor,
        );
        if (owner) {
          x = owner.x + (previousOwner ? old.x - previousOwner.x : 0);
          y =
            owner.y +
            (previousOwner
              ? old.y - previousOwner.y
              : n.y - (target?.y ?? owner.y));
        }
      }
      return {
        ...n,
        x,
        y,
        width: unchanged ? old.width : Math.max(old.width, n.width),
        height: unchanged ? old.height : Math.max(old.height, n.height),
      };
    }),
    edges: parsed.edges.map((e) => {
      const old = edges.get(e.id);
      return old
        ? {
            ...e,
            sourcePosition:
              old.source === e.source &&
              old.connectorMode === e.connectorMode &&
              !e.sourcePosition
                ? old.sourcePosition
                : e.sourcePosition,
            targetPosition:
              old.target === e.target &&
              old.connectorMode === e.connectorMode &&
              !e.targetPosition
                ? old.targetPosition
                : e.targetPosition,
          }
        : e;
    }),
    subgraphs: (parsed.subgraphs ?? []).map((g) => {
      const old = groups.get(g.id);
      return old
        ? {
            ...g,
            x: old.x,
            y: old.y,
            width: Math.max(old.width, g.width),
            height: Math.max(old.height, g.height),
          }
        : g;
    }),
  };
}
export function canonicalizeClassVisual(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
) {
  // Checked candidate bindings refer to the just-written Source ranges.
  const sourceModel = readClassProjectionModelFromParsed(parsed, requested);
  return sourceModel ?? parsed;
}
function readClassProjectionModelFromParsed(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
) {
  // Source itself is supplied by the registry parse; bind matching semantic owners
  // using its record metadata without storing Source in persisted family payloads.
  const bindingMap = new Map(
    classRecordBindings(requested).map((b) => [
      `${b.kind}:${b.start}:${b.end}:${b.hash}`,
      b.key,
    ]),
  );
  const keys = new Map(
    classRecordBindings(parsed).map((b) => [
      b.key,
      bindingMap.get(`${b.kind}:${b.start}:${b.end}:${b.hash}`) ?? b.key,
    ]),
  );
  return remapClassVisual(parsed, requested, keys);
}
function remapClassVisual(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
  keys: Map<string, string>,
) {
  // Only identity is adopted. All semantic payload is freshly projected from Source.
  for (const node of parsed.nodes) {
    const binding = classProjectionBinding(node);
    if (classNodeGfxData(node)?.kind !== "class" || !binding) continue;
    const match = requested.nodes.find(
      (other) =>
        classNodeGfxData(other)?.kind === "class" &&
        classProjectionBinding(other)?.sourceId === binding.sourceId,
    );
    if (match) keys.set(node.id, match.id);
  }
  for (const group of parsed.subgraphs ?? []) {
    const sourceId = mermaidVisualFamilyPayload(
      group.familyData,
      "class",
    )?.sourceId;
    const match = requested.subgraphs?.find(
      (g) =>
        mermaidVisualFamilyPayload(g.familyData, "class")?.sourceId ===
        sourceId,
    );
    if (match) keys.set(group.id, match.id);
  }
  const remap = (key: string): string => {
    if (keys.has(key)) return keys.get(key)!;
    for (const [before, after] of keys)
      if (key.startsWith(`${before}:`))
        return `${after}${key.slice(before.length)}`;
    return key;
  };
  const payload = (
    data: MermaidVisualModel["familyData"],
  ): MermaidVisualModel["familyData"] => {
    if (!data) return data;
    const values = { ...data.payload };
    if (Array.isArray(values.records))
      values.records = values.records.map((record) => {
        const entry = record as {
          key: string;
          [
            key: string
          ]: import("../runtime/gfx-family-data.js").MermaidGfxJsonValue;
        };
        return { ...entry, key: remap(entry.key) };
      });
    if (Array.isArray(values.classes))
      values.classes = values.classes.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return entry;
        return { ...entry, sourceKey: remap(String(entry.sourceKey)) };
      });
    if (Array.isArray(values.namespaces))
      values.namespaces = values.namespaces.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return entry;
        return { ...entry, sourceKey: remap(String(entry.sourceKey)) };
      });
    if (Array.isArray(values.memberKeys))
      values.memberKeys = values.memberKeys.map((key) => remap(String(key)));
    if (typeof values.sourceKey === "string")
      values.sourceKey = remap(values.sourceKey);
    if (values.binding && typeof values.binding === "object") {
      const binding = values.binding as Record<string, unknown>;
      values.binding = {
        ...binding,
        sourceKey: remap(String(binding.sourceKey)),
      };
    }
    return { ...data, payload: values };
  };
  const result: MermaidVisualModel = {
    ...parsed,
    familyData: payload(parsed.familyData),
    nodes: parsed.nodes.map((node) => ({
      ...node,
      id: remap(node.id),
      familyData: payload(node.familyData),
      details: node.details?.map((detail) => ({
        ...detail,
        id: remap(detail.id),
        ...(detail.sourceKey ? { sourceKey: remap(detail.sourceKey) } : {}),
      })),
    })),
    edges: parsed.edges.map((edge) => ({
      ...edge,
      id: remap(edge.id),
      source: remap(edge.source),
      target: remap(edge.target),
    })),
    subgraphs: parsed.subgraphs?.map((group) => ({
      ...group,
      id: remap(group.id),
      parentId: group.parentId ? remap(group.parentId) : group.parentId,
      nodeIds: group.nodeIds.map(remap),
      familyData: payload(group.familyData),
    })),
  };
  return reconcileClassVisual(result, requested);
}
export function applyClassGfxVisualToSource(
  source: string,
  visual: MermaidVisualModel,
) {
  let model = readClassProjectionModel(source, visual);
  if (!model) throw new Error("Invalid Class Source");
  const apply = (result: ClassCommandResult) => {
    if (result.status === "rejected")
      throw new Error(result.diagnostic ?? "Rejected Class mutation");
    model = result.model;
  };
  for (const node of visual.nodes) {
    const binding = classProjectionBinding(node),
      data = classNodeGfxData(node);
    if (!binding || !data) continue;
    if (data.kind === "class") {
      const original = model.nodes.find(
        (n) => n.sourceKey === binding.sourceKey,
      );
      if (original && original.label !== node.label)
        apply(editClass(model, binding.sourceKey, { label: node.label }));
      for (const detail of node.details ?? []) {
        const member = model.nodes
          .flatMap((n) => n.members)
          .find((m) => m.id === detail.id);
        if (member && member.raw !== detail.label)
          apply(editClassMember(model, member.id, { raw: detail.label }));
      }
    } else if (data.kind === "note") {
      const original = model.notes.find(
        (n) => n.sourceKey === binding.sourceKey,
      );
      if (original && node.label !== getNoteText(original.text))
        apply(editClassNote(model, original.id, { text: node.label }));
    }
  }
  for (const edge of visual.edges) {
    const relation = model.relations.find((r) => r.sourceKey === edge.id);
    if (!relation) {
      const data = classEdgeGfxData(edge);
      const fromSourceId = classProjectionBinding(
        visual.nodes.find((n) => n.id === edge.source) ?? {},
      )?.sourceId;
      const toSourceId = classProjectionBinding(
        visual.nodes.find((n) => n.id === edge.target) ?? {},
      )?.sourceId;
      if (data && !data.noteLink && fromSourceId && toSourceId)
        apply(
          connectClasses(model, {
            fromSourceId,
            toSourceId,
            sourceKey: edge.id,
            kind: data.relationKind,
            label: edge.label,
            fromCardinality: data.fromCardinality,
            toCardinality: data.toCardinality,
          }),
        );
      continue;
    }
    const from = classProjectionBinding(
        visual.nodes.find((n) => n.id === edge.source) ?? {},
      )?.sourceId,
      to = classProjectionBinding(
        visual.nodes.find((n) => n.id === edge.target) ?? {},
      )?.sourceId;
    const data = classEdgeGfxData(edge);
    if (
      data?.relationKind !== relation.kind ||
      from !== relation.fromSourceId ||
      to !== relation.toSourceId ||
      edge.label !== relation.label
    )
      apply(
        editClassRelation(model, relation.id, {
          ...(data ? classRelationSemantics(data.relationKind) : {}),
          fromSourceId: from,
          toSourceId: to,
          label: edge.label,
        }),
      );
  }
  for (const node of visual.nodes) {
    if (classNodeGfxData(node)?.kind !== "class") continue;
    const original = model.nodes.find((n) => n.sourceKey === node.id);
    const parent = (visual.subgraphs ?? [])
      .filter((g) => g.nodeIds.includes(node.id))
      .sort((a, b) => {
        const id = (g: typeof a) =>
          String(
            mermaidVisualFamilyPayload(g.familyData, "class")?.sourceId ?? "",
          );
        return id(b).split(".").length - id(a).split(".").length;
      })[0];
    const namespaceId = parent
      ? String(
          mermaidVisualFamilyPayload(parent.familyData, "class")?.sourceId ??
            "",
        ) || null
      : null;
    if (original && original.namespaceId !== namespaceId)
      apply(setClassNamespace(model, original.sourceKey, namespaceId));
  }
  for (const group of visual.subgraphs ?? []) {
    const original = model.namespaces.find((n) => n.sourceKey === group.id);
    if (!original) continue;
    const parent = visual.subgraphs?.find((g) => g.id === group.parentId);
    const parentId = parent
      ? String(
          mermaidVisualFamilyPayload(parent.familyData, "class")?.sourceId ??
            "",
        ) || null
      : null;
    if (original.parentId !== parentId && model.hierarchicalNamespaces)
      apply(moveClassNamespace(model, original.sourceKey, parentId));
    const title = model.hierarchicalNamespaces ? original.label : original.id;
    if (group.title !== title)
      apply(
        editClassNamespace(model, original.sourceKey, { label: group.title }),
      );
  }
  visual.familyData = classModelFamilyData(model);
  return model.sourceDocument.source;
}
function getNoteText(text: string) {
  return text.replaceAll("<br/>", "\n").replaceAll("\\n", "\n");
}
