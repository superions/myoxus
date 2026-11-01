// SPDX-License-Identifier: AGPL-3.0-or-later

type CssPrimitive = string | number | undefined | null | false;
interface CssObject {
  [key: string]: CssPrimitive | CssObject;
}
type CssInput = string | CssObject | Array<string | CssObject>;

const sheetId = "myoxus-virgultum-runtime-css";
const insertedRules = new Set<string>();

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function propertyName(name: string): string {
  if (name.startsWith("--")) return name;
  return name.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function declarationValue(value: CssPrimitive): string | null {
  if (value === undefined || value === null || value === false) return null;
  return String(value);
}

function serializeObject(selector: string, styles: CssObject): string {
  const declarations: string[] = [];
  const nestedRules: string[] = [];

  for (const [key, rawValue] of Object.entries(styles)) {
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      if (key.startsWith("@")) {
        const nested = serializeObject(selector, rawValue as CssObject);
        if (nested) nestedRules.push(`${key}{${nested}}`);
        continue;
      }

      const nestedSelector = key.includes("&")
        ? key.replaceAll("&", selector)
        : key.startsWith(":") || key.startsWith("[")
          ? `${selector}${key}`
          : `${selector} ${key}`;
      nestedRules.push(serializeObject(nestedSelector, rawValue as CssObject));
      continue;
    }

    const value = declarationValue(rawValue as CssPrimitive);
    if (value !== null) declarations.push(`${propertyName(key)}:${value};`);
  }

  const currentRule = declarations.length
    ? `${selector}{${declarations.join("")}}`
    : "";
  return [currentRule, ...nestedRules].filter(Boolean).join("");
}

function ensureStyleElement(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(sheetId);
  if (existing instanceof HTMLStyleElement) return existing;

  const element = document.createElement("style");
  element.id = sheetId;
  element.dataset.myoxusRuntimeStyle = "virgultum";
  document.head.append(element);
  return element;
}

function insertRule(rule: string): void {
  if (!rule || insertedRules.has(rule)) return;
  insertedRules.add(rule);

  const element = ensureStyleElement();
  if (!element) return;
  element.append(document.createTextNode(rule));
}

function classNameFor(styles: CssObject): string {
  const signature = JSON.stringify(styles);
  const className = `mx-vg-${hashString(signature)}`;
  insertRule(serializeObject(`.${className}`, styles));
  return className;
}

export function css(input: CssInput): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((entry) => (typeof entry === "string" ? entry : classNameFor(entry)))
      .filter(Boolean)
      .join(" ");
  }
  return classNameFor(input);
}

export function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

export function stableClassHash(value: string): string {
  return hashString(value);
}
