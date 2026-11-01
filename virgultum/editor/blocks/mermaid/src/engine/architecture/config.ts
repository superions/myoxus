// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureConfig } from "./model.js";

export const MERMAID_ARCHITECTURE_CONFIG_KEYS = [
  "padding",
  "iconSize",
  "fontSize",
  "randomize",
  "nodeSeparation",
  "idealEdgeLengthMultiplier",
  "edgeElasticity",
  "numIter",
  "seed",
] as const;

export const MERMAID_ARCHITECTURE_NUMERIC_CONFIG_KEYS = [
  "padding",
  "iconSize",
  "fontSize",
  "nodeSeparation",
  "idealEdgeLengthMultiplier",
  "edgeElasticity",
  "numIter",
  "seed",
] as const;

// Mirrors the nine editable fields in Mermaid 11.17.2 defaultConfig.architecture.
// `useMaxWidth` remains a foreign renderer member and is preserved, not owned.
export const MERMAID_ARCHITECTURE_CONFIG_DEFAULTS = {
  edgeElasticity: 0.45,
  fontSize: 16,
  iconSize: 80,
  idealEdgeLengthMultiplier: 1.5,
  nodeSeparation: 75,
  numIter: 2500,
  padding: 40,
  randomize: false,
  seed: 1,
} as const satisfies Required<MermaidArchitectureConfig>;

export const MERMAID_ARCHITECTURE_CONFIG_RULES = {
  edgeElasticity: { maximum: 1, minimum: 0, type: "number" },
  fontSize: { exclusiveMinimum: 0, type: "number" },
  iconSize: { exclusiveMinimum: 0, type: "number" },
  idealEdgeLengthMultiplier: { exclusiveMinimum: 0, type: "number" },
  nodeSeparation: { exclusiveMinimum: 0, type: "number" },
  numIter: { exclusiveMinimum: 0, type: "number" },
  padding: { exclusiveMinimum: 0, type: "number" },
  randomize: { type: "boolean" },
  seed: { type: "number" },
} as const;

type JsonMember = {
  end: number;
  key: string;
  start: number;
  valueStart: number;
};

function initJson(directive: string) {
  const trimmed = directive.trim();
  if (!trimmed.startsWith("%%{") || !trimmed.endsWith("}%%")) return null;
  const body = trimmed.slice(3, -3).trim();
  const colon = body.indexOf(":");
  if (colon < 0 || body.slice(0, colon).trim() !== "init") return null;
  const json = body.slice(colon + 1).trim();
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? { json, prefix: trimmed.slice(0, trimmed.indexOf(json)) }
      : null;
  } catch {
    return null;
  }
}

function topLevelMembers(json: string): JsonMember[] {
  const members: JsonMember[] = [];
  let index = 1;
  while (index < json.length - 1) {
    while (/\s|,/.test(json[index] ?? "")) index += 1;
    if (json[index] !== '"') return [];
    const start = index;
    index += 1;
    while (index < json.length && json[index] !== '"') {
      if (json[index] === "\\") index += 1;
      index += 1;
    }
    const keyEnd = index + 1;
    let key: string;
    try {
      key = JSON.parse(json.slice(start, keyEnd)) as string;
    } catch {
      return [];
    }
    index = keyEnd;
    while (/\s/.test(json[index] ?? "")) index += 1;
    if (json[index] !== ":") return [];
    index += 1;
    while (/\s/.test(json[index] ?? "")) index += 1;
    const valueStart = index;
    let depth = 0;
    let quoted = false;
    for (; index < json.length; index += 1) {
      const character = json[index];
      if (quoted) {
        if (character === "\\") index += 1;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === "," && depth === 0) break;
    }
    members.push({ end: index, key, start, valueStart });
    if (json[index] === ",") index += 1;
  }
  return members;
}

function architectureConfigValueIsValid(
  key: (typeof MERMAID_ARCHITECTURE_CONFIG_KEYS)[number],
  value: unknown,
) {
  if (value === undefined) return true;
  const rule = MERMAID_ARCHITECTURE_CONFIG_RULES[key];
  if (rule.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if ("exclusiveMinimum" in rule && value <= rule.exclusiveMinimum) {
    return false;
  }
  if ("minimum" in rule && value < rule.minimum) return false;
  if ("maximum" in rule && value > rule.maximum) return false;
  return true;
}

export function validateMermaidArchitectureConfig(
  config: unknown,
): config is MermaidArchitectureConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }
  return Object.entries(config).every(
    ([key, value]) =>
      MERMAID_ARCHITECTURE_CONFIG_KEYS.includes(
        key as (typeof MERMAID_ARCHITECTURE_CONFIG_KEYS)[number],
      ) &&
      architectureConfigValueIsValid(
        key as (typeof MERMAID_ARCHITECTURE_CONFIG_KEYS)[number],
        value,
      ),
  );
}

export function resolveMermaidArchitectureConfig(
  config: MermaidArchitectureConfig,
): Required<MermaidArchitectureConfig> {
  const validOverrides = Object.fromEntries(
    MERMAID_ARCHITECTURE_CONFIG_KEYS.flatMap((key) => {
      const value = config[key];
      return value !== undefined && architectureConfigValueIsValid(key, value)
        ? [[key, value]]
        : [];
    }),
  ) as MermaidArchitectureConfig;
  return { ...MERMAID_ARCHITECTURE_CONFIG_DEFAULTS, ...validOverrides };
}

function removeJsonMember(json: string, key: string) {
  const members = topLevelMembers(json);
  const member = members.find((candidate) => candidate.key === key);
  if (!member) return json;
  const memberIndex = members.indexOf(member);
  const next = members[memberIndex + 1];
  const previous = members[memberIndex - 1];
  let start = member.start;
  if (previous) {
    while (start > 1 && /\s/.test(json[start - 1] ?? "")) start -= 1;
    if (json[start - 1] === ",") start -= 1;
  }
  const end = next ? next.start : member.end;
  return `${json.slice(0, start)}${json.slice(end)}`;
}

function appendJsonMember(json: string, key: string, value: unknown) {
  const close = json.lastIndexOf("}");
  const separator = topLevelMembers(json).length ? "," : "";
  return `${json.slice(0, close)}${separator}${JSON.stringify(key)}:${JSON.stringify(value)}${json.slice(close)}`;
}

function patchArchitectureJson(
  json: string,
  config: MermaidArchitectureConfig,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Object.keys(config).length ? JSON.stringify(config) : null;
  }
  let next = json;
  for (const key of MERMAID_ARCHITECTURE_CONFIG_KEYS) {
    while (topLevelMembers(next).some((member) => member.key === key)) {
      next = removeJsonMember(next, key);
    }
  }
  for (const key of MERMAID_ARCHITECTURE_CONFIG_KEYS) {
    const value = config[key];
    if (value !== undefined) next = appendJsonMember(next, key, value);
  }
  return topLevelMembers(next).length ? next : null;
}

export function readMermaidArchitectureConfig(
  directives: readonly string[],
): MermaidArchitectureConfig {
  const config: MermaidArchitectureConfig = {};
  for (const directive of directives) {
    const parsed = initJson(directive);
    if (!parsed) continue;
    const root = JSON.parse(parsed.json) as Record<string, unknown>;
    const architecture = root.architecture;
    if (
      !architecture ||
      typeof architecture !== "object" ||
      Array.isArray(architecture)
    ) {
      continue;
    }
    const record = architecture as Record<string, unknown>;
    for (const key of MERMAID_ARCHITECTURE_CONFIG_KEYS) {
      const value = record[key];
      if (value === undefined || !architectureConfigValueIsValid(key, value)) {
        continue;
      }
      if (key === "randomize") config[key] = value as boolean;
      else config[key] = value as number;
    }
  }
  return config;
}

export function writeMermaidArchitectureConfigDirective(
  directives: readonly string[],
  config: MermaidArchitectureConfig,
) {
  if (!validateMermaidArchitectureConfig(config)) {
    throw new Error("Invalid Architecture configuration.");
  }
  const normalizedConfig = Object.fromEntries(
    MERMAID_ARCHITECTURE_CONFIG_KEYS.flatMap((key) =>
      config[key] === undefined ? [] : [[key, config[key]]],
    ),
  ) as MermaidArchitectureConfig;
  const empty = Object.keys(normalizedConfig).length === 0;
  const hasArchitecture = directives.some((directive) => {
    const parsed = initJson(directive);
    return Boolean(
      parsed &&
      topLevelMembers(parsed.json).some(
        (member) => member.key === "architecture",
      ),
    );
  });
  let applied = false;
  const nextDirectives: string[] = [];
  for (const directive of directives) {
    const parsed = initJson(directive);
    if (!parsed) {
      nextDirectives.push(directive);
      continue;
    }
    const members = topLevelMembers(parsed.json);
    const architecture = members.find(({ key }) => key === "architecture");
    let json = parsed.json;
    if (architecture) {
      const patched = patchArchitectureJson(
        json.slice(architecture.valueStart, architecture.end),
        !empty && !applied ? normalizedConfig : {},
      );
      if (patched) {
        json = `${json.slice(0, architecture.valueStart)}${patched}${json.slice(architecture.end)}`;
      } else {
        json = removeJsonMember(json, "architecture");
      }
      if (!empty && !applied) applied = true;
    } else if (!empty && !hasArchitecture && !applied) {
      json = appendJsonMember(json, "architecture", normalizedConfig);
      applied = true;
    }
    if (topLevelMembers(json).length) {
      nextDirectives.push(`${parsed.prefix}${json}}%%`);
    }
  }
  return !empty && !applied
    ? [
        `%%{init: {"architecture":${JSON.stringify(normalizedConfig)}}}%%`,
        ...nextDirectives,
      ]
    : nextDirectives;
}

export function resetMermaidArchitectureConfigDirectives(
  directives: readonly string[],
) {
  return writeMermaidArchitectureConfigDirective(directives, {});
}
