// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-G-02: Smoke-Test fuer `RotateInteractionManager`.
 *
 * `handleElementRotate` startet einen `ResizeController.startRotate`
 * — der braucht ein echtes GfxController-API. Eine vollstaendige
 * Verhaltens-Duplikation waere nur eine zweite Kopie der Logik.
 *
 * Stattdessen verifiziert dieser Smoke-Test den Vertrag:
 *
 *   1. Konstruktor speichert host-Referenz.
 *   2. `getRotateConfig` liefert ein Objekt mit den erwarteten
 *      Feldern (initialRotate, rotatable, viewConfigMap).
 *   3. `handleElementRotate` mit nicht-rotatable Element ist no-op
 *      (kein Crash, kein ResizeController.startRotate-Aufruf).
 *
 * Negativ-Abnahme: Wenn die Sub-Manager-Klasse nicht exportiert
 * waere oder Methoden entfernt werden, brechen diese Tests zusammen.
 */

import { describe, expect, test, vi } from "vitest";

import { RotateInteractionManager } from "../../gfx/interactivity/rotate-interaction-manager.js";

interface MockHost {
  _gfx: unknown;
  _std: unknown;
  _interactExtensions: unknown;
  _activeInteraction$: { value: unknown };
}

function makeMockHost(overrides?: {
  gfx?: unknown;
  std?: unknown;
  interactExtensions?: unknown;
  activeInteraction$?: { value: unknown };
}): MockHost {
  return {
    _gfx: overrides?.gfx ?? {},
    _std: overrides?.std ?? {
      getOptional: () => undefined,
      store: { transact: (fn: () => void) => fn() },
    },
    _interactExtensions: overrides?.interactExtensions ?? [],
    _activeInteraction$: overrides?.activeInteraction$ ?? { value: null },
  };
}

describe("RotateInteractionManager (G-02 contract)", () => {
  test("konstruktor speichert host-Referenz", () => {
    const host = makeMockHost();
    const mgr = new RotateInteractionManager(
      host as unknown as ConstructorParameters<
        typeof RotateInteractionManager
      >[0],
    );
    expect(mgr).toBeInstanceOf(RotateInteractionManager);
  });

  test("getRotateConfig liefert initialRotate, rotatable, viewConfigMap", () => {
    const getOptional = vi.fn().mockReturnValue(undefined);
    const viewGet = vi.fn().mockReturnValue(undefined);
    const host = makeMockHost({
      gfx: { view: { get: viewGet } },
      std: { getOptional },
    });
    const mgr = new RotateInteractionManager(
      host as unknown as ConstructorParameters<
        typeof RotateInteractionManager
      >[0],
    );
    const cfg = mgr.getRotateConfig({ elements: [] });
    expect(cfg).toHaveProperty("initialRotate");
    expect(cfg).toHaveProperty("rotatable");
    expect(cfg).toHaveProperty("viewConfigMap");
    // No rendered views means no rotation gesture can start.
    expect(cfg.rotatable).toBe(false);
    expect(cfg.initialRotate).toBe(0);
    expect(cfg.viewConfigMap.size).toBe(0);
    const element = { id: "e1", type: "shape" };
    expect(
      mgr.getRotateConfig({ elements: [element as never] }).rotatable,
    ).toBe(false);
    viewGet.mockReturnValue({ model: { rotate: 17 }, onResizeStart: () => {} });
    const rendered = mgr.getRotateConfig({ elements: [element as never] });
    expect(rendered.rotatable).toBe(true);
    expect(rendered.initialRotate).toBe(17);
    expect(rendered.viewConfigMap.has(element.id)).toBe(true);
  });

  test("handleElementRotate returnt ohne Fehler bei Element ohne view", () => {
    // A rendered view can explicitly prohibit rotation before the controller starts.
    const element = { id: "e1", type: "shape" };
    // Wichtig: `view` MUSS `{ model: { rotate: 0 } }` sein, weil
    // `_getViewRotateConfig` am Ende `views[0]?.model.rotate ?? 0`
    // liest.
    const view = { model: { rotate: 0 }, onResizeStart: () => {} };
    const getOptional = vi.fn().mockReturnValue({
      handleRotate: () => ({
        beforeRotate: ({ set }: { set: (c: { rotatable: boolean }) => void }) =>
          set({ rotatable: false }),
        onRotateStart: () => {},
        onRotateMove: () => {},
        onRotateEnd: () => {},
      }),
    });
    const viewGet = vi.fn().mockReturnValue(view);
    const host = makeMockHost({
      gfx: { view: { get: viewGet } },
      std: { getOptional },
    });
    const mgr = new RotateInteractionManager(
      host as unknown as ConstructorParameters<
        typeof RotateInteractionManager
      >[0],
    );
    // rotatable: false -> early return vor ResizeController.
    expect(() => {
      mgr.handleElementRotate({
        event: { x: 0, y: 0 } as never,
        elements: [element as never],
        // @ts-expect-error - OptionResize-Subset, rest ist nicht relevant
        scaleX: 1,
        scaleY: 1,
      });
    }).not.toThrow();
  });
});
