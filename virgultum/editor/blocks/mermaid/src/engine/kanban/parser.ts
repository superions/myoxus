// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../utils.js";
import { detectMermaidDiagramType } from "../diagram-types.js";
import { readKanbanConfig } from "./config.js";
import { readSourceYaml, readSourceYamlParts } from "../source-yaml.js";
import type { MermaidKanbanModel, MermaidKanbanNode } from "./model.js";
import {
  reconcileKanbanSource,
  scanKanbanSource,
  type KanbanRange,
  type KanbanSourceRecord,
} from "./source-document.js";

function valueRange(
  record: KanbanSourceRecord,
  start: number,
  end: number,
): KanbanRange {
  return {
    start: record.range.start + start,
    end: record.range.start + end,
    line:
      record.range.line +
      record.raw.slice(0, start).split(/\r\n|\r|\n/).length -
      1,
  };
}
function decodeLabel(raw: string) {
  const value =
    raw.startsWith('"`') && raw.endsWith('`"')
      ? raw.slice(2, -2)
      : raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
  return value
    .replaceAll("#91;", "[")
    .replaceAll("#93;", "]")
    .replaceAll("#quot;", '"');
}

/** Mirrors the installed Jison lexer, not Flowchart shapes: getData uses fixed Kanban shapes. */
function parseNode(
  record: KanbanSourceRecord,
  order: number,
): MermaidKanbanNode | null {
  const raw = record.raw;
  let cursor = record.indent.length;
  const idStart = cursor;
  while (cursor < raw.length && !/[([\n){}@]/.test(raw[cursor]!)) cursor++;
  const idEnd = cursor;
  const explicitId = raw.slice(idStart, idEnd).trim() || undefined;
  let label = explicitId ?? "";
  let delimiter: readonly [string, string] = ["", ""];
  let labelRange: KanbanRange | undefined;
  const open = /^(?:-\)|\(-|\)\)|\)|\(\(|\{\{|\(|\[)/.exec(raw.slice(cursor));
  if (open) {
    cursor += open[0].length;
    const start = cursor;
    let end: number;
    if (raw.slice(cursor).startsWith('"`')) {
      end = raw.indexOf('`"', cursor + 2);
      if (end < 0) return null;
      cursor = end + 2;
    } else if (raw[cursor] === '"') {
      end = raw.indexOf('"', cursor + 1);
      if (end < 0) return null;
      cursor = end + 1;
    } else {
      while (cursor < raw.length && !/[)\](}]/.test(raw[cursor]!)) cursor++;
    }
    if (cursor === start) return null;
    labelRange = valueRange(record, start, cursor);
    label = decodeLabel(raw.slice(start, cursor));
    const close = /^(?:\)\)|\)|\]|\}\}|\(-|-\)|\(\(|\()/.exec(
      raw.slice(cursor),
    );
    if (!close) return null;
    delimiter = [open[0], close[0]];
    cursor += close[0].length;
  } else if (!explicitId) return null;
  const metadataInsertion = record.range.start + cursor;
  const node: MermaidKanbanNode = {
    id: record.sourceKey,
    sourceKey: record.sourceKey,
    explicitId,
    nativeId: explicitId ?? label,
    label,
    order,
    indent: record.indent,
    delimiter,
    labelRange,
    idRange: explicitId
      ? valueRange(
          record,
          idStart,
          idStart + raw.slice(idStart, idEnd).trimEnd().length,
        )
      : undefined,
    metadata: {},
    metadataInsertion,
    decorationRanges: [],
    writable: record.complete,
  };
  const metadataParts: { raw: string; offset: number }[] = [];
  while (cursor < raw.length) {
    while (/\s/.test(raw[cursor] ?? "") && cursor < raw.length) cursor++;
    if (cursor >= raw.length || raw.slice(cursor).startsWith("%%")) break;
    if (raw.slice(cursor).startsWith("@{")) {
      const start = cursor;
      cursor += 2;
      const bodyStart = cursor;
      let quoted = false;
      while (cursor < raw.length) {
        if (raw[cursor] === '"') quoted = !quoted;
        if (!quoted && raw[cursor] === "}") break;
        cursor++;
      }
      if (cursor >= raw.length) return null;
      const content = raw.slice(bodyStart, cursor);
      metadataParts.push({
        raw: content,
        offset: record.range.start + bodyStart,
      });
      cursor++;
      node.metadataRange = valueRange(record, start, cursor);
    } else if (raw.slice(cursor).startsWith("::icon(")) {
      const end = raw.indexOf(")", cursor + 7);
      if (end < 0) return null;
      const range = valueRange(record, cursor, end + 1);
      const icon = raw.slice(cursor + 7, end);
      node.icon = icon;
      node.decorationRanges.push({
        field: "icon",
        range,
        valueRange: valueRange(record, cursor + 7, end),
        recordKey: record.sourceKey,
      });
      cursor = end + 1;
    } else if (raw.slice(cursor).startsWith(":::")) {
      node.className = raw.slice(cursor + 3);
      node.decorationRanges.push({
        field: "class",
        range: valueRange(record, cursor, raw.length),
        valueRange: valueRange(record, cursor + 3, raw.length),
        recordKey: record.sourceKey,
      });
      cursor = raw.length;
    } else return null;
  }
  if (metadataParts.length) {
    const yaml = readSourceYamlParts(metadataParts);
    const content = metadataParts.map((part) => part.raw).join("");
    const nativeContent = content.replace(/"[^"]*"/g, (value) =>
      value.replace(/\r\n|\r|\n/g, "<br/>"),
    );
    const nativeYaml =
      nativeContent === content
        ? yaml
        : readSourceYaml(
            /[\r\n]/.test(nativeContent) ? nativeContent : `{${nativeContent}}`,
            0,
          );
    if (!yaml || !nativeYaml) node.writable = false;
    else {
      node.metadata = nativeYaml.values;
      node.metadataYaml = yaml;
      const values = node.metadata;
      if (
        values.shape &&
        (typeof values.shape !== "string" ||
          values.shape !== values.shape.toLowerCase() ||
          values.shape.includes("_"))
      )
        node.writable = false;
      if (values.label) node.label = String(values.label);
      if (
        values.icon &&
        !node.decorationRanges.some((range) => range.field === "icon")
      )
        node.icon = String(values.icon);
    }
  }
  return node;
}

export function parseMermaidKanbanSource(
  source: string,
  previous?: MermaidKanbanModel,
  mapping?: ReadonlyMap<number, string>,
): MermaidKanbanModel | null {
  if (detectMermaidDiagramType(source) !== "kanban") return null;
  const sourceDocument = reconcileKanbanSource(
    scanKanbanSource(source),
    previous?.sourceDocument,
    mapping,
  );
  const model: MermaidKanbanModel = {
    cards: [],
    columns: [],
    comments: [],
    diagnostics: [],
    ambiguous: false,
    headerId: "",
    sourceDocument,
    sourceHash: hashMermaidSource(source),
    diagramType: "kanban",
    version: 1,
  };
  let columnIndent: number | undefined;
  let currentColumn: string | undefined;
  let latest: MermaidKanbanNode | undefined;
  for (const record of sourceDocument.records) {
    if (!record.complete) {
      model.ambiguous = true;
      model.diagnostics.push({
        code: record.kind === "node" ? "metadata" : "config",
        range: record.range,
        anchorId: record.sourceKey,
      });
      continue;
    }
    if (record.kind === "header") {
      if (!/^kanban(?:\s*(?:%%.*)?)?$/i.test(record.raw.trim())) {
        model.ambiguous = true;
        model.diagnostics.push({
          code: "header",
          range: record.range,
          anchorId: record.sourceKey,
        });
      }
      model.headerId = record.sourceKey;
      const commentOffset = record.raw.indexOf("%%");
      if (commentOffset >= 0)
        model.comments.push({
          id: `${record.sourceKey}:inline`,
          text: record.raw.slice(commentOffset + 2).trim(),
          range: valueRange(record, commentOffset, record.raw.length),
          indent: "",
          anchorId: null,
          affinity: "position",
          inline: true,
        });
      continue;
    }
    if (["frontmatter", "directive", "blank", "comment"].includes(record.kind))
      continue;
    if (!model.headerId) continue;
    if (record.kind === "decoration" && latest) {
      const icon = /^\s*::icon\(([^)]+)\)\s*$/.exec(record.raw);
      const cls = /^\s*:::(.+)$/.exec(record.raw);
      if (icon || cls) {
        const field = icon ? "icon" : "class";
        const value = (icon ?? cls)![1]!;
        const start = record.raw.indexOf(value);
        latest.decorationRanges.push({
          field,
          range: record.range,
          valueRange: valueRange(record, start, start + value.length),
          recordKey: record.sourceKey,
        });
        if (icon) latest.icon = value;
        else latest.className = value;
        continue;
      }
    }
    const node = parseNode(record, 0);
    if (!node) {
      model.diagnostics.push({
        code: "syntax",
        range: record.range,
        anchorId: record.sourceKey,
      });
      continue;
    }
    if (!node.writable)
      model.diagnostics.push({
        code: "metadata",
        range: record.range,
        anchorId: node.id,
      });
    if (columnIndent === undefined) columnIndent = node.indent.length;
    if (node.indent.length < columnIndent) {
      model.ambiguous = true;
      model.diagnostics.push({
        code: "hierarchy",
        range: record.range,
        anchorId: node.id,
      });
      continue;
    }
    if (node.indent.length === columnIndent) {
      node.order = model.columns.length;
      model.columns.push(node);
      currentColumn = node.id;
    } else if (currentColumn) {
      node.order = model.cards.filter(
        (card) => card.columnId === currentColumn,
      ).length;
      model.cards.push({ ...node, columnId: currentColumn });
    }
    latest =
      model.cards.at(-1)?.id === node.id
        ? model.cards.at(-1)
        : model.columns.at(-1);
  }
  const objects = [...model.columns, ...model.cards];
  for (const node of objects) {
    if (
      objects.filter((other) => other.nativeId === node.nativeId).length > 1
    ) {
      node.writable = false;
      model.diagnostics.push({
        code: "duplicate-id",
        range: sourceDocument.records.find(
          (record) => record.sourceKey === node.id,
        )!.range,
        anchorId: node.id,
      });
    }
  }
  for (let index = 0; index < sourceDocument.records.length; index++) {
    const record = sourceDocument.records[index]!;
    if (record.kind !== "comment") continue;
    let next = index + 1;
    while (
      sourceDocument.records[next]?.kind === "comment" &&
      sourceDocument.records[next]?.indent === record.indent
    )
      next++;
    let first = index;
    while (
      sourceDocument.records[first - 1]?.kind === "comment" &&
      sourceDocument.records[first - 1]?.indent === record.indent
    )
      first--;
    const following = sourceDocument.records[next];
    const object = objects.find((node) => node.id === following?.sourceKey);
    const anchored =
      object &&
      following?.indent === record.indent &&
      sourceDocument.records[first - 1]?.kind !== "header";
    model.comments.push({
      id: record.sourceKey,
      text: record.raw.trim().replace(/^%%\s?/, ""),
      range: record.range,
      indent: record.indent,
      anchorId: anchored ? object.id : null,
      affinity: anchored ? "object" : "position",
    });
  }
  for (const node of objects) {
    const record = sourceDocument.records.find(
      (record) => record.sourceKey === node.id,
    )!;
    const lastDecoration =
      node.decorationRanges
        .filter((item) => item.recordKey === record.sourceKey)
        .at(-1)?.range.end ??
      node.metadataRange?.end ??
      node.metadataInsertion;
    const offset = record.raw.indexOf(
      "%%",
      lastDecoration - record.range.start,
    );
    if (offset >= 0)
      model.comments.push({
        id: `${record.sourceKey}:inline`,
        text: record.raw.slice(offset + 2).trim(),
        range: valueRange(record, offset, record.raw.length),
        indent: "",
        anchorId: node.id,
        affinity: "object",
        inline: true,
      });
  }
  for (const id of readKanbanConfig(sourceDocument).invalid) {
    const record = sourceDocument.records.find(
      (record) => record.sourceKey === id,
    )!;
    if (!model.diagnostics.some((item) => item.anchorId === id))
      model.diagnostics.push({
        code: "config",
        range: record.range,
        anchorId: id,
      });
  }
  if (model.ambiguous) {
    for (const node of objects) node.writable = false;
  }
  return model;
}
