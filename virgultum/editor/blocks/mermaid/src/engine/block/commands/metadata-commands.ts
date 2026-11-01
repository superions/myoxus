// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "../model.js";
import { blockConfigPatches, isBlockPadding } from "../config.js";
import { nextBlockSourceKey } from "../source-document.js";
import {
  blockNoChange,
  writeBlockPatches,
  type BlockWriteOptions,
} from "../writer.js";
import { writeMermaidDiagramTitle } from "../../diagram-title.js";
import { readSourceYaml, sourceYamlFieldPatch } from "../../source-yaml.js";
import { parseDocument, stringify } from "yaml";
import { mermaidMessages as m } from "../../../i18n.js";
import {
  blockRecord,
  blockInsertion,
  blockDeletionPatches,
} from "./block-commands.js";
export function setBlockPadding(
  m: MermaidBlockDiagramModel,
  padding: number,
  o: BlockWriteOptions = {},
) {
  if (!isBlockPadding(padding)) return blockNoChange(m, "invalid");
  const p = blockConfigPatches(m.sourceDocument, { padding });
  return p
    ? writeBlockPatches(m, p, {
        ...o,
        impact: {
          records: [],
          grids: [null, ...m.groups.map((g) => g.bodyKey)],
        },
      })
    : blockNoChange(m, "invalid");
}
export function editBlockMetadata(
  m: MermaidBlockDiagramModel,
  args: {
    key?: string;
    kind: "classDef" | "class" | "style";
    targets: string;
    value: string;
    parent?: string | null;
    delete?: boolean;
  },
  o: BlockWriteOptions = {},
) {
  if (
    !/^\w+(?:,\s*\w+)*$/.test(args.targets) ||
    (args.kind === "classDef" && args.targets.includes(",")) ||
    /[\r\n]/.test(args.value)
  )
    return blockNoChange(m, "invalid");
  const r = args.key ? blockRecord(m, args.key) : undefined;
  if (args.key && (!r || r.kind !== args.kind))
    return blockNoChange(m, "invalid");
  if (r) {
    if (args.delete) {
      const owned = m.sourceDocument.records.filter(
          (c) =>
            c.sourceKey === r.sourceKey ||
            (c.range.start >= r.range.start && c.range.end <= r.range.end),
        ),
        removed = new Set(owned.map((c) => c.sourceKey));
      return writeBlockPatches(
        m,
        blockDeletionPatches(m, removed, [
          { start: r.range.start, end: r.range.end + r.eol.length },
        ]),
        { ...o, removed },
      );
    }
    return writeBlockPatches(
      m,
      [
        { range: r.values.targets!, value: args.targets },
        { range: r.values.value!, value: args.value },
      ],
      { ...o, selection: r.sourceKey },
    );
  }
  const i = blockInsertion(m, args.parent ?? null);
  if (!i || args.delete) return blockNoChange(m, "invalid");
  const key = nextBlockSourceKey();
  return writeBlockPatches(
    m,
    [
      {
        range: { start: i.start, end: i.start },
        value:
          i.prefix +
          i.indent +
          `${args.kind} ${args.targets} ${args.value}` +
          i.newline,
        identities: [[i.prefix.length, key]],
      },
    ],
    { ...o, selection: key },
  );
}
export function editBlockComment(
  m: MermaidBlockDiagramModel,
  args: {
    key?: string;
    text?: string;
    anchor?: string;
    position?: "before" | "after";
    delete?: boolean;
  },
  o: BlockWriteOptions = {},
) {
  const r = args.key ? blockRecord(m, args.key) : undefined;
  if (args.key && r?.kind !== "comment") return blockNoChange(m, "invalid");
  if (r && !args.anchor) {
    const text =
      args.text ?? m.comments.find((c) => c.sourceKey === r.sourceKey)!.text;
    if (/[\r\n]/.test(text)) return blockNoChange(m, "invalid");
    return writeBlockPatches(
      m,
      [
        {
          range: args.delete
            ? { start: r.range.start, end: r.range.end + r.eol.length }
            : r.range,
          value: args.delete ? "" : r.indent + "%% " + text,
        },
      ],
      {
        ...o,
        removed: args.delete ? new Set([r.sourceKey]) : undefined,
        selection: args.delete ? undefined : r.sourceKey,
      },
    );
  }
  const anchor = args.anchor ? blockRecord(m, args.anchor) : undefined;
  if (!anchor || args.delete) return blockNoChange(m, "invalid");
  const text =
    args.text ??
    m.comments.find((c) => c.sourceKey === r?.sourceKey)?.text ??
    "";
  if (/[\r\n]/.test(text)) return blockNoChange(m, "invalid");
  const start =
      args.position === "after"
        ? anchor.range.end + anchor.eol.length
        : anchor.range.start,
    key = r?.sourceKey ?? nextBlockSourceKey(),
    prefix =
      start && !/[\r\n]$/.test(m.sourceDocument.source.slice(0, start))
        ? m.sourceDocument.newline
        : "";
  return writeBlockPatches(
    m,
    [
      ...(r
        ? [
            {
              range: { start: r.range.start, end: r.range.end + r.eol.length },
              value: "",
            },
          ]
        : []),
      {
        range: { start, end: start },
        value: prefix + anchor.indent + "%% " + text + m.sourceDocument.newline,
        identities: [[prefix.length, key]],
      },
    ],
    { ...o, commentTransfers: new Set(r ? [r.sourceKey] : []), selection: key },
  );
}

const BLOCK_KNOWN_GLOBAL_OPTIONS = new Set([
  "theme",
  "themeVariables",
  "themeCSS",
  "look",
  "layout",
  "darkMode",
  "fontFamily",
  "fontSize",
  "altFontFamily",
  "securityLevel",
  "startOnLoad",
  "logLevel",
  "htmlLabels",
  "maxTextSize",
  "maxEdges",
  "deterministicIds",
  "deterministicIDSeed",
  "suppressErrorRendering",
  "secure",
  "wrap",
  "handDrawnSeed",
  "forceLegacyMathML",
  "legacyMathML",
  "flowchart",
  "sequence",
  "gantt",
  "journey",
  "timeline",
  "kanban",
  "class",
  "state",
  "er",
  "pie",
  "quadrantChart",
  "xyChart",
  "requirement",
  "mindmap",
  "gitGraph",
  "c4",
  "sankey",
  "packet",
  "radar",
  "treemap",
  "architecture",
]);
function blockMetadataYaml(model: MermaidBlockDiagramModel, key: string) {
  const record = blockRecord(model, key);
  if (!record || !["frontmatter", "directive"].includes(record.kind))
    return null;
  const start =
    record.kind === "frontmatter"
      ? (/^[^\r\n]*(?:\r\n|\r|\n)/.exec(record.raw)?.[0].length ?? 0)
      : record.raw.indexOf("%%{") + 2;
  const end =
    record.kind === "frontmatter"
      ? record.raw.lastIndexOf("---")
      : record.raw.lastIndexOf("}%%") + 1;
  return readSourceYaml(
    record.raw.slice(start, end),
    record.range.start + start,
  );
}
/** Data exposes only foreign metadata leaves. Known Block settings and the title
 * stay at their typed controls, even when they share this same YAML record. */
export function readBlockOpaqueConfig(model: MermaidBlockDiagramModel) {
  const entries: { recordKey: string; path: string[]; raw: string }[] = [];
  for (const record of model.sourceDocument.records) {
    const yaml = blockMetadataYaml(model, record.sourceKey);
    if (!yaml) continue;
    const visit = (values: Record<string, unknown>, path: string[]) => {
      for (const [name, value] of Object.entries(values)) {
        const next = [...path, name];
        if (
          (!path.length ||
            ["config", "init", "initialize"].includes(path.at(-1)!)) &&
          BLOCK_KNOWN_GLOBAL_OPTIONS.has(name)
        )
          continue;
        if (record.kind === "frontmatter" && !path.length && name === "title")
          continue;
        if (path.at(-1) === "block" && name === "padding") continue;
        if (
          ["config", "init", "initialize", "block"].includes(name) &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        )
          visit(value as Record<string, unknown>, next);
        else
          entries.push({
            recordKey: record.sourceKey,
            path: next,
            raw: stringify(value).trimEnd(),
          });
      }
    };
    visit(yaml.values, []);
  }
  return entries;
}
export function editBlockOpaqueConfig(
  model: MermaidBlockDiagramModel,
  key: string,
  path: readonly string[],
  raw: string,
  options: BlockWriteOptions = {},
) {
  const yaml = blockMetadataYaml(model, key);
  if (
    !yaml ||
    !readBlockOpaqueConfig(model).some(
      (e) =>
        e.recordKey === key &&
        e.path.length === path.length &&
        e.path.every((v, i) => v === path[i]),
    )
  )
    return blockNoChange(model, "invalid", m.classPatchRejected());
  try {
    const doc = parseDocument(raw, { uniqueKeys: true, schema: "core" });
    if (doc.errors.length)
      return blockNoChange(model, "invalid", m.classPatchRejected());
    const patches = sourceYamlFieldPatch(
      yaml,
      path,
      doc.toJS({ maxAliasCount: 100 }),
    );
    return patches
      ? writeBlockPatches(model, patches, options)
      : blockNoChange(model, "invalid", m.classPatchRejected());
  } catch {
    return blockNoChange(model, "invalid", m.classPatchRejected());
  }
}
/** Use the global YAML title owner and retain Block record identities. */
export function editBlockDiagramTitle(
  model: MermaidBlockDiagramModel,
  title: string,
  options: BlockWriteOptions = {},
) {
  const source = model.sourceDocument.source;
  if (!title.trim())
    return blockNoChange(model, "invalid", m.classPatchRejected());
  const next = writeMermaidDiagramTitle({
    source,
    diagramType: model.diagramType,
    title: title.trim(),
  });
  if (next === null)
    return blockNoChange(model, "invalid", m.classPatchRejected());
  let start = 0,
    end = source.length,
    nextEnd = next.length;
  while (start < end && start < nextEnd && source[start] === next[start])
    start++;
  while (
    end > start &&
    nextEnd > start &&
    source[end - 1] === next[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }
  return writeBlockPatches(
    model,
    [{ range: { start, end }, value: next.slice(start, nextEnd) }],
    options,
  );
}
