import { type I18nFuncs, useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Checkbox,
  ErrorMessage,
  FormSelect,
  MyoxusText,
  SettingsField,
  SettingsFieldGroup,
  SettingsNotice,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

import type {
  DocumentBrandingProfile,
  PdfExportDialogFormValue,
  PdfExportSettings,
  PdfTemplateCapabilities,
  PdfTemplateInputsSchemaProperty,
  PdfTemplateOption,
} from "./types";

type FieldConfig = {
  key: keyof PdfExportDialogFormValue;
  labelKey: keyof I18nFuncs;
  helpKey: keyof I18nFuncs;
  kind: "select" | "boolean" | "json";
  values: (ctx: CapabilityFormContext) => string[];
  enabled: (ctx: CapabilityFormContext) => boolean;
};

type CapabilityFormContext = {
  capabilities: PdfTemplateCapabilities;
  settings: PdfExportSettings;
  brandingProfile: DocumentBrandingProfile;
};

const PAPER_SIZES = ["A4", "Letter", "A3", "A5"];
const ORIENTATIONS = ["portrait", "landscape"];
const IMAGE_QUALITIES = ["low", "med", "high", "lossless"];
const COMPLIANCE_PROFILES = [
  "pdfa-2u",
  "standard",
  "pdfa-1b",
  "pdfa-2b",
  "pdfa-3b",
  "pdfua-1",
];

const FIELD_CONFIG: FieldConfig[] = [
  {
    key: "locale",
    labelKey: "com.myoxus.pdf-export.dialog.field.locale",
    helpKey: "com.myoxus.pdf-export.dialog.field.locale.help",
    kind: "select",
    values: ({ capabilities }) => capabilities.language?.values ?? ["en"],
    enabled: ({ capabilities }) => Array.isArray(capabilities.language?.values),
  },
  {
    key: "paperSize",
    labelKey: "com.myoxus.pdf-export.dialog.field.paper-size",
    helpKey: "com.myoxus.pdf-export.dialog.field.paper-size.help",
    kind: "select",
    values: ({ capabilities }) => capabilities.paperSize?.values ?? PAPER_SIZES,
    enabled: () => true,
  },
  {
    key: "orientation",
    labelKey: "com.myoxus.pdf-export.dialog.field.orientation",
    helpKey: "com.myoxus.pdf-export.dialog.field.orientation.help",
    kind: "select",
    values: () => ORIENTATIONS,
    enabled: () => true,
  },
  {
    key: "imageQuality",
    labelKey: "com.myoxus.pdf-export.dialog.field.image-quality",
    helpKey: "com.myoxus.pdf-export.dialog.field.image-quality.help",
    kind: "select",
    values: () => IMAGE_QUALITIES,
    enabled: () => true,
  },
  {
    key: "complianceProfile",
    labelKey: "com.myoxus.pdf-export.dialog.field.compliance-profile",
    helpKey: "com.myoxus.pdf-export.dialog.field.compliance-profile.help",
    kind: "select",
    values: () => COMPLIANCE_PROFILES,
    enabled: () => true,
  },
  {
    key: "tocBehavior",
    labelKey: "com.myoxus.pdf-export.dialog.field.toc",
    helpKey: "com.myoxus.pdf-export.dialog.field.toc.help",
    kind: "select",
    values: ({ capabilities }) => capabilities.tocBehavior?.values ?? ["off"],
    enabled: ({ capabilities }) =>
      Array.isArray(capabilities.tocBehavior?.values),
  },
  {
    key: "footerStyle",
    labelKey: "com.myoxus.pdf-export.dialog.field.footer",
    helpKey: "com.myoxus.pdf-export.dialog.field.footer.help",
    kind: "select",
    values: ({ capabilities }) => capabilities.footerStyle?.values ?? [],
    enabled: ({ capabilities }) =>
      Array.isArray(capabilities.footerStyle?.values),
  },
  {
    key: "pageNumbering",
    labelKey: "com.myoxus.pdf-export.dialog.field.page-numbering",
    helpKey: "com.myoxus.pdf-export.dialog.field.page-numbering.help",
    kind: "select",
    values: ({ capabilities }) => capabilities.pageNumbering?.values ?? [],
    enabled: ({ capabilities }) =>
      Array.isArray(capabilities.pageNumbering?.values),
  },
  {
    key: "colorVariant",
    labelKey: "com.myoxus.pdf-export.dialog.field.color-variant",
    helpKey: "com.myoxus.pdf-export.dialog.field.color-variant.help",
    kind: "select",
    values: ({ capabilities }) => capabilities.colorVariant?.values ?? [],
    enabled: ({ capabilities }) =>
      Array.isArray(capabilities.colorVariant?.values),
  },
  {
    key: "coverPage",
    labelKey: "com.myoxus.pdf-export.dialog.field.cover",
    helpKey: "com.myoxus.pdf-export.dialog.field.cover.help",
    kind: "boolean",
    values: () => [],
    enabled: ({ capabilities }) => capabilities.coverPage?.kind === "boolean",
  },
  {
    key: "confidentialityLabel",
    labelKey: "com.myoxus.pdf-export.dialog.field.confidentiality",
    helpKey: "com.myoxus.pdf-export.dialog.field.confidentiality.help",
    kind: "select",
    values: ({ capabilities }) =>
      (capabilities.confidentialityLabels?.default as string[] | undefined) ??
      [],
    enabled: ({ capabilities }) =>
      (capabilities.confidentialityLabels?.max_items ?? 0) > 0 &&
      Array.isArray(capabilities.confidentialityLabels?.default),
  },
  {
    key: "typedInputs",
    labelKey: "com.myoxus.pdf-export.dialog.field.typed-inputs",
    helpKey: "com.myoxus.pdf-export.dialog.field.typed-inputs.help",
    kind: "json",
    values: () => [],
    enabled: () => true,
  },
];

export function createDefaultPdfExportFormValue(
  template: PdfTemplateOption,
  settings: PdfExportSettings,
  _brandingProfile: DocumentBrandingProfile,
  docTitle?: string,
  webLanguage?: string,
): PdfExportDialogFormValue {
  const capabilities = template.capabilities ?? {};
  const value: PdfExportDialogFormValue = {
    paperSize: settings.defaultPaperSize ?? "A4",
    orientation: "portrait",
    imageQuality: settings.defaultImageQuality ?? "high",
    complianceProfile: "pdfa-2u",
  };

  if (Array.isArray(capabilities.language?.values)) {
    const values = capabilities.language.values;
    const candidates = [
      settings.defaultLocale,
      webLanguage,
      capabilities.language?.default as string | undefined,
      values[0],
      "en",
    ];
    value.locale =
      candidates
        .filter((candidate): candidate is string => !!candidate?.trim())
        .map((candidate) => candidate.trim())
        .map(
          (candidate) =>
            values.find((value) => value === candidate) ??
            values.find(
              (value) =>
                value.split("-")[0]?.toLowerCase() ===
                candidate.split("-")[0]?.toLowerCase(),
            ),
        )
        .find((candidate): candidate is string => !!candidate) ??
      values[0] ??
      "en";
  }
  if (capabilities.coverPage?.kind === "boolean") {
    value.coverPage = capabilities.coverPage.default as boolean | undefined;
  }
  if (Array.isArray(capabilities.tocBehavior?.values)) {
    value.tocBehavior =
      (capabilities.tocBehavior?.default as string | undefined) ??
      capabilities.tocBehavior?.values?.[0] ??
      "off";
  }
  if (
    (capabilities.confidentialityLabels?.max_items ?? 0) > 0 &&
    Array.isArray(capabilities.confidentialityLabels?.default)
  ) {
    value.confidentialityLabel =
      (
        capabilities.confidentialityLabels?.default as string[] | undefined
      )?.[0] ?? undefined;
  }
  if (Array.isArray(capabilities.footerStyle?.values))
    value.footerStyle = capabilities.footerStyle.default as string | undefined;
  if (Array.isArray(capabilities.pageNumbering?.values))
    value.pageNumbering = capabilities.pageNumbering.default as
      string | undefined;
  if (Array.isArray(capabilities.colorVariant?.values))
    value.colorVariant = capabilities.colorVariant.default as
      string | undefined;
  const typedInputs = createDefaultTypedInputs(template, docTitle);
  if (typedInputs) {
    value.typedInputs = typedInputs;
  }
  return value;
}

function firstJsonSchemaType(type: string | string[] | undefined): string {
  return Array.isArray(type)
    ? (type.find((entry) => entry !== "null") ?? "")
    : (type ?? "");
}

function typedInputFallbackValue(
  key: string,
  property: PdfTemplateInputsSchemaProperty | undefined,
  docTitle: string,
): unknown {
  if (property?.default !== undefined) return property.default;
  if (property?.enum?.length) return property.enum[0];

  const type = firstJsonSchemaType(property?.type);
  const lowerKey = key.toLocaleLowerCase();
  if (type === "array") {
    const itemType = firstJsonSchemaType(property?.items?.type);
    if (itemType === "object") return [{}];
    if (itemType === "boolean") return [true];
    if (itemType === "integer" || itemType === "number") return [1];
    return [docTitle];
  }
  if (type === "object") return {};
  if (type === "boolean") return true;
  if (type === "integer" || type === "number") return 1;
  if (
    property?.format === "date" ||
    property?.pattern === "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" ||
    lowerKey.endsWith("_date")
  ) {
    return new Date().toISOString().slice(0, 10);
  }
  return docTitle;
}

function createDefaultTypedInputs(
  template: PdfTemplateOption,
  docTitle?: string,
): Record<string, unknown> | undefined {
  const required = template.inputsSchema?.required ?? [];
  if (required.length === 0) return undefined;
  const fallbackTitle = docTitle?.trim() || template.name || "Untitled";
  const properties = template.inputsSchema?.properties ?? {};
  return Object.fromEntries(
    required.map((key) => [
      key,
      typedInputFallbackValue(key, properties[key], fallbackTitle),
    ]),
  );
}

export type PdfExportFormValidationError = {
  key: string;
  params?: Record<string, string>;
};

export type PdfExportFormValidationErrors = Partial<
  Record<keyof PdfExportDialogFormValue, PdfExportFormValidationError>
>;

export function formatPdfExportFormValidationError(
  t: ReturnType<typeof useI18n>,
  error: PdfExportFormValidationError,
): string {
  return t.t(error.key, error.params);
}

export function validatePdfExportFormValue(
  template: PdfTemplateOption,
  value: PdfExportDialogFormValue,
): PdfExportFormValidationErrors {
  const capabilities = template.capabilities ?? {};
  const errors: PdfExportFormValidationErrors = {};
  const hasValue = (current: unknown) =>
    current !== undefined &&
    current !== null &&
    !(typeof current === "string" && current.trim() === "");
  const checkEnumCapability = (
    key: keyof PdfExportDialogFormValue,
    capability: PdfTemplateCapabilities[string] | undefined,
    disabledKey: string,
  ) => {
    const current = value[key];
    if (!hasValue(current)) return;
    if (!Array.isArray(capability?.values) || capability.values.length === 0) {
      errors[key] = { key: disabledKey };
      return;
    }
    if (typeof current === "string" && !capability.values.includes(current)) {
      errors[key] = {
        key: "com.myoxus.pdf-export.dialog.validation.unsupported-value",
        params: { value: current },
      };
    }
  };
  const checkEnumValues = (
    key: keyof PdfExportDialogFormValue,
    allowed: string[],
  ) => {
    const current = value[key];
    if (!hasValue(current)) return;
    if (typeof current === "string" && !allowed.includes(current)) {
      errors[key] = {
        key: "com.myoxus.pdf-export.dialog.validation.unsupported-value",
        params: { value: current },
      };
    }
  };

  // This mirrors the server manifest capability gate for local feedback only.
  // The GraphQL mutation remains the final authority and revalidates again.
  checkEnumCapability(
    "locale",
    capabilities.language,
    "com.myoxus.pdf-export.dialog.validation.locale-unsupported",
  );
  checkEnumCapability(
    "tocBehavior",
    capabilities.tocBehavior,
    "com.myoxus.pdf-export.dialog.validation.toc-unsupported",
  );
  checkEnumCapability(
    "footerStyle",
    capabilities.footerStyle,
    "com.myoxus.pdf-export.dialog.validation.option-unavailable",
  );
  checkEnumCapability(
    "pageNumbering",
    capabilities.pageNumbering,
    "com.myoxus.pdf-export.dialog.validation.option-unavailable",
  );
  checkEnumCapability(
    "colorVariant",
    capabilities.colorVariant,
    "com.myoxus.pdf-export.dialog.validation.option-unavailable",
  );
  checkEnumValues("paperSize", capabilities.paperSize?.values ?? PAPER_SIZES);
  checkEnumValues("orientation", ORIENTATIONS);
  checkEnumValues("imageQuality", IMAGE_QUALITIES);
  checkEnumValues("complianceProfile", COMPLIANCE_PROFILES);

  if (hasValue(value.coverPage) && capabilities.coverPage?.kind !== "boolean") {
    errors.coverPage = {
      key: "com.myoxus.pdf-export.dialog.validation.cover-unsupported",
    };
  }
  if (hasValue(value.confidentialityLabel)) {
    const labels = capabilities.confidentialityLabels;
    const allowed = labels?.default;
    if ((labels?.max_items ?? 0) <= 0 || !Array.isArray(allowed)) {
      errors.confidentialityLabel = {
        key: "com.myoxus.pdf-export.dialog.validation.confidentiality-unsupported",
      };
    } else if (
      typeof value.confidentialityLabel === "string" &&
      !allowed.includes(value.confidentialityLabel)
    ) {
      errors.confidentialityLabel = {
        key: "com.myoxus.pdf-export.dialog.validation.unsupported-value",
        params: { value: value.confidentialityLabel },
      };
    }
  }
  if (
    value.typedInputs !== undefined &&
    (value.typedInputs === null ||
      typeof value.typedInputs !== "object" ||
      Array.isArray(value.typedInputs))
  ) {
    errors.typedInputs = {
      key: "com.myoxus.pdf-export.dialog.validation.typed-inputs-object",
    };
  }
  return errors;
}

export function PdfCapabilityForm({
  template,
  settings,
  brandingProfile,
  value,
  onChange,
  beforeFields,
  validationErrors = {},
}: {
  template: PdfTemplateOption;
  settings: PdfExportSettings;
  brandingProfile: DocumentBrandingProfile;
  value: PdfExportDialogFormValue;
  onChange: (value: PdfExportDialogFormValue) => void;
  beforeFields?: ReactNode;
  validationErrors?: PdfExportFormValidationErrors;
}) {
  const t = useI18n();
  const ctx: CapabilityFormContext = {
    capabilities: template.capabilities ?? {},
    settings,
    brandingProfile,
  };
  const fields = FIELD_CONFIG.filter((field) => field.enabled(ctx));
  const renderedFieldKeys = new Set(fields.map((field) => field.key));
  const hiddenValidationErrors = Object.entries(validationErrors).filter(
    ([key]) => !renderedFieldKeys.has(key as keyof PdfExportDialogFormValue),
  );

  const setField = (key: keyof PdfExportDialogFormValue, next: unknown) => {
    onChange({ ...value, [key]: next });
  };

  const optionLabel = (field: FieldConfig, option: string) => {
    if (field.key === "complianceProfile") {
      switch (option) {
        case "standard":
          return t.t("com.myoxus.pdf-export.dialog.option.compliance.standard");
        case "pdfa-1b":
          return t.t("com.myoxus.pdf-export.dialog.option.compliance.pdfa-1b");
        case "pdfa-2u":
          return t.t("com.myoxus.pdf-export.dialog.option.compliance.pdfa-2u");
        case "pdfa-2b":
          return t.t("com.myoxus.pdf-export.dialog.option.compliance.pdfa-2b");
        case "pdfa-3b":
          return t.t("com.myoxus.pdf-export.dialog.option.compliance.pdfa-3b");
        case "pdfua-1":
          return t.t("com.myoxus.pdf-export.dialog.option.compliance.pdfua-1");
      }
    }
    if (field.key === "orientation") {
      switch (option) {
        case "portrait":
          return t.t(
            "com.myoxus.pdf-export.dialog.option.orientation.portrait",
          );
        case "landscape":
          return t.t(
            "com.myoxus.pdf-export.dialog.option.orientation.landscape",
          );
      }
    }
    if (field.key === "tocBehavior") {
      switch (option) {
        case "off":
          return t.t("com.myoxus.pdf-export.dialog.option.toc.off");
        case "auto":
          return t.t("com.myoxus.pdf-export.dialog.option.toc.auto");
        case "force":
          return t.t("com.myoxus.pdf-export.dialog.option.toc.force");
      }
    }
    if (field.key === "footerStyle") {
      switch (option) {
        case "none":
          return t.t("com.myoxus.pdf-export.dialog.option.footer.none");
        case "minimal":
          return t.t("com.myoxus.pdf-export.dialog.option.footer.minimal");
        case "page-only":
          return t.t("com.myoxus.pdf-export.dialog.option.footer.page-only");
        case "brand-and-page":
          return t.t(
            "com.myoxus.pdf-export.dialog.option.footer.brand-and-page",
          );
      }
    }
    if (field.key === "pageNumbering") {
      switch (option) {
        case "arabic":
          return t.t(
            "com.myoxus.pdf-export.dialog.option.page-numbering.arabic",
          );
        case "roman":
          return t.t(
            "com.myoxus.pdf-export.dialog.option.page-numbering.roman",
          );
        case "none":
          return t.t("com.myoxus.pdf-export.dialog.option.page-numbering.none");
      }
    }
    if (field.key === "colorVariant") {
      switch (option) {
        case "mono":
          return t.t("com.myoxus.pdf-export.dialog.option.color-variant.mono");
        case "accent":
          return t.t(
            "com.myoxus.pdf-export.dialog.option.color-variant.accent",
          );
        case "brand":
          return t.t("com.myoxus.pdf-export.dialog.option.color-variant.brand");
      }
    }
    return option;
  };

  const standardFields = fields.filter((field) => field.kind !== "json");
  const advancedField = fields.find((field) => field.kind === "json");
  const renderTypedInputs = () => {
    if (!advancedField) return null;
    const validationError = validationErrors.typedInputs;
    return (
      <Accordion variant="contained">
        <AccordionItem value="typed-inputs">
          <AccordionControl>{t.t(advancedField.labelKey)}</AccordionControl>
          <AccordionPanel>
            <SettingsField
              description={t.t(advancedField.helpKey)}
              label={t.t(advancedField.labelKey)}
            >
              <Textarea
                aria-label={t.t(advancedField.labelKey)}
                autosize
                maxRows={10}
                minRows={4}
                mono
                spellCheck={false}
                value={
                  value.typedInputs === undefined
                    ? ""
                    : typeof value.typedInputs === "string"
                      ? value.typedInputs
                      : JSON.stringify(value.typedInputs, null, 2)
                }
                onChange={(rawValue) => {
                  const raw = rawValue.trim();
                  if (!raw) {
                    setField("typedInputs", undefined);
                    return;
                  }
                  try {
                    setField("typedInputs", JSON.parse(raw));
                  } catch {
                    setField("typedInputs", raw);
                  }
                }}
              />
              {validationError ? (
                <ErrorMessage>
                  {formatPdfExportFormValidationError(t, validationError)}
                </ErrorMessage>
              ) : null}
            </SettingsField>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    );
  };

  return (
    <Stack
      gap="lg"
      aria-label={t.t("com.myoxus.pdf-export.dialog.options.aria-label")}
    >
      <MyoxusText typographySlot="section">{template.name}</MyoxusText>
      {hiddenValidationErrors.length > 0 ? (
        <SettingsNotice
          role="alert"
          tone="error"
          title={t.t("com.myoxus.pdf-export.dialog.validation.summary")}
        >
          {hiddenValidationErrors.map(([key, error]) => (
            <ErrorMessage key={key}>
              {formatPdfExportFormValidationError(t, error)}
            </ErrorMessage>
          ))}
        </SettingsNotice>
      ) : null}
      {beforeFields}
      <SettingsFieldGroup>
        {standardFields.map((field) => {
          const current = value[field.key];
          const validationError = validationErrors[field.key];
          return (
            <SettingsField
              description={t.t(field.helpKey)}
              key={field.key}
              label={t.t(field.labelKey)}
            >
              {field.kind === "select" ? (
                <FormSelect
                  aria-label={t.t(field.labelKey)}
                  data={[
                    {
                      value: "",
                      label: t.t(
                        "com.myoxus.pdf-export.dialog.option.use-default",
                      ),
                    },
                    ...field.values(ctx).map((option) => ({
                      value: option,
                      label: optionLabel(field, option),
                    })),
                  ]}
                  value={(current as string | undefined) ?? ""}
                  onChange={(next) => setField(field.key, next || undefined)}
                />
              ) : (
                <Checkbox
                  aria-label={t.t(field.labelKey)}
                  checked={current === true}
                  onChange={(_event, checked) => setField(field.key, checked)}
                />
              )}
              {validationError ? (
                <ErrorMessage>
                  {formatPdfExportFormValidationError(t, validationError)}
                </ErrorMessage>
              ) : null}
            </SettingsField>
          );
        })}
      </SettingsFieldGroup>
      {renderTypedInputs()}
    </Stack>
  );
}
