import type { DocumentMetadataIndexQuery } from "@myoxus/graphql";
import { Service } from "@myoxus/infra";
import { combineLatest, map, type Observable } from "rxjs";

import {
  observeConfirmedDocumentMetadataIndex,
  type DocumentMetadataCacheService,
} from "../../../document-metadata/services/document-metadata-cache";
import type {
  FilterProvider,
  GroupByProvider,
  OrderByProvider,
} from "../../provider";
import type { FilterParams, GroupByParams, OrderByParams } from "../../types";

type IndexRow = DocumentMetadataIndexQuery["documentMetadataIndex"][number];

type MetadataField = keyof Pick<
  IndexRow,
  | "statusId"
  | "documentTypeId"
  | "currentVersionId"
  | "classificationId"
  | "reviewDueAt"
  | "validUntil"
>;

const FIELD_BY_KEY: Record<string, MetadataField> = {
  status: "statusId",
  documentType: "documentTypeId",
  version: "currentVersionId",
  classification: "classificationId",
  reviewDueAt: "reviewDueAt",
  validUntil: "validUntil",
};

function fieldFor(params: { key: string }): MetadataField {
  const field = FIELD_BY_KEY[params.key];
  if (!field)
    throw new Error(`Unsupported document metadata key: ${params.key}`);
  return field;
}

function compareDate(value: string | null | undefined, expected?: string) {
  if (!value || !expected) return 0;
  return Date.parse(value) - Date.parse(expected);
}

export function matchesDocumentMetadataFilter(
  row: IndexRow,
  field: MetadataField,
  params: FilterParams,
) {
  const value = row[field] ?? null;
  switch (params.method) {
    case "is":
      return value === (params.value ?? null);
    case "is-not":
      return value !== (params.value ?? null);
    case "is-empty":
      return value === null || value === "";
    case "is-not-empty":
      return value !== null && value !== "";
    case "before":
      return compareDate(value, params.value) < 0;
    case "after":
      return compareDate(value, params.value) > 0;
    default:
      throw new Error(
        `Unsupported document metadata filter method: ${params.method}`,
      );
  }
}

export function filterDocumentMetadataRows(
  rows: IndexRow[],
  params: FilterParams,
): Set<string> {
  const field = fieldFor(params);
  return new Set(
    rows
      .filter(
        (row): row is IndexRow & { externalId: string } =>
          row.externalId !== null &&
          matchesDocumentMetadataFilter(row, field, params),
      )
      .map((row) => row.externalId),
  );
}

export function groupDocumentMetadataRows(
  rows: IndexRow[],
  items: Set<string>,
  params: GroupByParams,
): Map<string, Set<string>> {
  const field = fieldFor(params);
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.externalId === null || !items.has(row.externalId)) continue;
    const group = String(row[field] ?? "");
    const docs = result.get(group) ?? new Set<string>();
    docs.add(row.externalId);
    result.set(group, docs);
  }
  return result;
}

export function orderDocumentMetadataRows(
  rows: IndexRow[],
  items: Set<string>,
  params: OrderByParams,
): string[] {
  const field = fieldFor(params);
  return [...rows]
    .filter(
      (row): row is IndexRow & { externalId: string } =>
        row.externalId !== null && items.has(row.externalId),
    )
    .sort((a, b) => {
      const left = String(a[field] ?? "");
      const right = String(b[field] ?? "");
      return params.desc
        ? right.localeCompare(left)
        : left.localeCompare(right);
    })
    .map((row) => row.externalId);
}

export function documentMetadataIndexRows$(
  cacheService: Pick<
    DocumentMetadataCacheService,
    "hydrateIndex" | "watchIndexState"
  >,
): Observable<IndexRow[]> {
  return observeConfirmedDocumentMetadataIndex(cacheService).pipe(
    map((state) => state.rows),
  );
}

export class DocumentMetadataIndexReader extends Service {
  constructor(private readonly cacheService: DocumentMetadataCacheService) {
    super();
  }

  rows$(): Observable<IndexRow[]> {
    return documentMetadataIndexRows$(this.cacheService);
  }
}

export class DocumentMetadataFilterProvider
  extends Service
  implements FilterProvider
{
  constructor(private readonly indexReader: DocumentMetadataIndexReader) {
    super();
  }

  filter$(params: FilterParams): Observable<Set<string>> {
    return this.indexReader
      .rows$()
      .pipe(map((rows) => filterDocumentMetadataRows(rows, params)));
  }
}

export class DocumentMetadataGroupByProvider
  extends Service
  implements GroupByProvider
{
  constructor(private readonly indexReader: DocumentMetadataIndexReader) {
    super();
  }

  groupBy$(
    items$: Observable<Set<string>>,
    params: GroupByParams,
  ): Observable<Map<string, Set<string>>> {
    return combineLatest([this.indexReader.rows$(), items$]).pipe(
      map(([rows, items]) => groupDocumentMetadataRows(rows, items, params)),
    );
  }
}

export class DocumentMetadataOrderByProvider
  extends Service
  implements OrderByProvider
{
  constructor(private readonly indexReader: DocumentMetadataIndexReader) {
    super();
  }

  orderBy$(
    items$: Observable<Set<string>>,
    params: OrderByParams,
  ): Observable<string[]> {
    return combineLatest([this.indexReader.rows$(), items$]).pipe(
      map(([rows, items]) => orderDocumentMetadataRows(rows, items, params)),
    );
  }
}
