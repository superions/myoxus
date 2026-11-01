// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../source-hash.js";
import { applyRequirementOrderedStyles } from "./ordered-styles.js";
import { partitionMermaidSourcePreamble } from "../diagram-types.js";
import type {
  MermaidRequirementElement,
  MermaidRequirementModel,
  MermaidRequirementNode,
  MermaidRequirementRelation,
} from "./model.js";
import type { RequirementSourceDiagnostic } from "./diagnostics.js";
import {
  REQUIREMENT_HEADER,
  REQUIREMENT_CSS_ID_LIST,
  REQUIREMENT_RELATIONS,
  REQUIREMENT_RISKS,
  REQUIREMENT_TYPES,
  REQUIREMENT_VERIFICATION_METHODS,
  readRequirementString,
  type RequirementPropertyName,
} from "./runtime-contract.js";
import {
  scanRequirementSource,
  type RequirementRange,
  type RequirementSourceDocument,
  type RequirementSourceRecord,
} from "./source-document.js";

/** Keep every occurrence, but expose the native first definition per namespace
 * and first property within that definition. Alias and optional domain ID are
 * never used to reconcile the Source record identities. */
export function resolveMermaidRequirementSource(
  source: string,
  previous?: RequirementSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  const document = scanRequirementSource(source, previous, mapping);
  const requirements: MermaidRequirementNode[] = [],
    elements: MermaidRequirementElement[] = [],
    relations: MermaidRequirementRelation[] = [];
  const reqs = new Map<string, MermaidRequirementNode>(),
    els = new Map<string, MermaidRequirementElement>();
  const valueAt = (range?: RequirementRange) =>
    range ? source.slice(range.start, range.end) : "";
  const issue = (
    code: RequirementSourceDiagnostic["code"],
    r: RequirementSourceRecord,
    range = r.range,
    allowed?: readonly string[],
  ) =>
    document.diagnostics.push({
      code,
      range,
      sourceKey: r.sourceKey,
      construct: valueAt(range),
      severity:
        code === "missing-reference" || code === "ambiguous-reference"
          ? "warning"
          : "error",
      ...(allowed ? { allowed } : {}),
    });
  const header = document.records.find((r) => r.kind === "header");
  if (!header || !REQUIREMENT_HEADER.test(header.raw.trim()))
    document.diagnostics.push({
      code: "missing-header",
      range: { start: 0, end: 0, line: 1 },
      construct: "requirementDiagram",
      severity: "error",
    });
  let direction: NonNullable<MermaidRequirementModel["direction"]> = "TB",
    accTitle: string | undefined,
    accDescr: string | undefined;
  let block:
    | {
        record: RequirementSourceRecord;
        kind: string;
        alias: string;
        props: Map<RequirementPropertyName, string>;
        keys: Partial<Record<RequirementPropertyName, string[]>>;
      }
    | undefined;
  const lineEndAfter = (offset: number) =>
    /^(?:(?:\r\n|\n)|[ \t]*[%#][^\r\n]*(?:\r\n|\n))/.test(source.slice(offset));
  for (const r of document.records) {
    if (!r.complete) {
      issue("incomplete-record", r);
      continue;
    }
    if (["frontmatter", "directive", "comment", "blank"].includes(r.kind))
      continue;
    if (r.kind === "header") {
      if (r !== header) issue("invalid-record", r);
      continue;
    }
    if (!header || r.range.start < header.range.start) {
      issue("invalid-record", r);
      continue;
    }
    if (r.kind === "object-open") {
      if (block) issue("unclosed-object", block.record);
      const alias = readRequirementString(valueAt(r.values.alias));
      if (alias === null) issue("invalid-value", r, r.values.alias);
      if (!lineEndAfter(r.range.end)) issue("invalid-record", r);
      block = {
        record: r,
        kind: valueAt(r.values.kind),
        alias: alias ?? "",
        props: new Map(),
        keys: {},
      };
      continue;
    }
    if (r.kind === "property") {
      if (
        !block ||
        r.blockKey !== block.record.sourceKey ||
        !r.values.name ||
        !r.values.value
      ) {
        issue("invalid-property", r);
        continue;
      }
      const name = valueAt(r.values.name)
        .trim()
        .toLowerCase() as RequirementPropertyName;
      const allowed =
        block.record.namespace === "element"
          ? ["type", "docref"]
          : ["id", "text", "risk", "verifymethod"];
      if (!allowed.includes(name)) {
        issue("invalid-property", r, r.values.name, allowed);
        continue;
      }
      const raw = valueAt(r.values.value);
      let value: string | null;
      if (name === "risk" || name === "verifymethod") {
        const values =
          name === "risk"
            ? REQUIREMENT_RISKS
            : REQUIREMENT_VERIFICATION_METHODS;
        value = values.find((v) => v === raw.toLowerCase()) ?? null;
        if (value === null) issue("invalid-value", r, r.values.value, values);
      } else {
        value = readRequirementString(raw);
        if (value === null) issue("invalid-value", r, r.values.value);
      }
      if (value !== null) {
        if (!block.props.has(name)) block.props.set(name, value);
        (block.keys[name] ??= []).push(r.sourceKey);
      }
      if (r.eol === "\r" || (!r.eol && !lineEndAfter(r.range.end)))
        issue("invalid-record", r);
      continue;
    }
    if (r.kind === "object-close") {
      if (!block || r.blockKey !== block.record.sourceKey) {
        issue("invalid-record", r);
        continue;
      }
      const { alias, props, keys, record } = block;
      if (record.namespace === "element") {
        if (!els.has(alias)) {
          const item: MermaidRequirementElement = {
            sourceKey: record.sourceKey,
            propertyKeys: keys,
            id: alias,
            name: alias,
            order: elements.length,
            elementType: props.get("type") ?? "",
            docRef: props.get("docref") ?? "",
            width: Math.max(170, Math.min(280, 96 + alias.length * 8)),
            x: 420,
            y: 60 + elements.length * 130,
          };
          elements.push(item);
          els.set(alias, item);
        }
      } else if (!reqs.has(alias)) {
        const kind = REQUIREMENT_TYPES.find(
          (k) => k.toLowerCase() === block!.kind.toLowerCase(),
        );
        if (!kind) issue("invalid-record", record);
        const item: MermaidRequirementNode = {
          sourceKey: record.sourceKey,
          propertyKeys: keys,
          id: alias,
          name: alias,
          order: requirements.length,
          requirementId: props.get("id") ?? "",
          requirementType: kind ?? "requirement",
          risk: props.get("risk") ?? "",
          text: props.get("text") ?? "",
          verifyMethod: props.get("verifymethod") ?? "",
          width: Math.max(180, Math.min(300, 100 + alias.length * 8)),
          x: 56,
          y: 60 + requirements.length * 140,
        };
        requirements.push(item);
        reqs.set(alias, item);
      }
      block = undefined;
      continue;
    }
    if (r.kind === "relation") {
      const left = readRequirementString(valueAt(r.values.left)),
        right = readRequirementString(valueAt(r.values.right));
      const kind = REQUIREMENT_RELATIONS.find(
        (k) => k === valueAt(r.values.relationship).toLowerCase(),
      );
      if (left === null || right === null || !kind) {
        issue("invalid-record", r, r.range, REQUIREMENT_RELATIONS);
        continue;
      }
      const sourceForm = source
        .slice(r.values.left!.end, r.values.relationship!.start)
        .includes("<-")
        ? "left"
        : "right";
      const from = sourceForm === "left" ? right : left,
        to = sourceForm === "left" ? left : right;
      relations.push({
        sourceKey: r.sourceKey,
        sourceForm,
        id: `relation-${from}-${to}-${relations.length + 1}`,
        from,
        to,
        kind,
        order: relations.length,
      });
      continue;
    }
    if (block) {
      issue("invalid-record", r);
      continue;
    }
    if (r.kind === "direction") {
      const match = /^\s*direction\s+(TB|BT|LR|RL)[^\r\n]*$/i.exec(r.raw);
      if (match) direction = match[1]!.toUpperCase() as typeof direction;
      else issue("invalid-value", r, r.range, ["TB", "BT", "LR", "RL"]);
    } else if (r.kind === "accessibility-title")
      accTitle = r.raw.slice(r.raw.indexOf(":") + 1).trim();
    else if (r.kind === "accessibility-description")
      accDescr = /^\s*accDescr\s*\{/i.test(r.raw)
        ? r.raw.slice(r.raw.indexOf("{") + 1, r.raw.lastIndexOf("}")).trim()
        : r.raw.slice(r.raw.indexOf(":") + 1).trim();
    else if (
      [
        "style",
        "style-definition",
        "style-assignment",
        "inline-class",
      ].includes(r.kind)
    ) {
      const valid =
        r.kind === "inline-class"
          ? new RegExp(
              `^[ \\t]*(?:"[^"]+"|[\\w][^:,\\r\\n{}<>\\-=]*?)[ \\t]*:::[ \\t]*${REQUIREMENT_CSS_ID_LIST}[ \\t]*$`,
            ).test(r.raw) &&
            r.references.length === 1 &&
            readRequirementString(valueAt(r.references[0]!.range)) !== null
          : r.kind === "style-assignment"
            ? new RegExp(
                `^[ \\t]*class[ \\t]+${REQUIREMENT_CSS_ID_LIST}[ \\t]+${REQUIREMENT_CSS_ID_LIST}[ \\t]*$`,
                "i",
              ).test(r.raw)
            : new RegExp(
                `^[ \\t]*(?:style|classDef)[ \\t]+${REQUIREMENT_CSS_ID_LIST}[ \\t]+[\\w\\s:#,;%-]+$`,
                "i",
              ).test(r.raw);
      if (!valid) issue("invalid-record", r);
    } else issue("invalid-record", r);
  }
  if (block) issue("unclosed-object", block.record);
  // Separate namespace cards, with the same preference as the native renderer.
  // Reference ambiguity is reported locally rather than merging either object.
  for (const el of elements)
    if (reqs.has(el.name)) el.id = `element:${el.sourceKey}`;
  for (const relation of relations) {
    const record = document.records.find(
      (r) => r.sourceKey === relation.sourceKey,
    )!;
    for (const [alias, field, side] of [
      [
        relation.from,
        "fromId",
        relation.sourceForm === "left" ? "right" : "left",
      ],
      [relation.to, "toId", relation.sourceForm === "left" ? "left" : "right"],
    ] as const) {
      const req = reqs.get(alias),
        el = els.get(alias);
      relation[field] = (req ?? el)?.id;
      if (!req && !el) issue("missing-reference", record, record.values[side]);
      else if (req && el)
        issue("ambiguous-reference", record, record.values[side]);
    }
  }
  const preamble = partitionMermaidSourcePreamble(
    source.slice(0, header?.range.start ?? 0).split(/\r\n|\r|\n/),
  );
  const model: MermaidRequirementModel | null = document.diagnostics.some(
    (d) => d.severity === "error",
  )
    ? null
    : {
        sourceDocument: document,
        diagnostics: document.diagnostics,
        diagramType: "requirementDiagram",
        directives: preamble.directives,
        headerLine: header!.raw.trim(),
        sourceAnnotations: document.records
          .filter((r) => r.kind === "comment")
          .map((r) => r.raw),
        requirements,
        elements,
        relations,
        direction,
        accTitle,
        accDescr,
        sourceHash: hashMermaidSource(source),
        version: 1,
      };
  if (model) applyRequirementOrderedStyles(model);
  return { model, document, diagnostics: document.diagnostics };
}

export function parseMermaidRequirementSource(
  source: string,
  previous?: RequirementSourceDocument,
  mapping?: ReadonlyMap<number, string>,
): MermaidRequirementModel | null {
  return resolveMermaidRequirementSource(source, previous, mapping).model;
}
