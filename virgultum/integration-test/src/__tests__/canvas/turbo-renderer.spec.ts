// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ParagraphLayoutHandlerExtension } from "@virgultum/editor/blocks/paragraph";
import {
  TurboRendererConfigFactory,
  ViewportTurboRendererExtension,
} from "@virgultum/editor/gfx/turbo-renderer";
import { firstValueFrom } from "rxjs";
import { beforeEach, describe, expect, test } from "vitest";

import { flushFrame } from "../../harness/pointer.js";
import {
  createTurboWorker,
  getTurboRenderer,
  mountTestSession,
  populateSampleNotes,
} from "../../harness/session.js";

const FRAME_MS = 16;

describe("ViewportTurboRendererExtension and worker paint protocol", () => {
  let activeWorker: Worker;

  beforeEach(async () => {
    return mountTestSession("edgeless", [
      ParagraphLayoutHandlerExtension,
      TurboRendererConfigFactory({
        painterWorkerEntry: () => {
          activeWorker = createTurboWorker();
          return activeWorker;
        },
      }),
      ViewportTurboRendererExtension,
    ]);
  });

  test("receives painted ImageBitmap responses from turbo-worker.ts", async () => {
    const renderer = getTurboRenderer();
    expect(renderer).toBeInstanceOf(ViewportTurboRendererExtension);
    expect(renderer.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(renderer.state$.value).toBe("pending");
    expect(renderer.layoutCacheData).toBeNull();

    const response = new Promise<MessageEvent>((resolve, reject) => {
      activeWorker.addEventListener("message", resolve, { once: true });
      activeWorker.addEventListener("error", reject, { once: true });
    });

    activeWorker.postMessage({
      type: "paintLayout",
      data: {
        layout: { roots: [], overallRect: { x: 0, y: 0, w: 2, h: 2 } },
        width: 2,
        height: 2,
        dpr: 1,
        zoom: 1,
        version: 1,
      },
    });

    const { data } = await response;
    try {
      expect(data.type).toBe("bitmapPainted");
      expect(data.version).toBe(1);
      expect(data.bitmap).toBeInstanceOf(ImageBitmap);
      expect([data.bitmap.width, data.bitmap.height]).toEqual([2, 2]);
    } finally {
      data.bitmap?.close();
    }
  });

  test("tracks zooming state, bitmap cache eligibility, and optimizedBlockIds", async () => {
    const renderer = getTurboRenderer();
    populateSampleNotes(doc, 1);
    await flushFrame(FRAME_MS);
    expect(renderer.optimizedBlockIds).toHaveLength(0);

    renderer.viewport.zooming$.next(true);
    expect(await firstValueFrom(renderer.state$)).toBe("zooming");
    expect(renderer.canUseBitmapCache()).toBe(false);

    await expect
      .poll(async () => {
        renderer.viewport.zooming$.next(true);
        await renderer.refresh();
        return renderer.optimizedBlockIds;
      })
      .toHaveLength(1);

    renderer.viewport.zooming$.next(false);
    await flushFrame(renderer.options.debounceTime + 100);
    expect(renderer.state$.value).not.toBe("zooming");
    expect(renderer.optimizedBlockIds).toHaveLength(0);
  });

  test("transitions from pending to ready after debounce settles", async () => {
    const renderer = getTurboRenderer();
    populateSampleNotes(doc, 1);
    await flushFrame(FRAME_MS);
    expect(renderer.state$.value).toBe("pending");

    renderer.viewport.zooming$.next(false);
    await flushFrame(renderer.options.debounceTime + 500);
    expect(renderer.state$.value).toBe("ready");
  });

  test("populates layoutCache lazily and invalidates it on document updates", async () => {
    const renderer = getTurboRenderer();
    populateSampleNotes(doc, 1);
    await flushFrame(100);
    expect(renderer.layoutCacheData).toBeNull();

    const cache = renderer.layoutCache;
    expect(renderer.layoutCacheData).not.toBeNull();
    expect(cache?.roots.length).toBeGreaterThan(0);

    populateSampleNotes(doc, 1);
    await flushFrame(100);
    expect(renderer.layoutCacheData).toBeNull();
  });
});
