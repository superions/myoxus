/**
 * See docs/dev/virgultum/testing-and-qa.md for test commands.
 */
import { ParagraphLayoutHandlerExtension } from "@virgultum/editor/blocks/paragraph";
import { noop } from "@virgultum/editor/global/utils";
import {
  TurboRendererConfigFactory,
  ViewportTurboRendererExtension,
} from "@virgultum/editor/gfx/turbo-renderer";
import { firstValueFrom } from "rxjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { wait } from "../utils/common.js";
import { addSampleNotes } from "../utils/doc-generator.js";
import {
  createPainterWorker,
  getRenderer,
  setupEditor,
} from "../utils/setup.js";

const FRAME = 16;

describe("viewport turbo renderer", () => {
  let cleanup: () => void;
  let painterWorker: Worker;

  beforeEach(async () => {
    cleanup = await setupEditor("edgeless", [
      ParagraphLayoutHandlerExtension,
      TurboRendererConfigFactory({
        painterWorkerEntry: () => {
          painterWorker = createPainterWorker();
          return painterWorker;
        },
      }),
      ViewportTurboRendererExtension,
    ]);
    return cleanup;
  });

  afterEach(() => cleanup?.());

  test("should access turbo renderer instance and receive its worker bitmap", async () => {
    const renderer = getRenderer();
    expect(renderer).toBeDefined();
    expect(renderer instanceof ViewportTurboRendererExtension).toBe(true);
    expect(renderer.canvas).toBeInstanceOf(HTMLCanvasElement);

    // The renderer can exist while a view/CSS import crashes its worker.
    // Exercise the real worker's existing paint protocol, not main-thread state.
    const painted = new Promise<MessageEvent>((resolve, reject) => {
      painterWorker.addEventListener("message", resolve, { once: true });
      painterWorker.addEventListener("error", reject, { once: true });
    });
    painterWorker.postMessage({
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
    const { data } = await painted;
    try {
      expect(data.type).toBe("bitmapPainted");
      expect(data.version).toBe(1);
      expect(data.bitmap).toBeInstanceOf(ImageBitmap);
      expect([data.bitmap.width, data.bitmap.height]).toEqual([2, 2]);
    } finally {
      data.bitmap?.close();
    }
  });

  test("initial state should be pending", async () => {
    const renderer = getRenderer();
    expect(renderer.state$.value).toBe("pending");
  });

  test("zooming should change internal state and populate optimized block ids", async () => {
    const renderer = getRenderer();
    addSampleNotes(doc, 1);
    await wait(FRAME);
    expect(renderer.optimizedBlockIds.length).toBe(0);

    renderer.viewport.zooming$.next(true);
    const nextState = await firstValueFrom(renderer.state$);
    expect(nextState).toBe("zooming");

    const canUseCache = renderer.canUseBitmapCache();
    expect(canUseCache).toBe(false);

    // Initialization can still end its own viewport zoom. Keep this test's
    // synthetic gesture active until its scheduled placeholder pass completes.
    await expect
      .poll(async () => {
        renderer.viewport.zooming$.next(true);
        await renderer.refresh();
        return renderer.optimizedBlockIds;
      })
      .toHaveLength(1);

    renderer.viewport.zooming$.next(false);
    await wait(renderer.options.debounceTime + 100);

    expect(renderer.state$.value).not.toBe("zooming");
    expect(renderer.optimizedBlockIds.length).toBe(0);
  });

  test("state transitions between pending and ready", async () => {
    const renderer = getRenderer();

    addSampleNotes(doc, 1);
    await wait(FRAME);
    expect(renderer.state$.value).toBe("pending");

    // Ensure zooming is off and wait for debounce + buffer
    renderer.viewport.zooming$.next(false);
    await wait(renderer.options.debounceTime + 500);
    expect(renderer.state$.value).toBe("ready");
  });

  test("initial layout cache data should be null", () => {
    const renderer = getRenderer();
    expect(renderer.layoutCacheData).toBeNull();
  });

  test("invalidation should reset layout cache data to null", async () => {
    const renderer = getRenderer();
    addSampleNotes(doc, 1);
    await wait(100);

    // Access getter to populate cache
    const _cache = renderer.layoutCache;
    noop(_cache);
    expect(renderer.layoutCacheData).not.toBeNull();

    // Invalidate
    addSampleNotes(doc, 1);
    await wait(100);

    expect(renderer.layoutCacheData).toBeNull();
  });

  test("accessing layoutCache getter should populate cache data", async () => {
    const renderer = getRenderer();
    addSampleNotes(doc, 1);
    await wait(FRAME);
    expect(renderer.layoutCacheData).toBeNull();

    const _cache = renderer.layoutCache;
    noop(_cache);
    expect(renderer.layoutCacheData).not.toBeNull();
    expect(renderer.layoutCache?.roots.length).toBeGreaterThan(0);
  });
});
