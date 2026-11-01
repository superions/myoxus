// SPDX-License-Identifier: AGPL-3.0-or-later
import { hashMermaidSource } from "../../utils.js";
import { hasInvalidMermaidHashPreambleLine } from "../diagram-types.js";
import { readBlockConfig, blockConnectionAppearance } from "./config.js";
import {
  scanBlockSource,
  reconcileBlockSource,
  type BlockSourceDocument,
  type BlockSourceRecord,
} from "./source-document.js";
import type {
  MermaidBlockDiagramModel,
  MermaidBlockNode,
  BlockFieldBinding,
} from "./model.js";
import type { BlockDiagnostic } from "./diagnostics.js";

type Entity = MermaidBlockNode & {
  composite: boolean;
  bodyKey?: string;
  columns?: number;
  columnsKey?: string;
  explicitId?: boolean;
};
/** Resolve Source in the same depth-first order as BlockDB. Geometry is a family
 * projection; recoverable native resolution/render defects retain the records. */
export function resolveMermaidBlockSource(
  source: string,
  previous?: MermaidBlockDiagramModel | BlockSourceDocument,
  mapping?: ReadonlyMap<number, string>,
  objectKeys?: ReadonlyMap<string, string>,
) {
  const document = reconcileBlockSource(
    scanBlockSource(source),
    previous &&
      ("sourceDocument" in previous ? previous.sourceDocument : previous),
    mapping,
  );
  const diagnostics: BlockDiagnostic[] = [...document.diagnostics];
  const preamble = document.records
    .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
    .map((r) => r.raw);
  const header = document.records.find((r) => r.kind === "header");
  if (
    header &&
    hasInvalidMermaidHashPreambleLine(
      source.slice(0, header.range.start).split(/\r\n|\r|\n/),
    )
  )
    diagnostics.push({
      stage: "syntax",
      code: "invalid-record",
      range: header.range,
      construct: "preamble",
    });
  const configRead = readBlockConfig(document);
  for (const r of configRead.invalidRecords)
    diagnostics.push({
      stage: "syntax",
      code: "invalid-record",
      range: {
        ...r.range,
        line: document.records.find((d) => d === r)?.range.line ?? 1,
      },
      construct: r.kind,
    });
  if (diagnostics.some((d) => d.stage === "syntax"))
    return { document, diagnostics, model: null };
  const model: MermaidBlockDiagramModel = {
    sourceDocument: document,
    diagnostics,
    config: configRead.config,
    columns: -1,
    diagramType: "block",
    directives: preamble,
    edges: [],
    groups: [],
    nodes: [],
    comments: [],
    spaces: [],
    styleStatements: [],
    sourceHash: hashMermaidSource(source),
    headerLine: header!.raw.trim(),
    version: 1,
  };
  const entities = new Map<string, Entity>();
  const retainedKeys =
    objectKeys ??
    new Map(
      previous && "sourceDocument" in previous
        ? [...previous.nodes, ...previous.groups].map((n) => [
            n.id,
            n.sourceKey,
          ])
        : [],
    );
  const retainedOccurrences = new Map<string, string>();
  if (previous && "sourceDocument" in previous)
    for (const n of [...previous.nodes, ...previous.groups])
      for (const key of n.recordKeys) {
        const r = previous.sourceDocument.records.find(
          (r) => r.sourceKey === key,
        );
        for (const [index, e] of (r?.endpoints ?? []).entries())
          if (e.id === n.id)
            retainedOccurrences.set(`${key}:${index}`, n.sourceKey);
      }
  const issue = (
    r: BlockSourceRecord,
    stage: BlockDiagnostic["stage"],
    code: BlockDiagnostic["code"],
    construct: string,
  ) =>
    diagnostics.push({
      stage,
      code,
      range: r.range,
      sourceKey: r.sourceKey,
      scope: r.parentKey ?? undefined,
      construct,
    });
  for (const field of configRead.invalid) {
    const record = document.records.find(
      (r) => r.kind === "frontmatter" || r.kind === "directive",
    )!;
    issue(record, "render", "invalid-padding", field);
  }
  if (configRead.config.padding > 10000) {
    const record = document.records.find(
      (r) => r.kind === "frontmatter" || r.kind === "directive",
    )!;
    issue(record, "render", "unsafe-geometry", "padding");
  }
  const byKey = new Map(document.records.map((r) => [r.sourceKey, r]));
  const scopeIds = new Map(
    document.records
      .filter((r) => r.kind === "composite")
      .map((r) => [r.sourceKey, r.endpoints?.[0]?.id ?? r.sourceKey]),
  );
  const field = (r: BlockSourceRecord, index = 0): BlockFieldBinding => ({
    sourceKey: r.sourceKey,
    endpoint: index,
  });
  const define = (
    r: BlockSourceRecord,
    index: number,
    composite = false,
    placed = true,
  ) => {
    const endpoint = r.endpoints?.[index];
    const id = endpoint?.id ?? r.sourceKey;
    const existing = entities.get(id);
    const binding = field(r, index);
    if (existing) {
      if (!existing.recordKeys.includes(r.sourceKey))
        existing.recordKeys.push(r.sourceKey);
      if (
        composite ||
        (endpoint && endpoint.syntax !== "bare" && endpoint.syntax !== "custom")
      ) {
        existing.composite = composite;
        existing.shape = endpoint?.shape ?? "rect";
        existing.syntax = endpoint?.syntax ?? "bare";
        existing.sourceOpen = endpoint?.sourceOpen ?? "";
        existing.sourceClose = endpoint?.sourceClose ?? "";
        existing.providers.shape = binding;
        if (composite && !existing.bodyKey) {
          existing.bodyKey = r.sourceKey;
          existing.columns = -1;
          existing.explicitId = Boolean(endpoint);
        }
      }
      // Native BlockDB keeps first span/directions/parent but aggregates label/type.
      const label =
        composite && endpoint?.syntax === "bare" ? "" : (endpoint?.label ?? "");
      if (label !== id) {
        existing.label = label || (composite ? "" : id);
        existing.providers.label = binding;
      }
      return existing;
    }
    const e: Entity = {
      sourceKey:
        retainedKeys.get(id) ??
        retainedOccurrences.get(`${r.sourceKey}:${index}`) ??
        (r.kind === "connection"
          ? `${r.sourceKey}:${index ? "to" : "from"}`
          : r.sourceKey),
      recordKeys: [r.sourceKey],
      providers: {
        label: binding,
        shape: binding,
        span: binding,
        directions: binding,
      },
      directions: endpoint?.directions ?? [],
      id,
      label:
        composite && endpoint?.syntax === "bare"
          ? ""
          : (endpoint?.label ?? (composite ? "" : id)),
      order: r.order + index / 100,
      parentId: r.parentKey ? (scopeIds.get(r.parentKey) ?? "") : "",
      parentKey: r.parentKey,
      gridPlacement: placed && id !== "root",
      shape: endpoint?.shape ?? "rect",
      sourceClose: endpoint?.sourceClose ?? "",
      sourceOpen: endpoint?.sourceOpen ?? "",
      span: r.kind === "connection" ? 1 : (endpoint?.span ?? 1),
      syntax: endpoint?.syntax ?? "bare",
      classes: [],
      styles: [],
      composite,
      ...(composite
        ? { bodyKey: r.sourceKey, columns: -1, explicitId: Boolean(endpoint) }
        : {}),
    };
    entities.set(id, e);
    return e;
  };
  const visit = (scope: string | null, visible: boolean) => {
    for (const r of document.records.filter((r) => r.parentKey === scope)) {
      if (r.kind === "columns") {
        const raw = source.slice(
            r.values.columns!.start,
            r.values.columns!.end,
          ),
          columns = raw === "auto" ? -1 : Number(raw);
        if (scope) {
          const e = entities.get(scopeIds.get(scope)!);
          if (e?.bodyKey === scope) {
            e.columns = columns;
            e.columnsKey = r.sourceKey;
          }
        } else {
          model.columns = columns;
          model.columnsKey = r.sourceKey;
        }
        if (!Number.isSafeInteger(columns) || columns > 10000)
          issue(r, "render", "unsafe-geometry", `columns ${raw}`);
        if (columns === 0) issue(r, "render", "zero-columns", "columns 0");
      } else if (r.kind === "composite") {
        const e = define(r, 0, true, visible);
        visit(
          r.sourceKey,
          visible &&
            e.bodyKey === r.sourceKey &&
            e.recordKeys[0] === r.sourceKey,
        );
      } else if (r.kind === "block") define(r, 0, false, visible);
      else if (r.kind === "space") {
        const range = r.values.span,
          span = range ? Number(source.slice(range.start, range.end)) : 1;
        model.spaces.push({
          sourceKey: r.sourceKey,
          id: r.sourceKey,
          parentKey: scope,
          parentId: scope ? scopeIds.get(scope)! : "",
          order: r.order,
          span,
        });
      } else if (r.kind === "connection") {
        // The pinned recursive production loses its left AST when chained. Keep
        // all occurrences editable and report that native resolution defect.
        if (!r.chained) {
          define(r, 0, false, visible);
          define(r, 1, false, visible);
        } else {
          define(r, r.endpoints!.length - 1, false, visible);
          issue(r, "resolution", "unresolved-reference", r.endpoints![0]!.id);
        }
        const from = r.chained ? "" : r.endpoints![0]!.id,
          to = r.endpoints!.at(-1)!.id;
        model.edges.push({
          sourceKey: r.sourceKey,
          id: r.sourceKey,
          from,
          to,
          token: r.connector!.token,
          startToken: r.connector!.startToken,
          labelSource: r.connector!.labelSource,
          label: r.connector!.label,
          order: model.edges.length,
          parentKey: scope,
          resolved: !r.chained,
          ...blockConnectionAppearance(r.connector!.token),
        });
      } else if (["classDef", "class", "style"].includes(r.kind)) {
        const targets = source.slice(
            r.values.targets!.start,
            r.values.targets!.end,
          ),
          value = source
            .slice(r.values.value!.start, r.values.value!.end)
            .trim();
        model.styleStatements.push({
          sourceKey: r.sourceKey,
          kind: r.kind as "classDef" | "class" | "style",
          order: model.styleStatements.length,
          parentKey: scope,
          targets,
          value,
        });
        if (r.kind === "class") {
          for (const [refIndex, ref] of r.references.entries()) {
            let e = entities.get(ref.id);
            if (!e) {
              e = define(
                {
                  ...r,
                  endpoints: [
                    {
                      id: ref.id,
                      consumed: 0,
                      directions: [],
                      label: ref.id,
                      shape: "rect",
                      sourceOpen: "",
                      sourceClose: "",
                      span: 1,
                      syntax: "bare",
                      role: "block",
                      range: ref.range,
                      values: { id: ref.range },
                      labelForm: "bare",
                    },
                  ],
                },
                0,
                false,
                false,
              );
              e.sourceKey =
                retainedKeys.get(ref.id) ?? `${r.sourceKey}:class-${refIndex}`;
            }
            e.classes.push(value);
          }
        } else if (r.kind === "style" && value) {
          // BlockDB applies inline style to this exact ID, unlike class's list.
          const e = entities.get(targets);
          if (e) e.styles = value.split(",");
          else issue(r, "resolution", "unresolved-reference", targets);
        }
      }
    }
  };
  visit(null, true);
  for (const e of entities.values()) {
    const { composite, bodyKey, columns, columnsKey, explicitId, ...node } = e;
    const record = byKey.get(e.recordKeys[0]!)!;
    if (!e.gridPlacement)
      issue(record, "resolution", "missing-grid-placement", e.id);
    if (!Number.isSafeInteger(e.span) || e.span > 10000)
      issue(record, "render", "unsafe-geometry", e.id);
    if (e.span === 0) issue(record, "render", "zero-span", e.id);
    const parentColumns = e.parentKey
      ? (entities.get(e.parentId)?.columns ?? -1)
      : model.columns;
    if (parentColumns > 0 && e.span > parentColumns)
      issue(record, "render", "span-overflow", e.id);
    if (composite)
      model.groups.push({
        ...node,
        bodyKey: bodyKey ?? e.sourceKey,
        columns: columns ?? -1,
        columnsKey,
        explicitId: explicitId ?? true,
      });
    else model.nodes.push(node);
  }
  for (const space of model.spaces)
    if (!Number.isSafeInteger(space.span) || space.span > 10000)
      issue(byKey.get(space.sourceKey)!, "render", "unsafe-geometry", "space");
  for (const parent of [null, ...model.groups.map((g) => g.bodyKey)]) {
    const columns = parent
      ? model.groups.find((g) => g.bodyKey === parent)!.columns
      : model.columns;
    let slot = 0;
    for (const n of [...model.nodes, ...model.groups, ...model.spaces]
      .filter(
        (n) =>
          n.parentKey === parent &&
          (!("gridPlacement" in n) || n.gridPlacement),
      )
      .sort((a, b) => a.order - b.order)) {
      slot +=
        columns > 0 && "syntax" in n
          ? Math.min(n.span, columns - (slot % columns))
          : n.span;
      if (!Number.isSafeInteger(slot) || slot > 10000) {
        issue(
          byKey.get(
            [...model.nodes, ...model.groups].find(
              (o) => o.sourceKey === n.sourceKey,
            )?.recordKeys[0] ?? n.sourceKey,
          )!,
          "render",
          "unsafe-geometry",
          "grid slots",
        );
        break;
      }
    }
  }
  for (const r of document.records.filter((r) => r.kind === "comment")) {
    const candidates = document.records.filter(
      (c) =>
        c.parentKey === r.parentKey &&
        ![
          "blank",
          "comment",
          "end",
          "frontmatter",
          "directive",
          "header",
        ].includes(c.kind),
    );
    const before = candidates
        .filter((c) => c.range.end <= r.range.start)
        .at(-1),
      after = candidates.find((c) => c.range.start >= r.range.end);
    const containing = candidates.find(
      (c) => c.range.start < r.range.start && c.range.end >= r.range.end,
    );
    const inline = Boolean(containing) || before?.range.line === r.range.line;
    const adjacentNext = after && after.range.line <= r.range.line + 1;
    const owner =
      containing ??
      (inline ? before : adjacentNext ? after : (before ?? after));
    model.comments.push({
      sourceKey: r.sourceKey,
      text: r.raw.trim().replace(/^(?:%%|#)\s?/, ""),
      parentKey: r.parentKey,
      anchorKey: owner?.sourceKey,
      position: inline ? "inline" : owner === after ? "before" : "after",
    });
  }
  return { document, diagnostics, model };
}
export function parseMermaidBlockDiagramSource(source: string) {
  return resolveMermaidBlockSource(source).model;
}
