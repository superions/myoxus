// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
const key = "virgultum:code-block:lang-list";
type Language = { id: string; name: string; aliases?: readonly string[] };

export function readLanguageOrder(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(saved))
      return saved.flatMap((entry) =>
        typeof entry?.name === "string" ? [entry.name] : [],
      );
  } catch {
    /* Browser storage is optional. */
  }
  return [];
}

export function codeLanguageOptions(
  languages: readonly Language[],
  selected: string | null,
  recent: readonly string[],
) {
  const rank = (id: string) => {
    if (id === selected) return -1;
    const index = recent.indexOf(id);
    return index < 0 ? Infinity : index;
  };
  return languages
    .map(({ id: value, name: label, aliases }) => ({ value, label, aliases }))
    .sort(
      (a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label),
    );
}

export function saveLanguageOrder(
  options: readonly {
    value: string;
    label: string;
    aliases?: readonly string[];
  }[],
) {
  try {
    // Other open clients read this deployed preference as objects with a name.
    localStorage.setItem(
      key,
      JSON.stringify(
        options.map(({ value: name, label, aliases }) => ({
          name,
          label,
          aliases,
        })),
      ),
    );
  } catch {
    /* Browser storage is optional. */
  }
}
