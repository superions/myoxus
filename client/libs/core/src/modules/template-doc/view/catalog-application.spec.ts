// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { expect, test, vi } from "vitest";

import type { TemplateDocService } from "../services/template-doc";
import { TemplateSuggestionSurface } from "../services/template-doc";
import { revalidateCatalogTemplateSource } from "./catalog-application";

test("Library Use revalidates picker eligibility for the selected source", async () => {
  const revalidateTemplateSuggestion = vi.fn(async () => false);
  const eligible = await revalidateCatalogTemplateSource(
    { revalidateTemplateSuggestion } as unknown as TemplateDocService,
    {
      templateId: "meeting-focus",
      docId: "source-doc",
      registryBacked: true,
      sourceRevisionId: "revision-one",
    },
    "de",
  );

  expect(eligible).toBe(false);
  expect(revalidateTemplateSuggestion).toHaveBeenCalledWith(
    "meeting-focus",
    "source-doc",
    {
      surface: TemplateSuggestionSurface.AllPagesNewPage,
      categoryFilter: { exclude: ["onboarding"] },
      locale: "de",
    },
    "revision-one",
  );
});

test("linked Library Use must re-read the exact source revision instead of latest picker eligibility", async () => {
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
  const resolveAssistantDocumentSource = vi.fn().mockResolvedValue({
    templateId: "registry-id",
    templateDocId: "source-doc",
    sourceRevisionId: "revision-one",
    available: true,
  });
  const revalidateTemplateSuggestion = vi.fn();
  const service = {
    resolveAssistantDocumentSource,
    revalidateTemplateSuggestion,
  } as unknown as TemplateDocService;
  const row = {
    templateId: "registry-id",
    docId: "source-doc",
    registryBacked: true,
    assistantSource: { input, sourceRevisionId: "revision-one" },
  };
  expect(await revalidateCatalogTemplateSource(service, row, "fr")).toBe(true);
  expect(resolveAssistantDocumentSource).toHaveBeenCalledWith(input, "fr");
  for (const changed of [
    { sourceRevisionId: "revision-two" },
    { templateId: "other" },
    { templateDocId: "other" },
    { available: false },
  ]) {
    resolveAssistantDocumentSource.mockResolvedValue({
      templateId: row.templateId,
      templateDocId: row.docId,
      sourceRevisionId: "revision-one",
      available: true,
      ...changed,
    });
    expect(await revalidateCatalogTemplateSource(service, row, "fr")).toBe(
      false,
    );
  }
  resolveAssistantDocumentSource.mockResolvedValue(null);
  expect(await revalidateCatalogTemplateSource(service, row, "fr")).toBe(false);
  expect(revalidateTemplateSuggestion).not.toHaveBeenCalled();
});
