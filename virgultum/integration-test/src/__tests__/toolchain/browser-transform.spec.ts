// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { expect, test } from "vitest";

type TransformFixture = {
  nested?: { value: number };
};

const transformedFixture: TransformFixture = await Promise.resolve({
  nested: { value: 42 },
});

test("transforms TypeScript with web semantics in browser mode", () => {
  expect(transformedFixture.nested?.value).toBe(42);
  expect(window.location.protocol).toMatch(/^https?:$/);
});
