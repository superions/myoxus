import {
  createBundledHighlighter,
  createHighlighterCore,
  createSingletonShorthands,
  guessEmbeddedLanguages,
  type HighlighterCoreOptions,
} from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import getWasm from "@shikijs/engine-oniguruma/wasm-inlined";

import { bundledLanguagesInfo } from "./languages.gen.js";

export { bundledLanguagesInfo };
export type {
  BundledLanguageInfo,
  HighlighterCore,
  MaybeGetter,
  ThemedToken,
  ThemeInput,
} from "@shikijs/core";

// Engine selection is shared; the code-block service still owns its reference-
// counted instance, while inline LaTeX keeps Shiki's native singleton lifetime.
const createEngine = () => createOnigurumaEngine(() => getWasm);

export function createEditorHighlighterCore(
  options: Omit<HighlighterCoreOptions, "engine"> = {},
) {
  return createHighlighterCore({ ...options, engine: createEngine() });
}

const languages = Object.fromEntries(
  bundledLanguagesInfo.flatMap(({ id, aliases = [], import: load }) =>
    [id, ...aliases].map((name) => [name, load]),
  ),
);

const createHighlighter = createBundledHighlighter({
  langs: languages,
  themes: {
    "dark-plus": () => import("@shikijs/themes/dark-plus"),
    "light-plus": () => import("@shikijs/themes/light-plus"),
  },
  engine: createEngine,
});

export const { codeToTokensBase } = createSingletonShorthands(
  createHighlighter,
  { guessEmbeddedLanguages },
);

export const CODE_BLOCK_DEFAULT_DARK_THEME = () =>
  import("@shikijs/themes/dark-plus");
export const CODE_BLOCK_DEFAULT_LIGHT_THEME = () =>
  import("@shikijs/themes/light-plus");
