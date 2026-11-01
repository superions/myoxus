// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-G-02: Smoke-Test fuer `SelectionInteractionManager`.
 *
 * Statt einer vollstaendigen Verhaltens-Duplikation (die nur eine
 * zweite Kopie der Manager-Logik waere) verifiziert dieser Test
 * die **Vertragsflaeche**:
 *
 *   1. Der Konstruktor nimmt einen Host und speichert ihn.
 *   2. `getSelectionConfig` ruft `host._gfx.view.get` und
 *      `host._std.getOptional` in der erwarteten Reihenfolge.
 *   3. `getSuggestedTarget` delegiert an `host._interactExtensions`.
 *   4. `handleBoxSelection` ruft `host._gfx.getElementsByBound`
 *      und `host._gfx.view.get` und liefert das gefilterte Array.
 *
 * Negativ-Abnahme: Wenn die Sub-Manager-Klasse nicht exportiert
 * waere oder der Konstruktor die Host-Referenz nicht haelt,
 * brechen diese Tests zusammen.
 */

import { describe, expect, test, vi } from "vitest";

import { SelectionInteractionManager } from "../../gfx/interactivity/selection-interaction-manager.js";

interface MockHost {
  _gfx: unknown;
  _std: unknown;
  _interactExtensions: unknown;
}

function makeMockHost(overrides?: {
  gfx?: unknown;
  std?: unknown;
  interactExtensions?: unknown;
}): MockHost {
  return {
    _gfx: overrides?.gfx ?? {},
    _std: overrides?.std ?? {},
    _interactExtensions: overrides?.interactExtensions ?? [],
  };
}

describe("SelectionInteractionManager (G-02 contract)", () => {
  test("konstruktor speichert host-Referenz", () => {
    const host = makeMockHost();
    const mgr = new SelectionInteractionManager(
      host as unknown as ConstructorParameters<
        typeof SelectionInteractionManager
      >[0],
    );
    expect(mgr).toBeInstanceOf(SelectionInteractionManager);
  });

  test("getSelectionConfig ruft host._gfx.view.get pro model", () => {
    const viewGet = vi.fn().mockReturnValue({ id: "view-1" });
    const getOptional = vi.fn().mockReturnValue(undefined);
    const host = makeMockHost({
      gfx: { view: { get: viewGet } },
      std: { getOptional },
    });
    const mgr = new SelectionInteractionManager(
      host as unknown as ConstructorParameters<
        typeof SelectionInteractionManager
      >[0],
    );
    const models = [{ id: "m1", flavour: "test:block" }];
    const out = mgr.getSelectionConfig(
      models as unknown as Parameters<typeof mgr.getSelectionConfig>[0],
    );
    expect(viewGet).toHaveBeenCalledTimes(1);
    expect(getOptional).toHaveBeenCalledTimes(1);
    expect(out.has("m1")).toBe(true);
  });

  test("getSelectionConfig ueberspringt models ohne view", () => {
    const viewGet = vi.fn().mockReturnValue(undefined);
    const getOptional = vi.fn().mockReturnValue(undefined);
    const host = makeMockHost({
      gfx: { view: { get: viewGet } },
      std: { getOptional },
    });
    const mgr = new SelectionInteractionManager(
      host as unknown as ConstructorParameters<
        typeof SelectionInteractionManager
      >[0],
    );
    const out = mgr.getSelectionConfig([
      { id: "m1", flavour: "test:block" },
    ] as unknown as Parameters<typeof mgr.getSelectionConfig>[0]);
    expect(out.size).toBe(0);
  });

  test("getSuggestedTarget delegiert an host._interactExtensions", () => {
    const emit = vi.fn();
    const host = makeMockHost({
      interactExtensions: [{ action: { emit } }],
    });
    const mgr = new SelectionInteractionManager(
      host as unknown as ConstructorParameters<
        typeof SelectionInteractionManager
      >[0],
    );
    const target = { id: "t1" };
    const out = mgr.getSuggestedTarget({
      candidates: [target as never],
      target: target as never,
    });
    expect(emit).toHaveBeenCalledWith(
      "elementSelect",
      expect.objectContaining({ target, suggest: expect.any(Function) }),
    );
    expect(out).toBe(target);
  });

  test("handleBoxSelection ruft host._gfx.getElementsByBound und liefert gefilterte Liste", () => {
    const element = { id: "e1", isLocked: () => false };
    const onBoxSelected = vi.fn().mockReturnValue(true);
    const viewGet = vi.fn().mockReturnValue({ onBoxSelected });
    const getElementsByBound = vi.fn().mockReturnValue([element]);
    const host = makeMockHost({
      gfx: {
        getElementsByBound,
        view: { get: viewGet },
      },
    });
    const mgr = new SelectionInteractionManager(
      host as unknown as ConstructorParameters<
        typeof SelectionInteractionManager
      >[0],
    );
    const out = mgr.handleBoxSelection({
      box: { x: 0, y: 0, w: 100, h: 100 } as never,
    });
    expect(getElementsByBound).toHaveBeenCalledTimes(1);
    expect(onBoxSelected).toHaveBeenCalledTimes(1);
    expect(out).toEqual([element]);
  });

  test("handleBoxSelection filtert isLocked-Elemente heraus", () => {
    const elementUnlocked = { id: "u1", isLocked: () => false };
    const elementLocked = { id: "l1", isLocked: () => true };
    const host = makeMockHost({
      gfx: {
        getElementsByBound: vi
          .fn()
          .mockReturnValue([elementUnlocked, elementLocked]),
        view: { get: vi.fn().mockReturnValue({ onBoxSelected: () => true }) },
      },
    });
    const mgr = new SelectionInteractionManager(
      host as unknown as ConstructorParameters<
        typeof SelectionInteractionManager
      >[0],
    );
    const out = mgr.handleBoxSelection({
      box: { x: 0, y: 0, w: 100, h: 100 } as never,
    });
    expect(out.map((e) => e.id)).toEqual(["u1"]);
  });
});
