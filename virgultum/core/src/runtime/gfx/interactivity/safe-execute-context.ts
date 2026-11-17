// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `safe-execute-context.ts` — P-VIRG-ARCH-H-02
 * (Observability, Slice 1).
 *
 * Structured context carried by
 * `InteractivityManager._safeExecute` so that any
 * extension-handler crash is logged with enough
 * information to diagnose from the console without
 * needing to attach a debugger.
 *
 * **Why this lives in its own file.** The H-02
 * roadmap calls for `Doc-ID, Workspace-ID soweit
 * verfuegbar, Block-ID, Flavour, Mode, Surface/Frame-ID
 * und Operation` on every critical error. Different
 * call sites will populate different subsets; the
 * GFX-interactivity layer today only has `mode`,
 * `operation`, `flavours` and `elementCount` readily
 * available. Defining the shape here (rather than
 * inline at the call site) keeps the call site tidy
 * and makes the format contract unit-testable.
 *
 * **Why optional fields.** `_safeExecute` is the
 * central error sink for *all* GFX extension
 * dispatch (Move, Resize, Rotate, future). Some
 * dispatch paths have elements, some don't (e.g. a
 * "click" on empty canvas). Forcing required
 * `flavours` would be a lie at those sites; optional
 * fields let each call site contribute what it
 * knows without false defaults.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §H
 *      (P-VIRG-ARCH-H-02 Observability)
 */

export interface SafeExecuteContext {
  /**
   * The GFX operation that triggered the dispatch.
   * Conventional format: `"<phase>.<hook>"`, e.g.
   * `"extension.onDragStart"`, `"extension.onDragMove"`,
   * `"extension.onDragEnd"`, `"extension.clear"`.
   *
   * This is the most important field: it tells a
   * log reader *which* handler chain was running
   * when the crash happened.
   */
  readonly operation: string;

  /**
   * Editor mode at the time of the call. Read via
   * `DocModeProvider` in the call site, not here
   * (we don't want this module to depend on
   * `@virgultum/editor` just to read the mode).
   *
   * `null` is a distinct sentinel: it means "the
   * resolver ran, but `DocModeProvider.getEditorMode()`
   * returned its default `null` (e.g. the editor
   * was just constructed and the host hasn't set
   * a mode yet)". The formatter collapses `null`
   * and `undefined` to `?` so a log reader cannot
   * tell them apart — that is by design, to keep
   * log-grep patterns simple. The distinction is
   * kept on the type for consumers that want to
   * branch on it (e.g. attach a different "fresh
   * editor" prose).
   */
  readonly mode?: "page" | "edgeless" | null;

  /**
   * Distinct flavours of the elements being operated
   * on (e.g. `["affine:shape", "affine:note"]`).
   * Capped to first 5 entries in the formatter to
   * keep log lines readable; full list is still
   * available via `elementCount`.
   */
  readonly flavours?: ReadonlyArray<string>;

  /**
   * Number of elements the dispatch is operating on.
   * Always set when the dispatch is element-bound;
   * `undefined` for ambient dispatches (e.g. a
   * click on the empty canvas).
   */
  readonly elementCount?: number;

  /**
   * Free-form human-readable tail. Convention: one
   * short English sentence ending in a period, e.g.
   * `"extension handler threw during onDragMove"`.
   * Kept separate from `operation` so the formatter
   * can put `operation` in brackets (machine-readable)
   * and `errorMessage` as prose (human-readable).
   */
  readonly errorMessage?: string;
}
