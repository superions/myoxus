// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  readSourceYaml,
  sourceYamlFieldPatch,
  type SourceValuePatch,
  type SourceYaml,
} from "../source-yaml.js";
import type {
  KanbanSourceDocument,
  KanbanSourceRecord,
} from "./source-document.js";
import { scanKanbanSource } from "./source-document.js";

/** The native lexer accepts case variants; its public detector only accepts lowercase. */
export function projectKanbanNativeRenderSource(source: string) {
  const header = scanKanbanSource(source).records.find(
    (record) => record.kind === "header",
  );
  if (!header) return source;
  const keyword = /kanban/i.exec(header.raw);
  if (!keyword) return source;
  const start = header.range.start + keyword.index;
  return (
    source.slice(0, start) + "kanban" + source.slice(start + keyword[0].length)
  );
}

// 11.17.2 reads sectionWidth/ticketBaseUrl. Padding reads mindmap.padding instead; no padding control.
export const KANBAN_EFFECTIVE_CONFIG_FIELDS = [
  "sectionWidth",
  "ticketBaseUrl",
] as const;
export type KanbanConfigScope = {
  yaml: SourceYaml;
  prefix: string;
  record: KanbanSourceRecord;
};
export function readKanbanConfig(source: KanbanSourceDocument) {
  const scopes: KanbanConfigScope[] = [];
  const effective: Record<string, unknown> = { sectionWidth: 200 };
  const invalid: string[] = [];
  for (const record of source.records) {
    if (record.kind !== "frontmatter" && record.kind !== "directive") continue;
    if (
      record.kind === "directive" &&
      record.complete &&
      !/^%%\{\s*(?:init|initialize)\s*:/i.test(record.raw.trim())
    )
      continue;
    const start =
      record.kind === "frontmatter"
        ? (/\r\n|\r|\n/.exec(record.raw)?.index ?? 3) +
          (/\r\n|\r|\n/.exec(record.raw)?.[0].length ?? 0)
        : record.raw.indexOf("%%{") + 2;
    const end =
      record.kind === "frontmatter"
        ? record.raw.lastIndexOf("---")
        : record.raw.lastIndexOf("}%%") + 1;
    const yaml = record.complete
      ? readSourceYaml(record.raw.slice(start, end), record.range.start + start)
      : null;
    if (!yaml) {
      invalid.push(record.sourceKey);
      continue;
    }
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : "init" in yaml.values
          ? "init"
          : "initialize";
    const config = yaml.values[prefix];
    const kanban =
      config && typeof config === "object" && "kanban" in config
        ? config.kanban
        : undefined;
    if (kanban && typeof kanban === "object" && !Array.isArray(kanban))
      Object.assign(effective, kanban);
    scopes.push({ yaml, prefix, record });
  }
  return { scopes, effective, invalid };
}
export function kanbanConfigPatch(
  source: KanbanSourceDocument,
  field: string,
  value: unknown,
): SourceValuePatch[] | null {
  if (!field || /[\r\n]/.test(field)) return null;
  if (
    field === "sectionWidth" &&
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  )
    return null;
  const { scopes, invalid } = readKanbanConfig(source);
  if (invalid.length) return null;
  const scope =
    scopes.findLast((item) => {
      const config = item.yaml.values[item.prefix];
      return (
        config &&
        typeof config === "object" &&
        "kanban" in config &&
        config.kanban &&
        typeof config.kanban === "object" &&
        field in config.kanban
      );
    }) ?? scopes.at(-1);
  if (scope)
    return sourceYamlFieldPatch(
      scope.yaml,
      [scope.prefix, "kanban", field],
      value,
    );
  if (value === undefined) return [];
  const header = source.records.find((item) => item.kind === "header");
  if (!header) return null;
  return [
    {
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify({ kanban: { [field]: value } })}}%%${source.newline}`,
    },
  ];
}
