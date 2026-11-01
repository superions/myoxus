// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidChartDecimal } from "../../chart-number.js";
import type { MermaidXyAppearanceCommand } from "./commands/appearance.js";
import { validateMermaidXyAppearanceCommand } from "./commands/appearance.js";
import type {
  MermaidXyAxisCommand,
  MermaidXyCategoryCommand,
} from "./commands/axis.js";
import { validateMermaidXyAxisCommand } from "./commands/axis.js";
import type { MermaidXyCommentCommand } from "./commands/comment.js";
import { validateMermaidXyCommentCommand } from "./commands/comment.js";
import type { MermaidXyPlotCommand } from "./commands/plot.js";
import { validateMermaidXyPlotCommand } from "./commands/plot.js";
import {
  findMermaidXyPoint,
  type MermaidXyPointCommand,
  validateMermaidXyPointCommand,
} from "./commands/point.js";
import type {
  MermaidXyCommand,
  MermaidXyCommandSelection,
} from "./commands/types.js";
import {
  DEFAULT_MERMAID_XY_CONFIG,
  refreshMermaidXyIdentityArchive,
} from "./model.js";
import type {
  MermaidXyCommentAnchor,
  MermaidXyConfig,
  MermaidXyModel,
  MermaidXyPlot,
} from "./model.js";
import { encodeMermaidXyText, parseMermaidXySource } from "./parser.js";
import type {
  MermaidXySourceRange,
  MermaidXySourceRecord,
  MermaidXyTextForm,
} from "./source-document.js";

export type MermaidXySourcePatch = {
  end: number;
  replacement: string;
  start: number;
};
export type MermaidXySourceApplyIntent = "commit" | "preview";
export type MermaidXySourceApplyResult = {
  changed: boolean;
  command: MermaidXyCommand;
  diagnosis: { code: string; recordId?: string };
  model: MermaidXyModel;
  patches: MermaidXySourcePatch[];
  selectionAfter: MermaidXyCommandSelection;
  source: string;
};
export type MermaidXySourceApplyInput = {
  baseSourceHash?: string;
  command: MermaidXyCommand;
  intent?: MermaidXySourceApplyIntent;
  previousModel: MermaidXyModel;
  readonly?: boolean;
  source: string;
};

function unchanged(
  input: MermaidXySourceApplyInput,
  code: string,
  selectionAfter: MermaidXyCommandSelection = { kind: "diagram" },
): MermaidXySourceApplyResult {
  return {
    changed: false,
    command: input.command,
    diagnosis: { code },
    model: input.previousModel,
    patches: [],
    selectionAfter,
    source: input.source,
  };
}

function validate(model: MermaidXyModel, command: MermaidXyCommand) {
  if (command.type.startsWith("axis.") || command.type.startsWith("category."))
    return validateMermaidXyAxisCommand(
      model,
      command as MermaidXyAxisCommand | MermaidXyCategoryCommand,
    );
  if (command.type.startsWith("plot."))
    return validateMermaidXyPlotCommand(model, command as MermaidXyPlotCommand);
  if (command.type.startsWith("point."))
    return validateMermaidXyPointCommand(
      model,
      command as MermaidXyPointCommand,
    );
  if (command.type.startsWith("comment."))
    return validateMermaidXyCommentCommand(
      model,
      command as MermaidXyCommentCommand,
    );
  return validateMermaidXyAppearanceCommand(
    model,
    command as MermaidXyAppearanceCommand,
  );
}

function applyPatches(
  source: string,
  patches: readonly MermaidXySourcePatch[],
) {
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

function newlineAfter(model: MermaidXyModel, offset: number) {
  const source = model.sourceDocument.source;
  if (source.startsWith("\r\n", offset)) return 2;
  return source[offset] === "\r" || source[offset] === "\n" ? 1 : 0;
}

function deleteRecordPatch(
  model: MermaidXyModel,
  record: Pick<MermaidXySourceRecord, "range">,
): MermaidXySourcePatch {
  const after = newlineAfter(model, record.range.end);
  if (after)
    return {
      end: record.range.end + after,
      replacement: "",
      start: record.range.start,
    };
  const beforeSource = model.sourceDocument.source.slice(0, record.range.start);
  const before = beforeSource.endsWith("\r\n")
    ? 2
    : /[\r\n]$/.test(beforeSource)
      ? 1
      : 0;
  return {
    end: record.range.end,
    replacement: "",
    start: Math.max(0, record.range.start - before),
  };
}

function removeAxisRecordPatch(
  model: MermaidXyModel,
  record:
    | Extract<MermaidXySourceRecord, { kind: "x-axis" }>
    | Extract<MermaidXySourceRecord, { kind: "y-axis" }>,
): MermaidXySourcePatch {
  if (!record.inlineCommentRange) return deleteRecordPatch(model, record);
  const indentation = /^\s*/.exec(record.raw)?.[0] ?? "";
  return {
    end: record.range.end,
    replacement: `${indentation}${record.raw
      .slice(record.inlineCommentRange.start - record.range.start)
      .trimStart()}`,
    start: record.range.start,
  };
}

function insertionAfter(
  model: MermaidXyModel,
  record: Pick<MermaidXySourceRecord, "range">,
  line: string,
): MermaidXySourcePatch {
  return {
    end: record.range.end,
    replacement: `${model.sourceDocument.newline}${line}`,
    start: record.range.end,
  };
}

function insertionBefore(
  model: MermaidXyModel,
  record: Pick<MermaidXySourceRecord, "range">,
  line: string,
): MermaidXySourcePatch {
  return {
    end: record.range.start,
    replacement: `${line}${model.sourceDocument.newline}`,
    start: record.range.start,
  };
}

function recordById(model: MermaidXyModel, id?: string) {
  return id
    ? model.sourceDocument.records.find((record) => record.id === id)
    : undefined;
}

function plotRecord(model: MermaidXyModel, plotId: string) {
  const plot = model.plots.find((candidate) => candidate.id === plotId);
  const record = plot ? recordById(model, plot.sourceRecordId) : undefined;
  return { plot, record: record?.kind === "plot" ? record : undefined };
}

function trailingPlotRecord(model: MermaidXyModel, plotId: string) {
  const { record } = plotRecord(model, plotId);
  if (!record) return undefined;
  const owned = model.comments.flatMap((comment) => {
    if (
      comment.anchor.kind !== "plot" ||
      comment.anchor.id !== plotId ||
      comment.sourceRecordId === record.id
    )
      return [];
    const owner = recordById(model, comment.sourceRecordId);
    return owner?.kind === "comment" && owner.range.start > record.range.start
      ? [owner]
      : [];
  });
  return [...owned, record].sort(
    (left, right) => right.range.end - left.range.end,
  )[0];
}

function leadingPlotRecord(model: MermaidXyModel, plotId: string) {
  const { record } = plotRecord(model, plotId);
  if (!record) return undefined;
  const owned = model.comments.flatMap((comment) => {
    if (
      comment.anchor.kind !== "plot" ||
      comment.anchor.id !== plotId ||
      comment.sourceRecordId === record.id
    )
      return [];
    const owner = recordById(model, comment.sourceRecordId);
    return owner?.kind === "comment" && owner.range.start < record.range.start
      ? [owner]
      : [];
  });
  return [...owned, record].sort(
    (left, right) => left.range.start - right.range.start,
  )[0];
}

function inlineCommentSuffix(record: MermaidXySourceRecord | undefined) {
  if (
    !record ||
    !("inlineCommentRange" in record) ||
    !record.inlineCommentRange
  )
    return "";
  return ` ${record.raw.slice(record.inlineCommentRange.start - record.range.start).trimStart()}`;
}

function listBodyPatch(
  record: MermaidXySourceRecord,
  ranges: readonly MermaidXySourceRange[],
  entries: readonly string[],
): MermaidXySourcePatch | null {
  if (ranges.length === 0) return null;
  const separator =
    ranges.length > 1
      ? record.raw.slice(
          ranges[0].end - record.range.start,
          ranges[1].start - record.range.start,
        )
      : ", ";
  return {
    end: ranges.at(-1)!.end,
    replacement: entries.join(separator.includes(",") ? separator : ", "),
    start: ranges[0].start,
  };
}

function textSource(
  value: string,
  form: MermaidXyTextForm | undefined,
  fallback: MermaidXyTextForm = "quoted",
) {
  return encodeMermaidXyText(value, form ?? fallback);
}

function plotLine(
  plot: Pick<
    MermaidXyPlot,
    "kind" | "points" | "title" | "titleExplicit" | "titleForm"
  >,
  inlineComment = "",
) {
  const title = plot.titleExplicit
    ? ` ${textSource(plot.title, plot.titleForm)}`
    : "";
  const points = plot.points.map((point) => {
    const label = point.label
      ? ` ${textSource(point.label, point.labelForm, "plain")}`
      : "";
    return `${mermaidChartDecimal(point.value)}${label}`;
  });
  return `  ${plot.kind}${title} [${points.join(", ")}]${inlineComment}`;
}

function xAxisLine(
  state: {
    categories: ReadonlyArray<{ label: string; textForm: MermaidXyTextForm }>;
    form: "band" | "linear" | "title-only";
    maximum: number;
    minimum: number;
    title: string;
    titleForm?: MermaidXyTextForm;
  },
  record?: MermaidXySourceRecord,
) {
  const title = state.title
    ? `${textSource(state.title, state.titleForm)} `
    : "";
  const suffix = inlineCommentSuffix(record);
  if (state.form === "band") {
    const categories = state.categories
      .map((category) => textSource(category.label, category.textForm))
      .join(", ");
    return `  x-axis ${title}[${categories}]${suffix}`;
  }
  if (state.form === "linear")
    return `  x-axis ${title}${mermaidChartDecimal(state.minimum)} --> ${mermaidChartDecimal(state.maximum)}${suffix}`;
  return `  x-axis${state.title ? ` ${textSource(state.title, state.titleForm)}` : ""}${suffix}`;
}

function yAxisLine(
  state: {
    maximum: number;
    minimum: number;
    rangeExplicit: boolean;
    title: string;
    titleForm?: MermaidXyTextForm;
  },
  record?: MermaidXySourceRecord,
) {
  const title = state.title
    ? ` ${textSource(state.title, state.titleForm)}`
    : "";
  const range = state.rangeExplicit
    ? ` ${mermaidChartDecimal(state.minimum)} --> ${mermaidChartDecimal(state.maximum)}`
    : "";
  return `  y-axis${title}${range}${inlineCommentSuffix(record)}`;
}

function replaceOrInsertAxis(
  model: MermaidXyModel,
  axis: "x" | "y",
  line: string,
) {
  const id =
    axis === "x" ? model.xAxis.sourceRecordId : model.yAxis.sourceRecordId;
  const record = recordById(model, id);
  if (record)
    return {
      end: record.range.end,
      replacement: line,
      start: record.range.start,
    };
  const anchor = [...model.sourceDocument.records]
    .reverse()
    .find((candidate) =>
      axis === "x"
        ? ["header", "metadata"].includes(candidate.kind)
        : ["x-axis", "header", "metadata"].includes(candidate.kind),
    );
  return anchor ? insertionAfter(model, anchor, line) : null;
}

function axisPatches(
  model: MermaidXyModel,
  command: MermaidXyAxisCommand | MermaidXyCategoryCommand,
): MermaidXySourcePatch[] | null {
  if (command.type === "axis.orientation") {
    const header = model.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
    if (!header || header.kind !== "header") return null;
    if (header.orientationRange)
      return [
        {
          end: header.orientationRange.end,
          replacement: command.orientation,
          start: header.orientationRange.start,
        },
      ];
    const configOrientation = model.sourceDocument.records
      .flatMap((record) =>
        record.kind === "frontmatter" || record.kind === "directive"
          ? record.configFields
          : [],
      )
      .reverse()
      .find((field) => field.field === "chartOrientation");
    if (configOrientation)
      return [
        {
          end: configOrientation.valueRange.end,
          replacement: command.orientation,
          start: configOrientation.valueRange.start,
        },
      ];
    let insertion = header.range.end;
    while (
      insertion > header.range.start &&
      /[\t ]/.test(model.sourceDocument.source[insertion - 1] ?? "")
    )
      insertion -= 1;
    if (model.sourceDocument.source[insertion - 1] === ";") insertion -= 1;
    return [
      {
        end: insertion,
        replacement: ` ${command.orientation}`,
        start: insertion,
      },
    ];
  }
  if (command.type === "category.rename") {
    const record = recordById(model, model.xAxis.sourceRecordId);
    if (record?.kind !== "x-axis") return null;
    const category = model.xAxis.categories.find(
      (candidate) => candidate.id === command.categoryId,
    );
    const sourceCategory = record.categories.find(
      (candidate) => candidate.id === command.categoryId,
    );
    if (!category || !sourceCategory) return null;
    return [
      {
        end: sourceCategory.range.end,
        replacement: textSource(
          command.label.trim(),
          category.textForm,
          "quoted",
        ),
        start: sourceCategory.range.start,
      },
    ];
  }
  if (
    command.type === "category.add" ||
    command.type === "category.delete" ||
    command.type === "category.reorder"
  ) {
    const record = recordById(model, model.xAxis.sourceRecordId);
    if (
      record?.kind === "x-axis" &&
      record.form === "band" &&
      !(command.type === "category.delete" && record.categories.length === 1)
    ) {
      const entries = record.categories.map((category) =>
        model.sourceDocument.source.slice(
          category.range.start,
          category.range.end,
        ),
      );
      if (command.type === "category.add") {
        const index = command.afterCategoryId
          ? model.xAxis.categories.findIndex(
              (category) => category.id === command.afterCategoryId,
            ) + 1
          : entries.length;
        entries.splice(
          index,
          0,
          textSource(command.label.trim(), command.form, "quoted"),
        );
      } else {
        const index = model.xAxis.categories.findIndex(
          (category) => category.id === command.categoryId,
        );
        const [entry] = entries.splice(index, 1);
        if (command.type === "category.reorder" && entry !== undefined) {
          const remaining = model.xAxis.categories
            .map((category) => category.id)
            .filter((id) => id !== command.categoryId);
          const target = command.beforeCategoryId
            ? remaining.indexOf(command.beforeCategoryId)
            : entries.length;
          entries.splice(target < 0 ? entries.length : target, 0, entry);
        }
      }
      const patch = listBodyPatch(
        record,
        record.categories.map((category) => category.range),
        entries,
      );
      return patch ? [patch] : null;
    }
  }
  if (
    (command.type === "axis.title" && command.axis === "y") ||
    (command.type === "axis.range" && command.axis === "y")
  ) {
    const record = recordById(model, model.yAxis.sourceRecordId);
    if (record?.kind === "y-axis" && command.type === "axis.title") {
      const title = command.title.trim();
      if (record.titleRange) {
        let start = record.titleRange.start;
        if (!title) {
          while (
            start > record.range.start &&
            /[\t ]/.test(model.sourceDocument.source[start - 1] ?? "")
          )
            start -= 1;
        }
        return [
          {
            end: record.titleRange.end,
            replacement: title
              ? textSource(title, command.form ?? model.yAxis.titleForm)
              : "",
            start,
          },
        ];
      }
      if (title) {
        const keyword = /\by-axis\b/i.exec(record.raw);
        if (!keyword) return null;
        const insertion =
          record.range.start + keyword.index + keyword[0].length;
        return [
          {
            end: insertion,
            replacement: ` ${textSource(title, command.form)}`,
            start: insertion,
          },
        ];
      }
    }
    if (record?.kind === "y-axis" && command.type === "axis.range") {
      if (record.minimumRange && record.maximumRange) {
        if (command.automatic) {
          let start = record.minimumRange.start;
          while (
            start > record.range.start &&
            /[\t ]/.test(model.sourceDocument.source[start - 1] ?? "")
          )
            start -= 1;
          return [
            {
              end: record.maximumRange.end,
              replacement: "",
              start,
            },
          ];
        }
        return [
          {
            end: record.minimumRange.end,
            replacement: mermaidChartDecimal(command.minimum),
            start: record.minimumRange.start,
          },
          {
            end: record.maximumRange.end,
            replacement: mermaidChartDecimal(command.maximum),
            start: record.maximumRange.start,
          },
        ];
      }
      if (!command.automatic) {
        const insertion = record.inlineCommentRange?.start ?? record.range.end;
        return [
          {
            end: insertion,
            replacement: ` ${mermaidChartDecimal(command.minimum)} --> ${mermaidChartDecimal(command.maximum)}${record.inlineCommentRange ? " " : ""}`,
            start: insertion,
          },
        ];
      }
    }
    const state = { ...model.yAxis };
    if (command.type === "axis.title") {
      state.title = command.title.trim();
      state.titleForm = command.form ?? model.yAxis.titleForm;
    } else if (command.automatic) {
      state.rangeExplicit = false;
    } else {
      state.minimum = command.minimum;
      state.maximum = command.maximum;
      state.rangeExplicit = true;
    }
    const patch = replaceOrInsertAxis(model, "y", yAxisLine(state, record));
    return patch ? [patch] : null;
  }
  const record = recordById(model, model.xAxis.sourceRecordId);
  if (record?.kind === "x-axis" && command.type === "axis.title") {
    const title = command.title.trim();
    if (!title && record.form === "title-only")
      return [removeAxisRecordPatch(model, record)];
    if (record.titleRange) {
      let start = record.titleRange.start;
      if (!title) {
        while (
          start > record.range.start &&
          /[\t ]/.test(model.sourceDocument.source[start - 1] ?? "")
        )
          start -= 1;
      }
      return [
        {
          end: record.titleRange.end,
          replacement: title
            ? textSource(title, command.form ?? model.xAxis.titleForm)
            : "",
          start,
        },
      ];
    }
    if (title) {
      const keyword = /\bx-axis\b/i.exec(record.raw);
      if (!keyword) return null;
      const insertion = record.range.start + keyword.index + keyword[0].length;
      return [
        {
          end: insertion,
          replacement: ` ${textSource(title, command.form)}`,
          start: insertion,
        },
      ];
    }
  }
  if (
    record?.kind === "x-axis" &&
    record.form === "linear" &&
    command.type === "axis.range" &&
    record.minimumRange &&
    record.maximumRange
  )
    return [
      {
        end: record.minimumRange.end,
        replacement: mermaidChartDecimal(command.minimum),
        start: record.minimumRange.start,
      },
      {
        end: record.maximumRange.end,
        replacement: mermaidChartDecimal(command.maximum),
        start: record.maximumRange.start,
      },
    ];
  const state = {
    categories: model.xAxis.categories.map((category) => ({
      label: category.label,
      textForm: category.textForm,
    })),
    form: (model.xAxis.sourceForm === "omitted"
      ? "title-only"
      : model.xAxis.sourceForm) as "band" | "linear" | "title-only",
    maximum: model.xAxis.effectiveMaximum,
    minimum: model.xAxis.effectiveMinimum,
    title: model.xAxis.title,
    titleForm: model.xAxis.titleForm,
  };
  if (command.type === "axis.title") {
    state.title = command.title.trim();
    state.titleForm = command.form ?? state.titleForm;
  } else if (command.type === "axis.range") {
    state.form = "linear";
    state.minimum = command.minimum;
    state.maximum = command.maximum;
  } else if (command.type === "axis.x-model") {
    if (command.kind === "auto" && !state.title)
      return record?.kind === "x-axis"
        ? [removeAxisRecordPatch(model, record)]
        : null;
    state.form = command.kind === "auto" ? "title-only" : command.kind;
    if (command.kind === "band")
      state.categories = (command.categories ?? []).map((category) => ({
        label: category.label.trim(),
        textForm: category.form ?? "quoted",
      }));
  } else if (command.type === "category.add") {
    state.form = "band";
    const index = command.afterCategoryId
      ? model.xAxis.categories.findIndex(
          (item) => item.id === command.afterCategoryId,
        ) + 1
      : state.categories.length;
    state.categories.splice(index, 0, {
      label: command.label.trim(),
      textForm: command.form ?? "quoted",
    });
  } else {
    const index = model.xAxis.categories.findIndex(
      (item) => item.id === command.categoryId,
    );
    if (command.type === "category.delete") {
      state.categories.splice(index, 1);
      if (state.categories.length === 0) state.form = "title-only";
    } else {
      const [item] = state.categories.splice(index, 1);
      const target = command.beforeCategoryId
        ? model.xAxis.categories
            .filter((candidate) => candidate.id !== command.categoryId)
            .findIndex((candidate) => candidate.id === command.beforeCategoryId)
        : state.categories.length;
      state.categories.splice(
        target < 0 ? state.categories.length : target,
        0,
        item,
      );
    }
  }
  const patch = replaceOrInsertAxis(model, "x", xAxisLine(state, record));
  return patch ? [patch] : null;
}

function plotPatches(
  model: MermaidXyModel,
  command: MermaidXyPlotCommand,
): MermaidXySourcePatch[] | null {
  if (command.type === "plot.add") {
    const points = command.points.map((point, order) => ({
      id: `xy-draft-point-${order}`,
      label: point.label?.trim() ?? "",
      labelForm: point.labelForm,
      order,
      plotId: "xy-draft-plot",
      sourceFingerprint: "xy-draft-point",
      sourceRangeStart: -1,
      value: point.value,
    }));
    const line = plotLine({
      kind: command.kind,
      points,
      title: command.title?.trim() || command.kind,
      titleExplicit: Boolean(command.title?.trim()),
      titleForm: command.titleForm,
    });
    const anchor = command.afterPlotId
      ? trailingPlotRecord(model, command.afterPlotId)
      : [...model.sourceDocument.records]
          .reverse()
          .find((record) =>
            ["plot", "y-axis", "x-axis", "metadata", "header"].includes(
              record.kind,
            ),
          );
    return anchor ? [insertionAfter(model, anchor, line)] : null;
  }
  const { plot, record } = plotRecord(model, command.plotId);
  if (!plot || !record) return null;
  if (command.type === "plot.delete") {
    const commentPatches = model.comments.flatMap((comment) => {
      if (
        comment.anchor.kind !== "plot" ||
        comment.anchor.id !== plot.id ||
        comment.sourceRecordId === record.id
      )
        return [];
      const owner = recordById(model, comment.sourceRecordId);
      return owner && owner.kind === "comment"
        ? [deleteRecordPatch(model, owner)]
        : [];
    });
    return [deleteRecordPatch(model, record), ...commentPatches];
  }
  if (command.type === "plot.reorder") {
    const ownedCommentRecords = model.comments.flatMap((comment) => {
      if (
        comment.anchor.kind !== "plot" ||
        comment.anchor.id !== plot.id ||
        comment.sourceRecordId === record.id
      )
        return [];
      const owner = recordById(model, comment.sourceRecordId);
      return owner?.kind === "comment" ? [owner] : [];
    });
    const ownedRecords = [record, ...ownedCommentRecords].sort(
      (left, right) => left.range.start - right.range.start,
    );
    const owned = ownedRecords
      .map((owner) =>
        model.sourceDocument.source.slice(owner.range.start, owner.range.end),
      )
      .join(model.sourceDocument.newline);
    const deletions = ownedRecords.map((owner) =>
      deleteRecordPatch(model, owner),
    );
    const remaining = model.plots.filter(
      (candidate) => candidate.id !== plot.id,
    );
    const target = command.beforePlotId
      ? remaining.find((candidate) => candidate.id === command.beforePlotId)
      : undefined;
    const anchor = target
      ? leadingPlotRecord(model, target.id)
      : remaining.length
        ? trailingPlotRecord(model, remaining.at(-1)!.id)
        : [...model.sourceDocument.records]
            .reverse()
            .find((candidate) =>
              ["y-axis", "x-axis", "metadata", "header"].includes(
                candidate.kind,
              ),
            );
    if (!anchor) return null;
    return [
      ...deletions,
      target
        ? insertionBefore(model, anchor, owned)
        : insertionAfter(model, anchor, owned),
    ];
  }
  if (command.type === "plot.rename") {
    const title = command.title.trim();
    if (record.titleRange) {
      let start = record.titleRange.start;
      if (!title) {
        while (
          start > record.range.start &&
          /[\t ]/.test(model.sourceDocument.source[start - 1] ?? "")
        )
          start -= 1;
      }
      return [
        {
          end: record.titleRange.end,
          replacement: title
            ? textSource(title, command.titleForm ?? plot.titleForm, "quoted")
            : "",
          start,
        },
      ];
    }
    if (!title) return null;
    const bracket = record.raw.indexOf("[");
    if (bracket < 0) return null;
    return [
      {
        end: record.range.start + bracket,
        replacement: ` ${textSource(title, command.titleForm, "quoted")} `,
        start: record.range.start + bracket,
      },
    ];
  }
  if (command.type === "plot.title-form") {
    if (!record.titleRange || !plot.titleExplicit) return null;
    return [
      {
        end: record.titleRange.end,
        replacement: textSource(plot.title, command.titleForm, "quoted"),
        start: record.titleRange.start,
      },
    ];
  }
  const keyword = /\b(?:bar|line)\b/i.exec(record.raw);
  return keyword
    ? [
        {
          end: record.range.start + keyword.index + keyword[0].length,
          replacement: command.kind,
          start: record.range.start + keyword.index,
        },
      ]
    : null;
}

function pointPatches(
  model: MermaidXyModel,
  command: MermaidXyPointCommand,
): MermaidXySourcePatch[] | null {
  const found =
    command.type === "point.add"
      ? {
          plot: model.plots.find((plot) => plot.id === command.plotId),
          point: undefined,
        }
      : findMermaidXyPoint(model, command.pointId);
  if (!found?.plot) return null;
  const record = plotRecord(model, found.plot.id).record;
  if (!record || record.kind !== "plot") return null;
  if (command.type !== "point.add") {
    const sourcePoint = record.points.find(
      (point) => point.id === command.pointId,
    );
    if (!sourcePoint) return null;
    if (command.type === "point.value")
      return [
        {
          end: sourcePoint.valueRange.end,
          replacement: mermaidChartDecimal(command.value),
          start: sourcePoint.valueRange.start,
        },
      ];
    if (command.type === "point.label" || command.type === "point.label-form") {
      const point = found.point!;
      const label =
        command.type === "point.label" ? command.label.trim() : point.label;
      const form =
        command.type === "point.label-form"
          ? command.labelForm
          : (command.labelForm ?? point.labelForm ?? "plain");
      if (sourcePoint.labelRange) {
        let start = sourcePoint.labelRange.start;
        if (!label) {
          while (
            start > sourcePoint.valueRange.end &&
            /[\t ]/.test(model.sourceDocument.source[start - 1] ?? "")
          )
            start -= 1;
        }
        return [
          {
            end: sourcePoint.labelRange.end,
            replacement: label ? textSource(label, form, "plain") : "",
            start,
          },
        ];
      }
      return label
        ? [
            {
              end: sourcePoint.valueRange.end,
              replacement: ` ${textSource(label, form, "plain")}`,
              start: sourcePoint.valueRange.end,
            },
          ]
        : null;
    }
  }
  const next = {
    ...found.plot,
    points: found.plot.points.map((point) => ({ ...point })),
  };
  if (command.type === "point.add") {
    const index = command.afterPointId
      ? next.points.findIndex((point) => point.id === command.afterPointId) + 1
      : next.points.length;
    next.points.splice(index, 0, {
      id: "xy-draft-point",
      label: command.label?.trim() ?? "",
      labelForm: command.labelForm,
      order: index,
      plotId: next.id,
      sourceFingerprint: "xy-draft-point",
      sourceRangeStart: -1,
      value: command.value,
    });
  } else {
    const index = next.points.findIndex(
      (point) => point.id === command.pointId,
    );
    if (command.type === "point.delete") next.points.splice(index, 1);
    else {
      const [moved] = next.points.splice(index, 1);
      const target = command.beforePointId
        ? next.points.findIndex(
            (candidate) => candidate.id === command.beforePointId,
          )
        : next.points.length;
      next.points.splice(target < 0 ? next.points.length : target, 0, moved);
    }
  }
  next.points.forEach((point, order) => {
    point.order = order;
  });
  const rawById = new Map(
    record.points.map((point) => [
      point.id,
      model.sourceDocument.source.slice(point.range.start, point.range.end),
    ]),
  );
  const entries = next.points.map((point) =>
    point.id === "xy-draft-point"
      ? `${mermaidChartDecimal(point.value)}${point.label ? ` ${textSource(point.label, point.labelForm, "plain")}` : ""}`
      : (rawById.get(point.id) ?? ""),
  );
  const patch = listBodyPatch(
    record,
    record.points.map((point) => point.range),
    entries,
  );
  return patch ? [patch] : null;
}

function categoryStructuralPatches(
  model: MermaidXyModel,
  command: Extract<
    MermaidXyCategoryCommand,
    { type: "category.add" | "category.delete" | "category.reorder" }
  >,
) {
  const axis = axisPatches(model, command);
  if (!axis) return null;
  const categoryIndex =
    command.type === "category.add"
      ? command.afterCategoryId
        ? model.xAxis.categories.findIndex(
            (category) => category.id === command.afterCategoryId,
          ) + 1
        : model.xAxis.categories.length
      : model.xAxis.categories.findIndex(
          (category) => category.id === command.categoryId,
        );
  const patches = [...axis];
  for (const plot of model.plots) {
    const record = plotRecord(model, plot.id).record;
    if (!record || record.kind !== "plot") return null;
    const entries = record.points.map((point) =>
      model.sourceDocument.source.slice(point.range.start, point.range.end),
    );
    if (command.type === "category.add") {
      const value = command.values.find((entry) => entry.plotId === plot.id);
      if (!value) return null;
      entries.splice(
        categoryIndex,
        0,
        `${mermaidChartDecimal(value.value)}${value.label?.trim() ? ` ${textSource(value.label.trim(), value.labelForm, "plain")}` : ""}`,
      );
    } else if (command.type === "category.delete") {
      if (categoryIndex < entries.length) entries.splice(categoryIndex, 1);
    } else {
      const [point] = entries.splice(categoryIndex, 1);
      const remainingCategoryIds = model.xAxis.categories
        .map((category) => category.id)
        .filter((id) => id !== command.categoryId);
      const target = command.beforeCategoryId
        ? remainingCategoryIds.indexOf(command.beforeCategoryId)
        : remainingCategoryIds.length;
      if (point !== undefined)
        entries.splice(target < 0 ? entries.length : target, 0, point);
    }
    const patch = listBodyPatch(
      record,
      record.points.map((point) => point.range),
      entries,
    );
    if (!patch) return null;
    patches.push(patch);
  }
  return patches;
}

function flattenedConfig(config: MermaidXyConfig) {
  return [
    ...Object.entries(config).filter(
      ([field]) => field !== "xAxis" && field !== "yAxis",
    ),
    ...Object.entries(config.xAxis ?? {}).map(
      ([field, value]) => [`xAxis.${field}`, value] as const,
    ),
    ...Object.entries(config.yAxis ?? {}).map(
      ([field, value]) => [`yAxis.${field}`, value] as const,
    ),
  ];
}

function defaultConfigValue(field: string) {
  if (field.startsWith("xAxis."))
    return DEFAULT_MERMAID_XY_CONFIG.xAxis[
      field.slice(6) as keyof typeof DEFAULT_MERMAID_XY_CONFIG.xAxis
    ];
  if (field.startsWith("yAxis."))
    return DEFAULT_MERMAID_XY_CONFIG.yAxis[
      field.slice(6) as keyof typeof DEFAULT_MERMAID_XY_CONFIG.yAxis
    ];
  return DEFAULT_MERMAID_XY_CONFIG[
    field as keyof typeof DEFAULT_MERMAID_XY_CONFIG
  ];
}

function modelConfigValue(model: MermaidXyModel, field: string) {
  if (field.startsWith("xAxis."))
    return (
      model.config.xAxis?.[
        field.slice(6) as keyof NonNullable<MermaidXyConfig["xAxis"]>
      ] ?? defaultConfigValue(field)
    );
  if (field.startsWith("yAxis."))
    return (
      model.config.yAxis?.[
        field.slice(6) as keyof NonNullable<MermaidXyConfig["yAxis"]>
      ] ?? defaultConfigValue(field)
    );
  return (
    model.config[field as keyof Omit<MermaidXyConfig, "xAxis" | "yAxis">] ??
    defaultConfigValue(field)
  );
}

function configPatches(model: MermaidXyModel, config: MermaidXyConfig) {
  const existing = model.sourceDocument.records.flatMap((record) =>
    record.kind === "frontmatter" || record.kind === "directive"
      ? record.configFields.map((field) => ({ field, record }))
      : [],
  );
  const patches: MermaidXySourcePatch[] = [];
  const missing: Array<[string, unknown]> = [];
  for (const [field, value] of flattenedConfig(config)) {
    if (value === undefined) continue;
    if (value === modelConfigValue(model, field)) continue;
    const owner = [...existing]
      .reverse()
      .find((candidate) => candidate.field.field === field);
    if (owner)
      patches.push({
        end: owner.field.valueRange.end,
        replacement: String(value),
        start: owner.field.valueRange.start,
      });
    else missing.push([field, value]);
  }
  if (missing.length) {
    const header = model.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
    if (!header) return null;
    const rootEntries = missing
      .filter(([field]) => !field.includes("."))
      .map(([field, value]) => `"${field}": ${JSON.stringify(value)}`);
    const axisEntries = (["xAxis", "yAxis"] as const).flatMap((axis) => {
      const entries = missing
        .filter(([field]) => field.startsWith(`${axis}.`))
        .map(
          ([field, value]) =>
            `"${field.slice(axis.length + 1)}": ${JSON.stringify(value)}`,
        );
      return entries.length ? [`"${axis}": {${entries.join(", ")}}`] : [];
    });
    patches.push(
      insertionBefore(
        model,
        header,
        `%%{init: {"xyChart": {${[...rootEntries, ...axisEntries].join(", ")}}}}%%`,
      ),
    );
  }
  return patches;
}

function metadataPatch(
  model: MermaidXyModel,
  field: "accessibilityDescription" | "accessibilityTitle" | "title",
  value: string,
  form?: MermaidXyTextForm,
) {
  const record = [...model.sourceDocument.records]
    .reverse()
    .find(
      (candidate) => candidate.kind === "metadata" && candidate.field === field,
    );
  if (record?.kind === "metadata") {
    if (!value) return deleteRecordPatch(model, record);
    if (
      field === "accessibilityDescription" &&
      record.format === "line" &&
      value.includes("\n")
    ) {
      const indent = record.raw.match(/^\s*/)?.[0] ?? "";
      return {
        end: record.range.end,
        replacement: `${indent}accDescr {${model.sourceDocument.newline}${indent}  ${value.split("\n").join(`${model.sourceDocument.newline}${indent}  `)}${model.sourceDocument.newline}${indent}}`,
        start: record.range.start,
      };
    }
    const replacement =
      record.format === "block"
        ? `${model.sourceDocument.newline}    ${value.split("\n").join(`${model.sourceDocument.newline}    `)}${model.sourceDocument.newline}  `
        : field === "title"
          ? textSource(value, form ?? record.textForm, "plain")
          : value;
    return {
      end: record.valueRange.end,
      replacement,
      start: record.valueRange.start,
    };
  }
  if (!value) return null;
  const header = model.sourceDocument.records.find(
    (candidate) => candidate.kind === "header",
  );
  if (!header) return null;
  const line =
    field === "title"
      ? `  title ${textSource(value, form, "quoted")}`
      : field === "accessibilityTitle"
        ? `  accTitle: ${value}`
        : value.includes("\n")
          ? `  accDescr {${model.sourceDocument.newline}    ${value.split("\n").join(`${model.sourceDocument.newline}    `)}${model.sourceDocument.newline}  }`
          : `  accDescr: ${value}`;
  return insertionAfter(model, header, line);
}

function deleteMetadataPatches(
  model: MermaidXyModel,
  field: "accessibilityDescription" | "accessibilityTitle" | "title",
) {
  const patches = model.sourceDocument.records
    .flatMap((record) =>
      record.kind === "metadata" && record.field === field
        ? [deleteRecordPatch(model, record)]
        : [],
    )
    .sort((left, right) => left.start - right.start);
  return patches.reduce<MermaidXySourcePatch[]>((merged, patch) => {
    const previous = merged.at(-1);
    if (previous && patch.start <= previous.end) {
      previous.end = Math.max(previous.end, patch.end);
      return merged;
    }
    merged.push({ ...patch });
    return merged;
  }, []);
}

function coalesceDeletionPatches(patches: MermaidXySourcePatch[]) {
  return [...patches]
    .sort((left, right) => left.start - right.start)
    .reduce<MermaidXySourcePatch[]>((merged, patch) => {
      const previous = merged.at(-1);
      if (
        previous?.replacement === "" &&
        patch.replacement === "" &&
        patch.start <= previous.end
      ) {
        previous.end = Math.max(previous.end, patch.end);
        return merged;
      }
      merged.push({ ...patch });
      return merged;
    }, []);
}

function appearancePatches(
  model: MermaidXyModel,
  command: MermaidXyAppearanceCommand,
): MermaidXySourcePatch[] | null {
  if (command.type === "appearance.config")
    return configPatches(model, command.config);
  if (command.type === "diagram.title") {
    if (!command.title.trim()) return deleteMetadataPatches(model, "title");
    const patch = metadataPatch(
      model,
      "title",
      command.title.trim(),
      command.titleForm,
    );
    return patch ? [patch] : null;
  }
  const titlePatch =
    command.title.trim() === model.accessibilityTitle
      ? null
      : command.title.trim()
        ? metadataPatch(model, "accessibilityTitle", command.title.trim())
        : deleteMetadataPatches(model, "accessibilityTitle");
  const descriptionPatch =
    command.description.trim() === model.accessibilityDescription
      ? null
      : command.description.trim()
        ? metadataPatch(
            model,
            "accessibilityDescription",
            command.description.trim(),
          )
        : deleteMetadataPatches(model, "accessibilityDescription");
  return coalesceDeletionPatches(
    [titlePatch, descriptionPatch].flatMap((patch) =>
      Array.isArray(patch) ? patch : patch ? [patch] : [],
    ),
  );
}

function anchorRecord(model: MermaidXyModel, anchor: MermaidXyCommentAnchor) {
  if (anchor.kind === "diagram")
    return model.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
  if (anchor.kind === "plot") return plotRecord(model, anchor.id).record;
  if (anchor.kind === "x-axis")
    return recordById(model, model.xAxis.sourceRecordId);
  if (anchor.kind === "y-axis")
    return recordById(model, model.yAxis.sourceRecordId);
  return model.sourceDocument.records.find(
    (record) => record.kind === "metadata" && record.field === anchor.id,
  );
}

function commentPatches(
  model: MermaidXyModel,
  command: MermaidXyCommentCommand,
): MermaidXySourcePatch[] | null {
  if (command.type === "comment.add") {
    const anchor = anchorRecord(model, command.anchor);
    if (!anchor) return null;
    const line = `  %% ${command.text.trim()}`;
    return [
      command.position === "before"
        ? insertionBefore(model, anchor, line)
        : insertionAfter(model, anchor, line),
    ];
  }
  const comment = model.comments.find(
    (candidate) => candidate.id === command.commentId,
  );
  if (!comment) return null;
  const owner = recordById(model, comment.sourceRecordId);
  if (!owner) return null;
  if (command.type === "comment.delete") {
    if (owner.kind === "comment") return [deleteRecordPatch(model, owner)];
    if ("inlineCommentRange" in owner && owner.inlineCommentRange)
      return [
        {
          end: owner.inlineCommentRange.end,
          replacement: "",
          start:
            owner.inlineCommentRange.start > owner.range.start &&
            /[\t ]/.test(
              model.sourceDocument.source[owner.inlineCommentRange.start - 1] ??
                "",
            )
              ? owner.inlineCommentRange.start - 1
              : owner.inlineCommentRange.start,
        },
      ];
    return null;
  }
  if (owner.kind === "comment")
    return [
      {
        end: owner.range.end,
        replacement: `${owner.raw.match(/^\s*/)?.[0] ?? ""}%% ${command.text.trim()}`,
        start: owner.range.start,
      },
    ];
  if ("inlineCommentRange" in owner && owner.inlineCommentRange)
    return [
      {
        end: owner.inlineCommentRange.end,
        replacement: `%% ${command.text.trim()}`,
        start: owner.inlineCommentRange.start,
      },
    ];
  return null;
}

function commandPatches(model: MermaidXyModel, command: MermaidXyCommand) {
  if (
    command.type === "category.add" ||
    command.type === "category.delete" ||
    command.type === "category.reorder"
  )
    return categoryStructuralPatches(model, command);
  if (command.type.startsWith("axis.") || command.type.startsWith("category."))
    return axisPatches(
      model,
      command as MermaidXyAxisCommand | MermaidXyCategoryCommand,
    );
  if (command.type.startsWith("plot."))
    return plotPatches(model, command as MermaidXyPlotCommand);
  if (command.type.startsWith("point."))
    return pointPatches(model, command as MermaidXyPointCommand);
  if (command.type.startsWith("comment."))
    return commentPatches(model, command as MermaidXyCommentCommand);
  return appearancePatches(model, command as MermaidXyAppearanceCommand);
}

function resolvedSelection(
  previous: MermaidXyModel,
  next: MermaidXyModel,
  command: MermaidXyCommand,
  fallback: MermaidXyCommandSelection,
): MermaidXyCommandSelection {
  if (command.type === "plot.add") {
    const plot = next.plots.find(
      (candidate) => !previous.plots.some((old) => old.id === candidate.id),
    );
    return plot ? { id: plot.id, kind: "plot" as const } : fallback;
  }
  if (command.type === "point.add") {
    const previousPlot = previous.plots.find(
      (plot) => plot.id === command.plotId,
    );
    const nextPlot = next.plots.find((plot) => plot.id === command.plotId);
    const point = nextPlot?.points.find(
      (candidate) =>
        !previousPlot?.points.some((old) => old.id === candidate.id),
    );
    return point ? { id: point.id, kind: "point" as const } : fallback;
  }
  if (command.type === "category.add") {
    const category = next.xAxis.categories.find(
      (candidate) =>
        !previous.xAxis.categories.some((old) => old.id === candidate.id),
    );
    return category ? { id: category.id, kind: "category" as const } : fallback;
  }
  if (command.type === "plot.delete") {
    const deletedIndex = previous.plots.findIndex(
      (plot) => plot.id === command.plotId,
    );
    const target = next.plots[Math.min(deletedIndex, next.plots.length - 1)];
    return target
      ? { id: target.id, kind: "plot" as const }
      : { kind: "diagram" };
  }
  if (command.type === "point.delete") {
    const previousOwner = previous.plots.find((plot) =>
      plot.points.some((point) => point.id === command.pointId),
    );
    const deletedIndex =
      previousOwner?.points.findIndex(
        (point) => point.id === command.pointId,
      ) ?? -1;
    const nextOwner = next.plots.find((plot) => plot.id === previousOwner?.id);
    const target =
      nextOwner?.points[Math.min(deletedIndex, nextOwner.points.length - 1)];
    return target
      ? { id: target.id, kind: "point" as const }
      : nextOwner
        ? { id: nextOwner.id, kind: "plot" as const }
        : { kind: "diagram" };
  }
  if (command.type === "category.delete") {
    const deletedIndex = previous.xAxis.categories.findIndex(
      (category) => category.id === command.categoryId,
    );
    const target =
      next.xAxis.categories[
        Math.min(deletedIndex, next.xAxis.categories.length - 1)
      ];
    return target
      ? { id: target.id, kind: "category" as const }
      : { id: "xy-axis-x", kind: "x-axis" as const };
  }
  return fallback;
}

function uniqueModelId(model: MermaidXyModel, prefix: string) {
  const occupied = new Set([
    ...model.plots.map((plot) => plot.id),
    ...model.plots.flatMap((plot) => plot.points.map((point) => point.id)),
    ...model.xAxis.categories.map((category) => category.id),
    ...(model.identityArchive?.categories.map((category) => category.id) ?? []),
    ...(model.identityArchive?.plots.map((plot) => plot.id) ?? []),
    ...(model.identityArchive?.plots.flatMap((plot) =>
      plot.points.map((point) => point.id),
    ) ?? []),
  ]);
  let index = 1;
  while (occupied.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

/**
 * Reparse reconciles unchanged source anchors. The command supplies the only
 * unambiguous identity information for insertion, deletion and reorder, so it
 * restores those identities before React receives the next projection.
 */
function restoreCommandIdentities(
  previous: MermaidXyModel,
  next: MermaidXyModel,
  command: MermaidXyCommand,
) {
  const previousPlotIds = previous.plots.map((plot) => plot.id);
  let plotIds = [...previousPlotIds];
  if (command.type === "plot.add") {
    const anchor = command.afterPlotId
      ? previousPlotIds.indexOf(command.afterPlotId) + 1
      : previousPlotIds.length;
    plotIds.splice(anchor, 0, uniqueModelId(next, "xy-plot"));
  } else if (command.type === "plot.delete") {
    plotIds = plotIds.filter((id) => id !== command.plotId);
  } else if (command.type === "plot.reorder") {
    plotIds = plotIds.filter((id) => id !== command.plotId);
    const target = command.beforePlotId
      ? plotIds.indexOf(command.beforePlotId)
      : plotIds.length;
    plotIds.splice(target < 0 ? plotIds.length : target, 0, command.plotId);
  }
  next.plots.forEach((plot, order) => {
    plot.id = plotIds[order] ?? plot.id;
    plot.order = order;
  });

  for (const nextPlot of next.plots) {
    const oldPlot = previous.plots.find((plot) => plot.id === nextPlot.id);
    let pointIds = oldPlot?.points.map((point) => point.id) ?? [];
    if (command.type === "point.add" && command.plotId === nextPlot.id) {
      const anchor = command.afterPointId
        ? pointIds.indexOf(command.afterPointId) + 1
        : pointIds.length;
      pointIds.splice(anchor, 0, uniqueModelId(next, `${nextPlot.id}-point`));
    } else if (command.type === "point.delete") {
      pointIds = pointIds.filter((id) => id !== command.pointId);
    } else if (
      command.type === "point.reorder" &&
      oldPlot?.points.some((point) => point.id === command.pointId)
    ) {
      pointIds = pointIds.filter((id) => id !== command.pointId);
      const target = command.beforePointId
        ? pointIds.indexOf(command.beforePointId)
        : pointIds.length;
      pointIds.splice(
        target < 0 ? pointIds.length : target,
        0,
        command.pointId,
      );
    } else if (command.type === "category.add") {
      const anchor = command.afterCategoryId
        ? previous.xAxis.categories.findIndex(
            (category) => category.id === command.afterCategoryId,
          ) + 1
        : previous.xAxis.categories.length;
      pointIds.splice(anchor, 0, uniqueModelId(next, `${nextPlot.id}-point`));
    } else if (command.type === "category.delete") {
      const index = previous.xAxis.categories.findIndex(
        (category) => category.id === command.categoryId,
      );
      if (index < pointIds.length) pointIds.splice(index, 1);
    } else if (command.type === "category.reorder") {
      const index = previous.xAxis.categories.findIndex(
        (category) => category.id === command.categoryId,
      );
      const [pointId] = pointIds.splice(index, 1);
      const remaining = previous.xAxis.categories
        .map((category) => category.id)
        .filter((id) => id !== command.categoryId);
      const target = command.beforeCategoryId
        ? remaining.indexOf(command.beforeCategoryId)
        : remaining.length;
      if (pointId)
        pointIds.splice(target < 0 ? pointIds.length : target, 0, pointId);
    }
    nextPlot.points.forEach((point, order) => {
      point.id = pointIds[order] ?? point.id;
      point.order = order;
      point.plotId = nextPlot.id;
    });
    const record = next.sourceDocument.records.find(
      (candidate) => candidate.id === nextPlot.sourceRecordId,
    );
    if (record?.kind === "plot") {
      record.plotId = nextPlot.id;
      record.points.forEach((point, order) => {
        point.id = nextPlot.points[order]?.id;
      });
    }
  }

  let categoryIds = previous.xAxis.categories.map((category) => category.id);
  if (command.type === "category.add") {
    const anchor = command.afterCategoryId
      ? categoryIds.indexOf(command.afterCategoryId) + 1
      : categoryIds.length;
    categoryIds.splice(anchor, 0, uniqueModelId(next, "xy-category"));
  } else if (command.type === "category.delete") {
    categoryIds = categoryIds.filter((id) => id !== command.categoryId);
  } else if (command.type === "category.reorder") {
    categoryIds = categoryIds.filter((id) => id !== command.categoryId);
    const target = command.beforeCategoryId
      ? categoryIds.indexOf(command.beforeCategoryId)
      : categoryIds.length;
    categoryIds.splice(
      target < 0 ? categoryIds.length : target,
      0,
      command.categoryId,
    );
  }
  next.xAxis.categories.forEach((category, order) => {
    category.id = categoryIds[order] ?? category.id;
    category.order = order;
  });
  const xRecord = recordById(next, next.xAxis.sourceRecordId);
  if (xRecord?.kind === "x-axis") {
    xRecord.categories.forEach((category, order) => {
      category.id = next.xAxis.categories[order]?.id;
    });
  }
}

export function applyMermaidXySourceCommand(
  input: MermaidXySourceApplyInput,
): MermaidXySourceApplyResult {
  if (input.readonly) return unchanged(input, "xy.readonly");
  if (
    input.source !== input.previousModel.sourceDocument.source ||
    (input.baseSourceHash &&
      input.baseSourceHash !== input.previousModel.sourceHash)
  )
    return unchanged(input, "xy.stale-source");
  const validation = validate(input.previousModel, input.command);
  if (!validation.valid)
    return unchanged(input, validation.code, validation.selectionAfter);
  const patches = commandPatches(input.previousModel, input.command);
  if (!patches?.length)
    return unchanged(input, "xy.patch-unavailable", validation.selectionAfter);
  const source = applyPatches(input.source, patches);
  if (source === null || source === input.source)
    return unchanged(
      input,
      source === null ? "xy.patch-overlap" : "xy.no-change",
      validation.selectionAfter,
    );
  const model = parseMermaidXySource(source, input.previousModel);
  if (!model)
    return unchanged(input, "xy.reparse-failed", validation.selectionAfter);
  const previousErrors = new Set(
    input.previousModel.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map(
        (diagnostic) =>
          `${diagnostic.code}:${diagnostic.recordId ?? ""}:${diagnostic.role}`,
      ),
  );
  if (
    model.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        !previousErrors.has(
          `${diagnostic.code}:${diagnostic.recordId ?? ""}:${diagnostic.role}`,
        ),
    )
  )
    return unchanged(input, "xy.reparse-failed", validation.selectionAfter);
  restoreCommandIdentities(input.previousModel, model, input.command);
  refreshMermaidXyIdentityArchive(model);
  return {
    changed: true,
    command: input.command,
    diagnosis: { code: "xy.ok" },
    model,
    patches,
    selectionAfter: resolvedSelection(
      input.previousModel,
      model,
      input.command,
      validation.selectionAfter,
    ),
    source,
  };
}
