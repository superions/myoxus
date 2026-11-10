// SPDX-License-Identifier: AGPL-3.0-or-later

import { TemplateInstantiationError } from "./template-instantiation-error";
import {
  DocumentFieldSchema,
  initializeDocumentField,
  visitDocumentFieldRuns,
  type DocumentField,
} from "@virgultum/shared/types";
import {
  formatRegionalDate,
  formatRegionalDateTime,
  type RegionalFormatPreferences,
} from "../../i18n";

export type TemplateInputValues = Readonly<Record<string, string>>;
export type RequestTemplateInputs = (
  names: readonly string[],
  signal: AbortSignal,
) => Promise<TemplateInputValues>;

export const TEMPLATE_INPUT_MAX_BYTES = 8 * 1024;
export type TemplateInputKind = "text" | "date" | "datetime";

/** Only the explicit typed namespaces select a control; ordinary names remain text. */
export function templateInputKind(name: string): TemplateInputKind | null {
  if (name.length > 128) return null;
  const match = /^input\.(?:(date|datetime)\.)?([a-z][a-z0-9_-]*)$/i.exec(name);
  return match
    ? ((match[1]?.toLowerCase() ?? "text") as TemplateInputKind)
    : null;
}

export const isTemplateInputName = (name: string) =>
  templateInputKind(name) !== null;
export const templateInputLabel = (name: string) =>
  name.replace(/^input\.(?:(?:date|datetime)\.)?/i, "").replace(/[_-]/g, " ");

/** Authoring choices share the same admitted grammar as source capture and application. */
export function templateInputVariants(name: string): readonly string[] {
  const kind = templateInputKind(name);
  if (kind === null) return [];
  return kind === "text"
    ? [
        name,
        `input.date.${name.slice("input.".length)}`,
        `input.datetime.${name.slice("input.".length)}`,
      ].filter(isTemplateInputName)
    : [name];
}

function calendarInput(value: string, kind: TemplateInputKind): Date | null {
  const match = (
    kind === "date"
      ? /^(\d{4})-(\d{2})-(\d{2})$/
      : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  ).exec(value);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  if (parts[0] < 1) return null;
  const date = new Date(0);
  // setUTCFullYear retains years 1–99, unlike Date.UTC's 1900 offset.
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], 0);
  return date.getUTCFullYear() === parts[0] &&
    date.getUTCMonth() === parts[1] - 1 &&
    date.getUTCDate() === parts[2] &&
    date.getUTCHours() === parts[3] &&
    date.getUTCMinutes() === parts[4] &&
    date.getUTCSeconds() === parts[5]
    ? date
    : null;
}

/** Keep the native owner’s stable order; answers are literal strings, never another template. */
export function templateInputNames(names: Iterable<string>): string[] {
  const inputs = [...new Set(names)].filter((name) =>
    name.startsWith("input."),
  );
  if (inputs.length > 100 || inputs.some((name) => !isTemplateInputName(name)))
    throw new TemplateInstantiationError("invalid-syntax");
  return inputs;
}

export function normalizeTemplateInputs(
  names: readonly string[],
  values: TemplateInputValues,
): TemplateInputValues {
  const result: Record<string, string> = Object.create(null);
  for (const name of templateInputNames(names)) {
    const value = typeof values[name] === "string" ? values[name].trim() : "";
    const kind = templateInputKind(name)!;
    if (
      !value ||
      new TextEncoder().encode(value).length > TEMPLATE_INPUT_MAX_BYTES ||
      (kind !== "text" && !calendarInput(value, kind))
    )
      throw new TemplateInstantiationError("unresolved-variable");
    result[name] = value;
  }
  return Object.freeze(result);
}

type NativeInput = Extract<DocumentField, { type: "input" }>;

function canonicalFieldValue(
  definition: NativeInput["definition"],
  value: NativeInput["value"],
): NativeInput["value"] {
  if (value === null || definition.kind === "text") return value;
  const invalid = () => new TypeError("Invalid native document field value");
  if (definition.kind === "date" || definition.kind === "datetime") {
    if (typeof value !== "string" || !calendarInput(value, definition.kind))
      throw invalid();
    return value;
  }
  if (definition.kind === "single-select") {
    if (
      typeof value !== "string" ||
      !definition.options.some((option) => option.id === value)
    )
      throw invalid();
    return value;
  }
  if (!Array.isArray(value)) throw invalid();
  const selected = new Set(value);
  if (
    value.some((id) => !definition.options.some((option) => option.id === id))
  )
    throw invalid();
  return definition.options
    .filter((option) => selected.has(option.id))
    .map((option) => option.id);
}

/** Immediate native-field feedback, separate from required/trim-all legacy answers.
 * Application admission remains authoritative at captured-content write owners.
 */
export function normalizeDocumentField(field: DocumentField): DocumentField {
  const parsed = DocumentFieldSchema.parse(field);
  if (parsed.type === "metadata") return parsed;
  const { definition } = parsed;
  if (
    "options" in definition &&
    new Set(definition.options.map((option) => option.id)).size !==
      definition.options.length
  ) {
    throw new TypeError("Duplicate native document field option identity");
  }
  return DocumentFieldSchema.parse({
    ...parsed,
    definition: {
      ...definition,
      ...(definition.default !== undefined
        ? { default: canonicalFieldValue(definition, definition.default) }
        : {}),
    },
    value: canonicalFieldValue(definition, parsed.value),
  });
}

/** Source checking admits valid unfinished answers without filling a default. */
export function validateTemplateDocumentFields(snapshot: unknown): void {
  visitDocumentFieldRuns(snapshot, (run) => {
    normalizeDocumentField(
      DocumentFieldSchema.parse(run.attributes?.documentField),
    );
  });
}

/** Initialize only the detached application/insertion copy, before target writes.
 * Archival text and its retained answer remain frozen until editable restore.
 */
export function initializeTemplateDocumentFields(snapshot: unknown): void {
  visitDocumentFieldRuns(snapshot, (run) => {
    const field = normalizeDocumentField(
      DocumentFieldSchema.parse(run.attributes?.documentField),
    );
    if (run.attributes?.documentFieldCaptured) return;
    run.attributes = {
      ...run.attributes,
      documentField: initializeDocumentField(field),
    };
  });
}

/** Presentation never fills a default, trims text or expands braces. Empty
 * required fields stay saveable and are reported as unfinished, not invalid.
 */
export function formatDocumentInput(
  field: DocumentField,
  preferences: RegionalFormatPreferences,
): { text: string | null; complete: boolean } {
  const input = normalizeDocumentField(field);
  if (input.type !== "input") throw new TypeError("Input field required");
  const { definition, value } = input;
  let text: string | null;
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    text = null;
  } else if (definition.kind === "text") {
    text = value as string;
  } else if (definition.kind === "date" || definition.kind === "datetime") {
    const date = calendarInput(value as string, definition.kind)!;
    const calendarPreferences = { ...preferences, timezone: "UTC" };
    text =
      definition.kind === "date"
        ? formatRegionalDate(date, calendarPreferences)
        : formatRegionalDateTime(date, calendarPreferences);
  } else {
    const selected = new Set(Array.isArray(value) ? value : [value]);
    text = definition.options
      .filter((option) => selected.has(option.id))
      .map((option) => option.label)
      .join(", ");
  }
  return {
    text,
    complete: !definition.required || (text !== null && text.length > 0),
  };
}

/** Project canonical calendar/clock answers once; UTC here deliberately prevents day/time shifts. */
export function formatTemplateInputs(
  values: TemplateInputValues,
  preferences: RegionalFormatPreferences,
): TemplateInputValues {
  const normalized = normalizeTemplateInputs(Object.keys(values), values);
  const calendarPreferences = { ...preferences, timezone: "UTC" };
  return Object.fromEntries(
    Object.entries(normalized).map(([name, value]) => {
      const kind = templateInputKind(name)!;
      if (kind === "text") return [name, value];
      const date = calendarInput(value, kind)!;
      return [
        name,
        kind === "date"
          ? formatRegionalDate(date, calendarPreferences)
          : formatRegionalDateTime(date, calendarPreferences),
      ];
    }),
  );
}
