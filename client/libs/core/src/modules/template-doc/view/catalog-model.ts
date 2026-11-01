// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AssistantDocumentSourceInput } from "@myoxus/graphql";

import type {
  TemplateSourceOrigin,
  TemplateSuggestionMenuItem,
} from "../services/template-doc";
import { templateSuggestionSourceKey } from "../services/template-doc";

export type TemplateCatalogOrigin = "all" | TemplateSourceOrigin;
export type TemplateCatalogType = "documents" | "building-blocks";
export type TemplateCatalogReadiness =
  | "ready"
  | "preparing"
  | "access-denied"
  | "source-missing"
  | "client-incompatible"
  | "retryable-failure";
export type TemplateCatalogSort =
  "name-asc" | "name-desc" | "updated-desc" | "updated-asc";

export type TemplateCatalogNativeSource = {
  docId: string;
  title: string;
  updatedAt: number | null;
  templateId: string | null | undefined;
  origin: string | null | undefined;
  category?: string | null;
  tags?: readonly string[];
  registryBacked?: boolean;
};

export type TemplateCatalogRow = {
  key: string;
  templateId: string;
  docId: string | null;
  title: string;
  description: string | null;
  category: string | null;
  tags: readonly string[];
  origin: TemplateSourceOrigin;
  updatedAt: number | null;
  available: boolean;
  managed: boolean;
  registryBacked: boolean;
  sourceRevisionId?: string | null;
  readiness: TemplateCatalogReadiness;
  readinessReasons: readonly string[];
  assistantSource?: {
    input: AssistantLibraryAssociation;
    sourceRevisionId: string;
  };
};

function catalogReadiness(
  item: TemplateSuggestionMenuItem,
): TemplateCatalogReadiness {
  if (item.reasons.includes("AccessDenied")) return "access-denied";
  if (item.reasons.includes("IncompatibleClient")) return "client-incompatible";
  if (item.reasons.includes("RetryableFailure")) return "retryable-failure";
  if (item.reasons.includes("SourceMissing")) return "source-missing";
  if (item.reasons.includes("Preparing")) return "preparing";
  return item.available ? "ready" : "retryable-failure";
}

export type TemplateCatalogRouteState = {
  type: TemplateCatalogType;
  tag: string | null;
  search: string;
  origin: TemplateCatalogOrigin;
  sort: TemplateCatalogSort;
};

export type AssistantLibraryAssociation = Omit<
  AssistantDocumentSourceInput,
  "locale" | "clientVersion"
>;
export type AssistantLibraryRoute =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "source"; input: AssistantLibraryAssociation };
const associationKeys = [
  "assistantId",
  "assistantVersion",
  "assistantDigest",
  "assistantStep",
  "assistantGroup",
  "sourceDigest",
] as const;

export function parseAssistantLibraryRoute(
  params: URLSearchParams,
): AssistantLibraryRoute {
  if (
    ![...params.keys()].some(
      (key) => key.startsWith("assistant") || key === "sourceDigest",
    )
  )
    return { kind: "none" };
  if (
    [...params.keys()].some(
      (key) =>
        key.startsWith("assistant") &&
        !associationKeys.some((known) => known === key),
    ) ||
    associationKeys.some((key) => params.getAll(key).length !== 1)
  )
    return { kind: "invalid" };
  const id = params.get("assistantId")!,
    version = params.get("assistantVersion")!,
    digest = params.get("assistantDigest")!,
    step = params.get("assistantStep")!,
    group = params.get("assistantGroup")!,
    sourceDigest = params.get("sourceDigest")!;
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
    !/^\d{1,20}\.\d{1,20}\.\d{1,20}$/.test(version) ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !/^[a-f0-9]{64}$/.test(sourceDigest) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(step) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(group)
  )
    return { kind: "invalid" };
  return {
    kind: "source",
    input: { identity: { id, version, digest }, step, group, sourceDigest },
  };
}
export function assistantLibrarySourcePath(
  input: AssistantLibraryAssociation,
): string {
  return `/templates?${new URLSearchParams({ assistantId: input.identity.id, assistantVersion: input.identity.version, assistantDigest: input.identity.digest, assistantStep: input.step, assistantGroup: input.group, sourceDigest: input.sourceDigest })}`;
}

const origins = new Set<TemplateCatalogOrigin>([
  "all",
  "builtin",
  "imported",
  "custom",
  "unknown",
]);
const sorts = new Set<TemplateCatalogSort>([
  "name-asc",
  "name-desc",
  "updated-desc",
  "updated-asc",
]);

export function parseTemplateCatalogRouteState(
  params: URLSearchParams,
): TemplateCatalogRouteState {
  const origin = params.get("origin") as TemplateCatalogOrigin | null;
  const sort = params.get("sort") as TemplateCatalogSort | null;
  const type =
    params.get("type") === "building-blocks" ? "building-blocks" : "documents";
  return {
    type,
    tag: type === "building-blocks" ? params.get("tag") || null : null,
    search: params.get("q") ?? "",
    origin: origin && origins.has(origin) ? origin : "all",
    sort: sort && sorts.has(sort) ? sort : "name-asc",
  };
}

export function templateCatalogRouteSearch(
  state: TemplateCatalogRouteState,
  previous: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  // This route owns only its filters. Retain assistant links and view state.
  const params = new URLSearchParams(previous);
  for (const key of ["q", "origin", "sort", "type", "tag"]) params.delete(key);
  if (state.search) params.set("q", state.search);
  if (state.origin !== "all") params.set("origin", state.origin);
  if (state.sort !== "name-asc") params.set("sort", state.sort);
  if (state.type === "building-blocks") {
    params.set("type", state.type);
    if (state.tag) params.set("tag", state.tag);
  }
  return params;
}

export function mergeTemplateCatalogRows(
  suggestions: readonly TemplateSuggestionMenuItem[],
  nativeSources: readonly TemplateCatalogNativeSource[],
): TemplateCatalogRow[] {
  const nativeById = new Map(
    nativeSources.map((source) => [source.docId, source]),
  );
  const usedDocIds = new Set<string>();
  const rows: TemplateCatalogRow[] = suggestions
    .filter((item) => item.category !== "onboarding")
    .map((item) => {
      const native = item.templateDocId
        ? nativeById.get(item.templateDocId)
        : undefined;
      if (item.templateDocId) usedDocIds.add(item.templateDocId);
      return {
        ...mapTemplateCatalogRow(item),
        updatedAt: native?.updatedAt ?? item.updatedAt,
      } satisfies TemplateCatalogRow;
    });

  for (const source of nativeSources) {
    if (usedDocIds.has(source.docId) || source.registryBacked) continue;
    rows.push({
      key: `document:${source.docId}`,
      templateId: source.templateId ?? source.docId,
      docId: source.docId,
      title: source.title || source.docId,
      description: null,
      category: source.category ?? null,
      tags: source.tags ?? [],
      origin: source.origin === "custom" ? "custom" : "unknown",
      updatedAt: source.updatedAt,
      available: true,
      managed: false,
      registryBacked: false,
      readiness: "ready",
      readinessReasons: [],
    });
  }
  return rows;
}

/** Cloud inventory already includes custom sources and owns its stable ordering. */
export function mapTemplateCatalogRow(
  item: TemplateSuggestionMenuItem,
): TemplateCatalogRow {
  const registryBacked =
    item.origin === "builtin" || item.origin === "imported";
  return {
    key: templateSuggestionSourceKey(item),
    templateId: item.templateId,
    docId: item.templateDocId,
    title: item.title || item.templateDocId || item.templateId,
    description: item.description,
    category: item.category,
    tags: item.tags,
    origin: item.origin,
    updatedAt: item.updatedAt,
    available: item.available,
    managed: item.protectedSource,
    registryBacked,
    sourceRevisionId: item.sourceRevisionId,
    readiness: catalogReadiness(item),
    readinessReasons: item.reasons,
  };
}

export function selectTemplateCatalogRows(
  rows: readonly TemplateCatalogRow[],
  state: TemplateCatalogRouteState,
): TemplateCatalogRow[] {
  const needle = state.search.trim().toLocaleLowerCase();
  return rows
    .filter((row) => {
      if (
        (row.category === "building-blocks") !==
        (state.type === "building-blocks")
      )
        return false;
      if (
        state.type === "building-blocks" &&
        state.tag &&
        !row.tags.includes(state.tag)
      )
        return false;
      if (state.origin !== "all" && row.origin !== state.origin) return false;
      if (!needle) return true;
      return `${row.title}\n${row.description ?? ""}`
        .toLocaleLowerCase()
        .includes(needle);
    })
    .sort((left, right) => {
      const name = left.title.localeCompare(right.title, undefined, {
        sensitivity: "base",
      });
      const updated = (left.updatedAt ?? 0) - (right.updatedAt ?? 0);
      const primary =
        state.sort === "name-asc"
          ? name
          : state.sort === "name-desc"
            ? -name
            : state.sort === "updated-desc"
              ? -updated
              : updated;
      return primary || left.key.localeCompare(right.key);
    });
}
