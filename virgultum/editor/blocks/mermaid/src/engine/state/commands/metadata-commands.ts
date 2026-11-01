// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidStateModel,
  StateComment,
  MermaidStateDirection,
} from "../model.js";
import { parseDocument, stringify } from "yaml";
import { readSourceYaml, sourceYamlFieldPatch } from "../../source-yaml.js";
import { writeMermaidDiagramTitle } from "../../diagram-title.js";
import { STATE_CONFIG_FIELDS } from "../config.js";
import { stateConfigPatches, type StateConfig } from "../config.js";
import { nextStateSourceKey } from "../source-document.js";
import { mermaidMessages as m } from "../../../i18n.js";
import { stateObject } from "./state-commands.js";
import {
  stateNoChange,
  stateImpact,
  stateRecord,
  stateRecordEnd,
  stateInsertAnchor,
  stateNewRecordPatch,
  writeStatePatches,
  deleteStateRecords,
  stateMoveRecords,
  composeStateCommandResults,
  type StatePatch,
  type StateWriteOptions,
} from "../writer.js";

function fieldPatch(
  model: MermaidStateModel,
  kind: string,
  text: string,
  command: string,
  field = "text",
): StatePatch {
  const r = model.sourceDocument.records.findLast(
    (r) => r.kind === kind && !r.parentId,
  );
  if (r?.values[field] && !/[\r\n]/.test(command))
    return { range: r.values[field]!, value: text };
  if (r)
    return {
      range: r.range,
      value: r.indent + command,
      identities: [[0, r.sourceKey]],
    };
  const header = model.sourceDocument.records.find((r) => r.kind === "header")!;
  return stateNewRecordPatch(model, stateRecordEnd(header), command);
}
export function editStateAppearance(
  model: MermaidStateModel,
  value: {
    direction?: MermaidStateDirection;
    config?: Partial<StateConfig>;
    hideEmptyDescription?: boolean;
    scaleWidth?: number | null;
    layout?: boolean;
  },
  options: StateWriteOptions = {},
) {
  const patches: StatePatch[] = [];
  if (value.direction && value.direction !== model.direction) {
    if (!["LR", "RL", "TB", "BT"].includes(value.direction))
      return stateNoChange(model, "invalid", m.classPatchRejected());
    patches.push(
      fieldPatch(
        model,
        "direction",
        value.direction,
        `direction ${value.direction}`,
        "direction",
      ),
    );
  }
  if (value.config) {
    const config = stateConfigPatches(model.sourceDocument, value.config);
    if (!config) return stateNoChange(model, "invalid", m.classPatchRejected());
    patches.push(...config);
  }
  const removed = new Set<string>();
  if (
    value.hideEmptyDescription !== undefined &&
    value.hideEmptyDescription !== model.hideEmptyDescription
  ) {
    const existing = model.sourceDocument.records.filter(
      (r) => r.kind === "source-option" && /^\s*hide\s/i.test(r.raw),
    );
    if (value.hideEmptyDescription) {
      const header = model.sourceDocument.records.find(
        (r) => r.kind === "header",
      )!;
      patches.push(
        stateNewRecordPatch(
          model,
          stateRecordEnd(header),
          "hide empty description",
        ),
      );
    } else
      for (const r of existing) {
        removed.add(r.sourceKey);
        patches.push({
          range: { start: r.range.start, end: stateRecordEnd(r) },
          value: "",
        });
      }
  }
  if (value.scaleWidth !== undefined && value.scaleWidth !== model.scaleWidth) {
    if (
      value.scaleWidth !== null &&
      (!Number.isSafeInteger(value.scaleWidth) || value.scaleWidth < 0)
    )
      return stateNoChange(model, "invalid", m.classPatchRejected());
    const existing = model.sourceDocument.records.filter(
      (r) => r.kind === "source-option" && r.values.width,
    );
    if (value.scaleWidth === null)
      for (const r of existing) {
        removed.add(r.sourceKey);
        patches.push({
          range: { start: r.range.start, end: stateRecordEnd(r) },
          value: "",
        });
      }
    else if (existing.length)
      patches.push({
        range: existing.at(-1)!.values.width!,
        value: String(value.scaleWidth),
      });
    else
      patches.push(
        stateNewRecordPatch(
          model,
          stateRecordEnd(
            model.sourceDocument.records.find((r) => r.kind === "header")!,
          ),
          `scale ${value.scaleWidth} width`,
        ),
      );
  }
  return writeStatePatches(model, patches, { ...options, removed });
}
export function editStateAccessibility(
  model: MermaidStateModel,
  value: { title?: string; description?: string },
  options: StateWriteOptions = {},
) {
  const patches: StatePatch[] = [];
  for (const [field, kind, cmd] of [
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
      return stateNoChange(model, "invalid", m.classPatchRejected());
    const r = model.sourceDocument.records.findLast((r) => r.kind === kind);
    if (r?.values.text && (r.raw.includes("{") || !/[\r\n]/.test(text)))
      patches.push({ range: r.values.text, value: text });
    else
      patches.push(
        fieldPatch(
          model,
          kind,
          text,
          /[\r\n]/.test(text)
            ? `${cmd} {${model.sourceDocument.newline}${text}${model.sourceDocument.newline}}`
            : `${cmd}: ${text}`,
        ),
      );
  }
  return writeStatePatches(model, patches, options);
}
export type StateStyleValue = {
  kind: "definition" | "inline" | "assignment";
  name?: string;
  targets?: readonly string[];
  properties?: readonly { name: string; value: string }[];
  classes?: readonly string[];
};
function styleText(model: MermaidStateModel, value: StateStyleValue) {
  const target =
    value.kind === "definition"
      ? value.name
      : value.targets?.map((key) => stateObject(model, key)?.id).join(",");
  if (
    !target ||
    !/^[\w,]+$/.test(target) ||
    (value.kind !== "definition" &&
      value.targets?.some((k) => !stateObject(model, k)))
  )
    return null;
  if (value.kind === "assignment") {
    if (!value.classes?.length || value.classes.some((v) => !/^\w+$/.test(v)))
      return null;
    return `class ${target} ${value.classes.join(",")}`;
  }
  if (
    !value.properties?.length ||
    value.properties.some(
      (p) => !/^[\w-]+$/.test(p.name) || /[\r\n;]/.test(p.value),
    )
  )
    return null;
  return `${value.kind === "definition" ? "classDef" : "style"} ${target} ${value.properties.map((p) => `${p.name}:${p.value}`).join(",")}`;
}
export function addStateStyle(
  model: MermaidStateModel,
  value: StateStyleValue,
  options: StateWriteOptions = {},
) {
  const text = styleText(model, value),
    key = nextStateSourceKey(),
    at = stateInsertAnchor(model);
  if (!text || !at)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  return writeStatePatches(
    model,
    [stateNewRecordPatch(model, at.offset, at.indent + text, key)],
    { ...options, selection: key },
  );
}
export function setStateStyleProperty(
  model: MermaidStateModel,
  key: string,
  name: string,
  value: string | undefined,
  options: StateWriteOptions = {},
) {
  const style = model.styles.find((s) => s.id === key),
    r = stateRecord(model, key);
  if (
    !style ||
    style.kind === "assignment" ||
    !r?.values.properties ||
    !name.trim() ||
    /[:,;\r\n]/.test(name) ||
    (value !== undefined && /[;\r\n]/.test(value))
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const property = style.properties.findLast((p) => p.name === name),
    patches: StatePatch[] = [];
  if (property) {
    if (value !== undefined)
      patches.push({ range: property.valueRange, value });
    else {
      let { start, end } = property.range;
      const source = model.sourceDocument.source;
      if (source[end] === ",") end++;
      else if (source[start - 1] === ",") start--;
      patches.push({ range: { start, end }, value: "" });
    }
  } else if (value !== undefined) {
    const end = r.values.properties.end;
    patches.push({
      range: { start: end, end },
      value: `${style.properties.length ? "," : ""}${name}:${value}`,
    });
  }
  return writeStatePatches(model, patches, options);
}
export function editStateStyle(
  model: MermaidStateModel,
  key: string,
  value: StateStyleValue,
  options: StateWriteOptions = {},
) {
  const r = stateRecord(model, key),
    style = model.styles.find((s) => s.id === key),
    text = styleText(model, value);
  if (!r || !style || !text)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  const next = /^\S+\s+(\S+)\s+([\s\S]*)$/.exec(text)!;
  const patches =
    style.kind === value.kind
      ? [
          { range: r.values.targets!, value: next[1]! },
          { range: r.values.properties!, value: next[2]! },
        ]
      : [
          {
            range: r.range,
            value: r.indent + text,
            identities: [[0, key]] as const,
          },
        ];
  return writeStatePatches(model, patches, options);
}
export function deleteStateStyle(
  model: MermaidStateModel,
  key: string,
  removeUses = false,
  options: StateWriteOptions = {},
) {
  const r = stateRecord(model, key);
  if (!r || !model.styles.some((s) => s.id === key))
    return stateNoChange(model, "invalid", m.stateMissingObject());
  if (removeUses && r.kind === "class-definition") {
    const names = model.styles.find((s) => s.id === key)!.owners,
      patches: StatePatch[] = [];
    const removed = new Set([key]);
    for (const record of model.sourceDocument.records) {
      const uses = names
        .flatMap((name) => stateStyleUses(model, name))
        .filter((use) => use.key === record.sourceKey);
      if (!uses.length) continue;
      if (record.kind === "class-assignment") {
        const range = record.values.properties!,
          original = model.sourceDocument.source.slice(range.start, range.end);
        const retained = original
          .split(/\s*,\s*|\s+/)
          .filter((token) => token && !names.includes(token));
        if (retained.length) patches.push({ range, value: retained.join(",") });
        else {
          removed.add(record.sourceKey);
          patches.push({
            range: { start: record.range.start, end: stateRecordEnd(record) },
            value: "",
          });
        }
      } else
        for (const use of uses)
          patches.push({
            range: { start: use.range.start - 3, end: use.range.end },
            value: "",
          });
    }
    patches.push({
      range: { start: r.range.start, end: stateRecordEnd(r) },
      value: "",
    });
    return writeStatePatches(model, patches, {
      ...options,
      removed,
      impact: stateImpact(
        model,
        model.sourceDocument.records.filter(
          (r) =>
            removed.has(r.sourceKey) ||
            patches.some(
              (p) =>
                p.range.start >= r.range.start && p.range.start < r.range.end,
            ),
        ),
      ),
      commentTransfers: new Set(
        model.commentRecords
          .filter((c) => c.anchorId && removed.has(c.anchorId))
          .map((c) => c.id),
      ),
    });
  }
  return deleteStateRecords(model, [r], {
    ...options,
    commentTransfers: new Set(
      model.commentRecords.filter((c) => c.anchorId === key).map((c) => c.id),
    ),
  });
}
/** Class names occupy owned fields distinct from object-ID references. */
export function stateStyleUses(model: MermaidStateModel, name: string) {
  return model.sourceDocument.records.flatMap((record) => {
    const fields =
      record.kind === "class-assignment"
        ? [record.values.properties]
        : [
            record.values.classes,
            record.values.fromClass,
            record.values.toClass,
          ];
    return fields.flatMap((range) => {
      if (!range) return [];
      return [
        ...model.sourceDocument.source
          .slice(range.start, range.end)
          .matchAll(/\w+/g),
      ]
        .filter((match) => match[0] === name)
        .map((match) => ({
          key: record.sourceKey,
          range: {
            start: range.start + match.index,
            end: range.start + match.index + name.length,
          },
        }));
    });
  });
}
export function renameStateStyleDefinition(
  model: MermaidStateModel,
  key: string,
  name: string,
  previousName?: string,
  options: StateWriteOptions = {},
) {
  const style = model.styles.find((s) => s.id === key),
    record = stateRecord(model, key);
  if (
    style?.kind !== "definition" ||
    !record?.values.targets ||
    !/^\w+$/.test(name) ||
    (previousName && !style.owners.includes(previousName))
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const previous = previousName ?? style.owners[0]!;
  if (previous === name) return writeStatePatches(model, [], options);
  if (
    model.styles.some((s) => s.kind === "definition" && s.owners.includes(name))
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const patches: StatePatch[] = [
    { range: record.values.targets, value: name },
    ...stateStyleUses(model, previous).map((use) => ({
      range: use.range,
      value: name,
    })),
  ];
  return writeStatePatches(model, patches, options);
}
export function editStateLink(
  model: MermaidStateModel,
  value: { target: string; url: string | null; tooltip?: string; key?: string },
  options: StateWriteOptions = {},
) {
  const node = stateObject(model, value.target),
    link = value.key
      ? model.links.find((l) => l.sourceKey === value.key)
      : model.links.findLast((l) => l.stateId === node?.id);
  if (
    !node ||
    ("kind" in node && ["start", "end"].includes(node.kind)) ||
    (value.key && !link) ||
    (value.url !== null && /["\r\n]/.test(value.url + (value.tooltip ?? "")))
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const r = link && stateRecord(model, link.sourceKey!);
  if (value.url === null)
    return r
      ? deleteStateRecords(model, [r], {
          ...options,
          commentTransfers: new Set(
            model.commentRecords
              .filter((c) => c.anchorId === r.sourceKey)
              .map((c) => c.id),
          ),
        })
      : writeStatePatches(model, [], options);
  const text = `click ${node.id} "${value.url}" "${value.tooltip ?? link?.tooltip ?? ""}"`;
  if (r) {
    const patches: StatePatch[] = [{ range: r.values.url!, value: value.url }];
    if (value.tooltip !== undefined)
      patches.push(
        r.values.tooltip
          ? { range: r.values.tooltip, value: value.tooltip }
          : {
              range: { start: r.range.end, end: r.range.end },
              value: ` "${value.tooltip}"`,
            },
      );
    return writeStatePatches(model, patches, options);
  }
  const at = stateInsertAnchor(model, {
    parentId: node.parentId,
    regionKey: node.regionKey,
  });
  return at
    ? writeStatePatches(
        model,
        [stateNewRecordPatch(model, at.offset, at.indent + text)],
        options,
      )
    : stateNoChange(model, "invalid", m.classPatchRejected());
}
export type StateCommentValue = Pick<
  StateComment,
  "text" | "anchorKind" | "anchorId" | "position"
>;
function commentAnchor(model: MermaidStateModel, value: StateCommentValue) {
  if (value.anchorKind === "diagram")
    return model.sourceDocument.records.find((r) => r.kind === "header");
  const node = stateObject(model, value.anchorId ?? "");
  if (value.anchorKind === "description") {
    const description = model.states
      .flatMap((n) => n.descriptions ?? [])
      .find((d) => d.id === value.anchorId);
    return description && stateRecord(model, description.recordKey);
  }
  if (value.anchorKind === "region") {
    const primary = model.composites.find(
      (c) => c.primaryRegionKey === value.anchorId,
    );
    if (primary)
      return primary.recordKeys
        ?.map((k) => stateRecord(model, k))
        .find((r) => r?.kind === "composite");
  }
  if (value.anchorKind === "composite" && value.position === "inside")
    return (
      node &&
      node.recordKeys
        ?.map((k) => stateRecord(model, k))
        .find((r) => r?.kind === "composite")
    );
  if (
    value.anchorKind === "composite" &&
    value.position === "after" &&
    node &&
    "closeKey" in node
  )
    return stateRecord(model, node.closeKey!);
  return node
    ? node.recordKeys?.map((k) => stateRecord(model, k)).find(Boolean)
    : stateRecord(model, value.anchorId ?? "");
}
export function addStateComment(
  model: MermaidStateModel,
  value: StateCommentValue,
  options: StateWriteOptions = {},
) {
  const anchor = commentAnchor(model, value),
    key = nextStateSourceKey();
  if (!anchor || /[\r\n]/.test(value.text))
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const primary =
    value.anchorKind === "region" &&
    model.composites.some((c) => c.primaryRegionKey === value.anchorId);
  const offset =
    value.position === "before" && !primary
      ? anchor.range.start
      : stateRecordEnd(anchor);
  const indent = anchor.indent + (value.position === "inside" ? "  " : "");
  return writeStatePatches(
    model,
    [stateNewRecordPatch(model, offset, `${indent}%% ${value.text}`, key)],
    {
      ...options,
      commentAnchors: new Map([[key, value]]),
      selection: key,
      focus: key,
    },
  );
}
export function editStateComment(
  model: MermaidStateModel,
  key: string,
  value: StateCommentValue,
  options: StateWriteOptions = {},
) {
  const r = stateRecord(model, key),
    c = model.commentRecords.find((c) => c.id === key),
    anchor = commentAnchor(model, value);
  if (!r?.values.text || !c || !anchor || /[\r\n]/.test(value.text))
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const transfers = new Set([key]),
    anchors = new Map([[key, value]]);
  const result = writeStatePatches(
    model,
    [{ range: r.values.text, value: value.text }],
    { ...options, commentTransfers: transfers, commentAnchors: anchors },
  );
  if (result.status === "rejected") return result;
  const target = commentAnchor(result.model, value)!,
    record = stateRecord(result.model, key)!;
  const primary =
    value.anchorKind === "region" &&
    model.composites.some((c) => c.primaryRegionKey === value.anchorId);
  const offset =
    value.position === "before" && !primary
      ? target.range.start
      : stateRecordEnd(target);
  const moved = writeStatePatches(
    result.model,
    stateMoveRecords(result.model, [record], offset),
    {
      ...options,
      baseSource: result.source,
      commentTransfers: transfers,
      commentAnchors: anchors,
      selection: key,
      focus: key,
    },
  );
  return composeStateCommandResults(model, moved, {
    ...options,
    commentTransfers: transfers,
  });
}
export function deleteStateComment(
  model: MermaidStateModel,
  key: string,
  options: StateWriteOptions = {},
) {
  const r = stateRecord(model, key);
  return r?.kind === "comment"
    ? deleteStateRecords(model, [r], options)
    : stateNoChange(model, "invalid", m.stateMissingObject());
}
export function reorderStateComment(
  model: MermaidStateModel,
  key: string,
  beforeKey: string,
  options: StateWriteOptions = {},
) {
  const comment = model.commentRecords.find((c) => c.id === key),
    target = model.commentRecords.find((c) => c.id === beforeKey);
  if (
    !comment ||
    !target ||
    comment.anchorKind !== target.anchorKind ||
    comment.anchorId !== target.anchorId ||
    comment.position !== target.position
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  return writeStatePatches(
    model,
    stateMoveRecords(
      model,
      [stateRecord(model, key)!],
      stateRecord(model, beforeKey)!.range.start,
    ),
    options,
  );
}

function stateMetadataYaml(model: MermaidStateModel, key: string) {
  const record = stateRecord(model, key);
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
/** Data exposes only foreign metadata leaves. Known State settings and the title
 * stay at their typed controls, even when they share this same YAML record. */
export function readStateOpaqueConfig(model: MermaidStateModel) {
  const entries: { recordKey: string; path: string[]; raw: string }[] = [];
  for (const record of model.sourceDocument.records) {
    const yaml = stateMetadataYaml(model, record.sourceKey);
    if (!yaml) continue;
    const visit = (values: Record<string, unknown>, path: string[]) => {
      for (const [name, value] of Object.entries(values)) {
        const next = [...path, name];
        if (record.kind === "frontmatter" && !path.length && name === "title")
          continue;
        if (
          path.at(-1) === "state" &&
          STATE_CONFIG_FIELDS.includes(
            name as (typeof STATE_CONFIG_FIELDS)[number],
          )
        )
          continue;
        if (
          ["config", "init", "initialize", "state"].includes(name) &&
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
export function editStateOpaqueConfig(
  model: MermaidStateModel,
  key: string,
  path: readonly string[],
  raw: string,
  options: StateWriteOptions = {},
) {
  const yaml = stateMetadataYaml(model, key);
  if (
    !yaml ||
    !readStateOpaqueConfig(model).some(
      (e) =>
        e.recordKey === key &&
        e.path.length === path.length &&
        e.path.every((v, i) => v === path[i]),
    )
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  try {
    const doc = parseDocument(raw, { uniqueKeys: true, schema: "core" });
    if (doc.errors.length)
      return stateNoChange(model, "invalid", m.classPatchRejected());
    const patches = sourceYamlFieldPatch(
      yaml,
      path,
      doc.toJS({ maxAliasCount: 100 }),
    );
    return patches
      ? writeStatePatches(model, patches, options)
      : stateNoChange(model, "invalid", m.classPatchRejected());
  } catch {
    return stateNoChange(model, "invalid", m.classPatchRejected());
  }
}
/** Use the global YAML title owner and retain State record identities. */
export function editStateDiagramTitle(
  model: MermaidStateModel,
  title: string,
  options: StateWriteOptions = {},
) {
  const source = model.sourceDocument.source;
  if (!title.trim())
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const next = writeMermaidDiagramTitle({
    source,
    diagramType: model.diagramType,
    title: title.trim(),
  });
  if (next === null)
    return stateNoChange(model, "invalid", m.classPatchRejected());
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
  return writeStatePatches(
    model,
    [{ range: { start, end }, value: next.slice(start, nextEnd) }],
    options,
  );
}
