import { z } from "zod";

export const KanbanViewTypeSchema = z.object({
  viewId: z.string(),
  type: z.literal("kanban"),
});
export const KanbanCellSelectionSchema = z.object({
  selectionType: z.literal("cell"),
  groupKey: z.string(),
  cardId: z.string(),
  columnId: z.string(),
  isEditing: z.boolean(),
});

const KanbanCardSelectionCardSchema = z.object({
  groupKey: z.string(),
  cardId: z.string(),
});
export const KanbanCardSelectionSchema = z.object({
  selectionType: z.literal("card"),
  cards: z
    .tuple([KanbanCardSelectionCardSchema])
    .rest(KanbanCardSelectionCardSchema),
});

export const KanbanGroupSelectionSchema = z.object({
  selectionType: z.literal("group"),
  groupKeys: z.tuple([z.string()]).rest(z.string()),
});

export const KanbanViewSelectionSchema = z.union([
  KanbanCellSelectionSchema,
  KanbanCardSelectionSchema,
  KanbanGroupSelectionSchema,
]);
export const KanbanViewSelectionWithTypeSchema = z.union([
  z.intersection(KanbanViewTypeSchema, KanbanCellSelectionSchema),
  z.intersection(KanbanViewTypeSchema, KanbanCardSelectionSchema),
  z.intersection(KanbanViewTypeSchema, KanbanGroupSelectionSchema),
]);
export type KanbanCellSelection = z.TypeOf<typeof KanbanCellSelectionSchema>;
export type KanbanCardSelectionCard = z.TypeOf<
  typeof KanbanCardSelectionCardSchema
>;
export type KanbanCardSelection = z.TypeOf<typeof KanbanCardSelectionSchema>;
export type KanbanGroupSelection = z.TypeOf<typeof KanbanGroupSelectionSchema>;
export type KanbanViewSelection = z.TypeOf<typeof KanbanViewSelectionSchema>;
export type KanbanViewSelectionWithType = z.TypeOf<
  typeof KanbanViewSelectionWithTypeSchema
>;

/**
 * Coerce a `T[]` (possibly empty) to a `[T, ...T[]]`
 * (non-empty) tuple. Returns `undefined` when the
 * input array is empty.
 *
 * E-FIND-03: `KanbanCardSelection.cards` is typed
 * as `[KanbanCardSelectionCard, ...KanbanCardSelectionCard[]]`
 * (non-empty tuple, mirroring the underlying zod
 * `z.tuple([...]).rest(...)` schema). Constructing
 * such a tuple from a `T[]` (e.g. the result of
 * `.filter(...)`) requires either a spread-from-a-
 * non-empty-source pattern or an explicit tuple
 * literal. The helper centralises the coercion in
 * one place so the call-sites are readable.
 *
 * The helper is **runtime-safe** (a `length > 0`
 * check), so it can replace ad-hoc `if (cards.length)`
 * guards in selection-builder code.
 */
export function nonEmptyCards<T>(
  cards: ReadonlyArray<T>,
): [T, ...T[]] | undefined {
  if (cards.length === 0) return undefined;
  // `[first, ...rest]` is type-safe because we
  // already verified `length > 0`. The cast is a
  // single-line escape hatch; the function's
  // return type carries the stronger guarantee.
  const [first, ...rest] = cards as [T, ...T[]];
  return [first, ...rest];
}
