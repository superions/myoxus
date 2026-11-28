// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createTemplateJob } from "@virgultum/editor/gfx/template";
import { FontFamily } from "@virgultum/editor/model";
import type { EditorHost } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { type BlockSnapshot, nanoid } from "@virgultum/editor/store";

import { markdownToSnapshot } from "../../utils";
import { AIProvider } from "../provider";
import { getSurfaceElementFromEditor } from "../utils/selection-utils";
import { SLIDE_BACKGROUND_URLS } from "./slide-backgrounds";

export interface SlideSection {
  title: string;
  content: string;
  keywords: string;
}

export interface SlideSpec {
  isCover: boolean;
  title: string;
  sections: SlideSection[];
}

export interface SlideAsset {
  id: string;
  url: string;
}

/** Alias kept for AIContext consumers expecting slide asset descriptors. */
export type TemplateImage = SlideAsset;

export interface SlideTemplateBlock {
  type: "block";
  id: string;
  flavour: string;
  version: number;
  props: Record<string, unknown>;
  children: SlideTemplateBlock[];
}

export interface SlideTemplatePayload {
  type: "page";
  meta: {
    id: string;
    title: string;
    createDate: number;
    tags: string[];
  };
  blocks: SlideTemplateBlock;
}

export interface BuiltSlide {
  content: SlideTemplatePayload;
  images: SlideAsset[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SLIDE_W = 1920;
const SLIDE_H = 1080;
const FRAME_PAD = 40;
const MARGIN_X = 96;
const MARGIN_Y = 84;
const TEXT_COLOR = "--myoxus-palette-line-black";
const FRAME_BG = "--myoxus-palette-transparent";
const TEXT_FONT = FontFamily.Poppins;

function serializeRect({ x, y, w, h }: Rect): string {
  return JSON.stringify([x, y, w, h]);
}

function stableIndex(key: string, length: number): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % length;
}

async function resolveSectionPhoto(
  keywords: string,
  rect: Rect,
): Promise<string | null> {
  const query = keywords.trim();
  if (!query || !AIProvider.photoEngine) return null;
  try {
    const photos = await AIProvider.photoEngine.searchImages({
      query,
      width: Math.round(rect.w),
      height: Math.round(rect.h),
    });
    if (!photos?.length) return null;
    const chosen =
      photos[stableIndex(`${rect.w}x${rect.h}:${query}`, photos.length)];
    return chosen || null;
  } catch {
    return null;
  }
}

function createTextElement(
  id: string,
  index: string,
  text: string,
  rect: Rect,
  fontSize: number,
  fontWeight: "400" | "600" | "700" = "400",
): Record<string, unknown> {
  return {
    id,
    type: "text",
    index,
    seed: Math.floor(Math.random() * 1_000_000_000) + 1,
    xywh: serializeRect(rect),
    rotate: 0,
    text: {
      "myoxus:surface:text": true,
      delta: [{ insert: text }],
    },
    color: TEXT_COLOR,
    fontSize,
    fontFamily: TEXT_FONT,
    fontWeight,
    fontStyle: "normal",
    textAlign: "left",
    hasMaxWidth: true,
  };
}

function createImageBlock(
  id: string,
  sourceId: string,
  index: string,
  rect: Rect,
): SlideTemplateBlock {
  return {
    type: "block",
    id,
    flavour: "myoxus:image",
    version: 1,
    props: {
      sourceId,
      width: Math.round(rect.w),
      height: Math.round(rect.h),
      index,
      xywh: serializeRect(rect),
      rotate: 0,
      size: 0,
    },
    children: [],
  };
}

function backgroundForSectionCount(count: number): string {
  if (count >= 4) return SLIDE_BACKGROUND_URLS.fourSections;
  if (count === 3) return SLIDE_BACKGROUND_URLS.threeSections;
  return SLIDE_BACKGROUND_URLS.twoSections;
}

/**
 * Programmatically builds a single Virgultum canvas slide frame snapshot.
 * Background artwork uses local SVG data URLs; optional section photos hydrate
 * through `AIProvider.photoEngine` and degrade cleanly when unavailable.
 */
export async function buildSlideTemplate(spec: SlideSpec): Promise<BuiltSlide> {
  const sections = spec.sections.slice(0, 4);
  const elements: Record<string, Record<string, unknown>> = {};
  const surfaceChildren: SlideTemplateBlock[] = [];
  const childElementIds: Record<string, boolean> = {};
  const images: SlideAsset[] = [];

  let zOrder = 1;
  const nextIndex = () => `a${zOrder++}`;

  const addText = (
    text: string,
    rect: Rect,
    fontSize: number,
    fontWeight: "400" | "600" | "700" = "400",
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = nanoid();
    elements[id] = createTextElement(
      id,
      nextIndex(),
      trimmed,
      rect,
      fontSize,
      fontWeight,
    );
    childElementIds[id] = true;
  };

  const addImage = (url: string, rect: Rect, indexOverride?: string) => {
    const id = nanoid();
    const sourceId = nanoid();
    surfaceChildren.push(
      createImageBlock(id, sourceId, indexOverride ?? nextIndex(), rect),
    );
    childElementIds[id] = true;
    images.push({ id: sourceId, url });
  };

  // Always place the local SVG background at the bottom of the frame.
  addImage(
    backgroundForSectionCount(sections.length),
    { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H },
    "a0",
  );

  if (spec.isCover) {
    const lead = sections[0];
    const heroRect: Rect = { x: 1120, y: 140, w: 700, h: 800 };
    const heroUrl = lead
      ? await resolveSectionPhoto(lead.keywords, heroRect)
      : null;
    if (heroUrl) {
      addImage(heroUrl, heroRect);
    }
    const textWidth = heroUrl ? 960 : SLIDE_W - MARGIN_X * 2;
    addText(
      lead?.title || spec.title,
      { x: MARGIN_X, y: 260, w: textWidth, h: 240 },
      96,
      "700",
    );
    if (lead?.content) {
      addText(
        lead.content,
        { x: MARGIN_X, y: 540, w: textWidth, h: 280 },
        36,
        "400",
      );
    }
  } else {
    // Slide title banner
    addText(
      spec.title,
      { x: MARGIN_X, y: MARGIN_Y, w: SLIDE_W - MARGIN_X * 2, h: 110 },
      64,
      "700",
    );

    const contentTop = 230;
    const contentWidth = SLIDE_W - MARGIN_X * 2;
    const contentHeight = SLIDE_H - contentTop - MARGIN_Y;
    const count = Math.max(1, sections.length);

    if (count === 1) {
      const s = sections[0];
      if (s) {
        const photoRect: Rect = {
          x: MARGIN_X + 1020,
          y: contentTop,
          w: contentWidth - 1020,
          h: contentHeight,
        };
        const photoUrl = await resolveSectionPhoto(s.keywords, photoRect);
        if (photoUrl) addImage(photoUrl, photoRect);
        const colW = photoUrl ? 960 : contentWidth;
        addText(
          s.title,
          { x: MARGIN_X, y: contentTop, w: colW, h: 90 },
          44,
          "600",
        );
        addText(
          s.content,
          { x: MARGIN_X, y: contentTop + 110, w: colW, h: contentHeight - 110 },
          30,
          "400",
        );
      }
    } else if (count === 2 || count === 3) {
      const gap = 56;
      const colW = Math.floor((contentWidth - gap * (count - 1)) / count);
      const photoUrls = await Promise.all(
        sections.map((section, idx) =>
          resolveSectionPhoto(section.keywords, {
            x: MARGIN_X + idx * (colW + gap),
            y: contentTop,
            w: colW,
            h: 320,
          }),
        ),
      );

      sections.forEach((section, idx) => {
        const x = MARGIN_X + idx * (colW + gap);
        const photoUrl = photoUrls[idx];
        let cursorY = contentTop;
        if (photoUrl) {
          addImage(photoUrl, { x, y: cursorY, w: colW, h: 320 });
          cursorY += 352;
        }
        addText(section.title, { x, y: cursorY, w: colW, h: 72 }, 36, "600");
        cursorY += 84;
        addText(
          section.content,
          {
            x,
            y: cursorY,
            w: colW,
            h: Math.max(180, SLIDE_H - MARGIN_Y - cursorY),
          },
          26,
          "400",
        );
      });
    } else {
      // 4-section 2x2 grid
      const gapX = 64;
      const gapY = 48;
      const cellW = Math.floor((contentWidth - gapX) / 2);
      const cellH = Math.floor((contentHeight - gapY) / 2);

      sections.forEach((section, idx) => {
        const col = idx % 2;
        const row = Math.floor(idx / 2);
        const x = MARGIN_X + col * (cellW + gapX);
        const y = contentTop + row * (cellH + gapY);
        addText(section.title, { x, y, w: cellW, h: 64 }, 34, "600");
        addText(
          section.content,
          { x, y: y + 76, w: cellW, h: cellH - 76 },
          24,
          "400",
        );
      });
    }
  }

  const frameBlock: SlideTemplateBlock = {
    type: "block",
    id: nanoid(),
    flavour: "myoxus:frame",
    version: 1,
    props: {
      title: {
        "$virgultum:internal:text$": true,
        delta: [{ insert: spec.title || "Slide" }],
      },
      background: FRAME_BG,
      xywh: serializeRect({
        x: -FRAME_PAD,
        y: -FRAME_PAD,
        w: SLIDE_W + FRAME_PAD * 2,
        h: SLIDE_H + FRAME_PAD * 2,
      }),
      index: "Zz",
      childElementIds,
    },
    children: [],
  };
  surfaceChildren.push(frameBlock);

  const content: SlideTemplatePayload = {
    type: "page",
    meta: {
      id: `slide:${nanoid()}`,
      title: spec.title,
      createDate: Date.now(),
      tags: [],
    },
    blocks: {
      type: "block",
      id: nanoid(),
      flavour: "myoxus:page",
      version: 2,
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: nanoid(),
          flavour: "myoxus:surface",
          version: 5,
          props: { elements },
          children: surfaceChildren,
        },
      ],
    },
  };

  return { content, images };
}

function readBlockText(block: BlockSnapshot | undefined): string {
  if (!block) return "";
  const textProp = block.props.text as
    { delta?: Array<{ insert?: unknown }> } | undefined;
  const firstInsert = textProp?.delta?.[0]?.insert;
  return typeof firstInsert === "string" ? firstInsert : "";
}

/**
 * Parses AI slide markdown into canvas frames inside a preview `EditorHost`
 * and returns the generated template payloads and asset maps for insertion.
 */
export function createSlideDeckBuilder(
  host: EditorHost,
  sourceHost: EditorHost = host,
) {
  const gfx = host.std.get(GfxControllerIdentifier);
  const slides: SlideSpec[] = [];
  const contents: SlideTemplatePayload[] = [];
  const allImages: SlideAsset[][] = [];
  const root = host.store.root;

  const insertSlideBlock = async (
    block: BlockSnapshot,
    assertCurrent: () => void,
  ) => {
    const ensureDestination = () => {
      assertCurrent();
      if (
        !host.isConnected ||
        !sourceHost.isConnected ||
        host.store.readonly ||
        !root ||
        host.store.root !== root
      ) {
        throw new Error("Markdown slide preview destination unavailable");
      }
    };
    ensureDestination();

    const sections: SlideSection[] = block.children.map((sectionBlock) => ({
      title: readBlockText(sectionBlock),
      keywords: readBlockText(sectionBlock.children[0]),
      content: readBlockText(sectionBlock.children[1]),
    }));

    const spec: SlideSpec = {
      isCover: slides.length === 0,
      title: readBlockText(block),
      sections,
    };

    const job = createTemplateJob(host.std, "template");
    using transformer = job.job;
    const { images, content } = await buildSlideTemplate(spec);

    if (images.length) {
      await Promise.all(
        images.map(async ({ id, url }) => {
          const response = await fetch(url);
          const blob = await response.blob();
          transformer.assets.set(id, blob);
        }),
      );
    }

    await job.insertTemplate(content, ensureDestination);
    slides.push(spec);
    contents.push(content);
    allImages.push(images);
    getSurfaceElementFromEditor(host)?.refresh();
  };

  return {
    process: async (markdown: string) => {
      try {
        const snapshot = await markdownToSnapshot(
          markdown,
          host.store,
          sourceHost,
        );
        try {
          const outlineRoot = snapshot.snapshot?.content[0];
          if (!outlineRoot) return;
          for (const slideBlock of outlineRoot.children) {
            await insertSlideBlock(slideBlock, snapshot.assertCurrent);
            gfx.fitToScreen();
          }
        } finally {
          snapshot.transformer[Symbol.dispose]();
        }
      } catch (error) {
        console.error(error);
      }

      return { contents, images: allImages };
    },
  };
}
