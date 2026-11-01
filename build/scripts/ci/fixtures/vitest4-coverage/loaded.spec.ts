// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { expect, test } from "vitest";

import { coveredValue } from "./loaded.js";

test("reports only modules loaded by the test graph", () => {
  expect(coveredValue()).toBe(42);
});
