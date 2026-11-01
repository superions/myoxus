// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidChartDecimal } from "../../chart-number.js";
import { hashMermaidSource } from "../../../utils.js";
import { hasBlockingMermaidQuadrantDiagnostic } from "./diagnostics.js";
import { applyMermaidQuadrantAppearanceCommand } from "./commands/appearance.js";
import { applyMermaidQuadrantCommentCommand } from "./commands/comment.js";
import { applyMermaidQuadrantPointCommand } from "./commands/point.js";
import { applyMermaidQuadrantTextCommand } from "./commands/text.js";
import type {
  MermaidQuadrantAppearanceCommand,
  MermaidQuadrantCommand,
  MermaidQuadrantCommandResult,
  MermaidQuadrantCommandSelection,
  MermaidQuadrantCommentCommand,
  MermaidQuadrantPointCommand,
  MermaidQuadrantTextCommand,
} from "./commands/types.js";
import type {
  MermaidQuadrantCommentAnchor,
  MermaidQuadrantConfig,
  MermaidQuadrantInlineStyle,
  MermaidQuadrantModel,
} from "./model.js";
import {
  encodeMermaidQuadrantText,
  parseMermaidQuadrantSource,
} from "./parser.js";
import type { MermaidQuadrantSourceRecord } from "./source-document.js";

export type MermaidQuadrantSourcePatch = {
  end: number;
  replacement: string;
  start: number;
};

export type MermaidQuadrantSourceApplyIntent = "commit" | "preview";

export type MermaidQuadrantSourceApplyResult = {
  changed: boolean;
  command: MermaidQuadrantCommand;
  diagnosis: { code: string; recordId?: string };
  model: MermaidQuadrantModel;
  patches: MermaidQuadrantSourcePatch[];
  selectionAfter: MermaidQuadrantCommandSelection;
  source: string;
};

export type MermaidQuadrantSourceApplyInput = {
  baseSourceHash?: string;
  command: MermaidQuadrantCommand;
  intent?: MermaidQuadrantSourceApplyIntent;
  previousModel: MermaidQuadrantModel;
  readonly?: boolean;
  source: string;
};

function dispatchQuadrantCommand(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantCommand,
): MermaidQuadrantCommandResult {
  if (command.type.startsWith("point."))
    return applyMermaidQuadrantPointCommand(
      model,
      command as MermaidQuadrantPointCommand,
    );
  if (command.type.startsWith("text."))
    return applyMermaidQuadrantTextCommand(
      model,
      command as MermaidQuadrantTextCommand,
    );
  if (command.type.startsWith("comment."))
    return applyMermaidQuadrantCommentCommand(
      model,
      command as MermaidQuadrantCommentCommand,
    );
  return applyMermaidQuadrantAppearanceCommand(
    model,
    command as MermaidQuadrantAppearanceCommand,
  );
}

function commandRecordIds(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantCommand,
) {
  if (command.type.startsWith("point.")) {
    const pointId = "pointId" in command ? command.pointId : undefined;
    return pointId ? [recordForPoint(model, pointId).record?.id] : [];
  }
  if (command.type === "text.axis") {
    return [model.axes[command.axis].sourceRecordId];
  }
  if (command.type === "text.quadrant") {
    return [model.quadrantTexts[command.quadrant - 1].sourceRecordId];
  }
  if (
    command.type === "appearance.class-update" ||
    command.type === "appearance.class-delete"
  ) {
    return [recordForClass(model, command.classDefId).record?.id];
  }
  if (command.type === "appearance.point-style") {
    return [recordForPoint(model, command.pointId).record?.id];
  }
  if (command.type === "appearance.config") {
    return model.sourceDocument.records
      .filter(
        (record) =>
          (record.kind === "directive" || record.kind === "frontmatter") &&
          record.configFields.length > 0,
      )
      .map((record) => record.id);
  }
  if (command.type === "comment.update" || command.type === "comment.delete") {
    const comment = model.comments.find(
      (candidate) => candidate.id === command.commentId,
    );
    return [comment?.sourceRecordId];
  }
  return [];
}

function unchangedApplyResult(
  input: MermaidQuadrantSourceApplyInput,
  diagnosis: MermaidQuadrantSourceApplyResult["diagnosis"],
): MermaidQuadrantSourceApplyResult {
  return {
    changed: false,
    command: input.command,
    diagnosis,
    model: input.previousModel,
    patches: [],
    selectionAfter: { kind: "diagram" },
    source: input.source,
  };
}

function applyPatches(source: string, patches: MermaidQuadrantSourcePatch[]) {
  const ordered = [...patches].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].start < ordered[index].end) return null;
  }
  let next = source;
  for (const patch of ordered) {
    if (patch.start < 0 || patch.end < patch.start || patch.end > source.length)
      return null;
    next = `${next.slice(0, patch.start)}${patch.replacement}${next.slice(patch.end)}`;
  }
  return next;
}

function recordForPoint(model: MermaidQuadrantModel, pointId: string) {
  const point = model.points.find((candidate) => candidate.id === pointId);
  const record = point
    ? model.sourceDocument.records.find(
        (candidate) =>
          candidate.kind === "point" && candidate.id === point.sourceRecordId,
      )
    : undefined;
  return { point, record: record?.kind === "point" ? record : undefined };
}

function recordForClass(model: MermaidQuadrantModel, classDefId: string) {
  const classDef = model.classes.find(
    (candidate) => candidate.id === classDefId,
  );
  const record = classDef
    ? model.sourceDocument.records.find(
        (candidate) =>
          candidate.kind === "classDef" &&
          candidate.id === classDef.sourceRecordId,
      )
    : undefined;
  return {
    classDef,
    record: record?.kind === "classDef" ? record : undefined,
  };
}

function newlineAfter(model: MermaidQuadrantModel, offset: number) {
  const source = model.sourceDocument.source;
  if (source.startsWith("\r\n", offset)) return 2;
  return source[offset] === "\r" || source[offset] === "\n" ? 1 : 0;
}

function deleteRecordPatch(
  model: MermaidQuadrantModel,
  record: Pick<MermaidQuadrantSourceRecord, "range">,
): MermaidQuadrantSourcePatch {
  const after = newlineAfter(model, record.range.end);
  if (after)
    return {
      end: record.range.end + after,
      replacement: "",
      start: record.range.start,
    };
  const source = model.sourceDocument.source;
  const before = source.slice(0, record.range.start).endsWith("\r\n")
    ? 2
    : /[\r\n]$/.test(source.slice(0, record.range.start))
      ? 1
      : 0;
  return {
    end: record.range.end,
    replacement: "",
    start: Math.max(0, record.range.start - before),
  };
}

function insertionAfter(
  model: MermaidQuadrantModel,
  record: Pick<MermaidQuadrantSourceRecord, "range">,
  line: string,
): MermaidQuadrantSourcePatch {
  return {
    end: record.range.end,
    replacement: `${model.sourceDocument.newline}${line}`,
    start: record.range.end,
  };
}

function insertionBefore(
  model: MermaidQuadrantModel,
  record: Pick<MermaidQuadrantSourceRecord, "range">,
  line: string,
): MermaidQuadrantSourcePatch {
  return {
    end: record.range.start,
    replacement: `${line}${model.sourceDocument.newline}`,
    start: record.range.start,
  };
}

function styleSource(style: MermaidQuadrantInlineStyle) {
  return [
    style.radius === undefined ? null : `radius: ${style.radius}`,
    style.color === undefined ? null : `color: ${style.color}`,
    style.strokeColor === undefined
      ? null
      : `stroke-color: ${style.strokeColor}`,
    style.strokeWidth === undefined
      ? null
      : `stroke-width: ${style.strokeWidth}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function pointLine(
  point: MermaidQuadrantModel["points"][number],
  indent = "  ",
) {
  const classSource = point.className ? `:::${point.className}` : "";
  const styles = styleSource(point.inlineStyle);
  return `${indent}${encodeMermaidQuadrantText(point.label, point.labelForm)}${classSource}: [${mermaidChartDecimal(point.x)}, ${mermaidChartDecimal(point.y)}]${styles ? ` ${styles}` : ""}`;
}

function anchorRecord(
  model: MermaidQuadrantModel,
  anchor: MermaidQuadrantCommentAnchor,
) {
  if (anchor.kind === "diagram")
    return model.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
  if (anchor.kind === "point") return recordForPoint(model, anchor.id).record;
  if (anchor.kind === "classDef")
    return recordForClass(model, anchor.id).record;
  if (anchor.kind === "axis") {
    const axis = Object.values(model.axes).find(
      (candidate) => candidate.id === anchor.id,
    );
    return axis?.sourceRecordId
      ? model.sourceDocument.records.find(
          (record) => record.id === axis.sourceRecordId,
        )
      : undefined;
  }
  const text = model.quadrantTexts.find(
    (candidate) => candidate.id === anchor.id,
  );
  return text?.sourceRecordId
    ? model.sourceDocument.records.find(
        (record) => record.id === text.sourceRecordId,
      )
    : undefined;
}

function anchoredCommentDeletionPatches(
  model: MermaidQuadrantModel,
  anchor: MermaidQuadrantCommentAnchor,
  ownerRecordId: string,
) {
  return model.comments.flatMap((comment) => {
    const sameAnchor =
      comment.anchor.kind === anchor.kind &&
      (anchor.kind === "diagram" ||
        ("id" in comment.anchor && comment.anchor.id === anchor.id));
    if (!sameAnchor || comment.sourceRecordId === ownerRecordId) return [];
    const record = model.sourceDocument.records.find(
      (candidate) => candidate.id === comment.sourceRecordId,
    );
    return record ? [deleteRecordPatch(model, record)] : [];
  });
}

function anchorOwnedRecords(
  model: MermaidQuadrantModel,
  ownerRecord: MermaidQuadrantSourceRecord | undefined,
  anchor: MermaidQuadrantCommentAnchor,
) {
  if (!ownerRecord) return [];
  const recordIds = new Set([ownerRecord.id]);
  model.comments.forEach((comment) => {
    const sameAnchor =
      comment.anchor.kind === anchor.kind &&
      (anchor.kind === "diagram" ||
        ("id" in comment.anchor && comment.anchor.id === anchor.id));
    if (sameAnchor) {
      recordIds.add(comment.sourceRecordId);
    }
  });
  return model.sourceDocument.records
    .filter((record) => recordIds.has(record.id))
    .sort((left, right) => left.range.start - right.range.start);
}

function pointOwnedRecords(model: MermaidQuadrantModel, pointId: string) {
  return anchorOwnedRecords(model, recordForPoint(model, pointId).record, {
    id: pointId,
    kind: "point",
  });
}

function trailingOwnedRecord(
  model: MermaidQuadrantModel,
  record: MermaidQuadrantSourceRecord | undefined,
) {
  if (!record) return undefined;
  if (record.kind === "point")
    return record.pointId
      ? (pointOwnedRecords(model, record.pointId).at(-1) ?? record)
      : record;
  if (record.kind === "classDef")
    return record.classDefId
      ? (anchorOwnedRecords(model, record, {
          id: record.classDefId,
          kind: "classDef",
        }).at(-1) ?? record)
      : record;
  if (record.kind === "axis") {
    const axis = Object.values(model.axes).find(
      (candidate) => candidate.sourceRecordId === record.id,
    );
    return axis
      ? (anchorOwnedRecords(model, record, {
          id: axis.id,
          kind: "axis",
        }).at(-1) ?? record)
      : record;
  }
  if (record.kind === "quadrant") {
    const text = model.quadrantTexts.find(
      (candidate) => candidate.sourceRecordId === record.id,
    );
    return text
      ? (anchorOwnedRecords(model, record, {
          id: text.id,
          kind: "quadrantText",
        }).at(-1) ?? record)
      : record;
  }
  if (record.kind === "header")
    return (
      anchorOwnedRecords(model, record, { kind: "diagram" }).at(-1) ?? record
    );
  return record;
}

function pointPatches(
  previous: MermaidQuadrantModel,
  next: MermaidQuadrantModel,
  command: MermaidQuadrantPointCommand,
) {
  if (command.type === "point.add") {
    const point = next.points.find(
      (candidate) => !previous.points.some((old) => old.id === candidate.id),
    );
    if (!point) return null;
    const after = command.afterPointId
      ? pointOwnedRecords(previous, command.afterPointId).at(-1)
      : previous.points.length
        ? pointOwnedRecords(previous, previous.points.at(-1)!.id).at(-1)
        : [...previous.sourceDocument.records]
            .reverse()
            .find((record) =>
              ["quadrant", "axis", "metadata", "header"].includes(record.kind),
            );
    return after
      ? [
          insertionAfter(
            previous,
            trailingOwnedRecord(previous, after) ?? after,
            pointLine(point),
          ),
        ]
      : null;
  }
  const { point: oldPoint, record } = recordForPoint(previous, command.pointId);
  const newPoint = next.points.find(
    (candidate) => candidate.id === command.pointId,
  );
  if (!oldPoint || !record) return null;
  if (command.type === "point.delete")
    return [
      deleteRecordPatch(previous, record),
      ...anchoredCommentDeletionPatches(
        previous,
        { id: oldPoint.id, kind: "point" },
        record.id,
      ),
    ];
  if (!newPoint) return null;
  if (command.type === "point.rename" || command.type === "point.label-form") {
    return [
      {
        end: record.labelRange.end,
        replacement: encodeMermaidQuadrantText(
          newPoint.label,
          newPoint.labelForm,
        ),
        start: record.labelRange.start,
      },
    ];
  }
  if (command.type === "point.move") {
    return [
      {
        end: record.xRange.end,
        replacement: mermaidChartDecimal(newPoint.x),
        start: record.xRange.start,
      },
      {
        end: record.yRange.end,
        replacement: mermaidChartDecimal(newPoint.y),
        start: record.yRange.start,
      },
    ];
  }
  if (command.type === "point.class") {
    if (record.classNameRange) {
      if (newPoint.className)
        return [
          {
            end: record.classNameRange.end,
            replacement: newPoint.className,
            start: record.classNameRange.start,
          },
        ];
      const source = previous.sourceDocument.source;
      const marker = source.lastIndexOf(":::", record.classNameRange.start);
      return [
        {
          end: record.classNameRange.end,
          replacement: "",
          start: Math.max(record.labelRange.end, marker),
        },
      ];
    }
    return newPoint.className
      ? [
          {
            end: record.labelRange.end,
            replacement: `:::${newPoint.className}`,
            start: record.labelRange.end,
          },
        ]
      : [];
  }
  const movedRecords = pointOwnedRecords(previous, command.pointId);
  if (!movedRecords.length) return null;
  const targetRecords = command.beforePointId
    ? pointOwnedRecords(previous, command.beforePointId)
    : [];
  const target = targetRecords[0];
  const movedSource = movedRecords
    .map((candidate) => candidate.raw)
    .join(previous.sourceDocument.newline);
  const deletions = movedRecords.map((candidate) =>
    deleteRecordPatch(previous, candidate),
  );
  const insertion = target
    ? insertionBefore(previous, target, movedSource)
    : insertionAfter(
        previous,
        pointOwnedRecords(
          previous,
          previous.points
            .filter((candidate) => candidate.id !== command.pointId)
            .at(-1)?.id ?? "",
        ).at(-1) ??
          previous.sourceDocument.records.find(
            (candidate) => candidate.kind === "header",
          )!,
        movedSource,
      );
  return [...deletions, insertion];
}

function textPatches(
  previous: MermaidQuadrantModel,
  next: MermaidQuadrantModel,
  command: MermaidQuadrantTextCommand,
) {
  if (command.type === "text.axis") {
    const oldAxis = previous.axes[command.axis];
    const newAxis = next.axes[command.axis];
    const record = oldAxis.sourceRecordId
      ? previous.sourceDocument.records.find(
          (candidate) =>
            candidate.kind === "axis" &&
            candidate.id === oldAxis.sourceRecordId,
        )
      : undefined;
    const body = `${command.axis}-axis ${encodeMermaidQuadrantText(newAxis.start, newAxis.startForm)}${newAxis.form === "both" ? ` --> ${encodeMermaidQuadrantText(newAxis.end, newAxis.endForm)}` : newAxis.form === "left-open" ? " -->" : ""}`;
    if (record?.kind === "axis") {
      const indent = record.raw.match(/^\s*/)?.[0] ?? "";
      let syntaxEnd = record.inlineCommentRange?.start ?? record.range.end;
      while (
        syntaxEnd > record.range.start + indent.length &&
        /[\t ]/.test(previous.sourceDocument.source[syntaxEnd - 1] ?? "")
      )
        syntaxEnd -= 1;
      return [
        {
          end: syntaxEnd,
          replacement: body,
          start: record.range.start + indent.length,
        },
      ];
    }
    const header = previous.sourceDocument.records.find(
      (candidate) => candidate.kind === "header",
    );
    return header
      ? [
          insertionAfter(
            previous,
            trailingOwnedRecord(previous, header) ?? header,
            `  ${body}`,
          ),
        ]
      : null;
  }
  const oldText = previous.quadrantTexts[command.quadrant - 1];
  const newText = next.quadrantTexts[command.quadrant - 1];
  const record = oldText.sourceRecordId
    ? previous.sourceDocument.records.find(
        (candidate) =>
          candidate.kind === "quadrant" &&
          candidate.id === oldText.sourceRecordId,
      )
    : undefined;
  if (record?.kind === "quadrant") {
    return [
      {
        end: record.textRange.end,
        replacement: encodeMermaidQuadrantText(newText.text, newText.form),
        start: record.textRange.start,
      },
    ];
  }
  const after = [...previous.sourceDocument.records]
    .reverse()
    .find((candidate) =>
      ["axis", "metadata", "header", "quadrant"].includes(candidate.kind),
    );
  return after
    ? [
        insertionAfter(
          previous,
          trailingOwnedRecord(previous, after) ?? after,
          `  quadrant-${command.quadrant} ${encodeMermaidQuadrantText(newText.text, newText.form)}`,
        ),
      ]
    : null;
}

function stylePatch(
  previous: MermaidQuadrantModel,
  record: Extract<MermaidQuadrantSourceRecord, { kind: "point" }>,
  style: MermaidQuadrantInlineStyle,
) {
  const replacement = styleSource(style);
  if (record.stylesRange)
    return {
      end: record.stylesRange.end,
      replacement,
      start: record.stylesRange.start,
    };
  const source = previous.sourceDocument.source;
  const close = source.indexOf("]", record.yRange.end);
  return {
    end: close + 1,
    replacement: replacement ? `] ${replacement}` : "]",
    start: close,
  };
}

function configPatches(
  previous: MermaidQuadrantModel,
  config: MermaidQuadrantConfig,
) {
  const existing = previous.sourceDocument.records.flatMap((record) =>
    record.kind === "frontmatter" || record.kind === "directive"
      ? record.configFields.map((field) => ({ field, record }))
      : [],
  );
  const patches: MermaidQuadrantSourcePatch[] = [];
  const missing: Array<[string, unknown]> = [];
  for (const [field, value] of Object.entries(config)) {
    const owner = [...existing]
      .reverse()
      .find((candidate) => candidate.field.field === field);
    if (owner) {
      patches.push({
        end: owner.field.valueRange.end,
        replacement: String(value),
        start: owner.field.valueRange.start,
      });
    } else missing.push([field, value]);
  }
  if (missing.length) {
    const header = previous.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
    if (!header) return null;
    const entries = missing
      .map(([field, value]) => `"${field}": ${JSON.stringify(value)}`)
      .join(", ");
    patches.push(
      insertionBefore(
        previous,
        header,
        `%%{init: {"quadrantChart": {${entries}}}}%%`,
      ),
    );
  }
  return patches;
}

function metadataPatch(
  previous: MermaidQuadrantModel,
  field: "accessibilityDescription" | "accessibilityTitle" | "title",
  value: string,
) {
  const record = [...previous.sourceDocument.records]
    .reverse()
    .find(
      (candidate) => candidate.kind === "metadata" && candidate.field === field,
    );
  if (record?.kind === "metadata") {
    if (!value) return deleteRecordPatch(previous, record);
    const replacement =
      record.format === "block"
        ? `${previous.sourceDocument.newline}    ${value
            .split("\n")
            .join(
              `${previous.sourceDocument.newline}    `,
            )}${previous.sourceDocument.newline}  `
        : field === "title"
          ? encodeMermaidQuadrantText(value, "plain")
          : value;
    return {
      end: record.valueRange.end,
      replacement,
      start: record.valueRange.start,
    };
  }
  if (!value) return null;
  const header = previous.sourceDocument.records.find(
    (candidate) => candidate.kind === "header",
  );
  if (!header) return null;
  const line =
    field === "title"
      ? `  title ${value}`
      : field === "accessibilityTitle"
        ? `  accTitle: ${value}`
        : value.includes("\n")
          ? `  accDescr {${previous.sourceDocument.newline}    ${value
              .split("\n")
              .join(
                `${previous.sourceDocument.newline}    `,
              )}${previous.sourceDocument.newline}  }`
          : `  accDescr: ${value}`;
  return insertionAfter(
    previous,
    trailingOwnedRecord(previous, header) ?? header,
    line,
  );
}

function appearancePatches(
  previous: MermaidQuadrantModel,
  next: MermaidQuadrantModel,
  command: MermaidQuadrantAppearanceCommand,
): MermaidQuadrantSourcePatch[] | null {
  if (command.type === "appearance.point-style") {
    const record = recordForPoint(previous, command.pointId).record;
    const point = next.points.find(
      (candidate) => candidate.id === command.pointId,
    );
    return record && point
      ? [stylePatch(previous, record, point.inlineStyle)]
      : null;
  }
  if (command.type === "appearance.class-add") {
    const classDef = next.classes.find(
      (candidate) => !previous.classes.some((old) => old.id === candidate.id),
    );
    const after = [...previous.sourceDocument.records]
      .reverse()
      .find((record) =>
        ["classDef", "point", "quadrant", "axis", "header"].includes(
          record.kind,
        ),
      );
    return classDef && after
      ? [
          insertionAfter(
            previous,
            trailingOwnedRecord(previous, after) ?? after,
            `  classDef ${classDef.name} ${styleSource(classDef.style)}`,
          ),
        ]
      : null;
  }
  if (command.type === "appearance.class-update") {
    const { classDef: oldClass, record } = recordForClass(
      previous,
      command.classDefId,
    );
    const newClass = next.classes.find(
      (candidate) => candidate.id === command.classDefId,
    );
    if (!oldClass || !record || !newClass) return null;
    const patches: MermaidQuadrantSourcePatch[] = [
      {
        end: record.classNameRange.end,
        replacement: newClass.name,
        start: record.classNameRange.start,
      },
      {
        end: record.stylesRange.end,
        replacement: styleSource(newClass.style),
        start: record.stylesRange.start,
      },
    ];
    if (oldClass.name !== newClass.name) {
      for (const candidate of previous.sourceDocument.records) {
        if (candidate.kind !== "point" || !candidate.classNameRange) continue;
        if (
          previous.sourceDocument.source.slice(
            candidate.classNameRange.start,
            candidate.classNameRange.end,
          ) !== oldClass.name
        )
          continue;
        patches.push({
          end: candidate.classNameRange.end,
          replacement: newClass.name,
          start: candidate.classNameRange.start,
        });
      }
    }
    return patches;
  }
  if (command.type === "appearance.class-delete") {
    const { classDef, record } = recordForClass(previous, command.classDefId);
    if (!classDef || !record) return null;
    const replacement = command.replacementClassId
      ? next.classes.find(
          (candidate) => candidate.id === command.replacementClassId,
        )?.name
      : undefined;
    const patches = [
      deleteRecordPatch(previous, record),
      ...anchoredCommentDeletionPatches(
        previous,
        { id: classDef.id, kind: "classDef" },
        record.id,
      ),
    ];
    for (const candidate of previous.sourceDocument.records) {
      if (candidate.kind !== "point" || !candidate.classNameRange) continue;
      if (
        previous.sourceDocument.source.slice(
          candidate.classNameRange.start,
          candidate.classNameRange.end,
        ) !== classDef.name
      )
        continue;
      if (replacement) {
        patches.push({
          end: candidate.classNameRange.end,
          replacement,
          start: candidate.classNameRange.start,
        });
      } else {
        const marker = previous.sourceDocument.source.lastIndexOf(
          ":::",
          candidate.classNameRange.start,
        );
        patches.push({
          end: candidate.classNameRange.end,
          replacement: "",
          start: Math.max(candidate.labelRange.end, marker),
        });
      }
    }
    return patches;
  }
  if (command.type === "appearance.config")
    return configPatches(previous, next.config);
  if (command.type === "diagram.title") {
    const patch = metadataPatch(previous, "title", next.title);
    return patch ? [patch] : null;
  }
  const patches = [
    metadataPatch(previous, "accessibilityTitle", next.accessibilityTitle),
    metadataPatch(
      previous,
      "accessibilityDescription",
      next.accessibilityDescription,
    ),
  ].filter(Boolean) as MermaidQuadrantSourcePatch[];
  return patches;
}

function commentPatches(
  previous: MermaidQuadrantModel,
  next: MermaidQuadrantModel,
  command: MermaidQuadrantCommentCommand,
) {
  if (command.type === "comment.add") {
    const comment = next.comments.find(
      (candidate) => !previous.comments.some((old) => old.id === candidate.id),
    );
    const anchor = comment ? anchorRecord(previous, comment.anchor) : undefined;
    if (!comment || !anchor) return null;
    const line = `${anchor.raw.match(/^\s*/)?.[0] ?? "  "}%% ${comment.text}`;
    return [
      comment.position === "before"
        ? insertionBefore(previous, anchor, line)
        : insertionAfter(previous, anchor, line),
    ];
  }
  const oldComment = previous.comments.find(
    (candidate) => candidate.id === command.commentId,
  );
  const record = oldComment
    ? previous.sourceDocument.records.find(
        (candidate) => candidate.id === oldComment.sourceRecordId,
      )
    : undefined;
  if (!oldComment || !record) return null;
  if (command.type === "comment.delete") {
    if ("inlineCommentRange" in record && record.inlineCommentRange) {
      let start = record.inlineCommentRange.start;
      while (
        start > record.range.start &&
        /[\t ]/.test(previous.sourceDocument.source[start - 1] ?? "")
      )
        start -= 1;
      return [{ end: record.inlineCommentRange.end, replacement: "", start }];
    }
    return [deleteRecordPatch(previous, record)];
  }
  const updated = next.comments.find(
    (candidate) => candidate.id === command.commentId,
  );
  if (!updated) return null;
  const range =
    "inlineCommentRange" in record && record.inlineCommentRange
      ? record.inlineCommentRange
      : record.range;
  const raw = previous.sourceDocument.source.slice(range.start, range.end);
  const marker = raw.indexOf("%%");
  if (marker < 0) return null;
  let textStart = marker + 2;
  while (/[\t ]/.test(raw[textStart] ?? "")) textStart += 1;
  return [
    {
      end: range.end,
      replacement: updated.text,
      start: range.start + textStart,
    },
  ];
}

function patchesForCommand(
  previous: MermaidQuadrantModel,
  next: MermaidQuadrantModel,
  command: MermaidQuadrantCommand,
) {
  if (command.type.startsWith("point."))
    return pointPatches(previous, next, command as MermaidQuadrantPointCommand);
  if (command.type.startsWith("text."))
    return textPatches(previous, next, command as MermaidQuadrantTextCommand);
  if (command.type.startsWith("comment."))
    return commentPatches(
      previous,
      next,
      command as MermaidQuadrantCommentCommand,
    );
  return appearancePatches(
    previous,
    next,
    command as MermaidQuadrantAppearanceCommand,
  );
}

function adoptPatchedIdentities(
  parsed: MermaidQuadrantModel,
  intended: MermaidQuadrantModel,
) {
  parsed.points.forEach((point, index) => {
    const identity = intended.points[index];
    if (!identity) return;
    point.id = identity.id;
    const record = parsed.sourceDocument.records.find(
      (candidate) =>
        candidate.kind === "point" && candidate.id === point.sourceRecordId,
    );
    if (record?.kind === "point") record.pointId = identity.id;
  });
  parsed.classes.forEach((classDef, index) => {
    const identity = intended.classes[index];
    if (!identity) return;
    classDef.id = identity.id;
    const record = parsed.sourceDocument.records.find(
      (candidate) =>
        candidate.kind === "classDef" &&
        candidate.id === classDef.sourceRecordId,
    );
    if (record?.kind === "classDef") record.classDefId = identity.id;
  });
  parsed.comments.forEach((comment) => {
    const semanticCandidates = intended.comments.filter(
      (candidate) =>
        candidate.text === comment.text &&
        candidate.anchor.kind === comment.anchor.kind &&
        (comment.anchor.kind === "diagram" ||
          ("id" in candidate.anchor &&
            candidate.anchor.id === comment.anchor.id)),
    );
    const identity =
      intended.comments.find(
        (candidate) =>
          candidate.sourceRecordId &&
          candidate.sourceRecordId === comment.sourceRecordId,
      ) ??
      (semanticCandidates.length === 1 ? semanticCandidates[0] : undefined);
    if (identity) {
      comment.anchor = { ...identity.anchor };
      comment.id = identity.id;
      comment.position = identity.position;
      const record = parsed.sourceDocument.records.find(
        (candidate) => candidate.id === comment.sourceRecordId,
      );
      if (record?.kind === "comment") record.commentId = identity.id;
      else if (record && "inlineCommentId" in record) {
        record.inlineCommentId = identity.id;
      }
    }
  });
  return parsed;
}

export function applyMermaidQuadrantSourceCommand(
  input: MermaidQuadrantSourceApplyInput,
): MermaidQuadrantSourceApplyResult {
  if (input.readonly)
    return unchangedApplyResult(input, { code: "quadrant.readonly" });
  if (
    input.baseSourceHash &&
    input.baseSourceHash !== hashMermaidSource(input.source)
  ) {
    return unchangedApplyResult(input, { code: "quadrant.source-conflict" });
  }
  const blockedRecordId = commandRecordIds(
    input.previousModel,
    input.command,
  ).find(
    (recordId): recordId is string =>
      recordId !== undefined &&
      hasBlockingMermaidQuadrantDiagnostic(
        input.previousModel.diagnostics,
        recordId,
      ),
  );
  if (blockedRecordId) {
    return unchangedApplyResult(input, {
      code: "quadrant.statement-protected",
      recordId: blockedRecordId,
    });
  }
  const commandResult = dispatchQuadrantCommand(
    input.previousModel,
    input.command,
  );
  if (!commandResult.changed) {
    return {
      ...unchangedApplyResult(input, commandResult.diagnosis),
      selectionAfter: commandResult.selectionAfter,
    };
  }
  const patches = patchesForCommand(
    input.previousModel,
    commandResult.model,
    input.command,
  );
  if (!patches) {
    return unchangedApplyResult(input, { code: "quadrant.patch-unavailable" });
  }
  const source = applyPatches(input.source, patches);
  if (source === null || source === input.source) {
    return unchangedApplyResult(input, {
      code: source === null ? "quadrant.patch-overlap" : "quadrant.no-change",
    });
  }
  const reparsed = parseMermaidQuadrantSource(
    source,
    input.previousModel.sourceDocument,
  );
  if (!reparsed) {
    return unchangedApplyResult(input, { code: "quadrant.reparse-failed" });
  }
  return {
    changed: true,
    command: input.command,
    diagnosis: { code: "quadrant.ok" },
    model: adoptPatchedIdentities(reparsed, commandResult.model),
    patches,
    selectionAfter: commandResult.selectionAfter,
    source,
  };
}
