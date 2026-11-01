// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `non-empty-cards.unit.spec.ts` - E-FIND-03 tests for the
 * `nonEmptyCards<T>` helper.
 *
 * P-VIRG-ARCH-E-06 centralises the `T[]` -> `[T, ...T[]]` coercion
 * that the `KanbanCardSelection.cards` tuple shape requires. The
 * helper is the single source of truth; any future site that needs
 * the same coercion uses the helper instead of the
 * `[arr[0]!, ...arr.slice(1)]` cast pattern.
 *
 * **Pinned invariants:**
 *   1. Empty input (`length === 0`) returns `undefined` (no
 *      "card with 0 cards" state is allowed by the schema).
 *   2. Single-element input returns a one-tuple (preserves the
 *      `T` element unchanged).
 *   3. Multi-element input returns a tuple in the original order.
 *   4. The function is readonly-safe (input is `ReadonlyArray<T>`,
 *      output does not mutate the input).
 *   5. The return type is exactly `[T, ...T[]]` (compile-time guard
 *      enforced via `expectTypeOf`-style assignment below).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-06)
 */

import { describe, expect, test } from "vitest";

import { nonEmptyCards } from "../view-presets/kanban/selection.js";

describe("P-VIRG-ARCH-E-06 nonEmptyCards", () => {
  describe("empty input", () => {
    test("empty mutable and readonly inputs return undefined", () => {
      expect(nonEmptyCards([] as number[])).toBeUndefined();
      expect(
        nonEmptyCards(Object.freeze([]) as ReadonlyArray<string>),
      ).toBeUndefined();
    });
  });

  describe("single-element input", () => {
    test("returns a one-tuple while preserving element identity", () => {
      const obj = { cardId: "c1", groupKey: "g1" };
      const input = [obj] as ReadonlyArray<typeof obj>;
      const result = nonEmptyCards(input);

      expect(result).toHaveLength(1);
      expect(result?.[0]).toBe(obj);
    });
  });

  describe("multi-element input", () => {
    test("preserves order, duplicates and object references", () => {
      // The helper does NOT dedupe. Dedup is the caller's job
      // (`uniqueById` in `pc/controller/selection.ts`).
      const a = { id: "a" };
      const b = { id: "b" };
      const result = nonEmptyCards([a, a, b] as ReadonlyArray<typeof a>);

      expect(result).toEqual([a, a, b]);
      expect(result?.[0]).toBe(a);
      expect(result?.[1]).toBe(a);
      expect(result?.[2]).toBe(b);
    });
  });

  describe("readonly input", () => {
    test("accepts readonly arrays and does not mutate the input", () => {
      const input: readonly number[] = Object.freeze([10, 20, 30]);
      const snapshot = [...input];

      expect(nonEmptyCards(input)).toEqual([10, 20, 30]);
      expect(input).toEqual(snapshot);
    });
  });

  describe("TypeScript type guard", () => {
    // Compile-time assertion: the result is `[T, ...T[]] | undefined`,
    // not `T[] | undefined`. We do this by ensuring that the
    // returned tuple has the literal `[number, ...number[]]` shape
    // after the `undefined` narrowing.
    test("after narrowing, the result keeps the non-empty tuple shape", () => {
      const input: number[] = [42, 7];
      const result = nonEmptyCards(input);
      if (result === undefined) {
        throw new Error("expected non-empty");
      }
      const tuple: [number, ...number[]] = result;
      const [head, ...tail] = tuple;
      expect(head).toBe(42);
      expect(tail).toEqual([7]);
    });
  });

  describe("edge cases", () => {
    test("input with a single undefined element returns [undefined]", () => {
      // The helper does not filter. The empty-input check is the
      // only runtime guard. Callers that need to filter must do so
      // before calling the helper.
      const input: ReadonlyArray<number | undefined> = [undefined];
      const result = nonEmptyCards(input);
      expect(result).toHaveLength(1);
      expect(result![0]).toBeUndefined();
    });
  });
});
