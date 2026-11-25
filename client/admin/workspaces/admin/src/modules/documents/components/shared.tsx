// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GraphQLError } from "graphql";

export function asJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function parseJsonField(value: string, fallback: unknown = {}) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed);
}

export function fieldError(error: GraphQLError | undefined, field: string) {
  const extensions = error?.extensions as
    | { fieldErrors?: Record<string, string>; fields?: Record<string, string> }
    | undefined;
  return (
    extensions?.fieldErrors?.[field] ?? extensions?.fields?.[field] ?? null
  );
}
