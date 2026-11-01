// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-G-02: Smoke-Test fuer `MoveInteractionManager`.
 *
 * `handleElementMove` ist stark an GfxController-API gebunden
 * (Viewport-Subscribe, addEventListener, store.transact,
 * activeInteraction$) — eine vollstaendige Verhaltens-Duplikation
 * waere nur eine zweite Kopie der Logik. Stattdessen verifiziert
 * dieser Smoke-Test den Vertrag:
 *
 *   1. Der Konstruktor nimmt einen Host und speichert ihn.
 *   2. `handleElementMove` ruft `host._gfx.viewport.viewportMoved.subscribe`
 *      nicht ohne `movingElements` und ohne `event` auf.
 *
 * Negativ-Abnahme: Wenn die Sub-Manager-Klasse nicht exportiert
 * waere oder `handleElementMove` entfernt wird, brechen diese
 * Tests zusammen.
 */

import { describe, expect, test, vi } from "vitest";

import { MoveInteractionManager } from "../../gfx/interactivity/move-interaction-manager.js";
import { InteractivityManager } from "../../gfx/interactivity/manager.js";
import type { GfxModel } from "../../gfx/model/model.js";
import type { SafeExecuteContext } from "../../gfx/interactivity/safe-execute-context.js";

interface MockHost {
  _gfx: unknown;
  _std: unknown;
  _interactExtensions: unknown;
  _activeInteraction$: { value: unknown };
  _currentMode?: "page" | "edgeless" | null | undefined;
  keyboard: unknown;
  readonly interactExtensions: unknown;
  resolveMoveElements: (elements: readonly GfxModel[]) => GfxModel[];
  _safeExecute: (fn: () => void, ctx: SafeExecuteContext) => void;
}

function makeMockHost(overrides?: {
  gfx?: unknown;
  std?: unknown;
  interactExtensions?: unknown;
  activeInteraction$?: { value: unknown };
  currentMode?: "page" | "edgeless" | null | undefined;
  keyboard?: unknown;
}): MockHost {
  return {
    _gfx: overrides?.gfx ?? {
      viewport: {
        toModelCoordFromClientCoord: () => [0, 0],
        viewportMoved: { subscribe: () => ({ unsubscribe: () => {} }) },
      },
      view: { get: () => undefined },
    },
    _std: overrides?.std ?? {
      host: { addEventListener: () => {}, removeEventListener: () => {} },
      store: { transact: (fn: () => void) => fn() },
    },
    _interactExtensions: overrides?.interactExtensions ?? [],
    get interactExtensions() {
      return this._interactExtensions;
    },
    resolveMoveElements(elements) {
      return InteractivityManager.prototype.resolveMoveElements.call(
        this as unknown as InteractivityManager,
        elements,
      );
    },
    _activeInteraction$: overrides?.activeInteraction$ ?? { value: null },
    _currentMode: overrides?.currentMode,
    keyboard: overrides?.keyboard ?? { shiftKey$: { peek: () => false } },
    _safeExecute: (fn, _ctx) => fn(),
  };
}

describe("MoveInteractionManager (G-02 contract)", () => {
  test("konstruktor speichert host-Referenz", () => {
    const host = makeMockHost();
    const mgr = new MoveInteractionManager(
      host as unknown as ConstructorParameters<
        typeof MoveInteractionManager
      >[0],
    );
    expect(mgr).toBeInstanceOf(MoveInteractionManager);
  });

  test("handleElementMove returnt ohne Fehler bei leerer movingElements-Liste", () => {
    const viewportSubscribe = vi
      .fn()
      .mockReturnValue({ unsubscribe: () => {} });
    const addEventListener = vi.fn();
    const transact = vi.fn((fn) => fn());
    const emit = vi.fn().mockReturnValue(undefined);
    const host = makeMockHost({
      gfx: {
        viewport: {
          toModelCoordFromClientCoord: () => [0, 0],
          viewportMoved: { subscribe: viewportSubscribe },
        },
        view: { get: () => undefined },
      },
      std: {
        host: { addEventListener, removeEventListener: () => {} },
        store: { transact },
      },
      interactExtensions: [{ action: { emit } }],
    });
    const mgr = new MoveInteractionManager(
      host as unknown as ConstructorParameters<
        typeof MoveInteractionManager
      >[0],
    );
    mgr.handleElementMove({
      movingElements: [],
      event: { x: 0, y: 0 } as never,
      onDragEnd: () => {},
    });
    // dragInitialize wird fuer jede Extension aufgerufen, auch
    // bei leerer Liste. Wichtig: kein Crash.
    expect(emit).toHaveBeenCalled();
  });

  test("handleElementMove setzt activeInteraction$ auf type=move (dragStart)", () => {
    const active = { value: null as unknown };
    const addEventListener = vi.fn();
    // Hinweis: `Bound.deserialize(xywh)` parst das echte
    // `deserializeXYWH`-Format. Wir liefern daher eine gueltige
    // CSV-Form '[0,0,10,10]' (das interne "x,y,w,h"-Format).
    const model = {
      xywh: "[0,0,10,10]",
      isLockedByAncestor: () => false,
    };
    const view = {
      onDragStart: vi.fn(),
      onDragEnd: vi.fn(),
      onDragMove: vi.fn(),
    };
    const host = makeMockHost({
      gfx: {
        viewport: {
          toModelCoordFromClientCoord: () => [0, 0],
          viewportMoved: { subscribe: () => ({ unsubscribe: () => {} }) },
        },
        view: { get: () => view },
      },
      std: {
        host: { addEventListener, removeEventListener: () => {} },
        store: { transact: (fn: () => void) => fn() },
      },
      interactExtensions: [{ action: { emit: () => undefined } }],
      activeInteraction$: active,
    });
    const mgr = new MoveInteractionManager(
      host as unknown as ConstructorParameters<
        typeof MoveInteractionManager
      >[0],
    );
    mgr.handleElementMove({
      movingElements: [model as never],
      event: { x: 0, y: 0 } as never,
      onDragEnd: () => {},
    });
    // dragStart setzt activeInteraction$ auf { type: 'move', elements: [...] }
    expect(active.value).toEqual(expect.objectContaining({ type: "move" }));
  });

  // P-VIRG-ARCH-H-02 (Observability, Slice 1):
  // The 4 `_safeExecute` call sites in
  // `handleElementMove` MUST pass a structured
  // `SafeExecuteContext` with a meaningful
  // `operation` field. A thrown handler must
  // surface in the formatter's input — not as
  // a free-form string.
  describe("H-02 _safeExecute context (Observability)", () => {
    test("dragStart dispatch passes 'extension.onDragStart' operation", () => {
      const observed: SafeExecuteContext[] = [];
      const addEventListener = vi.fn();
      const model = {
        xywh: "[0,0,10,10]",
        flavour: "affine:shape",
        isLockedByAncestor: () => false,
      };
      const view = {
        onDragStart: vi.fn(),
        onDragEnd: vi.fn(),
        onDragMove: vi.fn(),
      };
      const host = makeMockHost({
        gfx: {
          viewport: {
            toModelCoordFromClientCoord: () => [0, 0],
            viewportMoved: { subscribe: () => ({ unsubscribe: () => {} }) },
          },
          view: { get: () => view },
        },
        std: {
          host: { addEventListener, removeEventListener: () => {} },
          store: { transact: (fn: () => void) => fn() },
        },
        interactExtensions: [{ action: { emit: () => undefined } }],
        activeInteraction$: { value: null },
      });
      // Replace the no-op _safeExecute with a recorder.
      host._safeExecute = (fn, ctx) => {
        observed.push(ctx);
        fn();
      };
      const mgr = new MoveInteractionManager(
        host as unknown as ConstructorParameters<
          typeof MoveInteractionManager
        >[0],
      );
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      const onStartCall = observed.find(
        (c) => c.operation === "extension.onDragStart",
      );
      expect(onStartCall).toBeDefined();
      expect(onStartCall?.elementCount).toBe(1);
      expect(onStartCall?.flavours).toEqual(["affine:shape"]);
      expect(onStartCall?.errorMessage).toMatch(/onDragStart/);
    });

    test("clear dispatch passes 'extension.clear' operation with element count", () => {
      const observed: SafeExecuteContext[] = [];
      const addEventListener = vi.fn();
      const model = {
        xywh: "[0,0,10,10]",
        flavour: "affine:note",
        isLockedByAncestor: () => false,
      };
      const view = {
        onDragStart: vi.fn(),
        onDragEnd: vi.fn(),
        onDragMove: vi.fn(),
      };
      const host = makeMockHost({
        gfx: {
          viewport: {
            toModelCoordFromClientCoord: () => [0, 0],
            viewportMoved: { subscribe: () => ({ unsubscribe: () => {} }) },
          },
          view: { get: () => view },
        },
        std: {
          host: { addEventListener, removeEventListener: () => {} },
          store: { transact: (fn: () => void) => fn() },
        },
        interactExtensions: [{ action: { emit: () => undefined } }],
        activeInteraction$: { value: null },
      });
      host._safeExecute = (fn, ctx) => {
        observed.push(ctx);
        fn();
      };
      const mgr = new MoveInteractionManager(
        host as unknown as ConstructorParameters<
          typeof MoveInteractionManager
        >[0],
      );
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      // `clear` is dispatched from the `pointerup`
      // handler that `handleElementMove` registered
      // via `host.addEventListener`. The mock is a
      // no-op, so we reach into it to pull the
      // registered `onDragEnd` and invoke it
      // synchronously.
      const pointerupCall = addEventListener.mock.calls.find(
        (call) => call[0] === "pointerup",
      );
      expect(pointerupCall).toBeDefined();
      const onDragEnd = pointerupCall?.[1] as (event: unknown) => void;
      onDragEnd({ x: 1, y: 1 });
      const clearCall = observed.find((c) => c.operation === "extension.clear");
      expect(clearCall).toBeDefined();
      expect(clearCall?.elementCount).toBe(1);
      expect(clearCall?.flavours).toEqual(["affine:note"]);
    });

    test("onDragEnd dispatch passes 'extension.onDragEnd' with element count", () => {
      const observed: SafeExecuteContext[] = [];
      const addEventListener = vi.fn();
      const model = {
        xywh: "[0,0,10,10]",
        flavour: "affine:note",
        isLockedByAncestor: () => false,
      };
      const view = {
        onDragStart: vi.fn(),
        onDragEnd: vi.fn(),
        onDragMove: vi.fn(),
      };
      const host = makeMockHost({
        gfx: {
          viewport: {
            toModelCoordFromClientCoord: () => [0, 0],
            viewportMoved: { subscribe: () => ({ unsubscribe: () => {} }) },
          },
          view: { get: () => view },
        },
        std: {
          host: { addEventListener, removeEventListener: () => {} },
          store: { transact: (fn: () => void) => fn() },
        },
        interactExtensions: [{ action: { emit: () => undefined } }],
        activeInteraction$: { value: null },
      });
      host._safeExecute = (fn, ctx) => {
        observed.push(ctx);
        fn();
      };
      const mgr = new MoveInteractionManager(
        host as unknown as ConstructorParameters<
          typeof MoveInteractionManager
        >[0],
      );
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      const pointerupCall = addEventListener.mock.calls.find(
        (call) => call[0] === "pointerup",
      );
      const onDragEnd = pointerupCall?.[1] as (event: unknown) => void;
      onDragEnd({ x: 1, y: 1 });
      const onEndCall = observed.find(
        (c) => c.operation === "extension.onDragEnd",
      );
      expect(onEndCall).toBeDefined();
      expect(onEndCall?.elementCount).toBe(1);
      expect(onEndCall?.flavours).toEqual(["affine:note"]);
      expect(onEndCall?.errorMessage).toMatch(/onDragEnd/);
    });

    test("multi-flavour drag de-duplicates flavours in the context", () => {
      const observed: SafeExecuteContext[] = [];
      const addEventListener = vi.fn();
      const make = (id: string, flavour: string) => ({
        id,
        xywh: "[0,0,10,10]",
        flavour,
        isLockedByAncestor: () => false,
      });
      const models = [
        make("shape-a", "affine:shape"),
        make("shape-b", "affine:shape"), // duplicate flavour, distinct model
        make("note-a", "affine:note"),
      ];
      const view = {
        onDragStart: vi.fn(),
        onDragEnd: vi.fn(),
        onDragMove: vi.fn(),
      };
      const host = makeMockHost({
        gfx: {
          viewport: {
            toModelCoordFromClientCoord: () => [0, 0],
            viewportMoved: { subscribe: () => ({ unsubscribe: () => {} }) },
          },
          view: { get: () => view },
        },
        std: {
          host: { addEventListener, removeEventListener: () => {} },
          store: { transact: (fn: () => void) => fn() },
        },
        interactExtensions: [{ action: { emit: () => undefined } }],
        activeInteraction$: { value: null },
      });
      host._safeExecute = (fn, ctx) => {
        observed.push(ctx);
        fn();
      };
      const mgr = new MoveInteractionManager(
        host as unknown as ConstructorParameters<
          typeof MoveInteractionManager
        >[0],
      );
      mgr.handleElementMove({
        movingElements: [...models, models[0]] as never,
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      const onStartCall = observed.find(
        (c) => c.operation === "extension.onDragStart",
      );
      expect(onStartCall?.elementCount).toBe(3);
      expect(onStartCall?.flavours?.length).toBe(2);
      expect(new Set(onStartCall?.flavours ?? [])).toEqual(
        new Set(["affine:shape", "affine:note"]),
      );
    });
  });

  // P-VIRG-ARCH-H-02 (Observability, Slice 2):
  // The `_safeExecute` call sites in `handleElementMove`
  // MUST surface the current editor mode in the
  // `SafeExecuteContext`. The mode is read via
  // `this.host._currentMode`, which delegates to the
  // host-injected resolver on `GfxController` (the
  // runtime layer does not import `DocModeProvider`
  // directly).
  //
  // Negative-Abnahme: Wenn `_currentMode` nicht im
  // Mock-Host gesetzt ist, rendert der Formatter `?`
  // (P-VIRG-ARCH-H-02-Slice-1-Kontrakt bleibt
  // rueckwaertskompatibel).
  describe("H-02-Slice-2 _safeExecute mode (Observability)", () => {
    function observeOnce(observed: SafeExecuteContext[]) {
      const addEventListener = vi.fn();
      const model = {
        xywh: "[0,0,10,10]",
        flavour: "affine:shape",
        isLockedByAncestor: () => false,
      };
      const view = {
        onDragStart: vi.fn(),
        onDragEnd: vi.fn(),
        onDragMove: vi.fn(),
      };
      const host = makeMockHost({
        gfx: {
          viewport: {
            toModelCoordFromClientCoord: () => [0, 0],
            viewportMoved: {
              subscribe: () => ({ unsubscribe: () => {} }),
            },
          },
          view: { get: () => view },
        },
        std: {
          host: { addEventListener, removeEventListener: () => {} },
          store: { transact: (fn: () => void) => fn() },
        },
        interactExtensions: [{ action: { emit: () => undefined } }],
        activeInteraction$: { value: null },
      });
      host._safeExecute = (fn, ctx) => {
        observed.push(ctx);
        fn();
      };
      const mgr = new MoveInteractionManager(
        host as unknown as ConstructorParameters<
          typeof MoveInteractionManager
        >[0],
      );
      return { host, mgr, addEventListener, model };
    }

    test("dragStart context carries mode='page' when host reports page", () => {
      const observed: SafeExecuteContext[] = [];
      const { host, mgr, model } = observeOnce(observed);
      host._currentMode = "page";
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      const onStartCall = observed.find(
        (c) => c.operation === "extension.onDragStart",
      );
      expect(onStartCall?.mode).toBe("page");
    });

    test("dragStart context carries mode='edgeless' when host reports edgeless", () => {
      const observed: SafeExecuteContext[] = [];
      const { host, mgr, model } = observeOnce(observed);
      host._currentMode = "edgeless";
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      const onStartCall = observed.find(
        (c) => c.operation === "extension.onDragStart",
      );
      expect(onStartCall?.mode).toBe("edgeless");
    });

    test("dragStart context has mode=undefined when no resolver is wired (backward compat)", () => {
      const observed: SafeExecuteContext[] = [];
      const { mgr, model } = observeOnce(observed);
      // host._currentMode intentionally left undefined.
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      const onStartCall = observed.find(
        (c) => c.operation === "extension.onDragStart",
      );
      // The formatter renders `?` for `undefined` mode
      // (P-VIRG-ARCH-H-02-Slice-1 contract). The
      // context itself is explicit about "unknown"
      // rather than forcing a default.
      expect(onStartCall?.mode).toBeUndefined();
    });

    test("dragStart context carries mode=null when host reports null (provider initialized but unset)", () => {
      const observed: SafeExecuteContext[] = [];
      const { host, mgr, model } = observeOnce(observed);
      host._currentMode = null;
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      const onStartCall = observed.find(
        (c) => c.operation === "extension.onDragStart",
      );
      // `null` is distinct from `undefined` here: the
      // host *has* a resolver, but `getEditorMode()`
      // returned `null` (default state of a fresh
      // `DocModeService`). The formatter renders
      // `?` for both, but the call site that wants
      // to log it differently (e.g. "page by
      // default") gets to see the distinction.
      expect(onStartCall?.mode).toBeNull();
    });

    test("mode is read on every dispatch (not cached at construction)", () => {
      const observed: SafeExecuteContext[] = [];
      const { host, mgr, model, addEventListener } = observeOnce(observed);
      // Start in page mode, then switch to edgeless
      // between dragStart and clear. The second
      // dispatch must report the new mode.
      host._currentMode = "page";
      mgr.handleElementMove({
        movingElements: [model as never],
        event: { x: 0, y: 0 } as never,
        onDragEnd: () => {},
      });
      host._currentMode = "edgeless";
      const pointerupCall = addEventListener.mock.calls.find(
        (call) => call[0] === "pointerup",
      );
      const onDragEnd = pointerupCall?.[1] as (event: unknown) => void;
      onDragEnd({ x: 1, y: 1 });
      const onStartCall = observed.find(
        (c) => c.operation === "extension.onDragStart",
      );
      const onEndCall = observed.find(
        (c) => c.operation === "extension.onDragEnd",
      );
      expect(onStartCall?.mode).toBe("page");
      expect(onEndCall?.mode).toBe("edgeless");
    });
  });
});
