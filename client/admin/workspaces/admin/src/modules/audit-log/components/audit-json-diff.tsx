// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Audit JSON diff renderer.
 *
 * The audit log must redact secrets before any visual diffing happens: a text
 * diff over raw JSON would leak removed credentials even when the final cell is
 * styled as "removed". This component therefore walks the JSON tree first,
 * replaces sensitive leaves recursively, and only then computes side-by-side
 * path rows for old/new values.
 */
import { useI18n } from "@myoxus/i18n";
import {
  DiffColumn,
  DiffGrid,
  DiffLineNumber,
  DiffList,
  DiffPath,
  DiffRow,
  DiffValue,
  JsonPrimitiveValue,
  SettingsStatusText,
} from "@myoxus/ui-facade";

const REDACTED = "***redacted***";
const MISSING = Symbol("missing-json-path");
const SENSITIVE_KEY_PARTS = [
  "password",
  "secret",
  "token",
  "credential",
  "privatekey",
  "apikey",
  "api_key",
  "refresh_token",
  "access_token",
];

type Missing = typeof MISSING;
type JsonPathValue = unknown | Missing;

export type JsonDiffStatus = "added" | "removed" | "changed" | "unchanged";

export type JsonDiffRow = {
  path: string;
  oldValue: JsonPathValue;
  newValue: JsonPathValue;
  status: JsonDiffStatus;
  oldLine: number | null;
  newLine: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKey(key) ? REDACTED : redactAuditValue(child),
    ]),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function flattenJson(
  value: unknown,
  path = "$",
  target = new Map<string, unknown>(),
) {
  if (Array.isArray(value)) {
    if (value.length === 0) target.set(path, []);
    value.forEach((item, index) =>
      flattenJson(item, `${path}[${index}]`, target),
    );
    return target;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) target.set(path, {});
    keys.forEach((key) => flattenJson(value[key], `${path}.${key}`, target));
    return target;
  }

  target.set(path, value);
  return target;
}

function statusFor(
  oldValue: JsonPathValue,
  newValue: JsonPathValue,
): JsonDiffStatus {
  if (oldValue === MISSING) return "added";
  if (newValue === MISSING) return "removed";
  return stableStringify(oldValue) === stableStringify(newValue)
    ? "unchanged"
    : "changed";
}

export function buildAuditJsonDiffRows(
  oldValue: unknown,
  newValue: unknown,
): JsonDiffRow[] {
  const oldMap = flattenJson(redactAuditValue(oldValue));
  const newMap = flattenJson(redactAuditValue(newValue));
  const paths = Array.from(
    new Set([...oldMap.keys(), ...newMap.keys()]),
  ).sort();

  let oldLine = 0;
  let newLine = 0;
  return paths.map((path) => {
    const oldPathValue = oldMap.has(path) ? oldMap.get(path) : MISSING;
    const newPathValue = newMap.has(path) ? newMap.get(path) : MISSING;
    const status = statusFor(oldPathValue, newPathValue);
    const nextOldLine = oldPathValue === MISSING ? null : ++oldLine;
    const nextNewLine = newPathValue === MISSING ? null : ++newLine;
    return {
      path,
      oldValue: oldPathValue,
      newValue: newPathValue,
      status,
      oldLine: nextOldLine,
      newLine: nextNewLine,
    };
  });
}

function PrimitiveValue({ value }: { value: JsonPathValue }) {
  if (value === MISSING) return <SettingsStatusText>∅</SettingsStatusText>;
  if (value === null || value === undefined) {
    return <SettingsStatusText>null</SettingsStatusText>;
  }
  if (typeof value === "string") {
    const redacted = value === REDACTED;
    return (
      <JsonPrimitiveValue tone={redacted ? "redacted" : "string"}>
        {JSON.stringify(value)}
      </JsonPrimitiveValue>
    );
  }
  if (typeof value === "number")
    return <JsonPrimitiveValue tone="number">{value}</JsonPrimitiveValue>;
  if (typeof value === "boolean")
    return (
      <JsonPrimitiveValue tone="boolean">{String(value)}</JsonPrimitiveValue>
    );
  return <span>{JSON.stringify(value)}</span>;
}

function rowTone(status: JsonDiffStatus, side: "old" | "new") {
  if (status === "added" && side === "new") return "added";
  if (status === "removed" && side === "old") return "removed";
  if (status === "changed") return "changed";
  return "unchanged";
}

function AuditDiffColumn({
  side,
  rows,
}: {
  side: "old" | "new";
  rows: JsonDiffRow[];
}) {
  const i18n = useI18n();
  const title =
    side === "old"
      ? i18n.t("admin.audit-log.detail.old-value")
      : i18n.t("admin.audit-log.detail.new-value");

  return (
    <DiffColumn title={title}>
      <DiffList>
        {rows.map((row) => {
          const line = side === "old" ? row.oldLine : row.newLine;
          const value = side === "old" ? row.oldValue : row.newValue;
          return (
            <DiffRow
              key={`${side}:${row.path}`}
              tone={rowTone(row.status, side)}
            >
              <DiffLineNumber>{line ?? ""}</DiffLineNumber>
              <DiffPath title={row.path}>{row.path}</DiffPath>
              <DiffValue>
                <PrimitiveValue value={value} />
              </DiffValue>
            </DiffRow>
          );
        })}
      </DiffList>
    </DiffColumn>
  );
}

export function AuditJsonDiff({
  oldValue,
  newValue,
}: {
  oldValue: unknown;
  newValue: unknown;
}) {
  const rows = buildAuditJsonDiffRows(oldValue, newValue);

  return (
    <DiffGrid data-myoxus-ui-role="audit-json-diff-grid">
      <AuditDiffColumn side="old" rows={rows} />
      <AuditDiffColumn side="new" rows={rows} />
    </DiffGrid>
  );
}
