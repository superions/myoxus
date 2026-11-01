// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidGfxJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly MermaidGfxJsonValue[]
  | MermaidGfxJsonObject;

export type MermaidGfxJsonObject = Readonly<{
  [key: string]: MermaidGfxJsonValue;
}>;

export type MermaidVisualFamilyData = Readonly<{
  family: string;
  payload: MermaidGfxJsonObject;
  version: 1;
}>;

function isJsonValue(value: unknown): value is MermaidGfxJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is MermaidGfxJsonObject {
  return (
    Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    isJsonValue(value)
  );
}

const INVALID_JSON_VALUE = Symbol("invalid-mermaid-gfx-json-value");

function normalizeJsonValue(
  value: unknown,
): MermaidGfxJsonValue | undefined | typeof INVALID_JSON_VALUE {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  }
  if (Array.isArray(value)) {
    const normalized: MermaidGfxJsonValue[] = [];
    for (const item of value) {
      const next = normalizeJsonValue(item);
      if (next === undefined || next === INVALID_JSON_VALUE) {
        return INVALID_JSON_VALUE;
      }
      normalized.push(next);
    }
    return normalized;
  }
  if (!value || typeof value !== "object") return INVALID_JSON_VALUE;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return INVALID_JSON_VALUE;
  }
  const normalized: Record<string, MermaidGfxJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = normalizeJsonValue(item);
    if (next === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
    if (next !== undefined) normalized[key] = next;
  }
  return normalized;
}

export function createMermaidVisualFamilyData(
  family: string,
  payload: Readonly<Record<string, unknown>>,
): MermaidVisualFamilyData {
  const normalized = normalizeJsonValue(payload);
  if (
    !family ||
    normalized === INVALID_JSON_VALUE ||
    !isJsonObject(normalized)
  ) {
    throw new TypeError("Mermaid GFX family data must be JSON-safe");
  }
  return { family, payload: normalized, version: 1 };
}

export function mermaidVisualFamilyPayload(
  value: MermaidVisualFamilyData | undefined,
  family: string,
): MermaidGfxJsonObject | undefined {
  return value?.family === family && value.version === 1
    ? value.payload
    : undefined;
}

export function parseMermaidVisualFamilyData(
  value: unknown,
): MermaidVisualFamilyData | undefined {
  const parsed = (() => {
    if (typeof value !== "string") return value;
    if (!value.trim()) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "family" ||
    keys[1] !== "payload" ||
    keys[2] !== "version" ||
    typeof record.family !== "string" ||
    !record.family ||
    record.version !== 1 ||
    !isJsonObject(record.payload)
  ) {
    return undefined;
  }
  return {
    family: record.family,
    payload: record.payload,
    version: 1,
  };
}

function stableJson(value: MermaidGfxJsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as MermaidGfxJsonObject)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeMermaidVisualFamilyData(
  value: MermaidVisualFamilyData | undefined,
) {
  return value ? stableJson(value) : "";
}
