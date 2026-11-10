// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { DocumentFieldSchema } from "@virgultum/shared/types";
import fixtures from "../../../../../../../build/fixtures/contracts/document-fields.json";
import {
  formatDocumentInput,
  normalizeDocumentField,
  normalizeTemplateInputs,
} from "../services/template-inputs";

const preferences = {
  locale: "de-DE",
  timezone: "Pacific/Kiritimati",
  dateFormat: "year-month-day",
  timeFormat: "24-hour",
} as const;

test("native drafts keep unset and literal answers while legacy creation inputs stay required and trimmed", () => {
  const empty = DocumentFieldSchema.parse(fixtures.valid[0]);
  expect(formatDocumentInput(empty, preferences)).toEqual({
    text: null,
    complete: false,
  });
  const literal = DocumentFieldSchema.parse({
    ...fixtures.valid[0],
    value: "  {{date}}  ",
  });
  expect(formatDocumentInput(literal, preferences)).toEqual({
    text: "  {{date}}  ",
    complete: true,
  });
  expect(
    normalizeTemplateInputs(["input.subject"], {
      "input.subject": "  Subject  ",
    }),
  ).toEqual({ "input.subject": "Subject" });
  expect(() =>
    normalizeTemplateInputs(["input.subject"], { "input.subject": "" }),
  ).toThrow();
  for (const timezone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
    expect(
      formatDocumentInput(DocumentFieldSchema.parse(fixtures.valid[2]), {
        ...preferences,
        timezone,
      }).text,
    ).toBe("2026-11-05, 13:45");
  }
  const invalidDate = DocumentFieldSchema.parse({
    ...fixtures.valid[1],
    value: "2026-02-30",
  });
  expect(() => normalizeDocumentField(invalidDate)).toThrow();
});

test("selection answers and defaults use stable IDs and authored order without mutating their source", () => {
  const source = DocumentFieldSchema.parse(fixtures.valid[4]);
  if (source.type !== "input") throw new Error("Input fixture required");
  const draft = DocumentFieldSchema.parse({
    ...source,
    definition: { ...source.definition, default: ["a", "r", "a"] },
    value: ["a", "r", "a"],
  });
  const admitted = normalizeDocumentField(draft);
  expect(admitted).toMatchObject({
    definition: { default: ["r", "a"] },
    value: ["r", "a"],
  });
  expect(draft).toMatchObject({
    definition: { default: ["a", "r", "a"] },
    value: ["a", "r", "a"],
  });
  expect(formatDocumentInput(admitted, preferences).text).toBe("R, A");
  expect(
    formatDocumentInput(
      DocumentFieldSchema.parse({ ...source, value: [] }),
      preferences,
    ),
  ).toEqual({ text: null, complete: false });
  expect(() =>
    normalizeDocumentField(
      DocumentFieldSchema.parse({ ...source, value: ["unknown"] }),
    ),
  ).toThrow();
  expect(() =>
    normalizeDocumentField(
      DocumentFieldSchema.parse({
        ...source,
        definition: { ...source.definition, default: ["unknown"] },
      }),
    ),
  ).toThrow();
  expect(() =>
    normalizeDocumentField(
      DocumentFieldSchema.parse({
        ...source,
        definition: {
          ...source.definition,
          options: [
            { id: "r", label: "R" },
            { id: "r", label: "Other" },
          ],
        },
      }),
    ),
  ).toThrow();
});
