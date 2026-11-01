// SPDX-License-Identifier: AGPL-3.0-or-later

export const REQUIREMENT_TYPES = [
  "requirement",
  "functionalRequirement",
  "interfaceRequirement",
  "performanceRequirement",
  "physicalRequirement",
  "designConstraint",
] as const;
export const REQUIREMENT_RELATIONS = [
  "contains",
  "copies",
  "derives",
  "satisfies",
  "verifies",
  "refines",
  "traces",
] as const;
export const REQUIREMENT_RISKS = ["low", "medium", "high"] as const;
export const REQUIREMENT_VERIFICATION_METHODS = [
  "analysis",
  "demonstration",
  "inspection",
  "test",
] as const;
export const REQUIREMENT_DIRECTIONS = ["TB", "BT", "LR", "RL"] as const;
export const REQUIREMENT_HEADER = /^requirementDiagram\b/i;
export const REQUIREMENT_CSS_ID_LIST = String.raw`(?:"[^"]+"|\w+)(?:[ \t]*,[ \t]*(?:"[^"]+"|\w+))*`;
export type RequirementPropertyName =
  "id" | "text" | "risk" | "verifymethod" | "type" | "docref";

const reserved = new RegExp(
  `^(?:requirementDiagram|id|text|risk|verifyMethod|${REQUIREMENT_TYPES.join("|")}|${REQUIREMENT_RISKS.join("|")}|${REQUIREMENT_VERIFICATION_METHODS.join("|")}|element|${REQUIREMENT_RELATIONS.join("|")}|type|docref|style|classDef|class)\\b`,
  "i",
);

/** The pinned lexer has quoted strings, not JSON escapes. Quotes delimit even
 * after a backslash; quoted Markdown and physical newlines remain literal. */
export function readRequirementString(raw: string): string | null {
  const value = raw.trim();
  if (/^"[^"]+"$/.test(value)) return value.slice(1, -1);
  if (reserved.test(value) || /^title\s/i.test(value)) return null;
  return /^[\w][^:,\r\n{<>\-=]*$/.test(value) ? value : null;
}

export function sourceRequirementString(value: string) {
  return readRequirementString(value) === value && !value.includes('"')
    ? value
    : `"${value.replaceAll('"', "#quot;")}"`;
}
