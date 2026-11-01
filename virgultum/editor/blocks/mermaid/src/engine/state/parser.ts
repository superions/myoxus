// SPDX-License-Identifier: AGPL-3.0-or-later
import { hashMermaidSource } from "../../utils.js";
import {
  detectMermaidDiagramType,
  getMermaidFrontmatterTitle,
} from "../diagram-types.js";
import {
  isStartStateId,
  isEndStateId,
  stateEffectiveDescriptions,
  type MermaidStateNode,
  type MermaidStateComposite,
  type MermaidStateRegion,
  type MermaidStateDirection,
  type MermaidStateModel,
  type MermaidStateTransition,
  type MermaidStateNote,
  type MermaidStateLink,
  type MermaidStateNodeKind,
  type StateStyle,
  type StateComment,
} from "./model.js";
import {
  scanStateSource,
  reconcileStateSource,
  stateRecordValue,
  stateRenderReferences,
  type StateSourceRecord,
  type StateRange,
} from "./source-document.js";
import type { StateSourceDiagnostic } from "./diagnostics.js";
function upsertState(
  states: Map<string, MermaidStateNode>,
  id: string,
  partial: Partial<
    Pick<
      MermaidStateNode,
      "kind" | "label" | "order" | "parentId" | "regionIndex" | "sourceId"
    >
  > = {},
) {
  const existing = states.get(id);
  if (existing) {
    states.set(id, {
      ...existing,
      ...partial,
      label: partial.label ?? existing.label,
      parentId: partial.parentId ?? existing.parentId,
      regionIndex: partial.regionIndex ?? existing.regionIndex,
      sourceId: partial.sourceId ?? existing.sourceId,
    });
    return;
  }
  const order = partial.order ?? states.size;
  const kind =
    partial.kind ??
    (isStartStateId(id) ? "start" : isEndStateId(id) ? "end" : "state");
  const label = partial.label ?? (kind === "state" ? id : "");
  states.set(id, {
    id,
    kind,
    label,
    order,
    parentId: partial.parentId,
    regionIndex: partial.regionIndex,
    sourceId: partial.sourceId,
  });
}

function upsertComposite(
  composites: Map<string, MermaidStateComposite>,
  id: string,
  label: string,
  parentId?: string,
  regionIndex?: number,
) {
  const existing = composites.get(id);
  if (existing) {
    composites.set(id, {
      ...existing,
      label: label || existing.label,
      parentId: parentId ?? existing.parentId,
      regionIndex: regionIndex ?? existing.regionIndex,
    });
    return;
  }
  const order = composites.size;
  composites.set(id, {
    id,
    label: label || id,
    nodeIds: [],
    order,
    parentId,
    regionIndex,
  });
}

export function stateStyleProperties(
  source: string,
  range: StateRange,
): StateStyle["properties"] {
  const properties: StateStyle["properties"] = [];
  let start = range.start,
    quote = "",
    depth = 0;
  for (let i = start; i <= range.end; i++) {
    const c = source[i];
    if ((c === '"' || c === "'") && source[i - 1] !== "\\")
      quote = quote === c ? "" : quote || c;
    if (!quote && (c === "(" || c === "[")) depth++;
    if (!quote && (c === ")" || c === "]")) depth--;
    if (i < range.end && (c !== "," || quote || depth)) continue;
    const raw = source.slice(start, i),
      colon = raw.indexOf(":");
    if (colon >= 0) {
      const value = raw.slice(colon + 1),
        leading = value.length - value.trimStart().length;
      properties.push({
        name: raw.slice(0, colon).trim(),
        value: value.trim(),
        range: { ...range, start, end: i },
        valueRange: {
          ...range,
          start: start + colon + 1 + leading,
          end: i - (value.length - value.trimEnd().length),
        },
      });
    }
    start = i + 1;
  }
  return properties;
}

/** One record parser serves both headers. Internal object keys and ranges are
 * carried by checked writers; no synthetic identity is added to Mermaid text. */
export function resolveMermaidStateSource(
  source: string,
  previous?: MermaidStateModel,
  mapping?: ReadonlyMap<number, string>,
  stateKeys?: ReadonlyMap<string, string>,
  commentAnchors?: ReadonlyMap<
    string,
    Pick<StateComment, "anchorKind" | "anchorId" | "position">
  >,
) {
  const document = reconcileStateSource(
    scanStateSource(source),
    previous?.sourceDocument,
    mapping,
  );
  const diagramType = detectMermaidDiagramType(source);
  const states = new Map<string, MermaidStateNode>(),
    composites = new Map<string, MermaidStateComposite>();
  const transitions: MermaidStateTransition[] = [],
    regions: MermaidStateRegion[] = [],
    notes: MermaidStateNote[] = [],
    links: MermaidStateLink[] = [];
  const styles: StateStyle[] = [],
    styleStatements: string[] = [],
    commentRecords: StateComment[] = [];
  let direction: MermaidStateDirection = "TB",
    accessibilityTitle = "",
    accessibilityDescription = "",
    hideEmptyDescription = false,
    scaleWidth: number | undefined;
  const stack: Array<{
    id: string;
    key: string;
    regionKey: string;
    regionIndex: number;
  }> = [];
  const issue = (
    record: StateSourceRecord,
    code: StateSourceDiagnostic["code"],
    construct = record.raw.trim(),
  ) => {
    document.diagnostics.push({
      code,
      line: record.range.line,
      column: record.indent.length + 1,
      sourceKey: record.sourceKey,
      scope: record.parentId ?? undefined,
      construct,
    });
  };
  if (diagramType !== "stateDiagram" && diagramType !== "stateDiagram-v2") {
    document.diagnostics.push({
      code: "missing-header",
      line: 1,
      column: 1,
      construct: "stateDiagram / stateDiagram-v2",
    });
    return { model: null, document, diagnostics: document.diagnostics };
  }
  const objectKey = (id: string) =>
    stateKeys?.get(id) ??
    previous?.states.find((s) => s.id === id)?.sourceKey ??
    previous?.composites.find((s) => s.id === id)?.sourceKey ??
    `state-object-${hashMermaidSource(id)}`;
  const stateFor = (
    id: string,
    record: StateSourceRecord,
    kind: MermaidStateNodeKind = "state",
    explicit = false,
  ) => {
    if (composites.has(id)) return undefined;
    if (!states.has(id)) {
      upsertState(states, id, {
        kind,
        order: document.records.indexOf(record),
        parentId: record.parentId ?? undefined,
        regionIndex: record.parentId ? record.regionIndex : undefined,
      });
      Object.assign(states.get(id)!, {
        sourceKey: objectKey(id),
        declaration: "implicit",
        descriptions: [],
        recordKeys: [],
        relationKeys: [],
        regionKey: record.regionKey,
        cssClasses: [],
      });
    }
    const state = states.get(id)!;
    if (explicit)
      Object.assign(state, {
        parentId: record.parentId ?? undefined,
        regionIndex: record.parentId ? record.regionIndex : undefined,
        regionKey: record.regionKey,
      });
    return state;
  };
  const reference = (
    record: StateSourceRecord,
    field: string,
    id: string,
    after = 0,
  ) => {
    const end = stateRecordValue(record, field, id, after);
    if (record.values[field])
      record.references.push({ id, range: record.values[field]! });
    return end;
  };
  const description = (
    record: StateSourceRecord,
    id: string,
    text: string,
    form: "alias" | "description",
    field = "text",
  ) => {
    const target = composites.get(id) ?? stateFor(id, record, "state", true)!;
    target.descriptions ??= [];
    target.descriptions.push({
      id: field === "text" ? record.sourceKey : `${record.sourceKey}:${field}`,
      recordKey: record.sourceKey,
      text,
      form,
    });
    const effective = stateEffectiveDescriptions(target);
    target.label = effective[0]?.text.trim() || id;
    if (composites.has(id) && effective.length > 1)
      issue(record, "composite-description", id);
    stateRecordValue(
      record,
      field,
      text,
      form === "alias"
        ? record.raw.indexOf('"') + 1
        : record.values.id
          ? record.values.id.end - record.range.start
          : 0,
    );
    target.recordKeys ??= [];
    if (!target.recordKeys.includes(record.sourceKey))
      target.recordKeys.push(record.sourceKey);
  };
  let foundHeader = false;
  for (const record of document.records) {
    const scope = stack.at(-1);
    Object.assign(record, {
      parentId: scope?.id ?? null,
      parentKey: scope?.key ?? null,
      regionKey: scope?.regionKey ?? null,
      regionIndex: scope?.regionIndex ?? 0,
    });
    if (!record.complete) {
      issue(
        record,
        record.kind === "note" ? "unclosed-note" : "incomplete-record",
      );
      continue;
    }
    if (["frontmatter", "directive", "blank", "comment"].includes(record.kind))
      continue;
    const raw = record.raw.trim();
    if (!foundHeader && raw === diagramType) {
      record.kind = "header";
      foundHeader = true;
      continue;
    }
    if (record.kind === "accessibility-description") {
      const start = record.raw.indexOf("{") + 1,
        end = record.raw.lastIndexOf("}");
      record.values.text = {
        ...record.range,
        start: record.range.start + start,
        end: record.range.start + end,
      };
      accessibilityDescription = record.raw.slice(start, end).trim();
      continue;
    }
    const acc = /^(accTitle|accDescr)\s*:\s*([\s\S]*)$/i.exec(raw);
    if (acc) {
      record.kind =
        acc[1]!.toLowerCase() === "acctitle"
          ? "accessibility-title"
          : "accessibility-description";
      stateRecordValue(record, "text", acc[2]!, record.raw.indexOf(":") + 1);
      if (record.kind === "accessibility-title") accessibilityTitle = acc[2]!;
      else accessibilityDescription = acc[2]!;
      continue;
    }
    const dir = /^direction\s+(TB|BT|LR|RL)\s*$/i.exec(raw);
    if (dir) {
      record.kind = "direction";
      stateRecordValue(record, "direction", dir[1]!);
      if (scope) {
        if (
          composites.get(scope.id)!.primaryRegionKey === `${scope.key}:region`
        )
          composites.get(scope.id)!.direction =
            dir[1]!.toUpperCase() as MermaidStateDirection;
      } else direction = dir[1]!.toUpperCase() as MermaidStateDirection;
      continue;
    }
    if (/^hide\s+empty\s+description$/i.test(raw)) {
      record.kind = "source-option";
      hideEmptyDescription = true;
      continue;
    }
    const scale = /^scale\s+(\d+)\s+width$/i.exec(raw);
    if (scale) {
      record.kind = "source-option";
      scaleWidth = Number(scale[1]);
      stateRecordValue(record, "width", scale[1]!);
      continue;
    }
    const style =
      /^(classDef|class|style)\s+(\w+(?:,\s*\w+)*)[^\S\r\n]+([\s\S]*)$/i.exec(
        record.raw.trimStart(),
      );
    if (style) {
      if (
        (style[1]!.toLowerCase() !== "class" && /\s/.test(style[2]!)) ||
        (style[1]!.toLowerCase() === "classdef" && style[2]!.includes(","))
      ) {
        issue(record, "invalid-record");
        continue;
      }
      const kind =
        style[1]!.toLowerCase() === "classdef"
          ? "definition"
          : style[1]!.toLowerCase() === "class"
            ? "assignment"
            : "inline";
      record.kind =
        kind === "definition"
          ? "class-definition"
          : kind === "assignment"
            ? "class-assignment"
            : "style";
      stateRecordValue(record, "targets", style[2]!);
      stateRecordValue(
        record,
        "properties",
        style[3]!,
        record.values.targets!.end - record.range.start,
      );
      if (!style[3])
        record.values.properties = { ...record.range, start: record.range.end };
      const owners = style[2]!.split(",").map((v) => v.trim()),
        values = style[3]!.replace(/;$/, "").trim();
      let referenceOffset = record.values.targets!.start - record.range.start;
      if (kind !== "definition")
        for (const id of owners) {
          const target = composites.get(id) ?? states.get(id);
          if (kind === "assignment" && target) {
            target.cssClasses ??= [];
            target.cssClasses.push(
              ...values.split(/\s*,\s*|\s+/).filter(Boolean),
            );
          }
          const at = record.raw.indexOf(id, referenceOffset);
          referenceOffset = at + id.length;
          record.references.push({
            id,
            range: {
              ...record.range,
              start: record.range.start + at,
              end: record.range.start + at + id.length,
            },
          });
        }
      styles.push({
        id: record.sourceKey,
        sourceKey: record.sourceKey,
        kind,
        owners,
        styles: kind === "assignment" ? values.split(/\s*,\s*|\s+/) : [],
        properties:
          kind === "assignment"
            ? []
            : stateStyleProperties(source, record.values.properties!),
      });
      record.ownerId = style[2]!;
      styleStatements.push(raw);
      continue;
    }
    const link =
      /^click\s+([^:\s{}-]+)\s+(?:href\s+)?"([^"]*)"(?:\s+"([^"]*)")?\s*$/i.exec(
        raw,
      );
    if (link) {
      record.kind = "link";
      record.ownerId = link[1]!;
      reference(record, "id", link[1]!);
      stateRecordValue(
        record,
        "url",
        link[2]!,
        record.values.id!.end - record.range.start,
      );
      if (link[3] !== undefined)
        stateRecordValue(
          record,
          "tooltip",
          link[3]!,
          record.values.url!.end - record.range.start,
        );
      links.push({
        sourceKey: record.sourceKey,
        stateId: link[1]!,
        url: link[2]!,
        tooltip: link[3] ?? "",
      });
      continue;
    }
    const floating = /^note\s+"([^"]*)"\s+as\s+([^\r\n]+?)\s*$/i.exec(raw);
    const attached =
      /^note\s+(left|right)\s+of\s+([^:\s{}-]+)(?:[ \t]*:[ \t]*((?:#(?:\d+|\w+);|[^:\r\n;])+)|[ \t]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)[ \t]*end\s+note)\s*$/i.exec(
        raw,
      );
    if (floating || attached) {
      record.kind = "note";
      const floatingId = floating?.[2],
        stateId = attached?.[2],
        text = floating?.[1] ?? attached?.[3] ?? attached?.[4] ?? "";
      if (floatingId)
        reference(
          record,
          "id",
          floatingId,
          record.raw.indexOf('"', record.raw.lastIndexOf('"')),
        );
      if (stateId) {
        reference(record, "id", stateId);
        stateFor(stateId, record);
      }
      stateRecordValue(
        record,
        "text",
        text.trim(),
        floating
          ? record.raw.indexOf('"') + 1
          : record.values.id!.end - record.range.start,
      );
      notes.push({
        sourceKey: record.sourceKey,
        id: record.sourceKey,
        floatingId,
        stateId,
        // Source indentation belongs to the record range, not the editable
        // Note text. Reapplying it in a field patch must not double each line.
        label:
          attached?.[4] !== undefined
            ? text
                .split(/\r\n|\r|\n/)
                .map((line) => line.trim())
                .join("\n")
                .trim()
            : text.trim(),
        placement:
          attached?.[1]?.toLowerCase() === "left" ? "left of" : "right of",
        form: floating
          ? "floating"
          : attached?.[3] !== undefined
            ? "inline"
            : "multiline",
        order: document.records.indexOf(record),
        parentId: record.parentId ?? undefined,
        regionIndex: record.parentId ? record.regionIndex : undefined,
        regionKey: record.regionKey,
        effective: true,
      });
      record.ownerId = floatingId ?? stateId;
      continue;
    }
    const composite =
      /^state\s+(?:"([^"]*)"\s+as\s+([^\r\n{]+?)|([^\s{]+))\s*\{$/i.exec(raw);
    if (composite) {
      const id = (composite[2] ?? composite[3])!.trim();
      if (stack.some((s) => s.id === id)) {
        issue(record, "ambiguous-record", id);
        continue;
      }
      const implicit = states.get(id),
        existing = composites.get(id);
      upsertComposite(
        composites,
        id,
        composite[1] || existing?.label || implicit?.label || id,
        record.parentId ?? undefined,
        record.parentId ? record.regionIndex : undefined,
      );
      const target = composites.get(id)!;
      Object.assign(target, {
        sourceKey: objectKey(id),
        primaryRegionKey:
          existing?.primaryRegionKey ?? `${record.sourceKey}:region`,
        descriptions: existing?.descriptions ?? implicit?.descriptions ?? [],
        recordKeys: [
          ...(existing?.recordKeys ?? implicit?.recordKeys ?? []),
          record.sourceKey,
        ],
        cssClasses: existing?.cssClasses ?? implicit?.cssClasses ?? [],
        regionKey: record.regionKey,
        order: existing?.order ?? document.records.indexOf(record),
      });
      states.delete(id);
      record.kind = "composite";
      record.ownerId = id;
      reference(
        record,
        "id",
        id,
        composite[1] ? record.raw.lastIndexOf('"') + 1 : 0,
      );
      if (composite[1]) description(record, id, composite[1], "alias");
      stack.push({
        id,
        key: record.sourceKey,
        regionKey: `${record.sourceKey}:region`,
        regionIndex: 0,
      });
      continue;
    }
    if (raw === "}") {
      record.kind = "end";
      const open = stack.pop();
      if (!open) issue(record, "invalid-record");
      else {
        record.ownerId = open.id;
        const opener = document.records.find((r) => r.sourceKey === open.key)!;
        opener.closeKey = record.sourceKey;
        composites.get(open.id)!.closeKey = record.sourceKey;
      }
      continue;
    }
    if (/^--$/.test(raw)) {
      record.kind = "region";
      if (!scope) {
        issue(record, "invalid-region");
        continue;
      }
      scope.regionIndex++;
      const previousKey = scope.regionKey;
      scope.regionKey = record.sourceKey;
      regions.push({
        sourceKey: record.sourceKey,
        previousKey,
        id: record.sourceKey,
        compositeId: scope.id,
        regionIndex: scope.regionIndex,
        order: document.records.indexOf(record),
      });
      continue;
    }
    const transition =
      /^(\[\*\]|[^:\s{}-]+)(?::::([^:\s{}-]+))?\s*-->\s*(\[\*\]|[^:\s{}-]+)(?::::([^:\s{}-]+))?(?:\s*:\s*([\s\S]*))?$/.exec(
        raw,
      );
    if (transition) {
      record.kind = "transition";
      const endpoint = (value: string, side: "from" | "to") => {
        if (value !== "[*]") {
          stateFor(value, record);
          return value;
        }
        const kind = side === "from" ? "start" : "end";
        const id =
          diagramType === "stateDiagram"
            ? `${kind}-${record.sourceKey}`
            : `${record.regionKey ?? "root"}::__${kind}__`;
        const state = stateFor(id, record, kind)!;
        state.sourceId = "[*]";
        state.label = "";
        state.declaration = "pseudostate";
        state.relationKeys!.push(record.sourceKey);
        return id;
      };
      const from = endpoint(transition[1]!, "from"),
        to = endpoint(transition[3]!, "to");
      let after = reference(record, "from", transition[1]!);
      if (transition[2])
        after = stateRecordValue(record, "fromClass", transition[2], after);
      after = reference(
        record,
        "to",
        transition[3]!,
        Math.max(after, record.raw.indexOf("-->") + 3),
      );
      if (transition[4])
        after = stateRecordValue(record, "toClass", transition[4], after);
      if (transition[5] !== undefined)
        stateRecordValue(record, "text", transition[5], after);
      for (const [id, css] of [
        [from, transition[2]],
        [to, transition[4]],
      ] as const)
        if (css) {
          const target = composites.get(id) ?? states.get(id);
          if (target) {
            target.cssClasses ??= [];
            target.cssClasses.push(css);
          }
        }
      transitions.push({
        sourceKey: record.sourceKey,
        id: record.sourceKey,
        from,
        to,
        fromClass: transition[2],
        toClass: transition[4],
        label: transition[5] ?? "",
        order: document.records.indexOf(record),
        parentId: record.parentId ?? undefined,
        regionIndex: record.parentId ? record.regionIndex : undefined,
        regionKey: record.regionKey,
      });
      continue;
    }
    const pseudo =
      /^state\s+([^\r\n]+?)\s*(?:<<(choice|fork|join)>>|\[\[(choice|fork|join)\]\])\s*$/i.exec(
        raw,
      );
    if (pseudo) {
      const id = pseudo[1]!.trim(),
        kind = (pseudo[2] ?? pseudo[3])!.toLowerCase() as MermaidStateNodeKind;
      const target = stateFor(id, record, kind, true);
      record.kind = "pseudostate";
      record.ownerId = id;
      reference(record, "id", id);
      stateRecordValue(record, "kind", pseudo[2] ?? pseudo[3]!);
      if (target) {
        target.kind = kind;
        target.declaration = "pseudostate";
        target.recordKeys!.push(record.sourceKey);
      }
      continue;
    }
    const alias =
      /^state\s+"([^"]*)"\s+as\s+([^:\r\n{]+?)(?:\s*:\s*([^:\r\n]*)(?::[^\r\n]*)?)?$/i.exec(
        raw,
      );
    if (alias) {
      if (!alias[1]) {
        issue(record, "invalid-record");
        continue;
      }
      const id = alias[2]!.trim(),
        target = stateFor(id, record, "state", true);
      record.kind = "state";
      record.ownerId = id;
      reference(record, "id", id, record.raw.lastIndexOf('"') + 1);
      if (target) target.declaration = "alias";
      description(record, id, alias[1]!, "alias");
      if (alias[3] !== undefined)
        description(record, id, alias[3], "description", "body");
      continue;
    }
    const descr = /^([^:\s{}-]+)\s*:(?!:)\s*([\s\S]*)$/.exec(raw);
    if (descr) {
      record.kind = "description";
      record.ownerId = descr[1]!;
      reference(record, "id", descr[1]!);
      description(record, descr[1]!, descr[2]!, "description");
      if (!descr[2])
        record.values.text = { ...record.range, start: record.range.end };
      const target = states.get(descr[1]!);
      if (target && target.declaration === "implicit")
        target.declaration = "description";
      continue;
    }
    const stateDeclaration = /^state\s+([^\s{]+)\s*$/i.exec(raw);
    if (stateDeclaration) {
      // The native lexer consumes this incomplete keyword form without a node.
      // Preserve its bytes; generated plain declarations use the bare ID form.
      record.kind = "opaque";
      continue;
    }
    const bare = /^([^:\s{}-]+)(?::::([^:\s{}-]+))?\s*$/i.exec(raw);
    if (bare) {
      const id = bare[1]!;
      record.kind = "state";
      record.ownerId = id;
      reference(record, "id", id);
      const target = composites.get(id) ?? stateFor(id, record, "state", true)!;
      target.recordKeys ??= [];
      target.recordKeys.push(record.sourceKey);
      if ("declaration" in target) target.declaration = "bare";
      if (bare[2]) {
        stateRecordValue(
          record,
          "classes",
          bare[2],
          record.values.id!.end - record.range.start,
        );
        target.cssClasses ??= [];
        target.cssClasses.push(bare[2]);
      }
      continue;
    }
    record.kind = "opaque";
    issue(record, "invalid-record");
  }
  if (!foundHeader)
    document.diagnostics.push({
      code: "missing-header",
      line: 1,
      column: 1,
      construct: diagramType,
    });
  for (const scope of stack)
    issue(
      document.records.find((r) => r.sourceKey === scope.key)!,
      "unclosed-composite",
      `${scope.id}: }`,
    );
  if (diagramType === "stateDiagram-v2") {
    const remapped = new Map<string, string>();
    for (const open of document.records.filter(
      (r) => r.kind === "composite" && r.closeKey,
    )) {
      const body = document.records.filter(
        (r) => r.parentKey === open.sourceKey && r.kind !== "end",
      );
      const divider = body.findLast((r) => r.kind === "region");
      const concurrent =
        divider &&
        body.some(
          (r) =>
            r.range.start > divider.range.start &&
            !["blank", "comment", "source-option"].includes(r.kind),
        );
      // Native v2 wraps concurrent bodies only when a final document exists.
      // Otherwise all terminal occurrences belong to the named parent document,
      // including those authored in subsequent bodies of that same Composite.
      if (concurrent) continue;
      const canonicalRegion = composites.get(open.ownerId!)!.primaryRegionKey!;
      for (const relation of transitions.filter((t) =>
        body.some((r) => r.sourceKey === t.id),
      )) {
        for (const side of ["from", "to"] as const) {
          const node = states.get(relation[side]);
          if (node?.kind !== "start" && node?.kind !== "end") continue;
          const id = `${canonicalRegion}::__${node.kind}__`;
          if (id === node.id) continue;
          remapped.set(node.id, id);
          const existing = states.get(id);
          if (existing)
            existing.relationKeys = [
              ...new Set([...existing.relationKeys!, ...node.relationKeys!]),
            ];
          else states.set(id, { ...node, id, sourceKey: objectKey(id) });
        }
      }
    }
    for (const transition of transitions) {
      transition.from = remapped.get(transition.from) ?? transition.from;
      transition.to = remapped.get(transition.to) ?? transition.to;
    }
    for (const id of remapped.keys()) states.delete(id);
  }
  // Late Composite declarations replace implicit endpoint nodes with one object.
  // Native dataFetcher overwrites a node's parent for each nested appearance,
  // including relation endpoints. Root appearances omit parentId and therefore
  // cannot erase an earlier nested parent. Annotation-only references do not
  // create rendered nodes. Keep statement scope separate from this final effect.
  const membership = new Map<string, StateSourceRecord>();
  for (const record of document.records)
    if (record.parentId)
      for (const reference of stateRenderReferences(record))
        membership.set(reference.id, record);
  for (const node of [...states.values(), ...composites.values()]) {
    const record = membership.get(node.id);
    if (record)
      Object.assign(node, {
        parentId: record.parentId,
        regionIndex: record.regionIndex,
        regionKey: record.regionKey,
      });
    for (const style of styles)
      if (style.kind === "assignment" && style.owners.includes(node.id))
        node.cssClasses = [
          ...new Set([...(node.cssClasses ?? []), ...style.styles]),
        ];
  }
  for (const composite of composites.values()) {
    states.delete(composite.id);
    const visited = new Set([composite.id]);
    let parent = composite.parentId;
    while (parent) {
      if (visited.has(parent)) {
        const cause =
          membership.get(composite.id) ??
          document.records.find(
            (r) => r.sourceKey === composite.recordKeys?.[0],
          );
        if (cause) issue(cause, "ambiguous-record");
        break;
      }
      visited.add(parent);
      parent = composites.get(parent)?.parentId;
    }
    composite.nodeIds = [...states.values()]
      .filter((n) => n.parentId === composite.id)
      .map((n) => n.id);
  }
  // The native DB applies the last attached note; preserve earlier instructions
  // as separate editable records rather than silently dropping their source.
  const lastNote = new Map<string, string>();
  for (const note of notes)
    if (note.stateId) lastNote.set(note.stateId, note.id);
  for (const note of notes)
    note.effective = !note.stateId || lastNote.get(note.stateId) === note.id;
  for (const record of document.records.filter((r) => r.kind === "comment")) {
    const before = document.records.findLast(
      (r) =>
        r.range.end <= record.range.start &&
        !["comment", "blank", "frontmatter", "directive"].includes(r.kind),
    );
    const after = document.records.find(
      (r) =>
        r.range.start >= record.range.end &&
        !["comment", "blank"].includes(r.kind),
    );
    const separated =
      document.records[document.records.indexOf(record) + 1]?.kind === "blank";
    const anchorRecord =
      before &&
      (before.range.line === record.range.line || before.kind === "end")
        ? before
        : !separated && after?.kind !== "end"
          ? after
          : before;
    const kindFor = (r?: StateSourceRecord): StateComment["anchorKind"] =>
      !r || r.kind === "header"
        ? "diagram"
        : r.kind === "end"
          ? "composite"
          : r.kind === "state" || r.kind === "pseudostate"
            ? "state"
            : [
                  "description",
                  "composite",
                  "transition",
                  "note",
                  "region",
                ].includes(r.kind)
              ? (r.kind as StateComment["anchorKind"])
              : "record";
    const kind = kindFor(anchorRecord);
    const anchorId =
      kind === "diagram"
        ? undefined
        : kind === "state" || kind === "composite"
          ? (
              states.get(anchorRecord?.ownerId ?? "") ??
              composites.get(anchorRecord?.ownerId ?? "")
            )?.sourceKey
          : anchorRecord?.sourceKey;
    const oldAnchor =
      commentAnchors?.get(record.sourceKey) ??
      previous?.commentRecords.find((c) => c.id === record.sourceKey);
    const oldOwner =
      oldAnchor &&
      [...states.values(), ...composites.values()].find(
        (n) => n.sourceKey === oldAnchor.anchorId,
      );
    const oldDescription = [...states.values()]
      .flatMap((n) => n.descriptions ?? [])
      .find((d) => d.id === oldAnchor?.anchorId);
    const primaryOwner = [...composites.values()].find(
      (c) => c.primaryRegionKey === oldAnchor?.anchorId,
    );
    const anchorRecordKey =
      oldDescription?.recordKey ?? primaryOwner?.primaryRegionKey?.slice(0, -7);
    const adjacent =
      oldAnchor &&
      [before, after].some(
        (r) =>
          r &&
          (r.sourceKey === oldAnchor.anchorId ||
            r.sourceKey === anchorRecordKey ||
            oldOwner?.recordKeys?.includes(r.sourceKey) ||
            ("closeKey" in (oldOwner ?? {}) &&
              (oldOwner as MermaidStateComposite).closeKey === r.sourceKey)),
      );
    const inside =
      oldAnchor?.position === "inside" && record.parentId === oldOwner?.id;
    const retainedAnchor =
      oldAnchor &&
      (oldAnchor.anchorKind === "diagram"
        ? !record.parentId
        : adjacent || inside)
        ? oldAnchor
        : undefined;
    commentRecords.push({
      id: record.sourceKey,
      text: record.raw.trim().replace(/^(?:%%|#)\s?/, ""),
      anchorKind: retainedAnchor?.anchorKind ?? kind,
      anchorId: retainedAnchor ? retainedAnchor.anchorId : anchorId,
      position:
        retainedAnchor?.position ??
        (anchorRecord === before ? "after" : "before"),
    });
    stateRecordValue(
      record,
      "text",
      commentRecords.at(-1)!.text,
      record.raw.indexOf(record.raw.trim()[0]!) +
        (record.raw.trim().startsWith("%%") ? 2 : 1),
    );
  }
  if (document.diagnostics.length)
    return { model: null, document, diagnostics: document.diagnostics };
  const model: MermaidStateModel = {
    sourceDocument: document,
    styles,
    commentRecords,
    diagramType,
    sourceHash: hashMermaidSource(source),
    version: 1,
    headerLine: diagramType,
    diagramTitle:
      getMermaidFrontmatterTitle(
        document.records
          .filter((r) => r.kind === "frontmatter")
          .flatMap((r) => r.raw.split(/\r\n|\r|\n/)),
      ) ?? "",
    accessibilityTitle,
    accessibilityDescription,
    direction,
    hideEmptyDescription,
    scaleWidth,
    states: [...states.values()],
    composites: [...composites.values()],
    transitions,
    notes,
    regions,
    links,
    styleStatements,
    directives: document.records
      .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
      .flatMap((r) => r.raw.split(/\r\n|\r|\n/)),
  };
  return { model, document, diagnostics: document.diagnostics };
}
export function parseMermaidStateSource(
  source: string,
  previous?: MermaidStateModel,
  mapping?: ReadonlyMap<number, string>,
  stateKeys?: ReadonlyMap<string, string>,
) {
  return resolveMermaidStateSource(source, previous, mapping, stateKeys).model;
}
