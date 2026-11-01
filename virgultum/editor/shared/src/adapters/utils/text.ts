import type { ReferenceParams } from "@virgultum/model";
import type { DeltaInsert } from "@virgultum/store";
import isEqual from "lodash-es/isEqual";

const mergeDeltas = (
  acc: DeltaInsert[],
  cur: DeltaInsert,
  options: { force?: boolean } = { force: false },
) => {
  if (acc.length === 0) {
    return [cur];
  }
  const last = acc[acc.length - 1];
  if (options?.force) {
    last.insert = last.insert + cur.insert;
    last.attributes = Object.create(null);
    return acc;
  } else if (
    typeof last.insert === "string" &&
    typeof cur.insert === "string" &&
    (isEqual(last.attributes, cur.attributes) ||
      (last.attributes === undefined && cur.attributes === undefined))
  ) {
    last.insert += cur.insert;
    return acc;
  }
  return [...acc, cur];
};

const isNullish = (value: unknown) => value === null || value === undefined;

const createText = (s: string) => {
  return {
    "$virgultum:internal:text$": true,
    delta: s.length === 0 ? [] : [{ insert: s }],
  };
};

const isText = (o: unknown) => {
  if (typeof o === "object" && o !== null && "$virgultum:internal:text$" in o) {
    return o["$virgultum:internal:text$"] === true;
  }
  return false;
};

function toURLSearchParams(
  params?: Partial<Record<string, string | string[]>>,
) {
  if (!params) return;

  const items = Object.entries(params)
    .filter(([_, v]) => !isNullish(v))
    .filter(([_, v]) => {
      if (typeof v === "string") {
        return v.length > 0;
      }
      if (Array.isArray(v)) {
        return v.length > 0;
      }
      return false;
    })
    .map(([k, v]) => [k, Array.isArray(v) ? v.filter((v) => v.length) : v]) as [
    string,
    string | string[],
  ][];

  return new URLSearchParams(
    items
      .filter(([_, v]) => v.length)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
  );
}

function generateDocUrl(
  docBaseUrl: string,
  pageId: string,
  params: ReferenceParams,
  workspaceId?: string,
) {
  const search = toURLSearchParams(params);
  const query = search?.size ? `?${search.toString()}` : "";
  let base = docBaseUrl;
  if (workspaceId !== undefined && base) {
    const url = new URL(
      base,
      globalThis.location?.origin ?? "http://localhost",
    );
    const match = url.pathname.match(/^(.*\/workspace\/)[^/]+\/?$/);
    if (!match) return "";
    url.pathname = `${match[1]}${encodeURIComponent(workspaceId)}`;
    base = url.href.replace(/\/$/, "");
  }
  const url = base ? `${base}/${pageId}${query}` : "";
  return url;
}

export const AdapterTextUtils = {
  mergeDeltas,
  isNullish,
  createText,
  isText,
  toURLSearchParams,
  generateDocUrl,
};
