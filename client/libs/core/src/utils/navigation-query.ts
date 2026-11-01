// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

type QueryValue = string | number | boolean | null | undefined;
export type NavigationQuery = Record<string, QueryValue | QueryValue[]>;

/** Preserve repeated keys and bare flags while delegating decoding to the browser. */
export function parseNavigationQuery(
  search: string,
  options: { parseNumbers?: boolean; parseBooleans?: boolean } = {},
): NavigationQuery {
  const result: NavigationQuery = Object.create(null);
  for (const part of search
    .trim()
    .replace(/^[?#&]/, "")
    .split("&")) {
    if (!part) continue;
    const entry = new URLSearchParams(part).entries().next().value;
    if (!entry) continue;
    const [key, decoded] = entry;
    let value: QueryValue = part.includes("=") ? decoded : null;
    if (
      value !== null &&
      options.parseNumbers &&
      value.trim() &&
      !Number.isNaN(Number(value))
    ) {
      value = Number(value);
    } else if (
      typeof value === "string" &&
      options.parseBooleans &&
      /^(true|false)$/i.test(value)
    ) {
      value = value.toLowerCase() === "true";
    }
    const previous = result[key];
    result[key] = Object.hasOwn(result, key)
      ? Array.isArray(previous)
        ? [...previous, value]
        : [previous, value]
      : value;
  }
  return result;
}

/** Keep existing link spelling: sorted keys, repeated arrays and bare null flags. */
export function stringifyNavigationQuery(
  query: Record<string, unknown>,
): string {
  const encode = (value: unknown) =>
    new URLSearchParams([["", String(value)]])
      .toString()
      .slice(1)
      .replace(/\+/g, "%20")
      .replace(/%7E/gi, "~")
      .replace(/\*/g, "%2A");
  return Object.keys(query)
    .sort()
    .flatMap((key) => {
      const values = Array.isArray(query[key])
        ? (query[key] as unknown[])
        : [query[key]];
      return values
        .filter((value) => value !== undefined)
        .map((value) =>
          value === null ? encode(key) : `${encode(key)}=${encode(value)}`,
        );
    })
    .join("&");
}
