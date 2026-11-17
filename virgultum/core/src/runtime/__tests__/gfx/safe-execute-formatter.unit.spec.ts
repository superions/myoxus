// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `safe-execute-formatter.unit.spec.ts` — P-VIRG-ARCH-H-02
 * (Observability, Slice 1).
 *
 * Pure-function tests for `formatSafeExecuteMessage`.
 * The formatter is the only place where the
 * console-line shape is decided; pinning it here
 * means `_safeExecute` callers and the console can
 * never silently drift apart.
 *
 * **Pinned invariants:**
 *
 *   1. The header is always `[<mode>::<operation>]`
 *      with `?` sentinels for unknown fields.
 *   2. The `(n=…, flavours=[…])` suffix is omitted
 *      when neither `elementCount` nor `flavours`
 *      is set.
 *   3. `flavours` is capped to 5 entries with a
 *      `…+N` tail showing the hidden count.
 *   4. `errorMessage` is rendered as prose between
 *      the suffix and the error tail.
 *   5. `Error` instances are rendered as
 *      `name: message`; non-Error throws are
 *      rendered via `String(err)`.
 *   6. `null` / `undefined` errors render as
 *      `<unknown error>` (a single line is always
 *      produced — no `undefined` substring in the
 *      log).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §H
 *      (P-VIRG-ARCH-H-02 Observability)
 */

import { describe, expect, test } from "vitest";

import { formatSafeExecuteMessage } from "../../gfx/interactivity/safe-execute-formatter.js";

describe("P-VIRG-ARCH-H-02 formatSafeExecuteMessage", () => {
  test("renders [mode::operation] header with all fields", () => {
    const out = formatSafeExecuteMessage(
      {
        operation: "extension.onDragMove",
        mode: "edgeless",
        elementCount: 2,
        flavours: ["affine:shape", "affine:note"],
        errorMessage: "extension handler threw during onDragMove",
      },
      new Error("boom"),
    );
    expect(out).toBe(
      "[edgeless::extension.onDragMove] (n=2, flavours=[affine:shape, affine:note]) " +
        "extension handler threw during onDragMove — Error: boom",
    );
  });

  test("uses ? sentinels for missing mode and flavours", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.clear" },
      new TypeError("bad"),
    );
    expect(out).toBe("[?::extension.clear] — TypeError: bad");
  });

  test("omits the suffix when no element context is provided", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.onDragStart" },
      new Error("x"),
    );
    expect(out).toBe("[?::extension.onDragStart] — Error: x");
  });

  test("includes elementCount even with no flavours", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.onDragMove", elementCount: 0 },
      new Error("nope"),
    );
    expect(out).toBe(
      "[?::extension.onDragMove] (n=0, flavours=?) — Error: nope",
    );
  });

  test("includes flavours even with no elementCount", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.onDragEnd", flavours: ["affine:note"] },
      new Error("x"),
    );
    expect(out).toBe(
      "[?::extension.onDragEnd] (n=?, flavours=[affine:note]) — Error: x",
    );
  });

  test("caps flavours to 5 entries with a tail marker", () => {
    const out = formatSafeExecuteMessage(
      {
        operation: "extension.onDragMove",
        flavours: ["a", "b", "c", "d", "e", "f", "g"],
      },
      new Error("x"),
    );
    expect(out).toBe(
      "[?::extension.onDragMove] (n=?, flavours=[a, b, c, d, e, …+2]) — Error: x",
    );
  });

  test("renders empty flavours as [] when elementCount is set", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.clear", elementCount: 0, flavours: [] },
      new Error("x"),
    );
    expect(out).toBe("[?::extension.clear] (n=0, flavours=[]) — Error: x");
  });

  test("errorMessage appears between suffix and error", () => {
    const out = formatSafeExecuteMessage(
      {
        operation: "extension.onDragMove",
        elementCount: 1,
        flavours: ["affine:shape"],
        errorMessage: "handler X threw",
      },
      new Error("inner"),
    );
    expect(out).toBe(
      "[?::extension.onDragMove] (n=1, flavours=[affine:shape]) handler X threw — Error: inner",
    );
  });

  test("omits errorMessage prose when not set", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.onDragMove", elementCount: 1 },
      new Error("inner"),
    );
    // No prose between the suffix and the em-dash.
    expect(out).toBe(
      "[?::extension.onDragMove] (n=1, flavours=?) — Error: inner",
    );
  });

  test("non-Error throws render via String(err)", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.clear" },
      "string-throw",
    );
    expect(out).toBe("[?::extension.clear] — string-throw");
  });

  test("null error renders as <unknown error>", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.clear" },
      null,
    );
    expect(out).toBe("[?::extension.clear] — <unknown error>");
  });

  test("undefined error renders as <unknown error>", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.clear" },
      undefined,
    );
    expect(out).toBe("[?::extension.clear] — <unknown error>");
  });

  test("Error with empty message renders as 'name: ' (not ': undefined')", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.clear" },
      new RangeError(),
    );
    // `RangeError: ` with empty message is acceptable
    // (we want the colon to stay so the format is
    // stable for grep/parsing).
    expect(out).toBe("[?::extension.clear] — RangeError: ");
  });

  test("the output is a single line (no newlines, even for multi-line errors)", () => {
    const out = formatSafeExecuteMessage(
      { operation: "extension.onDragMove", elementCount: 1 },
      new Error("line1\nline2\nline3"),
    );
    // We do NOT want stray newlines in the log
    // line — they break log-aggregator parsing.
    expect(out).not.toContain("\n");
  });

  // P-VIRG-ARCH-H-02 (Observability, Slice 2):
  // The mode is now read at the call site
  // (MoveInteractionManager calls
  // `this.host._currentMode`, which delegates to the
  // host-injected resolver on `GfxController`).
  // The formatter must render `"page"` and
  // `"edgeless"` verbatim — the `?` sentinel is
  // reserved for the "no resolver wired" case.
  describe("P-VIRG-ARCH-H-02-Slice-2 mode pinning", () => {
    test("renders [page::operation] when mode is 'page'", () => {
      const out = formatSafeExecuteMessage(
        {
          operation: "extension.onDragStart",
          mode: "page",
          elementCount: 1,
          flavours: ["affine:shape"],
        },
        new Error("x"),
      );
      expect(out).toBe(
        "[page::extension.onDragStart] (n=1, flavours=[affine:shape]) — Error: x",
      );
    });

    test("renders [edgeless::operation] when mode is 'edgeless'", () => {
      const out = formatSafeExecuteMessage(
        {
          operation: "extension.onDragMove",
          mode: "edgeless",
          elementCount: 2,
          flavours: ["affine:shape", "affine:note"],
        },
        new Error("x"),
      );
      expect(out).toBe(
        "[edgeless::extension.onDragMove] (n=2, flavours=[affine:shape, affine:note]) — Error: x",
      );
    });

    test("renders [?::operation] when mode is null (resolver returned null)", () => {
      // `null` mode is distinct from `undefined` in
      // the call site (provider exists, but
      // `getEditorMode()` returned the default
      // `null`). The formatter collapses both to
      // `?` so log-grep patterns stay simple.
      const out = formatSafeExecuteMessage(
        { operation: "extension.clear", mode: null },
        new Error("x"),
      );
      expect(out).toBe("[?::extension.clear] — Error: x");
    });

    test("renders [?::operation] when mode is undefined (no resolver)", () => {
      const out = formatSafeExecuteMessage(
        { operation: "extension.clear" },
        new Error("x"),
      );
      expect(out).toBe("[?::extension.clear] — Error: x");
    });
  });
});
