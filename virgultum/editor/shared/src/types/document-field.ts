// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { DeltaInsert, Text } from "@virgultum/store";
import type { MyoxusTextAttributes } from "./index";

// Native wire shapes mirror the server decoder. Authoring choices and bounds
// are discovered from documentFieldCatalog, not a second editor catalog.
const boundedText = z
  .string()
  .refine((value) => new TextEncoder().encode(value).length <= 8192);
const identity = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim() === value && new TextEncoder().encode(value).length <= 128,
  );
const label = boundedText.refine((value) => value.trim().length > 0);
/** Decoder wire limit; the server catalog advertises the same authoring bound. */
export const DOCUMENT_FIELD_MAX_OPTIONS = 100;
const common = {
  label,
  description: boundedText.optional(),
  required: z.boolean(),
};
const scalar = boundedText.nullable();
const options = z
  .array(z.object({ id: identity, label }).strict())
  .min(1)
  .max(DOCUMENT_FIELD_MAX_OPTIONS);
const multiple = z.array(identity).max(DOCUMENT_FIELD_MAX_OPTIONS);

const scalarInput = <Kind extends "text" | "date" | "datetime">(kind: Kind) =>
  z
    .object({
      type: z.literal("input"),
      id: identity,
      definition: z
        .object({
          ...common,
          kind: z.literal(kind),
          default: scalar.optional(),
        })
        .strict(),
      value: scalar,
    })
    .strict();

const metadata = z
  .object({
    type: z.literal("metadata"),
    id: identity,
    key: z.enum([
      "title",
      "versionLabel",
      "versionNumber",
      "documentType",
      "status",
      "classification",
      "documentNumber",
      "responsible",
      "createdBy",
      "updatedBy",
      "createdAt",
      "updatedAt",
      "reviewDueAt",
      "validFrom",
      "validUntil",
      "language",
      "audience",
      "retentionPolicy",
    ]),
    format: z.enum(["text", "name", "email", "date", "time", "datetime"]),
  })
  .strict()
  .refine(({ key, format }) => {
    if (["responsible", "createdBy", "updatedBy"].includes(key))
      return format === "name" || format === "email";
    if (
      [
        "createdAt",
        "updatedAt",
        "reviewDueAt",
        "validFrom",
        "validUntil",
      ].includes(key)
    )
      return ["date", "time", "datetime"].includes(format);
    return format === "text";
  });

export const DocumentFieldSchema = z.union([
  scalarInput("text"),
  scalarInput("date"),
  scalarInput("datetime"),
  z
    .object({
      type: z.literal("input"),
      id: identity,
      definition: z
        .object({
          ...common,
          kind: z.literal("single-select"),
          options,
          default: scalar.optional(),
        })
        .strict(),
      value: scalar,
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      id: identity,
      definition: z
        .object({
          ...common,
          kind: z.literal("multi-select"),
          options,
          default: multiple.optional(),
        })
        .strict(),
      value: multiple,
    })
    .strict(),
  metadata,
]);

/** A live field occupies one native embed, never its formatted display text. */
export type DocumentField = z.infer<typeof DocumentFieldSchema>;
export const DOCUMENT_FIELD_LIVE_TEXT = " ";

export function cloneDocumentField(
  field: DocumentField,
  id: string,
): DocumentField {
  return DocumentFieldSchema.parse({ ...structuredClone(field), id });
}

/** Template application only; ordinary native copies retain their filled value. */
export function initializeDocumentField(field: DocumentField): DocumentField {
  if (field.type === "metadata") return structuredClone(field);
  return DocumentFieldSchema.parse({
    ...structuredClone(field),
    value: structuredClone(
      field.definition.default ??
        (field.definition.kind === "multi-select" ? [] : null),
    ),
  });
}

/** Visit detached native Snapshot text only, never opaque boxed data or live bindings. */
export function visitDocumentFieldRuns(
  value: unknown,
  visit: (
    run: DeltaInsert<MyoxusTextAttributes>,
    deltas: DeltaInsert<MyoxusTextAttributes>[],
    index: number,
  ) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((child) => visitDocumentFieldRuns(child, visit));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["$virgultum:internal:native$"] === true) return;
    if (
      record["$virgultum:internal:text$"] === true &&
      Array.isArray(record.delta)
    ) {
      const deltas = record.delta as DeltaInsert<MyoxusTextAttributes>[];
      for (const [index, run] of deltas.entries()) {
        if (
          run.attributes &&
          ("documentField" in run.attributes ||
            "documentFieldCaptured" in run.attributes)
        ) {
          validateDocumentFieldRun(run);
          visit(run, deltas, index);
        }
      }
    } else {
      Object.values(record).forEach((child) =>
        visitDocumentFieldRuns(child, visit),
      );
    }
  }
}

/** Prepare a detached editable copy. Adjacent frozen formatting runs represent
 * one occurrence and collapse to one live atom; archived source is untouched.
 * Share identities within a fragment, never across independently copied rows.
 */
export function remapDocumentFieldIdentities(
  snapshot: unknown,
  generateId: () => string,
  identities = new Map<string, string>(),
): void {
  const removals = new Map<DeltaInsert<MyoxusTextAttributes>[], number[]>();
  const seen = new Set<string>();
  let previous:
    | {
        deltas: DeltaInsert<MyoxusTextAttributes>[];
        index: number;
        field: string;
      }
    | undefined;
  visitDocumentFieldRuns(snapshot, (run, deltas, index) => {
    const field = DocumentFieldSchema.parse(run.attributes?.documentField);
    const captured = run.attributes?.documentFieldCaptured === true;
    const encoded = JSON.stringify(field);
    const continuation =
      captured &&
      previous?.deltas === deltas &&
      previous.index === index - 1 &&
      previous.field === encoded;
    if (!continuation && seen.has(field.id))
      throw new Error("Duplicate native field occurrence in editable copy");
    if (!continuation) seen.add(field.id);
    let id = identities.get(field.id);
    if (!id) {
      id = generateId();
      identities.set(field.id, id);
    }
    run.attributes = {
      ...run.attributes,
      documentField: cloneDocumentField(field, id),
    };
    if (captured) {
      if (continuation) {
        const indexes = removals.get(deltas) ?? [];
        indexes.push(index);
        removals.set(deltas, indexes);
      } else {
        run.insert = DOCUMENT_FIELD_LIVE_TEXT;
        delete run.attributes.documentFieldCaptured;
      }
      previous = { deltas, index, field: encoded };
    } else {
      previous = undefined;
    }
  });
  for (const [deltas, indexes] of removals) {
    for (const index of indexes.reverse()) deltas.splice(index, 1);
  }
}

/** Prepare an independent native Text clone before it is attached to its target.
 * Queue the detached editable delta on Y.Text's ordinary prelim path; neither
 * source values nor Store/reactive synchronization owners are changed.
 */
export function cloneTextWithDocumentFieldIdentities(
  source: Text,
  generateId: () => string,
  identities = new Map<string, string>(),
): Text {
  const copy = source.clone();
  const delta = structuredClone(
    source.toDelta(),
  ) as DeltaInsert<MyoxusTextAttributes>[];
  if (
    !delta.some(
      (run) =>
        run.attributes &&
        ("documentField" in run.attributes ||
          "documentFieldCaptured" in run.attributes),
    )
  )
    return copy;
  const snapshot = { "$virgultum:internal:text$": true, delta };
  remapDocumentFieldIdentities(snapshot, generateId, identities);
  const length = source.yText.length;
  if (length) copy.yText.delete(0, length);
  copy.yText.applyDelta(delta);
  return copy;
}

/** Frozen empty answers need readable text so the retained occurrence survives. */
export function freezeDocumentField(
  delta: DeltaInsert<MyoxusTextAttributes>,
  readable: string,
): DeltaInsert<MyoxusTextAttributes> {
  if (!readable) throw new Error("Native field capture requires readable text");
  validateDocumentFieldRun(delta);
  if (delta.attributes?.documentFieldCaptured)
    throw new Error("Native field is already captured");
  DocumentFieldSchema.parse(delta.attributes?.documentField);
  return {
    insert: readable,
    attributes: {
      ...structuredClone(delta.attributes),
      documentFieldCaptured: true,
    },
  };
}

/** Only editable copy/restore callers may remove the capture marker. */
export function reactivateDocumentField(
  delta: DeltaInsert<MyoxusTextAttributes>,
): DeltaInsert<MyoxusTextAttributes> {
  validateDocumentFieldRun(delta);
  DocumentFieldSchema.parse(delta.attributes?.documentField);
  const attributes = structuredClone(delta.attributes)!;
  delete attributes.documentFieldCaptured;
  return { insert: DOCUMENT_FIELD_LIVE_TEXT, attributes };
}

/** Shape validation at native import/capture boundaries, not a sync filter. */
export function validateDocumentFieldRun(
  delta: DeltaInsert<MyoxusTextAttributes>,
): void {
  const attributes = delta.attributes;
  if (!attributes || !("documentField" in attributes)) {
    if (attributes && "documentFieldCaptured" in attributes)
      throw new Error("Native field capture has no descriptor");
    return;
  }
  DocumentFieldSchema.parse(attributes.documentField);
  if (
    typeof delta.insert !== "string" ||
    !delta.insert ||
    (attributes.documentFieldCaptured !== undefined &&
      attributes.documentFieldCaptured !== true) ||
    (!attributes.documentFieldCaptured &&
      delta.insert !== DOCUMENT_FIELD_LIVE_TEXT) ||
    ["annotation", "reference", "mention", "latex", "footnote", "link"].some(
      (key) => key in attributes,
    )
  )
    throw new Error("Invalid native field text or inline combination");
}
