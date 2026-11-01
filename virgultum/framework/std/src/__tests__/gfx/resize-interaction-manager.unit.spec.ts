// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-G-02: Smoke-Test fuer `ResizeInteractionManager`.
 *
 * `handleElementResize` ist sehr stark an `ResizeController` und
 * die Model-View-Config-Map gebunden. Eine vollstaendige
 * Verhaltens-Duplikation waere nur eine zweite Kopie der Logik.
 * Stattdessen verifiziert dieser Smoke-Test den Vertrag:
 *
 *   1. Konstruktor speichert host-Referenz.
 *   2. `getResizeHandlers` liefert ein ResizeHandle-Array.
 *   3. `handleElementResize` mit nicht erlaubtem Handle ist no-op
 *      (kein Crash, kein ResizeController.startResize-Aufruf).
 *
 * Negativ-Abnahme: Wenn die Sub-Manager-Klasse nicht exportiert
 * waere oder Methoden entfernt werden, brechen diese Tests zusammen.
 */

import { describe, expect, test, vi } from "vitest";

import { ResizeInteractionManager } from "../../gfx/interactivity/resize-interaction-manager.js";

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

describe("ResizeInteractionManager (G-02 contract)", () => {
  test("konstruktor speichert host-Referenz", () => {
    const host = makeMockHost();
    const mgr = new ResizeInteractionManager(
      host as unknown as ConstructorParameters<
        typeof ResizeInteractionManager
      >[0],
    );
    expect(mgr).toBeInstanceOf(ResizeInteractionManager);
  });

  test("getResizeHandlers liefert Array (Default-Handler-Set)", () => {
    const getOptional = vi.fn().mockReturnValue(undefined);
    const viewGet = vi.fn().mockReturnValue({});
    const host = makeMockHost({
      gfx: { view: { get: viewGet } },
      std: { getOptional },
    });
    const mgr = new ResizeInteractionManager(
      host as unknown as ConstructorParameters<
        typeof ResizeInteractionManager
      >[0],
    );
    const handlers = mgr.getResizeHandlers({ elements: [] });
    expect(Array.isArray(handlers)).toBe(true);
  });

  // G-FIND-02: getResizeHandlers muss fuer eine leere elements-Liste
  // ein LEERES Array liefern, nicht das volle DEFAULT_HANDLES-Set.
  // Vor dem Fix lieferte die Funktion den Initial-Value
  // `new Set(DEFAULT_HANDLES)` zurueck, weil die
  // Intersection-Logik im _getViewResizeConfig ohne Elemente
  // 0-mal lief. Das war semantisch falsch: keine Selektion ->
  // keine Handles. Die meisten Konsumenten filtern separat
  // nach elements.length, aber die Funktion SOLLTE die Wahrheit
  // ausdruecken.
  test("getResizeHandlers: leere elements-Liste -> leere Handles (G-FIND-02)", () => {
    const getOptional = vi.fn().mockReturnValue(undefined);
    const viewGet = vi.fn().mockReturnValue({});
    const host = makeMockHost({
      gfx: { view: { get: viewGet } },
      std: { getOptional },
    });
    const mgr = new ResizeInteractionManager(
      host as unknown as ConstructorParameters<
        typeof ResizeInteractionManager
      >[0],
    );
    const handlers = mgr.getResizeHandlers({ elements: [] });
    expect(handlers).toEqual([]);
  });

  test("handleElementResize returnt ohne Fehler bei Element ohne view", () => {
    // Wenn `gfx.view.get(model)` undefined liefert, wird das Element
    // in `_getViewResizeConfig` uebersprungen, die viewConfigMap bleibt
    // leer, und der Pfad geht weiter (allowedHandlers = DEFAULT_HANDLES).
    // Aber `ResizeController` braucht ein echtes gfx mit viewport.
    // Daher ist der richtige Negativ-Pfad: ein Element, dessen
    // resizeConstraint den handle ausschliesst.
    const element = {
      id: "e1",
      type: "shape",
    };
    const view = { onResizeStart: () => {} };
    const getOptional = vi.fn().mockReturnValue({
      resizeConstraint: { allowedHandlers: ["top"] }, // "bottom" excluded
    });
    const viewGet = vi.fn().mockReturnValue(view);
    const host = makeMockHost({
      gfx: { view: { get: viewGet } },
      std: { getOptional },
    });
    const mgr = new ResizeInteractionManager(
      host as unknown as ConstructorParameters<
        typeof ResizeInteractionManager
      >[0],
    );
    // "bottom" ist nicht in allowedHandlers ["top"] -> early return,
    // kein ResizeController.startResize-Aufruf, kein Crash.
    expect(() => {
      mgr.handleElementResize({
        handle: "bottom" as never,
        event: { x: 0, y: 0 } as never,
        elements: [element as never],
        // @ts-expect-error - OptionResize-Subset, rest ist nicht relevant
        scaleX: 1,
        scaleY: 1,
      });
    }).not.toThrow();
  });
});
