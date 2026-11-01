// SPDX-License-Identifier: AGPL-3.0-or-later

import type { I18nFuncs } from "@myoxus/i18n";

import type { PdfTemplateViewModel } from "./format-adapters";

type AdminTranslate = (key: string) => string;
type TemplateDisplayField = "name" | "description";

function translateBuiltinTemplateField(
  template: PdfTemplateViewModel,
  t: AdminTranslate,
  field: TemplateDisplayField,
) {
  if (template.source !== "system") return null;
  const keys: Record<string, Record<TemplateDisplayField, keyof I18nFuncs>> = {
    default: {
      name: "admin.pdf-export.template.builtin.default.name",
      description: "admin.pdf-export.template.builtin.default.description",
    },
    report: {
      name: "admin.pdf-export.template.builtin.report.name",
      description: "admin.pdf-export.template.builtin.report.description",
    },
    letter: {
      name: "admin.pdf-export.template.builtin.letter.name",
      description: "admin.pdf-export.template.builtin.letter.description",
    },
    "myoxus-doc": {
      name: "admin.pdf-export.template.builtin.myoxus-doc.name",
      description: "admin.pdf-export.template.builtin.myoxus-doc.description",
    },
  };
  const key = keys[template.slug]?.[field];
  if (!key) return null;
  const translated = t(key);
  return translated === key ? null : translated;
}

export function pdfTemplateDisplayName(
  template: PdfTemplateViewModel,
  t: AdminTranslate,
) {
  return translateBuiltinTemplateField(template, t, "name") ?? template.name;
}

export function pdfTemplateDisplayDescription(
  template: PdfTemplateViewModel,
  t: AdminTranslate,
) {
  return (
    translateBuiltinTemplateField(template, t, "description") ??
    template.description
  );
}

export function pdfTemplateSearchText(
  template: PdfTemplateViewModel,
  t: AdminTranslate,
) {
  return [
    template.name,
    pdfTemplateDisplayName(template, t),
    template.slug,
    template.version,
    template.schemaVersion,
  ]
    .join(" ")
    .toLocaleLowerCase();
}
