// SPDX-License-Identifier: AGPL-3.0-or-later

import { sourceYamlFieldPatch, sourceValuesEqual } from "../source-yaml.js";
import { kanbanConfigPatch, readKanbanConfig } from "./config.js";
import type { MermaidKanbanModel, MermaidKanbanNode } from "./model.js";
import { parseMermaidKanbanSource } from "./parser.js";
import {
  nextKanbanSourceKey,
  type KanbanSourceRecord,
} from "./source-document.js";
import {
  kanbanNoChange,
  writeKanbanPatches,
  type KanbanPatch,
  type KanbanCommandResult,
} from "./writer.js";

export type KanbanCommand =
  | {
      type: "add";
      kind: "column" | "card";
      label: string;
      columnId?: string;
      afterId?: string;
    }
  | { type: "rename"; id: string; label: string }
  | { type: "id"; id: string; value: string | undefined }
  | { type: "delimiter"; id: string; open: string; close: string }
  | { type: "metadata"; id: string; field: string; value: unknown }
  | {
      type: "decoration";
      id: string;
      field: "icon" | "class";
      value: string | undefined;
    }
  | {
      type: "move-card";
      id: string;
      columnId: string;
      targetId?: string;
      edge?: "before" | "after";
    }
  | {
      type: "move-column";
      id: string;
      targetId: string;
      edge: "before" | "after";
    }
  | { type: "delete"; id: string; moveToColumnId?: string }
  | {
      type: "comment";
      id?: string;
      anchorId?: string | null;
      positionId?: string;
      text?: string;
    }
  | { type: "config"; field: string; value: unknown };

export function kanbanRecord(model: MermaidKanbanModel, id: string) {
  return model.sourceDocument.records.find((record) => record.sourceKey === id);
}
function allNodes(model: MermaidKanbanModel) {
  return [...model.columns, ...model.cards];
}
function ownedRecords(model: MermaidKanbanModel, ids: ReadonlySet<string>) {
  const records = new Set(ids);
  for (const comment of model.comments)
    if (comment.anchorId && ids.has(comment.anchorId)) records.add(comment.id);
  for (const node of allNodes(model))
    if (ids.has(node.id))
      for (const decoration of node.decorationRanges)
        records.add(decoration.recordKey);
  return model.sourceDocument.records.filter((record) =>
    records.has(record.sourceKey),
  );
}
function remove(record: KanbanSourceRecord): KanbanPatch {
  return {
    range: {
      start: record.range.start,
      end: record.range.end + record.eol.length,
    },
    value: "",
  };
}
function after(record: KanbanSourceRecord) {
  return record.range.end + record.eol.length;
}
function insertion(
  model: MermaidKanbanModel,
  point: number,
  payload: string,
  identities: readonly (readonly [number, string])[] = [],
): KanbanPatch {
  const previous = model.sourceDocument.records.findLast(
    (record) => after(record) <= point && record.kind !== "blank",
  );
  const following = model.sourceDocument.records.find(
    (record) => record.range.start === point,
  );
  const objectCommentAtHeader =
    previous?.kind === "header" && /^[ \t]*%%/.test(payload);
  const headerComment =
    following?.kind === "comment" &&
    model.comments.some(
      (comment) =>
        comment.id === following.sourceKey && comment.affinity === "position",
    ) &&
    previous?.kind === "header";
  const prefix = objectCommentAtHeader
    ? model.sourceDocument.newline
    : point > 0 && !/[\r\n]/.test(model.sourceDocument.source[point - 1]!)
      ? model.sourceDocument.newline
      : "";
  return {
    range: { start: point, end: point },
    value:
      prefix + payload + (headerComment ? model.sourceDocument.newline : ""),
    identities: identities.map(([offset, id]) => [offset + prefix.length, id]),
  };
}
function columnEnd(model: MermaidKanbanModel, columnId: string) {
  const column = model.columns.find((item) => item.id === columnId);
  if (!column) return null;
  const ids = new Set([
    column.id,
    ...model.cards
      .filter((card) => card.columnId === columnId)
      .map((card) => card.id),
  ]);
  const records = ownedRecords(model, ids);
  return records.length ? after(records.at(-1)!) : null;
}
function objectStart(model: MermaidKanbanModel, id: string) {
  return ownedRecords(model, new Set([id]))[0]?.range.start;
}
function encodedLabel(value: string) {
  return value
    .replaceAll('"', "#quot;")
    .replaceAll("[", "#91;")
    .replaceAll("]", "#93;");
}
function validLabel(value: string) {
  return Boolean(value.trim()) && !/[\r\n]/.test(value);
}
function nodeMetadata(
  node: MermaidKanbanNode,
  field: string,
  value: unknown,
): KanbanPatch[] | null {
  if (!field || /[\r\n]/.test(field)) return null;
  if (node.metadataYaml)
    return sourceYamlFieldPatch(node.metadataYaml, [field], value);
  if (value === undefined) return [];
  return [
    {
      range: { start: node.metadataInsertion, end: node.metadataInsertion },
      value: `@{${JSON.stringify(field)}: ${JSON.stringify(value)}}`,
    },
  ];
}

/** A draft retains its opening document. Only touched anchors/membership/order must still match.
 * Unrelated edits may shift offsets; reparse uses the current source's reconciled identity. */
export function applyKanbanCommand(
  model: MermaidKanbanModel,
  command: KanbanCommand,
  options: {
    readonly?: boolean;
    baseSource?: string;
    intent?: "apply" | "preview" | "cancel";
  } = {},
): KanbanCommandResult {
  if (options.readonly) return kanbanNoChange(model, "readonly");
  if (options.intent === "cancel") return kanbanNoChange(model);
  if (model.ambiguous) return kanbanNoChange(model, "invalid");
  const nodes = allNodes(model);
  const id = "id" in command ? command.id : undefined;
  const node = id ? nodes.find((item) => item.id === id) : undefined;
  const parent =
    "columnId" in command && command.columnId
      ? model.columns.find((column) => column.id === command.columnId)
      : undefined;
  const target =
    "targetId" in command && command.targetId
      ? nodes.find((item) => item.id === command.targetId)
      : undefined;
  if (
    options.baseSource !== undefined &&
    options.baseSource !== model.sourceDocument.source
  ) {
    // Reconcile forward from the draft basis, not backward from current ranges.
    const base = parseMermaidKanbanSource(options.baseSource);
    const current = base
      ? parseMermaidKanbanSource(model.sourceDocument.source, base)
      : null;
    if (!base || !current || current.ambiguous)
      return kanbanNoChange(model, "conflict");
    const forwardKey = (key: string) => {
      const record = kanbanRecord(model, key);
      return current.sourceDocument.records.find(
        (item) =>
          item.range.start === record?.range.start && item.raw === record?.raw,
      )?.sourceKey;
    };
    const sameAnchor = (key: string) => {
      const mapped = forwardKey(key);
      return Boolean(
        mapped &&
        base.sourceDocument.records.some(
          (record) => record.sourceKey === mapped,
        ),
      );
    };
    const affected = [node, parent, target].filter(
      Boolean,
    ) as MermaidKanbanNode[];
    if (command.type === "add") {
      const column = command.afterId
        ? model.columns.find((item) => item.id === command.afterId)
        : command.kind === "column"
          ? model.columns.at(-1)
          : undefined;
      if (column) affected.push(column);
    }
    if (command.type === "comment" && command.anchorId) {
      const anchor = nodes.find((item) => item.id === command.anchorId);
      if (!anchor) return kanbanNoChange(model, "conflict");
      affected.push(anchor);
    }
    if (affected.some((item) => !sameAnchor(item.id)))
      return kanbanNoChange(model, "conflict");
    if (command.type === "config") {
      const old = readKanbanConfig(base.sourceDocument);
      const fresh = readKanbanConfig(model.sourceDocument);
      if (
        old.invalid.length ||
        fresh.invalid.length ||
        !sourceValuesEqual(
          old.effective[command.field],
          fresh.effective[command.field],
        )
      )
        return kanbanNoChange(model, "conflict");
    }
    if (command.type === "comment") {
      const key = command.id ?? command.positionId;
      const comment = key
        ? model.comments.find((item) => item.id === key)
        : undefined;
      if (key && !comment) return kanbanNoChange(model, "conflict");
      if (comment) {
        const ownerKey = comment.inline
          ? (comment.anchorId ?? model.headerId)
          : comment.id;
        if (!sameAnchor(ownerKey)) return kanbanNoChange(model, "conflict");
      }
    }
    // Capture only the ordering/membership consumed by this intent. Other columns may change independently.
    const columns = new Set<string>();
    if (command.type === "move-card" && node) {
      const moving = model.cards.find((item) => item.id === node.id)!;
      columns.add(moving.columnId);
      columns.add(command.columnId);
    }
    if (
      command.type === "delete" &&
      model.columns.some((item) => item.id === node?.id)
    )
      columns.add(node!.id);
    if (command.type === "add" && parent) columns.add(parent.id);
    if (command.type === "move-column") {
      columns.add(command.id);
      if (
        JSON.stringify(base.columns.map((item) => item.id)) !==
        JSON.stringify(current.columns.map((item) => item.id))
      )
        return kanbanNoChange(model, "conflict");
    }
    for (const columnId of columns) {
      const key = forwardKey(columnId);
      if (
        !key ||
        JSON.stringify(
          base.cards
            .filter((item) => item.columnId === key)
            .map((item) => item.id),
        ) !==
          JSON.stringify(
            current.cards
              .filter((item) => item.columnId === key)
              .map((item) => item.id),
          )
      )
        return kanbanNoChange(model, "conflict");
    }
  }
  if (
    (node && !node.writable) ||
    (parent && !parent.writable) ||
    (target && !target.writable)
  )
    return kanbanNoChange(model, "invalid");
  const patches: KanbanPatch[] = [];
  const removed = new Set<string>();
  const memberships = new Map<string, string>();
  let selection: KanbanCommandResult["selection"];
  const source = model.sourceDocument.source;
  const newline = model.sourceDocument.newline;
  const moveRecords = (
    records: KanbanSourceRecord[],
    point: number,
    indent?: string,
  ) => {
    if (
      records.some(
        (record) => point > record.range.start && point < after(record),
      )
    )
      return false;
    let payload = "";
    const mapping: (readonly [number, string])[] = [];
    for (const record of records) {
      mapping.push([payload.length, record.sourceKey]);
      const raw =
        indent === undefined
          ? record.raw
          : indent + record.raw.slice(record.indent.length);
      payload += raw + (record.eol || newline);
      patches.push(remove(record));
    }
    patches.push(insertion(model, point, payload, mapping));
    return true;
  };
  if (command.type === "rename") {
    if (!node || !validLabel(command.label))
      return kanbanNoChange(model, "invalid");
    if (node.label === command.label) return kanbanNoChange(model);
    if (node.metadata.label) {
      const fields = nodeMetadata(node, "label", command.label);
      if (!fields) return kanbanNoChange(model, "invalid");
      patches.push(...fields);
    } else if (node.labelRange) {
      const raw = source.slice(node.labelRange.start, node.labelRange.end);
      const value = encodedLabel(command.label);
      patches.push({
        range: node.labelRange,
        value: raw.startsWith('"`')
          ? `"\`${value}\`"`
          : raw.startsWith('"')
            ? `"${value}"`
            : /[(){}]/.test(value)
              ? `"${value}"`
              : value,
      });
    } else {
      patches.push({
        range: { start: node.metadataInsertion, end: node.metadataInsertion },
        value: `["${encodedLabel(command.label)}"]`,
      });
    }
  } else if (command.type === "metadata") {
    if (!node) return kanbanNoChange(model, "invalid");
    if (Object.is(node.metadata[command.field], command.value))
      return kanbanNoChange(model);
    const fields = nodeMetadata(node, command.field, command.value);
    if (!fields) return kanbanNoChange(model, "invalid");
    patches.push(...fields);
  } else if (command.type === "id") {
    if (
      !node ||
      (command.value !== undefined &&
        (!command.value.trim() || /[([\r\n){}@]/.test(command.value)))
    )
      return kanbanNoChange(model, "invalid");
    if (command.value === node.explicitId) return kanbanNoChange(model);
    if (
      command.value &&
      nodes.some(
        (other) => other.id !== node.id && other.nativeId === command.value,
      )
    )
      return kanbanNoChange(model, "invalid");
    if (node.idRange) {
      patches.push({ range: node.idRange, value: command.value ?? "" });
      // A bare ID is also the native label. Materialize that label before changing/removing only its ID.
      if (!node.labelRange)
        patches.push({
          range: { start: node.idRange.end, end: node.idRange.end },
          value: `["${encodedLabel(node.explicitId!)}"]`,
        });
    } else {
      const record = kanbanRecord(model, node.id)!;
      patches.push({
        range: {
          start: record.range.start + node.indent.length,
          end: record.range.start + node.indent.length,
        },
        value: command.value ?? "",
      });
    }
  } else if (command.type === "delimiter") {
    if (
      !node?.labelRange ||
      !["[", "(", "((", "{{", ")", "))", "(-", "-)"].includes(command.open) ||
      !["]", ")", "))", "}}", "(", "((", "(-", "-)"].includes(command.close)
    )
      return kanbanNoChange(model, "invalid");
    patches.push(
      {
        range: {
          start: node.labelRange.start - node.delimiter[0].length,
          end: node.labelRange.start,
        },
        value: command.open,
      },
      {
        range: {
          start: node.labelRange.end,
          end: node.labelRange.end + node.delimiter[1].length,
        },
        value: command.close,
      },
    );
  } else if (command.type === "decoration") {
    if (!node || (command.value !== undefined && /[\r\n)]/.test(command.value)))
      return kanbanNoChange(model, "invalid");
    const existing = node.decorationRanges.findLast(
      (item) => item.field === command.field,
    );
    if (existing)
      patches.push({
        range:
          command.value === undefined ? existing.range : existing.valueRange,
        value: command.value ?? "",
      });
    else if (command.value) {
      const record = kanbanRecord(model, node.id)!;
      const value =
        command.field === "icon"
          ? `::icon(${command.value})`
          : `:::${command.value}`;
      if (!node.labelRange)
        patches.push(
          insertion(model, after(record), `${node.indent}${value}${newline}`),
        );
      else {
        const inlineComment = model.comments.find(
          (comment) => comment.anchorId === node.id && comment.inline,
        );
        const point = inlineComment?.range.start ?? record.range.end;
        patches.push({ range: { start: point, end: point }, value });
      }
    }
  } else if (command.type === "add") {
    if (!validLabel(command.label) || (command.kind === "card" && !parent))
      return kanbanNoChange(model, "invalid");
    const header = kanbanRecord(model, model.headerId);
    if (!header) return kanbanNoChange(model, "invalid");
    const key = nextKanbanSourceKey();
    let ordinal = 1;
    while (nodes.some((item) => item.nativeId === `${command.kind}_${ordinal}`))
      ordinal++;
    const indent =
      command.kind === "column"
        ? (model.columns[0]?.indent ?? "  ")
        : parent!.indent + "  ";
    const last = model.columns.at(-1);
    const point =
      command.kind === "card"
        ? columnEnd(model, parent!.id)
        : command.afterId
          ? columnEnd(model, command.afterId)
          : last
            ? columnEnd(model, last.id)
            : after(header);
    if (point === null) return kanbanNoChange(model, "invalid");
    patches.push(
      insertion(
        model,
        point,
        `${indent}${command.kind}_${ordinal}["${encodedLabel(command.label)}"]${newline}`,
        [[0, key]],
      ),
    );
    selection = command.kind === "card" ? { cardId: key } : { columnId: key };
  } else if (command.type === "move-card") {
    const card = model.cards.find((item) => item.id === command.id);
    if (
      !card ||
      !parent ||
      (target &&
        !model.cards.some(
          (item) => item.id === target.id && item.columnId === parent.id,
        ))
    )
      return kanbanNoChange(model, "invalid");
    if (command.targetId === card.id) return kanbanNoChange(model);
    const peers = model.cards.filter((item) => item.columnId === parent.id);
    const original = model.cards
      .filter((item) => item.columnId === card.columnId)
      .map((item) => item.id);
    const ids = peers
      .filter((item) => item.id !== card.id)
      .map((item) => item.id);
    const targetIndex = command.targetId ? ids.indexOf(command.targetId) : -1;
    if (command.targetId && targetIndex < 0)
      return kanbanNoChange(model, "invalid");
    ids.splice(
      targetIndex < 0
        ? ids.length
        : targetIndex + (command.edge === "before" ? 0 : 1),
      0,
      card.id,
    );
    if (
      card.columnId === parent.id &&
      ids.every((value, index) => value === original[index])
    )
      return kanbanNoChange(model);
    const point = target
      ? command.edge === "before"
        ? objectStart(model, target.id)
        : after(ownedRecords(model, new Set([target.id])).at(-1)!)
      : columnEnd(model, parent.id);
    if (
      point === undefined ||
      point === null ||
      !moveRecords(
        ownedRecords(model, new Set([card.id])),
        point,
        parent.indent + "  ",
      )
    )
      return kanbanNoChange(model, "invalid");
    memberships.set(card.id, parent.id);
    selection = { cardId: card.id };
  } else if (command.type === "move-column") {
    const column = model.columns.find((item) => item.id === command.id);
    const dest = model.columns.find((item) => item.id === command.targetId);
    if (!column || !dest) return kanbanNoChange(model, "invalid");
    const order = model.columns.map((item) => item.id);
    const ids = order.filter((id) => id !== column.id);
    const at = ids.indexOf(dest.id);
    ids.splice(at + (command.edge === "after" ? 1 : 0), 0, column.id);
    if (ids.every((id, index) => id === order[index]))
      return kanbanNoChange(model);
    const movingIds = new Set([
      column.id,
      ...model.cards
        .filter((card) => card.columnId === column.id)
        .map((card) => card.id),
    ]);
    const point =
      command.edge === "before"
        ? objectStart(model, dest.id)
        : columnEnd(model, dest.id);
    if (
      point === undefined ||
      point === null ||
      !moveRecords(ownedRecords(model, movingIds), point)
    )
      return kanbanNoChange(model, "invalid");
    selection = { columnId: column.id };
  } else if (command.type === "delete") {
    if (!node) return kanbanNoChange(model, "invalid");
    const cards = model.cards.filter((card) => card.columnId === node.id);
    if (command.moveToColumnId) {
      const dest = model.columns.find(
        (column) => column.id === command.moveToColumnId,
      );
      if (!dest?.writable || dest.id === node.id)
        return kanbanNoChange(model, "invalid");
      const point = columnEnd(model, dest.id);
      if (point === null) return kanbanNoChange(model, "invalid");
      if (
        cards.length &&
        !moveRecords(
          ownedRecords(model, new Set(cards.map((card) => card.id))),
          point,
          dest.indent + "  ",
        )
      )
        return kanbanNoChange(model, "invalid");
      for (const card of cards) memberships.set(card.id, dest.id);
    }
    const ids = new Set([
      node.id,
      ...(command.moveToColumnId ? [] : cards.map((card) => card.id)),
    ]);
    for (const record of ownedRecords(model, ids)) {
      patches.push(remove(record));
      removed.add(record.sourceKey);
    }
    const card = model.cards.find((item) => item.id === node.id);
    selection = card
      ? { columnId: card.columnId }
      : model.columns.find((column) => column.id !== node.id)
        ? {
            columnId: model.columns.find((column) => column.id !== node.id)!.id,
          }
        : undefined;
  } else if (command.type === "comment") {
    if (command.text !== undefined && /[\r\n]/.test(command.text))
      return kanbanNoChange(model, "invalid");
    const comment = command.id
      ? model.comments.find((item) => item.id === command.id)
      : undefined;
    if (command.id && !comment) return kanbanNoChange(model, "invalid");
    if (comment) {
      if (command.text === undefined) {
        const record = kanbanRecord(model, comment.id);
        patches.push(
          comment.inline
            ? { range: comment.range, value: "" }
            : remove(record!),
        );
        removed.add(comment.id);
      } else
        patches.push({
          range: comment.range,
          value: `${comment.indent}%% ${command.text}`,
        });
    } else if (command.text?.trim()) {
      const anchor = command.anchorId
        ? nodes.find((item) => item.id === command.anchorId)
        : undefined;
      if (command.anchorId && !anchor?.writable)
        return kanbanNoChange(model, "invalid");
      const position = command.positionId
        ? model.comments.find(
            (comment) =>
              comment.id === command.positionId &&
              comment.affinity === "position",
          )
        : undefined;
      if (command.positionId && !position)
        return kanbanNoChange(model, "invalid");
      const point = anchor
        ? objectStart(model, anchor.id)
        : position
          ? position.range.start
          : after(kanbanRecord(model, model.headerId)!);
      if (point === undefined) return kanbanNoChange(model, "invalid");
      const key = nextKanbanSourceKey();
      const raw = `${anchor?.indent ?? ""}%% ${command.text}${newline}`;
      const padding =
        anchor &&
        kanbanRecord(model, model.headerId) &&
        point === after(kanbanRecord(model, model.headerId)!)
          ? newline
          : "";
      patches.push(
        insertion(model, point, padding + raw + (!anchor ? newline : ""), [
          [padding.length, key],
        ]),
      );
    }
  } else if (command.type === "config") {
    const fields = kanbanConfigPatch(
      model.sourceDocument,
      command.field,
      command.value,
    );
    if (!fields) return kanbanNoChange(model, "invalid");
    patches.push(...fields);
  }
  return writeKanbanPatches(model, patches, {
    removed,
    memberships,
    selection,
    edited: node
      ? {
          id: node.id,
          nativeId:
            command.type === "id" ||
            (command.type === "rename" &&
              !node.explicitId &&
              !node.metadata.label),
          label:
            command.type === "rename" ||
            (command.type === "metadata" && command.field === "label"),
          icon:
            (command.type === "metadata" || command.type === "decoration") &&
            command.field === "icon",
          className: command.type === "decoration" && command.field === "class",
          metadataField:
            command.type === "metadata"
              ? command.field
              : command.type === "rename" && node.metadata.label
                ? "label"
                : undefined,
        }
      : undefined,
  });
}

/** A popover may edit several fields; failures return the original basis and never a partial commit. */
export function applyKanbanCommands(
  model: MermaidKanbanModel,
  commands: readonly KanbanCommand[],
  options: Parameters<typeof applyKanbanCommand>[2] = {},
) {
  // Validate every consumed anchor against the opening basis before deriving any intermediate source.
  // Otherwise an unrelated first field could mask a stale second field in one atomic popover apply.
  if (
    options.baseSource !== undefined &&
    options.baseSource !== model.sourceDocument.source
  ) {
    for (const command of commands) {
      const checked = applyKanbanCommand(model, command, options);
      if (checked.reason !== "applied" && checked.reason !== "no-change")
        return kanbanNoChange(model, checked.reason);
    }
  }
  let result = kanbanNoChange(model);
  for (const command of commands) {
    const next = applyKanbanCommand(result.model, command, {
      ...options,
      baseSource: result.changed ? result.source : options.baseSource,
    });
    if (next.reason !== "applied" && next.reason !== "no-change")
      return kanbanNoChange(model, next.reason);
    if (next.changed) result = next;
  }
  return { ...result, changed: result.source !== model.sourceDocument.source };
}
