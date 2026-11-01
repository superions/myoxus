// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../utils.js";
import { readGanttConfig } from "./config.js";
import {
  detectMermaidDiagramType,
  getMermaidSourceHeaderIndex,
} from "../diagram-types.js";
import {
  ganttAfterLine,
  type GanttRange,
  type GanttSourceDocument,
  type GanttSourceStatement,
  scanGanttSource,
} from "./source-document.js";
import {
  parseGanttDateValue,
  resolveGanttCalendar,
  resolveGanttTaskIntervals,
} from "./schedule.js";
import {
  GANTT_STATUS_TOKENS,
  type GanttClickBinding,
  type GanttComment,
  type GanttDiagnostic,
  type GanttScheduleKind,
  type MermaidGanttModel,
  type MermaidGanttSection,
  type MermaidGanttTask,
  isMermaidGanttTaskLabel,
} from "./types.js";

const TASK_ID_RE = /^[\w-]+$/;

type ParsedTaskParts = {
  idRange: GanttRange | null;
  afterIds: string[];
  untilIds: string[];
  duration: string;
  end: string;
  explicitId: boolean;
  id: string;
  isMilestone: boolean;
  isVert: boolean;
  scheduleKind: GanttScheduleKind;
  start: string;
  statuses: string[];
  diagnostics: GanttDiagnostic[];
};

function rangeOf(statement: GanttSourceStatement): GanttRange {
  return statement.range;
}

function localDiagnostic(
  statement: GanttSourceStatement,
  code: GanttDiagnostic["code"],
  message: string,
  field?: GanttDiagnostic["field"],
): GanttDiagnostic {
  return {
    code,
    field,
    message,
    range: rangeOf(statement),
    statementId: statement.id,
  };
}

function splitTaskParts(rawParts: string) {
  return rawParts.split(",").map((part) => part.trim());
}

function parseClickStatement(
  statement: GanttSourceStatement,
): GanttClickBinding | null {
  const trimmed = statement.raw.trim();
  // Gantt's href is part of a click statement, not a standalone directive or
  // the final quoted tooltip understood by other Mermaid diagram families.
  const href = /^click\s+(\S+)\s+href\s+"([^"\r\n]*)"\s*$/i.exec(trimmed);
  if (href)
    return {
      args: [],
      callCallback: false,
      callbackOrUrl: href[2]!,
      id: statement.id,
      kind: "href",
      recordId: statement.id,
      targetTaskId: TASK_ID_RE.test(href[1]!) ? href[1]! : null,
      tooltip: null,
    };
  const match = /^(click|href)\s+(.+)$/i.exec(trimmed);
  if (!match) return null;
  const kind = match[1].toLowerCase() as "click" | "href";
  const rest = match[2];
  const tooltipMatch = /\s+"([^"]*)"\s*$/.exec(rest);
  const tooltip = tooltipMatch ? tooltipMatch[1] : null;
  const body = tooltipMatch ? rest.slice(0, tooltipMatch.index) : rest;
  const tokens = body.split(/\s+/).filter(Boolean);
  const [targetTaskId, ...remainder] = tokens;
  if (!targetTaskId) return null;
  if (kind === "href") {
    return {
      args: [],
      callCallback: false,
      callbackOrUrl: remainder.join(" "),
      id: statement.id,
      kind,
      recordId: statement.id,
      targetTaskId: TASK_ID_RE.test(targetTaskId) ? targetTaskId : null,
      tooltip,
    };
  }
  const callMatch = /^call\s+([\w.$]+)\((.*)\)$/.exec(remainder.join(" "));
  if (callMatch) {
    const args = callMatch[2]
      .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
      .map((arg) => arg.trim())
      .filter(Boolean);
    return {
      args,
      callCallback: true,
      callbackOrUrl: callMatch[1],
      id: statement.id,
      kind,
      recordId: statement.id,
      targetTaskId: TASK_ID_RE.test(targetTaskId) ? targetTaskId : null,
      tooltip,
    };
  }
  const [callbackOrUrl, ...args] = remainder;
  return {
    args,
    callCallback: false,
    callbackOrUrl: callbackOrUrl ?? "",
    id: statement.id,
    kind,
    recordId: statement.id,
    targetTaskId: TASK_ID_RE.test(targetTaskId) ? targetTaskId : null,
    tooltip,
  };
}

function parseTaskStatement(
  statement: GanttSourceStatement,
  fallbackId: string,
  previousTaskId: string | undefined,
  dateFormat: string,
): {
  label: string;
  labelRange: GanttRange;
  parts: ParsedTaskParts;
} | null {
  const trimmed = statement.raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return null;
  const label = trimmed.slice(0, colon).trim();
  const parts: ParsedTaskParts = {
    idRange: null,
    afterIds: [],
    diagnostics: [],
    duration: "",
    end: "",
    explicitId: false,
    id: fallbackId,
    isMilestone: false,
    isVert: false,
    scheduleKind: "none",
    start: "",
    statuses: [],
    untilIds: [],
  };
  const labelStart = statement.range.start + statement.indent.length;
  const labelRange: GanttRange = {
    end: labelStart + label.length,
    endLine: statement.range.line,
    line: statement.range.line,
    start: labelStart,
  };
  if (!isMermaidGanttTaskLabel(label)) {
    parts.diagnostics.push(
      localDiagnostic(
        statement,
        "unknown-statement",
        `Task label "${label}" collides with a Gantt keyword.`,
        "label",
      ),
    );
  }
  const allParts = splitTaskParts(trimmed.slice(colon + 1));
  const statusesAndShapes = allParts.filter(
    (part) =>
      (GANTT_STATUS_TOKENS as readonly string[]).includes(part) ||
      part === "milestone" ||
      part === "vert",
  );
  for (const token of statusesAndShapes) {
    if ((GANTT_STATUS_TOKENS as readonly string[]).includes(token))
      parts.statuses.push(token);
    else if (token === "milestone") parts.isMilestone = true;
    else parts.isVert = true;
  }
  const remaining = allParts.filter(
    (part) => !statusesAndShapes.includes(part),
  );

  const isScheduleToken = (token: string) =>
    token.startsWith("after ") ||
    token.startsWith("until ") ||
    /^\d+(\.\d+)?\s*(ms|s|m|h|d|w|M|y)$/.test(token) ||
    parseGanttDateValue(token, dateFormat) !== null;

  let scheduleTokens = [...remaining];
  if (scheduleTokens.length && !isScheduleToken(scheduleTokens[0]!)) {
    const [candidate, ...rest] = scheduleTokens;
    if (!TASK_ID_RE.test(candidate!)) {
      parts.diagnostics.push(
        localDiagnostic(
          statement,
          "missing-id",
          `Task id "${candidate}" cannot be referenced.`,
          "id",
        ),
      );
    }
    parts.id = candidate!;
    parts.explicitId = true;
    const dataStart = statement.raw.indexOf(":") + 1;
    // IDs are whole data tokens: `a` must not match the `a` in `active`.
    let relative = dataStart;
    for (const token of statement.raw.slice(dataStart).split(",")) {
      if (token.trim() === candidate) {
        const start =
          statement.range.start +
          relative +
          token.length -
          token.trimStart().length;
        parts.idRange = {
          start,
          end: start + candidate!.length,
          endLine: statement.range.line,
          line: statement.range.line,
        };
        break;
      }
      relative += token.length + 1;
    }
    scheduleTokens = rest;
  }
  // Mermaid accepts the data list in a fixed order but omits the id freely, so
  // the schedule clauses are classified by form instead of by position.
  let startToken = "";
  let endToken = "";
  const dataTokens = scheduleTokens;
  if (dataTokens.length === 1) {
    if (dataTokens[0]!.startsWith("after ")) {
      // `Ship : s1, after p1` has no end anchor at all, so the single clause is
      // the start and Mermaid derives a zero-length bar.
      startToken = dataTokens[0]!;
    } else {
      endToken = dataTokens[0]!;
      if (previousTaskId) parts.scheduleKind = "previous";
    }
  } else if (dataTokens.length === 2) {
    if (dataTokens[0]!.startsWith("after ")) {
      startToken = dataTokens[0]!;
      endToken = dataTokens[1]!;
    } else {
      [startToken, endToken] = dataTokens as [string, string];
    }
  } else if (dataTokens.length > 2) {
    parts.diagnostics.push(
      localDiagnostic(
        statement,
        "invalid-schedule",
        `Unexpected task data "${dataTokens.join(", ")}".`,
        "schedule",
      ),
    );
  }

  if (startToken) {
    if (startToken.startsWith("after ")) {
      parts.scheduleKind = "after";
      parts.afterIds = startToken
        .slice("after ".length)
        .split(/\s+/)
        .filter(Boolean);
      parts.start = startToken;
    } else {
      parts.scheduleKind =
        parts.scheduleKind === "previous" ? "previous" : "explicit";
      parts.start = startToken;
    }
  }
  if (endToken) {
    if (endToken.startsWith("until ")) {
      parts.untilIds = endToken
        .slice("until ".length)
        .split(/\s+/)
        .filter(Boolean);
      parts.scheduleKind =
        parts.scheduleKind === "none" ? "until" : parts.scheduleKind;
      if (parts.scheduleKind === "until" && !parts.start) {
        parts.diagnostics.push(
          localDiagnostic(
            statement,
            "invalid-schedule",
            "until requires an explicit start value.",
            "schedule",
          ),
        );
      }
    } else if (/^\d+(\.\d+)?\s*(ms|s|m|h|d|w|M|y)$/.test(endToken)) {
      parts.duration = endToken;
    } else {
      parts.end = endToken;
    }
  }
  return { label, labelRange, parts };
}

/**
 * Reconciles edit-session identity across reparses. Explicit command mappings
 * win; otherwise a statement keeps its previous identity only when its range
 * or its unchanged raw text is unique, so renames, reorders and insertions
 * never move an open popover or selection onto another object.
 */
export function reconcileGanttSource(
  document: GanttSourceDocument,
  previous?: GanttSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  const available = new Map(
    (previous?.statements ?? []).map((statement) => [statement.id, statement]),
  );
  const assigned = new Set<string>();
  // Reserve all explicit destinations before scanning. A newly inserted row
  // can occupy an old row's offset without owning that row's mapped identity.
  const reserved = new Set(mapping?.values());
  // External source edits have no command mapping. Reserve uniquely unchanged
  // records for their own new statement before range-based rename fallback.
  const rawOwners = new Map<string, string>();
  for (const statement of document.statements) {
    if (mapping?.has(statement.range.start)) continue;
    const oldMatches = [...available.values()].filter(
      (candidate) =>
        !reserved.has(candidate.id) &&
        candidate.kind === statement.kind &&
        candidate.raw === statement.raw,
    );
    if (
      oldMatches.length === 1 &&
      document.statements.filter(
        (candidate) =>
          candidate.kind === statement.kind && candidate.raw === statement.raw,
      ).length === 1
    )
      rawOwners.set(oldMatches[0]!.id, statement.id);
  }
  const conflicts: string[] = [];
  const unchanged = document.source === previous?.source;
  const statements = document.statements.map((statement) => {
    const mappedId = mapping?.get(statement.range.start);
    const mapped = mappedId ? available.get(mappedId) : undefined;
    const exact = [...available.values()].filter(
      (candidate) =>
        !reserved.has(candidate.id) &&
        (!rawOwners.has(candidate.id) ||
          rawOwners.get(candidate.id) === statement.id) &&
        candidate.kind === statement.kind &&
        candidate.raw === statement.raw,
    );
    const sameRange = [...available.values()].filter(
      (candidate) =>
        !reserved.has(candidate.id) &&
        (!rawOwners.has(candidate.id) ||
          rawOwners.get(candidate.id) === statement.id) &&
        candidate.kind === statement.kind &&
        candidate.range.start === statement.range.start,
    );
    if (mappedId && !mapped) {
      if (assigned.has(mappedId)) {
        conflicts.push(mappedId);
        return statement;
      }
      assigned.add(mappedId);
      return { ...statement, id: mappedId };
    }
    const candidate =
      mapped ??
      (exact.length === 1
        ? exact[0]
        : sameRange.length === 1 && (exact.length === 0 || unchanged)
          ? sameRange[0]
          : undefined);
    if (!candidate) {
      if (exact.length > 1) conflicts.push(statement.id);
      return statement;
    }
    available.delete(candidate.id);
    assigned.add(candidate.id);
    return { ...statement, id: candidate.id };
  });
  return { conflicts, document: { ...document, statements } };
}

function readOptionValue(raw: string, name: string) {
  return raw.trim().slice(name.length).trim();
}

/**
 * Mermaid accepts valueless boolean statements (`inclusiveEndDates`, `topAxis`)
 * as enabled, so an empty value is a real source form and not a missing value.
 */
function parseBooleanOption(value: string): boolean | null {
  if (!value.trim()) return true;
  return null;
}

/**
 * Parses Gantt source into the visual model. Local defects stay local: every
 * readable section, task, comment and option is projected with its own
 * diagnosis, and only a genuinely ambiguous document is flagged as such.
 */
export function parseMermaidGanttSource(
  source: string,
  previous?: MermaidGanttModel,
  mapping?: ReadonlyMap<number, string>,
): MermaidGanttModel | null {
  if (detectMermaidDiagramType(source) !== "gantt") return null;
  const headerIndex = getMermaidSourceHeaderIndex(source);
  if (headerIndex < 0) return null;
  const scanned = scanGanttSource(source);
  const previousDocument =
    previous?.sourceDocument.source === source
      ? previous.sourceDocument
      : previous?.sourceDocument;
  const reconciled = reconcileGanttSource(
    scanned,
    previousDocument && previousDocument.source !== source
      ? previousDocument
      : previousDocument,
    mapping,
  );
  const document = reconciled.document;
  const diagnostics: GanttDiagnostic[] = [];
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const frontMatterEnd =
    lines[0]?.trim() === "---"
      ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
      : -1;
  if (
    lines
      .slice(frontMatterEnd + 1, headerIndex)
      .some((line) => line.trim() && !line.trim().startsWith("%"))
  ) {
    return null;
  }

  const headerStatements = document.statements.filter(
    (statement) => statement.kind === "header",
  );
  const ambiguous = headerStatements.length !== 1;
  // Keep the first header as the grammar entry; each additional header owns
  // its ambiguity diagnosis so recovery can identify the offending source.
  for (const statement of headerStatements.slice(1)) {
    diagnostics.push({
      code: "ambiguous-source",
      field: "option",
      message: "Multiple Gantt headers",
      range: statement.range,
      statementId: statement.id,
    });
  }

  const sections: MermaidGanttSection[] = [];
  const tasks: MermaidGanttTask[] = [];
  const clicks: GanttClickBinding[] = [];
  const comments: GanttComment[] = [];
  const optionStatements = new Map<string, GanttSourceStatement>();
  let title = "";
  let accessibilityTitle = "";
  let accessibilityDescription = "";
  // Native Gantt defers schedule compilation until after parsing the complete
  // diagram. A later dateFormat therefore also governs earlier task records.
  const dateFormatStatement = document.statements.findLast(
    (statement) => statement.optionName === "dateFormat",
  );
  const effectiveDateFormat =
    (dateFormatStatement
      ? readOptionValue(dateFormatStatement.raw, "dateFormat")
      : "") || "YYYY-MM-DD";
  let inclusiveEndDates: boolean | null = null;
  let weekday: string | null = null;
  let weekend: string | null = null;
  const includes: string[] = [];
  const excludes: string[] = [];
  let axisFormat: string | null = null;
  let tickInterval: string | null = null;
  let topAxis: boolean | null = null;
  let todayMarker: string | null = null;
  const config = readGanttConfig(document);
  const displayMode: string | null =
    typeof config.effective.displayMode === "string"
      ? config.effective.displayMode
      : null;
  const useMaxWidth: boolean | null =
    typeof config.effective.useMaxWidth === "boolean"
      ? config.effective.useMaxWidth
      : null;
  let currentSectionId = "";
  let pendingComments: GanttComment[] = [];
  const statementById = new Map(document.statements.map((s) => [s.id, s]));

  const implicitSection = () => {
    if (!currentSectionId) {
      const id = "section-default";
      if (!sections.some((section) => section.id === id)) {
        sections.push({
          id,
          implicit: true,
          order: sections.length,
          recordId: "",
          title: "Tasks",
        });
      }
      currentSectionId = id;
    }
    return currentSectionId;
  };

  const flushComments = (anchor: GanttComment["anchor"], bindable: boolean) => {
    if (!pendingComments.length) return;
    for (const comment of pendingComments) {
      comments.push(bindable ? { ...comment, anchor } : comment);
    }
    pendingComments = [];
  };

  const commentGapIsClean = (statement: GanttSourceStatement) => {
    const last = pendingComments.at(-1);
    const record = last ? statementById.get(last.recordId) : undefined;
    if (!record) return false;
    const between = document.source.slice(
      record.range.end,
      statement.range.start,
    );
    return between.trim() === "" && !between.includes("\n\n");
  };

  let previousStatementKind: string | null = null;
  let commentBlockPrecededBy: string | null = null;
  let previousTaskId: string | undefined;
  let implicitTaskCount = 0;
  for (const statement of document.statements) {
    const trimmed = statement.raw.trim();
    const commentBlockBindable =
      pendingComments.length > 0 &&
      (commentBlockPrecededBy === null ||
        commentBlockPrecededBy === "blank" ||
        commentBlockPrecededBy === "header") &&
      commentGapIsClean(statement);
    switch (statement.kind) {
      case "blank":
        // A blank line ends a comment block, so it can no longer bind to a
        // later statement and stays a diagram-level comment.
        flushComments({ kind: "diagram" }, false);
        previousStatementKind = "blank";
        continue;
      case "comment": {
        const text = trimmed.replace(/^%%\s?/, "");
        if (!pendingComments.length)
          commentBlockPrecededBy = previousStatementKind;
        pendingComments.push({
          anchor: { kind: "diagram" },
          id: statement.id,
          recordId: statement.id,
          text,
        });
        previousStatementKind = "comment";
        continue;
      }
      case "header":
        flushComments({ kind: "diagram" }, true);
        previousStatementKind = "header";
        continue;
      case "title": {
        flushComments({ kind: "diagram" }, commentBlockBindable);
        title = trimmed.replace(/^title\s*/i, "").trim();
        optionStatements.set("title", statement);
        previousStatementKind = "title";
        continue;
      }
      case "accessibility-title":
        accessibilityTitle = trimmed.replace(/^accTitle\s*:\s*/i, "").trim();
        optionStatements.set("accTitle", statement);
        previousStatementKind = statement.kind;
        continue;
      case "accessibility-description": {
        const body = trimmed
          .replace(/^accDescr\s*:\s*/i, "")
          .replace(/^accDescr\s*\{\s*/i, "")
          .replace(/\}\s*$/, "")
          .replace(/^accDescription(?:\s*:|\s*\{)\s*/i, "")
          .trim();
        accessibilityDescription = body;
        optionStatements.set("accDescr", statement);
        previousStatementKind = statement.kind;
        continue;
      }
      case "option": {
        const name = statement.optionName!;
        const value = readOptionValue(trimmed, name);
        optionStatements.set(name, statement);
        switch (name) {
          case "dateFormat":
            break;
          case "inclusiveEndDates":
            inclusiveEndDates = parseBooleanOption(value);
            break;
          case "weekday":
            weekday = value;
            break;
          case "weekend":
            weekend = value;
            break;
          case "includes":
            includes.push(
              ...value
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean),
            );
            break;
          case "excludes":
            excludes.push(
              ...value
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean),
            );
            break;
          case "axisFormat":
            axisFormat = value;
            break;
          case "tickInterval":
            tickInterval = value;
            break;
          case "topAxis":
            topAxis = parseBooleanOption(value);
            break;
          case "todayMarker":
            todayMarker = value;
            break;
        }
        if ((name === "topAxis" || name === "inclusiveEndDates") && value)
          diagnostics.push(
            localDiagnostic(
              statement,
              "unsupported-option",
              "Native boolean statements have no value.",
            ),
          );
        flushComments({ kind: "option", id: name }, commentBlockBindable);
        previousStatementKind = "option";
        continue;
      }
      case "section": {
        flushComments(
          { kind: "section", id: statement.id },
          commentBlockBindable,
        );
        const sectionTitle =
          trimmed.replace(/^section\s*/i, "").trim() || "Tasks";
        currentSectionId = statement.id;
        sections.push({
          id: statement.id,
          implicit: false,
          order: sections.length,
          recordId: statement.id,
          title: sectionTitle,
        });
        previousStatementKind = "section";
        continue;
      }
      case "click": {
        const binding = parseClickStatement(statement);
        if (binding) clicks.push(binding);
        else
          diagnostics.push(
            localDiagnostic(
              statement,
              "unknown-statement",
              "Unreadable click statement.",
            ),
          );
        previousStatementKind = "click";
        continue;
      }
      case "task": {
        const sectionId = implicitSection();
        const parsed = parseTaskStatement(
          statement,
          `task${implicitTaskCount + 1}`,
          previousTaskId,
          effectiveDateFormat,
        );
        if (!parsed) {
          diagnostics.push(
            localDiagnostic(
              statement,
              "unknown-statement",
              "Unreadable task statement.",
            ),
          );
          previousStatementKind = "task";
          continue;
        }
        flushComments({ kind: "task", id: statement.id }, commentBlockBindable);
        // Mermaid increments its automatic ID counter only for idless tasks;
        // record identity remains independent of this source reference name.
        if (!parsed.parts.explicitId) implicitTaskCount += 1;
        diagnostics.push(...parsed.parts.diagnostics);
        const duplicate = tasks.find((task) => task.id === parsed.parts.id);
        if (duplicate) {
          diagnostics.push({
            ...localDiagnostic(
              statement,
              "duplicate-id",
              `Task id "${parsed.parts.id}" is used twice.`,
              "id",
            ),
            detail: parsed.parts.id,
          });
        }
        const task: MermaidGanttTask = {
          afterIds: parsed.parts.afterIds,
          diagnostics: parsed.parts.diagnostics,
          idRange: parsed.parts.idRange,
          labelRange: parsed.labelRange,
          duration: parsed.parts.duration,
          end: parsed.parts.end,
          explicitId: parsed.parts.explicitId,
          id: parsed.parts.id,
          isMilestone: parsed.parts.isMilestone,
          isVert: parsed.parts.isVert,
          label: parsed.label,
          order: tasks.length,
          recordId: statement.id,
          scheduleKind: parsed.parts.scheduleKind,
          sectionId,
          start: parsed.parts.start,
          statuses: [...new Set(parsed.parts.statuses)],
          untilIds: parsed.parts.untilIds,
        };
        tasks.push(task);
        previousTaskId = task.id;
        previousStatementKind = "task";
        continue;
      }
      default: {
        if (
          trimmed &&
          statement.kind !== "frontmatter" &&
          statement.kind !== "directive"
        ) {
          diagnostics.push(
            localDiagnostic(
              statement,
              "unknown-statement",
              `Statement "${trimmed.slice(0, 40)}" is not part of the Gantt grammar.`,
            ),
          );
        }
        previousStatementKind = statement.kind;
        continue;
      }
    }
  }
  comments.push(...pendingComments);

  const calendar = resolveGanttCalendar(
    {
      dateFormat: effectiveDateFormat,
      excludes,
      includes,
      inclusiveEndDates,
      weekday,
      weekend,
    },
    (name) => optionStatements.get(name)?.range,
  );
  diagnostics.push(...calendar.diagnostics);

  const resolved = resolveGanttTaskIntervals({
    calendar,
    dateFormat: effectiveDateFormat,
    inclusiveEndDates: inclusiveEndDates === true,
    tasks,
  });
  // Recursive resolution and the supplementary reference checks can reach the
  // same failed boundary. Keep one source-owned cause, not duplicate UI text.
  const addScheduleDiagnostic = (diagnostic: GanttDiagnostic) => {
    if (
      diagnostics.some(
        (existing) =>
          existing.code === diagnostic.code &&
          existing.statementId === diagnostic.statementId &&
          existing.field === diagnostic.field &&
          existing.detail === diagnostic.detail,
      )
    )
      return;
    diagnostics.push({
      ...diagnostic,
      range:
        (diagnostic.statementId
          ? statementById.get(diagnostic.statementId)?.range
          : undefined) ?? diagnostic.range,
    });
  };
  resolved.diagnostics.forEach(addScheduleDiagnostic);
  for (const task of tasks) {
    for (const reference of [...task.afterIds, ...task.untilIds]) {
      if (!tasks.some((candidate) => candidate.id === reference)) {
        addScheduleDiagnostic({
          code: "unresolved-reference",
          detail: reference,
          field: "reference",
          message: `Unknown task id "${reference}".`,
          range: statementById.get(task.recordId)?.range ?? {
            end: 0,
            endLine: 1,
            line: 1,
            start: 0,
          },
          statementId: task.recordId,
        });
      }
    }
    if (
      task.scheduleKind === "explicit" &&
      parseGanttDateValue(task.start, effectiveDateFormat) === null
    ) {
      addScheduleDiagnostic({
        code: "invalid-date",
        detail: task.start,
        field: "schedule",
        message: `Unreadable start value "${task.start}".`,
        range: statementById.get(task.recordId)?.range ?? {
          end: 0,
          endLine: 1,
          line: 1,
          start: 0,
        },
        statementId: task.recordId,
      });
    }
  }

  const intervals: Record<string, { end: number; start: number }> = {};
  for (const task of tasks) {
    const interval = resolved.intervals.get(task.recordId);
    if (interval)
      intervals[task.recordId] = { end: interval.end, start: interval.start };
  }

  return {
    accessibilityDescription,
    accessibilityTitle,
    ambiguous,
    axis: { axisFormat, tickInterval, todayMarker, topAxis },
    calendar: {
      dateFormat: effectiveDateFormat,
      excludes,
      includes,
      inclusiveEndDates,
      weekday,
      weekend,
    },
    clicks,
    comments,
    diagramType: "gantt",
    diagnostics,
    displayMode,
    intervals,
    sections,
    sourceDocument: document,
    sourceHash: hashMermaidSource(source),
    tasks: tasks.map((task) => ({
      ...task,
      diagnostics: diagnostics.filter(
        (diagnostic) => diagnostic.statementId === task.recordId,
      ),
    })),
    title,
    useMaxWidth,
    version: 2,
    configOccurrences: config.occurrences,
  };
}

export { ganttAfterLine };
