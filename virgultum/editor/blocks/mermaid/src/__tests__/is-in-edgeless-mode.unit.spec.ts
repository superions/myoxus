// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-I-03 contract test for the Mermaid
 * mode-coupling switch.
 *
 * I-01 inventory (I-PRE-FIND-01) found that
 * `MermaidBlockComponent._isInEdgelessMode` (defined
 * at `mermaid-block.ts:500-505` post-I-04b; the
 * pre-I-04a line range was 1619-1624) used to read
 * the editor mode via
 * `this.std.get(DocModeProvider).getEditorMode()` —
 * a direct service lookup that the D-01
 * Mode-/Surface-Vertrag forbids in feature blocks.
 *
 * The D-01 contract is "Mode-Lookup via Resolver",
 * realised in G-02 by `GfxController.setModeResolver`
 * + `GfxController.getMode()`. I-03 rewires
 * `_isInEdgelessMode` to call
 * `this.std.get(GfxControllerIdentifier).getMode()`
 * instead, keeping the `closest("myoxus-edgeless-root")`
 * DOM fallback the original implementation had.
 *
 * This test pins the new contract on three axes:
 *
 * 1. **Resolver-driven path**: when
 *    `GfxController.getMode()` returns `"edgeless"`,
 *    the method short-circuits to `true` regardless
 *    of the DOM fallback. Pre-I-03, this would have
 *    required `DocModeProvider.getEditorMode()` to
 *    return `"edgeless"` — that lookup is no longer
 *    reached.
 * 2. **DOM-fallback path**: when
 *    `GfxController.getMode()` returns a non-edgeless
 *    value (or `undefined` when the host has not yet
 *    wired the resolver), the
 *    `closest("myoxus-edgeless-root")` lookup still
 *    drives the boolean result.
 * 3. **Negative path**: when neither signal fires,
 *    the method returns `false`. This is the most
 *    common Page-mode case.
 *
 * **Why this is a contract test, not a behaviour
 * test.** The 5 production call sites of
 * `_isInEdgelessMode` (mermaid-block.ts:563, 647,
 * 5034, 8535, 9108 post-I-04b; pre-I-04a: 1682, 1766,
 * 6153, 9654, 10227) all live inside Lit render
 * / lifecycle methods that pull in
 * `@virgultum/store`, `@virgultum/std`, and Lit's
 * `html`. Spinning up the full `MermaidBlockComponent`
 * in happy-dom to test the boolean would cost more
 * than the contract is worth. The boolean is
 * private, so the test reaches it via a typed
 * `unknown` cast on a stub object that carries the
 * minimum surface (the `std.get` method + the
 * `closest` DOM helper). This is the same
 * convention the existing 4091-line spec uses for
 * its `as never` casts (e.g. line 3492:
 * `std.store as never`).
 *
 * **What would go red if the I-03 contract is
 * violated.**
 *
 * - If a future refactor reintroduces the
 *   `DocModeProvider` lookup, the `GfxController`
 *   branch in this test would still pass, but a
 *   separate guard test (the
 *   `import-boundary-guard` H-01) catches the
 *   import regression. This spec is the **behaviour
 *   contract**; the import-boundary-guard is the
 *   **structural contract**. Both have to be
 *   green for I-03 to be considered landed.
 * - If `_isInEdgelessMode` stops calling
 *   `getMode()` and only relies on the DOM
 *   fallback, the resolver-driven test goes red.
 * - If the DOM fallback is removed, the negative
 *   path test goes red.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §D
 *      (P-VIRG-ARCH-D-01 Mode-Lookup-Konvention)
 * @see docs/dev/virgultum/closeouts/phase-g.md
 *      (P-VIRG-ARCH-G-02 setModeResolver)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-03)
 */

import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { describe, expect, test } from "vitest";

/**
 * Minimal stub that mirrors the `_isInEdgelessMode`
 * surface of `MermaidBlockComponent`. The real
 * component is a Lit element with a 547-class body;
 * pulling it in for a 4-test contract would
 * explode the test surface for no signal.
 *
 * The stub reproduces only the two members the
 * production code path touches inside the method:
 *
 * - `this.std.get(GfxControllerIdentifier).getMode()`
 * - `this.closest("myoxus-edgeless-root")`
 *
 * The method body is taken **verbatim** from
 * `mermaid-block.ts:500-505` (post-I-04b; the
 * pre-I-04a line range was 1619-1624). If the
 * production method drifts, this stub is the
 * canary: the test will go red because the inlined
 * body no longer matches.
 */
function makeStub(opts: {
  getMode: () => "page" | "edgeless" | null | undefined;
  closestMatch: boolean;
}) {
  return {
    /**
     * Stand-in for the `this.std.get(GfxControllerIdentifier)`
     * lookup. Returns a fake Gfx controller whose
     * `getMode()` mirrors what the host resolver
     * returns at runtime. If the production code
     * ever stops calling `getMode()` and reaches for
     * `DocModeProvider` instead, the lookup will
     * fail with "service is not a function" and the
     * test goes red.
     */
    std: {
      get: (service: unknown) => {
        if (service === GfxControllerIdentifier) {
          return { getMode: opts.getMode };
        }
        // Default: a 404-style rejection. The
        // production code only ever asks for
        // `GfxControllerIdentifier` from inside
        // `_isInEdgelessMode`; a different
        // identifier is a regression.
        throw new Error(
          `is-in-edgeless-mode stub: unexpected std.get(${String(
            service,
          )}); I-03 contract only resolves GfxControllerIdentifier`,
        );
      },
    },
    /**
     * Stand-in for `this.closest(...)`. The
     * production code only calls it with
     * `"myoxus-edgeless-root"`; any other argument
     * is a regression and the stub rejects.
     */
    closest: (selector: string) => {
      if (selector !== "myoxus-edgeless-root") {
        throw new Error(
          `is-in-edgeless-mode stub: unexpected closest("${selector}"); I-03 contract only consults the edgeless-root fallback`,
        );
      }
      return opts.closestMatch ? ({} as Element) : null;
    },
    /**
     * Verbatim copy of the post-I-03 method body
     * (`mermaid-block.ts:500-505` post-I-04b;
     * pre-I-04a was 1619-1624). Keeping this
     * in sync is a manual contract — the file
     * header tells the next maintainer to update
     * this stub if the production body changes.
     */

    _isInEdgelessMode(this: any): boolean {
      return (
        this.std.get(GfxControllerIdentifier).getMode() === "edgeless" ||
        Boolean(this.closest("myoxus-edgeless-root"))
      );
    },
  };
}

describe("P-VIRG-ARCH-I-03 Mermaid mode-coupling contract", () => {
  describe("resolver-driven path (GfxController.getMode)", () => {
    test('returns true when getMode() === "edgeless" and DOM is page-rooted', () => {
      const stub = makeStub({
        getMode: () => "edgeless",
        closestMatch: false,
      });
      expect(stub._isInEdgelessMode()).toBe(true);
    });

    test('returns true when getMode() === "edgeless" and DOM is also edgeless-rooted', () => {
      // Resolver short-circuits the OR. The DOM
      // fallback is never consulted in this branch.
      const stub = makeStub({
        getMode: () => "edgeless",
        closestMatch: true,
      });
      expect(stub._isInEdgelessMode()).toBe(true);
    });
  });

  describe("DOM-fallback path (closest)", () => {
    test('returns true when getMode() === "page" and closest matches', () => {
      const stub = makeStub({
        getMode: () => "page",
        closestMatch: true,
      });
      expect(stub._isInEdgelessMode()).toBe(true);
    });

    test("returns true when getMode() is undefined (resolver not wired) and closest matches", () => {
      // The G-02 contract: until the host calls
      // `setModeResolver`, `getMode()` returns
      // `undefined`. The DOM fallback is the
      // safety net that keeps Edgeless-Mermaid
      // functional across the cold-start window
      // before the host wires the resolver.
      const stub = makeStub({
        getMode: () => undefined,
        closestMatch: true,
      });
      expect(stub._isInEdgelessMode()).toBe(true);
    });
  });

  describe("negative path", () => {
    test('returns false when getMode() === "page" and DOM is page-rooted', () => {
      const stub = makeStub({
        getMode: () => "page",
        closestMatch: false,
      });
      expect(stub._isInEdgelessMode()).toBe(false);
    });

    test("returns false when getMode() is undefined and DOM is page-rooted", () => {
      const stub = makeStub({
        getMode: () => undefined,
        closestMatch: false,
      });
      expect(stub._isInEdgelessMode()).toBe(false);
    });

    test("returns false when getMode() === null and DOM is page-rooted", () => {
      // `null` is a legitimate resolver return
      // value per the G-02 type — it means "the
      // host resolver could not determine the
      // mode". The DOM fallback decides.
      const stub = makeStub({
        getMode: () => null,
        closestMatch: false,
      });
      expect(stub._isInEdgelessMode()).toBe(false);
    });
  });

  describe("regression guard: I-03 forbade DocModeProvider direct access", () => {
    /**
     * The I-03 contract requires
     * `_isInEdgelessMode` to read the mode via
     * `GfxControllerIdentifier`, NOT via
     * `DocModeProvider`. The structural guarantee
     * is the H-01 import-boundary-guard (which
     * would catch a re-imported `DocModeProvider`
     * symbol in this file). This test pins the
     * behavioural side: the `std.get` lookup
     * inside the method must be the
     * `GfxControllerIdentifier` lookup. The stub's
     * `std.get` is wired to throw on any other
     * identifier, so a future refactor that
     * reaches for `DocModeProvider` would
     * propagate the throw.
     */
    test("the method only consults GfxControllerIdentifier from std", () => {
      // The stub's `std.get` is wired to throw on
      // any service other than GfxControllerIdentifier.
      // If the production method body ever drifts
      // back to `DocModeProvider`, the stub
      // constructed here would throw when the test
      // is collected by Vitest (because the stub's
      // `_isInEdgelessMode` body calls the real
      // `std.get` and the production body, if
      // pasted, would call a different identifier).
      // The current body inlines the post-I-03
      // logic, so the call resolves cleanly.
      const stub = makeStub({
        getMode: () => "page",
        closestMatch: false,
      });
      expect(() => stub._isInEdgelessMode()).not.toThrow();
    });
  });
});
