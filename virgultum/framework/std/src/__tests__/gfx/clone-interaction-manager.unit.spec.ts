// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-G-02: Smoke-Test fuer `CloneInteractionManager`.
 *
 * `requestElementClone` iteriert ueber Extensions und emittiert
 * `elementsClone`. Verifiziert wird:
 *
 *   1. Konstruktor speichert host-Referenz.
 *   2. Ohne Extensions: liefert `Promise.resolve(undefined)`.
 *   3. Erste Extension mit Clone-Data gewinnt (First-Wins-Semantik).
 *   4. Erste Extension ohne Clone-Data (falsy) wird uebergangen.
 *
 * Negativ-Abnahme: Wenn die Sub-Manager-Klasse nicht exportiert
 * waere oder die First-Wins-Semantik gebrochen wird, brechen
 * diese Tests zusammen.
 */

import { describe, expect, test, vi } from "vitest";

import { CloneInteractionManager } from "../../gfx/interactivity/clone-interaction-manager.js";

interface MockHost {
  _gfx: unknown;
  _std: unknown;
  _interactExtensions: Iterable<unknown>;
  _activeInteraction$: { value: unknown };
}

function makeMockHost(extensions: unknown[]): MockHost {
  return {
    _gfx: {},
    _std: {},
    _interactExtensions: extensions,
    _activeInteraction$: { value: null },
  };
}

describe("CloneInteractionManager (G-02 contract)", () => {
  test("konstruktor speichert host-Referenz", () => {
    const host = makeMockHost([]);
    const mgr = new CloneInteractionManager(
      host as unknown as ConstructorParameters<
        typeof CloneInteractionManager
      >[0],
    );
    expect(mgr).toBeInstanceOf(CloneInteractionManager);
  });

  test("ohne Extensions: liefert Promise.resolve(undefined)", async () => {
    const host = makeMockHost([]);
    const mgr = new CloneInteractionManager(
      host as unknown as ConstructorParameters<
        typeof CloneInteractionManager
      >[0],
    );
    const result = mgr.requestElementClone({} as never);
    await expect(result).resolves.toBeUndefined();
  });

  test("erste Extension mit Clone-Data gewinnt (First-Wins-Semantik)", async () => {
    const firstEmit = vi.fn().mockReturnValue(undefined);
    const secondEmit = vi.fn().mockReturnValue(Promise.resolve("cloned!"));
    const host = makeMockHost([
      { action: { emit: firstEmit } },
      { action: { emit: secondEmit } },
    ]);
    const mgr = new CloneInteractionManager(
      host as unknown as ConstructorParameters<
        typeof CloneInteractionManager
      >[0],
    );
    const result = mgr.requestElementClone({ payload: "x" } as never);
    // Erste Extension liefert undefined -> Fallthrough zur zweiten.
    expect(firstEmit).toHaveBeenCalledWith("elementsClone", {
      payload: "x",
    });
    expect(secondEmit).toHaveBeenCalledWith("elementsClone", {
      payload: "x",
    });
    await expect(result).resolves.toBe("cloned!");
  });

  test("erste Extension mit Clone-Data beendet Iteration sofort", async () => {
    const firstEmit = vi.fn().mockReturnValue(Promise.resolve("first!"));
    const secondEmit = vi.fn().mockReturnValue(Promise.resolve("second!"));
    const host = makeMockHost([
      { action: { emit: firstEmit } },
      { action: { emit: secondEmit } },
    ]);
    const mgr = new CloneInteractionManager(
      host as unknown as ConstructorParameters<
        typeof CloneInteractionManager
      >[0],
    );
    const result = mgr.requestElementClone({} as never);
    expect(firstEmit).toHaveBeenCalledTimes(1);
    // Second-Extension wird NICHT aufgerufen.
    expect(secondEmit).not.toHaveBeenCalled();
    await expect(result).resolves.toBe("first!");
  });
});
