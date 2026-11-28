// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { GfxModel } from "@virgultum/core/runtime/gfx";
import { ImageBlockModel } from "@virgultum/editor/model";
import { FetchUtils } from "@virgultum/editor/shared/adapters";
import type { BlockModel } from "@virgultum/editor/store";

function rasterizeImageToPng(
  src: string,
  crossOrigin?: string,
): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0);
      canvas.toBlob(resolve, "image/png");
    };
    image.onerror = () => resolve(null);
    if (crossOrigin) {
      image.crossOrigin = crossOrigin;
    }
    image.src = src;
  });
}

async function ensurePngBlob(blob: Blob): Promise<Blob> {
  const dataUrl = await readBlobAsURL(blob).catch(() => null);
  if (!dataUrl) return blob;
  const converted = await rasterizeImageToPng(dataUrl).catch(() => null);
  return converted ?? blob;
}

export async function fetchImageToFile(
  url: string,
  filename: string,
  imageProxy?: string,
): Promise<File | void> {
  try {
    const response = await FetchUtils.fetchImage(url, undefined, imageProxy);
    if (response?.ok) {
      let blob = await response.blob();
      if (!blob.type || !blob.type.startsWith("image/")) {
        blob = await ensurePngBlob(blob);
      }
      return new File([blob], filename, { type: blob.type || "image/png" });
    }
  } catch (err) {
    console.error(err);
  }

  const fallbackBlob = await rasterizeImageToPng(url, "anonymous");
  if (fallbackBlob) {
    return new File([fallbackBlob], filename, {
      type: fallbackBlob.type || "image/png",
    });
  }
}

export function readBlobAsURL(blob: Blob | File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(new Error("Failed to read blob as data URL"));
      }
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function randomSeed(min = 0, max = Date.now()): number {
  return Math.round(Math.random() * (max - min)) + min;
}

export function isImage(
  model: GfxModel | BlockModel,
): model is ImageBlockModel {
  return model instanceof ImageBlockModel;
}
