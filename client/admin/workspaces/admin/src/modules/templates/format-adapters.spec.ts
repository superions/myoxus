import { TemplateSourceType, TemplateStatusType } from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import { adaptCatalogEntry } from "./format-adapters";

// adaptCatalogEntry

describe("adaptCatalogEntry", () => {
  const raw = {
    id: "tpl-1",
    slug: "weekly-standup",
    title: "Weekly Standup",
    description: "A weekly meeting template",
    category: "work",
    tags: ["team", "sync"],
    status: TemplateStatusType.Active,
    source: TemplateSourceType.Bundle,
    minClientVersion: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    archivedAt: null,
  };

  test("falls back to TemplateSourceType.Bundle when source is missing", () => {
    const withoutSource = {
      ...raw,
      source: undefined as unknown as TemplateSourceType,
    };
    const vm = adaptCatalogEntry(withoutSource);
    expect(vm.source).toBe(TemplateSourceType.Bundle);
  });
});

// adaptAssignment

// adaptRevision

// adaptJob

// adaptDefaultPolicy
