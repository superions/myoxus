import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import type { DocumentMetadataFieldsFragment } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  FormSelect,
  SettingsField,
  SettingsFieldGroup,
  SettingsNotice,
} from "@myoxus/ui-facade";
import { useId } from "react";

import type {
  PdfDocumentVersioningSettings,
  PdfDocumentVersionOption,
} from "./types";

export const LATEST_DOCUMENT_VERSION = "latest";

export function PdfDocumentVersionPicker({
  documentMetadata,
  settings,
  versions,
  value,
  onChange,
}: {
  documentMetadata?: DocumentMetadataFieldsFragment;
  settings: PdfDocumentVersioningSettings;
  versions: PdfDocumentVersionOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const selectId = useId();
  if (!settings.enabled) return null;

  const autoVersionOnPdfExport =
    settings.autoVersionOn.includes("on_pdf_export") ||
    settings.autoVersionOn.includes("on-pdf-export");
  const latestSelected = value === LATEST_DOCUMENT_VERSION;
  const currentVersionLabel = documentMetadata?.fields.find(
    (field) => field.key === "version",
  )?.reference?.label;

  return (
    <section
      aria-label={t.t("com.myoxus.pdf-export.dialog.version-picker.aria-label")}
    >
      <SettingsFieldGroup>
        <SettingsField
          description={
            currentVersionLabel
              ? t.t(
                  "com.myoxus.pdf-export.dialog.version-picker.help-current",
                  {
                    label: currentVersionLabel,
                  },
                )
              : t.t("com.myoxus.pdf-export.dialog.version-picker.help")
          }
          label={t.t("com.myoxus.pdf-export.dialog.version-picker.label")}
          labelFor={selectId}
        >
          <FormSelect
            aria-label={t.t(
              "com.myoxus.pdf-export.dialog.version-picker.label",
            )}
            data={[
              {
                value: LATEST_DOCUMENT_VERSION,
                label: t.t(
                  "com.myoxus.pdf-export.dialog.version-picker.latest",
                ),
              },
              ...versions.map((version) => ({
                value: version.id,
                label: `${version.label} · ${formatDateTime(version.createdAt)}${
                  version.isPinned
                    ? ` · ${t.t("com.myoxus.pdf-export.dialog.version-picker.pinned")}`
                    : ""
                }`,
              })),
            ]}
            id={selectId}
            value={value}
            onChange={onChange}
          />
        </SettingsField>
        {latestSelected && autoVersionOnPdfExport ? (
          <SettingsNotice tone="info">
            {t.t("com.myoxus.pdf-export.dialog.version-picker.auto-version")}
          </SettingsNotice>
        ) : null}
      </SettingsFieldGroup>
    </section>
  );
}
