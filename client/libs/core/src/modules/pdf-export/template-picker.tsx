import { useI18n } from "@myoxus/i18n";
import {
  Badge,
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

function capabilityTags(
  template: PdfTemplateOption,
  t: ReturnType<typeof useI18n>,
): string[] {
  const caps = template.capabilities ?? {};
  const tags = new Set<string>();
  if (caps.coverPage?.kind === "boolean") {
    tags.add(t.t("com.myoxus.pdf-export.dialog.tag.cover"));
  }
  if (Array.isArray(caps.tocBehavior?.values)) {
    tags.add(t.t("com.myoxus.pdf-export.dialog.tag.toc"));
  }
  if ((caps.confidentialityLabels?.max_items ?? 0) > 0) {
    tags.add(t.t("com.myoxus.pdf-export.dialog.tag.labels"));
  }
  if (Array.isArray(caps.language?.values)) {
    tags.add(
      t.t("com.myoxus.pdf-export.dialog.tag.locales", {
        count: caps.language.values.length.toString(),
      }),
    );
  }
  return [...tags].slice(0, 4);
}

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
                  <MyoxusText tone="secondary">
                    {template.slug} · v{template.version}
                    {template.isDefault
                      ? ` · ${t.t("com.myoxus.pdf-export.dialog.template.workspace-default")}`
                      : ""}
                  </MyoxusText>
                  <Group gap="xs" wrap="wrap">
                    {capabilityTags(template, t).map((tag) => (
                      <Badge key={tag} data-myoxus-ui-role="status-badge">
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                </Stack>
              </Group>
            </RadioCard>
          );
        })}
      </SelectionCardGrid>
    </RadioCardGroup>
  );
}
