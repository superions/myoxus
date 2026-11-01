// SPDX-License-Identifier: AGPL-3.0-or-later

type TemplateLike = {
  strings: readonly string[];
  values: readonly unknown[];
};

export function templateToString({ strings, values }: TemplateLike): string {
  return strings.reduce(
    (result, str, i) =>
      result + str + (i < values.length ? String(values[i]) : ""),
    "",
  );
}
