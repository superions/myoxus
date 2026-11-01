// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "../../diagram-title.js";
import type { MermaidErModel, MermaidErComment } from "../model.js";
import { nextErSourceKey } from "../source-document.js";
import { sourceMermaidErEntityName } from "../writer.js";
import { ER_CONFIG_FIELDS, erConfigPatches, type ErConfig } from "../config.js";
import {
  erNoChange,
  erRecord,
  erRecordEnd,
  erRecordGroup,
  erMoveRecords,
  composeErCommandResults,
  erNewRecordPatch,
  writeErPatches,
  type ErPatch,
  type ErWriteOptions,
} from "../writer.js";
import { erSubgraphRecord } from "./subgraph-commands.js";
import { parseDocument, stringify } from "yaml";
import { readSourceYaml, sourceYamlFieldPatch } from "../../source-yaml.js";
import { mermaidMessages as messages } from "../../../i18n.js";
export function editErAppearance(
  model: MermaidErModel,
  value: {
    direction?: MermaidErModel["direction"];
    layout?: boolean;
    config?: Partial<ErConfig>;
  },
  options: ErWriteOptions = {},
) {
  const patches: ErPatch[] = [];
  if (value.config) {
    const config = erConfigPatches(model.sourceDocument, value.config);
    if (!config)
      return erNoChange(model, "invalid", messages.erPatchRejected());
    patches.push(...config);
  }
  if (value.direction && value.direction !== model.direction) {
    const record = model.sourceDocument.records.findLast(
      (r) => r.kind === "direction" && !r.subgraphId,
    );
    if (record)
      patches.push({ range: record.values.direction!, value: value.direction });
    else {
      const header = model.sourceDocument.records.find(
        (r) => r.kind === "header",
      )!;
      patches.push(
        erNewRecordPatch(
          model,
          erRecordEnd(header),
          `direction ${value.direction}`,
        ),
      );
    }
  }
  return writeErPatches(model, patches, options);
}
export function editErAccessibility(
  model: MermaidErModel,
  value: { title?: string; description?: string },
  options: ErWriteOptions = {},
) {
  const patches: ErPatch[] = [];
  for (const [field, kind, command] of [
    ["title", "accessibility-title", "accTitle"],
    ["description", "accessibility-description", "accDescr"],
  ] as const) {
    const text = value[field];
    if (
      text === undefined ||
      text ===
        (field === "title"
          ? model.accessibilityTitle
          : model.accessibilityDescription)
    )
      continue;
    if (
      (field === "title" && /[\r\n;]/.test(text)) ||
      (field === "description" && /[{}]/.test(text))
    )
      return erNoChange(model, "invalid", messages.erPatchRejected());
    const record = model.sourceDocument.records.findLast(
      (r) => r.kind === kind,
    );
    if (
      record?.values.text &&
      (record.raw.includes("{") || !/[\r\n]/.test(text))
    )
      patches.push({ range: record.values.text, value: text });
    else if (record) {
      patches.push({
        range: record.range,
        value: `${record.indent}${command} {${text}}`,
        identities: [[0, record.sourceKey]],
      });
    } else
      patches.push(
        erNewRecordPatch(
          model,
          model.sourceDocument.source.length,
          field === "description" && /[\r\n]/.test(text)
            ? `${command} {${text}}`
            : `${command}: ${text}`,
        ),
      );
  }
  return writeErPatches(model, patches, options);
}
export function setErStyleProperty(
  model: MermaidErModel,
  key: string,
  name: string,
  value: string | undefined,
  options: ErWriteOptions = {},
) {
  const style = model.styles.find((s) => s.id === key),
    record = erRecord(model, key);
  if (
    !style ||
    style.kind === "assignment" ||
    !record?.values.properties ||
    !name.trim() ||
    /[:,;\r\n]/.test(name) ||
    (value !== undefined && /[;\r\n]/.test(value))
  )
    return erNoChange(model, "invalid", messages.erPatchRejected());
  const property = style.properties.findLast((p) => p.name === name),
    patches: ErPatch[] = [];
  if (property) {
    if (value !== undefined)
      patches.push({ range: property.valueRange, value });
    else {
      let start = property.range.start,
        end = property.range.end;
      const source = model.sourceDocument.source;
      if (source[end] === ",") end++;
      else if (source[start - 1] === ",") start--;
      patches.push({ range: { start, end }, value: "" });
    }
  } else if (value !== undefined) {
    const end = record.values.properties.end;
    patches.push({
      range: { start: end, end },
      value: `${style.properties.length ? "," : ""}${name}:${value}`,
    });
  }
  return writeErPatches(model, patches, options);
}
export function addErStyle(
  model: MermaidErModel,
  value: {
    kind: "definition" | "inline" | "assignment";
    owner: string;
    properties?: readonly { name: string; value: string }[];
    styles?: readonly string[];
  },
  options: ErWriteOptions = {},
) {
  if (
    !value.owner.trim() ||
    /[;\r\n]/.test(value.owner) ||
    value.properties?.some(
      (p) =>
        !p.name.trim() || /[:,;\r\n]/.test(p.name) || /[;\r\n]/.test(p.value),
    ) ||
    value.styles?.some((name) => !/^[-\p{L}\p{N}_]+$/u.test(name))
  )
    return erNoChange(model, "invalid", messages.erPatchRejected());
  const key = nextErSourceKey();
  const properties =
    value.properties?.map((p) => `${p.name}:${p.value}`).join(",") ?? "";
  const text =
    value.kind === "definition"
      ? `classDef ${value.owner} ${properties}`
      : value.kind === "inline"
        ? `style ${sourceMermaidErEntityName(value.owner)} ${properties}`
        : `class ${sourceMermaidErEntityName(value.owner)} ${(value.styles ?? []).join(",")}`;
  return writeErPatches(
    model,
    [erNewRecordPatch(model, model.sourceDocument.source.length, text, key)],
    { ...options, selection: key },
  );
}
export function renameErStyleDefinition(
  model: MermaidErModel,
  key: string,
  id: string,
  previousName?: string,
  options: ErWriteOptions = {},
) {
  const style = model.styles.find(
    (s) => s.id === key && s.kind === "definition",
  );
  const from =
    previousName ?? (style?.owners.length === 1 ? style.owners[0] : undefined);
  if (
    !style ||
    !from ||
    !style.owners.includes(from) ||
    !/^[\p{L}\p{N}_-]+$/u.test(id)
  )
    return erNoChange(model, "invalid", messages.erPatchRejected());
  if (
    model.styles.some(
      (s) => s.kind === "definition" && s.owners.includes(id) && id !== from,
    )
  )
    return erNoChange(model, "invalid", messages.erIdCollision());
  const patches = model.sourceDocument.records.flatMap((r) =>
    r.references
      .filter((ref) => ref.kind === "style" && ref.id === from)
      .map((ref) => ({ range: ref.range, value: id })),
  );
  return writeErPatches(model, patches, options);
}
export function deleteErStyle(
  model: MermaidErModel,
  key: string,
  removeUses: boolean,
  options: ErWriteOptions = {},
) {
  const style = model.styles.find((s) => s.id === key),
    record = style && erRecord(model, style.sourceKey);
  if (!style || !record)
    return erNoChange(model, "invalid", messages.erMissingObject());
  if (style.kind === "assignment")
    return editErStyleAssignment(model, key, [], options);
  const uses =
    style.kind === "definition"
      ? model.styles.filter(
          (s) =>
            s.kind === "assignment" &&
            s.styles.some((name) => style.owners.includes(name)),
        )
      : [];
  const impact = {
    records: [
      record,
      ...uses.flatMap((s) => erRecord(model, s.sourceKey) ?? []),
    ].map((r) => ({ id: r.sourceKey, kind: r.kind, label: r.raw.trim() })),
  };
  if (uses.length && !removeUses)
    return {
      ...erNoChange(model, "invalid", messages.erPatchRejected()),
      impact,
    };
  let current = model;
  for (const use of uses) {
    const result = editErStyleAssignment(
      current,
      use.id,
      use.styles.filter((name) => !style.owners.includes(name)),
    );
    if (result.status === "rejected")
      return erNoChange(model, "invalid", result.diagnostic);
    current = result.model;
  }
  const group = erRecordGroup(current, key)!;
  const result = writeErPatches(current, [{ range: group.range, value: "" }], {
    removed: new Set(group.records.map((r) => r.sourceKey)),
    impact,
  });
  return composeErCommandResults(model, result, options);
}
export type ErCommentAnchor = Pick<
  MermaidErComment,
  "anchorKind" | "anchorId" | "position"
>;
function commentAnchorRecord(model: MermaidErModel, anchor: ErCommentAnchor) {
  if (anchor.anchorKind === "diagram")
    return model.sourceDocument.records.find((r) => r.kind === "header");
  if (anchor.anchorKind === "subgraph")
    return erSubgraphRecord(model, anchor.anchorId ?? "");
  if (anchor.anchorKind === "entity") {
    const node = model.entities.find(
      (n) => n.sourceKey === anchor.anchorId || n.id === anchor.anchorId,
    );
    return model.sourceDocument.records.find(
      (r) => r.kind === "entity" && r.ownerId === node?.id,
    );
  }
  return erRecord(model, anchor.anchorId ?? "");
}
function commentPatch(
  model: MermaidErModel,
  anchor: ErCommentAnchor,
  text: string,
  key: string,
) {
  const record = commentAnchorRecord(model, anchor);
  if (!record) return null;
  const owningInline = anchor.position !== "before";
  if (owningInline)
    return {
      range: { start: record.range.end, end: record.range.end },
      value: ` %% ${text}`,
      identities: [[1, key] as const],
    };
  const offset =
    anchor.anchorKind === "diagram" ? erRecordEnd(record) : record.range.start;
  return erNewRecordPatch(model, offset, `${record.indent}%% ${text}`, key);
}
export function addErComment(
  model: MermaidErModel,
  anchor: ErCommentAnchor,
  text: string,
  options: ErWriteOptions = {},
) {
  if (!text.trim() || /[\r\n]/.test(text) || text.trim().startsWith("{"))
    return erNoChange(model, "invalid", messages.erPatchRejected());
  const key = nextErSourceKey(),
    patch = commentPatch(model, anchor, text, key);
  if (!patch) return erNoChange(model, "invalid", messages.erMissingObject());
  const result = writeErPatches(model, [patch], {
    ...options,
    selection: key,
    focus: key,
  });
  return checkedCommentAnchor(model, result, key, anchor);
}
function checkedCommentAnchor(
  model: MermaidErModel,
  result: import("../writer.js").ErCommandResult,
  key: string,
  anchor: ErCommentAnchor,
) {
  const comment = result.model.commentRecords.find((c) => c.id === key);
  return result.status !== "rejected" &&
    (!comment ||
      comment.anchorKind !== anchor.anchorKind ||
      comment.anchorId !== anchor.anchorId)
    ? erNoChange(model, "invalid", messages.erInvalidMembership())
    : result;
}
export function reanchorErComment(
  model: MermaidErModel,
  key: string,
  anchor: ErCommentAnchor,
  options: ErWriteOptions = {},
) {
  const comment = model.commentRecords.find((c) => c.id === key);
  if (!comment) return erNoChange(model, "invalid", messages.erMissingObject());
  const deleted = deleteErComment(model, key);
  if (deleted.status === "rejected") return deleted;
  const patch = commentPatch(deleted.model, anchor, comment.text, key);
  if (!patch) return erNoChange(model, "invalid", messages.erMissingObject());
  const result = writeErPatches(deleted.model, [patch], {
    selection: key,
    focus: key,
  });
  return checkedCommentAnchor(
    model,
    composeErCommandResults(model, result, {
      ...options,
      commentTransfers: new Set([key]),
    }),
    key,
    anchor,
  );
}

export function editErComment(
  model: MermaidErModel,
  key: string,
  text: string,
  options: ErWriteOptions = {},
) {
  const record = erRecord(model, key);
  if (
    !record ||
    record.kind !== "comment" ||
    /[\r\n]/.test(text) ||
    text.trim().startsWith("{")
  )
    return erNoChange(model, "invalid", messages.erPatchRejected());
  const range = record.values.text ?? {
    start: record.range.start + record.indent.length + 2,
    end: record.range.end,
  };
  return writeErPatches(model, [{ range, value: text }], options);
}
export function deleteErComment(
  model: MermaidErModel,
  key: string,
  options: ErWriteOptions = {},
) {
  const record = erRecord(model, key);
  if (!record || record.kind !== "comment")
    return erNoChange(model, "invalid", messages.erMissingObject());
  return writeErPatches(
    model,
    [
      {
        range: {
          start: record.range.start,
          end: model.sourceDocument.records.some(
            (r) =>
              r !== record &&
              r.range.line === record.range.line &&
              r.range.end <= record.range.start,
          )
            ? record.range.end
            : erRecordEnd(record),
        },
        value: "",
      },
    ],
    { ...options, removed: new Set([key]) },
  );
}
export function reorderErComment(
  model: MermaidErModel,
  key: string,
  before: string | undefined,
  options: ErWriteOptions = {},
) {
  const record = erRecord(model, key),
    comment = model.commentRecords.find((c) => c.id === key);
  if (!record || !comment)
    return erNoChange(model, "invalid", messages.erMissingObject());
  const siblings = model.commentRecords.filter(
    (c) =>
      c.anchorKind === comment.anchorKind &&
      c.anchorId === comment.anchorId &&
      c.position === comment.position,
  );
  const other = before
    ? siblings.find((c) => c.id === before)
    : siblings.at(-1);
  const target = other ? erRecord(model, other.id) : undefined;
  if (!target || key === other?.id) return erNoChange(model);
  // Inline comments cannot trade positions with a line comment without changing
  // their anchor position. Such a local ambiguity does not lock the diagram.
  if (
    [record, target].some((r) =>
      model.sourceDocument.records.some(
        (p) =>
          p !== r &&
          p.range.line === r.range.line &&
          p.range.end <= r.range.start,
      ),
    )
  )
    return erNoChange(model, "invalid", messages.erPatchRejected());
  return writeErPatches(
    model,
    erMoveRecords(
      model,
      [record],
      before ? target.range.start : erRecordEnd(target),
    ),
    options,
  );
}
function erMetadataYaml(model: MermaidErModel, key: string) {
  const record = erRecord(model, key);
  if (!record || !["frontmatter", "directive"].includes(record.kind))
    return null;
  const start =
    record.kind === "frontmatter"
      ? record.raw.indexOf("\n") + 1
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
/** Data exposes only foreign metadata leaves. Known ER settings and the title
 * stay at their typed controls, even when they share this same YAML record. */
export function readErOpaqueConfig(model: MermaidErModel) {
  const entries: { recordKey: string; path: string[]; raw: string }[] = [];
  for (const record of model.sourceDocument.records) {
    const yaml = erMetadataYaml(model, record.sourceKey);
    if (!yaml) continue;
    const visit = (values: Record<string, unknown>, path: string[]) => {
      for (const [name, value] of Object.entries(values)) {
        const next = [...path, name];
        if (record.kind === "frontmatter" && !path.length && name === "title")
          continue;
        if (
          path.at(-1) === "er" &&
          ER_CONFIG_FIELDS.includes(name as (typeof ER_CONFIG_FIELDS)[number])
        )
          continue;
        if (
          ["config", "init", "initialize", "er"].includes(name) &&
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
export function editErOpaqueConfig(
  model: MermaidErModel,
  key: string,
  path: readonly string[],
  raw: string,
  options: ErWriteOptions = {},
) {
  const yaml = erMetadataYaml(model, key);
  if (
    !yaml ||
    !readErOpaqueConfig(model).some(
      (e) =>
        e.recordKey === key &&
        e.path.length === path.length &&
        e.path.every((v, i) => v === path[i]),
    )
  )
    return erNoChange(model, "invalid", messages.erPatchRejected());
  try {
    const doc = parseDocument(raw, { uniqueKeys: true, schema: "core" });
    if (doc.errors.length)
      return erNoChange(model, "invalid", messages.erPatchRejected());
    const patches = sourceYamlFieldPatch(
      yaml,
      path,
      doc.toJS({ maxAliasCount: 100 }),
    );
    return patches
      ? writeErPatches(model, patches, options)
      : erNoChange(model, "invalid", messages.erPatchRejected());
  } catch {
    return erNoChange(model, "invalid", messages.erPatchRejected());
  }
}
export function editErStyleAssignment(
  model: MermaidErModel,
  key: string,
  styles: readonly string[],
  options: ErWriteOptions = {},
) {
  const item = model.styles.find(
      (s) => s.id === key && s.kind === "assignment",
    ),
    record = item && erRecord(model, item.sourceKey);
  if (
    !item ||
    !record ||
    styles.some((name) => !/^[-\p{L}\p{N}_]+$/u.test(name))
  )
    return erNoChange(model, "invalid", messages.erPatchRejected());
  const range =
    item.assignmentRange ?? record.values.styles ?? record.values.properties;
  if (!range) return erNoChange(model, "invalid", messages.erPatchRejected());
  if (styles.length)
    return writeErPatches(model, [{ range, value: styles.join(",") }], options);
  if (item.removalRange)
    return writeErPatches(
      model,
      [{ range: item.removalRange, value: "" }],
      options,
    );
  if (record.kind === "entity") {
    const prefix = model.sourceDocument.source.slice(
        record.range.start,
        range.start,
      ),
      marker = /:::\s*$/.exec(prefix);
    if (!marker)
      return erNoChange(model, "invalid", messages.erPatchRejected());
    return writeErPatches(
      model,
      [
        {
          range: { start: record.range.start + marker.index, end: range.end },
          value: "",
        },
      ],
      options,
    );
  }
  return writeErPatches(
    model,
    [
      {
        range: { start: record.range.start, end: erRecordEnd(record) },
        value: "",
      },
    ],
    { ...options, removed: new Set([key]) },
  );
}

/** Use the global YAML title owner and retain ER record identities. */
export function editErDiagramTitle(
  model: MermaidErModel,
  title: string,
  options: ErWriteOptions = {},
) {
  const source = model.sourceDocument.source;
  if (!title.trim())
    return erNoChange(model, "invalid", messages.erPatchRejected());
  const next = writeMermaidDiagramTitle({
    source,
    diagramType: model.diagramType,
    title: title.trim(),
  });
  if (next === null)
    return erNoChange(model, "invalid", messages.erPatchRejected());
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
  return writeErPatches(
    model,
    [{ range: { start, end }, value: next.slice(start, nextEnd) }],
    options,
  );
}
export function readErDiagramTitle(model: MermaidErModel) {
  return resolveMermaidDiagramTitle({
    source: model.sourceDocument.source,
    diagramType: model.diagramType,
  }).value;
}
