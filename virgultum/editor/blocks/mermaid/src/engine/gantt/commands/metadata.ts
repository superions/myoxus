// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ganttAppendAtEnd,
  ganttDeleteStatement,
  ganttInsertAfter,
  ganttNoChange,
  ganttPatchedResult,
  ganttReplaceStatement,
  type GanttCommandResult,
} from "../writer.js";
import type { GanttOptionName } from "../source-document.js";
import type { MermaidGanttModel } from "../types.js";
import { ganttConfigPatches, isGanttConfigField } from "../config.js";

type GanttOptionOccurrence = {
  /** Concrete statement; omitted only when editing the effective projection. */
  readonly statementId?: string;
};

export type GanttMetadataField = "title" | "accTitle" | "accDescr";

export type GanttMetadataCommand =
  | {
      readonly type: "metadata.set";
      readonly field: GanttMetadataField;
      readonly value: string;
    }
  | { readonly type: "metadata.remove"; readonly field: GanttMetadataField }
  | ({
      readonly type: "option.set";
      readonly name: GanttOptionName;
      readonly value: string;
    } & GanttOptionOccurrence)
  | ({
      readonly type: "option.remove";
      readonly name: GanttOptionName;
    } & GanttOptionOccurrence)
  | {
      readonly type: "click.set";
      /** Omitted for creation; edits address exactly one concrete statement. */
      readonly clickId?: string;
      readonly taskRecordId: string;
      readonly kind: "click" | "href";
      readonly callbackOrUrl: string;
      /** Argument values, without Mermaid quoting or call syntax. */
      readonly args?: readonly string[];
      readonly tooltip?: string | null;
    }
  | { readonly type: "click.remove"; readonly clickId: string };

/** Mermaid passes argument strings, stripping only their surrounding quotes. */
export function ganttClickArgumentValue(lexeme: string) {
  return lexeme.startsWith('"') && lexeme.endsWith('"')
    ? lexeme.slice(1, -1)
    : lexeme;
}

export function ganttClickBindingError(
  kind: "click" | "href",
  value: string,
  args: readonly string[],
) {
  if (
    !value.trim() ||
    /[\r\n"]/.test(value) ||
    (kind === "click" && !/^[\w.$]+$/.test(value))
  )
    return "target";
  if (kind === "click" && args.some((arg) => /[\r\n)"]/.test(arg)))
    return "argument";
  return null;
}

const STATEMENT_KIND_BY_FIELD: Record<GanttMetadataField, string> = {
  accDescr: "accessibility-description",
  accTitle: "accessibility-title",
  title: "title",
};

function statementForField(
  model: MermaidGanttModel,
  field: GanttMetadataField,
) {
  return (
    model.sourceDocument.statements.findLast(
      (statement) => statement.kind === STATEMENT_KIND_BY_FIELD[field],
    ) ?? null
  );
}

function encodeMetadataLine(field: GanttMetadataField, value: string) {
  if (field === "title") return `title ${value}`;
  if (field === "accTitle") return `accTitle: ${value}`;
  return value.includes("\n")
    ? `accDescr {\n${value
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}\n}`
    : `accDescr: ${value}`;
}

export function applyGanttMetadataCommand(input: {
  readonly model: MermaidGanttModel;
  readonly readonly: boolean;
  readonly command: GanttMetadataCommand;
}): GanttCommandResult {
  const { command, model, readonly } = input;
  if (readonly) return ganttNoChange(model, "readonly");
  switch (command.type) {
    case "metadata.set": {
      const value = command.value.trim();
      if (!value) return ganttNoChange(model, "invalid-label");
      const existing = statementForField(model, command.field);
      const patch = existing
        ? ganttReplaceStatement(
            model,
            existing.id,
            `${existing.indent}${encodeMetadataLine(command.field, value)}`,
          )
        : ganttAppendAtEnd(model, encodeMetadataLine(command.field, value));
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "metadata.remove": {
      const existing = statementForField(model, command.field);
      if (!existing) return ganttNoChange(model, "no-change");
      const patch = ganttDeleteStatement(model, existing.id);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "option.set": {
      if (/[\r\n]/.test(command.value))
        return ganttNoChange(model, "unsupported-option");
      if (
        command.name === "tickInterval" &&
        !/^[1-9]\d*(millisecond|second|minute|hour|day|week|month)$/.test(
          command.value,
        )
      )
        return ganttNoChange(model, "unsupported-option");
      if (
        (command.name === "topAxis" || command.name === "inclusiveEndDates") &&
        command.value.trim()
      )
        return ganttNoChange(model, "unsupported-option");
      if (isGanttConfigField(command.name)) {
        if (
          command.name === "useMaxWidth" &&
          !["", "true", "false"].includes(command.value)
        )
          return ganttNoChange(model, "unsupported-option");
        const value =
          command.name === "displayMode"
            ? command.value
            : command.name === "useMaxWidth"
              ? command.value !== "false"
              : Number(command.value);
        if (
          typeof value === "number" &&
          (!command.value.trim() ||
            !Number.isFinite(value) ||
            value < 0 ||
            ([
              "useWidth",
              "barHeight",
              "fontSize",
              "sectionFontSize",
              "numberSectionStyles",
            ].includes(command.name) &&
              value === 0) ||
            (command.name === "numberSectionStyles" &&
              !Number.isInteger(value)))
        )
          return ganttNoChange(model, "unsupported-option");
        if (
          command.name === "displayMode" &&
          value !== "" &&
          value !== "compact"
        )
          return ganttNoChange(model, "unsupported-option");
        const patches = ganttConfigPatches(
          model.sourceDocument,
          command.name,
          value,
          command.statementId
            ? { statementId: command.statementId }
            : undefined,
        );
        return patches
          ? ganttPatchedResult(model, patches, null)
          : ganttNoChange(model, "conflict");
      }
      if (command.statementId) {
        const statement = model.sourceDocument.statements.find(
          (item) =>
            item.id === command.statementId &&
            item.kind === "option" &&
            item.optionName === command.name,
        );
        if (!statement) return ganttNoChange(model, "conflict");
        const value = command.value.trim();
        const patch =
          value ||
          command.name === "inclusiveEndDates" ||
          command.name === "topAxis"
            ? ganttReplaceStatement(
                model,
                statement.id,
                `${statement.indent}${command.name} ${value}`.trimEnd(),
              )
            : ganttDeleteStatement(model, statement.id);
        return patch
          ? ganttPatchedResult(model, [patch], null)
          : ganttNoChange(model, "conflict");
      }
      if (command.name === "includes" || command.name === "excludes") {
        const name = command.name;
        const desired = command.value
          .toLowerCase()
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        const old = model.calendar[name].flatMap((value) =>
          value.toLowerCase().split(/[\s,]+/),
        );
        const added = desired.filter((value) => !old.includes(value));
        const instances = model.sourceDocument.statements.filter(
          (statement) =>
            statement.kind === "option" && statement.optionName === name,
        );
        if (!instances.length)
          return desired.length
            ? ganttPatchedResult(
                model,
                [ganttAppendAtEnd(model, `${name} ${desired.join(",")}`)],
                null,
              )
            : ganttNoChange(model, "no-change");
        // Calendar lists are additive statements, not singletons. Apply only
        // the edited membership to each instance; never duplicate the combined
        // list into one statement or silently collapse untouched instances.
        const patches = instances.flatMap((statement, index) => {
          const current = statement.raw
            .trim()
            .slice(name.length)
            .trim()
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean);
          const next = current.filter((value) =>
            desired.includes(value.toLowerCase()),
          );
          if (index === instances.length - 1) next.push(...added);
          if (next.join(",") === current.join(",")) return [];
          const patch = next.length
            ? ganttReplaceStatement(
                model,
                statement.id,
                `${statement.indent}${name} ${next.join(",")}`,
              )
            : ganttDeleteStatement(model, statement.id);
          return patch ? [patch] : [];
        });
        return ganttPatchedResult(model, patches, null);
      }
      const existing = model.sourceDocument.statements.findLast(
        (statement) =>
          statement.kind === "option" && statement.optionName === command.name,
      );
      const line = `${command.name} ${command.value}`.trim();
      const patch = existing
        ? ganttReplaceStatement(model, existing.id, `${existing.indent}${line}`)
        : ganttAppendAtEnd(model, line);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "option.remove": {
      if (isGanttConfigField(command.name)) {
        const patches = ganttConfigPatches(
          model.sourceDocument,
          command.name,
          undefined,
          command.statementId
            ? { statementId: command.statementId }
            : undefined,
        );
        return patches
          ? ganttPatchedResult(model, patches, null)
          : ganttNoChange(model, "conflict");
      }
      const existing = model.sourceDocument.statements.findLast(
        (statement) =>
          statement.kind === "option" &&
          statement.optionName === command.name &&
          (!command.statementId || statement.id === command.statementId),
      );
      if (!existing)
        return ganttNoChange(
          model,
          command.statementId ? "conflict" : "no-change",
        );
      const patch = ganttDeleteStatement(model, existing.id);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "click.set": {
      const task = model.tasks.find(
        (candidate) => candidate.recordId === command.taskRecordId,
      );
      if (!task) return ganttNoChange(model, "unknown-task");
      if (
        model.tasks.filter((candidate) => candidate.id === task.id).length !== 1
      )
        return ganttNoChange(model, "ambiguous-source");
      const existing = command.clickId
        ? model.clicks.find((click) => click.id === command.clickId)
        : null;
      if (command.clickId && (!existing || existing.targetTaskId !== task.id))
        return ganttNoChange(model, "conflict");
      const values = command.kind === "href" ? [] : [...(command.args ?? [])];
      if (
        command.tooltip ||
        ganttClickBindingError(command.kind, command.callbackOrUrl, values)
      )
        return ganttNoChange(model, "invalid-label");
      if (
        existing &&
        existing.kind === command.kind &&
        existing.callbackOrUrl === command.callbackOrUrl &&
        JSON.stringify(existing.args.map(ganttClickArgumentValue)) ===
          JSON.stringify(values)
      )
        return ganttNoChange(model, "no-change");
      // Unchanged arguments retain their authored lexemes and order. Only a
      // changed value receives quotes; other bindings are never reconstructed.
      const args = values
        .map((value, index) =>
          existing?.args[index] !== undefined &&
          ganttClickArgumentValue(existing.args[index]) === value
            ? existing.args[index]
            : `"${value}"`,
        )
        .join(", ");
      const line =
        command.kind === "href"
          ? `click ${task.id} href "${command.callbackOrUrl}"`
          : `click ${task.id} call ${command.callbackOrUrl}(${args})`;
      const statement = existing
        ? model.sourceDocument.statements.find(
            (item) => item.id === existing.recordId,
          )
        : null;
      const patch =
        existing && statement
          ? ganttReplaceStatement(
              model,
              existing.recordId,
              `${statement.indent}${line}`,
            )
          : ganttInsertAfter(model, task.recordId, line);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "click.remove": {
      const click = model.clicks.find(
        (candidate) => candidate.id === command.clickId,
      );
      if (!click) return ganttNoChange(model, "unknown-click");
      const patch = ganttDeleteStatement(model, click.recordId);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
  }
}
