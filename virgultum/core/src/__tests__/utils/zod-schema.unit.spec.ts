// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vitest";

import { makeDeepOptional, NodePropsSchema } from "../../utils/zod-schema";

test("preference patches stay sparse and default trees are independent", () => {
  const patch = makeDeepOptional(NodePropsSchema);
  expect(patch.parse({ text: { fontSize: 32 } })).toEqual({
    text: { fontSize: 32 },
  });
  expect(patch.parse({})).toEqual({});

  const first = NodePropsSchema.parse({});
  const original = structuredClone(first);
  first.connector.labelStyle.fontSize = 32;
  expect(NodePropsSchema.parse({})).toEqual(original);
});
