import { ImageLayoutHandlerExtension } from "@virgultum/editor/blocks/image";
import { ListLayoutHandlerExtension } from "@virgultum/editor/blocks/list";
import { ParagraphLayoutHandlerExtension } from "@virgultum/editor/blocks/paragraph";
import { signal } from "@preact/signals-core";
import { DocEmbedProvider } from "@virgultum/editor/shared/services";
import {
  TurboRendererConfigFactory,
  ViewportTurboRendererExtension,
  ViewportTurboRendererIdentifier,
} from "@virgultum/editor/gfx/turbo-renderer";

import { addSampleNotes } from "./doc-generator.js";
import { createPainterWorker, setupEditor } from "./setup.js";

async function init() {
  const params = new URLSearchParams(location.search);
  const room = params.get("room") ?? "";
  if (room.startsWith("playwright")) {
    await setupEditor("page", [
      {
        setup: (di) =>
          di.addImpl(DocEmbedProvider, () => {
            const collection = window.collection;
            const known = (id: string) =>
              Boolean(collection.meta.getDocMeta(id) && collection.getDoc(id));
            // This isolated host authorizes only its own fixture inventory. The
            // production clipboard's source and capture fences remain unchanged.
            const access: DocEmbedProvider = {
              // Card conversions retain an explicit workspace address. Resolve
              // only this fixture pool, just as the host resolves its own pool.
              inWorkspace: (workspaceId) =>
                workspaceId === collection.id
                  ? { access, collection, dispose: () => {} }
                  : undefined,
              canRead: async (id) => known(id),
              readable: (id) => signal(known(id)),
              waitForLoaded: async (id, abort) => {
                abort.throwIfAborted();
                if (!known(id)) throw new Error("Unknown fixture document");
                const doc = collection.getDoc(id)!;
                doc.load();
                abort.throwIfAborted();
                if (!doc.loaded)
                  throw new Error("Fixture document is not loaded");
              },
            };
            return access;
          }),
      },
    ]);
    return;
  }

  await setupEditor("edgeless", [
    ParagraphLayoutHandlerExtension,
    ListLayoutHandlerExtension,
    ImageLayoutHandlerExtension,
    TurboRendererConfigFactory({
      painterWorkerEntry: createPainterWorker,
    }),
    ViewportTurboRendererExtension,
  ]);
  addSampleNotes(doc, 100);
  doc.load();

  const renderer = editor.std.get(
    ViewportTurboRendererIdentifier,
  ) as ViewportTurboRendererExtension;
  window.renderer = renderer;
}

await init();
