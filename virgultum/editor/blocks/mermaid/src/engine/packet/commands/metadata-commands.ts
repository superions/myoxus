// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../../i18n.js";
import type { MermaidPacketComment, MermaidPacketModel } from "../model.js";
import {
  packetConfigPatches,
  PACKET_CONFIG_FIELDS,
  packetConfigValueDiagnostic,
  type PacketConfig,
} from "../config.js";
import { nextPacketSourceKey } from "../source-document.js";
import {
  packetNoChange,
  writePacketPatches,
  type PacketWriteOptions,
} from "../writer.js";

export type PacketCommentAnchor = Pick<
  MermaidPacketComment,
  "anchorKind" | "anchorId"
> & { position: "before" | "inline" | "after" };
export type PacketCommentCommand =
  | {
      type: "comment-add";
      anchor: PacketCommentAnchor;
      text: string;
      commentKey?: string;
    }
  | { type: "comment-edit"; commentKey: string; text: string }
  | { type: "comment-delete"; commentKey: string }
  | { type: "comment-reorder"; commentKey: string; targetKey: string };

function commentValue(text: string) {
  const value = text.trim().replace(/^%%\s*/, "");
  return value && !/[\r\n]/.test(value) && !value.startsWith("{")
    ? value
    : null;
}
export function applyPacketCommentCommand(
  model: MermaidPacketModel,
  command: PacketCommentCommand,
  options: PacketWriteOptions = {},
) {
  const records = model.sourceDocument.records;
  const newline = model.sourceDocument.newline;
  if (command.type === "comment-add") {
    const text = commentValue(command.text);
    const anchor = command.anchor;
    const record =
      anchor.anchorKind === "diagram"
        ? records.find((r) => r.kind === "header")
        : records.find(
            (r) =>
              r.sourceKey ===
              (anchor.anchorId ??
                model.metadataKeys?.[
                  anchor.anchorKind as keyof typeof model.metadataKeys
                ]),
          );
    if (!text || !record || (anchor.position === "inline" && !record.eol))
      return packetNoChange(model, "invalid", messages.packetCommentAnchor());
    const key = command.commentKey ?? nextPacketSourceKey();
    if (records.some((r) => r.sourceKey === key))
      return packetNoChange(model, "invalid", messages.packetCommentIdentity());
    const before = anchor.position === "before";
    const inline = anchor.position === "inline";
    const owned = (model.comments ?? []).filter(
      (c) => c.anchorId === record.sourceKey && c.position === anchor.position,
    );
    const offset = before
      ? Math.min(record.range.start, ...owned.map((c) => c.range!.start))
      : inline
        ? record.range.end
        : Math.max(
            record.range.end + record.eol.length,
            ...owned.map((c) => {
              const r = records.find((r) => r.sourceKey === c.id)!;
              return r.range.end + r.eol.length;
            }),
          );
    const prior = records.findLast((r) => r.range.end + r.eol.length <= offset);
    const prefix = inline
      ? " "
      : !before &&
          offset > 0 &&
          !/[\r\n]/.test(model.sourceDocument.source[offset - 1]!)
        ? newline
        : before &&
            prior?.kind === "header" &&
            prior.indent === record.indent &&
            anchor.anchorKind !== "diagram"
          ? newline
          : "";
    const indent = inline ? "" : record.indent;
    const suffix = inline ? "" : newline + (!before ? newline : "");
    const result = writePacketPatches(
      model,
      [
        {
          range: { start: offset, end: offset },
          value: `${prefix}${indent}%% ${text}${suffix}`,
          identities: [[prefix.length, key]],
        },
      ],
      options,
    );
    const added = result.model.comments?.find((c) => c.id === key);
    if (
      result.changed &&
      (!added ||
        added.anchorKind !== anchor.anchorKind ||
        (anchor.anchorKind !== "diagram" &&
          added.anchorId !== record.sourceKey) ||
        added.position !== anchor.position)
    )
      return packetNoChange(model, "invalid", messages.packetCommentPosition());
    return result;
  }
  const comment = model.comments?.find((c) => c.id === command.commentKey);
  const record = records.find(
    (r) => r.sourceKey === command.commentKey && r.kind === "comment",
  );
  if (!comment || !record)
    return packetNoChange(model, "invalid", messages.packetMissingComment());
  if (command.type === "comment-edit") {
    const text = commentValue(command.text);
    if (!text)
      return packetNoChange(model, "invalid", messages.packetCommentText());
    const prefix = /^\s*%%\s*/.exec(record.raw)![0];
    return writePacketPatches(
      model,
      [
        {
          range: {
            start: record.range.start + prefix.length,
            end: record.range.end,
          },
          value: text,
        },
      ],
      options,
    );
  }
  if (command.type === "comment-delete") {
    return writePacketPatches(
      model,
      [
        {
          range: {
            start: record.range.start,
            end:
              record.range.end +
              (comment.position === "inline" ? 0 : record.eol.length),
          },
          value: "",
        },
      ],
      { ...options, removed: new Set([comment.id]) },
    );
  }
  if (command.targetKey === command.commentKey) return packetNoChange(model);
  const target = model.comments?.find((c) => c.id === command.targetKey);
  const other = records.find(
    (r) => r.sourceKey === command.targetKey && r.kind === "comment",
  );
  if (
    !target ||
    !other ||
    target.anchorKind !== comment.anchorKind ||
    target.anchorId !== comment.anchorId ||
    target.position !== comment.position
  )
    return packetNoChange(model, "invalid", messages.packetCommentReorder());
  return writePacketPatches(
    model,
    [
      {
        range: record.range,
        value: other.raw,
        identities: [[0, other.sourceKey]],
      },
      {
        range: other.range,
        value: record.raw,
        identities: [[0, record.sourceKey]],
      },
    ],
    options,
  );
}

export type PacketMetadataCommand =
  | { type: "accessibility"; title: string; description: string }
  | { type: "appearance"; changes: Partial<PacketConfig> };

export function applyPacketMetadataCommand(
  model: MermaidPacketModel,
  command: PacketMetadataCommand,
  options: PacketWriteOptions = {},
) {
  if (command.type === "appearance") {
    for (const field of PACKET_CONFIG_FIELDS) {
      if (!Object.hasOwn(command.changes, field)) continue;
      const diagnostic = packetConfigValueDiagnostic(
        field,
        command.changes[field],
      );
      if (diagnostic) return packetNoChange(model, "invalid", diagnostic);
    }
    const patches = packetConfigPatches(model, command.changes);
    return patches
      ? writePacketPatches(model, patches, {
          ...options,
          allowConfigDiagnostics: true,
        })
      : packetNoChange(model, "invalid", messages.packetConfigPatch());
  }
  if (
    /[\r\n]/.test(command.title) ||
    command.title.includes("%%") ||
    /}/.test(command.description)
  )
    return packetNoChange(
      model,
      "invalid",
      messages.packetAccessibilityDelimiters(),
    );
  const patches: import("../writer.js").PacketPatch[] = [];
  const newline = model.sourceDocument.newline;
  let inserted = "";
  for (const [kind, name, value, previous] of [
    [
      "accessibility-title",
      "accTitle",
      command.title,
      model.accessibilityTitle,
    ],
    [
      "accessibility-description",
      "accDescr",
      command.description.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
      model.accessibilityDescription,
    ],
  ] as const) {
    if (value === previous) continue;
    const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === model.metadataKeys?.[kind],
    );
    const block =
      name === "accDescr" &&
      (value.includes("\n") ||
        value.includes("%%") ||
        (record && /^accDescr\s*\{/.test(record.raw.trimStart())));
    if (record) {
      const existingBlock = /^accDescr\s*\{/.test(record.raw.trimStart());
      const prefix =
        block && existingBlock
          ? record.raw.slice(0, record.raw.indexOf("{") + 1)
          : record.raw.slice(0, record.raw.indexOf(":") + 1);
      const start = record.range.start + prefix.length;
      const end = record.range.end;
      const indent = record.indent;
      if (block) {
        const innerIndent =
          /^\s*accDescr\s*\{(?:\r\n|\r|\n)([ \t]*)/.exec(record.raw)?.[1] ??
          indent + "  ";
        patches.push({
          range: {
            start: existingBlock ? start : record.range.start,
            end: existingBlock
              ? record.range.start + record.raw.lastIndexOf("}")
              : end,
          },
          value: existingBlock
            ? `${newline}${innerIndent}${value.split("\n").join(newline + innerIndent)}${newline}${indent}`
            : `${indent}accDescr {${newline}${innerIndent}${value.split("\n").join(newline + innerIndent)}${newline}${indent}}`,
        });
      } else {
        const old = record.raw.slice(prefix.length);
        const leading = /^[ \t]*/.exec(old)![0],
          trailing = /[ \t]*$/.exec(old)![0];
        patches.push({
          range: { start, end },
          value: leading + value + trailing,
        });
      }
    } else {
      inserted += block
        ? `  accDescr {${newline}    ${value.split("\n").join(newline + "    ")}${newline}  }${newline}`
        : `  ${name}: ${value}${newline}`;
    }
  }
  if (inserted) {
    const header = model.sourceDocument.records.find(
      (r) => r.kind === "header",
    );
    if (!header)
      return packetNoChange(model, "invalid", messages.packetHeaderLost());
    const offset = model.sourceDocument.source.length;
    const last = model.sourceDocument.records.at(-1);
    const prefix =
      (offset && !/[\r\n]/.test(model.sourceDocument.source[offset - 1]!)
        ? newline
        : "") + (last?.kind === "comment" ? newline : "");
    patches.push({
      range: { start: offset, end: offset },
      value: prefix + inserted,
    });
  }
  return writePacketPatches(model, patches, options);
}
