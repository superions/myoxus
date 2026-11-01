import { expect, test } from "vitest";

import contract from "../../../../../../build/fixtures/contracts/organizer-fractional-indexing.json";
import { generateFractionalIndexingKeyBetween } from "../fractional-indexing";

function gen(a: string | null, b: string | null) {
  const result = generateFractionalIndexingKeyBetween(a, b);

  expect(
    a === null || b === null || (a < result && result < b),
    `${a} ${b} ${result}`,
  ).toBe(true);
  return result;
}

function isContractOrderKey(key: string) {
  if (!/^[0-9A-Za-z]+$/.test(key)) return false;
  const head = key.charCodeAt(0);
  const integerLength =
    head >= 97 && head <= 122
      ? head - 97 + 2
      : head >= 65 && head <= 90
        ? 90 - head + 2
        : 0;
  return (
    integerLength > 0 &&
    key.length >= integerLength &&
    key !== `A${"0".repeat(26)}` &&
    !key.slice(integerLength).endsWith("0")
  );
}

test("fractional-indexing", () => {
  for (let i = 0; i < 100; i++) {
    const set = new Set<string>();
    let a = null;
    let b = null;
    for (let i = 0; i < 100; i++) {
      const s1 = gen(a, b);
      expect(a === null || b === null || (a < s1 && s1 < b)).toBe(true);
      const s2 = gen(a, b);
      expect(a === null || b === null || (a < s2 && s2 < b)).toBe(true);

      if (set.has(s1) || set.has(s2) || s1 === s2) {
        throw new Error("Duplicate key, " + set.size + ", " + s1 + ", " + s2);
      }
      set.add(s1);
      set.add(s2);
      if (s1 < s2) {
        a = s1;
        b = s2;
      } else {
        a = s2;
        b = s1;
      }
    }
  }
});

test("no postfix", () => {
  expect(
    generateFractionalIndexingKeyBetween("a0", null).startsWith("a1"),
  ).toBe(true);
  expect(
    generateFractionalIndexingKeyBetween("a01", null).startsWith("a1"),
  ).toBe(true);
  expect(
    generateFractionalIndexingKeyBetween("a0001", null).startsWith("a1"),
  ).toBe(true);
  expect(
    generateFractionalIndexingKeyBetween(null, "a0").startsWith("Zz"),
  ).toBe(true);
  expect(
    generateFractionalIndexingKeyBetween("a0", "a01").startsWith("a00V"),
  ).toBe(true);
});

test("edge cases", () => {
  for (let i = 0; i < 100; i++) {
    let a = generateFractionalIndexingKeyBetween(null, null);
    let b = generateFractionalIndexingKeyBetween(null, null);
    if (a > b) {
      [a, b] = [b, a];
    }
    const c = generateFractionalIndexingKeyBetween(a, b);
    const d = generateFractionalIndexingKeyBetween(c, b);
    expect(a < c).toBeTruthy();
    expect(c < b).toBeTruthy();
    expect(c < d).toBeTruthy();
    expect(d < b).toBeTruthy();
  }
});

test("server Organizer keys satisfy the production wrapper contract", () => {
  for (const key of contract.validKeys) {
    expect(isContractOrderKey(key), key).toBe(true);
    expect(() => generateFractionalIndexingKeyBetween(key, null)).not.toThrow();
  }
  for (const key of contract.invalidKeys) {
    expect(isContractOrderKey(key), key).toBe(false);
  }

  for (const relation of contract.relations) {
    let lower = relation.lower;
    let upper = relation.upper;
    const generated = new Set<string>();
    for (let iteration = 0; iteration < relation.iterations; iteration++) {
      const key = generateFractionalIndexingKeyBetween(lower, upper);
      expect(lower === null || lower < key, relation.name).toBe(true);
      expect(upper === null || key < upper, relation.name).toBe(true);
      expect(generated.has(key), relation.name).toBe(false);
      generated.add(key);
      if (relation.advance === "lower") {
        lower = key;
      } else {
        upper = key;
      }
    }
  }

  expect(() =>
    generateFractionalIndexingKeyBetween(null, contract.reindexKeys[0]),
  ).not.toThrow();
  for (let index = 1; index < contract.reindexKeys.length; index++) {
    expect(() =>
      generateFractionalIndexingKeyBetween(
        contract.reindexKeys[index - 1],
        contract.reindexKeys[index],
      ),
    ).not.toThrow();
  }
  expect(() =>
    generateFractionalIndexingKeyBetween(
      contract.reindexKeys[contract.reindexKeys.length - 1],
      null,
    ),
  ).not.toThrow();
});
