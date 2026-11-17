import { useI18n } from "@myoxus/i18n";
import {
  Group,
  MyoxusText,
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  SelectionCardGrid,
  Stack,
} from "@myoxus/ui-facade";

import { PdfTemplatePreviewThumbnail } from "./template-preview-thumbnail";
import type { PdfTemplateOption } from "./types";

export function PdfTemplatePicker({
  templates,
  selectedTemplateId,
  loadPreviewPdf,
  onSelect,
}: {
  templates: PdfTemplateOption[];
  selectedTemplateId: string | null;
  loadPreviewPdf?: (template: PdfTemplateOption) => Promise<string | null>;
  onSelect: (template: PdfTemplateOption) => void;
}) {
  const t = useI18n();
  return (
    <RadioCardGroup
      value={selectedTemplateId}
      onChange={(templateId) => {
        const template = templates.find((entry) => entry.id === templateId);
        if (template) onSelect(template);
      }}
      label={t.t("com.myoxus.pdf-export.dialog.templates.aria-label")}
    >
      <SelectionCardGrid data-myoxus-ui-role="pdf-template-selection-grid">
        {templates.map((template) => {
          return (
            <RadioCard
              key={template.id}
              value={template.id}
              selected={selectedTemplateId === template.id}
              data-myoxus-ui-role="pdf-template-selection-card"
            >
              <Group align="flex-start" wrap="nowrap">
                <PdfTemplatePreviewThumbnail
                  templateId={template.id}
                  templateName={template.name}
                  loadPreviewPdf={
                    loadPreviewPdf ? () => loadPreviewPdf(template) : undefined
                  }
                />
                <Stack flex={1} gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <MyoxusText typographySlot="nav">
                      {template.name}
                    </MyoxusText>
                    <RadioCardIndicator />
                  </Group>
                  {template.isDefault ? (
                    <MyoxusText tone="secondary">
                      {t.t(
                        "com.myoxus.pdf-export.dialog.template.workspace-default",
                      )}
                    </MyoxusText>
                  ) : null}
                </Stack>
              </Group>
            </RadioCard>
          );
        })}
      </SelectionCardGrid>
    </RadioCardGroup>
  );
}
