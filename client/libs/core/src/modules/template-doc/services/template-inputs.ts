// SPDX-License-Identifier: AGPL-3.0-or-later

import { TemplateInstantiationError } from "./template-instantiation-error";

export type TemplateInputValues = Readonly<Record<string, string>>;
export type RequestTemplateInputs = (
  names: readonly string[],
  signal: AbortSignal,
) => Promise<TemplateInputValues>;

export const TEMPLATE_INPUT_MAX_BYTES = 8 * 1024;
export const isTemplateInputName = (name: string) =>
  name.length <= 128 && /^input\.[a-z][a-z0-9_-]*$/i.test(name);
export const templateInputLabel = (name: string) =>
  name.slice("input.".length).replace(/[_-]/g, " ");

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
    if (
      !value ||
      new TextEncoder().encode(value).length > TEMPLATE_INPUT_MAX_BYTES
    )
      throw new TemplateInstantiationError("unresolved-variable");
    result[name] = value;
  }
  return Object.freeze(result);
}
