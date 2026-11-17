// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `safe-execute-formatter.ts` — P-VIRG-ARCH-H-02
 * (Observability, Slice 1).
 *
 * Pure-function formatter for `SafeExecuteContext` +
 * the thrown error. Kept separate from the manager
 * (which owns the runtime) and from the context type
 * (which is the data shape) so that the format
 * contract is unit-testable without spinning up an
 * `InteractivityManager`.
 *
 * **Format:**
 * ```
 * [mode::operation] (n=<count>, flavours=[…]) <errorMessage> — <error.name>: <error.message>
 * ```
 *
 * - `[mode::operation]` is always present, with
 *   `?` sentinels for unknown fields.
 * - `(n=…, flavours=[…])` is omitted entirely if
 *   neither `elementCount` nor `flavours` is set.
 * - `<errorMessage>` is the optional human tail
 *   and is omitted if not set.
 * - The error is rendered as
 *   `<name>: <message>` when it's an `Error`, and
 *   as `String(error)` otherwise.
 *
 * The function never throws. A `null`/`undefined`
 * error renders as the literal `"<unknown error>"`
 * sentinel so a single line is always produced.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §H
 *      (P-VIRG-ARCH-H-02 Observability)
 */

import type { SafeExecuteContext } from "./safe-execute-context.js";

/**
 * Cap on the number of flavours rendered in the log
 * line. 5 is enough to spot a mixed-flavour drag
 * (e.g. shape + note + frame) without flooding the
 * console; the full count is still available via
 * `elementCount`.
 */
const FLAVOUR_RENDER_CAP = 5;

function renderFlavours(flavours: ReadonlyArray<string>): string {
  if (flavours.length === 0) return "[]";
  const head = flavours.slice(0, FLAVOUR_RENDER_CAP);
  if (flavours.length > FLAVOUR_RENDER_CAP) {
    return `[${head.join(", ")}, …+${flavours.length - FLAVOUR_RENDER_CAP}]`;
  }
  return `[${head.join(", ")}]`;
}

function renderError(err: unknown): string {
  if (err === null || err === undefined) {
    return "<unknown error>";
  }
  if (err instanceof Error) {
    return `${err.name}: ${sanitize(err.message)}`;
  }
  return sanitize(String(err));
}

/**
 * Replace every newline with a single space and
 * collapse runs of whitespace, so a single log line
 * stays a single line (log aggregators break on
 * unescaped newlines).
 */
function sanitize(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
}

export function formatSafeExecuteMessage(
  ctx: SafeExecuteContext,
  err: unknown,
): string {
  const mode = ctx.mode ?? "?";
  const operation = ctx.operation;
  const head = `[${mode}::${operation}]`;

  const hasCount = ctx.elementCount !== undefined;
  const hasFlavours = ctx.flavours !== undefined;
  const tail =
    hasCount || hasFlavours
      ? ` (n=${ctx.elementCount ?? "?"}, flavours=${
          hasFlavours ? renderFlavours(ctx.flavours ?? []) : "?"
        })`
      : "";

  const prose = ctx.errorMessage ? ` ${ctx.errorMessage}` : "";
  return `${head}${tail}${prose} — ${renderError(err)}`;
}
