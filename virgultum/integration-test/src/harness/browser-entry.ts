// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ImageLayoutHandlerExtension } from "@virgultum/editor/blocks/image";
import { ListLayoutHandlerExtension } from "@virgultum/editor/blocks/list";
import { ParagraphLayoutHandlerExtension } from "@virgultum/editor/blocks/paragraph";
import {
  TurboRendererConfigFactory,
  ViewportTurboRendererExtension,
} from "@virgultum/editor/gfx/turbo-renderer";

import {
  createTurboWorker,
  getTurboRenderer,
  mountTestSession,
  populateSampleNotes,
} from "./session.js";

async function bootBrowserHarness(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const room = params.get("room") ?? "";

  if (room.startsWith("playwright")) {
    await mountTestSession("page");
    return;
  }

  await mountTestSession("edgeless", [
    ParagraphLayoutHandlerExtension,
    ListLayoutHandlerExtension,
    ImageLayoutHandlerExtension,
    TurboRendererConfigFactory({
      painterWorkerEntry: createTurboWorker,
    }),
    ViewportTurboRendererExtension,
  ]);
  populateSampleNotes(doc, 100);
  doc.load();
  window.renderer = getTurboRenderer();
}

await bootBrowserHarness();
