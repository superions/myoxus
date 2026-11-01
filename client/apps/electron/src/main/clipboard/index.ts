import {
  clipboard,
  ClipboardItem,
  type NativeImage,
  nativeImage,
} from "electron";

import type { MainHandlerImplementations } from "../type";

export async function writePngToClipboard(image: NativeImage) {
  const png = image.toPNG();
  await clipboard.write([
    new ClipboardItem({
      "image/png": new Blob([Uint8Array.from(png).buffer], {
        type: "image/png",
      }),
    }),
  ]);
}

export const clipboardHandlers = {
  copyAsPNG: async (_, arrayBuffer: ArrayBuffer) => {
    const image = nativeImage.createFromBuffer(Buffer.from(arrayBuffer));
    if (image.isEmpty()) return false;
    await writePngToClipboard(image);
    return true;
  },
} satisfies MainHandlerImplementations["clipboard"];
