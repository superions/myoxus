import { createIdentifier } from "@virgultum/global/di";
import { IS_FIREFOX } from "@virgultum/global/env";
import { LifeCycleWatcher } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import type { FontConfig } from "./config.js";

const initFontFace = IS_FIREFOX
  ? ({ font, weight, url, style }: FontConfig) =>
      new FontFace(`"${font}"`, `url(${url})`, {
        weight,
        style,
      })
  : ({ font, weight, url, style }: FontConfig) =>
      new FontFace(font, `url(${url})`, {
        weight,
        style,
      });

/** Server CSS owns normal font loading; only explicit host-supplied faces are owned here. */
export class FontLoaderService extends LifeCycleWatcher {
  static override readonly key = "font-loader";
  private readonly _loadedFontKeys = new Set<string>();
  readonly fontFaces: FontFace[] = [];
  get ready() {
    return Promise.all([
      document.fonts.ready,
      ...this.fontFaces.map((face) => face.loaded),
    ]);
  }
  private readonly _fontKey = ({ font, weight, style, url }: FontConfig) =>
    `${font}:${weight}:${style}:${url}`;
  load(fonts: FontConfig[]) {
    for (const font of fonts) {
      const key = this._fontKey(font);
      if (this._loadedFontKeys.has(key)) {
        continue;
      }
      this._loadedFontKeys.add(key);
      const fontFace = initFontFace(font);
      document.fonts.add(fontFace);
      fontFace.load().catch(console.error);
      this.fontFaces.push(fontFace);
    }
  }

  override mounted() {
    this.load(this.std.getOptional(FontConfigIdentifier) ?? []);
  }
  override unmounted() {
    this.fontFaces.forEach((face) => document.fonts.delete(face));
    this.fontFaces.splice(0);
    this._loadedFontKeys.clear();
  }
}

export const FontConfigIdentifier =
  createIdentifier<FontConfig[]>("MyoxusFontConfig");

export const FontConfigExtension = (
  fontConfig: FontConfig[],
): ExtensionType => ({
  setup: (di) => {
    di.addImpl(FontConfigIdentifier, () => fontConfig);
  },
});
