// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "../../diagram-title.js";
import { isValidUrl, normalizeUrl } from "@virgultum/shared/utils";
import type {
  MermaidClassModel,
  MermaidClassComment,
  MermaidClassInteraction,
} from "../model.js";
import {
  nextClassSourceKey,
  sourceMermaidClassName,
} from "../source-document.js";
import { classConfigPatches, type ClassConfig } from "../config.js";
import {
  classNoChange,
  classRecord,
  classRecordEnd,
  classRecordGroup,
  classMoveRecords,
  classNewRecordPatch,
  writeClassPatches,
  type ClassPatch,
  type ClassWriteOptions,
} from "../writer.js";
import { classQuotedText } from "./class-commands.js";
import { namespaceRecord } from "./namespace-commands.js";
import { mermaidMessages as messages } from "../../../i18n.js";
export function editClassAppearance(
  model: MermaidClassModel,
  value: {
    direction?: MermaidClassModel["direction"];
    layout?: boolean;
    config?: Partial<ClassConfig>;
  },
  options: ClassWriteOptions = {},
) {
  const patches: ClassPatch[] = [];
  if (value.config) {
    const config = classConfigPatches(model.sourceDocument, value.config);
    if (!config)
      return classNoChange(model, "invalid", messages.classPatchRejected());
    patches.push(...config);
  }
  if (value.direction && value.direction !== model.direction) {
    const record = model.sourceDocument.records.findLast(
      (r) => r.kind === "direction",
    );
    if (record)
      patches.push({ range: record.values.direction!, value: value.direction });
    else {
      const header = model.sourceDocument.records.find(
        (r) => r.kind === "header",
      )!;
      patches.push(
        classNewRecordPatch(
          model,
          classRecordEnd(header),
          `direction ${value.direction}`,
        ),
      );
    }
  }
  return writeClassPatches(model, patches, options);
}
export function editClassAccessibility(
  model: MermaidClassModel,
  value: { title?: string; description?: string },
  options: ClassWriteOptions = {},
) {
  const patches: ClassPatch[] = [];
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
      return classNoChange(model, "invalid", messages.classPatchRejected());
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
        classNewRecordPatch(
          model,
          model.sourceDocument.source.length,
          field === "description" && /[\r\n]/.test(text)
            ? `${command} {${text}}`
            : `${command}: ${text}`,
        ),
      );
  }
  return writeClassPatches(model, patches, options);
}
export function editClassLink(
  model: MermaidClassModel,
  classKey: string,
  value: {
    url: string;
    tooltip: string;
    target: MermaidClassInteraction["target"];
  },
  options: ClassWriteOptions = {},
) {
  const node = model.nodes.find(
    (n) =>
      n.kind === "class" && (n.sourceKey === classKey || n.id === classKey),
  );
  if (!node)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const url = value.url.trim() ? normalizeUrl(value.url.trim()) : "";
  if (url && !isValidUrl(url, "https://myoxus.local"))
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const previous = model.interactions.findLast(
      (i) => i.classId === node.sourceId && i.kind === "link",
    ),
    record = previous ? classRecord(model, previous.id) : undefined;
  if (!url)
    return record
      ? writeClassPatches(
          model,
          [
            {
              range: { start: record.range.start, end: classRecordEnd(record) },
              value: "",
            },
          ],
          { ...options, removed: new Set([record.sourceKey]) },
        )
      : classNoChange(model);
  const patches: ClassPatch[] = [];
  if (record && previous) {
    for (const field of ["url", "tooltip", "target"] as const) {
      const next = field === "url" ? url : value[field];
      if (next === previous[field]) continue;
      if (record.values[field])
        patches.push({
          range: record.values[field]!,
          value: field === "target" ? next : classQuotedText(next),
        });
      else {
        const end =
          record.range.end - (record.raw.trimEnd().endsWith(";") ? 1 : 0);
        patches.push({
          range: { start: end, end },
          value:
            field === "target" ? ` ${next}` : ` "${classQuotedText(next)}"`,
        });
      }
    }
  } else
    patches.push(
      classNewRecordPatch(
        model,
        model.sourceDocument.source.length,
        `link ${sourceMermaidClassName(node.sourceId)} "${classQuotedText(url)}" "${classQuotedText(value.tooltip)}" ${value.target}`,
      ),
    );
  return writeClassPatches(model, patches, {
    ...options,
    selection: node.sourceKey,
  });
}
export function editClassOpaquePayload(
  model: MermaidClassModel,
  key: string,
  payload: string,
  options: ClassWriteOptions = {},
) {
  const interaction = model.interactions.find(
      (i) => i.id === key && i.kind === "callback",
    ),
    record = classRecord(model, key);
  if (!interaction || !record?.values.payload)
    return classNoChange(model, "invalid", messages.classMissingObject());
  // Source data only. There is no evaluation or callback invocation path.
  return writeClassPatches(
    model,
    [{ range: record.values.payload, value: payload }],
    options,
  );
}
export function setClassStyleProperty(
  model: MermaidClassModel,
  key: string,
  name: string,
  value: string | undefined,
  options: ClassWriteOptions = {},
) {
  const style = model.styles.find((s) => s.id === key),
    record = classRecord(model, key);
  if (
    !style ||
    style.kind === "assignment" ||
    !record?.values.properties ||
    !name.trim() ||
    /[:,;\r\n]/.test(name)
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const property = style.properties.findLast((p) => p.name === name),
    patches: ClassPatch[] = [];
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
  return writeClassPatches(model, patches, options);
}
export function addClassStyle(
  model: MermaidClassModel,
  value: {
    kind: "definition" | "inline" | "assignment";
    owner: string;
    properties?: readonly { name: string; value: string }[];
    styles?: readonly string[];
  },
  options: ClassWriteOptions = {},
) {
  const key = nextClassSourceKey();
  const properties =
    value.properties?.map((p) => `${p.name}:${p.value}`).join(",") ?? "";
  const text =
    value.kind === "definition"
      ? `classDef ${value.owner} ${properties}`
      : value.kind === "inline"
        ? `style ${sourceMermaidClassName(value.owner)} ${properties}`
        : `class ${sourceMermaidClassName(value.owner)} ${(value.styles ?? []).join(",")}`;
  return writeClassPatches(
    model,
    [classNewRecordPatch(model, model.sourceDocument.source.length, text, key)],
    { ...options, selection: key },
  );
}
export function renameClassStyleDefinition(
  model: MermaidClassModel,
  key: string,
  id: string,
  options: ClassWriteOptions = {},
) {
  const style = model.styles.find(
    (s) => s.id === key && s.kind === "definition",
  );
  if (!style || style.styles.length !== 1 || !/^[\p{L}\p{N}_-]+$/u.test(id))
    return classNoChange(model, "invalid", messages.classPatchRejected());
  if (
    model.styles.some(
      (s) => s !== style && s.kind === "definition" && s.styles.includes(id),
    )
  )
    return classNoChange(model, "invalid", messages.classIdCollision());
  const patches = model.sourceDocument.records.flatMap((r) =>
    r.references
      .filter((ref) => ref.kind === "style" && ref.id === style.styles[0])
      .map((ref) => ({ range: ref.range, value: id })),
  );
  return writeClassPatches(model, patches, options);
}
export function deleteClassStyle(
  model: MermaidClassModel,
  key: string,
  removeUses: boolean,
  options: ClassWriteOptions = {},
) {
  const style = model.styles.find((s) => s.id === key),
    record = classRecord(model, key);
  if (!style || !record)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const uses =
    style.kind === "definition"
      ? model.sourceDocument.records.filter(
          (r) =>
            r.sourceKey !== key &&
            r.references.some(
              (ref) => ref.kind === "style" && style.styles.includes(ref.id),
            ),
        )
      : [];
  const impact = {
    records: [record, ...uses].map((r) => ({
      id: r.sourceKey,
      kind: r.kind,
      label: r.raw.trim(),
    })),
    attachedNotes: [],
  };
  if (uses.length && !removeUses)
    return {
      ...classNoChange(model, "invalid", messages.classPatchRejected()),
      impact,
    };
  const group = classRecordGroup(model, key)!;
  const removed = new Set(group.records.map((r) => r.sourceKey)),
    patches: ClassPatch[] = [{ range: group.range, value: "" }];
  for (const use of uses) {
    const keep = use.references.filter(
      (ref) => ref.kind === "style" && !style.styles.includes(ref.id),
    );
    const range = use.values.styles ?? use.values.properties;
    if (keep.length && range)
      patches.push({
        range,
        value: keep
          .map((ref) =>
            model.sourceDocument.source.slice(ref.range.start, ref.range.end),
          )
          .join(","),
      });
    else if (use.kind === "class" && use.values.styles)
      patches.push({
        range: {
          start: use.values.styles.start - 3,
          end: use.values.styles.end,
        },
        value: "",
      });
    else {
      const group = classRecordGroup(model, use.sourceKey)!;
      for (const record of group.records) removed.add(record.sourceKey);
      patches.push({ range: group.range, value: "" });
    }
  }
  return writeClassPatches(model, patches, { ...options, removed, impact });
}
export type ClassCommentAnchor = Pick<
  MermaidClassComment,
  "anchorKind" | "anchorId" | "position"
>;
function commentAnchorRecord(
  model: MermaidClassModel,
  anchor: ClassCommentAnchor,
) {
  if (anchor.anchorKind === "diagram")
    return model.sourceDocument.records.find((r) => r.kind === "header");
  if (anchor.anchorKind === "namespace")
    return namespaceRecord(model, anchor.anchorId ?? "");
  if (anchor.anchorKind === "class") {
    const node = model.nodes.find(
      (n) => n.sourceKey === anchor.anchorId || n.id === anchor.anchorId,
    );
    return model.sourceDocument.records.find(
      (r) => r.kind === "class" && r.ownerId === node?.sourceId,
    );
  }
  return classRecord(model, anchor.anchorId ?? "");
}
export function addClassComment(
  model: MermaidClassModel,
  anchor: ClassCommentAnchor,
  text: string,
  options: ClassWriteOptions = {},
) {
  if (!text.trim() || /[\r\n]/.test(text) || text.trim().startsWith("{"))
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const record = commentAnchorRecord(model, anchor);
  if (!record)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const key = nextClassSourceKey(),
    before = anchor.position === "before" && anchor.anchorKind !== "diagram";
  const member = model.nodes
    .flatMap((n) => n.members)
    .find((m) => m.id === anchor.anchorId);
  const offset = before
    ? record.range.start
    : member?.sourceForm === "block"
      ? classRecordEnd(record)
      : record.range.end;
  const patch = before
    ? classNewRecordPatch(model, offset, `${record.indent}%% ${text}`, key)
    : member?.sourceForm === "block"
      ? {
          range: { start: offset, end: offset },
          value: `${record.indent}%% ${text}${model.sourceDocument.newline}${model.sourceDocument.newline}`,
          identities: [[0, key] as const],
        }
      : {
          range: { start: offset, end: offset },
          value: ` %% ${text}`,
          identities: [[1, key] as const],
        };
  return writeClassPatches(model, [patch], { ...options, selection: key });
}
export function editClassComment(
  model: MermaidClassModel,
  key: string,
  text: string,
  options: ClassWriteOptions = {},
) {
  const record = classRecord(model, key);
  if (
    !record ||
    record.kind !== "comment" ||
    /[\r\n]/.test(text) ||
    text.trim().startsWith("{")
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const range = record.values.text ?? {
    start: record.range.start + record.indent.length + 2,
    end: record.range.end,
  };
  return writeClassPatches(model, [{ range, value: text }], options);
}
export function deleteClassComment(
  model: MermaidClassModel,
  key: string,
  options: ClassWriteOptions = {},
) {
  const record = classRecord(model, key);
  if (!record || record.kind !== "comment")
    return classNoChange(model, "invalid", messages.classMissingObject());
  return writeClassPatches(
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
            : classRecordEnd(record),
        },
        value: "",
      },
    ],
    { ...options, removed: new Set([key]) },
  );
}
export function reorderClassComment(
  model: MermaidClassModel,
  key: string,
  before: string | undefined,
  options: ClassWriteOptions = {},
) {
  const record = classRecord(model, key),
    comment = model.commentRecords.find((c) => c.id === key);
  if (!record || !comment)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const siblings = model.commentRecords.filter(
    (c) =>
      c.anchorKind === comment.anchorKind &&
      c.anchorId === comment.anchorId &&
      c.position === comment.position,
  );
  const other = before
    ? siblings.find((c) => c.id === before)
    : siblings.at(-1);
  const target = other ? classRecord(model, other.id) : undefined;
  if (!target || key === other?.id) return classNoChange(model);
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
    return classNoChange(model, "invalid", messages.classPatchRejected());
  return writeClassPatches(
    model,
    classMoveRecords(
      model,
      [record],
      before ? target.range.start : classRecordEnd(target),
    ),
    options,
  );
}
/** Technical config is intentionally opened as opaque data. Known Class fields
 * remain authored through Appearance; the Source record is never executed. */
export function editClassOpaqueConfig(
  model: MermaidClassModel,
  key: string,
  raw: string,
  options: ClassWriteOptions = {},
) {
  const record = classRecord(model, key);
  if (!record || !["frontmatter", "directive"].includes(record.kind))
    return classNoChange(model, "invalid", messages.classMissingObject());
  return writeClassPatches(
    model,
    [{ range: record.range, value: raw }],
    options,
  );
}
export function editClassStyleAssignment(
  model: MermaidClassModel,
  key: string,
  styles: readonly string[],
  options: ClassWriteOptions = {},
) {
  const item = model.styles.find(
      (s) => s.id === key && s.kind === "assignment",
    ),
    record = classRecord(model, key);
  if (
    !item ||
    !record ||
    styles.some((name) => !/^[-\p{L}\p{N}_]+$/u.test(name))
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const range = record.values.styles ?? record.values.properties;
  if (!range)
    return classNoChange(model, "invalid", messages.classPatchRejected());
  if (styles.length)
    return writeClassPatches(
      model,
      [{ range, value: styles.join(",") }],
      options,
    );
  if (record.kind === "class") {
    const prefix = model.sourceDocument.source.slice(
        record.range.start,
        range.start,
      ),
      marker = /:::\s*$/.exec(prefix);
    if (!marker)
      return classNoChange(model, "invalid", messages.classPatchRejected());
    return writeClassPatches(
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
  return writeClassPatches(
    model,
    [
      {
        range: { start: record.range.start, end: classRecordEnd(record) },
        value: "",
      },
    ],
    { ...options, removed: new Set([key]) },
  );
}

/** Use the global YAML title owner and retain Class record identities. */
export function editClassDiagramTitle(
  model: MermaidClassModel,
  title: string,
  options: ClassWriteOptions = {},
) {
  const source = model.sourceDocument.source;
  if (!title.trim())
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const next = writeMermaidDiagramTitle({
    source,
    diagramType: model.diagramType,
    title: title.trim(),
  });
  if (next === null)
    return classNoChange(model, "invalid", messages.classPatchRejected());
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
  return writeClassPatches(
    model,
    [{ range: { start, end }, value: next.slice(start, nextEnd) }],
    options,
  );
}
export function readClassDiagramTitle(model: MermaidClassModel) {
  return resolveMermaidDiagramTitle({
    source: model.sourceDocument.source,
    diagramType: model.diagramType,
  }).value;
}
