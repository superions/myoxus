/**
 * @vitest-environment happy-dom
 */
import { TemplateSuggestionReason } from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import {
  nativeSourceMetadata,
  type ResolvedTemplateSourceMetadata,
} from "../services/source-metadata";

import type { DocRecord } from "../../../modules/doc";
import {
  applyCategoryFilter,
  mapTemplateSuggestionResult,
  TemplateSuggestionSurface,
} from "../services/template-doc";

const fakeDoc = (id: string): DocRecord => ({ id }) as unknown as DocRecord;

const userDoc = fakeDoc("user-doc-1");
const userDoc2 = fakeDoc("user-doc-2");
const businessDailyDoc = fakeDoc("doc-business-daily");
const meetingDoc = fakeDoc("doc-meeting-agenda");
const welcomeDoc = fakeDoc("doc-welcome-myoxus");
const gettingStartedDoc = fakeDoc("doc-getting-started-myoxus");
const usingFoldersDoc = fakeDoc("doc-using-folders-myoxus");

const instanceMap: Record<string, ResolvedTemplateSourceMetadata> = {};
for (const [slug, docId] of Object.entries({
  "business-daily": businessDailyDoc.id,
  "meeting-agenda": meetingDoc.id,
  "welcome-myoxus": welcomeDoc.id,
  "getting-started-myoxus": gettingStartedDoc.id,
  "using-folders-myoxus": usingFoldersDoc.id,
})) {
  const metadata = nativeSourceMetadata(slug);
  if (!metadata) throw new Error("Missing test source metadata");
  instanceMap[docId] = metadata;
}
const meetingGuideDoc = fakeDoc("doc-meeting-templates-myoxus");
const databaseGuideDoc = fakeDoc("doc-databases-guide-myoxus");
for (const [slug, doc] of [
  ["meeting-templates-myoxus", meetingGuideDoc],
  ["databases-guide-myoxus", databaseGuideDoc],
] as const) {
  const metadata = nativeSourceMetadata(slug);
  if (!metadata) throw new Error("Missing test guide metadata");
  instanceMap[doc.id] = metadata;
}

const allDocs: DocRecord[] = [
  meetingGuideDoc,
  databaseGuideDoc,
  userDoc,
  userDoc2,
  businessDailyDoc,
  meetingDoc,
  welcomeDoc,
  gettingStartedDoc,
  usingFoldersDoc,
];

describe("applyCategoryFilter", () => {
  test("include: ['journal-daily'] keeps only the business-daily journal builtin", () => {
    const filtered = applyCategoryFilter(allDocs, instanceMap, {
      include: ["journal-daily"],
    });
    expect(filtered.map((d) => d.id)).toEqual(["doc-business-daily"]);
  });

  test("include: ['onboarding'] keeps onboarding builtins and nothing else", () => {
    const filtered = applyCategoryFilter(allDocs, instanceMap, {
      include: ["onboarding"],
    });
    expect(filtered.map((d) => d.id).sort()).toEqual([
      "doc-databases-guide-myoxus",
      "doc-getting-started-myoxus",
      "doc-meeting-templates-myoxus",
      "doc-using-folders-myoxus",
      "doc-welcome-myoxus",
    ]);
  });

  test("include drops user-created docs that have no slug → no category", () => {
    const filtered = applyCategoryFilter(allDocs, instanceMap, {
      include: ["meeting"],
    });
    expect(filtered.map((d) => d.id)).toEqual(["doc-meeting-agenda"]);
    expect(filtered.map((d) => d.id)).not.toContain(userDoc.id);
  });

  test("exclude: ['onboarding'] removes onboarding builtins but keeps user docs", () => {
    const filtered = applyCategoryFilter(allDocs, instanceMap, {
      exclude: ["onboarding"],
    });
    expect(filtered.map((d) => d.id).sort()).toEqual([
      "doc-business-daily",
      "doc-meeting-agenda",
      "user-doc-1",
      "user-doc-2",
    ]);
  });

  test("exclude: [] is a no-op", () => {
    const filtered = applyCategoryFilter(allDocs, instanceMap, {
      exclude: [],
    });
    expect(filtered).toHaveLength(allDocs.length);
  });

  test("exclude treats unknown-category docs (user-created) as pass-through", () => {
    const filtered = applyCategoryFilter([userDoc, welcomeDoc], instanceMap, {
      exclude: ["onboarding"],
    });
    expect(filtered.map((d) => d.id)).toEqual([userDoc.id]);
  });

  test("empty instanceMap means every doc is treated as user-created", () => {
    const includeFiltered = applyCategoryFilter(
      allDocs,
      {},
      {
        include: ["journal-daily"],
      },
    );
    expect(includeFiltered).toHaveLength(0);

    const excludeFiltered = applyCategoryFilter(
      allDocs,
      {},
      {
        exclude: ["onboarding"],
      },
    );
    expect(excludeFiltered).toHaveLength(allDocs.length);
  });
});

describe("mapTemplateSuggestionResult", () => {
  test("maps server-ranked template suggestions without mutating availability", () => {
    const result = mapTemplateSuggestionResult(
      TemplateSuggestionSurface.SidebarNewPage,
      {
        emptyDocumentAllowed: true,
        reconcileRequired: true,
        stale: false,
        hasNextPage: false,
        endCursor: null,
        items: [
          {
            templateId: "builtin-daily",
            templateDocId: "doc-daily",
            slug: "business-daily",
            title: "Business daily",
            description: "Daily journal",
            source: "builtin",
            titlePolicy: null,
            sourceRevisionId: null,
            updatedAt: "2026-09-12T10:00:00Z",
            category: "journal-daily",
            tags: ["document-type:daily"],
            score: 123,
            reasons: [
              TemplateSuggestionReason.WorkspacePolicy,
              TemplateSuggestionReason.InstanceOk,
            ],
            instanceState: "ok",
            available: true,
            protectedSource: false,
          },
          {
            templateId: "builtin-missing",
            templateDocId: null,
            slug: "missing",
            title: "Missing",
            description: null,
            source: "bundle",
            titlePolicy: "template",
            sourceRevisionId: "bundle-revision",
            updatedAt: "2026-09-11T10:00:00Z",
            category: null,
            tags: [],
            score: 1,
            reasons: [TemplateSuggestionReason.ReconcileRequired],
            instanceState: null,
            available: false,
            protectedSource: false,
          },
        ],
      },
    );

    expect(result.status).toBe("ready");
    expect(result.surface).toBe(TemplateSuggestionSurface.SidebarNewPage);
    expect(result.reconcileRequired).toBe(true);
    expect(result.items).toEqual([
      expect.objectContaining({
        templateId: "builtin-daily",
        templateDocId: "doc-daily",
        origin: "builtin",
        available: true,
        reasons: ["WorkspacePolicy", "InstanceOk"],
      }),
      expect.objectContaining({
        templateId: "builtin-missing",
        templateDocId: null,
        origin: "imported",
        available: false,
        reasons: ["ReconcileRequired"],
      }),
    ]);
  });

  test("treats an absent workspace result as an empty server-owned suggestion set", () => {
    const result = mapTemplateSuggestionResult(
      TemplateSuggestionSurface.AllPagesNewPage,
      null,
    );

    expect(result).toMatchObject({
      status: "ready",
      surface: TemplateSuggestionSurface.AllPagesNewPage,
      items: [],
      emptyDocumentAllowed: true,
      reconcileRequired: false,
      stale: false,
      error: null,
    });
  });
});
