/**
 * @file filter.ts — @myoxus/env
 *
 * Schema and type definitions for the document collection / filter system.
 *
 * A {@link Collection} groups documents by a name and an ordered list of
 * {@link Filter} rules, each expressing a predicate like
 * `createdDate.after(literal)`.  An optional `allowList` explicitly includes
 * specific doc IDs regardless of filter results.
 *
 * Zod schemas are provided for runtime validation when collections are read
 * from persistent storage.
 *
 * Consumers: workspace view / filter UI in `client/web`.
 */

import type { DocsPropertiesMeta } from "@virgultum/editor/store";
import { z } from "zod";

/** Zod schema for a recursive literal value (number, string, boolean, array, or record). */
export const literalValueSchema: z.ZodType<LiteralValue, LiteralValue> =
  z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.array(z.lazy(() => literalValueSchema)),
    z.record(
      z.string(),
      z.lazy(() => literalValueSchema),
    ),
  ]);

/**
 * A recursive literal value type: can be a primitive, array of literals, or a
 * record of literals.  Used as the argument type in filter expressions.
 */
export type LiteralValue =
  | number
  | string
  | boolean
  | {
      [K: string]: LiteralValue;
    }
  | Array<LiteralValue>;

export const refSchema: z.ZodType<Ref, Ref> = z.object({
  type: z.literal("ref"),
  name: z.never(),
});

/**
 * A reference to a named variable in {@link VariableMap}.
 *
 * References are the left-hand side of a {@link Filter} predicate — they point
 * to a document property (e.g. `createdDate`, `tag`).
 */
export type Ref = {
  type: "ref";
  name: keyof VariableMap;
};

/**
 * Declaration map for variables that can appear on the left-hand side of a
 * filter expression.  Extended by declaration merging in the application layer.
 */
export interface VariableMap {}

/** Zod schema for a filter argument holding a concrete {@link LiteralValue}. */
export const literalSchema = z.object({
  type: z.literal("literal"),
  value: literalValueSchema,
});

export type Literal = z.input<typeof literalSchema>;

export const filterSchema = z.object({
  type: z.literal("filter"),
  left: refSchema,
  funcName: z.string(),
  args: z.array(literalSchema),
});

export type Filter = z.input<typeof filterSchema>;

/** Zod schema for a document collection with its filter rules and allow-list. */
export const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  filterList: z.array(filterSchema),
  allowList: z.array(z.string()),
  createDate: z.union([z.date(), z.number()]).optional(),
  updateDate: z.union([z.date(), z.number()]).optional(),
});
/** A document collection descriptor with filter rules and an explicit allow-list. */
export type Collection = z.input<typeof collectionSchema>;

/** Document properties metadata, re-exported from Virgultum for convenience. */
export type PropertiesMeta = DocsPropertiesMeta;
