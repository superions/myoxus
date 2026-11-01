// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TemplateDocService } from "../services/template-doc";
import { TemplateSuggestionSurface } from "../services/template-doc";
import type { TemplateCatalogRow } from "./catalog-model";

/** Recheck only this source immediately before Use; do not mutate Library state. */
export function revalidateCatalogTemplateSource(
  templateDocService: TemplateDocService,
  row: Pick<TemplateCatalogRow, "templateId" | "docId" | "registryBacked"> & {
    category?: TemplateCatalogRow["category"];
    docId: string;
    assistantSource?: TemplateCatalogRow["assistantSource"];
    sourceRevisionId?: TemplateCatalogRow["sourceRevisionId"];
  },
  locale: string,
): Promise<boolean> {
  if (row.assistantSource) {
    const source = row.assistantSource;
    return templateDocService
      .resolveAssistantDocumentSource(source.input, locale)
      .then((current) =>
        Boolean(
          current?.available &&
          current.templateId === row.templateId &&
          current.templateDocId === row.docId &&
          current.sourceRevisionId === source.sourceRevisionId,
        ),
      );
  }
  return templateDocService.revalidateTemplateSuggestion(
    row.templateId,
    row.docId,
    {
      surface:
        row.category === "building-blocks"
          ? TemplateSuggestionSurface.BuildingBlock
          : TemplateSuggestionSurface.AllPagesNewPage,
      categoryFilter: { exclude: ["onboarding"] },
      locale,
    },
    row.sourceRevisionId,
  );
}
