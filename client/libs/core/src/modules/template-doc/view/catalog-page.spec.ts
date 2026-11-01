// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import type { TemplateSuggestionMenuItem } from "../services/template-doc";
import {
  mergeTemplateCatalogRows,
  assistantLibrarySourcePath,
  parseAssistantLibraryRoute,
  parseTemplateCatalogRouteState,
  selectTemplateCatalogRows,
  templateCatalogRouteSearch,
} from "./catalog-model";

const suggestion = (
  templateId: string,
  origin: TemplateSuggestionMenuItem["origin"],
  category: string | null = null,
): TemplateSuggestionMenuItem => ({
  templateId,
  templateDocId: `doc-${templateId}`,
  title: templateId,
  description: `${templateId} description`,
  origin,
  updatedAt: 100,
  category,
  tags: category ? [category] : [],
  score: 0,
  reasons: [],
  instanceState: "ok",
  available: true,
  protectedSource: true,
});

describe("template catalog model", () => {
  test("keeps authoritative origins and leaves unproven native sources unknown", () => {
    const rows = mergeTemplateCatalogRows(
      [
        suggestion("builtin", "builtin", "meeting"),
        suggestion("imported", "imported", "building-blocks"),
        suggestion("welcome", "builtin", "onboarding"),
      ],
      [
        {
          docId: "doc-builtin",
          title: "Builtin",
          updatedAt: 200,
          templateId: "builtin",
          origin: undefined,
        },
        {
          docId: "custom",
          title: "Custom",
          updatedAt: 300,
          templateId: null,
          origin: "custom",
        },
        {
          docId: "unresolved",
          title: "Unresolved",
          updatedAt: null,
          templateId: undefined,
          origin: undefined,
        },
        {
          docId: "wrong-surface-registry-source",
          title: "Assigned source omitted by the authoritative surface",
          updatedAt: null,
          templateId: "registry-source",
          origin: undefined,
          registryBacked: true,
        },
      ],
    );

    expect(
      rows.map(({ templateId, origin, managed, category, tags }) => ({
        templateId,
        origin,
        managed,
        category,
        tags,
      })),
    ).toEqual([
      {
        templateId: "builtin",
        origin: "builtin",
        managed: true,
        category: "meeting",
        tags: ["meeting"],
      },
      {
        templateId: "imported",
        origin: "imported",
        managed: true,
        category: "building-blocks",
        tags: ["building-blocks"],
      },
      {
        templateId: "custom",
        origin: "custom",
        managed: false,
        category: null,
        tags: [],
      },
      {
        templateId: "unresolved",
        origin: "unknown",
        managed: false,
        category: null,
        tags: [],
      },
    ]);
  });

  test("round-trips list context and filters the complete supplied inventory", () => {
    const state = parseTemplateCatalogRouteState(
      new URLSearchParams("q=alp&origin=custom&sort=updated-desc"),
    );
    expect(templateCatalogRouteSearch(state).toString()).toBe(
      "q=alp&origin=custom&sort=updated-desc",
    );

    const rows = mergeTemplateCatalogRows(
      [suggestion("alpha-block", "custom", "building-blocks")],
      [
        {
          docId: "alpha",
          title: "Alpha",
          updatedAt: 20,
          templateId: null,
          origin: "custom",
        },
        {
          docId: "beta",
          title: "Beta",
          updatedAt: 10,
          templateId: null,
          origin: "custom",
        },
      ],
    );
    expect(
      selectTemplateCatalogRows(rows, state).map((row) => row.docId),
    ).toEqual(["alpha"]);

    const blocks = parseTemplateCatalogRouteState(
      new URLSearchParams(
        "q=alp&origin=custom&sort=updated-desc&type=building-blocks&tag=building-blocks",
      ),
    );
    expect(
      selectTemplateCatalogRows(rows, blocks).map((row) => row.templateId),
    ).toEqual(["alpha-block"]);
    expect(templateCatalogRouteSearch(blocks).toString()).toBe(
      "q=alp&origin=custom&sort=updated-desc&type=building-blocks&tag=building-blocks",
    );
  });

  test("preserves Registry readiness reasons and explicit source protection", () => {
    const missing = {
      ...suggestion("missing", "imported"),
      templateDocId: null,
      available: false,
      reasons: ["ReconcileRequired", "SourceMissing"],
      protectedSource: false,
    };
    const restricted = {
      ...suggestion("restricted", "builtin"),
      templateDocId: null,
      title: "",
      available: false,
      reasons: ["AccessDenied", "Redacted"],
      protectedSource: true,
    };

    const rows = mergeTemplateCatalogRows([missing, restricted], []);

    expect(
      rows.map(({ readiness, readinessReasons, managed }) => ({
        readiness,
        readinessReasons,
        managed,
      })),
    ).toEqual([
      {
        readiness: "source-missing",
        readinessReasons: ["ReconcileRequired", "SourceMissing"],
        managed: false,
      },
      {
        readiness: "access-denied",
        readinessReasons: ["AccessDenied", "Redacted"],
        managed: true,
      },
    ]);
  });
});

test("qualified Library links round-trip and malformed associations never become ordinary inventory", () => {
  const input = {
    identity: {
      id: "example.project",
      version: "1.0.0",
      digest: "a".repeat(64),
    },
    step: "setup",
    group: "guides",
    sourceDigest: "b".repeat(64),
  };
  const url = new URL(
    assistantLibrarySourcePath(input),
    "https://workspace.example",
  );
  expect(parseAssistantLibraryRoute(url.searchParams)).toEqual({
    kind: "source",
    input,
  });
  const filtered = templateCatalogRouteSearch(
    {
      ...parseTemplateCatalogRouteState(url.searchParams),
      type: "building-blocks",
      tag: "technical-projects",
    },
    url.searchParams,
  );
  expect(parseAssistantLibraryRoute(filtered)).toEqual({
    kind: "source",
    input,
  });
  expect(parseAssistantLibraryRoute(new URLSearchParams("q=project"))).toEqual({
    kind: "none",
  });
  for (const key of url.searchParams.keys()) {
    const partial = new URLSearchParams(url.searchParams);
    partial.delete(key);
    expect(parseAssistantLibraryRoute(partial)).toEqual({ kind: "invalid" });
  }
  url.searchParams.append("assistantId", input.identity.id);
  expect(parseAssistantLibraryRoute(url.searchParams)).toEqual({
    kind: "invalid",
  });
});
