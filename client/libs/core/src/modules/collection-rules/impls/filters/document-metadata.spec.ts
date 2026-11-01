/**
 * @vitest-environment happy-dom
 */
import { firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, test, vi } from "vitest";
import { LiveData } from "@myoxus/infra";
import type { DocumentMetadataIndexState } from "../../../document-metadata/services/document-metadata-cache";

import {
  documentMetadataGroupLabel,
  metadataIndexDisplayValue,
  metadataLookupHydrated,
} from "../../../../components/system-property-types/document-metadata";
import { configureCollectionRulesModule } from "../../index";
import {
  documentMetadataIndexRows$,
  filterDocumentMetadataRows,
  groupDocumentMetadataRows,
  orderDocumentMetadataRows,
} from "./document-metadata";

const UUID_DEFAULT_ID = "10000000-0000-4000-8000-000000000001";
const COLLISION_EXTERNAL_ID = "10000000-0000-4000-8000-000000000002";
const nativeDefaults = {
  createdBy: null,
  updatedBy: null,
  journalDate: null,
  templateState: null,
  templateCategory: null,
  templateTags: null,
  primaryMode: null,
  pageWidth: null,
  edgelessColorTheme: null,
  integrationType: null,
  canPublish: false,
  tagIds: [] as string[],
};
const rows = [
  {
    ...nativeDefaults,
    docId: UUID_DEFAULT_ID,
    externalId: UUID_DEFAULT_ID,
    isTemplate: false,
    templateOrigin: null,
    statusId: "status-review",
    documentTypeId: "type-report",
    currentVersionId: "version-1",
    dirtySinceCurrentVersion: false,
    classificationId: "class-internal",
    reviewDueAt: "2026-05-10T00:00:00.000Z",
    validUntil: null,
  },
  {
    ...nativeDefaults,
    docId: COLLISION_EXTERNAL_ID,
    externalId: "NanoDocB",
    isTemplate: false,
    templateOrigin: null,
    statusId: "status-draft",
    documentTypeId: "type-report",
    currentVersionId: null,
    dirtySinceCurrentVersion: true,
    classificationId: "class-public",
    reviewDueAt: "2026-06-10T00:00:00.000Z",
    validUntil: "2026-12-31T00:00:00.000Z",
  },
  {
    ...nativeDefaults,
    docId: "10000000-0000-4000-8000-000000000003",
    externalId: COLLISION_EXTERNAL_ID,
    isTemplate: false,
    templateOrigin: null,
    statusId: "status-review",
    documentTypeId: "type-note",
    currentVersionId: "version-2",
    dirtySinceCurrentVersion: false,
    classificationId: null,
    reviewDueAt: null,
    validUntil: null,
  },
  {
    ...nativeDefaults,
    docId: "10000000-0000-4000-8000-000000000004",
    externalId: null,
    isTemplate: false,
    templateOrigin: null,
    statusId: "status-review",
    documentTypeId: "type-note",
    currentVersionId: null,
    dirtySinceCurrentVersion: false,
    classificationId: "class-internal",
    reviewDueAt: null,
    validUntil: null,
  },
];

describe("DocumentMetadata collection providers", () => {
  test("loads the collection-rules module registration", () => {
    expect(configureCollectionRulesModule).toBeTypeOf("function");
  });

  test("filters documents by canonical classification values from the server index", async () => {
    const result = filterDocumentMetadataRows(rows, {
      type: "system",
      key: "classification",
      method: "is",
      value: "class-internal",
    });

    expect([...result]).toEqual([UUID_DEFAULT_ID]);
  });

  test("groups documents by canonical status values from the server index", async () => {
    const result = groupDocumentMetadataRows(
      rows,
      new Set([UUID_DEFAULT_ID, "NanoDocB"]),
      {
        type: "system",
        key: "status",
      },
    );

    expect([...(result.get("status-review") ?? [])].sort()).toEqual([
      UUID_DEFAULT_ID,
    ]);
    expect([...(result.get("status-draft") ?? [])]).toEqual(["NanoDocB"]);
    expect(result.has("")).toBe(false);
  });

  test("orders documents by canonical date values from the server index", async () => {
    const result = orderDocumentMetadataRows(
      rows,
      new Set([UUID_DEFAULT_ID, "NanoDocB"]),
      {
        type: "system",
        key: "reviewDueAt",
      },
    );

    expect(result).toEqual([UUID_DEFAULT_ID, "NanoDocB"]);
  });

  test("uses only browser external ids for NanoID, collision and missing-map rows", () => {
    const filtered = filterDocumentMetadataRows(rows, {
      type: "system",
      key: "classification",
      method: "is",
      value: "class-internal",
    });
    expect([...filtered]).toEqual([UUID_DEFAULT_ID]);
  });

  test("uses a hydrated empty server index instead of stale cached rows", async () => {
    const cacheService = {
      hydrateIndex: vi.fn(async () => []),
      watchIndexState: vi.fn(
        () =>
          new LiveData({
            phase: "ready" as const,
            rows: [],
            error: null,
            generation: 0,
          }),
      ),
    };

    await expect(
      firstValueFrom(documentMetadataIndexRows$(cacheService as never)),
    ).resolves.toEqual([]);
  });

  test("keeps collection rules reactive to later index generations", async () => {
    const state = new LiveData<DocumentMetadataIndexState>({
      phase: "ready" as const,
      rows: rows.slice(0, 1),
      error: null,
      generation: 0,
    });
    const watchIndexState = vi.fn(() => state);
    const values = firstValueFrom(
      documentMetadataIndexRows$({
        hydrateIndex: vi.fn(async () => rows.slice(0, 1)),
        watchIndexState,
      } as never).pipe(take(2), toArray()),
    );

    await vi.waitFor(() => expect(watchIndexState).toHaveBeenCalledOnce());

    state.next({
      phase: "ready",
      rows: rows.slice(0, 2),
      error: null,
      generation: 1,
    });

    await expect(values).resolves.toEqual([rows.slice(0, 1), rows.slice(0, 2)]);
  });

  test("keeps a failed first load pending until retry provides confirmed rows", async () => {
    const failure = new Error("index unavailable");
    const state = new LiveData<DocumentMetadataIndexState>({
      phase: "loading" as const,
      rows: [],
      error: null,
      generation: 0,
    });
    const hydrateIndex = vi.fn(async () => {
      state.next({
        phase: "error",
        rows: [],
        error: failure,
        generation: 0,
      });
      throw failure;
    });
    const value = firstValueFrom(
      documentMetadataIndexRows$({
        hydrateIndex,
        watchIndexState: vi.fn(() => state),
      } as never),
    );

    await vi.waitFor(() => expect(hydrateIndex).toHaveBeenCalledOnce());
    state.next({
      phase: "ready",
      rows: rows.slice(0, 1),
      error: null,
      generation: 1,
    });

    await expect(value).resolves.toEqual(rows.slice(0, 1));
  });

  test("projects index ids to labels for document-list values without leaking raw ids", () => {
    const lookups = {
      statusLabels: { "status-review": "Review" },
      documentTypeLabels: { "type-report": "Report" },
      classificationLabels: { "class-internal": "Internal" },
      versionLabels: { "version-1": "v1" },
      hydratedKeys: {
        status: true,
        documentType: true,
        classification: true,
      },
    };

    expect(metadataIndexDisplayValue(rows[0], "status", lookups)).toBe(
      "Review",
    );
    expect(metadataIndexDisplayValue(rows[0], "documentType", lookups)).toBe(
      "Report",
    );
    expect(metadataIndexDisplayValue(rows[0], "classification", lookups)).toBe(
      "Internal",
    );
    expect(metadataIndexDisplayValue(rows[0], "version", lookups)).toBe("v1");
    expect(
      metadataIndexDisplayValue(
        { ...rows[0], dirtySinceCurrentVersion: true },
        "version",
        lookups,
      ),
    ).toBe("v1 (changed)");
    expect(metadataIndexDisplayValue(rows[2], "status", lookups)).toBe(
      "Review",
    );
    expect(
      metadataIndexDisplayValue(rows[2], "documentType", lookups),
    ).toBeNull();
  });

  test("projects group ids to labels and never displays unresolved raw ids", () => {
    const lookups = {
      statusLabels: { "status-review": "Review" },
      documentTypeLabels: {},
      classificationLabels: {},
      versionLabels: {},
      hydratedKeys: { status: true },
    };

    expect(documentMetadataGroupLabel("status-review", "status", lookups)).toBe(
      "Review",
    );
    expect(documentMetadataGroupLabel("status-draft", "status", lookups)).toBe(
      "Loading",
    );
    expect(
      documentMetadataGroupLabel("type-report", "documentType", lookups),
    ).not.toBe("type-report");
    expect(documentMetadataGroupLabel("", "classification", lookups)).toBe(
      "Not set",
    );
  });

  test("tracks lookup hydration per metadata family instead of any non-empty label map", () => {
    const lookups = {
      statusLabels: { "status-review": "Review" },
      documentTypeLabels: {},
      classificationLabels: {},
      versionLabels: {},
      hydratedKeys: { status: true },
    };

    expect(metadataLookupHydrated("status", lookups)).toBe(true);
    expect(metadataLookupHydrated("documentType", lookups)).toBe(false);
    expect(metadataLookupHydrated("classification", lookups)).toBe(false);
    expect(metadataLookupHydrated("reviewDueAt", lookups)).toBe(true);
    expect(metadataLookupHydrated("version", lookups)).toBe(true);
  });
});
