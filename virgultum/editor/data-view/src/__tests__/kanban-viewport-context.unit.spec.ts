// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `kanban-viewport-context.unit.spec.ts` - P-VIRG-ARCH-E-02.
 *
 * Tests fuer `viewport-context.ts`. PAGE_VIEWPORT ist ein frozen
 * Singleton mit `scale: 1`; der Typ ist strukturell.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-02)
 */

import { describe, expect, it } from "vitest";

import {
  PAGE_VIEWPORT,
  type ViewportContext,
} from "../view-presets/kanban/viewport-context.js";

describe("P-VIRG-ARCH-E-02 PAGE_VIEWPORT", () => {
  it("ist strukturell ein ViewportContext mit scale = 1", () => {
    const ctx: ViewportContext = PAGE_VIEWPORT;
    expect(ctx.scale).toBe(1);
  });

  it("hat keine toCanvasCoord-Funktion (Page = Identity, default)", () => {
    expect(PAGE_VIEWPORT.toCanvasCoord).toBeUndefined();
  });

  it("ist frozen (singleton-safety)", () => {
    expect(Object.isFrozen(PAGE_VIEWPORT)).toBe(true);
  });

  it("Mutation wirft im Strict-Mode (Type-Safety gegen versehentliches Mutieren)", () => {
    "use strict";
    expect(() => {
      (PAGE_VIEWPORT as { scale: number }).scale = 2;
    }).toThrow();
  });
});

describe("P-VIRG-ARCH-E-02 ViewportContext (strukturell)", () => {
  it("akzeptiert Edgeless-Kontext mit toCanvasCoord-Funktion", () => {
    const ctx: ViewportContext = {
      scale: 2,
      toCanvasCoord: (x, y) => ({ x: x / 2, y: y / 2 }),
    };
    expect(ctx.scale).toBe(2);
    expect(ctx.toCanvasCoord?.(4, 6)).toEqual({ x: 2, y: 3 });
  });

  it("akzeptiert Page-Kontext ohne toCanvasCoord-Funktion", () => {
    const ctx: ViewportContext = { scale: 1 };
    expect(ctx.scale).toBe(1);
    expect(ctx.toCanvasCoord).toBeUndefined();
  });
});
