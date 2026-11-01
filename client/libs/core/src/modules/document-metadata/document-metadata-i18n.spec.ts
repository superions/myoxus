import { describe, expect, test } from "vitest";

import de from "../../../../i18n/src/resources/de.json";
import en from "../../../../i18n/src/resources/en.json";
import es from "../../../../i18n/src/resources/es.json";
import fr from "../../../../i18n/src/resources/fr.json";

const REQUIRED_KEYS = [
  "com.myoxus.document-metadata.eyebrow",
  "com.myoxus.document-metadata.title",
  "com.myoxus.document-metadata.description",
  "com.myoxus.document-metadata.action.refresh",
  "com.myoxus.document-metadata.loading",
  "com.myoxus.document-metadata.summary.fields",
  "com.myoxus.document-metadata.summary.loading",
  "com.myoxus.document-metadata.more.title",
  "com.myoxus.document-metadata.section.metadata",
  "com.myoxus.document-metadata.section.system",
  "com.myoxus.document-metadata.section.presentation",
  "com.myoxus.document-metadata.field.status",
  "com.myoxus.document-metadata.field.document-type",
  "com.myoxus.document-metadata.field.version",
  "com.myoxus.document-metadata.field.created-at",
  "com.myoxus.document-metadata.field.updated-at",
  "com.myoxus.document-metadata.field.metadata-revision",
  "com.myoxus.document-metadata.field.metadata-updated-at",
  "com.myoxus.document-metadata.field.projection-version",
  "com.myoxus.document-metadata.field.primary-mode",
  "com.myoxus.document-metadata.field.page-width",
  "com.myoxus.document-metadata.field.edgeless-color-theme",
  "com.myoxus.document-metadata.field.template-state",
  "com.myoxus.document-metadata.field.journal-date",
  "com.myoxus.document-metadata.field.integration-type",
  "com.myoxus.document-metadata.field.responsible",
  "com.myoxus.document-metadata.field.review-due-at",
  "com.myoxus.document-metadata.field.valid-from",
  "com.myoxus.document-metadata.field.valid-until",
  "com.myoxus.document-metadata.field.classification",
  "com.myoxus.document-metadata.field.document-number",
  "com.myoxus.document-metadata.field.language",
  "com.myoxus.document-metadata.field.audience",
  "com.myoxus.document-metadata.field.retention-policy",
  "com.myoxus.document-metadata.value.no-status",
  "com.myoxus.document-metadata.value.no-type",
  "com.myoxus.document-metadata.value.no-version",
  "com.myoxus.document-metadata.value.not-set",
  "com.myoxus.document-metadata.value.unversioned-changes",
  "com.myoxus.document-metadata.value.changed",
  "com.myoxus.document-metadata.value.principal.one",
  "com.myoxus.document-metadata.value.principal.other",
  "com.myoxus.document-metadata.validation.issues",
  "com.myoxus.document-metadata.validation.warnings",
  "com.myoxus.document-metadata.validation.required",
  "com.myoxus.document-metadata.validation.blocks",
] as const;

const resources = { de, en, es, fr } as const;

describe("document metadata i18n", () => {
  test.each(Object.entries(resources))(
    "%s has the complete document-metadata namespace",
    (_locale, resource) => {
      for (const key of REQUIRED_KEYS) {
        expect(resource[key], key).toEqual(expect.any(String));
        expect(resource[key].trim(), key).not.toBe("");
        expect(resource[key], key).not.toBe(key);
      }
    },
  );

  test("German document-metadata labels use real umlauts where required", () => {
    expect(de["com.myoxus.document-metadata.field.review-due-at"]).toContain(
      "Überprüfung",
    );
    expect(de["com.myoxus.document-metadata.field.valid-from"]).toContain(
      "Gültig",
    );
    expect(de["com.myoxus.document-metadata.value.changed"]).toBe("geändert");
    expect(
      de["com.myoxus.document-metadata.value.unversioned-changes"],
    ).toContain("Änderungen");
  });
});
